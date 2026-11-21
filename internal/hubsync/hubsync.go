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
	"net/url"
	"runtime"
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
	ErrInvalidPayload    = errors.New("hubsync: invalid configuration payload from hub")
	ErrInsecureHubURL    = errors.New("hubsync: hub URL must use https:// unless allowPrivate is enabled")
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
	MaxHubPayloadBytes   = 10 << 20 // 10 MiB
)

// HubSource coordinates fetching and caching configuration from EdgeOne Hub.
type HubSource struct {
	hubURL       string
	nodeToken    string
	allowPrivate bool
	nodeVersion  string
	// usageProvider supplies a compact usage digest reported with each sync so the
	// hub can show which models a VM actually serves. Nil in tests/older wiring.
	usageProvider func() any
	client        *http.Client
	snapshot      atomic.Pointer[types.RuntimeSnapshot]
	state         atomic.Value // holds string
	mu            sync.Mutex   // protects refresh coordination
	refreshing    bool
	refreshGen    uint64
	lastResult    *types.RuntimeSnapshot
	lastErr       error
	refreshCond   *sync.Cond
	lastRefresh   time.Time
	cbMu          sync.RWMutex
	callbacks     []func(*types.ProxyConfig)
}

// SetUsageProvider registers a callback returning a JSON-serializable usage digest.
func (s *HubSource) SetUsageProvider(fn func() any) {
	s.usageProvider = fn
}

// SetNodeVersion sets the binary version reported to the hub on every sync request.
func (s *HubSource) SetNodeVersion(v string) {
	s.nodeVersion = strings.TrimSpace(v)
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
		hubURL:       strings.TrimRight(hubURL, "/"),
		nodeToken:    strings.TrimSpace(nodeToken),
		allowPrivate: allowPrivate,
		client:       upstream.DefaultClient(15*time.Second, allowPrivate),
	}
	s.refreshCond = sync.NewCond(&s.mu)
	s.state.Store(StateWaitingFirstRequest)
	return s
}

