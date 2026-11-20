package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestExtractSessionKey_PrioritiesAndPrefixStability(t *testing.T) {
	// 1. Explicit header overrides payload
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("X-Session-Id", "sess-header-01")
	body := []byte(`{"model":"m","prompt_cache_key":"pck-1","messages":[{"role":"user","content":"hello"}]}`)
	if got := ExtractSessionKey(req, body); got != "hdr:sess-header-01" {
		t.Fatalf("expected hdr:sess-header-01, got %q", got)
	}

	// 2. Explicit prompt_cache_key overrides metadata and prefix
	if got := ExtractSessionKey(nil, body); got != "pck:pck-1" {
		t.Fatalf("expected pck:pck-1, got %q", got)
	}

	// 3. Claude Code metadata.user_id
	metaBody := []byte(`{"model":"claude","metadata":{"user_id":"user_123_session_abc"},"messages":[{"role":"user","content":"hi"}]}`)
	if got := ExtractSessionKey(nil, metaBody); got != "meta:user_123_session_abc" {
		t.Fatalf("expected meta:user_123_session_abc, got %q", got)
	}

	// 4. Multi-turn prefix fingerprint stays identical as conversation grows,
	//    while another session with identical system+tools but different user[0] gets a distinct key.
	turn1A := []byte(`{"model":"claude","system":"sys prompt","tools":[{"name":"bash"}],"messages":[{"role":"user","content":"fix bug in auth.go"}]}`)
	turn3A := []byte(`{"model":"claude","system":"sys prompt","tools":[{"name":"bash"}],"messages":[{"role":"user","content":"fix bug in auth.go"},{"role":"assistant","content":"done"},{"role":"user","content":"add tests"}]}`)
	turn1B := []byte(`{"model":"claude","system":"sys prompt","tools":[{"name":"bash"}],"messages":[{"role":"user","content":"refactor scheduler.go"}]}`)

	k1A := ExtractSessionKey(nil, turn1A)
	k3A := ExtractSessionKey(nil, turn3A)
	k1B := ExtractSessionKey(nil, turn1B)

	if !strings.HasPrefix(k1A, "pfx:") {
		t.Fatalf("expected pfx:* key, got %q", k1A)
	}
	if k1A != k3A {
		t.Errorf("multi-turn prefix key drifted: turn1=%q vs turn3=%q", k1A, k3A)
	}
	if k1A == k1B {
		t.Errorf("distinct concurrent conversations collided on prefix key %q", k1A)
	}

	// 5. OpenAI format where messages[0] is system/developer anchors on messages[0] + messages[1]
	oaiTurn1A := []byte(`{"messages":[{"role":"system","content":"be brief"},{"role":"user","content":"task A"}]}`)
	oaiTurn2A := []byte(`{"messages":[{"role":"system","content":"be brief"},{"role":"user","content":"task A"},{"role":"assistant","content":"ok"},{"role":"user","content":"next"}]}`)
	oaiTurn1B := []byte(`{"messages":[{"role":"system","content":"be brief"},{"role":"user","content":"task B"}]}`)

	if ExtractSessionKey(nil, oaiTurn1A) != ExtractSessionKey(nil, oaiTurn2A) {
		t.Errorf("OpenAI multi-turn system+user0 prefix drifted")
	}
	if ExtractSessionKey(nil, oaiTurn1A) == ExtractSessionKey(nil, oaiTurn1B) {
		t.Errorf("OpenAI distinct conversations with same system collided")
	}

	// 6. Large (>512KB) payload with metadata placed after large messages array
	padding := strings.Repeat("x", 600*1024)
	largeBody := []byte(fmt.Sprintf(`{"model":"claude","messages":[{"role":"user","content":"%s"}],"metadata":{"session_id":"tail-sess-99"}}`, padding))
	if got := ExtractSessionKey(nil, largeBody); got != "meta:tail-sess-99" {
		t.Fatalf("expected tail metadata extracted on >512KB payload, got %q", got)
	}
}

