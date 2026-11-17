package kb

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

type mockKBSource struct {
	config *types.ProxyConfig
}

func (m *mockKBSource) Current(ctx context.Context, forceRefresh bool) (*types.RuntimeSnapshot, error) {
	return &types.RuntimeSnapshot{Config: m.config}, nil
}

func (m *mockKBSource) HealthState() (status string, state string, leaseValid bool, configVer int64) {
	return "healthy", "ready", true, 1
}

type mockObsSink struct {
	mu     sync.Mutex
	traces []types.RequestTrace
}

func (m *mockObsSink) RecordRequest(trace types.RequestTrace) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.traces = append(m.traces, trace)
}

func (m *mockObsSink) RecentTraces(onlyFailedOrRetried bool) []types.RequestTrace {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]types.RequestTrace(nil), m.traces...)
}

func (m *mockObsSink) QueryUsage(period string, tzName string) (map[string]any, error) {
	return map[string]any{"ok": true}, nil
}

func TestPipeline_OCR_PreReadSemaphore(t *testing.T) {
	// Set maxOCR = 1
	pipe := NewPipeline(&mockKBSource{}, 1, 10, true)

	// Block the 1 semaphore slot
	pipe.ocrSem <- struct{}{}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/ocr", strings.NewReader("some image bytes"))

	pipe.HandleOCR(rec, req)

	// Must be rejected with 429
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 when OCR semaphore is full, got %d", rec.Code)
	}

	// Release semaphore
	<-pipe.ocrSem

	// Now should proceed past semaphore check
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/v1/ocr", strings.NewReader(`{"image_base64":"some-data"}`))
	pipe.HandleOCR(rec2, req2)
	// It will return 404 or 503 because mock config has no KB models, but NOT 429
	if rec2.Code == http.StatusTooManyRequests {
		t.Fatalf("did not expect 429 after semaphore released, got %d", rec2.Code)
	}
}

func TestPipeline_BodyTooLarge(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {ID: "p1", BaseURL: ts.URL, Enabled: true, APIKeys: []*types.KeyEntry{{Key: "k", Enabled: true}}},
		},
		KBModels: map[string][]*types.KBCandidate{
			"embedding": {{Provider: "p1", Enabled: true}},
		},
	}

	pipe := NewPipeline(&mockKBSource{config: cfg}, 4, 16, true)

	// Create body exceeding 20MB (20MB + 10 bytes)
	hugeBody := strings.Repeat("A", MaxBodyBytes+10)
	req := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(hugeBody))
	rec := httptest.NewRecorder()

	pipe.HandleEmbeddings(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 Request Entity Too Large, got %d", rec.Code)
	}
}

func TestPipeline_FailoverAndObservability(t *testing.T) {
	// Candidate 1 fails with 502
	ts1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"upstream down"}`))
	}))
	defer ts1.Close()

	// Candidate 2 succeeds with 200
	ts2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"result":"ok from candidate 2"}`))
	}))
	defer ts2.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts1.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "key-1", Enabled: true}},
			},
			"p2": {
				ID:      "p2",
				BaseURL: ts2.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k2", Label: "k2", Key: "key-2", Enabled: true}},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"chat": {
				{Provider: "p1", Model: "cand1-model", KeyLabel: "k1", Enabled: true},
				{Provider: "p2", Model: "cand2-model", KeyLabel: "k2", Enabled: true},
			},
		},
	}

	obs := &mockObsSink{}
	pipe := NewPipeline(&mockKBSource{config: cfg}, 4, 16, true)
	pipe.SetObservabilitySink(obs)

	body := []byte(`{"model":"chat","messages":[{"role":"user","content":"hello"}]}`)
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()

	pipe.HandleChat(rec, req, body)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK after failover, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ok from candidate 2") {
		t.Errorf("expected response from candidate 2, got %s", rec.Body.String())
	}

	// Verify ObservabilitySink trace
	traces := obs.RecentTraces(false)
	if len(traces) != 1 {
		t.Fatalf("expected 1 recorded trace, got %d", len(traces))
	}

	tr := traces[0]
	if tr.Mode != "kb" || tr.ReqModel != "chat" {
		t.Errorf("unexpected trace mode/req_model: %s / %s", tr.Mode, tr.ReqModel)
	}
	if tr.WinnerProvider != "p2" || tr.WinnerKey != "k2" {
		t.Errorf("unexpected winner: provider=%s key=%s", tr.WinnerProvider, tr.WinnerKey)
	}
	if len(tr.Tries) != 2 {
		t.Fatalf("expected 2 tries in trace, got %d", len(tr.Tries))
	}
	if tr.Tries[0].Status != http.StatusBadGateway || tr.Tries[0].Provider != "p1" {
		t.Errorf("unexpected try 0: %+v", tr.Tries[0])
	}
	if tr.Tries[1].Status != http.StatusOK || tr.Tries[1].Provider != "p2" {
		t.Errorf("unexpected try 1: %+v", tr.Tries[1])
	}
}

