package scheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/adapters"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

const (
	ewmaAlpha          = 0.30
	maxLatencyEntries  = 4096
	defaultMaxConcWait = 300 * time.Second
)

// LatencyTracker records smoothed EWMA latencies (ms) per candidate KeyTag
// to power Magpie-style "fast" adaptive routing under high concurrency.
type LatencyTracker struct {
	mu      sync.RWMutex
	samples map[string]float64
}

// NewLatencyTracker creates an EWMA LatencyTracker.
func NewLatencyTracker() *LatencyTracker {
	return &LatencyTracker{
		samples: make(map[string]float64),
	}
}

// Record updates the EWMA latency for keyTag with elapsedMs (>= 1).
func (lt *LatencyTracker) Record(keyTag string, elapsedMs int64) {
	if lt == nil || keyTag == "" {
		return
	}
	v := float64(elapsedMs)
	if v < 1 {
		v = 1
	}

	lt.mu.Lock()
	defer lt.mu.Unlock()

	if prev, ok := lt.samples[keyTag]; ok {
		lt.samples[keyTag] = ewmaAlpha*v + (1-ewmaAlpha)*prev
		return
	}
	if len(lt.samples) >= maxLatencyEntries {
		// Evict one arbitrary entry to keep bounded memory footprint
		for k := range lt.samples {
			delete(lt.samples, k)
			break
		}
	}
	lt.samples[keyTag] = v
}

// Get returns the smoothed EWMA latency in ms and whether a sample exists.
func (lt *LatencyTracker) Get(keyTag string) (float64, bool) {
	if lt == nil || keyTag == "" {
		return 0, false
	}
	lt.mu.RLock()
	defer lt.mu.RUnlock()
	v, ok := lt.samples[keyTag]
	return v, ok
}

// IsSaturated returns true if candidate c specifies a positive MaxConc and
// its current active (busy + waiting) count meets or exceeds MaxConc.
func (s *Scheduler) isCandidateSaturated(c *CandidateKey) bool {
	if c == nil || c.MaxConc <= 0 || s.lanes == nil {
		return false
	}
	return s.lanes.ActiveCount(c.KeyTag) >= c.MaxConc
}

// partitionFreeCandidates moves unsaturated candidates (ActiveCount < MaxConc)
// ahead of saturated ones while preserving relative strategy order in each group.
func (s *Scheduler) partitionFreeCandidates(candidates []*CandidateKey) []*CandidateKey {
	if len(candidates) <= 1 || s.lanes == nil {
		return candidates
	}
	var free, busy []*CandidateKey
	for _, c := range candidates {
		if s.isCandidateSaturated(c) {
			busy = append(busy, c)
		} else {
			free = append(free, c)
		}
	}
	if len(free) == 0 || len(busy) == 0 {
		return candidates
	}
	return append(free, busy...)
}

// orderRoundRobin rotates candidates using per-model cursor and partitions free slots first.
func (s *Scheduler) orderRoundRobin(candidates []*CandidateKey, modelKey string) []*CandidateKey {
	n := len(candidates)
	s.mu.Lock()
	idx := s.rrIndex[modelKey]
	s.rrIndex[modelKey] = (idx + 1) % n
	s.mu.Unlock()

	reordered := make([]*CandidateKey, n)
	for i := 0; i < n; i++ {
		reordered[i] = candidates[(idx+i)%n]
	}
	return s.partitionFreeCandidates(reordered)
}

