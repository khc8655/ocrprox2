package scheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/adapters"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

const (
	HardBudgetTimeout = 300 * time.Second
	KeepaliveInterval = 45 * time.Second
)

var (
	ErrNoCandidateAvailable = errors.New("scheduler: all candidates are cooled down or exhausted")
	ErrAllRetriesExhausted  = errors.New("scheduler: all upstream candidates failed within budget")
)

// OAuthRefresher enables dynamic token refresh before dispatching requests.
type OAuthRefresher interface {
	EnsureValidToken(ctx context.Context, keyEntry *types.KeyEntry, endpoint string) error
}

// Scheduler coordinates upstream dispatching across candidate keys.
type Scheduler struct {
	mu                sync.Mutex
	configSource      types.ConfigSource
	engine            types.AdapterEngine
	cooldowns         *CooldownManager
	obsSink           types.ObservabilitySink
	httpClient        *http.Client
	allowPrivate      bool
	clientsMu         sync.RWMutex
	clients           map[int]*http.Client // cached by firstByteTimeoutSec -> client
	lanes             *LaneTracker
	rpmLimiter        *RPMLimiter
	rrIndex           map[string]int
	swrrCurrent       map[string]map[string]int
	latency           *LatencyTracker
	sessionSticky     *SessionStickyCache
	oauthRefresher    OAuthRefresher
	keepaliveInterval time.Duration
}

// NewScheduler creates a Scheduler.
func NewScheduler(
	cfgSrc types.ConfigSource,
	obsSink types.ObservabilitySink,
	allowPrivate bool,
) *Scheduler {
	return &Scheduler{
		configSource:      cfgSrc,
		engine:            adapters.NewDefaultEngine(),
		cooldowns:         NewCooldownManager(),
		obsSink:           obsSink,
		httpClient:        upstream.UpstreamClient(120*time.Second, allowPrivate),
		allowPrivate:      allowPrivate,
		clients:           make(map[int]*http.Client),
		lanes:             NewLaneTracker(),
		rpmLimiter:        NewRPMLimiter(60 * time.Second),
		rrIndex:           make(map[string]int),
		swrrCurrent:       make(map[string]map[string]int),
		latency:           NewLatencyTracker(),
		sessionSticky:     NewSessionStickyCache(defaultSessionStickyTTL, defaultSessionStickyMaxSize),
		keepaliveInterval: KeepaliveInterval,
	}
}

func (s *Scheduler) keepaliveDur() time.Duration {
	s.mu.Lock()
	d := s.keepaliveInterval
	s.mu.Unlock()
	if d <= 0 {
		return KeepaliveInterval
	}
	return d
}

func resolveCandidateKeySecret(cand *CandidateKey, refresher OAuthRefresher) string {
	if cand == nil || cand.KeyEntry == nil {
		return ""
	}
	if cand.KeyEntry.AuthType == "oauth_device" && refresher != nil {
		if tg, ok := refresher.(interface{ GetAccessToken(*types.KeyEntry) string }); ok {
			return tg.GetAccessToken(cand.KeyEntry)
		}
	}
	return cand.KeyEntry.Key
}

// SessionSticky returns the per-session sticky cache (for inspection/tests).
func (s *Scheduler) SessionSticky() *SessionStickyCache {
	return s.sessionSticky
}

// SetOAuthRefresher registers an OAuth token refresher callback. Thread-safe.
func (s *Scheduler) SetOAuthRefresher(r OAuthRefresher) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.oauthRefresher = r
}

func (s *Scheduler) getOAuthRefresher() OAuthRefresher {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.oauthRefresher
}

// Cooldowns returns the active cooldown manager.
func (s *Scheduler) Cooldowns() *CooldownManager {
	return s.cooldowns
}

// Lanes returns the active lane tracker.
func (s *Scheduler) Lanes() *LaneTracker {
	return s.lanes
}

// SnapshotLanes returns a snapshot of active lanes for /api/lanes.
func (s *Scheduler) SnapshotLanes() map[string]Lane {
	if s.lanes == nil {
		return make(map[string]Lane)
	}
	return s.lanes.Snapshot()
}

// RPM returns the per-key sliding window RPM limiter.
func (s *Scheduler) RPM() *RPMLimiter {
	return s.rpmLimiter
}

// SetBanFile configures the persistent ban file path.
func (s *Scheduler) SetBanFile(path string) error {
	return s.cooldowns.SetBanFile(path)
}

// InitBans initializes persistent bans based on role and configDir.
func (s *Scheduler) InitBans(role types.Role, configDir string) error {
	if role == types.RoleFull && configDir != "" {
		return s.cooldowns.SetBanFile(filepath.Join(configDir, "key_bans.json"))
	}
	return s.cooldowns.SetBanFile("")
}

func (s *Scheduler) getClient(firstByteSec int) *http.Client {
	if firstByteSec <= 0 {
		firstByteSec = 120
	}
	s.clientsMu.RLock()
	c, ok := s.clients[firstByteSec]
	s.clientsMu.RUnlock()
	if ok {
		return c
	}
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	if c, ok = s.clients[firstByteSec]; ok {
		return c
	}
	c = upstream.UpstreamClient(time.Duration(firstByteSec)*time.Second, s.allowPrivate)
	s.clients[firstByteSec] = c
	return c
}

// CandidateKey represents an actionable route key target.
type CandidateKey struct {
	Provider    *types.ProviderConfig
	KeyEntry    *types.KeyEntry
	TargetModel string
	KeyTag      string // e.g. "minimax:hk-01"
	Weight      int    // routing weight (default 1)
	MaxConc     int    // soft concurrency cap per candidate (0 = unlimited)
}