func TestSessionStickyCache_TTLAndLRU(t *testing.T) {
	now := time.Now()
	cache := NewSessionStickyCache(5*time.Minute, 2)
	cache.nowFunc = func() time.Time { return now }

	cache.Set("m1", "s1", "", "p1:k1")
	cache.Set("m1", "s2", "", "p1:k2")

	// Touch s1 so s2 becomes LRU
	if got, ok := cache.Get("m1", "s1", ""); !ok || got != "p1:k1" {
		t.Fatalf("expected s1->p1:k1, got %q, %v", got, ok)
	}

	// Inserting s3 evicts s2 (LRU)
	cache.Set("m1", "s3", "", "p1:k3")
	if _, ok := cache.Get("m1", "s2", ""); ok {
		t.Errorf("expected s2 to be evicted as LRU")
	}
	if got, ok := cache.Get("m1", "s1", ""); !ok || got != "p1:k1" {
		t.Errorf("expected s1 retained, got %q, %v", got, ok)
	}

	// Advance past TTL -> s1 and s3 expire
	now = now.Add(6 * time.Minute)
	if _, ok := cache.Get("m1", "s1", ""); ok {
		t.Errorf("expected s1 expired after TTL")
	}
}

func TestScheduler_MultiSessionStickyIsolationAndConcurrentSpread(t *testing.T) {
	inFlightK1Started := make(chan struct{}, 1)
	releaseK1 := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(releaseK1) }) })

	var mu sync.Mutex
	keyLog := map[string][]string{} // session marker from body -> list of upstream keys hit

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, _ := io.ReadAll(r.Body)
		bodyStr := string(bodyBytes)
		sessMarker := "unknown"
		if strings.Contains(bodyStr, "task-A") {
			sessMarker = "sess-A"
		} else if strings.Contains(bodyStr, "task-B") {
			sessMarker = "sess-B"
		}

		auth := r.Header.Get("Authorization")
		usedKey := "unknown"
		switch {
		case strings.Contains(auth, "key-1"):
			usedKey = "k1"
		case strings.Contains(auth, "key-2"):
			usedKey = "k2"
		}

		mu.Lock()
		turnIdx := len(keyLog[sessMarker])
		keyLog[sessMarker] = append(keyLog[sessMarker], usedKey)
		mu.Unlock()

		if sessMarker == "sess-A" && usedKey == "k1" && turnIdx == 0 {
			// Hold first turn of sess-A briefly so sess-B arrives concurrently while k1 is busy
			select {
			case inFlightK1Started <- struct{}{}:
			default:
			}
			select {
			case <-releaseK1:
			case <-time.After(3 * time.Second):
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"ok","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}]}`))
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
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true, MaxConc: 1},
					{Provider: "p1", KeyLabel: "k2", Enabled: true, MaxConc: 1},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	payloadA := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"task-A"}]}`)
	payloadB := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"task-B"}]}`)
	payloadA2 := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"task-A"},{"role":"assistant","content":"ok"},{"role":"user","content":"turn2"}]}`)
	payloadB2 := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"task-B"},{"role":"assistant","content":"ok"},{"role":"user","content":"turn2"}]}`)

	// Start Session A Turn 1 -> claims k1 and blocks until releaseK1
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		if err := sched.Dispatch(context.Background(), "/v1/chat/completions", payloadA, "gpt-4o", false, rec, req); err != nil {
			t.Errorf("sess-A turn 1 failed: %v", err)
		}
	}()

	select {
	case <-inFlightK1Started:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for sess-A turn 1 to hit upstream k1")
	}

	// While Session A occupies k1's single slot, start Session B Turn 1 -> k1 is
	// saturated, so B overflows to k2 instead of queueing behind A.
	recB1 := httptest.NewRecorder()
	reqB1 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	if err := sched.Dispatch(context.Background(), "/v1/chat/completions", payloadB, "gpt-4o", false, recB1, reqB1); err != nil {
		t.Fatalf("sess-B turn 1 failed: %v", err)
	}

	// Release Session A Turn 1
	releaseOnce.Do(func() { close(releaseK1) })
	wg.Wait()

	// Now both k1 and k2 are idle!
	// Turn 2 of Session A MUST still stick to k1; Turn 2 of Session B MUST still stick to k2!
	for _, tc := range []struct {
		name string
		body []byte
	}{
		{"sess-A", payloadA2},
		{"sess-B", payloadB2},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		if err := sched.Dispatch(context.Background(), "/v1/chat/completions", tc.body, "gpt-4o", false, rec, req); err != nil {
			t.Fatalf("%s turn 2 failed: %v", tc.name, err)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if gotA := keyLog["sess-A"]; len(gotA) != 2 || gotA[0] != "k1" || gotA[1] != "k1" {
		t.Errorf("expected sess-A to stick [k1, k1], got %v", gotA)
	}
	if gotB := keyLog["sess-B"]; len(gotB) != 2 || gotB[0] != "k2" || gotB[1] != "k2" {
		t.Errorf("expected sess-B to stick [k2, k2], got %v", gotB)
	}

	// Ensure model route.ActiveKey was NOT mutated on shared config
	if cfg.AgentModels["gpt-4o"].ActiveKey != "" {
		t.Errorf("expected config route.ActiveKey to stay unmodified, got %q", cfg.AgentModels["gpt-4o"].ActiveKey)
	}
}

func TestScheduler_GlobalRoutingStrategyFallbackAndFailoverIsolation(t *testing.T) {
	cfg := &types.ProxyConfig{
		Settings: types.RuntimeSettings{
			AgentRoutingStrategy: "round_robin",
		},
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled: true,
				// RoutingStrategy intentionally empty -> inherits global "round_robin"
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
					{Provider: "p1", KeyLabel: "k2", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	route := cfg.AgentModels["gpt-4o"]

	first := sched.OrderCandidatesForSession(route, cfg.Providers, "gpt-4o", cfg.Settings.AgentRoutingStrategy, "hdr:s1")
	second := sched.OrderCandidatesForSession(route, cfg.Providers, "gpt-4o", cfg.Settings.AgentRoutingStrategy, "hdr:s1")
	if first[0].KeyTag == second[0].KeyTag {
		t.Errorf("expected global round_robin to alternate, got %s then %s", first[0].KeyTag, second[0].KeyTag)
	}

	// Failover in Session X must NOT clobber Session Y's sticky binding
	sched.SessionSticky().Set("gpt-4o", "hdr:X", "", "p1:k1")
	sched.SessionSticky().Set("gpt-4o", "hdr:Y", "", "p1:k1")
	// Simulate X failing over to k2
	sched.updateStickyKey("gpt-4o", SessionIdentity{Key: "hdr:X"}, &types.AgentModelRoute{Enabled: true, RoutingStrategy: "sticky_failover"}, "", &CandidateKey{KeyTag: "p1:k2"})

	ordX := sched.OrderCandidatesForSession(route, cfg.Providers, "gpt-4o", "sticky_failover", "hdr:X")
	ordY := sched.OrderCandidatesForSession(route, cfg.Providers, "gpt-4o", "sticky_failover", "hdr:Y")
	if ordX[0].KeyTag != "p1:k2" {
		t.Errorf("expected Session X rebound to p1:k2, got %s", ordX[0].KeyTag)
	}
	if ordY[0].KeyTag != "p1:k1" {
		t.Errorf("expected Session Y to retain p1:k1 unaffected by Session X failover, got %s", ordY[0].KeyTag)
	}
}

func TestScheduler_ConcurrentMultiSessionRaceFree(t *testing.T) {
	var okCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		okCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":      "chatcmpl-race",
			"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "ok"}}},
		})
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
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
					{ID: "k3", Label: "k3", Key: "key-3", Enabled: true},
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
					{Provider: "p1", KeyLabel: "k3", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	var wg sync.WaitGroup
	for sIdx := 0; sIdx < 16; sIdx++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			for turn := 0; turn < 3; turn++ {
				body := []byte(fmt.Sprintf(`{"model":"gpt-4o","system":"shared sys","messages":[{"role":"user","content":"session-%d"},{"role":"user","content":"turn-%d"}]}`, idx, turn))
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
				if err := sched.Dispatch(context.Background(), "/v1/chat/completions", body, "gpt-4o", false, rec, req); err != nil {
					t.Errorf("concurrent dispatch failed: %v", err)
				}
			}
		}(sIdx)
	}
	wg.Wait()

	if okCount.Load() != 48 {
		t.Errorf("expected 48 successful requests, got %d", okCount.Load())
	}
	if n := sched.SessionSticky().Len(); n != 16 {
		t.Errorf("expected 16 isolated sticky sessions, got %d", n)
	}
}

