// Package kb provides specialized protocol adapters for fixed high-concurrency
// KB/RAG pipelines (/v1/ocr, /v1/embeddings, /v1/rerank, and KB chat):
// pre-read OOM semaphore guard for OCR, 20MB body limit, Vision ChatCompletion <->
// Native OCR translation, MIME magic bytes detection, while delegating all
// candidate ordering (round_robin/weighted/least_busy/fast), cooldowns, RPM,
// lane tracking, OAuth, and observability to the unified Scheduler.
package kb

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"

	"github.com/khc8655/llmproxy2/internal/scheduler"
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

type dynamicLimiter struct {
	mu       sync.Mutex
	cond     *sync.Cond
	inflight int
	limit    int
}

func newDynamicLimiter(limit int) *dynamicLimiter {
	l := &dynamicLimiter{limit: limit}
	l.cond = sync.NewCond(&l.mu)
	return l
}

func (l *dynamicLimiter) tryAcquire() (func(), bool) {
	l.mu.Lock()
	if l.inflight >= l.limit {
		l.mu.Unlock()
		return nil, false
	}
	l.inflight++
	l.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.inflight--
			if l.inflight < 0 {
				l.inflight = 0
			}
			l.cond.Signal()
			l.mu.Unlock()
		})
	}, true
}

func (l *dynamicLimiter) acquireContext(ctx context.Context) (func(), bool) {
	stopWake := context.AfterFunc(ctx, func() {
		l.mu.Lock()
		l.cond.Broadcast()
		l.mu.Unlock()
	})
	defer stopWake()

	l.mu.Lock()
	for l.inflight >= l.limit {
		if ctx.Err() != nil {
			l.mu.Unlock()
			return nil, false
		}
		l.cond.Wait()
	}
	if ctx.Err() != nil {
		l.mu.Unlock()
		return nil, false
	}
	l.inflight++
	l.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.inflight--
			if l.inflight < 0 {
				l.inflight = 0
			}
			l.cond.Signal()
			l.mu.Unlock()
		})
	}, true
}

func (l *dynamicLimiter) setLimit(newLimit int) {
	if newLimit <= 0 {
		return
	}
	l.mu.Lock()
	if newLimit != l.limit {
		increased := newLimit > l.limit
		l.limit = newLimit
		if increased {
			l.cond.Broadcast()
		}
	}
	l.mu.Unlock()
}

// Pipeline adapts /v1/ocr, /v1/embeddings, /v1/rerank, and legacy KB chat payloads
// and delegates execution/failover/cooldowns to the unified Scheduler.
type Pipeline struct {
	mu            sync.Mutex
	configSrc     types.ConfigSource
	sched         *scheduler.Scheduler
	ocrLimiter    *dynamicLimiter
	globalLimiter *dynamicLimiter
}

// NewPipeline creates a KB Pipeline backed by an internal unified Scheduler
// (can be shared with the main Agent Scheduler via SetScheduler).
func NewPipeline(cfgSrc types.ConfigSource, maxOCR, maxGlobal int, allowPrivate bool) *Pipeline {
	if maxOCR <= 0 {
		maxOCR = DefaultMaxOCR
	}
	if maxGlobal <= 0 {
		maxGlobal = DefaultMaxGlobal
	}

	return &Pipeline{
		configSrc:     cfgSrc,
		sched:         scheduler.NewScheduler(cfgSrc, nil, allowPrivate),
		ocrLimiter:    newDynamicLimiter(maxOCR),
		globalLimiter: newDynamicLimiter(maxGlobal),
	}
}

// SetScheduler attaches the shared unified Scheduler instance.
func (p *Pipeline) SetScheduler(s *scheduler.Scheduler) {
	if s == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sched = s
}

// SetObservabilitySink sets the observability sink on the underlying Scheduler.
func (p *Pipeline) SetObservabilitySink(sink types.ObservabilitySink) {
	p.mu.Lock()
	s := p.sched
	p.mu.Unlock()
	if s != nil {
		s.SetObservabilitySink(sink)
	}
}

