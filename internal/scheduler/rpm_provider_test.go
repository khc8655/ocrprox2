package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func runEmbeddingRequest(sched *Scheduler) (*httptest.ResponseRecorder, error) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", nil)
	err := sched.ExecuteEndpoint(context.Background(), EndpointRequestSpec{
		Endpoint:      "/v1/embeddings",
		Category:      "embedding",
		ReqModel:      "embedding",
		ForceStrategy: "round_robin",
		RawBody:       []byte(`{"model":"embedding","input":"hello"}`),
	}, rec, req)
	return rec, err
}

// TestExecuteEndpoint_ProviderRPMLimitsWholeProvider proves Provider.RPMPerKey is
// the provider's OVERALL RPM ceiling: two keys with no MaxRPM of their own still
// stop at the provider's third request within the sliding window. Under the old
// fallback (RPMPerKey as the key-level limit) the third request would have been
// served by whichever key had spent only one token.
func TestExecuteEndpoint_ProviderRPMLimitsWholeProvider(t *testing.T) {
	var k1Called, k2Called atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "key-1") {
			k1Called.Add(1)
		} else if strings.Contains(auth, "key-2") {
			k2Called.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1]}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:        "p1",
				BaseURL:   ts.URL,
				Enabled:   true,
				RPMPerKey: 2, // whole-provider ceiling across BOTH keys, 0 = unlimited
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true}, // MaxRPM unset: unlimited per key
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "text-emb", Enabled: true},
					{Provider: "p1", KeyLabel: "k2", TargetModel: "text-emb", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	// 1st and 2nd requests go through; together they fill the provider window.
	for i := 1; i <= 2; i++ {
		rec, err := runEmbeddingRequest(sched)
		if err != nil {
			t.Fatalf("request %d should succeed: %v", i, err)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d: %s", i, rec.Code, rec.Body.String())
		}
	}
	if total := k1Called.Load() + k2Called.Load(); total != 2 {
		t.Fatalf("expected exactly 2 upstream calls after 2 requests, got k1=%d k2=%d", k1Called.Load(), k2Called.Load())
	}

	// 3rd request: neither key has its own limit, so only the provider window can
	// reject it — and both candidates of the provider must be skipped.
	rec, err := runEmbeddingRequest(sched)
	if err == nil {
		t.Fatalf("3rd request should be rejected by the provider-level RPM limit")
	}
	if k1Called.Load()+k2Called.Load() != 2 {
		t.Errorf("3rd request must not reach upstream, got k1=%d k2=%d", k1Called.Load(), k2Called.Load())
	}
	if !strings.Contains(rec.Body.String(), "provider RPM limit") {
		t.Errorf("expected a \"provider RPM limit\" skip in the response, got: %s", rec.Body.String())
	}
}

// TestExecuteEndpoint_KeyMaxRPMAppliesWithinProviderBudget proves the per-key
// MaxRPM keeps its original meaning and still blocks on its own: the provider
// window has room, but the key that burned its quota is skipped.
func TestExecuteEndpoint_KeyMaxRPMAppliesWithinProviderBudget(t *testing.T) {
	var k1Called atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		k1Called.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1]}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:        "p1",
				BaseURL:   ts.URL,
				Enabled:   true,
				RPMPerKey: 5, // provider has plenty of room
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true, MaxRPM: 1},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "text-emb", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	rec, err := runEmbeddingRequest(sched)
	if err != nil || rec.Code != http.StatusOK {
		t.Fatalf("1st request should succeed, got err=%v code=%d body=%s", err, rec.Code, rec.Body.String())
	}
	if k1Called.Load() != 1 {
		t.Fatalf("expected 1 upstream call after the 1st request, got %d", k1Called.Load())
	}

	// 2nd request: the provider window (limit 5) has room, but k1 hit MaxRPM=1.
	rec, err = runEmbeddingRequest(sched)
	if err == nil {
		t.Fatalf("2nd request should be rejected by the key-level RPM limit")
	}
	if k1Called.Load() != 1 {
		t.Errorf("over-quota key must be skipped before dialing upstream, calls=%d", k1Called.Load())
	}
	if !strings.Contains(rec.Body.String(), "k1 (RPM limit)") {
		t.Errorf("expected a key-level RPM skip for k1, got: %s", rec.Body.String())
	}
}

