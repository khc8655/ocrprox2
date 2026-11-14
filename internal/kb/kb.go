// Package kb provides KB (Knowledge Base) pipeline processing:
// pre-read concurrency semaphore for OCR, 20MB body buffering, failover routing,
// Vision ChatCompletion transformation, MIME magic bytes detection, and embedding/rerank/chat dispatch.
package kb

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

const (
	MaxBodyBytes     = 20 << 20 // 20 MiB
	DefaultMaxOCR    = 4
	DefaultMaxGlobal = 16
)

var (
	ErrOCRLimitExceeded = errors.New("kb: ocr concurrency limit exceeded (429)")
	ErrBodyTooLarge     = errors.New("kb: request body exceeds 20MB limit")
	ErrNoCandidate      = errors.New("kb: no enabled candidate found for kb category")
)

// Pipeline manages KB mode traffic and resource semaphores.
type Pipeline struct {
	mu            sync.Mutex
	configSrc     types.ConfigSource
	ocrSem        chan struct{}
	globalSem     chan struct{}
	httpClient    *http.Client
	ocrMaxLimit   int
	obsSink       types.ObservabilitySink
	adapterEngine types.AdapterEngine
}

// NewPipeline creates a new KB Pipeline.
func NewPipeline(cfgSrc types.ConfigSource, maxOCR, maxGlobal int, allowPrivate bool) *Pipeline {
	if maxOCR <= 0 {
		maxOCR = DefaultMaxOCR
	}
	if maxGlobal <= 0 {
		maxGlobal = DefaultMaxGlobal
	}

	return &Pipeline{
		configSrc:   cfgSrc,
		ocrSem:      make(chan struct{}, maxOCR),
		globalSem:   make(chan struct{}, maxGlobal),
		httpClient:  upstream.DefaultClient(120*time.Second, allowPrivate),
		ocrMaxLimit: maxOCR,
	}
}

// SetObservabilitySink sets the observability sink for recording request traces.
func (p *Pipeline) SetObservabilitySink(sink types.ObservabilitySink) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.obsSink = sink
}

// SetHTTPClient overrides the default HTTP client (useful for unit testing).
func (p *Pipeline) SetHTTPClient(client *http.Client) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.httpClient = client
}

// SetAdapterEngine sets the adapter engine for request/response mutation.
func (p *Pipeline) SetAdapterEngine(engine types.AdapterEngine) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.adapterEngine = engine
}