// orderWeighted selects the starting candidate using Nginx-style smooth weighted
// round-robin (Magpie "weight" strategy) and keeps free-slot candidates ahead.
func (s *Scheduler) orderWeighted(candidates []*CandidateKey, modelKey string) []*CandidateKey {
	n := len(candidates)
	weights := make([]int, n)
	totalWeight := 0
	for i, c := range candidates {
		w := c.Weight
		if w <= 0 && c.KeyEntry != nil && c.KeyEntry.Weight > 0 {
			w = c.KeyEntry.Weight
		}
		if w <= 0 {
			w = 1
		}
		if w > 1000 {
			w = 1000
		}
		weights[i] = w
		totalWeight += w
	}

	s.mu.Lock()
	if s.swrrCurrent == nil {
		s.swrrCurrent = make(map[string]map[string]int)
	}
	curMap, ok := s.swrrCurrent[modelKey]
	if !ok {
		curMap = make(map[string]int, n)
		s.swrrCurrent[modelKey] = curMap
	}

	bestIdx := 0
	bestScore := -1 << 30
	for i, c := range candidates {
		cur := curMap[c.KeyTag] + weights[i]
		curMap[c.KeyTag] = cur
		if cur > bestScore {
			bestScore = cur
			bestIdx = i
		}
	}
	curMap[candidates[bestIdx].KeyTag] -= totalWeight
	s.mu.Unlock()

	reordered := make([]*CandidateKey, n)
	for i := 0; i < n; i++ {
		reordered[i] = candidates[(bestIdx+i)%n]
	}
	return s.partitionFreeCandidates(reordered)
}

// orderLeastBusy sorts candidates by lowest active utilization (ActiveCount / MaxConc,
// or raw ActiveCount when MaxConc == 0), rotating ties via rrIndex.
func (s *Scheduler) orderLeastBusy(candidates []*CandidateKey, modelKey string) []*CandidateKey {
	n := len(candidates)
	s.mu.Lock()
	idx := s.rrIndex[modelKey]
	s.rrIndex[modelKey] = (idx + 1) % n
	s.mu.Unlock()

	rotated := make([]*CandidateKey, n)
	for i := 0; i < n; i++ {
		rotated[i] = candidates[(idx+i)%n]
	}

	sort.SliceStable(rotated, func(i, j int) bool {
		ci, cj := rotated[i], rotated[j]
		si, sj := s.isCandidateSaturated(ci), s.isCandidateSaturated(cj)
		if si != sj {
			return !si
		}
		ai, aj := 0, 0
		if s.lanes != nil {
			ai = s.lanes.ActiveCount(ci.KeyTag)
			aj = s.lanes.ActiveCount(cj.KeyTag)
		}
		// Compare relative utilization when both specify MaxConc
		if ci.MaxConc > 0 && cj.MaxConc > 0 {
			li := float64(ai) / float64(ci.MaxConc)
			lj := float64(aj) / float64(cj.MaxConc)
			if li != lj {
				return li < lj
			}
		}
		return ai < aj
	})
	return rotated
}

// orderFast sorts candidates by lowest EWMA latency (Magpie "fast" strategy),
// placing unsaturated & unmeasured candidates ahead so new keys get sampled.
func (s *Scheduler) orderFast(candidates []*CandidateKey) []*CandidateKey {
	copied := append([]*CandidateKey(nil), candidates...)
	sort.SliceStable(copied, func(i, j int) bool {
		ci, cj := copied[i], copied[j]
		si, sj := s.isCandidateSaturated(ci), s.isCandidateSaturated(cj)
		if si != sj {
			return !si
		}
		li, oki := s.latency.Get(ci.KeyTag)
		lj, okj := s.latency.Get(cj.KeyTag)
		if oki != okj {
			return !oki // Probe unmeasured candidates first
		}
		if oki && okj && li != lj {
			return li < lj
		}
		ai, aj := 0, 0
		if s.lanes != nil {
			ai = s.lanes.ActiveCount(ci.KeyTag)
			aj = s.lanes.ActiveCount(cj.KeyTag)
		}
		return ai < aj
	})
	return copied
}

