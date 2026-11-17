// Package hubsync implements the Lite mode ConfigSource (HubSource).
// It manages the lazy-once, lease-based, 304-conditional synchronization lifecycle
// with EdgeOne Hub, including memory key destruction (0x00) upon revocation.
package hubsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

var (
	ErrNodeUnauthorized  = errors.New("hubsync: node token unauthorized or revoked (401/403)")
	ErrSourceUnavailable = errors.New("hubsync: hub unavailable and grace period expired")
	ErrInvalidPayload     = errors.New("hubsync: invalid configuration payload from hub")
)

const (
	StateWaitingFirstRequest = "waiting_first_request"
	StateReady               = "ready"
	StateStale               = "stale"
	StateRevoked             = "revoked"
	StateError               = "error"

	DefaultLeaseDuration = 24 * time.Hour
	DefaultGraceDuration = 1 * time.Hour
	MinRefreshDebounce   = 5 * time.Minute
)

// HubSource coordinates fetching and caching configuration from EdgeOne Hub.
type HubSource struct {
	hubURL      string
	nodeToken   string
	client      *http.Client
	snapshot    atomic.Pointer[types.RuntimeSnapshot]
	state       atomic.Value // holds string
	mu          sync.Mutex   // protects refresh coordination
	refreshing  bool
	refreshCond *sync.Cond
	lastRefresh time.Time
	cbMu        sync.RWMutex
	callbacks   []func(*types.ProxyConfig)
}

// OnConfigChange registers a callback invoked whenever Hub delivers an updated config snapshot.
func (s *HubSource) OnConfigChange(fn func(*types.ProxyConfig)) {
	if fn == nil {
		return
	}
	s.cbMu.Lock()
	s.callbacks = append(s.callbacks, fn)
	s.cbMu.Unlock()
}

func (s *HubSource) notifyCallbacks(cfg *types.ProxyConfig) {
	if cfg == nil {
		return
	}
	s.cbMu.RLock()
	cbs := make([]func(*types.ProxyConfig), len(s.callbacks))
	copy(cbs, s.callbacks)
	s.cbMu.RUnlock()
	for _, fn := range cbs {
		if fn != nil {
			fn(cfg)
		}
	}
}

// NewHubSource creates a new HubSource. Zero network calls occur during creation.
func NewHubSource(hubURL, nodeToken string, allowPrivate bool) *HubSource {
	s := &HubSource{
		hubURL:    strings.TrimRight(hubURL, "/"),
		nodeToken: strings.TrimSpace(nodeToken),
		client:    upstream.DefaultClient(15*time.Second, allowPrivate),
	}
	s.refreshCond = sync.NewCond(&s.mu)
	s.state.Store(StateWaitingFirstRequest)
	return s
}

// HealthState returns status for /healthz.
func (s *HubSource) HealthState() (status string, state string, leaseValid bool, configVer int64) {
	st, _ := s.state.Load().(string)
	snap := s.snapshot.Load()

	now := time.Now()
	isValid := snap != nil && now.Before(snap.LeaseUntil)
	var ver int64
	if snap != nil && snap.Config != nil {
		ver = snap.Config.Version
	}

	switch st {
	case StateWaitingFirstRequest:
		return "standby", StateWaitingFirstRequest, false, 0
	case StateReady:
		if isValid {
			return "healthy", StateReady, true, ver
		}
		return "degraded", StateStale, false, ver
	case StateStale:
		return "degraded", StateStale, false, ver
	case StateRevoked:
		return "unhealthy", StateRevoked, false, 0
	default:
		return "unhealthy", st, false, ver
	}
}

// Current returns the current runtime snapshot.
// On first call or when now >= LeaseUntil or forceRefresh is true, triggers singleflight fetch.
func (s *HubSource) Current(ctx context.Context, forceRefresh bool) (*types.RuntimeSnapshot, error) {
	st, _ := s.state.Load().(string)
	if st == StateRevoked {
		return nil, ErrNodeUnauthorized
	}

	snap := s.snapshot.Load()
	now := time.Now()

	// If we have a valid lease and not forcing refresh, return immediately with zero network overhead
	if snap != nil && now.Before(snap.LeaseUntil) && !forceRefresh {
		return snap, nil
	}

	// Needs refresh (first request, lease expired, or forced)
	return s.syncWithHub(ctx, snap, forceRefresh)
}

