package admin

// POST /api/admin/test-key — the console's per-key "does this key actually
// answer" check. It sends one minimal real inference ("你好", max_tokens 16,
// stream false) through the stored key and the provider's real endpoint, then
// reports the verdict plus the reply text. This replaces the model-row test
// route (which only proved a candidate could answer, not which key was billed)
// and supersedes using GET /v1/models for per-key health: a subscription key can
// list models and still have no inference quota.
//
// Independent implementation; the magpie test probe shape
// (internal/provider/test.go:381-385 in the upstream repo) informed the request
// body only. No gateway/fallback/routing code is ported (CLAUDE.md red lines).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/provider"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

const (
	// testKeyTimeout is the whole-probe budget: dial + TLS + response body.
	testKeyTimeout = 20 * time.Second
	// testKeyMaxReplyRunes caps reply_text: enough to show the model really
	// answered, small enough for a table cell and a config blob.
	testKeyMaxReplyRunes = 200
	testKeyUserContent   = "你好"
	testKeyMaxTokens     = 16
	testKeyEndpoint      = "/admin/test-key"
	// testKeyBodyLimit caps how much upstream body we buffer for parsing /
	// error extraction. A chat completion for 16 tokens is far below this.
	testKeyBodyLimit = 1 << 20
)

// testKeyResponse is the documented response shape. Every field is always
// present (empty strings included) so the console can render a verdict without
// branching on key existence. The secret is never part of it.
type testKeyResponse struct {
	OK          bool   `json:"ok"`
	Valid       bool   `json:"valid"`
	Status      int    `json:"status"`
	LatencyMS   int64  `json:"latency_ms"`
	Provider    string `json:"provider"`
	KeyID       string `json:"key_id"`
	KeyLabel    string `json:"key_label"`
	Model       string `json:"model"`
	ModelSource string `json:"model_source"`
	APIType     string `json:"api_type"`
	ReplyText   string `json:"reply_text"`
	Reason      string `json:"reason"`
	ErrType     string `json:"err_type"`
	Error       string `json:"error"`
	RequestID   string `json:"rid"`
}

// probeClient returns the HTTP client for console probes. An explicitly
// injected client (SetHTTPClient, used by tests) wins; otherwise the probe gets
// its own client whose timeout is the probe budget — the shared admin client is
// built with 15s and would otherwise cut the documented 20s short.
func (s *Server) probeClient(timeout time.Duration) *http.Client {
	if s.httpClientInjected && s.httpClient != nil {
		return s.httpClient
	}
	return upstream.DefaultClient(timeout, s.allowPrivate)
}