// ResolveRoute resolves an AgentModelRoute from unified AgentModels first, falling back
// seamlessly to legacy KBModels for the 4 fixed slots (chat, embedding, reranker, ocr).
// For embedding/reranker, a concrete reqModel (e.g. "bge-m3") also filters matching
// candidates inside the category slot when no standalone AgentModels[reqModel] entry exists.
func ResolveRoute(cfg *types.ProxyConfig, category, reqModel string) (*types.AgentModelRoute, bool) {
	if cfg == nil {
		return nil, false
	}
	if reqModel != "" {
		if r, ok := cfg.AgentModels[reqModel]; ok && r != nil && r.Enabled && len(r.Candidates) > 0 {
			return r, true
		}
	}

	if category == "" {
		category = reqModel
	}
	if category != "" {
		if r, ok := cfg.AgentModels[category]; ok && r != nil && r.Enabled && len(r.Candidates) > 0 {
			if reqModel != "" && reqModel != category {
				var matched []*types.RouteCandidate
				for _, c := range r.Candidates {
					if c != nil && c.Enabled && c.TargetModel == reqModel {
						matched = append(matched, c)
					}
				}
				if len(matched) > 0 {
					cloned := *r
					cloned.Candidates = matched
					return &cloned, true
				}
				return nil, false
			}
			return r, true
		}
	}

	// Backward-compatible fallback to legacy cfg.KBModels[category]
	kbList, ok := cfg.KBModels[category]
	if !ok || len(kbList) == 0 {
		return nil, false
	}

	var cands []*types.RouteCandidate
	for _, kc := range kbList {
		if kc == nil || !kc.Enabled {
			continue
		}
		if reqModel != "" && reqModel != category && (category == "embedding" || category == "reranker") {
			if kc.Model != reqModel {
				continue
			}
		}
		cands = append(cands, &types.RouteCandidate{
			Provider:    kc.Provider,
			KeyLabel:    kc.KeyLabel,
			TargetModel: kc.Model,
			Enabled:     true,
			Weight:      1,
			MaxConc:     kc.MaxConc,
		})
	}
	if len(cands) == 0 {
		return nil, false
	}

	return &types.AgentModelRoute{
		Enabled:         true,
		RoutingStrategy: "round_robin",
		NoReasoning:     category == "chat",
		ForceNonStream:  category == "chat",
		Candidates:      cands,
	}, true
}

func applyRouteNormalization(body []byte, noReasoning, forceNonStream bool) ([]byte, bool) {
	if (!noReasoning && !forceNonStream) || len(body) == 0 {
		return body, false
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return body, false
	}
	changed := false
	if noReasoning {
		for _, k := range []string{"reasoning_effort", "thinking", "reasoning", "thinking_config"} {
			if _, ok := m[k]; ok {
				delete(m, k)
				changed = true
			}
		}
	}
	if forceNonStream {
		if st, ok := m["stream"].(bool); ok && st {
			m["stream"] = false
			changed = true
		}
	}
	if !changed {
		return body, false
	}
	out, err := json.Marshal(m)
	if err != nil {
		return body, false
	}
	return out, true
}

// EndpointRequestSpec configures unified scheduling for specialized non-streaming
// endpoints (/v1/ocr, /v1/embeddings, /v1/rerank) so they share Scheduler's
// routing strategies, cooldowns, RPM/concurrency tracking, OAuth, and observability.
type EndpointRequestSpec struct {
	Endpoint         string
	Category         string // "ocr" | "embedding" | "reranker" | "chat"
	ReqModel         string
	TraceMode        string // "kb" | "agent"
	RawBody          []byte
	ForceStrategy    string // optional fallback strategy if route does not specify one (e.g. "round_robin")
	TimeoutSec       int    // optional per-request timeout (defaults to settings or 60s)
	BuildRequest     func(cand *CandidateKey) (targetURL string, body []byte, extraHeaders map[string]string, err error)
	TransformBody    func(cand *CandidateKey, respBody []byte) []byte
}

