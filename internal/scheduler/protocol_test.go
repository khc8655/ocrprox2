package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestEntryProtocol(t *testing.T) {
	cases := map[string]string{
		"/v1/messages":             ProtoAnthropic,
		"/api/v1/messages":         ProtoAnthropic,
		"/v1/chat/completions":     ProtoOpenAI,
		"/api/v1/chat/completions": ProtoOpenAI,
		"/v1/responses":            ProtoOpenAI,
		"/v1/models":               "",
		"/v1/ocr":                  "",
		"/v1/embeddings":           "",
		"/v1/rerank":               "",
		"/healthz":                 "",
		"/v1/messages?beta=true":   ProtoAnthropic,
		"/v1/chat/completions?x=1": ProtoOpenAI,
	}
	for path, want := range cases {
		if got := EntryProtocol(path); got != want {
			t.Errorf("EntryProtocol(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestProviderServesProtocol(t *testing.T) {
	cases := []struct {
		name          string
		prov          *types.ProviderConfig
		wantOpenAI    bool
		wantAnthropic bool
	}{
		{"openai api_type", &types.ProviderConfig{APIType: "openai-completions", BaseURL: "https://x/v1"}, true, false},
		{"anthropic api_type", &types.ProviderConfig{APIType: "anthropic-messages", BaseURL: "https://x"}, false, true},
		{"dual: openai api_type + anthropic base", &types.ProviderConfig{APIType: "openai-completions", BaseURL: "https://x/v1", AnthropicBaseURL: "https://x/anthropic"}, true, true},
		{"legacy protocols list, anthropic only", &types.ProviderConfig{Protocols: []string{"messages"}}, false, true},
		{"legacy protocols list, both", &types.ProviderConfig{Protocols: []string{"chat", "messages"}}, true, true},
		{"nothing declared is legacy-unknown: both allowed", &types.ProviderConfig{BaseURL: "https://x/v1"}, true, true},
		{"gemini is openai-family", &types.ProviderConfig{APIType: "gemini", BaseURL: "https://x"}, true, false},
		{"ocr-only declares no chat dialect: left permissive", &types.ProviderConfig{APIType: "ocr", BaseURL: "https://x"}, true, true},
		{"nil provider", nil, false, false},
	}
	for _, tc := range cases {
		if got := ProviderServesProtocol(tc.prov, ProtoOpenAI); got != tc.wantOpenAI {
			t.Errorf("%s: openai = %v, want %v", tc.name, got, tc.wantOpenAI)
		}
		if got := ProviderServesProtocol(tc.prov, ProtoAnthropic); got != tc.wantAnthropic {
			t.Errorf("%s: anthropic = %v, want %v", tc.name, got, tc.wantAnthropic)
		}
	}
}

func TestRouteServesProtocol(t *testing.T) {
	providers := map[string]*types.ProviderConfig{
		"only-openai":    {APIType: "openai-completions", BaseURL: "https://a/v1"},
		"only-anthropic": {APIType: "anthropic-messages", BaseURL: "https://b"},
		"dual":           {APIType: "openai-completions", BaseURL: "https://c/v1", AnthropicBaseURL: "https://c/anthropic"},
	}

	// Every candidate openai-only, client asks anthropic.
	route := &types.AgentModelRoute{Enabled: true, Candidates: []*types.RouteCandidate{
		{Provider: "only-openai", Enabled: true},
		{Provider: "only-openai", Enabled: true},
	}}
	ok, notes := RouteServesProtocol(route, providers, ProtoAnthropic)
	if ok || len(notes) == 0 {
		t.Fatalf("expected mismatch with notes, got ok=%v notes=%v", ok, notes)
	}
	if !strings.Contains(notes[0], "openai-compatible only") {
		t.Fatalf("note should describe the dialect, got %q", notes[0])
	}

	// A dual provider in the pool serves both dialects.
	route.Candidates = append(route.Candidates, &types.RouteCandidate{Provider: "dual", Enabled: true})
	if ok, notes := RouteServesProtocol(route, providers, ProtoAnthropic); !ok {
		t.Fatalf("dual provider should serve anthropic, notes=%v", notes)
	}

	// Disabled candidates do not count...
	route.Candidates = []*types.RouteCandidate{{Provider: "only-anthropic", Enabled: false}}
	if ok, notes := RouteServesProtocol(route, providers, ProtoAnthropic); ok || len(notes) != 0 {
		t.Fatalf("no enabled candidates must be silent (503 path handles it), got ok=%v notes=%v", ok, notes)
	}

	// ...and a missing provider is named rather than silently dropped.
	route.Candidates = []*types.RouteCandidate{{Provider: "ghost", Enabled: true}}
	ok, notes = RouteServesProtocol(route, providers, ProtoAnthropic)
	if ok || len(notes) != 1 || !strings.Contains(notes[0], "unknown provider") {
		t.Fatalf("missing provider should be reported as unknown, got ok=%v notes=%v", ok, notes)
	}
}

// The gateway must not hand an Anthropic body to an OpenAI endpoint: the call is
// rejected before any key is spent, and the upstream never sees a request.
func TestDispatch_RejectsProtocolMismatch(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer upstream.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p-openai": {
				ID: "p-openai", BaseURL: upstream.URL, APIType: "openai-completions", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-1", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"m": {Enabled: true, Candidates: []*types.RouteCandidate{{Provider: "p-openai", KeyLabel: "k1", Enabled: true}}},
		},
	}
	s := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	body := []byte(`{"model":"m","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`)

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	err := s.Dispatch(context.Background(), "/v1/messages", body, "m", false, rec, req)
	if err != ErrProtocolUnsupported {
		t.Fatalf("expected ErrProtocolUnsupported, got %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "cannot be served over") {
		t.Fatalf("error body should explain the mismatch, got %s", rec.Body.String())
	}
	if n := atomic.LoadInt32(&hits); n != 0 {
		t.Fatalf("upstream must not be called on a protocol mismatch, got %d hits", n)
	}

	// The same model over its own dialect still works.
	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(body)))
	rec2 := httptest.NewRecorder()
	if err := s.Dispatch(context.Background(), "/v1/chat/completions", body, "m", false, rec2, req2); err != nil {
		t.Fatalf("openai entry should succeed, got %v (%d)", err, rec2.Code)
	}
	if n := atomic.LoadInt32(&hits); n != 1 {
		t.Fatalf("expected exactly 1 upstream hit, got %d", n)
	}
}

