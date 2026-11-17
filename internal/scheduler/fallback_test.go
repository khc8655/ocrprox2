package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestHideClientName_UserAgentPassthroughAndMasking(t *testing.T) {
	var seenUAs []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenUAs = append(seenUAs, r.Header.Get("User-Agent"))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"chatcmpl-ua","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	defer upstream.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p-pass": {
				ID:             "p-pass",
				BaseURL:        upstream.URL,
				Enabled:        true,
				HideClientName: false, // default: off -> forwards client's User-Agent
				APIKeys:        []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-pass", Enabled: true}},
			},
			"p-hide": {
				ID:             "p-hide",
				BaseURL:        upstream.URL,
				Enabled:        true,
				HideClientName: true, // enabled -> hides client's User-Agent
				APIKeys:        []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-hide", Enabled: true}},
			},
			"p-custom": {
				ID:             "p-custom",
				BaseURL:        upstream.URL,
				Enabled:        true,
				HideClientName: true,
				AdapterRules:   &types.AdapterRules{ExtraHeaders: map[string]string{"User-Agent": "CustomAgent/9.0"}},
				APIKeys:        []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-custom", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"m-pass":   {Enabled: true, Candidates: []*types.RouteCandidate{{Provider: "p-pass", KeyLabel: "k1", Enabled: true}}},
			"m-hide":   {Enabled: true, Candidates: []*types.RouteCandidate{{Provider: "p-hide", KeyLabel: "k1", Enabled: true}}},
			"m-custom": {Enabled: true, Candidates: []*types.RouteCandidate{{Provider: "p-custom", KeyLabel: "k1", Enabled: true}}},
		},
	}

	s := NewScheduler(&mockConfigSource{config: cfg}, nil, true)
	reqBody := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)

	for _, tc := range []struct {
		model     string
		inboundUA string
		wantUA    string
	}{
		{"m-pass", "claude-cli/2.1.0", "claude-cli/2.1.0"},
		{"m-pass", "", proxyDefaultUA},
		{"m-hide", "claude-cli/2.1.0", proxyDefaultUA},
		{"m-custom", "claude-cli/2.1.0", "CustomAgent/9.0"},
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		if tc.inboundUA != "" {
			req.Header.Set("User-Agent", tc.inboundUA)
		}
		rec := httptest.NewRecorder()
		if err := s.Dispatch(context.Background(), "/v1/chat/completions", reqBody, tc.model, false, rec, req); err != nil {
			t.Fatalf("dispatch %s failed: %v", tc.model, err)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("dispatch %s status=%d body=%s", tc.model, rec.Code, rec.Body.String())
		}
		gotUA := seenUAs[len(seenUAs)-1]
		if gotUA != tc.wantUA {
			t.Fatalf("model=%s inboundUA=%q: got upstream User-Agent %q, want %q", tc.model, tc.inboundUA, gotUA, tc.wantUA)
		}
	}
}

func TestOrderCandidates_AllowKeyFallback(t *testing.T) {
	providers := map[string]*types.ProviderConfig{
		"p1": {
			ID:      "p1",
			Enabled: true,
			APIKeys: []*types.KeyEntry{
				{ID: "k1", Label: "k1", Key: "sk-1", Enabled: false},
				{ID: "k2", Label: "k2", Key: "sk-2", Enabled: true},
			},
		},
	}
	route := &types.AgentModelRoute{
		Enabled:    true,
		Candidates: []*types.RouteCandidate{{Provider: "p1", KeyLabel: "k1", Enabled: true}},
	}
	s := NewScheduler(nil, nil, true)

	if got := s.OrderCandidates(route, providers, "m"); len(got) != 0 {
		t.Fatalf("fallback disabled: expected 0 candidates, got %d", len(got))
	}

	route.AllowKeyFallback = true
	got := s.OrderCandidates(route, providers, "m")
	if len(got) != 1 {
		t.Fatalf("fallback enabled: expected 1 candidate, got %d", len(got))
	}
	if got[0].KeyEntry.Label != "k2" {
		t.Fatalf("fallback enabled: expected k2, got %s", got[0].KeyEntry.Label)
	}

	// When the referenced key is usable, fallback must not add duplicate keys.
	exact := &types.AgentModelRoute{
		Enabled:          true,
		AllowKeyFallback: true,
		Candidates:       []*types.RouteCandidate{{Provider: "p1", KeyLabel: "k2", Enabled: true}},
	}
	got = s.OrderCandidates(exact, providers, "m")
	if len(got) != 1 || got[0].KeyEntry.Label != "k2" {
		t.Fatalf("exact binding must stay single, got %d", len(got))
	}
}
