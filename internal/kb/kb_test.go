package kb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

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
	req2 := httptest.NewRequest("POST", "/v1/ocr", strings.NewReader("some image bytes"))
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