// DetectImageMIME detects image MIME type from raw base64 or magic bytes cleanly without panicking.
func DetectImageMIME(b64 string, explicitMime string) string {
	if explicitMime != "" && explicitMime != "application/octet-stream" {
		return explicitMime
	}

	trimmed := strings.TrimSpace(b64)
	if strings.HasPrefix(trimmed, "data:") {
		if semi := strings.Index(trimmed, ";"); semi > 5 {
			mimePart := trimmed[5:semi]
			if strings.HasPrefix(mimePart, "image/") {
				return mimePart
			}
		}
		if comma := strings.Index(trimmed, ","); comma >= 0 {
			trimmed = strings.TrimSpace(trimmed[comma+1:])
		}
	}

	// Try decoding prefix to check binary magic bytes
	prefix := trimmed
	if len(prefix) > 64 {
		prefix = prefix[:64]
	}
	switch len(prefix) % 4 {
	case 2:
		prefix += "=="
	case 3:
		prefix += "="
	}

	decoded, err := base64.StdEncoding.DecodeString(prefix)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(prefix)
	}

	if err == nil && len(decoded) >= 2 {
		// PNG: \x89PNG (\x89\x50\x4e\x47)
		if len(decoded) >= 4 && bytes.Equal(decoded[:4], []byte{0x89, 'P', 'N', 'G'}) {
			return "image/png"
		}
		// JPEG: \xff\xd8\xff
		if len(decoded) >= 3 && bytes.Equal(decoded[:3], []byte{0xff, 0xd8, 0xff}) {
			return "image/jpeg"
		}
		// WebP: RIFF....WEBP (bytes 0..3 "RIFF", bytes 8..11 "WEBP")
		if len(decoded) >= 12 && bytes.Equal(decoded[:4], []byte("RIFF")) && bytes.Equal(decoded[8:12], []byte("WEBP")) {
			return "image/webp"
		}
		// GIF: GIF87a or GIF89a
		if len(decoded) >= 6 && (bytes.Equal(decoded[:6], []byte("GIF87a")) || bytes.Equal(decoded[:6], []byte("GIF89a"))) {
			return "image/gif"
		}
		// BMP: BM
		if len(decoded) >= 2 && bytes.Equal(decoded[:2], []byte("BM")) {
			return "image/bmp"
		}
		// TIFF: II*\x00 (little endian) or MM\x00* (big endian)
		if len(decoded) >= 4 && (bytes.Equal(decoded[:4], []byte{0x49, 0x49, 0x2a, 0x00}) || bytes.Equal(decoded[:4], []byte{0x4d, 0x4d, 0x00, 0x2a})) {
			return "image/tiff"
		}
	}

	// Fallback to base64 string prefix matching (matches v1 proxy_routes.py)
	if strings.HasPrefix(trimmed, "/9j/") {
		return "image/jpeg"
	}
	if strings.HasPrefix(trimmed, "iVBORw0KGgo") || strings.HasPrefix(trimmed, "iVBOR") {
		return "image/png"
	}
	if strings.HasPrefix(trimmed, "UklGR") {
		return "image/webp"
	}
	if strings.HasPrefix(trimmed, "R0lGOD") {
		return "image/gif"
	}
	if strings.HasPrefix(trimmed, "Qk") {
		return "image/bmp"
	}
	if strings.HasPrefix(trimmed, "SUkq") || strings.HasPrefix(trimmed, "TU0A") {
		return "image/tiff"
	}
	if strings.HasPrefix(trimmed, "AAAA") || strings.Contains(trimmed[:min(40, len(trimmed))], "ftypheic") || strings.Contains(trimmed[:min(40, len(trimmed))], "ftypavif") {
		return "image/heic"
	}

	return "image/png"
}

// DetectImageMIMEFromBytes detects MIME from raw decoded image bytes.
func DetectImageMIMEFromBytes(data []byte, explicitMime string) string {
	if explicitMime != "" && explicitMime != "application/octet-stream" {
		return explicitMime
	}
	if len(data) >= 4 && bytes.Equal(data[:4], []byte{0x89, 'P', 'N', 'G'}) {
		return "image/png"
	}
	if len(data) >= 3 && bytes.Equal(data[:3], []byte{0xff, 0xd8, 0xff}) {
		return "image/jpeg"
	}
	if len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	if len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))) {
		return "image/gif"
	}
	if len(data) >= 2 && bytes.Equal(data[:2], []byte("BM")) {
		return "image/bmp"
	}
	if len(data) >= 4 && (bytes.Equal(data[:4], []byte{0x49, 0x49, 0x2a, 0x00}) || bytes.Equal(data[:4], []byte{0x4d, 0x4d, 0x00, 0x2a})) {
		return "image/tiff"
	}
	return "image/png"
}

type parsedOCRRequest struct {
	ImageBase64 string
	ImageURL    string
	Prompt      string
	MIMEType    string
	Model       string
	Messages    []any
	MaxTokens   int
}