func validateHubURL(rawURL string, allowPrivate bool) error {
	u, err := url.Parse(rawURL)
	if err != nil || u == nil || u.Host == "" {
		return ErrInsecureHubURL
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme == "https" {
		return nil
	}
	if scheme == "http" && allowPrivate {
		return nil
	}
	return ErrInsecureHubURL
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

// RefreshForAuth refreshes configuration during data-plane client authentication.
// Cold starts and expired leases always trigger a normal sync so Hub-projected client_key
// remains discoverable, while unauthenticated X-Node-Refresh: 1 requests within
// MinRefreshDebounce are ignored to prevent Hub request flooding.
func (s *HubSource) RefreshForAuth(ctx context.Context, forceRequested bool) (*types.RuntimeSnapshot, error) {
	if st, _ := s.state.Load().(string); st == StateRevoked {
		return nil, ErrNodeUnauthorized
	}

	snap := s.snapshot.Load()
	if snap == nil || !time.Now().Before(snap.LeaseUntil) {
		return s.Current(ctx, false)
	}
	if !forceRequested {
		return snap, nil
	}

	s.mu.Lock()
	recent := !s.lastRefresh.IsZero() && time.Since(s.lastRefresh) < MinRefreshDebounce
	s.mu.Unlock()
	if recent {
		return snap, nil
	}
	return s.Current(ctx, true)
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

func (s *HubSource) syncWithHub(_ context.Context, currentSnap *types.RuntimeSnapshot, forceRefresh bool) (retSnap *types.RuntimeSnapshot, retErr error) {
	s.mu.Lock()

	// Singleflight pattern: join in-flight refresh generation
	if s.refreshing {
		waitGen := s.refreshGen
		for s.refreshing && s.refreshGen == waitGen {
			s.refreshCond.Wait()
		}
		res, err := s.lastResult, s.lastErr
		s.mu.Unlock()
		return res, err
	}

	// Double check state and lease after acquiring lock
	if st, _ := s.state.Load().(string); st == StateRevoked {
		s.mu.Unlock()
		return nil, ErrNodeUnauthorized
	}
	currentSnap = s.snapshot.Load()
	if !forceRefresh && currentSnap != nil && time.Now().Before(currentSnap.LeaseUntil) {
		s.mu.Unlock()
		return currentSnap, nil
	}

	s.refreshing = true
	s.refreshGen++
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.lastResult = retSnap
		s.lastErr = retErr
		s.refreshing = false
		s.lastRefresh = time.Now()
		s.refreshCond.Broadcast()
		s.mu.Unlock()
	}()

	if err := validateHubURL(s.hubURL, s.allowPrivate); err != nil {
		s.state.Store(StateError)
		return nil, err
	}

	// Detach Hub fetch context from Caller #1's request context so Caller #1
	// disconnecting never cancels the shared Hub fetch for concurrent waiters.
	syncCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Perform HTTP request to hub
	url := s.hubURL + "/api/node/config"
	req, err := http.NewRequestWithContext(syncCtx, http.MethodPost, url, nil)
	if err != nil {
		return s.handleSyncError(err, currentSnap)
	}

	req.Header.Set("Authorization", "Bearer "+s.nodeToken)
	if s.nodeVersion != "" {
		// Lets the hub record the real binary version (last_binary_version) instead
		// of the issuance-time default.
		req.Header.Set("X-Node-Version", s.nodeVersion)
	}
	if s.usageProvider != nil {
		if digest := s.usageProvider(); digest != nil {
			if raw, err := json.Marshal(digest); err == nil && len(raw) < 8000 {
				req.Header.Set("X-Node-Usage", string(raw))
			}
		}
	}
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
		// Extend lease via copy-on-write snapshot without mutating currentSnap in place
		leaseUntil := parseLeaseHeader(resp.Header.Get("X-Lease-Until"), DefaultLeaseDuration)
		graceUntil := parseLeaseHeader(resp.Header.Get("X-Grace-Until"), DefaultGraceDuration)

		if currentSnap != nil {
			updatedSnap := &types.RuntimeSnapshot{
				Config:     currentSnap.Config,
				ETag:       currentSnap.ETag,
				LeaseUntil: leaseUntil,
				GraceUntil: graceUntil,
				LoadedAt:   currentSnap.LoadedAt,
			}
			s.snapshot.Store(updatedSnap)
			s.state.Store(StateReady)
			return updatedSnap, nil
		}
		s.state.Store(StateError)
		return nil, ErrSourceUnavailable

	case http.StatusOK: // 200
		body, err := io.ReadAll(io.LimitReader(resp.Body, MaxHubPayloadBytes))
		if err != nil {
			return s.handleSyncError(err, currentSnap)
		}
		defer clear(body)

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
			defer clear(env.Payload)
			if err := json.Unmarshal(env.Payload, &cfg); err != nil {
				return s.handleSyncError(ErrInvalidPayload, currentSnap)
			}
			if cfg.Version == 0 && env.ConfigVersion != 0 {
				cfg.Version = env.ConfigVersion
			}
		} else {
			if len(env.Payload) > 0 {
				defer clear(env.Payload)
			}
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

		// Atomically publish newSnap without mutating oldSnap in-place so in-flight
		// Dispatch goroutines reading KeyEntry.Key never race; GC reclaims oldSnap cleanly.
		s.snapshot.Store(newSnap)

		s.state.Store(StateReady)
		s.notifyCallbacks(newSnap.Config)
		return newSnap, nil

	case http.StatusUnauthorized, http.StatusForbidden: // 401 / 403
		// Node revoked! Purge memory keys immediately and set permanent StateRevoked
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
	s.nodeToken = ""
	s.state.Store(StateRevoked)
	runtime.GC()
}

func (s *HubSource) handleSyncError(_ error, currentSnap *types.RuntimeSnapshot) (*types.RuntimeSnapshot, error) {
	now := time.Now()
	// Check grace period
	if currentSnap != nil && now.Before(currentSnap.GraceUntil) {
		s.state.Store(StateStale)
		return currentSnap, nil
	}

	// Cold start (currentSnap == nil) or grace period expired on transient error:
	// Drop snapshot reference (let GC reclaim after in-flight requests finish) and set
	// recoverable StateError (NOT StateRevoked) so node automatically heals when Hub recovers.
	if currentSnap != nil {
		s.snapshot.Store(nil)
		runtime.GC()
	}
	s.state.Store(StateError)
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