// ExecuteEndpoint executes an EndpointRequestSpec through the unified Scheduler:
// candidate ordering (round_robin/weighted/least_busy/fast/sticky_failover/manual),
// RPM & cooldown guards, forbiddenAlike detection, OAuth refresh, latency tracking,
// X-Routed-Via / X-Fallback-Attempts / X-Fallback-Trail headers, and trace recording.
func (s *Scheduler) ExecuteEndpoint(ctx context.Context, spec EndpointRequestSpec, w http.ResponseWriter, r *http.Request) error {
	reqStart := time.Now()
	hasObs := s.hasObs()
	var traceID string
	var reqHeaders map[string]string
	if hasObs {
		traceID = fmt.Sprintf("%s_%x", strings.TrimPrefix(spec.TraceMode, " "), reqStart.UnixNano())
		if spec.TraceMode == "" {
			spec.TraceMode = "agent"
		}
		if r != nil {
			reqHeaders = sanitizeHeaders(r.Header)
		}
	}

	budgetCtx, cancel := context.WithTimeout(ctx, HardBudgetTimeout)
	defer cancel()

	snap, err := s.configSource.Current(budgetCtx, false)
	if err != nil || snap == nil || snap.Config == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "configuration unavailable", "type": "service_unavailable"},
		})
		return err
	}

	route, exists := ResolveRoute(snap.Config, spec.Category, spec.ReqModel)
	if !exists || !route.Enabled {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": fmt.Sprintf("no enabled candidate configured for %s", spec.Category),
				"type":    "invalid_request_error",
			},
		})
		return ErrNoCandidateAvailable
	}

	fallbackStrat := spec.ForceStrategy
	if fallbackStrat == "" {
		fallbackStrat = snap.Config.Settings.AgentRoutingStrategy
	}
	if fallbackStrat == "" {
		fallbackStrat = "round_robin"
	}

	orderModelKey := spec.ReqModel
	if orderModelKey == "" {
		orderModelKey = spec.Category
	}
	candidates := s.OrderCandidatesForSession(route, snap.Config.Providers, orderModelKey, fallbackStrat, "")
	if len(candidates) == 0 {
		msg := fmt.Sprintf("no candidate keys available for %s", orderModelKey)
		if notes := DescribeRouteCandidates(route, snap.Config.Providers); len(notes) > 0 {
			msg += ": " + strings.Join(notes, "; ")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": msg, "type": "service_unavailable"},
		})
		return ErrNoCandidateAvailable
	}

	settings := snap.Config.Settings
	durRateLimit, durServerError, durNetwork, durAuth := resolveCooldownDurations(settings)
	timeoutSec := spec.TimeoutSec
	if timeoutSec <= 0 {
		timeoutSec = settings.AgentFirstByteTimeoutSec
	}
	if timeoutSec <= 0 {
		timeoutSec = 60
	}
	client := s.getClient(timeoutSec)

	var (
		tries          []types.Try
		attempts       []TryAttempt
		trailParts     []string
		skips          []string
		lastStatus     int
		lastErrSnippet string
		passthrough4xx *struct {
			status  int
			body    []byte
			headers http.Header
		}
	)

	for _, cand := range candidates {
		if budgetCtx.Err() != nil {
			break
		}
		keyID := cand.KeyEntry.ID
		if keyID == "" {
			keyID = cand.KeyEntry.Label
		}

		rpmLimit := cand.KeyEntry.MaxRPM
		if rpmLimit <= 0 && cand.Provider != nil {
			rpmLimit = cand.Provider.RPMPerKey
		}
		if rpmLimit > 0 && !s.rpmLimiter.TryAcquire(cand.KeyTag, rpmLimit) {
			skips = append(skips, fmt.Sprintf("%s (RPM limit)", keyID))
			continue
		}
		if s.cooldowns.IsCooledDown(cand.Provider.ID, cand.TargetModel, keyID) {
			skips = append(skips, fmt.Sprintf("%s (cooling down %s)", keyID, s.cooldowns.RemainingFor(cand.Provider.ID, cand.TargetModel, keyID)))
			continue
		}

		queuedStart := time.Now()
		cancelWait := s.lanes.StartWaiting(cand.KeyTag)
		tryStart := time.Now()

		if cand.KeyEntry.AuthType == "oauth_device" {
			if refresher := s.getOAuthRefresher(); refresher != nil {
				if refErr := refresher.EnsureValidToken(budgetCtx, cand.KeyEntry, ""); refErr != nil {
					cancelWait()
					lastStatus = http.StatusUnauthorized
					lastErrSnippet = refErr.Error()
					cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, http.StatusUnauthorized, durRateLimit, durServerError, durNetwork, durAuth)
					tries = append(tries, types.Try{
						Attempt:            len(tries) + 1,
						Provider:           cand.Provider.ID,
						KeyID:              cand.KeyEntry.Label,
						Model:              cand.TargetModel,
						Status:             http.StatusUnauthorized,
						Millis:             time.Since(tryStart).Milliseconds(),
						Reason:             "auth_error",
						CooldownAppliedSec: cooldownSec,
						ErrorSnippet:       obs.ScrubString(lastErrSnippet),
					})
					trailParts = append(trailParts, fmt.Sprintf("%s=401", cand.KeyTag))
					continue
				}
			}
		}

		var (
			targetURL    string
			reqBytes     []byte
			extraHeaders map[string]string
			buildErr     error
		)
		if spec.BuildRequest != nil {
			targetURL, reqBytes, extraHeaders, buildErr = spec.BuildRequest(cand)
		} else {
			reqBytes, extraHeaders, _, buildErr = s.engine.PrepareRequest(spec.Endpoint, spec.RawBody, cand.Provider, cand.TargetModel, false)
			targetURL = upstream.JoinUpstream(cand.Provider.BaseURL, strings.TrimPrefix(spec.Endpoint, "/v1/"))
		}
		if buildErr != nil {
			cancelWait()
			continue
		}

		upReq, reqErr := http.NewRequestWithContext(budgetCtx, http.MethodPost, targetURL, bytes.NewReader(reqBytes))
		if reqErr != nil {
			cancelWait()
			continue
		}
		applyUpstreamHeaders(upReq, r, cand.Provider, cand.KeyEntry.Key, extraHeaders)

		queuedMillis := time.Since(queuedStart).Milliseconds()
		cancelWait()
		releaseBusy := s.lanes.Acquire(cand.KeyTag, rpmLimit)
		var relOnce sync.Once
		rel := func() { relOnce.Do(releaseBusy) }

		sendStart := time.Now()
		resp, callErr := client.Do(upReq)
		sentMillis := time.Since(sendStart).Milliseconds()
		tryElapsed := time.Since(tryStart).Milliseconds()

		if callErr != nil {
			rel()
			lastStatus = http.StatusBadGateway
			lastErrSnippet = callErr.Error()
			cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, http.StatusBadGateway, durRateLimit, durServerError, durNetwork, durAuth)
			tries = append(tries, types.Try{
				Attempt:            len(tries) + 1,
				Provider:           cand.Provider.ID,
				KeyID:              cand.KeyEntry.Label,
				Model:              cand.TargetModel,
				Status:             http.StatusBadGateway,
				Millis:             tryElapsed,
				Reason:             "network_error",
				CooldownAppliedSec: cooldownSec,
				ErrorSnippet:       obs.ScrubString(lastErrSnippet),
			})
			trailParts = append(trailParts, fmt.Sprintf("%s=net_err", cand.KeyTag))
			continue
		}

		var tryRespHeaders map[string]string
		if hasObs {
			tryRespHeaders = sanitizeHeaders(resp.Header)
		}
		lastStatus = resp.StatusCode

		if resp.StatusCode != http.StatusOK {
			errBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			rel()
			lastErrSnippet = string(errBytes)

			cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, resp.StatusCode, durRateLimit, durServerError, durNetwork, durAuth)
			if cand.Provider.QuotaResetAt != "" && (resp.StatusCode == 429 || resp.StatusCode == 402) {
				if sec, _, qErr := s.cooldowns.ApplyQuotaCooldown(cand.Provider.ID, cand.TargetModel, keyID, cand.Provider.QuotaResetAt); qErr == nil {
					cooldownSec = sec
				}
			}

			reason := classifyFailureReason(resp.StatusCode)
			currAttempt := TryAttempt{
				Provider:     cand.Provider.ID,
				KeyID:        keyID,
				Model:        cand.TargetModel,
				Status:       resp.StatusCode,
				ErrorSnippet: lastErrSnippet,
			}
			tries = append(tries, types.Try{
				Attempt:            len(tries) + 1,
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
			trailParts = append(trailParts, fmt.Sprintf("%s=%d", cand.KeyTag, resp.StatusCode))

			if CheckForbiddenAlike(attempts, currAttempt, s.cooldowns) || (len(candidates) == 1 && resp.StatusCode == http.StatusBadRequest) {
				passthrough4xx = &struct {
					status  int
					body    []byte
					headers http.Header
				}{status: resp.StatusCode, body: errBytes, headers: resp.Header}
				break
			}
			attempts = append(attempts, currAttempt)
			continue
		}

		respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
		_ = resp.Body.Close()
		rel()
		if readErr != nil {
			lastStatus = http.StatusBadGateway
			lastErrSnippet = readErr.Error()
			trailParts = append(trailParts, fmt.Sprintf("%s=read_err", cand.KeyTag))
			continue
		}

		// Success! Record latency for "fast" strategy and transform response
		s.latency.Record(cand.KeyTag, tryElapsed)
		if spec.TransformBody != nil {
			respBody = spec.TransformBody(cand, respBody)
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Routed-Via", cand.Provider.ID)
		w.Header().Set("X-Fallback-Attempts", strconv.Itoa(len(tries)+1))
		w.Header().Set("X-Fallback-Trail", strings.Join(append(trailParts, fmt.Sprintf("%s=200", cand.KeyTag)), ";"))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(respBody)

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
				Attempt:     len(tries) + 1,
				Provider:    cand.Provider.ID,
				KeyID:       cand.KeyEntry.Label,
				Model:       cand.TargetModel,
				Status:      http.StatusOK,
				Millis:      tryElapsed,
				TTFTMillis:  tryElapsed,
				RespHeaders: tryRespHeaders,
			})

			s.recordFinalTrace(types.RequestTrace{
				ID:                 traceID,
				Timestamp:          time.Now().Unix(),
				Mode:               spec.TraceMode,
				Endpoint:           spec.Endpoint,
				ReqModel:           orderModelKey,
				ServedModel:        cand.TargetModel,
				WinnerProvider:     cand.Provider.ID,
				WinnerKey:          cand.KeyEntry.Label,
				Status:             http.StatusOK,
				Stream:             false,
				InTokens:           usageTracker.InTokens,
				OutTokens:          usageTracker.OutTokens,
				CacheReadTokens:    usageTracker.CacheReadTokens,
				CacheWriteTokens:   usageTracker.CacheWriteTokens,
				CacheWrite1hTokens: usageTracker.CacheWrite1hTokens,
				ReasoningTokens:    usageTracker.ReasoningTokens,
				StopReason:         usageTracker.StopReason,
				TTFTMillis:         tryElapsed,
				OwnMillis:          ownMillis,
				QueuedMillis:       queuedMillis,
				SentMillis:         sentMillis,
				TotalMillis:        totalMillis,
				UpBytes:            len(reqBytes),
				DownBytes:          len(respBody),
				ReqHeaders:         reqHeaders,
				Tries:              tries,
			})
		}
		return nil
	}

	if passthrough4xx != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(passthrough4xx.status)
		_, _ = w.Write(passthrough4xx.body)
		s.recordFinalTrace(types.RequestTrace{
			ID:          traceID,
			Timestamp:   time.Now().Unix(),
			Mode:        spec.TraceMode,
			Endpoint:    spec.Endpoint,
			ReqModel:    orderModelKey,
			Status:      passthrough4xx.status,
			TotalMillis: time.Since(reqStart).Milliseconds(),
			ReqHeaders:  reqHeaders,
			Tries:       tries,
		})
		return nil
	}

	status := lastStatus
	if status == 0 {
		status = http.StatusBadGateway
	}
	reason := lastErrSnippet
	if reason == "" && len(skips) > 0 {
		reason = "skipped: " + strings.Join(skips, "; ")
	}

	w.Header().Set("Content-Type", "application/json")
	if len(trailParts) > 0 {
		w.Header().Set("X-Fallback-Trail", strings.Join(trailParts, ";"))
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
		Mode:        spec.TraceMode,
		Endpoint:    spec.Endpoint,
		ReqModel:    orderModelKey,
		Status:      status,
		TotalMillis: time.Since(reqStart).Milliseconds(),
		ReqHeaders:  reqHeaders,
		Tries:       tries,
	})
	return ErrAllRetriesExhausted
}