// ============================================================================
// New Tests for Task D1: OCR Vision Alignment, MIME Detection, Failover, Gating
// ============================================================================

func TestDetectImageMIME_MagicBytes(t *testing.T) {
	tests := []struct {
		name         string
		data         []byte
		explicitMime string
		b64Prefix    string
		expected     string
	}{
		{
			name:     "PNG magic bytes (\\x89PNG\\r\\n\\x1a\\n)",
			data:     []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d},
			expected: "image/png",
		},
		{
			name:     "JPEG magic bytes (\\xff\\xd8\\xff\\xe0)",
			data:     []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0x01},
			expected: "image/jpeg",
		},
		{
			name:     "WebP magic bytes (RIFF....WEBP)",
			data:     []byte{'R', 'I', 'F', 'F', 0x24, 0x00, 0x00, 0x00, 'W', 'E', 'B', 'P', 'V', 'P', '8'},
			expected: "image/webp",
		},
		{
			name:     "GIF87a magic bytes",
			data:     []byte{'G', 'I', 'F', '8', '7', 'a', 0x01, 0x00, 0x01, 0x00},
			expected: "image/gif",
		},
		{
			name:     "GIF89a magic bytes",
			data:     []byte{'G', 'I', 'F', '8', '9', 'a', 0x01, 0x00, 0x01, 0x00},
			expected: "image/gif",
		},
		{
			name:     "BMP magic bytes (BM)",
			data:     []byte{'B', 'M', 0x3a, 0x00, 0x00, 0x00},
			expected: "image/bmp",
		},
		{
			name:     "TIFF magic bytes (II*\\x00)",
			data:     []byte{0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00},
			expected: "image/tiff",
		},
		{
			name:         "Explicit MIME override",
			data:         []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a},
			explicitMime: "image/webp",
			expected:     "image/webp",
		},
		{
			name:      "Data URI prefix in base64",
			b64Prefix: "data:image/jpeg;base64,",
			data:      []byte{0x01, 0x02, 0x03},
			expected:  "image/jpeg",
		},
		{
			name:     "Fallback to image/png on arbitrary unknown bytes",
			data:     []byte("hello world this is not an image"),
			expected: "image/png",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b64 := base64.StdEncoding.EncodeToString(tc.data)
			if tc.b64Prefix != "" {
				b64 = tc.b64Prefix + b64
			}
			detected := DetectImageMIME(b64, tc.explicitMime)
			if detected != tc.expected {
				t.Errorf("DetectImageMIME() = %q, expected %q", detected, tc.expected)
			}

			// Also test DetectImageMIMEFromBytes
			if tc.b64Prefix == "" {
				detectedBytes := DetectImageMIMEFromBytes(tc.data, tc.explicitMime)
				if detectedBytes != tc.expected {
					t.Errorf("DetectImageMIMEFromBytes() = %q, expected %q", detectedBytes, tc.expected)
				}
			}
		})
	}
}

