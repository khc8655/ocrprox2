package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/types"
)

type mockConfigSource struct {
	config *types.ProxyConfig
}

func (m *mockConfigSource) Current(ctx context.Context, forceRefresh bool) (*types.RuntimeSnapshot, error) {
	return &types.RuntimeSnapshot{
		Config:     m.config,
		LeaseUntil: time.Now().Add(24 * time.Hour),
	}, nil
}

func (m *mockConfigSource) HealthState() (status string, state string, leaseValid bool, configVer int64) {
	return "healthy", "ready", true, 1
}

func TestScheduler_CandidateOrdering(t *testing.T) {
	providers := map[string]*types.ProviderConfig{
		"p1": {
			ID:      "p1",
			Enabled: true,
			APIKeys: []*types.KeyEntry{
				{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
				{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
			},
		},
	}

	route := &types.AgentModelRoute{
		Enabled:         true,
		RoutingStrategy: "sticky_failover",
		ActiveKey:       "p1:k2", // sticky prefers k2
		Candidates: []*types.RouteCandidate{
			{Provider: "p1", KeyLabel: "k1", Enabled: true},
			{Provider: "p1", KeyLabel: "k2", Enabled: true},
		},
	}

	sched := NewScheduler(&mockConfigSource{}, nil, true)
	ordered := sched.OrderCandidates(route, providers, "gpt-4o")

	if len(ordered) != 2 {
		t.Fatalf("expected 2 candidates, got %d", len(ordered))
	}
	if ordered[0].KeyTag != "p1:k2" {
		t.Errorf("expected active sticky key p1:k2 first, got %s", ordered[0].KeyTag)
	}
}

func TestScheduler_ForbiddenAlike(t *testing.T) {
	cm := NewCooldownManager()

	// 1st key fails with 403 "unauthorized prompt format"
	cm.ApplyCooldown("minimax", "m2", "k1", 403, 15*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)

	attempts := []TryAttempt{
		{
			Provider:     "minimax",
			KeyID:        "k1",
			Model:        "m2",
			Status:       403,
			ErrorSnippet: "Forbidden: unauthorized prompt format in system prompt",
		},
	}

	// 2nd key fails with exact same 403 error snippet
	curr := TryAttempt{
		Provider:     "minimax",
		KeyID:        "k2",
		Model:        "m2",
		Status:       403,
		ErrorSnippet: "Forbidden: unauthorized prompt format in system prompt",
	}

	alike := CheckForbiddenAlike(attempts, curr, cm)
	if !alike {
		t.Fatalf("expected forbiddenAlike to detect twin failures")
	}

	// First key cooldown should have been un-banned
	if cm.IsCooledDown("minimax", "m2", "k1") {
		t.Errorf("expected cooldown on k1 to be cleared by forbiddenAlike")
	}
}

func TestScheduler_PeekUntilPayload_CatchesBareError(t *testing.T) {
	bareErrorStream := "{\"error\": {\"message\": \"model overloaded\", \"type\": \"server_error\"}}\n"

	res, err := PeekUntilPayload(strings.NewReader(bareErrorStream), 45*time.Second, nil)
	if err == nil || !res.IsError {
		t.Fatalf("expected peek to detect bare JSON error, got err=%v, res=%+v", err, res)
	}
	if !strings.Contains(res.ErrorSnippet, "model overloaded") {
		t.Errorf("expected snippet to contain 'model overloaded', got %q", res.ErrorSnippet)
	}
}

func TestScheduler_PeekUntilPayload_CatchesEmptyDONE(t *testing.T) {
	emptyDoneStream := "data: [DONE]\n\n"

	res, err := PeekUntilPayload(strings.NewReader(emptyDoneStream), 45*time.Second, nil)
	if err != ErrEmptyStream || !res.IsError {
		t.Fatalf("expected ErrEmptyStream on immediate [DONE], got err=%v", err)
	}
}

func TestScheduler_SameProvider_Key1_429_Failover_Key2(t *testing.T) {
	var k1Called, k2Called bool

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "key-1") {
			k1Called = true
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error": "rate limit exceeded for key 1"}`))
			return
		}
		if strings.Contains(auth, "key-2") {
			k2Called = true
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"id":"chatcmpl-k2","choices":[{"index":0,"message":{"role":"assistant","content":"success from k2"}}]}`))
			return
		}
		w.WriteHeader(http.StatusBadRequest)
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

	obsMgr, _ := obs.NewManager(types.RoleLite, "")
	sched := NewScheduler(&mockConfigSource{config: cfg}, obsMgr, true)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`))

	err := sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`), "gpt-4o", false, rec, req)
	if err != nil {
		t.Fatalf("Dispatch error: %v", err)
	}

	if !k1Called {
		t.Errorf("expected k1 to be attempted first")
	}
	if !k2Called {
		t.Errorf("expected failover to k2 of same provider, but k2 was not called")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 OK after k2 failover, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "success from k2") {
		t.Errorf("expected response from k2, got %s", rec.Body.String())
	}

	// Verify cooldown status: k1 should be cooled down, k2 must be available!
	if !sched.Cooldowns().IsCooledDown("p1", "gpt-4o", "k1") {
		t.Errorf("expected k1 to be cooled down after 429")
	}
	if sched.Cooldowns().IsCooledDown("p1", "gpt-4o", "k2") {
		t.Errorf("expected k2 to NOT be cooled down, but it was marked cooled down!")
	}
}

func TestScheduler_SameProvider_ForbiddenAlike_BothKeysUncooled(t *testing.T) {
	var k1Called, k2Called bool

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "key-1") {
			k1Called = true
		} else if strings.Contains(auth, "key-2") {
			k2Called = true
		}
		// Both keys return identical 400 Bad Request
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error": {"message": "invalid parameter: temperature out of range", "type": "invalid_request_error"}}`))
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

	obsMgr, _ := obs.NewManager(types.RoleLite, "")
	sched := NewScheduler(&mockConfigSource{config: cfg}, obsMgr, true)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"bad"}]}`))

	err := sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"bad"}]}`), "gpt-4o", false, rec, req)
	if err != nil {
		t.Fatalf("unexpected dispatch error: %v", err)
	}

	if !k1Called || !k2Called {
		t.Fatalf("expected both k1 and k2 to be called to trigger forbiddenAlike, got k1=%v, k2=%v", k1Called, k2Called)
	}

	// Client should get the 400 Bad Request directly
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected client to receive 400 Bad Request, got %d", rec.Code)
	}

	// Both keys MUST be uncooled and ready for subsequent requests
	if sched.Cooldowns().IsCooledDown("p1", "gpt-4o", "k1") {
		t.Errorf("forbiddenAlike failed: k1 is still cooled down!")
	}
	if sched.Cooldowns().IsCooledDown("p1", "gpt-4o", "k2") {
		t.Errorf("forbiddenAlike failed: k2 is still cooled down!")
	}
}

