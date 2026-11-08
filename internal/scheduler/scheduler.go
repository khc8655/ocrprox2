package scheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/adapters"
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
	mu             sync.Mutex
	configSource   types.ConfigSource
	engine         types.AdapterEngine
	cooldowns      *CooldownManager
	obsSink        types.ObservabilitySink
	httpClient     *http.Client
	rrIndex        map[string]int
	oauthRefresher OAuthRefresher
}

// NewScheduler creates a Scheduler.
func NewScheduler(
	cfgSrc types.ConfigSource,
	obsSink types.ObservabilitySink,
	allowPrivate bool,
) *Scheduler {
	return &Scheduler{
		configSource: cfgSrc,
		engine:       adapters.NewDefaultEngine(),
		cooldowns:    NewCooldownManager(),
		obsSink:      obsSink,
		httpClient:   upstream.DefaultClient(120*time.Second, allowPrivate),
		rrIndex:      make(map[string]int),
	}
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

// CandidateKey represents an actionable route key target.
type CandidateKey struct {
	Provider    *types.ProviderConfig
	KeyEntry    *types.KeyEntry
	TargetModel string
	KeyTag      string // e.g. "minimax:hk-01"
}

// OrderCandidates sorts candidate keys according to route strategy.
func (s *Scheduler) OrderCandidates(
	route *types.AgentModelRoute,
	providers map[string]*types.ProviderConfig,
	reqModel string,
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
				targetModel = reqModel
			}

			candidates = append(candidates, &CandidateKey{
				Provider:    p,
				KeyEntry:    k,
				TargetModel: targetModel,
				KeyTag:      cand.Provider + ":" + k.Label,
			})
		}
	}

	strategy := route.RoutingStrategy
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
		s.mu.Lock()
		idx := s.rrIndex[reqModel]
		s.rrIndex[reqModel] = (idx + 1) % len(candidates)
		s.mu.Unlock()

		n := len(candidates)
		reordered := make([]*CandidateKey, n)
		for i := 0; i < n; i++ {
			reordered[i] = candidates[(idx+i)%n]
		}
		return reordered

	case "sticky_failover":
		fallthrough
	default:
		// Place active key first if available
		if route.ActiveKey != "" {
			var active *CandidateKey
			var others []*CandidateKey
			for _, c := range candidates {
				if c.KeyTag == route.ActiveKey && active == nil {
					active = c
				} else {
					others = append(others, c)
				}
			}
			if active != nil {
				return append([]*CandidateKey{active}, others...)
			}
		}
		return candidates
	}
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
	traceID := fmt.Sprintf("req-%d", reqStart.UnixNano())

	// Hard total budget: 300s
	budgetCtx, cancel := context.WithTimeout(ctx, HardBudgetTimeout)
	defer cancel()

	snap, err := s.configSource.Current(budgetCtx, false)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": err.Error(),
				"type":    "service_unavailable",
			},
		})
		return err
	}

	route, exists := snap.Config.AgentModels[reqModel]
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

	candidates := s.OrderCandidates(route, snap.Config.Providers, reqModel)
	if len(candidates) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "no candidate keys available for model",
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
	if durAuth == 0 {
		durAuth = 86400 * time.Second
	}

	var tries []types.Try
	var attempts []TryAttempt
	var lastStatus int
	var lastErrSnippet string

	for i, cand := range candidates {
		// Check budget
		if budgetCtx.Err() != nil {
			break
		}

		keyID := cand.KeyEntry.ID
		if keyID == "" {
			keyID = cand.KeyEntry.Label
		}

		// Check cooldown
		if s.cooldowns.IsCooledDown(cand.Provider.ID, cand.TargetModel, keyID) {
			continue
		}

		tryStart := time.Now()

		// Dynamic OAuth token refresh if needed
		if cand.KeyEntry.AuthType == "oauth_device" {
			refresher := s.getOAuthRefresher()
			if refresher != nil {
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
					continue
				}
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
			continue
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
			continue
		}

		// Set auth header
		authHeader := "Authorization"
		authPrefix := "Bearer "
		if cand.Provider.AdapterRules != nil {
			if cand.Provider.AdapterRules.AuthHeader != "" {
				authHeader = cand.Provider.AdapterRules.AuthHeader
			}
			if cand.Provider.AdapterRules.AuthPrefix != "" {
				authPrefix = cand.Provider.AdapterRules.AuthPrefix
			}
		}
		upReq.Header.Set(authHeader, authPrefix+cand.KeyEntry.Key)
		upReq.Header.Set("Content-Type", "application/json")

		for hk, hv := range extraHeaders {
			upReq.Header.Set(hk, hv)
		}

		// Execute HTTP call
		resp, callErr := s.httpClient.Do(upReq)
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
			continue
		}

		lastStatus = resp.StatusCode

		if resp.StatusCode != http.StatusOK {
			errBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			lastErrSnippet = string(errBytes)

			cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, resp.StatusCode, durRateLimit, durServerError, durNetwork, durAuth)

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
			})

			// Check Magpie forbiddenAlike
			if CheckForbiddenAlike(attempts, currAttempt, s.cooldowns) {
				// Immediate abort: it's a client error, don't burn other keys!
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(resp.StatusCode)
				_, _ = w.Write(errBytes)
				s.recordFinalTrace(traceID, reqModel, cand, tries, resp.StatusCode, tryElapsed, clientStream)
				return nil
			}

			attempts = append(attempts, currAttempt)
			continue
		}

		// Upstream returned 200 OK!
		// Case A: Streaming request
		if clientStream || upstreamStream {
			peekRes, peekErr := PeekUntilPayload(resp.Body, KeepaliveInterval, func() {
				// Pre-commit keepalive
				if f, ok := w.(http.Flusher); ok {
					_, _ = w.Write([]byte(": keep-alive\n\n"))
					f.Flush()
				}
			})

			if peekErr != nil || peekRes.IsError {
				resp.Body.Close()
				lastErrSnippet = peekRes.ErrorSnippet
				cooldownSec, _ := s.cooldowns.ApplyCooldown(cand.Provider.ID, cand.TargetModel, keyID, 502, durRateLimit, durServerError, durNetwork, durAuth)
				tries = append(tries, types.Try{
					Attempt:            i + 1,
					Provider:           cand.Provider.ID,
					KeyID:              cand.KeyEntry.Label,
					Model:              cand.TargetModel,
					Status:             502,
					Millis:             tryElapsed,
					Reason:             "stream_peek_error",
					CooldownAppliedSec: cooldownSec,
					ErrorSnippet:       obs.ScrubString(lastErrSnippet),
				})
				continue
			}

			// Stream peek succeeded!
			if !clientStream && cand.Provider.AdapterRules != nil && cand.Provider.AdapterRules.StreamOnly {
				// Client asked for non-stream, but provider was stream_only: aggregate to JSON!
				aggBytes, aggErr := adapters.AggregateStreamToJSON(peekRes.CombinedBody)
				resp.Body.Close()
				if aggErr != nil {
					continue
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(aggBytes)
				s.updateStickyKey(route, cand)
				tries = append(tries, types.Try{
					Attempt:  i + 1,
					Provider: cand.Provider.ID,
					KeyID:    cand.KeyEntry.Label,
					Model:    cand.TargetModel,
					Status:   200,
					Millis:   tryElapsed,
				})
				s.recordFinalTrace(traceID, reqModel, cand, tries, 200, tryElapsed, clientStream)
				return nil
			}

			// Client wants stream
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(http.StatusOK)

			flusher, hasFlusher := w.(http.Flusher)
			if hasFlusher {
				flusher.Flush()
			}

			// Pipe stream
			buf := make([]byte, 32*1024)
			for {
				n, readErr := peekRes.CombinedBody.Read(buf)
				if n > 0 {
					_, _ = w.Write(buf[:n])
					if hasFlusher {
						flusher.Flush()
					}
				}
				if readErr != nil {
					break
				}
			}
			resp.Body.Close()

			s.updateStickyKey(route, cand)
			tries = append(tries, types.Try{
				Attempt:  i + 1,
				Provider: cand.Provider.ID,
				KeyID:    cand.KeyEntry.Label,
				Model:    cand.TargetModel,
				Status:   200,
				Millis:   tryElapsed,
			})
			s.recordFinalTrace(traceID, reqModel, cand, tries, 200, tryElapsed, clientStream)
			return nil
		}

		// Case B: Non-streaming request
		respBody, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			continue
		}

		transformed, transErr := s.engine.TransformNonStreamResponse(endpoint, respBody, cand.Provider, reqModel)
		if transErr == nil {
			respBody = transformed
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(respBody)

		s.updateStickyKey(route, cand)
		tries = append(tries, types.Try{
			Attempt:  i + 1,
			Provider: cand.Provider.ID,
			KeyID:    cand.KeyEntry.Label,
			Model:    cand.TargetModel,
			Status:   200,
			Millis:   tryElapsed,
		})
		s.recordFinalTrace(traceID, reqModel, cand, tries, 200, tryElapsed, clientStream)
		return nil
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
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": fmt.Sprintf("all candidate keys failed: %s", lastErrSnippet),
			"type":    "upstream_error",
		},
	})
	return ErrAllRetriesExhausted
}

func (s *Scheduler) updateStickyKey(route *types.AgentModelRoute, cand *CandidateKey) {
	if route != nil && (route.RoutingStrategy == "sticky_failover" || route.RoutingStrategy == "") {
		route.ActiveKey = cand.KeyTag
	}
}

func (s *Scheduler) recordFinalTrace(
	traceID string,
	reqModel string,
	cand *CandidateKey,
	tries []types.Try,
	status int,
	elapsed int64,
	stream bool,
) {
	if s.obsSink == nil {
		return
	}
	served := ""
	winnerProv := ""
	winnerKey := ""
	if cand != nil {
		served = cand.TargetModel
		winnerProv = cand.Provider.ID
		winnerKey = cand.KeyEntry.Label
	}

	s.obsSink.RecordRequest(types.RequestTrace{
		ID:             traceID,
		Timestamp:      time.Now().Unix(),
		Mode:           "agent",
		Endpoint:       "/v1/chat/completions",
		ReqModel:       reqModel,
		ServedModel:    served,
		WinnerProvider: winnerProv,
		WinnerKey:      winnerKey,
		Status:         status,
		Stream:         stream,
		TotalMillis:    elapsed,
		Tries:          tries,
	})
}