func TestPipeline_OCR_VisionConversionAndResponse(t *testing.T) {
	pngBytes := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R'}
	pngB64 := base64.StdEncoding.EncodeToString(pngBytes)

	var receivedBody map[string]any
	var receivedAuth string
	var receivedPath string

	tsVision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		receivedAuth = r.Header.Get("Authorization")

		bodyBytes, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(bodyBytes, &receivedBody)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		resp := map[string]any{
			"id":      "chatcmpl-vision-ocr-test",
			"object":  "chat.completion",
			"created": 1700000000,
			"model":   "gpt-4o",
			"choices": []any{
				map[string]any{
					"index": 0,
					"message": map[string]any{
						"role":    "assistant",
						"content": "Invoice #1042\nTotal Amount: $1,250.00\nDate: 2026-11-14",
					},
					"finish_reason": "stop",
				},
			},
			"usage": map[string]any{
				"prompt_tokens":     128,
				"completion_tokens": 32,
				"total_tokens":      160,
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer tsVision.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"prov-vision": {
				ID:      "prov-vision",
				BaseURL: tsVision.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "key-vision", Key: "sk-test-vision-key", Enabled: true}},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {
				{Provider: "prov-vision", Model: "gpt-4o", KeyLabel: "key-vision", Enabled: true},
			},
		},
	}

	obs := &mockObsSink{}
	pipe := NewPipeline(&mockKBSource{config: cfg}, 4, 16, true)
	pipe.SetObservabilitySink(obs)

	ocrReqBody := map[string]any{
		"image_base64": pngB64,
		"prompt":       "Please extract all invoice details.",
	}
	reqBytes, _ := json.Marshal(ocrReqBody)

	req := httptest.NewRequest("POST", "/v1/ocr", bytes.NewReader(reqBytes))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	pipe.HandleOCR(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	// 1. Verify upstream request formatting: routed to /v1/chat/completions as OpenAI Vision
	if !strings.HasSuffix(receivedPath, "/chat/completions") {
		t.Fatalf("expected upstream path to end with /chat/completions, got %s", receivedPath)
	}
	if receivedAuth != "Bearer sk-test-vision-key" {
		t.Fatalf("expected Authorization header Bearer sk-test-vision-key, got %s", receivedAuth)
	}

	// Verify chat body structure
	if receivedBody["model"] != "gpt-4o" {
		t.Errorf("expected model gpt-4o, got %v", receivedBody["model"])
	}
	if receivedBody["stream"] != false {
		t.Errorf("expected stream false, got %v", receivedBody["stream"])
	}
	if _, hasReasoning := receivedBody["reasoning_effort"]; hasReasoning {
		t.Errorf("reasoning_effort should be suppressed")
	}

	msgs, ok := receivedBody["messages"].([]any)
	if !ok || len(msgs) == 0 {
		t.Fatalf("expected messages array in upstream payload, got %v", receivedBody["messages"])
	}
	userMsg, _ := msgs[0].(map[string]any)
	contents, _ := userMsg["content"].([]any)
	if len(contents) != 2 {
		t.Fatalf("expected 2 content parts (text and image_url), got %d", len(contents))
	}
	part1, _ := contents[0].(map[string]any)
	if part1["text"] != "Please extract all invoice details." {
		t.Errorf("unexpected prompt text: %v", part1["text"])
	}
	part2, _ := contents[1].(map[string]any)
	imgURLMap, _ := part2["image_url"].(map[string]any)
	urlStr, _ := imgURLMap["url"].(string)
	if !strings.HasPrefix(urlStr, "data:image/png;base64,") {
		t.Errorf("expected data:image/png;base64,... url, got %s", urlStr)
	}

	// 2. Verify returned response schema aligned with v1
	var clientResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &clientResp); err != nil {
		t.Fatalf("failed to parse client response json: %v", err)
	}

	expectedText := "Invoice #1042\nTotal Amount: $1,250.00\nDate: 2026-11-14"
	if clientResp["text"] != expectedText {
		t.Errorf("clientResp['text'] = %q, expected %q", clientResp["text"], expectedText)
	}
	if clientResp["content"] != expectedText {
		t.Errorf("clientResp['content'] = %q, expected %q", clientResp["content"], expectedText)
	}
	if clientResp["model"] != "gpt-4o" {
		t.Errorf("clientResp['model'] = %v, expected gpt-4o", clientResp["model"])
	}

	// Check response headers
	if rec.Header().Get("X-Routed-Via") != "prov-vision" {
		t.Errorf("expected X-Routed-Via prov-vision, got %s", rec.Header().Get("X-Routed-Via"))
	}
	if rec.Header().Get("X-Fallback-Attempts") != "1" {
		t.Errorf("expected X-Fallback-Attempts 1, got %s", rec.Header().Get("X-Fallback-Attempts"))
	}

	// 3. Verify ObservabilitySink trace
	traces := obs.RecentTraces(false)
	if len(traces) != 1 {
		t.Fatalf("expected 1 recorded trace, got %d", len(traces))
	}
	tr := traces[0]
	if tr.Mode != "kb" || tr.Endpoint != "/v1/ocr" || tr.ReqModel != "ocr" {
		t.Errorf("unexpected trace fields: mode=%s endpoint=%s reqModel=%s", tr.Mode, tr.Endpoint, tr.ReqModel)
	}
	if tr.ServedModel != "gpt-4o" {
		t.Errorf("expected ServedModel gpt-4o, got %s", tr.ServedModel)
	}
	if tr.WinnerProvider != "prov-vision" {
		t.Errorf("expected WinnerProvider prov-vision, got %s", tr.WinnerProvider)
	}
	if tr.InTokens != 128 || tr.OutTokens != 32 {
		t.Errorf("expected InTokens=128 OutTokens=32, got In=%d Out=%d", tr.InTokens, tr.OutTokens)
	}
	if tr.UpBytes <= 0 || tr.DownBytes <= 0 {
		t.Errorf("expected UpBytes and DownBytes > 0, got Up=%d Down=%d", tr.UpBytes, tr.DownBytes)
	}
}