func resolveCooldownDurations(settings types.RuntimeSettings) (durRateLimit, durServerError, durNetwork, durAuth time.Duration) {
	durRateLimit = time.Duration(settings.CooldownRateLimitSec) * time.Second
	if durRateLimit == 0 {
		durRateLimit = 15 * time.Second
	}
	durServerError = time.Duration(settings.CooldownServerErrorSec) * time.Second
	if durServerError == 0 {
		durServerError = 30 * time.Second
	}
	durNetwork = time.Duration(settings.CooldownNetworkErrorSec) * time.Second
	if durNetwork == 0 {
		durNetwork = 15 * time.Second
	}
	durAuth = time.Duration(settings.CooldownAuthErrorSec) * time.Second
	if durAuth < 0 {
		durAuth = 0
	}
	return
}

func classifyFailureReason(status int) string {
	switch {
	case status == http.StatusTooManyRequests:
		return "rate_limit"
	case status == http.StatusUnauthorized || status == http.StatusPaymentRequired || status == http.StatusForbidden:
		return "auth_error"
	case status >= 400 && status < 500:
		return "client_error"
	default:
		return "server_error"
	}
}

// proxyDefaultUA replaces the inbound client's User-Agent when HideClientName is enabled
// (or when the caller sent no User-Agent), matching Magpie's userAgentFor logic.
const proxyDefaultUA = "llmproxy/2"