// A subagent shares its lead's session key. Its answer must bind the subagent
// slot alone, never the lead's: rebinding the lead to whatever account a
// subagent reached throws away the cache the lead was building there.
func TestSessionSticky_SubagentDoesNotStealLeadBinding(t *testing.T) {
	cache := NewSessionStickyCache(15*time.Minute, 16)

	cache.Set("m", "meta:conv-1", "", "p1:lead")     // lead answered on p1:lead
	cache.Set("m", "meta:conv-1", "sub-7", "p1:sub") // subagent answered on another key

	if got, ok := cache.GetWithLead("m", "meta:conv-1", ""); !ok || got != "p1:lead" {
		t.Errorf("lead binding must stay p1:lead, got %q, %v", got, ok)
	}
	if got, ok := cache.GetWithLead("m", "meta:conv-1", "sub-7"); !ok || got != "p1:sub" {
		t.Errorf("subagent binding must be p1:sub, got %q, %v", got, ok)
	}
	// A different subagent of the same conversation starts where the lead is.
	if got, ok := cache.GetWithLead("m", "meta:conv-1", "sub-8"); !ok || got != "p1:lead" {
		t.Errorf("unbound subagent should inherit lead's p1:lead, got %q, %v", got, ok)
	}
}

func TestSessionSticky_SubagentFailoverIsolationViaScheduler(t *testing.T) {
	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "lead", Label: "lead", Key: "key-1", Enabled: true},
					{ID: "sub", Label: "sub", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "lead", Enabled: true},
					{Provider: "p1", KeyLabel: "sub", Enabled: true},
				},
			},
		},
	}
	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	route := cfg.AgentModels["gpt-4o"]
	const sess = "meta:shared-conv"

	sched.SessionSticky().Set("gpt-4o", sess, "", "p1:lead")

	// The subagent's request fails over to the sibling key.
	sched.updateStickyKey("gpt-4o", SessionIdentity{Key: sess, AgentID: "claude-code-1"}, route, "", &CandidateKey{KeyTag: "p1:sub"})

	leadOrd := sched.orderCandidates(route, cfg.Providers, "gpt-4o", "sticky_failover", SessionIdentity{Key: sess}, false).List
	if leadOrd[0].KeyTag != "p1:lead" {
		t.Errorf("lead conversation must stay on p1:lead, got %s", leadOrd[0].KeyTag)
	}

	subOrd := sched.orderCandidates(route, cfg.Providers, "gpt-4o", "sticky_failover", SessionIdentity{Key: sess, AgentID: "claude-code-1"}, false).List
	if subOrd[0].KeyTag != "p1:sub" {
		t.Errorf("subagent must stay on p1:sub, got %s", subOrd[0].KeyTag)
	}
}

