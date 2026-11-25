package scheduler

// Per-candidate thinking level: the route editor lets the operator pin a
// candidate to a specific reasoning effort ("high", "max", …). Storing it is
// useless unless the outbound request says so, which is what this file does.
//
// Two dialects, two knobs:
//   - OpenAI family: body.reasoning_effort = <level>
//   - Anthropic:     body.thinking = {type:"enabled", budget_tokens:N}, which
//     upstream only accepts when 1024 <= N < max_tokens; when the client's
//     max_tokens leaves no room we leave the body alone rather than send a
//     request the upstream will reject.
//
// Empty candidate level means "follow the client": the body is passed through
// untouched, exactly as before this feature existed.

import (
	"encoding/json"
	"strings"

	"github.com/khc8655/llmproxy2/internal/modelcatalog"
	"github.com/khc8655/llmproxy2/internal/types"
)

const (
	// anthropicMinThinkingBudget is the smallest budget_tokens Anthropic accepts.
	anthropicMinThinkingBudget = 1024
	// anthropicThinkingHeadroom keeps budget_tokens safely below max_tokens.
	anthropicThinkingHeadroom = 1024
)

// effortBudgets maps a normalized effort level onto an Anthropic thinking budget.
// These are operator-facing defaults, not upstream constants: they follow the
// levels Anthropic documents for its own UI.
var effortBudgets = map[string]int{
	"minimal": 1024,
	"low":     2048,
	"medium":  8192,
	"high":    16384,
	"xhigh":   24576,
	"max":     32768,
}

// applyCandidateReasoning rewrites body so the attempt actually asks for the
// operator's thinking level. It returns body unchanged when the candidate pins
// no level, when the body is not a JSON object, or when the dialect cannot
// honour the request safely.
func applyCandidateReasoning(body []byte, cand *CandidateKey, provider *types.ProviderConfig, catalog *modelcatalog.Catalog) []byte {
	if cand == nil || provider == nil {
		return body
	}
	want := strings.TrimSpace(cand.ReasoningEffort)
	if want == "" {
		return body
	}
	targetModel := cand.TargetModel

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil || payload == nil {
		return body
	}

	presetID := strings.TrimSpace(provider.PresetID)
	if presetID == "" {
		presetID = provider.ID
	}

	if providerIsAnthropic(provider) {
		budget := anthropicBudgetFor(want, presetID, targetModel, catalog)
		if budget <= 0 {
			return body
		}
		// thinking.budget_tokens must stay below max_tokens.
		if maxTokens, ok := numberField(payload["max_tokens"]); ok {
			if int64(budget)+anthropicThinkingHeadroom > maxTokens {
				return body
			}
		} else {
			// No client ceiling: give the thinking budget a ceiling that fits.
			payload["max_tokens"] = budget + anthropicThinkingHeadroom
		}
		payload["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
		out, err := json.Marshal(payload)
		if err != nil {
			return body
		}
		return out
	}

	level := want
	if catalog != nil {
		if levels := catalog.Efforts(presetID, targetModel); len(levels) > 0 {
			level = modelcatalog.NearestEffort(want, levels)
		}
	}
	payload["reasoning_effort"] = level
	out, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return out
}

// providerIsAnthropic mirrors protocolHints: an explicit anthropic api_type, or
// an anthropic_base_url, means the /v1/messages dialect.
func providerIsAnthropic(p *types.ProviderConfig) bool {
	if p == nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(p.APIType)) {
	case "anthropic-messages", "anthropic", "messages":
		return true
	}
	return strings.TrimSpace(p.AnthropicBaseURL) != ""
}

// anthropicBudgetFor picks a budget that the catalog says the model accepts,
// falling back to the level's default when the catalog has nothing to say.
func anthropicBudgetFor(want, presetID, model string, catalog *modelcatalog.Catalog) int {
	def := effortBudgets[strings.ToLower(strings.TrimSpace(want))]
	if def == 0 {
		return 0
	}
	if catalog == nil {
		return def
	}
	min, max, ok := catalog.BudgetRange(presetID, model)
	if !ok {
		// The model may still expose discrete levels instead of a budget
		// (e.g. an OpenAI-shaped model behind an anthropic endpoint): skip
		// rather than send a field the upstream never documents.
		if len(catalog.Efforts(presetID, model)) > 0 {
			return 0
		}
		return def
	}
	if def < min {
		def = min
	}
	if max > 0 && def > max {
		def = max
	}
	if def < anthropicMinThinkingBudget {
		return 0
	}
	return def
}

// numberField reads a JSON number that may have arrived as float64 (always the
// case after encoding/json into any).
func numberField(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case int:
		return int64(n), true
	case int64:
		return n, true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	}
	return 0, false
}