func parseOCRRequest(r *http.Request, bodyBytes []byte) (*parsedOCRRequest, error) {
	req := &parsedOCRRequest{
		Prompt:    "请识别图片中的所有文字内容，返回纯文本。",
		MaxTokens: 4096,
	}

	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(ct)
		if err != nil {
			return nil, fmt.Errorf("invalid multipart media type: %w", err)
		}
		mr := multipart.NewReader(bytes.NewReader(bodyBytes), params["boundary"])
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, fmt.Errorf("reading multipart: %w", err)
			}
			formName := part.FormName()
			fileName := part.FileName()

			if fileName != "" || formName == "file" || formName == "image" {
				partBytes, err := io.ReadAll(part)
				if err != nil {
					return nil, fmt.Errorf("reading file part: %w", err)
				}
				partMime := part.Header.Get("Content-Type")
				detected := DetectImageMIMEFromBytes(partBytes, partMime)
				req.MIMEType = detected
				req.ImageBase64 = base64.StdEncoding.EncodeToString(partBytes)
			} else {
				val, err := io.ReadAll(part)
				if err != nil {
					return nil, fmt.Errorf("reading form value: %w", err)
				}
				sVal := strings.TrimSpace(string(val))
				switch formName {
				case "prompt":
					if sVal != "" {
						req.Prompt = sVal
					}
				case "model":
					if sVal != "" {
						req.Model = sVal
					}
				case "mime_type":
					if sVal != "" {
						req.MIMEType = sVal
					}
				}
			}
		}
		return req, nil
	}

	// JSON parsing
	var jsonBody map[string]any
	if err := json.Unmarshal(bodyBytes, &jsonBody); err != nil {
		return nil, fmt.Errorf("invalid json body: %w", err)
	}

	if s, ok := jsonBody["image_base64"].(string); ok && strings.TrimSpace(s) != "" {
		req.ImageBase64 = strings.TrimSpace(s)
	}

	if req.ImageBase64 == "" {
		if s, ok := jsonBody["image"].(string); ok && strings.TrimSpace(s) != "" {
			s = strings.TrimSpace(s)
			if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
				req.ImageURL = s
			} else {
				req.ImageBase64 = s
			}
		}
	}

	if u, ok := jsonBody["image_url"].(string); ok && strings.TrimSpace(u) != "" {
		req.ImageURL = strings.TrimSpace(u)
	} else if uMap, ok := jsonBody["image_url"].(map[string]any); ok {
		if u, ok := uMap["url"].(string); ok && strings.TrimSpace(u) != "" {
			req.ImageURL = strings.TrimSpace(u)
		}
	}

	if p, ok := jsonBody["prompt"].(string); ok && strings.TrimSpace(p) != "" {
		req.Prompt = strings.TrimSpace(p)
	}

	if m, ok := jsonBody["mime_type"].(string); ok && strings.TrimSpace(m) != "" {
		req.MIMEType = strings.TrimSpace(m)
	}

	if m, ok := jsonBody["model"].(string); ok && strings.TrimSpace(m) != "" {
		req.Model = strings.TrimSpace(m)
	}

	if mt, ok := jsonBody["max_tokens"].(float64); ok && mt > 0 {
		req.MaxTokens = int(mt)
	}

	if msgs, ok := jsonBody["messages"].([]any); ok && len(msgs) > 0 {
		req.Messages = msgs
		if req.ImageBase64 == "" && req.ImageURL == "" {
			for _, m := range msgs {
				if mMap, ok := m.(map[string]any); ok {
					if content, ok := mMap["content"].([]any); ok {
						for _, part := range content {
							if pMap, ok := part.(map[string]any); ok {
								pType, _ := pMap["type"].(string)
								if pType == "image_url" {
									if iu, ok := pMap["image_url"].(map[string]any); ok {
										if u, ok := iu["url"].(string); ok {
											u = strings.TrimSpace(u)
											if strings.HasPrefix(u, "data:") {
												req.ImageBase64 = u
											} else {
												req.ImageURL = u
											}
										}
									}
								} else if pType == "text" && req.Prompt == "请识别图片中的所有文字内容，返回纯文本。" {
									if t, ok := pMap["text"].(string); ok && strings.TrimSpace(t) != "" {
										req.Prompt = strings.TrimSpace(t)
									}
								}
							}
						}
					}
				}
			}
		}
	}

	return req, nil
}

func isNativeOCR(cand *types.KBCandidate, prov *types.ProviderConfig, reqModel string) bool {
	if prov != nil {
		if strings.EqualFold(prov.APIType, "ocr") || strings.EqualFold(prov.APIType, "native_ocr") || strings.EqualFold(prov.APIType, "native") {
			return true
		}
		for _, p := range prov.Protocols {
			if strings.EqualFold(p, "ocr") || strings.EqualFold(p, "native_ocr") {
				return true
			}
		}
	}
	if cand != nil {
		if strings.EqualFold(cand.Model, "ocr") || strings.EqualFold(cand.Model, "native_ocr") || strings.EqualFold(cand.Model, "native") {
			return true
		}
		if cand.Model == "" && (reqModel == "" || reqModel == "ocr") {
			return true
		}
	}
	return false
}