func (s *Server) handleTestKey(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		Provider string `json:"provider"`
		KeyID    string `json:"key_id"`
		KeyLabel string `json:"key_label"`
		Model    string `json:"model"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"valid": false,
			"error": "invalid_json_body",
		})
		return
	}

	providerName := strings.TrimSpace(req.Provider)
	if providerName == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"valid": false,
			"error": "missing_provider",
		})
		return
	}

	resp := testKeyResponse{
		Provider: providerName,
		Model:    strings.TrimSpace(req.Model),
	}

	if s.localSrc == nil {
		s.finishTestKey(w, resp, 0, http.StatusServiceUnavailable, "", "config_unavailable")
		return
	}
	snap, err := s.localSrc.Current(r.Context(), false)
	if err != nil || snap == nil || snap.Config == nil {
		s.finishTestKey(w, resp, 0, http.StatusServiceUnavailable, "", "config_unavailable")
		return
	}

	prov, exists := snap.Config.Providers[providerName]
	if !exists || prov == nil {
		s.finishTestKey(w, resp, 0, http.StatusBadRequest, "", fmt.Sprintf("provider '%s' not found", providerName))
		return
	}

	key, keyLabel, keyErr := selectTestKey(prov, strings.TrimSpace(req.KeyID), strings.TrimSpace(req.KeyLabel))
	if key == nil {
		s.finishTestKey(w, resp, 0, http.StatusBadRequest, "", keyErr)
		return
	}
	resp.KeyID = key.ID
	resp.KeyLabel = keyLabel

	baseURL, headers, isAnthropic := resolveProbeTargetAndHeaders("", "", key.Key, prov)
	if strings.TrimSpace(baseURL) == "" {
		s.finishTestKey(w, resp, 0, http.StatusBadRequest, "", "provider base_url is empty")
		return
	}
	apiType := "openai-completions"
	if isAnthropic {
		apiType = "anthropic-messages"
	}
	resp.APIType = apiType

	model, modelSource := resolveTestModel(snap.Config, providerName, prov, resp.Model, apiType)
	resp.Model = model
	resp.ModelSource = modelSource
	if model == "" {
		// Nothing to send the probe to. Fail fast with an actionable message
		// instead of guessing a model the vendor will reject.
		resp.Reason = "model_unspecified"
		resp.Error = "provider has no route and no preset model: pass a model to test this key"
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
		return
	}

	var targetURL string
	if isAnthropic {
		targetURL = upstream.JoinUpstream(baseURL, "messages")
	} else {
		targetURL = upstream.JoinUpstream(baseURL, "chat/completions")
	}

	payload, _ := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]any{
			{"role": "user", "content": testKeyUserContent},
		},
		"max_tokens": testKeyMaxTokens,
		"stream":     false,
	})

	ctx, cancel := context.WithTimeout(r.Context(), testKeyTimeout)
	defer cancel()

	upReq, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(payload))
	if reqErr != nil {
		s.finishTestKey(w, resp, 0, http.StatusInternalServerError, "", reqErr.Error())
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	for hk, hv := range headers {
		upReq.Header.Set(hk, hv)
	}

	client := s.probeClient(testKeyTimeout)
	start := time.Now()
	upResp, doErr := client.Do(upReq)
	latency := time.Since(start).Milliseconds()
	resp.LatencyMS = latency

	if doErr != nil {
		// Transport failure: no HTTP status exists. The kind decides between
		// timeout / network / client_disconnected exactly like the dispatcher.
		kind := probeFailureKind(doErr, ctx, r.Context())
		reason, errType := scheduler.ClassifyFailure(0, []byte(doErr.Error()), kind)
		errText := scrubTestKeyText(doErr.Error(), key.Key)
		resp.Reason = reason
		resp.ErrType = errType
		resp.Error = errText
		s.recordTestKeyTrace(resp, testKeyTry(resp, 0, latency, reason, errType, errText, ""))
		s.writeTestKeyResult(w, http.StatusOK, resp)
		return
	}
	defer upResp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(upResp.Body, testKeyBodyLimit))
	resp.Status = upResp.StatusCode
	resp.RequestID = scheduler.ExtractRequestID(upResp.Header)

	if upResp.StatusCode >= 200 && upResp.StatusCode < 300 {
		resp.Valid = true
		resp.ReplyText = truncateRunes(extractReplyText(bodyBytes, isAnthropic), testKeyMaxReplyRunes)
		s.recordTestKeyTrace(resp, testKeyTry(resp, upResp.StatusCode, latency, "", "", "", resp.RequestID))
		s.persistKeyTest(resp)
		s.writeTestKeyResult(w, http.StatusOK, resp)
		return
	}

	reason, errType := scheduler.ClassifyFailure(upResp.StatusCode, bodyBytes, scheduler.FailureKindHTTP)
	errText := scrubTestKeyText(string(bodyBytes), key.Key)
	if errText == "" {
		errText = fmt.Sprintf("upstream returned %d", upResp.StatusCode)
	}
	resp.Reason = reason
	resp.ErrType = errType
	resp.Error = errText
	s.recordTestKeyTrace(resp, testKeyTry(resp, upResp.StatusCode, latency, reason, errType, errText, resp.RequestID))
	s.persistKeyTest(resp)
	s.writeTestKeyResult(w, http.StatusOK, resp)
}

// selectTestKey resolves the key the operator pointed at. key_id wins, then
// key_label (front ends send both for older configs without stable ids); with
// neither, the first enabled key with a usable secret. Explicitly targeted
// keys are allowed even when disabled — testing a disabled key is exactly how
// an operator decides whether to re-enable it.
func selectTestKey(prov *types.ProviderConfig, keyID, keyLabel string) (*types.KeyEntry, string, string) {
	if prov == nil {
		return nil, "", "provider_not_found"
	}
	if len(prov.APIKeys) == 0 {
		return nil, "", "no_key_configured"
	}

	find := func(needle string) *types.KeyEntry {
		if needle == "" {
			return nil
		}
		for _, k := range prov.APIKeys {
			if k != nil && k.ID != "" && k.ID == needle {
				return k
			}
		}
		for _, k := range prov.APIKeys {
			if k != nil && k.Label != "" && k.Label == needle {
				return k
			}
		}
		return nil
	}
	usable := func(k *types.KeyEntry) bool {
		return k != nil && k.Key != "" && !config.IsMaskedSecret(k.Key)
	}
	labelOf := func(k *types.KeyEntry) string {
		if k.Label != "" {
			return k.Label
		}
		return k.ID
	}

	if keyID != "" || keyLabel != "" {
		k := find(keyID)
		if k == nil {
			k = find(keyLabel)
		}
		if k == nil {
			return nil, "", "key_not_found"
		}
		if !usable(k) {
			return nil, "", "key_secret_unavailable"
		}
		return k, labelOf(k), ""
	}

	for _, k := range prov.APIKeys {
		if usable(k) && k.Enabled {
			return k, labelOf(k), ""
		}
	}
	return nil, "", "no_enabled_key"
}

// resolveTestModel walks the documented fallback chain:
//
//	request (explicit body field) -> route (first agent_models route that names
//	this provider, its target_model) -> preset (preset's first recommended
//	model) -> fallback (a common model for the protocol).
//
// Route lookup is deterministic: route names sorted, candidates in their
// configured order, enabled candidates preferred over disabled ones.
func resolveTestModel(cfg *types.ProxyConfig, providerName string, prov *types.ProviderConfig, requested, apiType string) (string, string) {
	if requested != "" {
		return requested, "request"
	}

	if cfg != nil && len(cfg.AgentModels) > 0 {
		names := make([]string, 0, len(cfg.AgentModels))
		for name := range cfg.AgentModels {
			names = append(names, name)
		}
		sort.Strings(names)

		routeModel := func(requireEnabled bool) string {
			for _, name := range names {
				route := cfg.AgentModels[name]
				if route == nil {
					continue
				}
				for _, c := range route.Candidates {
					if c == nil || c.Provider != providerName {
						continue
					}
					if requireEnabled && !c.Enabled {
						continue
					}
					if m := strings.TrimSpace(c.TargetModel); m != "" {
						return m
					}
				}
			}
			return ""
		}
		if m := routeModel(true); m != "" {
			return m, "route"
		}
		if m := routeModel(false); m != "" {
			return m, "route"
		}
	}

	presetID := strings.TrimSpace(prov.PresetID)
	if presetID == "" {
		presetID = providerName
	}
	if preset := provider.FindPreset(presetID); preset != nil {
		for _, m := range preset.Models {
			if strings.TrimSpace(m) != "" {
				return strings.TrimSpace(m), "preset"
			}
		}
	}

	// No blind guess. A made-up model name ("gpt-4o-mini") is rejected by most
	// relay vendors, and the console then reports a perfectly good key as
	// "失败 · 404 model_not_found" — observed 2026-11-27 on amd / Nvidia /
	// minimax / sensenova. Saying "pick a model first" is the honest answer.
	return "", "missing"
}

// probeFailureKind buckets a client.Do error into the scheduler failure kinds.
func probeFailureKind(err error, probeCtx, clientCtx context.Context) string {
	if errors.Is(err, context.Canceled) ||
		(clientCtx != nil && errors.Is(clientCtx.Err(), context.Canceled)) {
		return scheduler.FailureKindClientAbort
	}
	if errors.Is(err, context.DeadlineExceeded) ||
		(probeCtx != nil && errors.Is(probeCtx.Err(), context.DeadlineExceeded)) {
		return scheduler.FailureKindTimeout
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return scheduler.FailureKindTimeout
	}
	return scheduler.FailureKindNetwork
}

// scrubTestKeyText compresses an upstream body / error string to one short line
// and passes the mandatory secret scrub. Every error string that leaves this
// handler goes through here (or through the response builder), so the key can
// never ride out in a log line or a JSON field.
func scrubTestKeyText(raw, secret string) string {
	return obs.ScrubStringWithSecrets(
		scheduler.CompressError([]byte(raw), 0),
		secret,
	)
}

// extractReplyText pulls the plain text answer out of a 200 body.
// OpenAI: choices[0].message.content (string, or an array of text parts).
// Anthropic: content[] entries whose type is "text", concatenated.
// Unrecognized shapes return "" — a 200 is still a valid key.
func extractReplyText(body []byte, anthropic bool) string {
	if len(bytes.TrimSpace(body)) == 0 {
		return ""
	}
	var root struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(body, &root) != nil {
		return ""
	}

	if anthropic {
		var sb strings.Builder
		for _, c := range root.Content {
			if c.Type == "" || c.Type == "text" {
				sb.WriteString(c.Text)
			}
		}
		return strings.TrimSpace(sb.String())
	}

	if len(root.Choices) == 0 {
		return ""
	}
	raw := root.Choices[0].Message.Content
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var sb strings.Builder
		for _, p := range parts {
			if p.Type == "" || p.Type == "text" {
				sb.WriteString(p.Text)
			}
		}
		return strings.TrimSpace(sb.String())
	}
	return ""
}

func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) > max {
		return string(runes[:max])
	}
	return s
}

func testKeyTry(resp testKeyResponse, status int, latency int64, reason, errType, errText, rid string) types.Try {
	return types.Try{
		Attempt:    1,
		Provider:   resp.Provider,
		KeyID:      resp.KeyLabel,
		Model:      resp.Model,
		Status:     status,
		Millis:     latency,
		TTFTMillis: latency,
		Reason:     reason,
		ErrType:    errType,
		Error:      errText,
		RequestID:  rid,
	}
}

// persistKeyTest writes the fresh verdict into the on-disk config immediately, so
// the key-row pill survives a page refresh or a restart without the operator
// having to save the provider first. Only the last_test field is carried, so the
// stored secret and every other attribute stay untouched; PersistKeyEntry saves
// through the vault-bypass path (fromVaultSync) because this is console metadata,
// not a credential change.
func (s *Server) persistKeyTest(resp testKeyResponse) {
	if s.localSrc == nil || (resp.KeyID == "" && resp.KeyLabel == "") {
		return
	}
	lt := &types.KeyLastTest{
		OK:        resp.Valid,
		Status:    resp.Status,
		LatencyMS: resp.LatencyMS,
		Reason:    resp.Reason,
		ErrType:   resp.ErrType,
		Error:     resp.Error,
		ReplyText: resp.ReplyText,
		At:        time.Now().UTC().Format(time.RFC3339),
	}
	if err := s.localSrc.PersistKeyTestState(resp.Provider, resp.KeyID, resp.KeyLabel, lt); err != nil {
		// A failed write must not fail the test itself: the probe answer is still
		// the operator's answer, and the next provider save will carry the pill.
		log.Printf("test-key: persist last_test for %s/%s failed: %v", resp.Provider, resp.KeyLabel, err)
	}
}

// recordTestKeyTrace writes exactly one probe trace so the console's request
// history shows what the operator tested and how it went. obs.RecordRequest
// records the trace but skips the usage ledger for Source=="probe" (a test is
// not client traffic and must not show up in usage/token accounting).
func (s *Server) recordTestKeyTrace(resp testKeyResponse, try types.Try) {
	if s.obsSink == nil {
		return
	}
	tries := []types.Try{try}
	s.obsSink.RecordRequest(types.RequestTrace{
		ID:             fmt.Sprintf("probe-%d", time.Now().UnixNano()),
		Timestamp:      time.Now().Unix(),
		Source:         "probe",
		Mode:           "agent",
		Endpoint:       testKeyEndpoint,
		ReqModel:       resp.Model,
		ServedModel:    resp.Model,
		WinnerProvider: resp.Provider,
		WinnerKey:      resp.KeyLabel,
		Status:         resp.Status,
		TotalMillis:    resp.LatencyMS,
		TTFTMillis:     resp.LatencyMS,
		Tries:          tries,
	})
}

// finishTestKey reports a preflight failure (config/provider/key/model problem)
// before any upstream attempt: HTTP status is the operator error, trace status
// mirrors it, reason stays empty (contract §6: local early exits have no
// upstream reason). The error text is scrubbed like every other error.
func (s *Server) finishTestKey(w http.ResponseWriter, resp testKeyResponse, latency int64, status int, rid, msg string) {
	resp.LatencyMS = latency
	resp.Error = scrubTestKeyText(msg, "")
	resp.RequestID = rid
	resp.Status = status
	s.recordTestKeyTraceNoTry(resp)
	s.writeTestKeyResult(w, status, resp)
}

func (s *Server) recordTestKeyTraceNoTry(resp testKeyResponse) {
	if s.obsSink == nil {
		return
	}
	s.obsSink.RecordRequest(types.RequestTrace{
		ID:             fmt.Sprintf("probe-%d", time.Now().UnixNano()),
		Timestamp:      time.Now().Unix(),
		Source:         "probe",
		Mode:           "agent",
		Endpoint:       testKeyEndpoint,
		ReqModel:       resp.Model,
		ServedModel:    resp.Model,
		WinnerProvider: resp.Provider,
		WinnerKey:      resp.KeyLabel,
		Status:         resp.Status,
		TotalMillis:    resp.LatencyMS,
	})
}

func (s *Server) writeTestKeyResult(w http.ResponseWriter, httpStatus int, resp testKeyResponse) {
	resp.OK = httpStatus == http.StatusOK
	w.WriteHeader(httpStatus)
	_ = json.NewEncoder(w).Encode(resp)
}