// SetHTTPClient overrides the default HTTP client (useful for unit testing).
func (p *Pipeline) SetHTTPClient(client *http.Client) {
	p.mu.Lock()
	s := p.sched
	p.mu.Unlock()
	if s != nil {
		s.SetHTTPClient(client)
	}
}

// SetAdapterEngine sets the adapter engine for request/response mutation.
func (p *Pipeline) SetAdapterEngine(engine types.AdapterEngine) {
	p.mu.Lock()
	s := p.sched
	p.mu.Unlock()
	if s != nil {
		s.SetEngineForTest(engine)
	}
}

func (p *Pipeline) getScheduler() *scheduler.Scheduler {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sched
}

func (p *Pipeline) acquireGlobalSem(r *http.Request) (func(), bool) {
	return p.globalLimiter.acquireContext(r.Context())
}

func (p *Pipeline) syncDynamicLimits(snap *types.RuntimeSnapshot) {
	if snap == nil || snap.Config == nil {
		return
	}
	s := snap.Config.Settings
	if s.OCRMaxInflight > 0 {
		p.ocrLimiter.setLimit(s.OCRMaxInflight)
	}
	if s.KBGlobalMaxConcurrency > 0 {
		p.globalLimiter.setLimit(s.KBGlobalMaxConcurrency)
	}
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
		if len(decoded) >= 4 && bytes.Equal(decoded[:4], []byte{0x89, 'P', 'N', 'G'}) {
			return "image/png"
		}
		if len(decoded) >= 3 && bytes.Equal(decoded[:3], []byte{0xff, 0xd8, 0xff}) {
			return "image/jpeg"
		}
		if len(decoded) >= 12 && bytes.Equal(decoded[:4], []byte("RIFF")) && bytes.Equal(decoded[8:12], []byte("WEBP")) {
			return "image/webp"
		}
		if len(decoded) >= 6 && (bytes.Equal(decoded[:6], []byte("GIF87a")) || bytes.Equal(decoded[:6], []byte("GIF89a"))) {
			return "image/gif"
		}
		if len(decoded) >= 2 && bytes.Equal(decoded[:2], []byte("BM")) {
			return "image/bmp"
		}
		if len(decoded) >= 4 && (bytes.Equal(decoded[:4], []byte{0x49, 0x49, 0x2a, 0x00}) || bytes.Equal(decoded[:4], []byte{0x4d, 0x4d, 0x00, 0x2a})) {
			return "image/tiff"
		}
	}

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
				req.MIMEType = DetectImageMIMEFromBytes(partBytes, partMime)
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

func isNativeOCRModelKeyword(model string) bool {
	m := strings.TrimSpace(strings.ToLower(model))
	if m == "" {
		return false
	}
	return m == "native_ocr" || m == "native" ||
		strings.Contains(m, "mistral-ocr") || strings.Contains(m, "paddleocr")
}