// DescribeRouteCandidates explains, per configured candidate, why it cannot be
// used. Attached to the 503 body so "no candidate keys available" is diagnosable
// (typically after disabling/removing a key that a route still references).
func DescribeRouteCandidates(route *types.AgentModelRoute, providers map[string]*types.ProviderConfig) []string {
	var notes []string
	for _, cand := range route.Candidates {
		label := cand.KeyLabel
		if label == "" {
			label = "*"
		}
		desc := cand.Provider + "/" + label
		if !cand.Enabled {
			notes = append(notes, desc+" (candidate disabled)")
			continue
		}
		p, ok := providers[cand.Provider]
		if !ok {
			notes = append(notes, desc+" (provider missing)")
			continue
		}
		if !p.Enabled {
			notes = append(notes, desc+" (provider disabled)")
			continue
		}
		if cand.KeyLabel == "" {
			usable := false
			for _, k := range p.APIKeys {
				if k != nil && k.Enabled && k.Key != "" {
					usable = true
					break
				}
			}
			if !usable {
				notes = append(notes, desc+" (no enabled key)")
			}
			continue
		}
		found, usable := false, false
		for _, k := range p.APIKeys {
			if k != nil && k.Label == cand.KeyLabel {
				found = true
				usable = k.Enabled && k.Key != ""
				break
			}
		}
		switch {
		case !found:
			notes = append(notes, desc+" (key not found)")
		case !usable:
			notes = append(notes, desc+" (key disabled)")
		}
	}
	return notes
}

// OrderCandidates sorts candidate keys according to route strategy.
func (s *Scheduler) OrderCandidates(
	route *types.AgentModelRoute,
	providers map[string]*types.ProviderConfig,
	reqModel string,
) []*CandidateKey {
	return s.OrderCandidatesForSession(route, providers, reqModel, "", "")
}

// OrderCandidatesForSession sorts candidate keys using per-session sticky affinity,
// falling back to globalStrategy -> route.ActiveKey / model sticky fallback, and spreading
// concurrent unbound sessions across healthy idle keys of the primary provider.
func (s *Scheduler) OrderCandidatesForSession(
	route *types.AgentModelRoute,
	providers map[string]*types.ProviderConfig,
	reqModel string,
	globalStrategy string,
	sessionKey string,
) []*CandidateKey {
	var candidates []*CandidateKey

	for _, cand := range route.Candidates {
		if !cand.Enabled {
			continue
		}
		p, exists := providers[cand.Provider]
		if !exists || !p.Enabled {
			continue
		}

		for _, k := range p.APIKeys {
			if !k.Enabled || k.Key == "" {
				continue
			}
			if cand.KeyLabel != "" && k.Label != cand.KeyLabel {
				continue
			}

			targetModel := cand.TargetModel
			if targetModel == "" && p.ModelAliases != nil {
				targetModel = p.ModelAliases[reqModel]
			}
			if targetModel == "" {
				if rules := adapters.ResolveAdapterRules(p); rules != nil && rules.ModelAliases != nil {
					targetModel = rules.ModelAliases[reqModel]
				}
			}
			if targetModel == "" {
				targetModel = reqModel
			}

			candidates = append(candidates, &CandidateKey{
				Provider:    p,
				KeyEntry:    k,
				TargetModel: targetModel,
				KeyTag:      cand.Provider + ":" + k.Label,
				Weight:      cand.Weight,
				MaxConc:     cand.MaxConc,
			})
		}
	}

	// Optional fallback: a candidate pinned to a key_label that is disabled or
	// removed can borrow another enabled key from the same provider. Off by default
	// so explicit key bindings keep their exact semantics.
	if route.AllowKeyFallback {
		added := make(map[string]bool, len(candidates))
		for _, c := range candidates {
			added[c.KeyTag] = true
		}
		for _, cand := range route.Candidates {
			if !cand.Enabled || cand.KeyLabel == "" {
				continue
			}
			p, exists := providers[cand.Provider]
			if !exists || p == nil || !p.Enabled {
				continue
			}
			refUsable := false
			for _, c := range candidates {
				if c.Provider == p && c.KeyEntry != nil && c.KeyEntry.Label == cand.KeyLabel {
					refUsable = true
					break
				}
			}
			if refUsable {
				continue
			}
			for _, k := range p.APIKeys {
				if k == nil || !k.Enabled || k.Key == "" {
					continue
				}
				tag := cand.Provider + ":" + k.Label
				if added[tag] {
					continue
				}
				targetModel := cand.TargetModel
				if targetModel == "" && p.ModelAliases != nil {
					targetModel = p.ModelAliases[reqModel]
				}
				if targetModel == "" {
					targetModel = reqModel
				}
				candidates = append(candidates, &CandidateKey{
					Provider:    p,
					KeyEntry:    k,
					TargetModel: targetModel,
					KeyTag:      tag,
					Weight:      cand.Weight,
					MaxConc:     cand.MaxConc,
				})
				added[tag] = true
			}
		}
	}

	strategy := route.RoutingStrategy
	if strategy == "" {
		strategy = globalStrategy
	}
	if strategy == "" {
		strategy = "sticky_failover"
	}

	if len(candidates) <= 1 {
		return candidates
	}

	switch strategy {
	case "manual":
		// Manual: only active key if present
		if route.ActiveKey != "" {
			for _, c := range candidates {
				if c.KeyTag == route.ActiveKey {
					return []*CandidateKey{c}
				}
			}
		}
		return candidates

	case "round_robin":
		return s.orderRoundRobin(candidates, reqModel)

	case "weighted":
		return s.orderWeighted(candidates, reqModel)

	case "least_busy":
		return s.orderLeastBusy(candidates, reqModel)

	case "fast":
		return s.orderFast(candidates)

	case "sticky_failover":
		fallthrough
	default:
		// 1. Per-session sticky affinity takes highest precedence so concurrent sessions never stomp each other
		if sessionKey != "" && s.sessionSticky != nil {
			if boundTag, ok := s.sessionSticky.Get(reqModel, sessionKey); ok {
				if reordered, moved := moveCandidateFirst(candidates, boundTag); moved {
					return reordered
				}
			}
		}

		// 2. Explicit route.ActiveKey (config-pinned) or sessionless model fallback
		preferred := route.ActiveKey
		if preferred == "" && sessionKey == "" && s.sessionSticky != nil {
			preferred = s.sessionSticky.GetModelFallback(reqModel)
		}
		if preferred != "" {
			if reordered, moved := moveCandidateFirst(candidates, preferred); moved {
				return reordered
			}
		}

		// 3. New unbound session with multiple keys on the primary provider:
		//    if candidates[0] is currently busy/cooled/over-RPM, prefer an idle healthy sibling key
		//    on the same provider so concurrent multi-path sessions warm separate caches.
		if sessionKey != "" && !s.isCandidateAvailableAndIdle(candidates[0]) {
			primaryProv := candidates[0].Provider.ID
			for _, c := range candidates[1:] {
				if c.Provider.ID == primaryProv && s.isCandidateAvailableAndIdle(c) {
					if reordered, moved := moveCandidateFirst(candidates, c.KeyTag); moved {
						return reordered
					}
				}
			}
		}

		return candidates
	}
}