// TestExecuteEndpoint_NoRPMPerKeyUnlimited proves RPMPerKey=0 keeps the previous
// behaviour: the provider-wide window is not installed and repeated requests to
// an unlimited key all go through.
func TestExecuteEndpoint_NoRPMPerKeyUnlimited(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1]}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "text-emb", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	for i := 1; i <= 3; i++ {
		rec, err := runEmbeddingRequest(sched)
		if err != nil || rec.Code != http.StatusOK {
			t.Fatalf("request %d should succeed with no RPM configured, got err=%v code=%d body=%s", i, err, rec.Code, rec.Body.String())
		}
	}
	if calls.Load() != 3 {
		t.Errorf("expected 3 upstream calls with no RPM limits, got %d", calls.Load())
	}
}

func runChatDispatch(sched *Scheduler, body string) (*httptest.ResponseRecorder, error) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	err := sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(body), "gpt-4o", false, rec, req)
	return rec, err
}

// TestScheduler_Dispatch_ProviderRPMLimitsWholeProvider is the main chat-path
// twin of TestExecuteEndpoint_ProviderRPMLimitsWholeProvider: Provider.RPMPerKey
// is the whole-provider ceiling, so two keys with no MaxRPM of their own stop at
// the provider's third request in the window.
func TestScheduler_Dispatch_ProviderRPMLimitsWholeProvider(t *testing.T) {
	var k1Called, k2Called atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "key-1") {
			k1Called.Add(1)
		} else if strings.Contains(auth, "key-2") {
			k2Called.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:        "p1",
				BaseURL:   ts.URL,
				Enabled:   true,
				RPMPerKey: 2, // whole-provider ceiling across BOTH keys, 0 = unlimited
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
					{Provider: "p1", KeyLabel: "k2", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	// 1st and 2nd requests go through; together they fill the provider window.
	for i := 1; i <= 2; i++ {
		rec, err := runChatDispatch(sched, `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
		if err != nil {
			t.Fatalf("request %d should succeed: %v", i, err)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d: %s", i, rec.Code, rec.Body.String())
		}
	}
	if total := k1Called.Load() + k2Called.Load(); total != 2 {
		t.Fatalf("expected exactly 2 upstream calls after 2 requests, got k1=%d k2=%d", k1Called.Load(), k2Called.Load())
	}

	// 3rd request: neither key has its own limit, so only the provider window can
	// reject it — and every candidate of the provider must be skipped.
	rec, err := runChatDispatch(sched, `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	if err == nil {
		t.Fatalf("3rd request should be rejected by the provider-level RPM limit")
	}
	if k1Called.Load()+k2Called.Load() != 2 {
		t.Errorf("3rd request must not reach upstream, got k1=%d k2=%d", k1Called.Load(), k2Called.Load())
	}
	if !strings.Contains(rec.Body.String(), "provider RPM limit") {
		t.Errorf("expected a \"provider RPM limit\" skip in the response, got: %s", rec.Body.String())
	}
}

// TestScheduler_Dispatch_ProviderRPMFullBlocksBeforeOrderingClaim proves the
// provider-wide check is consistent across the Dispatch pipeline: with the
// provider window already full, the candidates are unhealthy during ordering
// (no lane slot is claimed for them) AND every candidate is skipped in the
// walk with "provider RPM limit", so nothing reaches upstream.
func TestScheduler_Dispatch_ProviderRPMFullBlocksBeforeOrderingClaim(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:        "p1",
				BaseURL:   ts.URL,
				Enabled:   true,
				RPMPerKey: 2,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true, MaxConc: 2},
					{Provider: "p1", KeyLabel: "k2", Enabled: true, MaxConc: 2},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	// Fill the provider window without dialing upstream.
	sched.ProviderRPM().Record(providerRPMKey("p1"))
	sched.ProviderRPM().Record(providerRPMKey("p1"))

	rec, err := runChatDispatch(sched, `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	if err == nil {
		t.Fatalf("request should be rejected by the provider-level RPM limit")
	}
	if calls.Load() != 0 {
		t.Errorf("no request may reach a provider whose RPM window is full, calls=%d", calls.Load())
	}
	if !strings.Contains(rec.Body.String(), "provider RPM limit") {
		t.Errorf("expected a \"provider RPM limit\" skip in the response, got: %s", rec.Body.String())
	}
}

// TestScheduler_Dispatch_NoRPMPerKeyUnlimited proves RPMPerKey=0 keeps the
// previous behaviour on the chat path: no provider-wide window is installed.
func TestScheduler_Dispatch_NoRPMPerKeyUnlimited(t *testing.T) {
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	for i := 1; i <= 3; i++ {
		rec, err := runChatDispatch(sched, `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
		if err != nil || rec.Code != http.StatusOK {
			t.Fatalf("request %d should succeed with no RPM configured, got err=%v code=%d body=%s", i, err, rec.Code, rec.Body.String())
		}
	}
	if calls.Load() != 3 {
		t.Errorf("expected 3 upstream calls with no RPM limits, got %d", calls.Load())
	}
}

// TestScheduler_Dispatch_ProviderTokenReleasedWhenKeyLimited is the rollback
// regression: with a provider ceiling of 3, k1 limited to MaxRPM=1 and k2
// unlimited, the 3rd request walks k1 first (round_robin), takes a provider
// token, is refused at the KEY level — and must hand that provider token back
// before moving to k2. Without the rollback the phantom token filled the
// provider window (3/3) and k2 was wrongly refused: statuses were
// [200,200,502] with only 2 upstream hits although the ceiling allows 3.
func TestScheduler_Dispatch_ProviderTokenReleasedWhenKeyLimited(t *testing.T) {
	var k1Called, k2Called atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "key-1") {
			k1Called.Add(1)
		} else if strings.Contains(auth, "key-2") {
			k2Called.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:        "p1",
				BaseURL:   ts.URL,
				Enabled:   true,
				RPMPerKey: 3, // provider ceiling: 3 real requests within the window
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true, MaxRPM: 1},
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true}, // unlimited per key
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "round_robin",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
					{Provider: "p1", KeyLabel: "k2", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	// r1 -> k1, r2 -> k2, r3 walks k1 first (over key quota, provider token must
	// be released) and must land on k2 as the provider's 3rd REAL request.
	for i := 1; i <= 3; i++ {
		rec, err := runChatDispatch(sched, `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
		if err != nil || rec.Code != http.StatusOK {
			t.Fatalf("request %d should succeed (ceiling 3, k2 unlimited), got err=%v code=%d body=%s", i, err, rec.Code, rec.Body.String())
		}
	}
	if k1Called.Load() != 1 {
		t.Errorf("expected exactly 1 upstream call on k1 (its MaxRPM=1), got %d", k1Called.Load())
	}
	if k2Called.Load() != 2 {
		t.Errorf("expected 2 upstream calls on k2 (r2 + r3 after k1 refused), got %d", k2Called.Load())
	}
}

// TestRPMLimiter_ProviderWindowIsOwnLimiter proves the provider-wide buckets and
// the per-key KeyTag buckets cannot collide: they live in two separate
// RPMLimiter instances, so a provider literally named "provider" with a key
// labelled like another provider's id ("provider:p1") never shares a sliding
// window with provider p1's overall ceiling.
func TestRPMLimiter_ProviderWindowIsOwnLimiter(t *testing.T) {
	s := NewScheduler(&mockConfigSource{config: &types.ProxyConfig{Providers: map[string]*types.ProviderConfig{}}}, nil, true)

	// Fill the KEY-level bucket with the colliding string "provider:p1".
	s.RPM().Record("provider:p1")
	if s.RPM().Count("provider:p1") != 1 {
		t.Fatalf("expected the key bucket to hold the recorded timestamp")
	}
	// The PROVIDER-level bucket with the same string must be unaffected.
	rel, ok := s.ProviderRPM().TryAcquireToken("provider:p1", 1)
	if !ok {
		t.Fatalf("provider-wide window must not share a bucket with the identically named key bucket")
	}
	rel()
	if s.ProviderRPM().Count("provider:p1") != 0 {
		t.Errorf("release must remove the provider-wide token it recorded")
	}
}

// TestRPMLimiter_TryAcquireTokenReleasesExactSlot covers the undo primitive
// itself: acquire up to the limit, release one, acquire again.
func TestRPMLimiter_TryAcquireTokenReleasesExactSlot(t *testing.T) {
	l := NewRPMLimiter(60 * time.Second)

	rel1, ok1 := l.TryAcquireToken("bucket", 2)
	rel2, ok2 := l.TryAcquireToken("bucket", 2)
	if !ok1 || !ok2 {
		t.Fatalf("both acquires should fit limit=2, got ok1=%v ok2=%v", ok1, ok2)
	}
	if _, ok := l.TryAcquireToken("bucket", 2); ok {
		t.Fatalf("third acquire must be refused at limit=2")
	}
	rel2()
	if l.Count("bucket") != 1 {
		t.Errorf("release must leave exactly 1 token, got %d", l.Count("bucket"))
	}
	if _, ok := l.TryAcquireToken("bucket", 2); !ok {
		t.Errorf("acquire after release must succeed again")
	}
	rel1()
	if l.Count("bucket") != 1 {
		t.Errorf("after releasing both tokens once re-acquired, exactly 1 token remains, got %d", l.Count("bucket"))
	}

	// Unlimited (limit<=0) returns a callable no-op release.
	rel, ok := l.TryAcquireToken("free", 0)
	if !ok {
		t.Fatalf("limit=0 must be unlimited")
	}
	rel()
}