// A sessionless model fallback is a hint, not a reservation: requests stay on it
// while it has room and only overflow when it is at its cap.
func TestSessionSticky_SessionlessRequestsFollowFallbackUntilSaturated(t *testing.T) {
	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				Enabled: true,
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
	route := cfg.AgentModels["gpt-4o"]
	sched.SessionSticky().SetModelFallback("gpt-4o", "p1:k1")

	// One of two slots used -> the fallback key still leads: leaving it would throw
	// away the cache it is building.
	rel1 := sched.Lanes().Acquire("p1:k1", 2)
	defer rel1()
	ord := sched.orderCandidates(route, cfg.Providers, "gpt-4o", "sticky_failover", SessionIdentity{}, false).List
	if ord[0].KeyTag != "p1:k1" {
		t.Fatalf("fallback key with room left should lead, got %s", ord[0].KeyTag)
	}

	// At the cap -> overflow to the sibling.
	rel2 := sched.Lanes().Acquire("p1:k1", 2)
	defer rel2()
	ord = sched.orderCandidates(route, cfg.Providers, "gpt-4o", "sticky_failover", SessionIdentity{}, false).List
	if ord[0].KeyTag != "p1:k2" {
		t.Errorf("expected sessionless request to overflow to p1:k2 at the cap, got %s", ord[0].KeyTag)
	}
}