func extractAssistantText(respData map[string]any) string {
	if choices, ok := respData["choices"].([]any); ok && len(choices) > 0 {
		if firstChoice, ok := choices[0].(map[string]any); ok {
			if msg, ok := firstChoice["message"].(map[string]any); ok {
				if c, ok := msg["content"].(string); ok {
					return c
				} else if cList, ok := msg["content"].([]any); ok {
					var sb strings.Builder
					for _, part := range cList {
						if pMap, ok := part.(map[string]any); ok {
							if txt, ok := pMap["text"].(string); ok {
								sb.WriteString(txt)
							}
						}
					}
					return sb.String()
				}
			}
		}
	}
	if t, ok := respData["text"].(string); ok {
		return t
	}
	if c, ok := respData["content"].(string); ok {
		return c
	}
	return ""
}

func applyAdapterRules(engine types.AdapterEngine, endpoint string, reqBytes []byte, prov *types.ProviderConfig, targetModel string) ([]byte, map[string]string, error) {
	if engine != nil {
		mutated, extraHeaders, _, err := engine.PrepareRequest(endpoint, reqBytes, prov, targetModel, false)
		return mutated, extraHeaders, err
	}

	extraHeaders := make(map[string]string)
	if prov == nil || prov.AdapterRules == nil {
		return reqBytes, extraHeaders, nil
	}

	rules := prov.AdapterRules
	if rules.ExtraHeaders != nil {
		for k, v := range rules.ExtraHeaders {
			extraHeaders[k] = v
		}
	}

	var data map[string]any
	if err := json.Unmarshal(reqBytes, &data); err != nil {
		return reqBytes, extraHeaders, nil
	}

	for _, param := range rules.StripParams {
		delete(data, param)
	}

	if rules.StripReasoningEnabled {
		if rObj, ok := data["reasoning"].(map[string]any); ok {
			delete(rObj, "enabled")
			if len(rObj) == 0 {
				delete(data, "reasoning")
			}
		}
		delete(data, "reasoning_effort")
	}

	for oldKey, newKey := range rules.RenameParams {
		if val, exists := data[oldKey]; exists {
			data[newKey] = val
			delete(data, oldKey)
		}
	}

	for k, v := range rules.OverrideParams {
		data[k] = v
	}

	mutated, err := json.Marshal(data)
	if err != nil {
		return reqBytes, extraHeaders, nil
	}
	return mutated, extraHeaders, nil
}