func resolveUpstreamUserAgent(inboundReq *http.Request, prov *types.ProviderConfig) string {
	if prov != nil && prov.HideClientName {
		return proxyDefaultUA
	}
	if inboundReq != nil {
		if ua := strings.TrimSpace(inboundReq.Header.Get("User-Agent")); ua != "" {
			return ua
		}
	}
	return proxyDefaultUA
}

func applyUpstreamHeaders(upReq *http.Request, inboundReq *http.Request, prov *types.ProviderConfig, rawKey string, extraHeaders map[string]string) {
	authHeader := "Authorization"
	authPrefix := "Bearer "
	if prov != nil && prov.AdapterRules != nil {
		if prov.AdapterRules.AuthHeader != "" {
			authHeader = prov.AdapterRules.AuthHeader
		}
		if prov.AdapterRules.AuthPrefix != "" {
			authPrefix = prov.AdapterRules.AuthPrefix
		}
	}
	upReq.Header.Set(authHeader, authPrefix+rawKey)
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("User-Agent", resolveUpstreamUserAgent(inboundReq, prov))
	for hk, hv := range extraHeaders {
		upReq.Header.Set(hk, hv)
	}
}

// Engine returns the scheduler's AdapterEngine.
func (s *Scheduler) Engine() types.AdapterEngine {
	return s.engine
}