// Without a cap nothing can fill up, so in-flight load must never push traffic off
// the leading key: every extra conversation would rebuild the same prompt cache.
func TestSessionSticky_UncappedKeyKeepsTraffic(t *testing.T) {
	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				Enabled: true,
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
	route := cfg.AgentModels["gpt-4o"]

	rel := sched.Lanes().Acquire("p1:k1", 0)
	defer rel()

	ord := sched.orderCandidates(route, cfg.Providers, "gpt-4o", "sticky_failover", SessionIdentity{}, false).List
	if ord[0].KeyTag != "p1:k1" {
		t.Errorf("uncapped leading key must keep the traffic, got %s", ord[0].KeyTag)
	}
}

// A bound session is never spread away from its key, even while that key is busy:
// moving it would throw away the cache it has there.
func TestSessionSticky_BoundSessionStaysEvenWhenBusy(t *testing.T) {
	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				Enabled: true,
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
	route := cfg.AgentModels["gpt-4o"]
	sched.SessionSticky().Set("gpt-4o", "hdr:S", "", "p1:k1")

	rel := sched.Lanes().Acquire("p1:k1", 0)
	defer rel()

	ord := sched.orderCandidates(route, cfg.Providers, "gpt-4o", "sticky_failover", SessionIdentity{Key: "hdr:S"}, false).List
	if ord[0].KeyTag != "p1:k1" {
		t.Errorf("bound session must stay on p1:k1 while busy, got %s", ord[0].KeyTag)
	}
}