// HandleOCR handles /v1/ocr with pre-read semaphore guard to prevent 20MB OOM.
func (p *Pipeline) HandleOCR(w http.ResponseWriter, r *http.Request) {
	// Pre-read semaphore acquisition: REJECT WITH 429 BEFORE READING BODY!
	select {
	case p.ocrSem <- struct{}{}:
		defer func() { <-p.ocrSem }()
	default:
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "ocr concurrency limit reached, please retry later",
				"type":    "rate_limit_error",
				"code":    "ocr_max_inflight_exceeded",
			},
		})
		return
	}

	// Global concurrency semaphore
	select {
	case p.globalSem <- struct{}{}:
		defer func() { <-p.globalSem }()
	case <-r.Context().Done():
		return
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	if len(bodyBytes) > MaxBodyBytes {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "payload exceeds 20MB limit",
				"type":    "invalid_request_error",
			},
		})
		return
	}

	parsed, err := parseOCRRequest(r, bodyBytes)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": err.Error(),
				"type":    "invalid_request_error",
			},
		})
		return
	}

	if parsed.ImageBase64 == "" && parsed.ImageURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "Must provide image_base64 or image_url",
				"type":    "invalid_request_error",
				"code":    "missing_image",
			},
		})
		return
	}

	snap, err := p.configSrc.Current(r.Context(), false)
	if err != nil || snap == nil || snap.Config == nil {
		http.Error(w, "configuration unavailable", http.StatusServiceUnavailable)
		return
	}

	candidates := snap.Config.KBModels["ocr"]
	var enabledCandidates []*types.KBCandidate
	for _, c := range candidates {
		if c != nil && c.Enabled {
			enabledCandidates = append(enabledCandidates, c)
		}
	}

	if len(enabledCandidates) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "no enabled candidate configured for kb ocr",
				"type":    "invalid_request_error",
			},
		})
		return
	}

	startTime := time.Now()
	trace := types.RequestTrace{
		ID:        fmt.Sprintf("kb_%x", time.Now().UnixNano()),
		Timestamp: startTime.Unix(),
		Mode:      "kb",
		Endpoint:  "/v1/ocr",
		ReqModel:  "ocr",
		Tries:     make([]types.Try, 0, len(enabledCandidates)),
	}

	p.mu.Lock()
	sink := p.obsSink
	client := p.httpClient
	engine := p.adapterEngine
	p.mu.Unlock()

	var lastStatus int = http.StatusBadGateway
	var lastErrSnippet string = "all candidates failed"

	detectedMime := DetectImageMIME(parsed.ImageBase64, parsed.MIMEType)

	for _, cand := range enabledCandidates {
		prov, ok := snap.Config.Providers[cand.Provider]
		if !ok || !prov.Enabled {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				Model:        cand.Model,
				Status:       http.StatusServiceUnavailable,
				Millis:       0,
				Reason:       "provider_disabled",
				ErrorSnippet: "provider not found or disabled",
			})
			continue
		}

		var apiKey string
		var keyLabel string
		for _, k := range prov.APIKeys {
			if k.Enabled && (cand.KeyLabel == "" || k.Label == cand.KeyLabel || k.ID == cand.KeyLabel) {
				apiKey = k.Key
				keyLabel = k.Label
				if keyLabel == "" {
					keyLabel = k.ID
				}
				break
			}
		}

		if apiKey == "" {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				Model:        cand.Model,
				Status:       http.StatusUnauthorized,
				Millis:       0,
				Reason:       "auth_error",
				ErrorSnippet: "no matching enabled api key for candidate",
			})
			continue
		}

		isNative := isNativeOCR(cand, prov, parsed.Model)

		var targetModel string
		var targetURL string
		var reqPayloadBytes []byte
		var extraHeaders map[string]string

		if isNative {
			targetModel = cand.Model
			if targetModel == "" {
				targetModel = "ocr"
			}
			targetURL = upstream.JoinUpstream(prov.BaseURL, "ocr")
			reqPayloadBytes = bodyBytes
			if cand.Model != "" && cand.Model != "ocr" {
				var parsedBody map[string]any
				if err := json.Unmarshal(bodyBytes, &parsedBody); err == nil {
					parsedBody["model"] = cand.Model
					if mutated, err := json.Marshal(parsedBody); err == nil {
						reqPayloadBytes = mutated
					}
				}
			}
		} else {
			// Vision ChatCompletion dispatch
			targetModel = cand.Model
			if targetModel == "" || targetModel == "ocr" {
				if parsed.Model != "" && parsed.Model != "ocr" {
					targetModel = parsed.Model
				} else {
					targetModel = "gpt-4o"
				}
			}

			targetURL = upstream.JoinUpstream(prov.BaseURL, "chat/completions")

			dataURL := parsed.ImageURL
			if dataURL == "" && parsed.ImageBase64 != "" {
				if strings.HasPrefix(parsed.ImageBase64, "data:") {
					dataURL = parsed.ImageBase64
				} else {
					dataURL = fmt.Sprintf("data:%s;base64,%s", detectedMime, parsed.ImageBase64)
				}
			}

			var msgs []any
			if len(parsed.Messages) > 0 {
				msgs = parsed.Messages
			} else {
				msgs = []any{
					map[string]any{
						"role": "user",
						"content": []any{
							map[string]any{"type": "text", "text": parsed.Prompt},
							map[string]any{"type": "image_url", "image_url": map[string]any{"url": dataURL}},
						},
					},
				}
			}

			maxTokens := parsed.MaxTokens
			if maxTokens <= 0 {
				maxTokens = 4096
			}

			chatBody := map[string]any{
				"model":      targetModel,
				"messages":   msgs,
				"max_tokens": maxTokens,
				"stream":     false,
			}
			// Suppress thinking/reasoning parameters
			delete(chatBody, "reasoning_effort")
			delete(chatBody, "thinking")
			delete(chatBody, "reasoning")
			delete(chatBody, "thinking_config")

			rawChatBytes, err := json.Marshal(chatBody)
			if err != nil {
				continue
			}

			mutated, extra, err := applyAdapterRules(engine, "/v1/chat/completions", rawChatBytes, prov, targetModel)
			if err != nil {
				reqPayloadBytes = rawChatBytes
			} else {
				reqPayloadBytes = mutated
				extraHeaders = extra
			}
		}

		upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, targetURL, bytes.NewReader(reqPayloadBytes))
		if err != nil {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       http.StatusInternalServerError,
				Millis:       0,
				Reason:       "internal_error",
				ErrorSnippet: obs.ScrubString(err.Error()),
			})
			continue
		}

		authHeader := "Authorization"
		authPrefix := "Bearer "
		if prov.AdapterRules != nil {
			if prov.AdapterRules.AuthHeader != "" {
				authHeader = prov.AdapterRules.AuthHeader
			}
			if prov.AdapterRules.AuthPrefix != "" {
				authPrefix = prov.AdapterRules.AuthPrefix
			}
		}
		upReq.Header.Set(authHeader, authPrefix+apiKey)
		upReq.Header.Set("Content-Type", "application/json")
		for k, v := range extraHeaders {
			upReq.Header.Set(k, v)
		}

		startTry := time.Now()
		resp, err := client.Do(upReq)
		elapsed := time.Since(startTry).Milliseconds()

		if err != nil {
			lastStatus = http.StatusBadGateway
			lastErrSnippet = err.Error()
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       http.StatusBadGateway,
				Millis:       elapsed,
				Reason:       "network_error",
				ErrorSnippet: obs.ScrubString(err.Error()),
			})
			continue
		}

		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			snipBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 240))
			_ = resp.Body.Close()

			lastStatus = resp.StatusCode
			lastErrSnippet = string(snipBytes)
			reason := "server_error"
			if resp.StatusCode == http.StatusTooManyRequests {
				reason = "rate_limit"
			}

			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       resp.StatusCode,
				Millis:       elapsed,
				Reason:       reason,
				ErrorSnippet: obs.ScrubString(string(snipBytes)),
			})
			continue
		}

		respBodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, MaxBodyBytes))
		_ = resp.Body.Close()

		trace.Tries = append(trace.Tries, types.Try{
			Attempt:  len(trace.Tries) + 1,
			Provider: cand.Provider,
			KeyID:    keyLabel,
			Model:    targetModel,
			Status:   resp.StatusCode,
			Millis:   elapsed,
		})
		trace.WinnerProvider = cand.Provider
		trace.WinnerKey = keyLabel
		trace.ServedModel = targetModel
		trace.Status = resp.StatusCode
		trace.TotalMillis = time.Since(startTime).Milliseconds()
		trace.UpBytes = len(reqPayloadBytes)
		trace.DownBytes = len(respBodyBytes)

		if resp.StatusCode == http.StatusOK {
			if engine != nil {
				if transformed, err := engine.TransformNonStreamResponse("/v1/chat/completions", respBodyBytes, prov, targetModel); err == nil {
					respBodyBytes = transformed
				}
			}

			var respData map[string]any
			if err := json.Unmarshal(respBodyBytes, &respData); err == nil {
				extracted := extractAssistantText(respData)
				if extracted != "" {
					if _, ok := respData["text"]; !ok {
						respData["text"] = extracted
					}
					if _, ok := respData["content"]; !ok {
						respData["content"] = extracted
					}
				}
				if usage, ok := respData["usage"].(map[string]any); ok {
					if pt, ok := usage["prompt_tokens"].(float64); ok {
						trace.InTokens = int(pt)
					}
					if ct, ok := usage["completion_tokens"].(float64); ok {
						trace.OutTokens = int(ct)
					}
				}
				if mutated, err := json.Marshal(respData); err == nil {
					respBodyBytes = mutated
				}
			}
		}

		if sink != nil {
			sink.RecordRequest(trace)
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Routed-Via", cand.Provider)
		w.Header().Set("X-Fallback-Attempts", strconv.Itoa(len(trace.Tries)))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBodyBytes)
		return
	}

	// All candidates failed
	trace.Status = lastStatus
	trace.TotalMillis = time.Since(startTime).Milliseconds()
	if sink != nil {
		sink.RecordRequest(trace)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(lastStatus)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": "all kb upstream candidates failed: " + obs.ScrubString(lastErrSnippet),
			"type":    "upstream_error",
		},
	})
}

