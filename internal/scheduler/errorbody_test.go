package scheduler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestErrInSuccessBody(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantHit    bool
	}{
		{"anthropic error envelope", `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`, 502, true},
		{"openai error object with code", `{"error":{"message":"quota","code":429}}`, 429, true},
		{"openai error string", `{"error":"upstream overloaded"}`, 502, true},
		{"gemini top-level code", `{"code":503,"message":"overloaded"}`, 503, true},
		{"status error with message", `{"status":"error","message":"boom"}`, 502, true},
		{"successful chat completion", `{"choices":[{"message":{"content":"{\"error\":\"not an error\"}"}}]}`, 0, false},
		{"null error field", `{"error":null,"choices":[]}`, 0, false},
		{"embeddings result", `{"data":[{"embedding":[0.1,0.2]}]}`, 0, false},
		{"empty object", `{}`, 0, false},
		{"null literal", `null`, 0, false},
		{"plain text", `overloaded`, 0, false},
		{"string code is not a status", `{"code":"400","message":"bad"}`, 0, false},
		{"success code", `{"code":200,"message":"ok"}`, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, snippet, hit := errInSuccessBody([]byte(tt.body))
			if hit != tt.wantHit {
				t.Fatalf("hit = %v, want %v", hit, tt.wantHit)
			}
			if hit && status != tt.wantStatus {
				t.Errorf("status = %d, want %d", status, tt.wantStatus)
			}
			if hit && snippet == "" {
				t.Errorf("expected a non-empty error snippet")
			}
		})
	}
}

