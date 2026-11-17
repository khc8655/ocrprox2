package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/types"
)

func setupBenchScheduler(b *testing.B, withObs bool) (*Scheduler, *httptest.Server) {
	b.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}`))
	}))

	cfg := &types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"mock": {
				ID:      "mock",
				BaseURL: upstream.URL + "/v1",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "sk-bench-123456", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"bench-model": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				Candidates: []*types.RouteCandidate{
					{Provider: "mock", KeyLabel: "k1", TargetModel: "bench-model", Enabled: true},
				},
			},
		},
		Settings: types.RuntimeSettings{
			RunMode:                  types.ModeAgent,
			AgentRoutingStrategy:     "round_robin",
			AgentFirstByteTimeoutSec: 30,
		},
	}

	var sink types.ObservabilitySink
	if withObs {
		mgr, err := obs.NewManager(types.RoleFull, b.TempDir())
		if err != nil {
			b.Fatalf("NewManager: %v", err)
		}
		b.Cleanup(func() { _ = mgr.Close() })
		sink = mgr
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, sink, true)
	return sched, upstream
}

func BenchmarkRelayDispatch_LiteNoObs(b *testing.B) {
	sched, upstream := setupBenchScheduler(b, false)
	defer upstream.Close()

	body := []byte(`{"model":"bench-model","stream":false,"messages":[{"role":"user","content":"hi"}]}`)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer sk-client")
		req.Header.Set("Content-Type", "application/json")
		if err := sched.Dispatch(context.Background(), "/v1/chat/completions", body, "bench-model", false, rec, req); err != nil {
			b.Fatalf("Dispatch err: %v", err)
		}
	}
}

func BenchmarkRelayDispatch_FullWithObs(b *testing.B) {
	sched, upstream := setupBenchScheduler(b, true)
	defer upstream.Close()

	body := []byte(`{"model":"bench-model","stream":false,"messages":[{"role":"user","content":"hi"}]}`)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer sk-client")
		req.Header.Set("Content-Type", "application/json")
		if err := sched.Dispatch(context.Background(), "/v1/chat/completions", body, "bench-model", false, rec, req); err != nil {
			b.Fatalf("Dispatch err: %v", err)
		}
	}
}