// ConfigSource returns the scheduler's ConfigSource.
func (s *Scheduler) ConfigSource() types.ConfigSource {
	return s.configSource
}

// OverrideClientForTest overrides cached httpClient for unit testing.
func (s *Scheduler) OverrideClientForTest(client *http.Client) {
	if client == nil {
		return
	}
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	s.httpClient = client
	for k := range s.clients {
		s.clients[k] = client
	}
	s.clients[60] = client
	s.clients[120] = client
}

// SetEngineForTest overrides the adapter engine (or exposes adapters engine).
func (s *Scheduler) SetEngineForTest(engine types.AdapterEngine) {
	if engine != nil {
		s.engine = engine
	} else {
		s.engine = adapters.NewDefaultEngine()
	}
}

// SetObservabilitySink sets obsSink safely.
func (s *Scheduler) SetObservabilitySink(sink types.ObservabilitySink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.obsSink = sink
}

// SetHTTPClientOverrides sets a shared client used across timeouts (e.g. kb.Pipeline.SetHTTPClient).
func (s *Scheduler) SetHTTPClient(client *http.Client) {
	s.OverrideClientForTest(client)
}

// Latency returns the EWMA LatencyTracker.
func (s *Scheduler) Latency() *LatencyTracker {
	return s.latency
}