type mockOAuthRefresher struct {
	calledWithKey string
	refreshFunc   func(ctx context.Context, keyEntry *types.KeyEntry, endpoint string) error
}

func (m *mockOAuthRefresher) EnsureValidToken(ctx context.Context, keyEntry *types.KeyEntry, endpoint string) error {
	m.calledWithKey = keyEntry.Key
	if m.refreshFunc != nil {
		return m.refreshFunc(ctx, keyEntry, endpoint)
	}
	keyEntry.Key = "refreshed-oauth-token-123"
	return nil
}

func TestScheduler_OAuthRefresher(t *testing.T) {
	var receivedAuthHeader string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuthHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"chatcmpl-oauth","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"oauth-prov": {
				ID:      "oauth-prov",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:       "k-oauth",
						Label:    "k-oauth",
						Key:      "expired-old-token",
						Enabled:  true,
						AuthType: "oauth_device",
					},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "oauth-prov", KeyLabel: "k-oauth", Enabled: true},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	refresher := &mockOAuthRefresher{}
	sched.SetOAuthRefresher(refresher)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`))

	err := sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`), "gpt-4o", false, rec, req)
	if err != nil {
		t.Fatalf("Dispatch error: %v", err)
	}

	if refresher.calledWithKey != "expired-old-token" {
		t.Errorf("expected refresher to be called with old key, got %q", refresher.calledWithKey)
	}
	if receivedAuthHeader != "Bearer refreshed-oauth-token-123" {
		t.Errorf("expected upstream to receive refreshed token, got %q", receivedAuthHeader)
	}
}

type mockConfigSourceWithTrigger struct {
	config        *types.ProxyConfig
	triggerCalled bool
}

func (m *mockConfigSourceWithTrigger) Current(ctx context.Context, forceRefresh bool) (*types.RuntimeSnapshot, error) {
	return &types.RuntimeSnapshot{
		Config:     m.config,
		LeaseUntil: time.Now().Add(24 * time.Hour),
	}, nil
}

func (m *mockConfigSourceWithTrigger) HealthState() (status string, state string, leaseValid bool, configVer int64) {
	return "healthy", "ready", true, 1
}

func (m *mockConfigSourceWithTrigger) TriggerAllKeysFailed(ctx context.Context) {
	m.triggerCalled = true
}

func TestScheduler_TriggerAllKeysFailed(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error": {"message": "invalid api key", "type": "auth_error"}}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "bad-key-1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "bad-key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
					{Provider: "p1", KeyLabel: "k2", Enabled: true},
				},
			},
		},
	}

	src := &mockConfigSourceWithTrigger{config: cfg}
	sched := NewScheduler(src, nil, true)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`))

	err := sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`), "gpt-4o", false, rec, req)
	if err == nil {
		t.Fatalf("expected dispatch error when all keys fail")
	}

	if !src.triggerCalled {
		t.Errorf("expected TriggerAllKeysFailed to be called when all keys fail with 401")
	}
}

func TestCooldownManager_Snapshot(t *testing.T) {
	cm := NewCooldownManager()

	// 1. Temporary cooldown for rate limit (key & model)
	cm.ApplyCooldown("minimax", "m2", "k1", 429, 60*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)

	// 2. Permanent cooldown (410 Gone)
	cm.ApplyCooldown("openai", "gpt-4", "k-gone", 410, 60*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)

	snap := cm.Snapshot()
	if snap["ok"] != true {
		t.Errorf("expected ok=true in snapshot")
	}

	total, ok := snap["total"].(int)
	if !ok || total != 2 {
		t.Fatalf("expected total=2, got %v", snap["total"])
	}

	cooldowns, ok := snap["cooldowns"].([]CooldownEntry)
	if !ok {
		t.Fatalf("expected []CooldownEntry, got %T", snap["cooldowns"])
	}
	if len(cooldowns) != 2 {
		t.Fatalf("expected 2 cooldown entries, got %d", len(cooldowns))
	}

	keys, ok := snap["keys"].([]CooldownEntry)
	if !ok || len(keys) != 2 {
		t.Errorf("expected 2 keys in snapshot keys list, got %v", snap["keys"])
	}

	var hasPermanent, hasRateLimit bool
	for _, c := range cooldowns {
		if c.Permanent && c.RemainingSec == -1 {
			hasPermanent = true
		}
		if !c.Permanent && c.RemainingSec > 0 {
			hasRateLimit = true
		}
	}
	if !hasPermanent {
		t.Errorf("expected snapshot to include permanent cooldown entry")
	}
	if !hasRateLimit {
		t.Errorf("expected snapshot to include temporary rate limit entry")
	}
}