func moveCandidateFirst(candidates []*CandidateKey, keyTag string) ([]*CandidateKey, bool) {
	if keyTag == "" {
		return candidates, false
	}
	var active *CandidateKey
	var others []*CandidateKey
	for _, c := range candidates {
		if c.KeyTag == keyTag && active == nil {
			active = c
		} else {
			others = append(others, c)
		}
	}
	if active == nil {
		return candidates, false
	}
	return append([]*CandidateKey{active}, others...), true
}

func (s *Scheduler) isCandidateAvailableAndIdle(c *CandidateKey) bool {
	if c == nil || c.Provider == nil || c.KeyEntry == nil {
		return false
	}
	keyID := c.KeyEntry.ID
	if keyID == "" {
		keyID = c.KeyEntry.Label
	}
	if s.cooldowns != nil && s.cooldowns.IsCooledDown(c.Provider.ID, c.TargetModel, keyID) {
		return false
	}
	rpmLimit := c.KeyEntry.MaxRPM
	if rpmLimit <= 0 {
		rpmLimit = c.Provider.RPMPerKey
	}
	if rpmLimit > 0 && s.rpmLimiter != nil && !s.rpmLimiter.Allow(c.KeyTag, rpmLimit) {
		return false
	}
	if s.lanes != nil && s.lanes.ActiveCount(c.KeyTag) > 0 {
		return false
	}
	return true
}

// sanitizeHeaders redacts sensitive auth tokens and cleans up headers for observability.
func sanitizeHeaders(h http.Header) map[string]string {
	if h == nil || len(h) == 0 {
		return nil
	}
	res := make(map[string]string, len(h))
	for k, vals := range h {
		if len(vals) == 0 {
			continue
		}
		joined := vals[0]
		if len(vals) > 1 {
			joined = strings.Join(vals, ", ")
		}
		if strings.EqualFold(k, "Authorization") ||
			strings.EqualFold(k, "Proxy-Authorization") ||
			strings.EqualFold(k, "X-Api-Key") ||
			strings.EqualFold(k, "x-goog-api-key") ||
			strings.EqualFold(k, "api-key") ||
			strings.EqualFold(k, "Cookie") ||
			strings.EqualFold(k, "Set-Cookie") ||
			strings.Contains(strings.ToLower(k), "token") ||
			strings.Contains(strings.ToLower(k), "secret") {
			joined = "[REDACTED]"
		} else if !isBenignStandardHeader(k) {
			joined = obs.ScrubString(joined)
		}
		res[k] = joined
	}
	return res
}

func isBenignStandardHeader(k string) bool {
	return strings.EqualFold(k, "Content-Type") ||
		strings.EqualFold(k, "Content-Length") ||
		strings.EqualFold(k, "Accept") ||
		strings.EqualFold(k, "Accept-Encoding") ||
		strings.EqualFold(k, "Connection") ||
		strings.EqualFold(k, "Cache-Control") ||
		strings.EqualFold(k, "Date") ||
		strings.EqualFold(k, "Server") ||
		strings.EqualFold(k, "Transfer-Encoding") ||
		strings.EqualFold(k, "User-Agent")
}