// A burst of independent conversations arriving at the same instant must reach
// different keys once the leading one is at its cap. Ordering alone cannot do
// this: every request sees every key idle before any of them acquires a lane. The
// atomic claim in LaneTracker.TryAcquire covers that gap.
func TestSessionSticky_ConcurrentBurstSpreadsAcrossSaturatedKeys(t *testing.T) {
	var mu sync.Mutex
	hits := map[string]int{}
	gate := make(chan struct{})

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		used := "unknown"
		switch auth := r.Header.Get("Authorization"); {
		case strings.Contains(auth, "key-1"):
			used = "k1"
		case strings.Contains(auth, "key-2"):
			used = "k2"
		case strings.Contains(auth, "key-3"):
			used = "k3"
		}
		mu.Lock()
		hits[used]++
		mu.Unlock()
		// Hold every request until all three have arrived, so a burst that all
		// picks the same key is visible as a non-spread.
		<-gate
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ok","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}]}`))
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
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
					{ID: "k3", Label: "k3", Key: "key-3", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true, MaxConc: 1},
					{Provider: "p1", KeyLabel: "k2", Enabled: true, MaxConc: 1},
					{Provider: "p1", KeyLabel: "k3", Enabled: true, MaxConc: 1},
				},
			},
		},
	}
	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	// Independent conversations (distinct tasks), all starting together.
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			body := []byte(fmt.Sprintf(`{"model":"gpt-4o","messages":[{"role":"user","content":"task-%d"}]}`, idx))
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			if err := sched.Dispatch(context.Background(), "/v1/chat/completions", body, "gpt-4o", false, rec, req); err != nil {
				t.Errorf("dispatch failed: %v", err)
			}
		}(i)
	}
	close(start)

	// Wait until all three are held upstream, then release them.
	deadline := time.After(5 * time.Second)
	for {
		mu.Lock()
		n := hits["k1"] + hits["k2"] + hits["k3"]
		mu.Unlock()
		if n >= 3 {
			break
		}
		select {
		case <-deadline:
			close(gate)
			wg.Wait()
			t.Fatalf("timed out waiting for 3 in-flight requests, got %d", n)
		case <-time.After(5 * time.Millisecond):
		}
	}
	close(gate)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	for _, k := range []string{"k1", "k2", "k3"} {
		if hits[k] != 1 {
			t.Errorf("expected burst to spread one request per key, got k1=%d k2=%d k3=%d", hits["k1"], hits["k2"], hits["k3"])
			break
		}
	}
}

// A burst larger than the key count must stay balanced, not stack onto the first
// key once the others have one request each.
func TestSessionSticky_BurstStaysBalancedBeyondKeyCount(t *testing.T) {
	var mu sync.Mutex
	hits := map[string]int{}
	gate := make(chan struct{})

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		used := "k1"
		switch auth := r.Header.Get("Authorization"); {
		case strings.Contains(auth, "key-2"):
			used = "k2"
		case strings.Contains(auth, "key-3"):
			used = "k3"
		}
		mu.Lock()
		hits[used]++
		mu.Unlock()
		<-gate
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ok","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}]}`))
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
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
					{ID: "k3", Label: "k3", Key: "key-3", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true, MaxConc: 1},
					{Provider: "p1", KeyLabel: "k2", Enabled: true, MaxConc: 1},
					{Provider: "p1", KeyLabel: "k3", Enabled: true, MaxConc: 1},
				},
			},
		},
	}
	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	const total = 9
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < total; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			body := []byte(fmt.Sprintf(`{"model":"gpt-4o","messages":[{"role":"user","content":"task-%d"}]}`, idx))
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			if err := sched.Dispatch(context.Background(), "/v1/chat/completions", body, "gpt-4o", false, rec, req); err != nil {
				t.Errorf("dispatch failed: %v", err)
			}
		}(i)
	}
	close(start)

	deadline := time.After(5 * time.Second)
	for {
		mu.Lock()
		n := hits["k1"] + hits["k2"] + hits["k3"]
		mu.Unlock()
		if n >= total {
			break
		}
		select {
		case <-deadline:
			close(gate)
			wg.Wait()
			t.Fatalf("timed out waiting for %d in-flight requests, got %d", total, n)
		case <-time.After(5 * time.Millisecond):
		}
	}
	close(gate)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	for _, k := range []string{"k1", "k2", "k3"} {
		if hits[k] != total/3 {
			t.Errorf("expected %d requests per key, got k1=%d k2=%d k3=%d", total/3, hits["k1"], hits["k2"], hits["k3"])
			break
		}
	}
}