func TestPipeline_OCR_VisionFailover(t *testing.T) {
	// Candidate 1 fails with 502 Bad Gateway
	ts1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"message":"primary vision model overloaded","type":"server_error"}}`))
	}))
	defer ts1.Close()

	// Candidate 2 succeeds with 200 OK
	ts2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		resp := map[string]any{
			"id":      "chatcmpl-fallback-succ",
			"object":  "chat.completion",
			"created": 1700000000,
			"model":   "glm-4v",
			"choices": []any{
				map[string]any{
					"index": 0,
					"message": map[string]any{
						"role":    "assistant",
						"content": "Fallback Model OCR Output: Success",
					},
					"finish_reason": "stop",
				},
			},
			"usage": map[string]any{
				"prompt_tokens":     80,
				"completion_tokens": 15,
				"total_tokens":      95,
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer ts2.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"prov-primary": {
				ID:      "prov-primary",
				BaseURL: ts1.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-primary", Enabled: true}},
			},
			"prov-secondary": {
				ID:      "prov-secondary",
				BaseURL: ts2.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k2", Label: "k2", Key: "sk-secondary", Enabled: true}},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {
				{Provider: "prov-primary", Model: "gpt-4o", KeyLabel: "k1", Enabled: true},
				{Provider: "prov-secondary", Model: "glm-4v", KeyLabel: "k2", Enabled: true},
			},
		},
	}

	obs := &mockObsSink{}
	pipe := NewPipeline(&mockKBSource{config: cfg}, 4, 16, true)
	pipe.SetObservabilitySink(obs)

	jpegBytes := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J', 'F', 'I', 'F'}
	jpegB64 := base64.StdEncoding.EncodeToString(jpegBytes)

	reqBytes, _ := json.Marshal(map[string]any{
		"image_base64": jpegB64,
		"prompt":       "Read image",
	})
	req := httptest.NewRequest("POST", "/v1/ocr", bytes.NewReader(reqBytes))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	pipe.HandleOCR(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK after failover, got %d: %s", rec.Code, rec.Body.String())
	}

	var clientResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &clientResp)
	if clientResp["text"] != "Fallback Model OCR Output: Success" {
		t.Errorf("unexpected extracted text: %v", clientResp["text"])
	}
	if rec.Header().Get("X-Routed-Via") != "prov-secondary" {
		t.Errorf("expected X-Routed-Via prov-secondary, got %s", rec.Header().Get("X-Routed-Via"))
	}
	if rec.Header().Get("X-Fallback-Attempts") != "2" {
		t.Errorf("expected X-Fallback-Attempts 2, got %s", rec.Header().Get("X-Fallback-Attempts"))
	}

	traces := obs.RecentTraces(false)
	if len(traces) != 1 {
		t.Fatalf("expected 1 recorded trace, got %d", len(traces))
	}
	tr := traces[0]
	if tr.WinnerProvider != "prov-secondary" || tr.ServedModel != "glm-4v" {
		t.Errorf("unexpected winner/model: %s / %s", tr.WinnerProvider, tr.ServedModel)
	}
	if len(tr.Tries) != 2 {
		t.Fatalf("expected 2 tries, got %d", len(tr.Tries))
	}
	if tr.Tries[0].Status != http.StatusBadGateway || tr.Tries[0].Provider != "prov-primary" {
		t.Errorf("unexpected try 0: %+v", tr.Tries[0])
	}
	if tr.Tries[1].Status != http.StatusOK || tr.Tries[1].Provider != "prov-secondary" {
		t.Errorf("unexpected try 1: %+v", tr.Tries[1])
	}
}

func TestPipeline_OCR_ConcurrentInflightGating(t *testing.T) {
	// Set maxOCR = 2
	maxOCR := 2

	// We create a server that blocks until a channel signal is sent
	holdGate := make(chan struct{})
	var inFlightCount int32

	tsSlow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&inFlightCount, 1)
		defer atomic.AddInt32(&inFlightCount, -1)

		<-holdGate // wait until released

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		resp := map[string]any{
			"choices": []any{
				map[string]any{"message": map[string]any{"content": "OCR text"}},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer tsSlow.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p": {
				ID:      "p",
				BaseURL: tsSlow.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k", Label: "k", Key: "sk", Enabled: true}},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {{Provider: "p", Model: "gpt-4o", KeyLabel: "k", Enabled: true}},
		},
	}

	pipe := NewPipeline(&mockKBSource{config: cfg}, maxOCR, 16, true)

	var wg sync.WaitGroup
	reqBytes, _ := json.Marshal(map[string]any{"image_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="})

	// Start 2 concurrent requests that will occupy both semaphore slots
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			req := httptest.NewRequest("POST", "/v1/ocr", bytes.NewReader(reqBytes))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			pipe.HandleOCR(rec, req)
		}()
	}

	// Give goroutines a moment to acquire the semaphore slots
	time.Sleep(50 * time.Millisecond)

	// Now send a 3rd request - MUST be rejected immediately with 429
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest("POST", "/v1/ocr", bytes.NewReader(reqBytes))
	req3.Header.Set("Content-Type", "application/json")
	pipe.HandleOCR(rec3, req3)

	if rec3.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 3rd concurrent request to get 429 Too Many Requests, got %d: %s", rec3.Code, rec3.Body.String())
	}
	if !strings.Contains(rec3.Body.String(), "ocr_max_inflight_exceeded") {
		t.Errorf("expected error code ocr_max_inflight_exceeded, got %s", rec3.Body.String())
	}
	if rec3.Header().Get("Retry-After") == "" {
		t.Errorf("expected Retry-After header on 429 response")
	}

	// Release the active slow requests
	close(holdGate)
	wg.Wait()

	// 4th request should now succeed after semaphore slots are released
	rec4 := httptest.NewRecorder()
	req4 := httptest.NewRequest("POST", "/v1/ocr", bytes.NewReader(reqBytes))
	req4.Header.Set("Content-Type", "application/json")
	pipe.HandleOCR(rec4, req4)

	if rec4.Code != http.StatusOK {
		t.Fatalf("expected 4th request to succeed with 200 OK after slots released, got %d: %s", rec4.Code, rec4.Body.String())
	}
}

func TestPipeline_OCR_MultipartAndNative(t *testing.T) {
	// Test 1: Multipart upload support
	var receivedVisionURL string
	tsVision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, _ := io.ReadAll(r.Body)
		var b map[string]any
		_ = json.Unmarshal(bodyBytes, &b)
		if msgs, ok := b["messages"].([]any); ok && len(msgs) > 0 {
			if uMsg, ok := msgs[0].(map[string]any); ok {
				if parts, ok := uMsg["content"].([]any); ok && len(parts) > 1 {
					if p2, ok := parts[1].(map[string]any); ok {
						if iu, ok := p2["image_url"].(map[string]any); ok {
							receivedVisionURL, _ = iu["url"].(string)
						}
					}
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Multipart OCR Result"}}]}`))
	}))
	defer tsVision.Close()

	// Test 2: Native OCR candidate support
	var receivedNativePath string
	tsNative := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedNativePath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"text":"Native OCR Output Text","pages":[{"page":1}]}`))
	}))
	defer tsNative.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"prov-vision": {
				ID:      "prov-vision",
				BaseURL: tsVision.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-v", Enabled: true}},
			},
			"prov-native": {
				ID:      "prov-native",
				BaseURL: tsNative.URL,
				APIType: "ocr", // Explicit native OCR
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k2", Label: "k2", Key: "sk-n", Enabled: true}},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {
				{Provider: "prov-vision", Model: "gpt-4o", KeyLabel: "k1", Enabled: true},
			},
		},
	}

	pipe := NewPipeline(&mockKBSource{config: cfg}, 4, 16, true)

	// Create multipart form body
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	_ = mw.WriteField("prompt", "Analyze document")
	fw, _ := mw.CreateFormFile("file", "test.jpg")
	jpegBytes := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J', 'F', 'I', 'F'}
	_, _ = fw.Write(jpegBytes)
	_ = mw.Close()

	req := httptest.NewRequest("POST", "/v1/ocr", &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()

	pipe.HandleOCR(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for multipart OCR, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.HasPrefix(receivedVisionURL, "data:image/jpeg;base64,") {
		t.Errorf("expected vision url data:image/jpeg;base64,..., got %s", receivedVisionURL)
	}

	var clientResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &clientResp)
	if clientResp["text"] != "Multipart OCR Result" {
		t.Errorf("unexpected multipart result: %v", clientResp["text"])
	}

	// Now switch config to prov-native
	cfg.KBModels["ocr"] = []*types.KBCandidate{
		{Provider: "prov-native", Model: "ocr", KeyLabel: "k2", Enabled: true},
	}

	reqNative := httptest.NewRequest("POST", "/v1/ocr", strings.NewReader(`{"image":"raw-img-payload"}`))
	reqNative.Header.Set("Content-Type", "application/json")
	recNative := httptest.NewRecorder()

	pipe.HandleOCR(recNative, reqNative)

	if recNative.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for native OCR, got %d: %s", recNative.Code, recNative.Body.String())
	}
	if !strings.HasSuffix(receivedNativePath, "/ocr") {
		t.Errorf("expected native path /ocr, got %s", receivedNativePath)
	}

	var nativeResp map[string]any
	_ = json.Unmarshal(recNative.Body.Bytes(), &nativeResp)
	if nativeResp["text"] != "Native OCR Output Text" {
		t.Errorf("unexpected native text: %v", nativeResp["text"])
	}
	if nativeResp["content"] != "Native OCR Output Text" {
		t.Errorf("unexpected native content: %v", nativeResp["content"])
	}
}

func TestPipeline_Embeddings_RoundRobin_UnifiedModelAndFilter(t *testing.T) {
	var hitK1, hitK2 atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "sk-k1") {
			hitK1.Add(1)
		} else if strings.Contains(auth, "sk-k2") {
			hitK2.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1,0.2]}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "sk-k1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "sk-k2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "bge-m3", Enabled: true},
					{Provider: "p1", KeyLabel: "k2", TargetModel: "bge-m3", Enabled: true},
				},
			},
		},
	}

	pipe := NewPipeline(&mockKBSource{config: cfg}, 4, 16, true)
	for i := 0; i < 4; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"bge-m3","input":"hello"}`))
		pipe.HandleEmbeddings(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("embedding request %d failed: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if hitK1.Load() != 2 || hitK2.Load() != 2 {
		t.Errorf("expected round_robin 2/2 split across k1/k2, got k1=%d k2=%d", hitK1.Load(), hitK2.Load())
	}
}
