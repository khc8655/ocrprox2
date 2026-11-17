package scheduler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestScheduler_HighConcurrencyStrategies_Weighted_LeastBusy_Fast_RoundRobin(t *testing.T) {
	providers := map[string]*types.ProviderConfig{
		"p1": {
			ID:      "p1",
			Enabled: true,
			APIKeys: []*types.KeyEntry{
				{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
				{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				{ID: "k3", Label: "k3", Key: "key-3", Enabled: true},
			},
		},
	}

	// 1. Weighted smooth round-robin (3 : 1 : 1)
	weightedRoute := &types.AgentModelRoute{
		Enabled:         true,
		RoutingStrategy: "weighted",
		Candidates: []*types.RouteCandidate{
			{Provider: "p1", KeyLabel: "k1", Enabled: true, Weight: 3},
			{Provider: "p1", KeyLabel: "k2", Enabled: true, Weight: 1},
			{Provider: "p1", KeyLabel: "k3", Enabled: true, Weight: 1},
		},
	}

	sched := NewScheduler(&mockConfigSource{}, nil, true)
	counts := map[string]int{}
	for i := 0; i < 10; i++ {
		ord := sched.OrderCandidates(weightedRoute, providers, "emb-model")
		counts[ord[0].KeyTag]++
	}
	if counts["p1:k1"] != 6 || counts["p1:k2"] != 2 || counts["p1:k3"] != 2 {
		t.Errorf("weighted SWRR mismatch: got %v, want k1=6, k2=2, k3=2", counts)
	}

	// 2. Round-robin with free-slot partitioning (saturated MaxConc=1 moved after free slot)
	rrRoute := &types.AgentModelRoute{
		Enabled:         true,
		RoutingStrategy: "round_robin",
		Candidates: []*types.RouteCandidate{
			{Provider: "p1", KeyLabel: "k1", Enabled: true, MaxConc: 1},
			{Provider: "p1", KeyLabel: "k2", Enabled: true, MaxConc: 2},
		},
	}
	// Saturate k1 (MaxConc = 1)
	relK1 := sched.Lanes().Acquire("p1:k1", 0)
	defer relK1()
	for i := 0; i < 4; i++ {
		ord := sched.OrderCandidates(rrRoute, providers, "ocr")
		if ord[0].KeyTag != "p1:k2" {
			t.Fatalf("expected unsaturated p1:k2 first while p1:k1 saturated, got %s", ord[0].KeyTag)
		}
	}

	// 3. Least-busy strategy picks lower ActiveCount candidate regardless of slice order
	lbRoute := &types.AgentModelRoute{
		Enabled:         true,
		RoutingStrategy: "least_busy",
		Candidates: []*types.RouteCandidate{
			{Provider: "p1", KeyLabel: "k1", Enabled: true},
			{Provider: "p1", KeyLabel: "k2", Enabled: true},
		},
	}
	// Hold 2 active slots on k2; k1 is 0 -> wait, hold 2 on k1 too vs 0 on k3
	lbRoute.Candidates = append(lbRoute.Candidates, &types.RouteCandidate{Provider: "p1", KeyLabel: "k3", Enabled: true})
	relK2 := sched.Lanes().Acquire("p1:k2", 0)
	defer relK2()
	ordLB := sched.OrderCandidates(lbRoute, providers, "reranker")
	if ordLB[0].KeyTag != "p1:k3" {
		t.Errorf("expected idle p1:k3 selected by least_busy, got %s", ordLB[0].KeyTag)
	}

	// 4. Fast EWMA latency strategy: samples unmeasured first, then prefers lowest EWMA latency
	fastRoute := &types.AgentModelRoute{
		Enabled:         true,
		RoutingStrategy: "fast",
		Candidates: []*types.RouteCandidate{
			{Provider: "p1", KeyLabel: "k1", Enabled: true},
			{Provider: "p1", KeyLabel: "k2", Enabled: true},
			{Provider: "p1", KeyLabel: "k3", Enabled: true},
		},
	}
	sched.Latency().Record("p1:k1", 420)
	sched.Latency().Record("p1:k2", 85)
	sched.Latency().Record("p1:k3", 210)
	ordFast := sched.OrderCandidates(fastRoute, providers, "fast-model")
	if ordFast[0].KeyTag != "p1:k2" || ordFast[1].KeyTag != "p1:k3" || ordFast[2].KeyTag != "p1:k1" {
		t.Errorf("fast order mismatch: got [%s, %s, %s]", ordFast[0].KeyTag, ordFast[1].KeyTag, ordFast[2].KeyTag)
	}
}

func TestResolveRoute_UnifiedAndLegacyFallback_AndNormalization(t *testing.T) {
	cfg := &types.ProxyConfig{
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled:         true,
				RoutingStrategy: "least_busy",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "bge-m3", Enabled: true, Weight: 2, MaxConc: 4},
					{Provider: "p1", KeyLabel: "k2", TargetModel: "text-emb-3", Enabled: true, Weight: 1, MaxConc: 4},
				},
			},
			"chat": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				NoReasoning:     true,
				ForceNonStream:  true,
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "qwen-fast", Enabled: true},
				},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {
				{Provider: "p1", KeyLabel: "k1", Model: "gpt-4o", Enabled: true, MaxConc: 4},
			},
		},
	}

	// Filter exact embedding model inside unified "embedding" slot
	embFiltered, ok := ResolveRoute(cfg, "embedding", "bge-m3")
	if !ok || len(embFiltered.Candidates) != 1 || embFiltered.Candidates[0].TargetModel != "bge-m3" {
		t.Fatalf("expected bge-m3 filtered from unified embedding slot, got ok=%v, route=%+v", ok, embFiltered)
	}

	// Legacy KBModels["ocr"] still synthesizes a round_robin route
	ocrRoute, ok := ResolveRoute(cfg, "ocr", "ocr")
	if !ok || ocrRoute.RoutingStrategy != "round_robin" || len(ocrRoute.Candidates) != 1 || ocrRoute.Candidates[0].MaxConc != 4 {
		t.Fatalf("expected synthesized legacy ocr route, got ok=%v, route=%+v", ok, ocrRoute)
	}

	// Dispatch "chat" with NoReasoning + ForceNonStream: strips thinking fields & forces stream=false
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer ts.Close()

	cfg.Providers = map[string]*types.ProviderConfig{
		"p1": {
			ID:      "p1",
			BaseURL: ts.URL,
			Enabled: true,
			APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-1", Enabled: true}},
		},
	}
	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	reqBody := []byte(`{"model":"chat","stream":true,"reasoning_effort":"high","thinking":{"type":"enabled"},"messages":[{"role":"user","content":"hi"}]}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	if err := sched.Dispatch(context.Background(), "/v1/chat/completions", reqBody, "chat", true, rec, req); err != nil {
		t.Fatalf("Dispatch chat failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}
	if gotBody["stream"] != false {
		t.Errorf("expected stream coerced to false, got %v", gotBody["stream"])
	}
	if _, has := gotBody["reasoning_effort"]; has {
		t.Errorf("expected reasoning_effort stripped")
	}
	if _, has := gotBody["thinking"]; has {
		t.Errorf("expected thinking stripped")
	}
}

func TestScheduler_ExecuteEndpoint_RoundRobin_And_AuthFailover(t *testing.T) {
	var hitK1, hitK2 atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "key-1") {
			hitK1.Add(1)
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"bad key 1"}`))
			return
		}
		if strings.Contains(auth, "key-2") {
			hitK2.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"embedding":[0.5,0.6]}]}`))
		}
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Settings: types.RuntimeSettings{
			CooldownAuthErrorSec: 60,
		},
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "", TargetModel: "text-emb", Enabled: true}, // expands all keys!
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", nil)
	err := sched.ExecuteEndpoint(context.Background(), EndpointRequestSpec{
		Endpoint:      "/v1/embeddings",
		Category:      "embedding",
		ReqModel:      "embedding",
		TraceMode:     "kb",
		ForceStrategy: "round_robin",
		RawBody:       []byte(`{"model":"embedding","input":"hello"}`),
	}, rec, req)
	if err != nil {
		t.Fatalf("ExecuteEndpoint failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK after 401 failover, got %d: %s", rec.Code, rec.Body.String())
	}
	if hitK1.Load() != 1 || hitK2.Load() != 1 {
		t.Errorf("expected k1 tried once and failed over to k2, got k1=%d, k2=%d", hitK1.Load(), hitK2.Load())
	}
	if !sched.Cooldowns().IsCooledDown("p1", "text-emb", "k1") {
		t.Errorf("expected k1 cooled down after 401")
	}
	if trail := rec.Header().Get("X-Fallback-Trail"); !strings.Contains(trail, "p1:k1=401") || !strings.Contains(trail, "p1:k2=200") {
		t.Errorf("unexpected X-Fallback-Trail: %q", trail)
	}
}