// HandleEmbeddings handles /v1/embeddings.
func (p *Pipeline) HandleEmbeddings(w http.ResponseWriter, r *http.Request) {
	p.dispatchKBRequest("embedding", "/v1/embeddings", w, r, nil)
}

// HandleRerank handles /v1/rerank.
func (p *Pipeline) HandleRerank(w http.ResponseWriter, r *http.Request) {
	p.dispatchKBRequest("reranker", "/v1/rerank", w, r, nil)
}

// HandleChat handles /v1/chat/completions for KB mode (category="chat", stream=false).
func (p *Pipeline) HandleChat(w http.ResponseWriter, r *http.Request, bodyBytes []byte) {
	p.dispatchKBRequest("chat", "/v1/chat/completions", w, r, bodyBytes)
}

func (p *Pipeline) dispatchKBRequest(category, endpoint string, w http.ResponseWriter, r *http.Request, preReadBody []byte) {
	// Global concurrency semaphore
	select {
	case p.globalSem <- struct{}{}:
		defer func() { <-p.globalSem }()
	case <-r.Context().Done():
		return
	}

	var bodyBytes []byte
	if preReadBody != nil {
		bodyBytes = preReadBody
	} else {
		var err error
		bodyBytes, err = io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}
	}

	if len(bodyBytes) > MaxBodyBytes {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "payload exceeds 20MB limit",
				"type":    "invalid_request_error",
			},
		})
		return
	}

	snap, err := p.configSrc.Current(r.Context(), false)
	if err != nil || snap == nil || snap.Config == nil {
		http.Error(w, "configuration unavailable", http.StatusServiceUnavailable)
		return
	}

	candidates := snap.Config.KBModels[category]
	var enabledCandidates []*types.KBCandidate
	for _, c := range candidates {
		if c != nil && c.Enabled {
			enabledCandidates = append(enabledCandidates, c)
		}
	}

	if len(enabledCandidates) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": fmt.Sprintf("no enabled candidate configured for kb %s", category),
				"type":    "invalid_request_error",
			},
		})
		return
	}

	startTime := time.Now()
	trace := types.RequestTrace{
		ID:        fmt.Sprintf("kb_%x", time.Now().UnixNano()),
		Timestamp: startTime.Unix(),
		Mode:      "kb",
		Endpoint:  endpoint,
		ReqModel:  category,
		Tries:     make([]types.Try, 0, len(enabledCandidates)),
	}

	p.mu.Lock()
	sink := p.obsSink
	client := p.httpClient
	engine := p.adapterEngine
	p.mu.Unlock()

	var lastStatus int = http.StatusBadGateway
	var lastErrSnippet string = "all candidates failed"

	for _, cand := range enabledCandidates {
		prov, ok := snap.Config.Providers[cand.Provider]
		if !ok || !prov.Enabled {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				Model:        cand.Model,
				Status:       http.StatusServiceUnavailable,
				Millis:       0,
				Reason:       "provider_disabled",
				ErrorSnippet: "provider not found or disabled",
			})
			continue
		}

		var apiKey string
		var keyLabel string
		for _, k := range prov.APIKeys {
			if k.Enabled && (cand.KeyLabel == "" || k.Label == cand.KeyLabel || k.ID == cand.KeyLabel) {
				apiKey = k.Key
				keyLabel = k.Label
				if keyLabel == "" {
					keyLabel = k.ID
				}
				break
			}
		}

		if apiKey == "" {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				Model:        cand.Model,
				Status:       http.StatusUnauthorized,
				Millis:       0,
				Reason:       "auth_error",
				ErrorSnippet: "no matching enabled api key for candidate",
			})
			continue
		}

		targetModel := cand.Model
		if targetModel == "" {
			targetModel = category
		}

		reqBytes := bodyBytes
		if cand.Model != "" && cand.Model != category {
			var parsed map[string]any
			if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
				parsed["model"] = cand.Model
				if mutated, err := json.Marshal(parsed); err == nil {
					reqBytes = mutated
				}
			}
		}

		mutated, extraHeaders, err := applyAdapterRules(engine, endpoint, reqBytes, prov, targetModel)
		if err == nil {
			reqBytes = mutated
		}

		targetURL := upstream.JoinUpstream(prov.BaseURL, endpoint)
		upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, targetURL, bytes.NewReader(reqBytes))
		if err != nil {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       http.StatusInternalServerError,
				Millis:       0,
				Reason:       "internal_error",
				ErrorSnippet: obs.ScrubString(err.Error()),
			})
			continue
		}

		authHeader := "Authorization"
		authPrefix := "Bearer "
		if prov.AdapterRules != nil {
			if prov.AdapterRules.AuthHeader != "" {
				authHeader = prov.AdapterRules.AuthHeader
			}
			if prov.AdapterRules.AuthPrefix != "" {
				authPrefix = prov.AdapterRules.AuthPrefix
			}
		}
		upReq.Header.Set(authHeader, authPrefix+apiKey)
		upReq.Header.Set("Content-Type", "application/json")
		for k, v := range extraHeaders {
			upReq.Header.Set(k, v)
		}

		startTry := time.Now()
		resp, err := client.Do(upReq)
		elapsed := time.Since(startTry).Milliseconds()

		if err != nil {
			lastStatus = http.StatusBadGateway
			lastErrSnippet = err.Error()
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       http.StatusBadGateway,
				Millis:       elapsed,
				Reason:       "network_error",
				ErrorSnippet: obs.ScrubString(err.Error()),
			})
			continue
		}

		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			snipBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 240))
			_ = resp.Body.Close()

			lastStatus = resp.StatusCode
			lastErrSnippet = string(snipBytes)
			reason := "server_error"
			if resp.StatusCode == http.StatusTooManyRequests {
				reason = "rate_limit"
			}

			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       resp.StatusCode,
				Millis:       elapsed,
				Reason:       reason,
				ErrorSnippet: obs.ScrubString(string(snipBytes)),
			})
			continue
		}

		respBodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, MaxBodyBytes))
		_ = resp.Body.Close()

		trace.Tries = append(trace.Tries, types.Try{
			Attempt:  len(trace.Tries) + 1,
			Provider: cand.Provider,
			KeyID:    keyLabel,
			Model:    targetModel,
			Status:   resp.StatusCode,
			Millis:   elapsed,
		})
		trace.WinnerProvider = cand.Provider
		trace.WinnerKey = keyLabel
		trace.ServedModel = targetModel
		trace.Status = resp.StatusCode
		trace.TotalMillis = time.Since(startTime).Milliseconds()
		trace.UpBytes = len(reqBytes)
		trace.DownBytes = len(respBodyBytes)

		if resp.StatusCode == http.StatusOK {
			if engine != nil {
				if transformed, err := engine.TransformNonStreamResponse(endpoint, respBodyBytes, prov, targetModel); err == nil {
					respBodyBytes = transformed
				}
			}
			var respData map[string]any
			if err := json.Unmarshal(respBodyBytes, &respData); err == nil {
				if usage, ok := respData["usage"].(map[string]any); ok {
					if pt, ok := usage["prompt_tokens"].(float64); ok {
						trace.InTokens = int(pt)
					}
					if ct, ok := usage["completion_tokens"].(float64); ok {
						trace.OutTokens = int(ct)
					}
				}
			}
		}

		if sink != nil {
			sink.RecordRequest(trace)
		}

		for k, vv := range resp.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBodyBytes)
		return
	}

	// All candidates failed
	trace.Status = lastStatus
	trace.TotalMillis = time.Since(startTime).Milliseconds()
	if sink != nil {
		sink.RecordRequest(trace)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(lastStatus)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": "all kb upstream candidates failed: " + obs.ScrubString(lastErrSnippet),
			"type":    "upstream_error",
		},
	})
}