// Dispatch executes the scheduled request with 300s budget, failover, peek, and forbiddenAlike.
func (s *Scheduler) Dispatch(
	ctx context.Context,
	endpoint string,
	reqBody []byte,
	reqModel string,
	clientStream bool,
	w http.ResponseWriter,
	r *http.Request,
) error {
	reqStart := time.Now()
	hasObs := s.hasObs()
	var traceID string
	var reqHeaders map[string]string
	if hasObs {
		traceID = fmt.Sprintf("req-%d", reqStart.UnixNano())
		if r != nil {
			reqHeaders = sanitizeHeaders(r.Header)
		}
	}

	// Hard total budget: 300s
	budgetCtx, cancel := context.WithTimeout(ctx, HardBudgetTimeout)
	defer cancel()

	snap, err := s.configSource.Current(budgetCtx, false)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		msg := err.Error()
		if errors.Is(err, config.ErrConfigNotInitialized) {
			// Never echo the config file path to callers.
			msg = "configuration not initialized: upload or sync a config before serving requests"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": msg,
				"type":    "service_unavailable",
			},
		})
		return err
	}

	category := ""
	if reqModel == "chat" {
		category = "chat"
	}
	route, exists := ResolveRoute(snap.Config, category, reqModel)
	if !exists || !route.Enabled {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": fmt.Sprintf("model %q not configured or disabled", reqModel),
				"type":    "invalid_request_error",
			},
		})
		return fmt.Errorf("model %s not found", reqModel)
	}

	if route.NoReasoning || route.ForceNonStream {
		if normBody, changed := applyRouteNormalization(reqBody, route.NoReasoning, route.ForceNonStream); changed {
			reqBody = normBody
		}
		if route.ForceNonStream {
			clientStream = false
		}
	}

	sessionKey := ExtractSessionKey(r, reqBody)
	globalStrategy := snap.Config.Settings.AgentRoutingStrategy
	candidates := s.OrderCandidatesForSession(route, snap.Config.Providers, reqModel, globalStrategy, sessionKey)
	if len(candidates) == 0 {
		msg := fmt.Sprintf("no candidate keys available for model %q", reqModel)
		if notes := DescribeRouteCandidates(route, snap.Config.Providers); len(notes) > 0 {
			msg += ": " + strings.Join(notes, "; ")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": msg,
				"type":    "service_unavailable",
			},
		})
		return ErrNoCandidateAvailable
	}

	settings := snap.Config.Settings
	durRateLimit := time.Duration(settings.CooldownRateLimitSec) * time.Second
	if durRateLimit == 0 {
		durRateLimit = 15 * time.Second
	}
	durServerError := time.Duration(settings.CooldownServerErrorSec) * time.Second
	if durServerError == 0 {
		durServerError = 30 * time.Second
	}
	durNetwork := time.Duration(settings.CooldownNetworkErrorSec) * time.Second
	if durNetwork == 0 {
		durNetwork = 15 * time.Second
	}
	durAuth := time.Duration(settings.CooldownAuthErrorSec) * time.Second
	// 0 explicitly disables the 401/402/403 key ban; a negative value is clamped
	// to the same meaning. Schema default (86400) supplies the 24h ban, so an
	// unset field still bans — only an explicit 0 opts out.
	if durAuth < 0 {
		durAuth = 0
	}

	firstByteSec := settings.AgentFirstByteTimeoutSec
	if firstByteSec <= 0 {
		firstByteSec = 120
	}
	durFirstByte := time.Duration(firstByteSec) * time.Second
	client := s.getClient(firstByteSec)

	var tries []types.Try
	var attempts []TryAttempt
	var lastStatus int
	var lastErrSnippet string
	// Why candidates were skipped before any upstream attempt. Surfaced when every
	// candidate is unavailable so the client gets a diagnosable error instead of
	// an empty "all candidate keys failed: ".
	var skips []string

	for i, cand := range candidates {
		// Check budget
		if budgetCtx.Err() != nil {
			break
		}

		keyID := cand.KeyEntry.ID
		if keyID == "" {
			keyID = cand.KeyEntry.Label
		}

		// 1. Check cooldown BEFORE acquiring RPM token so cooled-down keys never burn RPM quota
		if s.cooldowns.IsCooledDown(cand.Provider.ID, cand.TargetModel, keyID) {
			skips = append(skips, fmt.Sprintf("%s (cooling down %s)", keyID, s.cooldowns.RemainingFor(cand.Provider.ID, cand.TargetModel, keyID)))
			continue
		}

		// 2. Pre-flight per-key sliding-window RPM rate limiter check
		rpmLimit := cand.KeyEntry.MaxRPM
		if rpmLimit <= 0 && cand.Provider != nil {
			rpmLimit = cand.Provider.RPMPerKey
		}
		if rpmLimit > 0 && !s.rpmLimiter.TryAcquire(cand.KeyTag, rpmLimit) {
			// Over quota! Skip key cleanly before dialing upstream
			skips = append(skips, fmt.Sprintf("%s (RPM limit)", keyID))
			continue
		}

		var (
			done       bool
			retErr     error
		)
		func() {
			// 3. Concurrency tracking: start waiting (guaranteed cleanup via defer)
			queuedStart := time.Now()
			cancelWait := s.lanes.StartWaiting(cand.KeyTag)
			defer cancelWait()

			tryStart := time.Now()

			refresher := s.getOAuthRefresher()
			// Dynamic OAuth token refresh if needed
			if cand.KeyEntry.AuthType == "oauth_device" && refresher != nil {
				if refErr := refresher.EnsureValidToken(budgetCtx, cand.KeyEntry, ""); refErr != nil {
					lastStatus = http.StatusUnauthorized
					lastErrSnippet = refErr.Error()
					cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, http.StatusUnauthorized, durRateLimit, durServerError, durNetwork, durAuth)
					tries = append(tries, types.Try{
						Attempt:            i + 1,
						Provider:           cand.Provider.ID,
						KeyID:              cand.KeyEntry.Label,
						Model:              cand.TargetModel,
						Status:             http.StatusUnauthorized,
						Millis:             time.Since(tryStart).Milliseconds(),
						Reason:             "auth_error",
						CooldownAppliedSec: cooldownSec,
						ErrorSnippet:       obs.ScrubString(lastErrSnippet),
					})
					return
				}
			}

			// Prepare request
			mutatedBody, extraHeaders, upstreamStream, prepErr := s.engine.PrepareRequest(
				endpoint,
				reqBody,
				cand.Provider,
				cand.TargetModel,
				clientStream,
			)
			if prepErr != nil {
				return
			}

			// Construct URL
			var targetURL string
			if strings.Contains(endpoint, "messages") {
				targetURL = upstream.BuildMessagesUpstream(cand.Provider.BaseURL, cand.Provider.AnthropicBaseURL, cand.Provider.ID)
			} else {
				targetURL = upstream.JoinUpstream(cand.Provider.BaseURL, endpoint)
			}

			upReq, reqErr := http.NewRequestWithContext(budgetCtx, http.MethodPost, targetURL, bytes.NewReader(mutatedBody))
			if reqErr != nil {
				return
			}

			rawKey := resolveCandidateKeySecret(cand, refresher)
			applyUpstreamHeaders(upReq, r, endpoint, cand.Provider, rawKey, extraHeaders)

			// Concurrency tracking: acquire busy slot with MaxConc (guaranteed release via defer)
			queuedMillis := time.Since(queuedStart).Milliseconds()
			cancelWait()

			releaseBusy := s.lanes.Acquire(cand.KeyTag, cand.MaxConc)
			var relOnce sync.Once
			rel := func() { relOnce.Do(releaseBusy) }
			defer rel()

			// Execute HTTP call
			sendStart := time.Now()
			resp, callErr := client.Do(upReq)
			sentMillis := time.Since(sendStart).Milliseconds()
			tryElapsed := time.Since(tryStart).Milliseconds()

			if callErr != nil {
				lastStatus = 504
				lastErrSnippet = callErr.Error()
				cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, 504, durRateLimit, durServerError, durNetwork, durAuth)
				tries = append(tries, types.Try{
					Attempt:            i + 1,
					Provider:           cand.Provider.ID,
					KeyID:              cand.KeyEntry.Label,
					Model:              cand.TargetModel,
					Status:             504,
					Millis:             tryElapsed,
					Reason:             "network_error",
					CooldownAppliedSec: cooldownSec,
					ErrorSnippet:       obs.ScrubString(lastErrSnippet),
				})
				return
			}

			lastStatus = resp.StatusCode
			var tryRespHeaders map[string]string
			if hasObs {
				tryRespHeaders = sanitizeHeaders(resp.Header)
			}

			if resp.StatusCode != http.StatusOK {
				errBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
				resp.Body.Close()
				rel()
				lastErrSnippet = string(errBytes)

				cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, resp.StatusCode, durRateLimit, durServerError, durNetwork, durAuth)
				// Check if QuotaResetAt is configured for daily reset on quota limit
				if cand.Provider.QuotaResetAt != "" && (resp.StatusCode == 429 || resp.StatusCode == 402) {
					if sec, _, err := s.cooldowns.ApplyQuotaCooldown(cand.Provider.ID, cand.TargetModel, keyID, cand.Provider.QuotaResetAt); err == nil {
						cooldownSec = sec
					}
				}

				reason := "server_error"
				if resp.StatusCode == 429 {
					reason = "rate_limit"
				} else if resp.StatusCode == 401 || resp.StatusCode == 402 || resp.StatusCode == 403 {
					reason = "auth_error"
				} else if resp.StatusCode >= 400 && resp.StatusCode < 500 {
					reason = "client_error"
				}

				currAttempt := TryAttempt{
					Provider:     cand.Provider.ID,
					KeyID:        keyID,
					Model:        cand.TargetModel,
					Status:       resp.StatusCode,
					ErrorSnippet: lastErrSnippet,
				}

				tries = append(tries, types.Try{
					Attempt:            i + 1,
					Provider:           cand.Provider.ID,
					KeyID:              cand.KeyEntry.Label,
					Model:              cand.TargetModel,
					Status:             resp.StatusCode,
					Millis:             tryElapsed,
					Reason:             reason,
					CooldownAppliedSec: cooldownSec,
					ErrorSnippet:       obs.ScrubString(lastErrSnippet),
					RespHeaders:        tryRespHeaders,
				})

				// Check Magpie forbiddenAlike
				if CheckForbiddenAlike(attempts, currAttempt, s.cooldowns) {
					// Immediate abort: it's a client error, don't burn other keys!
					scrubbedErr := obs.Scrub(errBytes)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(resp.StatusCode)
					_, _ = w.Write(scrubbedErr)

					totalMillis := time.Since(reqStart).Milliseconds()
					ownMillis := totalMillis - (sentMillis + tryElapsed)
					if ownMillis < 0 {
						ownMillis = 0
					}
					s.recordFinalTrace(types.RequestTrace{
						ID:             traceID,
						Timestamp:      time.Now().Unix(),
						Mode:           "agent",
						Endpoint:       endpoint,
						ReqModel:       reqModel,
						ServedModel:    cand.TargetModel,
						WinnerProvider: cand.Provider.ID,
						WinnerKey:      cand.KeyEntry.Label,
						Status:         resp.StatusCode,
						Stream:         clientStream,
						OwnMillis:      ownMillis,
						QueuedMillis:   queuedMillis,
						SentMillis:     sentMillis,
						TotalMillis:    totalMillis,
						UpBytes:        len(mutatedBody),
						DownBytes:      len(scrubbedErr),
						ReqHeaders:     reqHeaders,
						Tries:          tries,
					})
					done = true
					retErr = nil
					return
				}

				attempts = append(attempts, currAttempt)
				return
			}

			// Upstream returned 200 OK!
			// Case A: Streaming request (either client requested stream, or provider is StreamOnly)
			if clientStream || upstreamStream {
				streamHeadersCommitted := false
				var keepaliveCb func()
				if clientStream {
					keepaliveCb = func() {
						if !streamHeadersCommitted {
							w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
							w.Header().Set("Cache-Control", "no-cache")
							w.Header().Set("Connection", "keep-alive")
							w.Header().Set("X-Accel-Buffering", "no")
							w.Header().Set("X-Routed-Via", cand.Provider.ID)
							w.WriteHeader(http.StatusOK)
							streamHeadersCommitted = true
						}
						_, _ = w.Write([]byte(": keep-alive\n\n"))
						if f, ok := w.(http.Flusher); ok {
							f.Flush()
						}
					}
				}

				peekRes, peekErr := PeekFirstChunk(budgetCtx, resp.Body, s.keepaliveDur(), durFirstByte, keepaliveCb)

				ttftMillis := time.Since(reqStart).Milliseconds()
				tryTTFT := time.Since(tryStart).Milliseconds()

				if peekErr != nil || peekRes.IsError {
					resp.Body.Close()
					rel()
					lastErrSnippet = ""
					if peekRes != nil {
						lastErrSnippet = peekRes.ErrorSnippet
					} else if peekErr != nil {
						lastErrSnippet = peekErr.Error()
					}
					cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, 502, durRateLimit, durServerError, durNetwork, durAuth)
					tries = append(tries, types.Try{
						Attempt:            i + 1,
						Provider:           cand.Provider.ID,
						KeyID:              cand.KeyEntry.Label,
						Model:              cand.TargetModel,
						Status:             502,
						Millis:             tryElapsed,
						TTFTMillis:         tryTTFT,
						Reason:             "stream_peek_error",
						CooldownAppliedSec: cooldownSec,
						ErrorSnippet:       obs.ScrubString(lastErrSnippet),
						RespHeaders:        tryRespHeaders,
					})
					if streamHeadersCommitted {
						// Stream headers already flushed via keepalive: emit SSE error event and abort cleanly
						errPayload, _ := json.Marshal(map[string]any{
							"error": map[string]any{
								"message": obs.ScrubString(lastErrSnippet),
								"type":    "upstream_error",
							},
						})
						_, _ = fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", errPayload)
						if f, ok := w.(http.Flusher); ok {
							f.Flush()
						}
						s.recordFinalTrace(types.RequestTrace{
							ID:          traceID,
							Timestamp:   time.Now().Unix(),
							Mode:        "agent",
							Endpoint:    endpoint,
							ReqModel:    reqModel,
							Status:      502,
							Stream:      clientStream,
							TotalMillis: time.Since(reqStart).Milliseconds(),
							ReqHeaders:  reqHeaders,
							Tries:       tries,
						})
						done = true
						if peekErr != nil {
							retErr = peekErr
						} else {
							retErr = ErrAllRetriesExhausted
						}
					}
					return
				}

				// Stream peek succeeded!
				if !clientStream {
					// Client asked for non-stream, but provider was stream_only: aggregate to JSON!
					aggBytes, aggErr := adapters.AggregateStreamToJSON(peekRes.CombinedBody)
					resp.Body.Close()
					rel()
					if aggErr != nil {
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("X-Routed-Via", cand.Provider.ID)
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write(aggBytes)
					s.latency.Record(cand.KeyTag, tryElapsed)
					s.updateStickyKey(reqModel, sessionKey, route, globalStrategy, cand)

					var usageTracker *StreamUsageTracker
					if hasObs {
						usageTracker = NewStreamUsageTracker(reqStart, ttftMillis)
						var aggMap map[string]any
						if json.Unmarshal(aggBytes, &aggMap) == nil {
							usageTracker.ParseJSON(aggMap)
						}
						usageTracker.Finish()
					}

					totalMillis := time.Since(reqStart).Milliseconds()
					if hasObs {
						ownMillis := totalMillis - (sentMillis + tryElapsed)
						if ownMillis < 0 {
							ownMillis = 0
						}
						tries = append(tries, types.Try{
							Attempt:     i + 1,
							Provider:    cand.Provider.ID,
							KeyID:       cand.KeyEntry.Label,
							Model:       cand.TargetModel,
							Status:      200,
							Millis:      tryElapsed,
							TTFTMillis:  tryTTFT,
							RespHeaders: tryRespHeaders,
						})
						s.recordFinalTrace(types.RequestTrace{
							ID:                 traceID,
							Timestamp:          time.Now().Unix(),
							Mode:               "agent",
							Endpoint:           endpoint,
							ReqModel:           reqModel,
							ServedModel:        cand.TargetModel,
							WinnerProvider:     cand.Provider.ID,
							WinnerKey:          cand.KeyEntry.Label,
							Status:             200,
							Stream:             clientStream,
							InTokens:           usageTracker.InTokens,
							OutTokens:          usageTracker.OutTokens,
							CacheReadTokens:    usageTracker.CacheReadTokens,
							CacheWriteTokens:   usageTracker.CacheWriteTokens,
							CacheWrite1hTokens: usageTracker.CacheWrite1hTokens,
							ReasoningTokens:    usageTracker.ReasoningTokens,
							StopReason:         usageTracker.StopReason,
							TTFTMillis:         ttftMillis,
							FlowMillis:         0,
							OwnMillis:          ownMillis,
							QueuedMillis:       queuedMillis,
							SentMillis:         sentMillis,
							TotalMillis:        totalMillis,
							UpBytes:            len(mutatedBody),
							DownBytes:          len(aggBytes),
							ReqHeaders:         reqHeaders,
							Tries:              tries,
						})
					}
					done = true
					retErr = nil
					return
				}

				// Client wants stream, but the upstream ignored stream=true and answered
				// with a plain completion body. Forwarding it under text/event-stream
				// breaks every SSE client, so synthesize a single-chunk SSE stream.
				if clientStream && peekRes.BareJSONPayload {
					resp.Body.Close()
					rel()
					w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
					w.Header().Set("Cache-Control", "no-cache")
					w.Header().Set("Connection", "keep-alive")
					w.Header().Set("X-Accel-Buffering", "no")
					w.Header().Set("X-Routed-Via", cand.Provider.ID)
					w.WriteHeader(http.StatusOK)

					synthBytes := adapters.SynthesizeSSEFromJSON(peekRes.FirstChunk)
					_, _ = w.Write(synthBytes)
					if f, ok := w.(http.Flusher); ok {
						f.Flush()
					}

					totalMillis := time.Since(reqStart).Milliseconds()
					done = true
					retErr = nil

					// Record usage from the synthesized body so streaming stats are not lost.
					var usageTracker *StreamUsageTracker
					if hasObs {
						usageTracker = NewStreamUsageTracker(reqStart, ttftMillis)
						usageTracker.FeedChunk(synthBytes)
					}
					if usageTracker != nil {
						s.recordFinalTrace(types.RequestTrace{
							ID:          traceID,
							Timestamp:   time.Now().Unix(),
							Mode:        "agent",
							Endpoint:    endpoint,
							ReqModel:    reqModel,
							ServedModel: cand.TargetModel,
							WinnerProvider: cand.Provider.ID,
							WinnerKey:   cand.KeyEntry.Label,
							Status:      http.StatusOK,
							Stream:      true,
							InTokens:    usageTracker.InTokens,
							OutTokens:   usageTracker.OutTokens,
							StopReason:  usageTracker.StopReason,
							TTFTMillis:  ttftMillis,
							TotalMillis: totalMillis,
							UpBytes:     len(mutatedBody),
							DownBytes:   len(synthBytes),
							ReqHeaders:  reqHeaders,
							Tries:       tries,
						})
					} else {
						s.recordFinalTrace(types.RequestTrace{
							ID:             traceID,
							Timestamp:      time.Now().Unix(),
							Mode:           "agent",
							Endpoint:       endpoint,
							ReqModel:       reqModel,
							ServedModel:    cand.TargetModel,
							WinnerProvider: cand.Provider.ID,
							WinnerKey:      cand.KeyEntry.Label,
							Status:         http.StatusOK,
							Stream:         true,
							TTFTMillis:     ttftMillis,
							TotalMillis:    totalMillis,
							UpBytes:        len(mutatedBody),
							DownBytes:      len(synthBytes),
							ReqHeaders:     reqHeaders,
							Tries:          tries,
						})
					}
					return
				}

				// Client wants stream
				if !streamHeadersCommitted {
					w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
					w.Header().Set("Cache-Control", "no-cache")
					w.Header().Set("Connection", "keep-alive")
					w.Header().Set("X-Accel-Buffering", "no")
					w.Header().Set("X-Routed-Via", cand.Provider.ID)
					w.WriteHeader(http.StatusOK)
					streamHeadersCommitted = true
				}

				flusher, hasFlusher := w.(http.Flusher)
				if hasFlusher {
					flusher.Flush()
				}

				// Stream Filter for <thought> tags
				var streamFilter *adapters.ThoughtStreamFilter
				if rules := adapters.ResolveAdapterRules(cand.Provider); rules != nil {
					streamFilter = adapters.NewStreamFilterFromRules(rules)
				}

				// Real-Time SSE Usage & StopReason Tracker (only when obsSink attached)
				var usageTracker *StreamUsageTracker
				if hasObs {
					usageTracker = NewStreamUsageTracker(reqStart, ttftMillis)
				}

				downBytes := 0
				// Pipe stream
				buf := make([]byte, 32*1024)
				for {
					n, readErr := peekRes.CombinedBody.Read(buf)
					if n > 0 {
						rawChunk := buf[:n]
						if usageTracker != nil {
							usageTracker.FeedChunk(rawChunk)
						}

						writeBytes := rawChunk
						if streamFilter != nil {
							writeBytes = streamFilter.FilterChunk(rawChunk)
						}

						if len(writeBytes) > 0 {
							downBytes += len(writeBytes)
							_, _ = w.Write(writeBytes)
							if hasFlusher {
								flusher.Flush()
							}
						}
					}
					if readErr != nil {
						break
					}
				}
				if streamFilter != nil {
					flushBytes := streamFilter.Flush()
					if len(flushBytes) > 0 {
						downBytes += len(flushBytes)
						_, _ = w.Write(flushBytes)
						if hasFlusher {
							flusher.Flush()
						}
					}
				}
				resp.Body.Close()
				rel()

				s.latency.Record(cand.KeyTag, tryTTFT)
				s.updateStickyKey(reqModel, sessionKey, route, globalStrategy, cand)

				if usageTracker != nil {
					usageTracker.Finish()
					flowMillis := usageTracker.FlowMillis
					totalMillis := time.Since(reqStart).Milliseconds()
					ownMillis := totalMillis - (sentMillis + flowMillis)
					if ownMillis < 0 {
						ownMillis = 0
					}
					tries = append(tries, types.Try{
						Attempt:     i + 1,
						Provider:    cand.Provider.ID,
						KeyID:       cand.KeyEntry.Label,
						Model:       cand.TargetModel,
						Status:      200,
						Millis:      time.Since(tryStart).Milliseconds(),
						TTFTMillis:  tryTTFT,
						RespHeaders: tryRespHeaders,
					})
					s.recordFinalTrace(types.RequestTrace{
						ID:                 traceID,
						Timestamp:          time.Now().Unix(),
						Mode:               "agent",
						Endpoint:           endpoint,
						ReqModel:           reqModel,
						ServedModel:        cand.TargetModel,
						WinnerProvider:     cand.Provider.ID,
						WinnerKey:          cand.KeyEntry.Label,
						Status:             200,
						Stream:             clientStream,
						InTokens:           usageTracker.InTokens,
						OutTokens:          usageTracker.OutTokens,
						CacheReadTokens:    usageTracker.CacheReadTokens,
						CacheWriteTokens:   usageTracker.CacheWriteTokens,
						CacheWrite1hTokens: usageTracker.CacheWrite1hTokens,
						ReasoningTokens:    usageTracker.ReasoningTokens,
						StopReason:         usageTracker.StopReason,
						TTFTMillis:         ttftMillis,
						FlowMillis:         flowMillis,
						OwnMillis:          ownMillis,
						QueuedMillis:       queuedMillis,
						SentMillis:         sentMillis,
						TotalMillis:        totalMillis,
						UpBytes:            len(mutatedBody),
						DownBytes:          downBytes,
						ReqHeaders:         reqHeaders,
						Tries:              tries,
					})
				}
				done = true
				retErr = nil
				return
			}

			// Case B: Non-streaming request (capped at 20 MiB to guard memory)
			respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
			resp.Body.Close()
			rel()
			if readErr != nil {
				return
			}

			transformed, transErr := s.engine.TransformNonStreamResponse(endpoint, respBody, cand.Provider, reqModel)
			if transErr == nil {
				respBody = transformed
			}

			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Routed-Via", cand.Provider.ID)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(respBody)

			s.latency.Record(cand.KeyTag, tryElapsed)
			s.updateStickyKey(reqModel, sessionKey, route, globalStrategy, cand)
			if hasObs {
				usageTracker := NewStreamUsageTracker(reqStart, tryElapsed)
				var respMap map[string]any
				if json.Unmarshal(respBody, &respMap) == nil {
					usageTracker.ParseJSON(respMap)
				}
				usageTracker.Finish()

				totalMillis := time.Since(reqStart).Milliseconds()
				ownMillis := totalMillis - (sentMillis + tryElapsed)
				if ownMillis < 0 {
					ownMillis = 0
				}
				tries = append(tries, types.Try{
					Attempt:     i + 1,
					Provider:    cand.Provider.ID,
					KeyID:       cand.KeyEntry.Label,
					Model:       cand.TargetModel,
					Status:      200,
					Millis:      tryElapsed,
					TTFTMillis:  tryElapsed,
					RespHeaders: tryRespHeaders,
				})
				s.recordFinalTrace(types.RequestTrace{
					ID:                 traceID,
					Timestamp:          time.Now().Unix(),
					Mode:               "agent",
					Endpoint:           endpoint,
					ReqModel:           reqModel,
					ServedModel:        cand.TargetModel,
					WinnerProvider:     cand.Provider.ID,
					WinnerKey:          cand.KeyEntry.Label,
					Status:             200,
					Stream:             clientStream,
					InTokens:           usageTracker.InTokens,
					OutTokens:          usageTracker.OutTokens,
					CacheReadTokens:    usageTracker.CacheReadTokens,
					CacheWriteTokens:   usageTracker.CacheWriteTokens,
					CacheWrite1hTokens: usageTracker.CacheWrite1hTokens,
					ReasoningTokens:    usageTracker.ReasoningTokens,
					StopReason:         usageTracker.StopReason,
					TTFTMillis:         tryElapsed,
					FlowMillis:         0,
					OwnMillis:          ownMillis,
					QueuedMillis:       queuedMillis,
					SentMillis:         sentMillis,
					TotalMillis:        totalMillis,
					UpBytes:            len(mutatedBody),
					DownBytes:          len(respBody),
					ReqHeaders:         reqHeaders,
					Tries:              tries,
				})
			}
			done = true
			retErr = nil
		}()

		if done {
			return retErr
		}
	}

	// All attempts failed
	if len(tries) > 0 {
		allAuthFailed := true
		for _, tr := range tries {
			if tr.Status != http.StatusUnauthorized && tr.Status != http.StatusForbidden && tr.Reason != "auth_error" {
				allAuthFailed = false
				break
			}
		}
		if allAuthFailed {
			if trigger, ok := s.configSource.(interface{ TriggerAllKeysFailed(ctx context.Context) }); ok {
				trigger.TriggerAllKeysFailed(ctx)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	status := lastStatus
	if status == 0 {
		status = http.StatusBadGateway
	}
	reason := lastErrSnippet
	if reason == "" && len(skips) > 0 {
		reason = "skipped: " + strings.Join(skips, "; ")
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": fmt.Sprintf("all candidate keys failed: %s", obs.ScrubString(reason)),
			"type":    "upstream_error",
		},
	})

	s.recordFinalTrace(types.RequestTrace{
		ID:          traceID,
		Timestamp:   time.Now().Unix(),
		Mode:        "agent",
		Endpoint:    endpoint,
		ReqModel:    reqModel,
		Status:      status,
		Stream:      clientStream,
		TotalMillis: time.Since(reqStart).Milliseconds(),
		ReqHeaders:  reqHeaders,
		Tries:       tries,
	})
	return ErrAllRetriesExhausted
}

func (s *Scheduler) updateStickyKey(reqModel, sessionKey string, route *types.AgentModelRoute, globalStrategy string, cand *CandidateKey) {
	if route == nil || cand == nil || s.sessionSticky == nil {
		return
	}
	strategy := route.RoutingStrategy
	if strategy == "" {
		strategy = globalStrategy
	}
	if strategy == "" {
		strategy = "sticky_failover"
	}
	if strategy != "sticky_failover" {
		return
	}
	if sessionKey != "" {
		s.sessionSticky.Set(reqModel, sessionKey, cand.KeyTag)
		return
	}
	s.sessionSticky.SetModelFallback(reqModel, cand.KeyTag)
}

func (s *Scheduler) hasObs() bool {
	s.mu.Lock()
	sink := s.obsSink
	s.mu.Unlock()
	if sink == nil {
		return false
	}
	return true
}

func (s *Scheduler) recordFinalTrace(trace types.RequestTrace) {
	s.mu.Lock()
	sink := s.obsSink
	s.mu.Unlock()
	if sink != nil {
		sink.RecordRequest(trace)
	}
}