// An Anthropic-only provider serves /v1/messages on its base_url even without an
// explicit anthropic_base_url — that is how a Claude-native vendor is configured.
func TestDispatch_AnthropicProviderServesMessages(t *testing.T) {
	var seenPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"msg","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}`))
	}))
	defer upstream.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p-ant": {
				ID: "p-ant", BaseURL: upstream.URL, APIType: "anthropic-messages", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-ant", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"claude": {Enabled: true, Candidates: []*types.RouteCandidate{{Provider: "p-ant", KeyLabel: "k1", Enabled: true}}},
		},
	}
	s := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	body := []byte(`{"model":"claude","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	if err := s.Dispatch(context.Background(), "/v1/messages", body, "claude", false, rec, req); err != nil {
		t.Fatalf("anthropic entry should succeed, got %v (%d): %s", err, rec.Code, rec.Body.String())
	}
	if !strings.HasSuffix(seenPath, "/v1/messages") {
		t.Fatalf("upstream should see /v1/messages, got %q", seenPath)
	}

	// The reverse direction is rejected: this provider has no OpenAI endpoint.
	bodyOAI := []byte(`{"model":"claude","messages":[{"role":"user","content":"hi"}]}`)
	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(bodyOAI)))
	rec2 := httptest.NewRecorder()
	if err := s.Dispatch(context.Background(), "/v1/chat/completions", bodyOAI, "claude", false, rec2, req2); err != ErrProtocolUnsupported {
		t.Fatalf("expected ErrProtocolUnsupported for the reverse direction, got %v (%d)", err, rec2.Code)
	}
}