func isNativeOCR(targetModel string, prov *types.ProviderConfig, reqModel string) bool {
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
	if isNativeOCRModelKeyword(targetModel) {
		return true
	}
	if (targetModel == "" || strings.EqualFold(targetModel, "ocr")) && isNativeOCRModelKeyword(reqModel) {
		return true
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

// HandleOCR handles /v1/ocr with pre-read semaphore guard to prevent 20MB OOM
// and delegates candidate scheduling, cooldowns, RPM, and tracing to Scheduler.
func (p *Pipeline) HandleOCR(w http.ResponseWriter, r *http.Request) {
	if p.configSrc != nil {
		if snap, sErr := p.configSrc.Current(r.Context(), false); sErr == nil {
			p.syncDynamicLimits(snap)
		}
	}

	// Pre-read semaphore acquisition: REJECT WITH 429 BEFORE READING BODY!
	releaseOCR, acquiredOCR := p.ocrLimiter.tryAcquire()
	if !acquiredOCR {
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
	defer releaseOCR()

	releaseGlobal, ok := p.acquireGlobalSem(r)
	if !ok {
		return
	}
	defer releaseGlobal()

	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	if len(bodyBytes) > MaxBodyBytes {
		writePayloadTooLarge(w)
		return
	}

	parsed, err := parseOCRRequest(r, bodyBytes)
	if err != nil {
		writeBadRequest(w, err.Error(), "")
		return
	}
	if parsed.ImageBase64 == "" && parsed.ImageURL == "" {
		writeBadRequest(w, "Must provide image_base64 or image_url", "missing_image")
		return
	}

	detectedMime := DetectImageMIME(parsed.ImageBase64, parsed.MIMEType)
	sched := p.getScheduler()
	engine := sched.Engine()

	if snap, sErr := p.configSrc.Current(r.Context(), false); sErr == nil {
		p.syncDynamicLimits(snap)
	}

	spec := scheduler.EndpointRequestSpec{
		Endpoint:      "/v1/ocr",
		Category:      "ocr",
		ReqModel:      "ocr",
		TraceMode:     "kb",
		RawBody:       bodyBytes,
		ForceStrategy: "round_robin",
		TimeoutSec:    60,
		BuildRequest: func(cand *scheduler.CandidateKey) (string, []byte, map[string]string, error) {
			if isNativeOCR(cand.TargetModel, cand.Provider, parsed.Model) {
				targetModel := cand.TargetModel
				if targetModel == "" {
					targetModel = "ocr"
				}
				targetURL := upstream.JoinUpstream(cand.Provider.BaseURL, "ocr")
				reqPayloadBytes := bodyBytes
				if cand.TargetModel != "" && cand.TargetModel != "ocr" {
					var parsedBody map[string]any
					if json.Unmarshal(bodyBytes, &parsedBody) == nil {
						parsedBody["model"] = cand.TargetModel
						if mutated, mErr := json.Marshal(parsedBody); mErr == nil {
							reqPayloadBytes = mutated
						}
					}
				}
				return targetURL, reqPayloadBytes, nil, nil
			}

			// Vision ChatCompletion dispatch
			targetModel := cand.TargetModel
			if targetModel == "" || targetModel == "ocr" {
				if parsed.Model != "" && parsed.Model != "ocr" {
					targetModel = parsed.Model
				} else {
					targetModel = "gpt-4o"
				}
				cand.TargetModel = targetModel
			}
			targetURL := upstream.JoinUpstream(cand.Provider.BaseURL, "chat/completions")

			dataURL := parsed.ImageURL
			if dataURL == "" && parsed.ImageBase64 != "" {
				if strings.HasPrefix(parsed.ImageBase64, "data:") {
					dataURL = parsed.ImageBase64
				} else {
					dataURL = fmt.Sprintf("data:%s;base64,%s", detectedMime, parsed.ImageBase64)
				}
			}

			msgs := parsed.Messages
			if len(msgs) == 0 {
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
			rawChatBytes, err := json.Marshal(map[string]any{
				"model":      targetModel,
				"messages":   msgs,
				"max_tokens": maxTokens,
				"stream":     false,
			})
			if err != nil {
				return "", nil, nil, err
			}
			if engine != nil {
				mutated, extra, _, prepErr := engine.PrepareRequest("/v1/chat/completions", rawChatBytes, cand.Provider, targetModel, false)
				if prepErr == nil {
					return targetURL, mutated, extra, nil
				}
			}
			return targetURL, rawChatBytes, nil, nil
		},
		TransformBody: func(cand *scheduler.CandidateKey, respBodyBytes []byte) []byte {
			if engine != nil {
				if transformed, err := engine.TransformNonStreamResponse("/v1/chat/completions", respBodyBytes, cand.Provider, cand.TargetModel); err == nil {
					respBodyBytes = transformed
				}
			}
			var respData map[string]any
			if json.Unmarshal(respBodyBytes, &respData) == nil {
				if extracted := extractAssistantText(respData); extracted != "" {
					if _, ok := respData["text"]; !ok {
						respData["text"] = extracted
					}
					if _, ok := respData["content"]; !ok {
						respData["content"] = extracted
					}
				}
				if mutated, err := json.Marshal(respData); err == nil {
					return mutated
				}
			}
			return respBodyBytes
		},
	}

	_ = sched.ExecuteEndpoint(r.Context(), spec, w, r)
}

// HandleEmbeddings handles /v1/embeddings through unified Scheduler routing.
func (p *Pipeline) HandleEmbeddings(w http.ResponseWriter, r *http.Request) {
	p.dispatchKBRequest("embedding", "/v1/embeddings", w, r, nil)
}

// HandleRerank handles /v1/rerank through unified Scheduler routing.
func (p *Pipeline) HandleRerank(w http.ResponseWriter, r *http.Request) {
	p.dispatchKBRequest("reranker", "/v1/rerank", w, r, nil)
}

// HandleChat handles /v1/chat/completions for KB chat pipeline through unified Scheduler routing.
func (p *Pipeline) HandleChat(w http.ResponseWriter, r *http.Request, bodyBytes []byte) {
	p.dispatchKBRequest("chat", "/v1/chat/completions", w, r, bodyBytes)
}

func (p *Pipeline) dispatchKBRequest(category, endpoint string, w http.ResponseWriter, r *http.Request, preReadBody []byte) {
	if p.configSrc != nil {
		if snap, sErr := p.configSrc.Current(r.Context(), false); sErr == nil {
			p.syncDynamicLimits(snap)
		}
	}

	releaseGlobal, ok := p.acquireGlobalSem(r)
	if !ok {
		return
	}
	defer releaseGlobal()

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
		writePayloadTooLarge(w)
		return
	}

	if snap, sErr := p.configSrc.Current(r.Context(), false); sErr == nil {
		p.syncDynamicLimits(snap)
	}

	var probe struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(bodyBytes, &probe)
	reqModel := strings.TrimSpace(probe.Model)
	if reqModel == "" {
		reqModel = category
	}

	sched := p.getScheduler()
	engine := sched.Engine()
	upPath := strings.TrimPrefix(endpoint, "/v1/")
	timeoutSec := 20
	if category == "chat" {
		timeoutSec = 60
	}

	spec := scheduler.EndpointRequestSpec{
		Endpoint:      endpoint,
		Category:      category,
		ReqModel:      reqModel,
		TraceMode:     "kb",
		RawBody:       bodyBytes,
		ForceStrategy: "round_robin",
		TimeoutSec:    timeoutSec,
		BuildRequest: func(cand *scheduler.CandidateKey) (string, []byte, map[string]string, error) {
			reqBytes := bodyBytes
			targetModel := cand.TargetModel
			if targetModel == "" {
				targetModel = reqModel
			}
			var parsed map[string]any
			if json.Unmarshal(bodyBytes, &parsed) == nil {
				mutatedFlag := false
				if cand.TargetModel != "" && cand.TargetModel != category && parsed["model"] != cand.TargetModel {
					parsed["model"] = cand.TargetModel
					mutatedFlag = true
				}
				if category == "chat" {
					for _, k := range []string{"reasoning_effort", "thinking", "reasoning", "thinking_config"} {
						if _, has := parsed[k]; has {
							delete(parsed, k)
							mutatedFlag = true
						}
					}
					if st, ok := parsed["stream"].(bool); ok && st {
						parsed["stream"] = false
						mutatedFlag = true
					}
				}
				if mutatedFlag {
					if mBytes, err := json.Marshal(parsed); err == nil {
						reqBytes = mBytes
					}
				}
			}

			var extraHeaders map[string]string
			if engine != nil {
				if mBytes, extra, _, err := engine.PrepareRequest(endpoint, reqBytes, cand.Provider, targetModel, false); err == nil {
					reqBytes = mBytes
					extraHeaders = extra
				}
			}
			return upstream.JoinUpstream(cand.Provider.BaseURL, upPath), reqBytes, extraHeaders, nil
		},
		TransformBody: func(cand *scheduler.CandidateKey, respBody []byte) []byte {
			if engine != nil {
				if transformed, err := engine.TransformNonStreamResponse(endpoint, respBody, cand.Provider, cand.TargetModel); err == nil {
					return transformed
				}
			}
			return respBody
		},
	}

	_ = sched.ExecuteEndpoint(r.Context(), spec, w, r)
}

func writePayloadTooLarge(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusRequestEntityTooLarge)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": "payload exceeds 20MB limit",
			"type":    "invalid_request_error",
		},
	})
}

func writeBadRequest(w http.ResponseWriter, msg, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	errObj := map[string]any{"message": msg, "type": "invalid_request_error"}
	if code != "" {
		errObj["code"] = code
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"error": errObj})
}
