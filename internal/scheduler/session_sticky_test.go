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

	cache.Set("m1", "s1", "p1:k1")
	cache.Set("m1", "s2", "p1:k2")

	// Touch s1 so s2 becomes LRU
	if got, ok := cache.Get("m1", "s1"); !ok || got != "p1:k1" {
		t.Fatalf("expected s1->p1:k1, got %q, %v", got, ok)
	}

	// Inserting s3 evicts s2 (LRU)
	cache.Set("m1", "s3", "p1:k3")
	if _, ok := cache.Get("m1", "s2"); ok {
		t.Errorf("expected s2 to be evicted as LRU")
	}
	if got, ok := cache.Get("m1", "s1"); !ok || got != "p1:k1" {
		t.Errorf("expected s1 retained, got %q, %v", got, ok)
	}

	// Advance past TTL -> s1 and s3 expire
	now = now.Add(6 * time.Minute)
	if _, ok := cache.Get("m1", "s1"); ok {
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
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
					{Provider: "p1", KeyLabel: "k2", Enabled: true},
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

	// While Session A is in-flight on k1, start Session B Turn 1 -> spreads to idle k2!
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
	sched.SessionSticky().Set("gpt-4o", "hdr:X", "p1:k1")
	sched.SessionSticky().Set("gpt-4o", "hdr:Y", "p1:k1")
	// Simulate X failing over to k2
	sched.updateStickyKey("gpt-4o", "hdr:X", &types.AgentModelRoute{Enabled: true, RoutingStrategy: "sticky_failover"}, "", &CandidateKey{KeyTag: "p1:k2"})

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
