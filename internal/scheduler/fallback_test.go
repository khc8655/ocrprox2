package scheduler

import (
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

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
