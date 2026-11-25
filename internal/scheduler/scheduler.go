package scheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/adapters"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/modelcatalog"
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
	// ErrProtocolUnsupported: the client called a dialect no candidate speaks.
	// Rejected with 400 before anything is sent upstream — forwarding would just
	// hand an Anthropic body to an OpenAI endpoint (or the reverse).
	ErrProtocolUnsupported = errors.New("scheduler: no candidate speaks the requested protocol")
)

// OAuthRefresher enables dynamic token refresh before dispatching requests.
type OAuthRefresher interface {
	EnsureValidToken(ctx context.Context, keyEntry *types.KeyEntry, endpoint string) error
}

// Scheduler coordinates upstream dispatching across candidate keys.
type Scheduler struct {
	mu                 sync.Mutex
	configSource       types.ConfigSource
	engine             types.AdapterEngine
	cooldowns          *CooldownManager
	obsSink            types.ObservabilitySink
	httpClient         *http.Client
	allowPrivate       bool
	clientsMu          sync.RWMutex
	clients            map[int]*http.Client // cached by firstByteTimeoutSec -> client
	lanes              *LaneTracker
	rpmLimiter         *RPMLimiter
	providerRPMLimiter *RPMLimiter
	rrIndex            map[string]int
	swrrCurrent        map[string]map[string]int
	latency            *LatencyTracker
	sessionSticky      *SessionStickyCache
	oauthRefresher     OAuthRefresher
	keepaliveInterval  time.Duration
	// catalog resolves per-model reasoning capabilities for candidates that pin
	// an effort. Loaded lazily from the embedded copy on first use.
	catalog *modelcatalog.Catalog
}

// SetModelCatalog injects the model capability catalog (the admin server owns
// the synced one); nil keeps the lazily-loaded embedded copy.
func (s *Scheduler) SetModelCatalog(c *modelcatalog.Catalog) {
	s.mu.Lock()
	s.catalog = c
	s.mu.Unlock()
}

// reasoningCatalog returns the catalog, loading the embedded copy on first use so
// a deployment that never pins an effort never pays for the parse.
func (s *Scheduler) reasoningCatalog() *modelcatalog.Catalog {
	s.mu.Lock()
	c := s.catalog
	s.mu.Unlock()
	if c != nil {
		return c
	}
	cat, err := modelcatalog.Bundled()
	if err != nil {
		return nil
	}
	s.mu.Lock()
	if s.catalog == nil {
		s.catalog = cat
	}
	c = s.catalog
	s.mu.Unlock()
	return c
}