// TestExecuteEndpoint_NonStream200ErrorFailsOver proves a 200 carrying an error
// object is treated as that error: the next candidate is asked instead of the
// error body being handed to the caller as a success.
func TestExecuteEndpoint_NonStream200ErrorFailsOver(t *testing.T) {
	var hitK1, hitK2 atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "key-1") {
			hitK1.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"error":{"message":"insufficient quota","code":429}}`))
			return
		}
		hitK2.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.5,0.6]}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Settings: types.RuntimeSettings{CooldownRateLimitSec: 1},
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
					{Provider: "p1", KeyLabel: "", TargetModel: "text-emb", Enabled: true},
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
		t.Fatalf("expected 200 OK after 200-error failover, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "0.5") {
		t.Errorf("expected the healthy candidate's body, got %s", rec.Body.String())
	}
	if hitK1.Load() != 1 || hitK2.Load() != 1 {
		t.Errorf("expected k1 tried once then k2, got k1=%d k2=%d", hitK1.Load(), hitK2.Load())
	}
	trail := rec.Header().Get("X-Fallback-Trail")
	if !strings.Contains(trail, "p1:k1=429") || !strings.Contains(trail, "p1:k2=200") {
		t.Errorf("unexpected X-Fallback-Trail: %q", trail)
	}
	if !sched.Cooldowns().IsCooledDown("p1", "text-emb", "k1") {
		t.Errorf("expected the 200-with-error key to be cooled down like a real 429")
	}
}

// TestExecuteEndpoint_AppliesRouteNormalization proves the endpoint path honours
// the route's no_reasoning flag: the body handed to the upstream has no thinking
// controls left.
func TestExecuteEndpoint_AppliesRouteNormalization(t *testing.T) {
	var gotBody atomic.Value
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		gotBody.Store(m)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1]}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID: "p1", BaseURL: ts.URL, Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "key-1", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				NoReasoning:     true,
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "text-emb", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", nil)
	raw := []byte(`{"model":"embedding","input":"hello","thinking":{"type":"enabled"},"reasoning_effort":"high","stream":true}`)
	var seenByBuilder []byte
	err := sched.ExecuteEndpoint(context.Background(), EndpointRequestSpec{
		Endpoint:      "/v1/embeddings",
		Category:      "embedding",
		ReqModel:      "embedding",
		ForceStrategy: "round_robin",
		RawBody:       raw,
		BuildRequest: func(cand *CandidateKey, body []byte) (string, []byte, map[string]string, error) {
			seenByBuilder = append([]byte(nil), body...)
			return ts.URL + "/embeddings", body, nil, nil
		},
	}, rec, req)
	if err != nil {
		t.Fatalf("ExecuteEndpoint failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	for _, k := range []string{"thinking", "reasoning_effort"} {
		if _, ok := gotBody.Load().(map[string]any)[k]; ok {
			t.Errorf("upstream body still carries %q", k)
		}
	}
	if strings.Contains(string(seenByBuilder), "thinking") {
		t.Errorf("BuildRequest saw an unnormalized body: %s", seenByBuilder)
	}
}

// TestExecuteEndpoint_MaxConcurrencySkipsFullLane proves max_concurrency is
// enforced on the endpoint path: a full lane is passed over for a sibling with
// room instead of silently accepting the request.
func TestExecuteEndpoint_MaxConcurrencySkipsFullLane(t *testing.T) {
	var hitK1, hitK2 atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Authorization"), "key-1") {
			hitK1.Add(1)
		} else {
			hitK2.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1]}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID: "p1", BaseURL: ts.URL, Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled: true,
				// manual keeps the configured order, so k1 is tried first and its full
				// lane has to be the reason the request ends up on k2.
				RoutingStrategy: "manual",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "text-emb", Enabled: true, MaxConc: 1},
					{Provider: "p1", KeyLabel: "k2", TargetModel: "text-emb", Enabled: true, MaxConc: 1},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	// Occupy k1's only slot.
	rel, ok := sched.Lanes().TryAcquireOne("p1:k1", 1)
	if !ok {
		t.Fatal("expected to occupy k1's lane")
	}
	defer rel()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", nil)
	err := sched.ExecuteEndpoint(context.Background(), EndpointRequestSpec{
		Endpoint:      "/v1/embeddings",
		Category:      "embedding",
		ReqModel:      "embedding",
		ForceStrategy: "manual",
		RawBody:       []byte(`{"model":"embedding","input":"hello"}`),
	}, rec, req)
	if err != nil {
		t.Fatalf("ExecuteEndpoint failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from the free sibling, got %d: %s", rec.Code, rec.Body.String())
	}
	if hitK1.Load() != 0 || hitK2.Load() != 1 {
		t.Errorf("expected the request on k2 only, got k1=%d k2=%d", hitK1.Load(), hitK2.Load())
	}
}

func TestLaneTracker_WaitAcquireBlocksAndWakes(t *testing.T) {
	lt := NewLaneTracker()
	hold, ok := lt.TryAcquireOne("p1:k1", 1)
	if !ok {
		t.Fatal("expected first acquire to succeed")
	}

	done := make(chan bool, 1)
	go func() {
		rel, got := lt.WaitAcquire(context.Background(), "p1:k1", 1, 2*time.Second)
		if got {
			rel()
		}
		done <- got
	}()

	select {
	case <-done:
		t.Fatal("WaitAcquire returned while the lane was full")
	case <-time.After(80 * time.Millisecond):
	}
	hold()
	select {
	case got := <-done:
		if !got {
			t.Fatal("expected WaitAcquire to succeed after the slot was released")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("WaitAcquire did not wake after release")
	}
}

func TestLaneTracker_WaitAcquireHonoursContext(t *testing.T) {
	lt := NewLaneTracker()
	hold, _ := lt.TryAcquireOne("p1:k1", 1)
	defer hold()

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, ok := lt.WaitAcquire(ctx, "p1:k1", 1, time.Second); ok {
		t.Fatal("expected WaitAcquire to give up when ctx ended")
	}
	if elapsed := time.Since(start); elapsed > 800*time.Millisecond {
		t.Fatalf("WaitAcquire waited past ctx: %v", elapsed)
	}
}

func TestLaneTracker_TryAcquireFirstDoesNotStealFullLane(t *testing.T) {
	lt := NewLaneTracker()
	hold, _ := lt.TryAcquireOne("p1:k1", 1)
	defer hold()
	choices := []LaneChoice{{Tag: "p1:k1", Cap: 1}, {Tag: "p1:k2", Cap: 1}}
	if tag, rel, ok := lt.TryAcquireFirst(choices); !ok || tag != "p1:k2" {
		t.Fatalf("expected p1:k2, got %q ok=%v", tag, ok)
	} else {
		rel()
	}
	// With every lane full, TryAcquireFirst must report failure rather than
	// piling a second request onto a lane at its cap.
	hold2, _ := lt.TryAcquireOne("p1:k2", 1)
	defer hold2()
	if tag, _, ok := lt.TryAcquireFirst(choices); ok {
		t.Fatalf("expected no admission while all lanes are full, got %q", tag)
	}
}