// The cacheable prefix is the system/instructions block plus the tool catalog —
// the part every conversation of one project shares. The task itself is not part
// of it, or every conversation would look like a different prefix.
func TestExtractCachePrefix_GroupsSharedSystemAndTools(t *testing.T) {
	base := `"model":"m","system":"you are a coding agent","tools":[{"name":"bash"}]`
	a := []byte(`{` + base + `,"messages":[{"role":"user","content":"fix bug in auth.go"}]}`)
	b := []byte(`{` + base + `,"messages":[{"role":"user","content":"refactor scheduler.go"}]}`)
	c := []byte(`{"model":"m","system":"you are a reviewer","tools":[{"name":"bash"}],"messages":[{"role":"user","content":"fix bug in auth.go"}]}`)

	pa, pb, pc := ExtractCachePrefix(a), ExtractCachePrefix(b), ExtractCachePrefix(c)
	if !strings.HasPrefix(pa, "cpy:") {
		t.Fatalf("expected cpy:* prefix, got %q", pa)
	}
	if pa != pb {
		t.Errorf("conversations sharing system+tools must share a cache prefix: %q vs %q", pa, pb)
	}
	if pa == pc {
		t.Errorf("a different system prompt must not share the prefix: %q", pa)
	}

	// A user-only conversation has nothing another conversation could cache.
	if got := ExtractCachePrefix([]byte(`{"model":"m","messages":[{"role":"user","content":"hello"}]}`)); got != "" {
		t.Errorf("expected no cache prefix without system/tools, got %q", got)
	}

	// OpenAI-style: a leading system turn is the prefix, the following user turn
	// is the task and must not enter it.
	e := []byte(`{"messages":[{"role":"system","content":"be brief"},{"role":"user","content":"task A"}]}`)
	f := []byte(`{"messages":[{"role":"system","content":"be brief"},{"role":"user","content":"task B"}]}`)
	if pe, pf := ExtractCachePrefix(e), ExtractCachePrefix(f); pe == "" || pe != pf {
		t.Errorf("OpenAI leading system message must form a shared prefix: %q vs %q", pe, pf)
	}
}