// NewScheduler creates a Scheduler.
func NewScheduler(
	cfgSrc types.ConfigSource,
	obsSink types.ObservabilitySink,
	allowPrivate bool,
) *Scheduler {
	return &Scheduler{
		configSource:       cfgSrc,
		engine:             adapters.NewDefaultEngine(),
		cooldowns:          NewCooldownManager(),
		obsSink:            obsSink,
		httpClient:         upstream.UpstreamClient(120*time.Second, allowPrivate),
		allowPrivate:       allowPrivate,
		clients:            make(map[int]*http.Client),
		lanes:              NewLaneTracker(),
		rpmLimiter:         NewRPMLimiter(60 * time.Second),
		providerRPMLimiter: NewRPMLimiter(60 * time.Second),
		rrIndex:            make(map[string]int),
		swrrCurrent:        make(map[string]map[string]int),
		latency:            NewLatencyTracker(),
		sessionSticky:      NewSessionStickyCache(defaultSessionStickyTTL, defaultSessionStickyMaxSize),
		keepaliveInterval:  KeepaliveInterval,
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

// ProviderRPM returns the provider-wide sliding window RPM limiter. It is a
// separate RPMLimiter instance from the per-key one (RPM), so the provider:<id>
// buckets and the KeyTag ("provider:key_label") buckets can never share a
// window — the disjointness holds by construction, not by naming convention.
func (s *Scheduler) ProviderRPM() *RPMLimiter {
	return s.providerRPMLimiter
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
	// ReasoningEffort is the operator's per-candidate thinking level ("" = follow
	// the client). applyCandidateReasoning turns it into the dialect's wire knob.
	ReasoningEffort string
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
	return s.orderCandidates(route, providers, reqModel, "", SessionIdentity{}, false).candidates()
}

// OrderCandidatesForSession sorts candidate keys for a bare session key.
func (s *Scheduler) OrderCandidatesForSession(
	route *types.AgentModelRoute,
	providers map[string]*types.ProviderConfig,
	reqModel string,
	globalStrategy string,
	sessionKey string,
) []*CandidateKey {
	return s.orderCandidates(route, providers, reqModel, globalStrategy, SessionIdentity{Key: sessionKey}, false).candidates()
}

// OrderCandidatesForIdentity sorts candidate keys for a request's full session
// identity, keeping a subagent apart from its lead conversation.
func (s *Scheduler) OrderCandidatesForIdentity(
	route *types.AgentModelRoute,
	providers map[string]*types.ProviderConfig,
	reqModel string,
	globalStrategy string,
	ident SessionIdentity,
) []*CandidateKey {
	return s.orderCandidates(route, providers, reqModel, globalStrategy, ident, false).candidates()
}

// CandidateOrder is an ordering plus, for a brand-new conversation, the key whose
// lane it already occupies. Claim is "" when nothing was taken. The request owns
// ClaimRelease and must call it exactly once: the attempt loop passes it to the
// key's lane, or releases it when it never gets there.
type CandidateOrder struct {
	List         []*CandidateKey
	Claim        string
	ClaimRelease func()
}

func (o CandidateOrder) candidates() []*CandidateKey { return o.List }

// orderCandidates sorts candidate keys using per-session sticky affinity,
// falling back to globalStrategy -> route.ActiveKey / model sticky fallback, and
// spreading concurrent unbound sessions across healthy keys of the primary provider.
func (s *Scheduler) orderCandidates(
	route *types.AgentModelRoute,
	providers map[string]*types.ProviderConfig,
	reqModel string,
	globalStrategy string,
	ident SessionIdentity,
	claimOpening bool,
) CandidateOrder {
	sessionKey := ident.Key
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
				Provider:        p,
				KeyEntry:        k,
				TargetModel:     targetModel,
				KeyTag:          cand.Provider + ":" + k.Label,
				Weight:          cand.Weight,
				MaxConc:         cand.MaxConc,
				ReasoningEffort: cand.ReasoningEffort,
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
					Provider:        p,
					KeyEntry:        k,
					TargetModel:     targetModel,
					KeyTag:          tag,
					Weight:          cand.Weight,
					MaxConc:         cand.MaxConc,
					ReasoningEffort: cand.ReasoningEffort,
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
		return CandidateOrder{List: candidates}
	}

	switch strategy {
	case "manual":
		// Manual: only active key if present
		if route.ActiveKey != "" {
			for _, c := range candidates {
				if c.KeyTag == route.ActiveKey {
					return CandidateOrder{List: []*CandidateKey{c}}
				}
			}
		}
		return CandidateOrder{List: candidates}

	case "round_robin":
		return CandidateOrder{List: s.orderRoundRobin(candidates, reqModel)}

	case "weighted":
		return CandidateOrder{List: s.orderWeighted(candidates, reqModel)}

	case "least_busy":
		return CandidateOrder{List: s.orderLeastBusy(candidates, reqModel)}

	case "fast":
		return CandidateOrder{List: s.orderFast(candidates)}

	case "sticky_failover":
		fallthrough
	default:
		// 1. Per-session sticky affinity takes highest precedence so concurrent sessions never stomp each other.
		//    A subagent shares its lead's session key; GetWithLead starts it where the lead already
		//    warms the cache, and its own binding is written back under its agent id alone.
		bound := false
		if sessionKey != "" && s.sessionSticky != nil {
			if boundTag, ok := s.sessionSticky.GetWithLead(reqModel, sessionKey, ident.AgentID); ok {
				bound = true
				if reordered, moved := moveCandidateFirst(candidates, boundTag); moved {
					return CandidateOrder{List: reordered}
				}
			}
		}

		// 2. Explicit route.ActiveKey is an operator pin and outranks everything
		//    learned, including a session binding that landed elsewhere.
		if route.ActiveKey != "" {
			if reordered, moved := moveCandidateFirst(candidates, route.ActiveKey); moved {
				return CandidateOrder{List: reordered}
			}
		}

		// 3. A new conversation that shares its cacheable prefix with one already
		//    being served starts on the same key: the prefix is already warm there,
		//    so the second agent reads it instead of paying to write it again. Room is
		//    settled below, where the decision is also made atomic; returning here
		//    would let a whole burst read the same free slot.
		if !bound && ident.PrefixKey != "" && s.sessionSticky != nil {
			if tag := s.sessionSticky.GetPrefix(reqModel, ident.PrefixKey); tag != "" {
				if reordered, moved := moveCandidateFirst(candidates, tag); moved {
					candidates = reordered
				}
			}
		}

		// 4. Model-level fallback for requests without any session identity.
		if !bound && sessionKey == "" && s.sessionSticky != nil {
			if preferred := s.sessionSticky.GetModelFallback(reqModel); preferred != "" {
				if reordered, moved := moveCandidateFirst(candidates, preferred); moved {
					candidates = reordered
				}
			}
		}

		// 5. Overflow: only when the leading key has reached its soft concurrency
		//    cap (or is cooling / over RPM) does traffic move to a sibling. An
		//    uncapped key has room by definition, so it keeps the traffic and its
		//    cache instead of scattering it.
		if !bound && !s.candidateHasRoom(candidates[0]) {
			primaryProv := candidates[0].Provider.ID
			for _, c := range candidates[1:] {
				if c.Provider.ID == primaryProv && s.candidateHasRoom(c) {
					if reordered, moved := moveCandidateFirst(candidates, c.KeyTag); moved {
						candidates = reordered
					}
					break
				}
			}
		}

		// 6. Ordering alone cannot settle simultaneous arrivals — each sees the same
		//    idle keys — so an unbound request occupies its key's lane while it is
		//    still being ordered. Taking the slot here is what makes the cap exact
		//    under a burst; the request hands the release back to the attempt loop.
		if claimOpening && !bound && s.anyCandidateCapped(candidates) {
			choices := make([]LaneChoice, 0, len(candidates))
			for _, c := range candidates {
				if !s.isCandidateHealthy(c) {
					continue
				}
				choices = append(choices, LaneChoice{Tag: c.KeyTag, Cap: c.MaxConc})
			}
			if tag, release, ok := s.lanes.TryAcquire(choices); ok {
				if reordered, moved := moveCandidateFirst(candidates, tag); moved {
					candidates = reordered
				}
				return CandidateOrder{List: candidates, Claim: tag, ClaimRelease: release}
			}
		}

		return CandidateOrder{List: candidates}
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

// isCandidateHealthy reports whether c can take a request now: not cooling
// down and within its RPM quota. It deliberately ignores in-flight load, so a
// caller that has just claimed c's lane slot is not refused by its own claim.
// Both RPM probes are non-consuming Allow checks — the consuming TryAcquire
// happens in the attempt walks. Provider.RPMPerKey is the provider's OVERALL
// RPM ceiling (0 = unlimited) shared by all its keys, not a per-key limit, so
// a provider whose window is exhausted marks every one of its keys unhealthy.
func (s *Scheduler) isCandidateHealthy(c *CandidateKey) bool {
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
	if s.providerRPMLimiter != nil && c.Provider.RPMPerKey > 0 && !s.providerRPMLimiter.Allow(providerRPMKey(c.Provider.ID), c.Provider.RPMPerKey) {
		return false
	}
	if s.rpmLimiter != nil {
		if rpmLimit := c.KeyEntry.MaxRPM; rpmLimit > 0 && !s.rpmLimiter.Allow(c.KeyTag, rpmLimit) {
			return false
		}
	}
	return true
}

// appendSkipOnce appends msg to skips unless the exact message is already
// recorded. A provider-wide limit is re-hit by every remaining candidate of the
// same provider, and the joined "skipped: ..." message would otherwise repeat
// the entry once per candidate.
func appendSkipOnce(skips []string, msg string) []string {
	for _, s := range skips {
		if s == msg {
			return skips
		}
	}
	return append(skips, msg)
}

// candidateHasRoom reports whether c can take another request without passing
// its soft concurrency cap. A key with no cap (MaxConc == 0) always has room:
// staying on it is exactly what keeps a shared prompt cache warm, so load alone
// must never push traffic off an uncapped key.
func (s *Scheduler) candidateHasRoom(c *CandidateKey) bool {
	if !s.isCandidateHealthy(c) {
		return false
	}
	if c.MaxConc <= 0 {
		return true
	}
	// A request that ordered before this one may not have reached its lane yet.
	return s.candidateLoad(c) < c.MaxConc
}

// anyCandidateCapped reports whether any candidate has a concurrency cap. Without
// one, nothing can fill up, so taking a lane during ordering would be pointless.
func (s *Scheduler) anyCandidateCapped(candidates []*CandidateKey) bool {
	for _, c := range candidates {
		if c != nil && c.MaxConc > 0 {
			return true
		}
	}
	return false
}

// candidateLoad is a candidate's current load: every request that holds one of
// its slots, whether it is still being prepared or already on the wire.
func (s *Scheduler) candidateLoad(c *CandidateKey) int {
	if s == nil || s.lanes == nil || c == nil {
		return 0
	}
	return s.lanes.BusyCount(c.KeyTag)
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
) (dispatchErr error) {
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

	// Failure bookkeeping lives here so the deferred one-line app.log writer can
	// see the final attempt and every key literal used on the way out.
	var (
		tries          []types.Try
		usedSecrets    []string
		lastStatus     int
		logErrFallback string // human-readable cause when no try carries the text (e.g. all keys skipped)
	)
	defer func() {
		s.logDispatchOutcome(traceID, reqModel, endpoint, lastStatus, tries,
			time.Since(reqStart).Milliseconds(), usedSecrets, logErrFallback, dispatchErr)
	}()

	// Hard total budget: 300s
	budgetCtx, cancel := context.WithTimeout(ctx, HardBudgetTimeout)
	defer cancel()

	snap, err := s.configSource.Current(budgetCtx, false)
	if err != nil {
		lastStatus = http.StatusServiceUnavailable
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
		tries = append(tries, s.recordLocalFailure(traceID, endpoint, reqModel, http.StatusServiceUnavailable,
			ReasonConfigUnavailable, msg, clientStream, reqStart, reqHeaders, usedSecrets))
		return err
	}

	category := ""
	if reqModel == "chat" {
		category = "chat"
	}
	route, exists := ResolveRoute(snap.Config, category, reqModel)
	if !exists || !route.Enabled {
		lastStatus = http.StatusNotFound
		msg := fmt.Sprintf("model %q not configured or disabled", reqModel)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": msg,
				"type":    "invalid_request_error",
			},
		})
		tries = append(tries, s.recordLocalFailure(traceID, endpoint, reqModel, http.StatusNotFound,
			ReasonModelNotFound, msg, clientStream, reqStart, reqHeaders, usedSecrets))
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

	// The gateway forwards bodies untouched and only swaps the endpoint, so a
	// client dialect no candidate speaks would reach the upstream as a malformed
	// request. Reject it here, before any key is spent, with a message that
	// names the fix (call the other entry point, or declare anthropic_base_url).
	if r != nil {
		if proto := EntryProtocol(r.URL.Path); proto != "" {
			if ok, notes := RouteServesProtocol(route, snap.Config.Providers, proto); !ok && len(notes) > 0 {
				msg := protocolMismatchMessage(reqModel, proto, r.URL.Path, notes)
				lastStatus = http.StatusBadRequest
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"message": msg,
						"type":    "invalid_request_error",
					},
				})

				// Nothing was dialed, but the reason this request never spent a key
				// still belongs in the trace and in the failure log line.
				now := time.Now()
				tries = append(tries, types.Try{
					Attempt:      1,
					Model:        reqModel,
					Status:       http.StatusBadRequest,
					Reason:       ReasonProtocolMismatch,
					Error:        compressErrorText(msg, usedSecrets),
					ErrorSnippet: obs.ScrubStringWithSecrets(msg, usedSecrets...),
				})
				s.recordFinalTrace(types.RequestTrace{
					ID:          traceID,
					Timestamp:   now.Unix(),
					Mode:        "agent",
					Endpoint:    endpoint,
					ReqModel:    reqModel,
					Status:      http.StatusBadRequest,
					Stream:      clientStream,
					TotalMillis: time.Since(reqStart).Milliseconds(),
					ReqHeaders:  reqHeaders,
					Tries:       tries,
				})
				return ErrProtocolUnsupported
			}
		}
	}

	ident := ExtractSessionIdentity(r, reqBody)
	globalStrategy := snap.Config.Settings.AgentRoutingStrategy
	order := s.orderCandidates(route, snap.Config.Providers, reqModel, globalStrategy, ident, true)
	candidates := order.List
	// The claim is a real lane slot, taken while ordering so a burst cannot all
	// see the same free slot. The attempt loop reuses it for the claimed key; if
	// this request never reaches that key, the slot is given back on return.
	claimRelease := order.ClaimRelease
	if claimRelease != nil {
		defer func() {
			if claimRelease != nil {
				claimRelease()
			}
		}()
	}
	if len(candidates) == 0 {
		lastStatus = http.StatusServiceUnavailable
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
		tries = append(tries, s.recordLocalFailure(traceID, endpoint, reqModel, http.StatusServiceUnavailable,
			ReasonNoCandidate, msg, clientStream, reqStart, reqHeaders, usedSecrets))
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

	var attempts []TryAttempt
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

		// 2. Pre-flight RPM checks: the provider-wide sliding window first (cheap,
		// and one exhausted window stops every key of the provider at once), then
		// the per-key limit. Provider.RPMPerKey is the provider's OVERALL RPM
		// ceiling (0 = unlimited), not a per-key limit — it must never fall back
		// into the key-level check, or N keys would each get the whole-provider
		// ceiling. Both takes return undo tokens: a candidate refused after the
		// provider take (key-level quota, OAuth refresh, request build) hands the
		// provider token back, so attempts that never dial never consume the
		// provider window.
		var releaseProviderRPM, releaseKeyRPM func()
		if cand.Provider != nil && cand.Provider.RPMPerKey > 0 {
			rel, ok := s.providerRPMLimiter.TryAcquireToken(providerRPMKey(cand.Provider.ID), cand.Provider.RPMPerKey)
			if !ok {
				skips = appendSkipOnce(skips, fmt.Sprintf("%s (provider RPM limit)", cand.Provider.ID))
				continue
			}
			releaseProviderRPM = rel
		}
		if rpmLimit := cand.KeyEntry.MaxRPM; rpmLimit > 0 {
			rel, ok := s.rpmLimiter.TryAcquireToken(cand.KeyTag, rpmLimit)
			if !ok {
				// Over quota! Skip key cleanly before dialing upstream and hand the
				// provider token back — this candidate will not make a request.
				if releaseProviderRPM != nil {
					releaseProviderRPM()
				}
				skips = appendSkipOnce(skips, fmt.Sprintf("%s (RPM limit)", keyID))
				continue
			}
			releaseKeyRPM = rel
		}

		var (
			done   bool
			retErr error
		)
		func() {
			// Any failure before the request is on the wire gives the RPM tokens
			// back: the sliding windows must count requests that were actually
			// sent, not attempts that never dialed. onWire flips just before the
			// HTTP call; from there the tokens stay (the attempt is real traffic).
			onWire := false
			defer func() {
				if onWire {
					return
				}
				if releaseKeyRPM != nil {
					releaseKeyRPM()
				}
				if releaseProviderRPM != nil {
					releaseProviderRPM()
				}
			}()

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
					reason, errType := ClassifyFailure(http.StatusUnauthorized, []byte(lastErrSnippet), FailureKindHTTP)
					tries = append(tries, types.Try{
						Attempt:            i + 1,
						Provider:           cand.Provider.ID,
						KeyID:              cand.KeyEntry.Label,
						Model:              cand.TargetModel,
						Status:             http.StatusUnauthorized,
						Millis:             time.Since(tryStart).Milliseconds(),
						Reason:             reason,
						ErrType:            errType,
						Error:              compressErrorText(lastErrSnippet, usedSecrets),
						CooldownAppliedSec: cooldownSec,
						ErrorSnippet:       obs.ScrubStringWithSecrets(lastErrSnippet, usedSecrets...),
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
			// The route editor lets the operator pin a thinking level per
			// candidate; honour it on the wire instead of only storing it.
			if cand.ReasoningEffort != "" && !route.NoReasoning {
				mutatedBody = applyCandidateReasoning(mutatedBody, cand, cand.Provider, s.reasoningCatalog())
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
			if rawKey != "" {
				usedSecrets = append(usedSecrets, rawKey)
			}
			applyUpstreamHeaders(upReq, r, endpoint, cand.Provider, rawKey, extraHeaders)

			// Concurrency tracking: acquire busy slot with MaxConc (guaranteed release via defer)
			queuedMillis := time.Since(queuedStart).Milliseconds()
			cancelWait()

			var releaseBusy func()
			if claimRelease != nil && cand.KeyTag == order.Claim {
				// Ordering already took this key's slot; the attempt inherits it.
				releaseBusy, claimRelease = claimRelease, nil
			} else {
				releaseBusy = s.lanes.Acquire(cand.KeyTag, cand.MaxConc)
			}
			var relOnce sync.Once
			rel := func() { relOnce.Do(releaseBusy) }
			defer rel()

			// Execute HTTP call
			sendStart := time.Now()
			onWire = true
			resp, callErr := client.Do(upReq)
			sentMillis := time.Since(sendStart).Milliseconds()
			tryElapsed := time.Since(tryStart).Milliseconds()

			if callErr != nil {
				lastStatus = 504
				lastErrSnippet = callErr.Error()
				kind := classifyTransportError(callErr, ctx)
				reason, errType := ClassifyFailure(504, []byte(lastErrSnippet), kind)
				cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, 504, durRateLimit, durServerError, durNetwork, durAuth)
				tries = append(tries, types.Try{
					Attempt:            i + 1,
					Provider:           cand.Provider.ID,
					KeyID:              cand.KeyEntry.Label,
					Model:              cand.TargetModel,
					Status:             504,
					Millis:             tryElapsed,
					Reason:             reason,
					ErrType:            errType,
					Error:              compressErrorText(lastErrSnippet, usedSecrets),
					CooldownAppliedSec: cooldownSec,
					ErrorSnippet:       obs.ScrubStringWithSecrets(lastErrSnippet, usedSecrets...),
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

				reason, errType := ClassifyFailure(resp.StatusCode, errBytes, FailureKindHTTP)
				requestID := ExtractRequestID(resp.Header)

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
					ErrType:            errType,
					Error:              compressErrorText(lastErrSnippet, usedSecrets),
					RequestID:          requestID,
					CooldownAppliedSec: cooldownSec,
					ErrorSnippet:       obs.ScrubStringWithSecrets(lastErrSnippet, usedSecrets...),
					RespHeaders:        tryRespHeaders,
				})

				// Check Magpie forbiddenAlike
				if CheckForbiddenAlike(attempts, currAttempt, s.cooldowns) {
					// Immediate abort: it's a client error, don't burn other keys!
					scrubbedErr := obs.ScrubWithSecrets(errBytes, usedSecrets...)
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
					// The upstream header said 200; the body is what failed. Keep the
					// response status in step with the try (502), or the all-failed
					// fallthrough would answer the client with 200 + an error body.
					lastStatus = 502
					kind := classifyPeekError(peekErr, ctx)
					reason, errType := ClassifyFailure(502, []byte(lastErrSnippet), kind)
					cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, 502, durRateLimit, durServerError, durNetwork, durAuth)
					tries = append(tries, types.Try{
						Attempt:            i + 1,
						Provider:           cand.Provider.ID,
						KeyID:              cand.KeyEntry.Label,
						Model:              cand.TargetModel,
						Status:             502,
						Millis:             tryElapsed,
						TTFTMillis:         tryTTFT,
						Reason:             reason,
						ErrType:            errType,
						Error:              compressErrorText(lastErrSnippet, usedSecrets),
						RequestID:          ExtractRequestID(resp.Header),
						CooldownAppliedSec: cooldownSec,
						ErrorSnippet:       obs.ScrubStringWithSecrets(lastErrSnippet, usedSecrets...),
						RespHeaders:        tryRespHeaders,
					})
					if streamHeadersCommitted {
						// Stream headers already flushed via keepalive: emit SSE error event and abort cleanly
						errPayload, _ := json.Marshal(map[string]any{
							"error": map[string]any{
								"message": obs.ScrubStringWithSecrets(lastErrSnippet, usedSecrets...),
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
						// A 200 stream that cannot be aggregated into JSON is an
						// unusable body, not a success — record it and fail over.
						lastStatus = http.StatusBadGateway
						lastErrSnippet = aggErr.Error()
						reason, errType := ClassifyFailure(502, []byte(lastErrSnippet), FailureKindBadResponse)
						tries = append(tries, types.Try{
							Attempt:      i + 1,
							Provider:     cand.Provider.ID,
							KeyID:        cand.KeyEntry.Label,
							Model:        cand.TargetModel,
							Status:       http.StatusBadGateway,
							Millis:       tryElapsed,
							TTFTMillis:   tryTTFT,
							Reason:       reason,
							ErrType:      errType,
							Error:        compressErrorText(lastErrSnippet, usedSecrets),
							RequestID:    ExtractRequestID(resp.Header),
							ErrorSnippet: obs.ScrubStringWithSecrets(lastErrSnippet, usedSecrets...),
							RespHeaders:  tryRespHeaders,
						})
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("X-Routed-Via", cand.Provider.ID)
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write(aggBytes)
					s.latency.Record(cand.KeyTag, tryElapsed)
					s.updateStickyKey(reqModel, ident, route, globalStrategy, cand)

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
							InTokens:       usageTracker.InTokens,
							OutTokens:      usageTracker.OutTokens,
							StopReason:     usageTracker.StopReason,
							TTFTMillis:     ttftMillis,
							TotalMillis:    totalMillis,
							UpBytes:        len(mutatedBody),
							DownBytes:      len(synthBytes),
							ReqHeaders:     reqHeaders,
							Tries:          tries,
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
				s.updateStickyKey(reqModel, ident, route, globalStrategy, cand)

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
				// Truncated body (connection reset mid-body, malformed JSON): the
				// 200 header alone is not a usable answer. Record it and fail over.
				lastStatus = http.StatusBadGateway
				lastErrSnippet = readErr.Error()
				kind := classifyTransportError(readErr, ctx)
				if kind != FailureKindClientAbort {
					kind = FailureKindBadResponse
				}
				reason, errType := ClassifyFailure(502, []byte(lastErrSnippet), kind)
				tries = append(tries, types.Try{
					Attempt:      i + 1,
					Provider:     cand.Provider.ID,
					KeyID:        cand.KeyEntry.Label,
					Model:        cand.TargetModel,
					Status:       http.StatusBadGateway,
					Millis:       tryElapsed,
					Reason:       reason,
					ErrType:      errType,
					Error:        compressErrorText(lastErrSnippet, usedSecrets),
					RequestID:    ExtractRequestID(resp.Header),
					ErrorSnippet: obs.ScrubStringWithSecrets(lastErrSnippet, usedSecrets...),
					RespHeaders:  tryRespHeaders,
				})
				return
			}

			// A 200 can still be an error the upstream wrote into the body after its
			// headers were out. Read as success it would be returned to the caller as
			// the answer; it fails as the status it names instead.
			if errStatus, errSnippet, isErr := errInSuccessBody(respBody); isErr {
				lastStatus = errStatus
				lastErrSnippet = errSnippet
				cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, errStatus, durRateLimit, durServerError, durNetwork, durAuth)
				reason, errType := ClassifyFailure(errStatus, []byte(errSnippet), FailureKindHTTP)
				currAttempt := TryAttempt{
					Provider:     cand.Provider.ID,
					KeyID:        keyID,
					Model:        cand.TargetModel,
					Status:       errStatus,
					ErrorSnippet: errSnippet,
				}
				tries = append(tries, types.Try{
					Attempt:            i + 1,
					Provider:           cand.Provider.ID,
					KeyID:              cand.KeyEntry.Label,
					Model:              cand.TargetModel,
					Status:             errStatus,
					Millis:             tryElapsed,
					Reason:             reason,
					ErrType:            errType,
					Error:              compressErrorText(errSnippet, usedSecrets),
					RequestID:          ExtractRequestID(resp.Header),
					CooldownAppliedSec: cooldownSec,
					ErrorSnippet:       obs.ScrubStringWithSecrets(errSnippet, usedSecrets...),
					RespHeaders:        tryRespHeaders,
				})

				if CheckForbiddenAlike(attempts, currAttempt, s.cooldowns) {
					scrubbedErr := obs.ScrubWithSecrets(respBody, usedSecrets...)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(errStatus)
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
						Status:         errStatus,
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

			transformed, transErr := s.engine.TransformNonStreamResponse(endpoint, respBody, cand.Provider, reqModel)
			if transErr == nil {
				respBody = transformed
			}

			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Routed-Via", cand.Provider.ID)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(respBody)

			s.latency.Record(cand.KeyTag, tryElapsed)
			s.updateStickyKey(reqModel, ident, route, globalStrategy, cand)
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
			if tr.Status != http.StatusUnauthorized && tr.Status != http.StatusForbidden && tr.Reason != ReasonAuthInvalid {
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
	lastStatus = status // keep the failure log line in step with what the client saw
	reason := lastErrSnippet
	if reason == "" && len(skips) > 0 {
		reason = "skipped: " + strings.Join(skips, "; ")
	}
	logErrFallback = reason
	// Every candidate was skipped before dialing (all keys cooling down, RPM
	// capped, disabled). Without a synthetic Try the trace and the usage ledger
	// carry tries=0 and no reason, leaving the console's error analysis unable
	// to explain a 502 that is purely a local admission decision.
	if len(tries) == 0 {
		tries = append(tries, types.Try{
			Status: status,
			Reason: ReasonNoCandidate,
			Error:  compressErrorText(reason, usedSecrets),
		})
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": fmt.Sprintf("all candidate keys failed: %s", obs.ScrubStringWithSecrets(reason, usedSecrets...)),
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

func (s *Scheduler) updateStickyKey(reqModel string, ident SessionIdentity, route *types.AgentModelRoute, globalStrategy string, cand *CandidateKey) {
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
	// A lead request also teaches the prefix binding: the next conversation on the
	// same project starts on this key and reads the prefix already cached here. A
	// subagent is skipped — it inherits the lead's key, so it adds no information
	// and would only move the shared binding onto whichever key it failed over to.
	if ident.PrefixKey != "" && ident.AgentID == "" {
		s.sessionSticky.SetPrefix(reqModel, ident.PrefixKey, cand.KeyTag)
	}
	if ident.Key != "" {
		// A subagent's answer binds the subagent slot only. Writing the lead's
		// slot here is what moved a lead conversation to whichever account a
		// subagent happened to reach, throwing away the cache it had built.
		s.sessionSticky.Set(reqModel, ident.Key, ident.AgentID, cand.KeyTag)
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

// recordLocalFailure records a request the gateway rejected before dialing any
// upstream: no usable config, model not configured, no candidate key left.
// These used to exist only in app.log, so the console's recent-requests and
// error-analysis panels silently omitted them — and "model X is not configured"
// is exactly the client error an operator needs to see there.
//
// The synthetic Try carries the reason but no provider/key, which marks it as a
// local decision rather than an upstream attempt (per-key health stats ignore it).
// It is returned so the caller can append it to its own tries slice and keep the
// deferred app.log line in step with the trace.
func (s *Scheduler) recordLocalFailure(
	traceID, endpoint, reqModel string,
	status int,
	reason, message string,
	stream bool,
	start time.Time,
	reqHeaders map[string]string,
	usedSecrets []string,
) types.Try {
	msg := message
	if msg == "" {
		msg = reason
	}
	try := types.Try{
		Status: status,
		Reason: reason,
		Error:  compressErrorText(msg, usedSecrets),
	}
	s.recordFinalTrace(types.RequestTrace{
		ID:          traceID,
		Timestamp:   time.Now().Unix(),
		Mode:        "agent",
		Endpoint:    endpoint,
		ReqModel:    reqModel,
		Status:      status,
		Stream:      stream,
		TotalMillis: time.Since(start).Milliseconds(),
		ReqHeaders:  reqHeaders,
		Tries:       []types.Try{try},
	})
	return try
}

// logDispatchOutcome writes exactly one app.log line when the request ended in
// failure (non-nil error, or any Try with status >= 400 / == 0). Successful
// single-attempt requests stay silent so the log is a failure ledger rather
// than a copy of the traffic. Consecutive same-(provider,key,reason) failures
// are intentionally not aggregated here — the usage ledger does that.
func (s *Scheduler) logDispatchOutcome(
	traceID, reqModel, endpoint string,
	lastStatus int,
	tries []types.Try,
	totalMillis int64,
	usedSecrets []string,
	fallbackErr string,
	dispatchErr error,
) {
	failed := dispatchErr != nil
	for _, tr := range tries {
		if tr.Status >= 400 || tr.Status == 0 {
			failed = true
			break
		}
	}
	if !failed {
		return
	}

	// The line describes the LAST FAILURE, not the last attempt: on a successful
	// failover the final try succeeded, so reading it would print reason=- and
	// hide the very thing the operator is looking for (why did the first key
	// fail?). When a later try did succeed, that is appended so the line also
	// answers "did the client get an answer?".
	var last types.Try
	for i := len(tries) - 1; i >= 0; i-- {
		if tries[i].Status >= 400 || tries[i].Status == 0 {
			last = tries[i]
			break
		}
	}
	status := lastStatus
	if status == 0 && last.Status != 0 {
		status = last.Status
	}
	errText := last.Error
	if errText == "" {
		errText = last.ErrorSnippet
	}
	if errText == "" {
		errText = fallbackErr
	}
	if errText == "" && dispatchErr != nil {
		errText = dispatchErr.Error()
	}
	errText = obs.ScrubStringWithSecrets(CompressError([]byte(errText), DefaultErrorTextMax), usedSecrets...)
	if errText == "" {
		errText = "-"
	}

	line := fmt.Sprintf(
		"req=%s model=%s endpoint=%s status=%d reason=%s err_type=%s provider=%s key=%s tries=%d ms=%d err=%s",
		logField(traceID, 128),
		logField(reqModel, 128),
		logField(endpoint, 128),
		status,
		logField(last.Reason, maxErrTypeLen),
		logField(last.ErrType, maxErrTypeLen),
		logField(last.Provider, 64),
		logField(last.KeyID, 64),
		len(tries),
		totalMillis,
		errText,
	)
	// Fallbacks exhausted (no candidate was ever attempted) carry their reason
	// only in fallbackErr, so reason/err_type print "-". Name the skips so the
	// line still explains itself: every key cooling down, RPM-capped, etc.
	if last.Reason == "" && fallbackErr != "" {
		line += " note=" + logField(obs.ScrubStringWithSecrets(CompressError([]byte(fallbackErr), DefaultErrorTextMax), usedSecrets...), 512)
	}
	// A failure followed by a successful failover: the client got 200, and the
	// log says so rather than reading like a total failure.
	if lastStatus >= 200 && lastStatus < 300 && len(tries) > 0 {
		if final := tries[len(tries)-1]; final.Status >= 200 && final.Status < 300 {
			line += fmt.Sprintf(" recovered_by=%s/%s", logField(final.Provider, 64), logField(final.KeyID, 64))
		}
	}
	log.Printf("%s", obs.ScrubStringWithSecrets(line, usedSecrets...))
}
