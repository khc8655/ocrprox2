package scheduler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

// setupStickyBench builds a sticky_failover route with keys keys on one provider
// and a per-key soft concurrency cap of maxConc (0 = uncapped).
func setupStickyBench(b *testing.B, keys, maxConc int) (*Scheduler, func()) {
	b.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}`))
	}))

	apiKeys := make([]*types.KeyEntry, 0, keys)
	cands := make([]*types.RouteCandidate, 0, keys)
	for i := 0; i < keys; i++ {
		label := fmt.Sprintf("k%d", i+1)
		apiKeys = append(apiKeys, &types.KeyEntry{ID: label, Label: label, Key: "sk-bench-" + label, Enabled: true})
		// A cap is what arms the admission claim; without one nothing can fill up
		// and the claim path is skipped entirely.
		cands = append(cands, &types.RouteCandidate{Provider: "mock", KeyLabel: label, TargetModel: "bench-model", Enabled: true, MaxConc: maxConc})
	}

	cfg := &types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"mock": {ID: "mock", BaseURL: upstream.URL + "/v1", Enabled: true, APIKeys: apiKeys},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"bench-model": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates:      cands,
			},
		},
		Settings: types.RuntimeSettings{
			AgentRoutingStrategy:     "sticky_failover",
			AgentFirstByteTimeoutSec: 30,
		},
	}
	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	return sched, upstream.Close
}

func benchRequest() *http.Request {
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer sk-client")
	req.Header.Set("Content-Type", "application/json")
	return req
}

func dispatchBench(sched *Scheduler, b *testing.B, body []byte, hdr map[string]string) {
	b.Helper()
	rec := httptest.NewRecorder()
	req := benchRequest()
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if err := sched.Dispatch(context.Background(), "/v1/chat/completions", body, "bench-model", false, rec, req); err != nil {
		b.Fatalf("Dispatch err: %v", err)
	}
}

// BenchmarkStickyNewConversation measures the unbound path: every iteration is a
// brand-new conversation, so ordering walks the affinity steps and, when a cap is
// configured, claims a lane slot on the chosen key.
func BenchmarkStickyNewConversation(b *testing.B) {
	for _, maxConc := range []int{0, 4} {
		for _, keys := range []int{1, 3, 8} {
			b.Run(fmt.Sprintf("cap=%d/keys=%d", maxConc, keys), func(b *testing.B) {
				sched, closeUp := setupStickyBench(b, keys, maxConc)
				defer closeUp()
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					body := []byte(fmt.Sprintf(`{"model":"bench-model","stream":false,"messages":[{"role":"user","content":"conv-%d"}]}`, i))
					dispatchBench(sched, b, body, nil)
				}
			})
		}
	}
}

// BenchmarkStickySharedPrefix measures the multi-agent case the prefix grouping
// exists for: new conversations that differ only in their task, so every one of
// them reuses the same cacheable prefix binding.
func BenchmarkStickySharedPrefix(b *testing.B) {
	for _, maxConc := range []int{0, 4} {
		for _, keys := range []int{1, 3, 8} {
			b.Run(fmt.Sprintf("cap=%d/keys=%d", maxConc, keys), func(b *testing.B) {
				sched, closeUp := setupStickyBench(b, keys, maxConc)
				defer closeUp()
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					body := []byte(fmt.Sprintf(`{"model":"bench-model","stream":false,"system":"you are a coding agent","tools":[{"name":"bash"}],"messages":[{"role":"user","content":"task-%d"}]}`, i))
					dispatchBench(sched, b, body, nil)
				}
			})
		}
	}
}

// BenchmarkStickyBoundSession measures the fast path a long conversation hits:
// a session header repeats, so ordering returns at the binding step.
func BenchmarkStickyBoundSession(b *testing.B) {
	for _, keys := range []int{1, 3, 8} {
		b.Run(fmt.Sprintf("keys=%d", keys), func(b *testing.B) {
			sched, closeUp := setupStickyBench(b, keys, 4)
			defer closeUp()
			body := []byte(`{"model":"bench-model","stream":false,"messages":[{"role":"user","content":"same conversation every turn"}]}`)
			hdr := map[string]string{"X-Session-Id": "bench-session-1"}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				dispatchBench(sched, b, body, hdr)
			}
		})
	}
}

// BenchmarkStickyNewConversationParallel is the contention probe: many goroutines
// opening brand-new conversations at once serialize on the lane lock.
func BenchmarkStickyNewConversationParallel(b *testing.B) {
	for _, maxConc := range []int{0, 4} {
		for _, keys := range []int{1, 3, 8} {
			b.Run(fmt.Sprintf("cap=%d/keys=%d", maxConc, keys), func(b *testing.B) {
				sched, closeUp := setupStickyBench(b, keys, maxConc)
				defer closeUp()
				b.ReportAllocs()
				b.ResetTimer()
				b.RunParallel(func(pb *testing.PB) {
					var n int
					for pb.Next() {
						n++
						body := []byte(fmt.Sprintf(`{"model":"bench-model","stream":false,"messages":[{"role":"user","content":"p-%d"}]}`, n))
						dispatchBench(sched, b, body, nil)
					}
				})
			})
		}
	}
}

func setupOrderBench(keys int, strategy string, maxConc int) (*Scheduler, *types.AgentModelRoute, map[string]*types.ProviderConfig) {
	apiKeys := make([]*types.KeyEntry, 0, keys)
	cands := make([]*types.RouteCandidate, 0, keys)
	for i := 0; i < keys; i++ {
		label := fmt.Sprintf("k%d", i+1)
		apiKeys = append(apiKeys, &types.KeyEntry{ID: label, Label: label, Key: "sk-x-" + label, Enabled: true})
		cands = append(cands, &types.RouteCandidate{Provider: "mock", KeyLabel: label, TargetModel: "m", Enabled: true, MaxConc: maxConc})
	}
	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"mock": {ID: "mock", Enabled: true, APIKeys: apiKeys},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"m": {Enabled: true, RoutingStrategy: strategy, Candidates: cands},
		},
	}
	return NewScheduler(&mockConfigSource{config: cfg}, nil, true), cfg.AgentModels["m"], cfg.Providers
}

// BenchmarkOrderCandidates isolates the ordering cost from the HTTP round trip.
func BenchmarkOrderCandidates(b *testing.B) {
	cases := []struct {
		name     string
		strategy string
		keys     int
		cap      int
	}{
		{"rr/keys=3", "round_robin", 3, 0},
		{"sticky/cap0/keys=3", "sticky_failover", 3, 0},
		{"sticky/cap4/keys=3", "sticky_failover", 3, 4},
		{"sticky/cap0/keys=8", "sticky_failover", 8, 0},
		{"sticky/cap4/keys=8", "sticky_failover", 8, 4},
	}
	for _, tc := range cases {
		b.Run(tc.name, func(b *testing.B) {
			sched, route, provs := setupOrderBench(tc.keys, tc.strategy, tc.cap)
			claim := tc.strategy == "sticky_failover" && tc.cap > 0
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				ident := SessionIdentity{Key: fmt.Sprintf("pfx:%d", i)}
				order := sched.orderCandidates(route, provs, "m", tc.strategy, ident, claim)
				_ = order.List
				if order.ClaimRelease != nil {
					order.ClaimRelease()
				}
			}
		})
	}
}

// BenchmarkOrderCandidatesParallel probes lock contention on the ordering path.
func BenchmarkOrderCandidatesParallel(b *testing.B) {
	cases := []struct {
		name string
		cap  int
		keys int
	}{
		{"cap0/keys=8", 0, 8},
		{"cap4/keys=8", 4, 8},
	}
	for _, tc := range cases {
		b.Run(tc.name, func(b *testing.B) {
			sched, route, provs := setupOrderBench(tc.keys, "sticky_failover", tc.cap)
			b.ReportAllocs()
			b.ResetTimer()
			b.RunParallel(func(pb *testing.PB) {
				n := 0
				for pb.Next() {
					n++
					ident := SessionIdentity{Key: fmt.Sprintf("pfx:%d-%d", n, tc.cap)}
					order := sched.orderCandidates(route, provs, "m", "sticky_failover", ident, tc.cap > 0)
					_ = order.List
					if order.ClaimRelease != nil {
						order.ClaimRelease()
					}
				}
			})
		})
	}
}