// recordingUpstream records which upstream key answered each request.
func recordingUpstream(t *testing.T) (*httptest.Server, func() map[string]int) {
	t.Helper()
	var mu sync.Mutex
	hits := map[string]int{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		label := "?"
		auth := r.Header.Get("Authorization")
		for _, l := range []string{"k1", "k2", "k3"} {
			if strings.Contains(auth, "key-"+l[1:]) {
				label = l
				break
			}
		}
		mu.Lock()
		hits[label]++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ok","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}]}`))
	}))
	t.Cleanup(ts.Close)
	snapshot := func() map[string]int {
		mu.Lock()
		defer mu.Unlock()
		out := make(map[string]int, len(hits))
		for k, v := range hits {
			out[k] = v
		}
		return out
	}
	return ts, snapshot
}

func prefixTestConfig(baseURL string, maxConc int) *types.ProxyConfig {
	cands := make([]*types.RouteCandidate, 0, 3)
	for _, label := range []string{"k1", "k2", "k3"} {
		cands = append(cands, &types.RouteCandidate{Provider: "p1", KeyLabel: label, Enabled: true, MaxConc: maxConc})
	}
	return &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: baseURL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
					{ID: "k3", Label: "k3", Key: "key-3", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates:      cands,
			},
		},
	}
}

func prefixTaskBody(task string) []byte {
	return []byte(fmt.Sprintf(`{"model":"gpt-4o","system":"you are a coding agent","tools":[{"name":"bash"},{"name":"read"}],"messages":[{"role":"user","content":"%s"}]}`, task))
}

// Agents of one project share their system prompt and tool catalog but work on
// different tasks. They must all land on one key so the second agent reads the
// prefix the first one cached instead of paying for it again.
func TestSessionSticky_SharedPrefixConversationsShareOneKey(t *testing.T) {
	ts, snapshot := recordingUpstream(t)
	cfg := prefixTestConfig(ts.URL, 0)
	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	for _, task := range []string{"fix auth.go", "refactor scheduler.go", "add tests", "write docs"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		if err := sched.Dispatch(context.Background(), "/v1/chat/completions", prefixTaskBody(task), "gpt-4o", false, rec, req); err != nil {
			t.Fatalf("dispatch %q failed: %v", task, err)
		}
	}

	hits := snapshot()
	if hits["k1"] != 4 || hits["k2"] != 0 || hits["k3"] != 0 {
		t.Errorf("same-prefix conversations must share one key, got %v", hits)
	}
}

// When that shared key reaches its cap the next conversation overflows to a
// sibling, and the conversation after it follows the prefix to the new key: the
// prefix is warm on both, so either is a cache hit.
func TestSessionSticky_SharedPrefixOverflowsAtCap(t *testing.T) {
	ts, snapshot := recordingUpstream(t)
	cfg := prefixTestConfig(ts.URL, 1)
	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	dispatch := func(task string) {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		if err := sched.Dispatch(context.Background(), "/v1/chat/completions", prefixTaskBody(task), "gpt-4o", false, rec, req); err != nil {
			t.Fatalf("dispatch %q failed: %v", task, err)
		}
	}

	dispatch("first task")
	if hits := snapshot(); hits["k1"] != 1 {
		t.Fatalf("first conversation should warm k1, got %v", hits)
	}

	// Occupy k1's only slot: the shared prefix can no longer be served there.
	rel := sched.Lanes().Acquire("p1:k1", 1)
	dispatch("second task")
	rel()

	hits := snapshot()
	if hits["k1"] != 1 || hits["k2"] != 1 {
		t.Errorf("saturated shared key must overflow to p1:k2, got %v", hits)
	}

	// The prefix is now warm on k2, so the next conversation follows it there.
	dispatch("third task")
	hits = snapshot()
	if hits["k2"] != 2 || hits["k1"] != 1 || hits["k3"] != 0 {
		t.Errorf("next same-prefix conversation should follow the warm key, got %v", hits)
	}
}

// TestSessionSticky_ConcurrentBurstFillsEveryKeyExactly enforces that one free
// slot is never handed to two simultaneous arrivals: six new conversations over
// three keys with a cap of two must land 2/2/2, never 3/2/1. This is the guard
// for the slot being taken atomically during ordering and counted once.
func TestSessionSticky_ConcurrentBurstFillsEveryKeyExactly(t *testing.T) {
	const (
		maxConc = 2
		burst   = 6
		rounds  = 20
	)
	var mu sync.Mutex
	hits := map[string]int{}
	gate := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		label := "?"
		auth := r.Header.Get("Authorization")
		for _, l := range []string{"k1", "k2", "k3"} {
			if strings.Contains(auth, "key-"+l[1:]) {
				label = l
				break
			}
		}
		mu.Lock()
		hits[label]++
		mu.Unlock()
		<-gate
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ok","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}]}`))
	}))
	defer ts.Close()

	sched := NewScheduler(&mockConfigSource{config: prefixTestConfig(ts.URL, maxConc)}, nil, true)

	for round := 0; round < rounds; round++ {
		mu.Lock()
		hits["k1"], hits["k2"], hits["k3"] = 0, 0, 0
		mu.Unlock()
		gate = make(chan struct{})

		var wg sync.WaitGroup
		for i := 0; i < burst; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
				body := fmt.Sprintf(`{"model":"gpt-4o","messages":[{"role":"user","content":"round-%d-task-%d"}]}`, round, i)
				if err := sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(body), "gpt-4o", false, rec, req); err != nil {
					t.Errorf("round %d dispatch %d: %v", round, i, err)
				}
			}(i)
		}
		for {
			mu.Lock()
			total := hits["k1"] + hits["k2"] + hits["k3"]
			mu.Unlock()
			if total == burst {
				break
			}
		}
		close(gate)
		wg.Wait()

		mu.Lock()
		got := [3]int{hits["k1"], hits["k2"], hits["k3"]}
		mu.Unlock()
		if got != [3]int{2, 2, 2} {
			t.Fatalf("round %d: burst of %d over 3 keys at cap %d landed %v, want [2 2 2]", round, burst, maxConc, got)
		}
		if l := sched.lanes.Snapshot(); len(l) != 0 {
			t.Fatalf("round %d: lane slots leaked: %v", round, l)
		}
	}
}
