package scheduler

// The route editor stores a per-candidate thinking level; these tests pin the
// wire behaviour so the control cannot silently do nothing again.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func candWithEffort(effort string) *CandidateKey {
	return &CandidateKey{TargetModel: "m", ReasoningEffort: effort}
}

func TestApplyCandidateReasoning_EmptyEffortLeavesBodyAlone(t *testing.T) {
	body := []byte(`{"model":"m","max_tokens":64,"messages":[]}`)
	got := applyCandidateReasoning(body, candWithEffort(""), &types.ProviderConfig{ID: "p"}, nil)
	if string(got) != string(body) {
		t.Fatalf("body must pass through untouched, got %s", got)
	}
}

func TestApplyCandidateReasoning_OpenAIDialectSetsEffort(t *testing.T) {
	body := []byte(`{"model":"m","max_tokens":64,"messages":[]}`)
	prov := &types.ProviderConfig{ID: "p", APIType: "openai-completions"}
	got := applyCandidateReasoning(body, candWithEffort("high"), prov, nil)

	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	if payload["reasoning_effort"] != "high" {
		t.Fatalf("reasoning_effort = %v, want high", payload["reasoning_effort"])
	}
	// Everything else survives.
	if payload["model"] != "m" {
		t.Fatalf("model field lost: %v", payload["model"])
	}
}

func TestApplyCandidateReasoning_AnthropicDialectUsesThinkingBudget(t *testing.T) {
	body := []byte(`{"model":"m","max_tokens":64000,"messages":[]}`)
	prov := &types.ProviderConfig{ID: "p", APIType: "anthropic-messages"}
	got := applyCandidateReasoning(body, candWithEffort("high"), prov, nil)

	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	thinking, ok := payload["thinking"].(map[string]any)
	if !ok {
		t.Fatalf("thinking block missing, got %s", got)
	}
	if thinking["type"] != "enabled" {
		t.Fatalf("thinking.type = %v", thinking["type"])
	}
	if budget, _ := thinking["budget_tokens"].(float64); budget != 16384 {
		t.Fatalf("budget_tokens = %v, want 16384 for high", thinking["budget_tokens"])
	}
	if payload["reasoning_effort"] != nil {
		t.Fatalf("anthropic dialect must not send reasoning_effort, got %s", got)
	}
}

func TestApplyCandidateReasoning_AnthropicSkipsWhenMaxTokensTooSmall(t *testing.T) {
	// A 16-token response cannot host a 1024-token thinking budget; sending it
	// anyway would make the upstream 400 on every request.
	body := []byte(`{"model":"m","max_tokens":16,"messages":[]}`)
	prov := &types.ProviderConfig{ID: "p", AnthropicBaseURL: "https://a.example.com"}
	got := applyCandidateReasoning(body, candWithEffort("high"), prov, nil)
	if string(got) != string(body) {
		t.Fatalf("body must stay untouched when the budget cannot fit, got %s", got)
	}
}

func TestDispatch_PinnedEffortReachesUpstream(t *testing.T) {
	var seen map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&seen)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer upstream.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID: "p1", BaseURL: upstream.URL, APIType: "openai-completions", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-1", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"m": {Enabled: true, Candidates: []*types.RouteCandidate{{
				Provider: "p1", KeyLabel: "k1", TargetModel: "vendor-m", Enabled: true,
				ReasoningEffort: "max",
			}}},
		},
	}
	s := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	body := []byte(`{"model":"m","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	if err := s.Dispatch(context.Background(), "/v1/chat/completions", body, "m", false, rec, req); err != nil {
		t.Fatalf("Dispatch: %v (%d)", err, rec.Code)
	}
	if seen == nil {
		t.Fatal("upstream was not called")
	}
	if seen["reasoning_effort"] != "max" {
		t.Fatalf("upstream saw reasoning_effort=%v, want max", seen["reasoning_effort"])
	}
	if seen["model"] != "vendor-m" {
		t.Fatalf("upstream model = %v, want vendor-m", seen["model"])
	}
}