// TriggerAllKeysFailed is invoked by scheduler when all keys for a request fail with 401/403.
// Refreshes config if debounced interval has passed.
func (s *HubSource) TriggerAllKeysFailed(ctx context.Context) {
	s.mu.Lock()
	if time.Since(s.lastRefresh) < MinRefreshDebounce {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	_, _ = s.Current(ctx, true)
}

func (s *HubSource) syncWithHub(ctx context.Context, currentSnap *types.RuntimeSnapshot, forceRefresh bool) (*types.RuntimeSnapshot, error) {
	s.mu.Lock()

	// Singleflight pattern
	for s.refreshing {
		s.refreshCond.Wait()
		// Check if another goroutine succeeded
		latest := s.snapshot.Load()
		if latest != nil && time.Now().Before(latest.LeaseUntil) {
			s.mu.Unlock()
			return latest, nil
		}
		st, _ := s.state.Load().(string)
		if st == StateRevoked {
			s.mu.Unlock()
			return nil, ErrNodeUnauthorized
		}
	}

	// Double check lease after acquiring lock
	currentSnap = s.snapshot.Load()
	if !forceRefresh && currentSnap != nil && time.Now().Before(currentSnap.LeaseUntil) {
		s.mu.Unlock()
		return currentSnap, nil
	}

	s.refreshing = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.refreshing = false
		s.lastRefresh = time.Now()
		s.refreshCond.Broadcast()
		s.mu.Unlock()
	}()

	// Perform HTTP request to hub
	url := s.hubURL + "/api/node/config"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return s.handleSyncError(err, currentSnap)
	}

	req.Header.Set("Authorization", "Bearer "+s.nodeToken)
	if currentSnap != nil && currentSnap.ETag != "" {
		req.Header.Set("If-None-Match", currentSnap.ETag)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return s.handleSyncError(err, currentSnap)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusNotModified: // 304
		// Extend lease directly from header without JSON parsing
		leaseUntil := parseLeaseHeader(resp.Header.Get("X-Lease-Until"), DefaultLeaseDuration)
		graceUntil := parseLeaseHeader(resp.Header.Get("X-Grace-Until"), DefaultGraceDuration)

		if currentSnap != nil {
			currentSnap.LeaseUntil = leaseUntil
			currentSnap.GraceUntil = graceUntil
			s.snapshot.Store(currentSnap)
			s.state.Store(StateReady)
			return currentSnap, nil
		}
		return nil, ErrSourceUnavailable

	case http.StatusOK: // 200
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return s.handleSyncError(err, currentSnap)
		}

		var cfg types.ProxyConfig
		var env struct {
			OK            bool            `json:"ok"`
			ConfigVersion int64           `json:"config_version"`
			LeaseUntil    any             `json:"lease_until"`
			GraceUntil    any             `json:"grace_until"`
			LeaseTTL      int64           `json:"lease_ttl"`
			GraceTTL      int64           `json:"grace_ttl"`
			Payload       json.RawMessage `json:"payload"`
		}

		if err := json.Unmarshal(body, &env); err == nil && len(env.Payload) > 0 && string(env.Payload) != "null" {
			if err := json.Unmarshal(env.Payload, &cfg); err != nil {
				return s.handleSyncError(ErrInvalidPayload, currentSnap)
			}
			if cfg.Version == 0 && env.ConfigVersion != 0 {
				cfg.Version = env.ConfigVersion
			}
		} else {
			if err := json.Unmarshal(body, &cfg); err != nil {
				return s.handleSyncError(ErrInvalidPayload, currentSnap)
			}
		}

		etag := resp.Header.Get("ETag")
		if etag == "" {
			etag = fmt.Sprintf(`"%d"`, cfg.Version)
		}

		leaseHeader := resp.Header.Get("X-Lease-Until")
		if leaseHeader == "" && env.LeaseUntil != nil {
			leaseHeader = fmt.Sprint(env.LeaseUntil)
		}
		graceHeader := resp.Header.Get("X-Grace-Until")
		if graceHeader == "" && env.GraceUntil != nil {
			graceHeader = fmt.Sprint(env.GraceUntil)
		}

		leaseUntil := parseLeaseHeader(leaseHeader, DefaultLeaseDuration)
		if leaseHeader == "" && env.LeaseTTL > 0 {
			leaseUntil = time.Now().Add(time.Duration(env.LeaseTTL) * time.Second)
		}

		graceUntil := parseLeaseHeader(graceHeader, DefaultGraceDuration)
		if graceHeader == "" && env.GraceTTL > 0 {
			graceUntil = time.Now().Add(time.Duration(env.GraceTTL) * time.Second)
		}

		newSnap := &types.RuntimeSnapshot{
			Config:     &cfg,
			ETag:       etag,
			LeaseUntil: leaseUntil,
			GraceUntil: graceUntil,
			LoadedAt:   time.Now(),
		}

		oldSnap := s.snapshot.Swap(newSnap)
		if oldSnap != nil {
			// Zero old secret bytes in memory
			oldSnap.PurgeSecrets()
		}

		s.state.Store(StateReady)
		s.notifyCallbacks(newSnap.Config)
		return newSnap, nil

	case http.StatusUnauthorized, http.StatusForbidden: // 401 / 403
		// Node revoked! Purge memory keys immediately and set revoked
		s.purgeAndRevoke()
		return nil, ErrNodeUnauthorized

	default:
		return s.handleSyncError(fmt.Errorf("hub returned HTTP %d", resp.StatusCode), currentSnap)
	}
}

func (s *HubSource) purgeAndRevoke() {
	snap := s.snapshot.Swap(nil)
	if snap != nil {
		snap.PurgeSecrets()
	}
	s.state.Store(StateRevoked)
}

func (s *HubSource) handleSyncError(err error, currentSnap *types.RuntimeSnapshot) (*types.RuntimeSnapshot, error) {
	now := time.Now()
	// Check grace period
	if currentSnap != nil && now.Before(currentSnap.GraceUntil) {
		s.state.Store(StateStale)
		return currentSnap, nil
	}

	// Grace period expired or never had a snapshot: purge and fail
	s.purgeAndRevoke()
	return nil, ErrSourceUnavailable
}

func parseLeaseHeader(headerVal string, defaultDuration time.Duration) time.Time {
	if headerVal == "" {
		return time.Now().Add(defaultDuration)
	}
	// Try parsing unix seconds
	if sec, err := strconv.ParseInt(headerVal, 10, 64); err == nil {
		return time.Unix(sec, 0)
	}
	// Try parsing RFC3339Nano or RFC3339
	if t, err := time.Parse(time.RFC3339Nano, headerVal); err == nil {
		return t
	}
	if t, err := time.Parse(time.RFC3339, headerVal); err == nil {
		return t
	}
	return time.Now().Add(defaultDuration)
}
