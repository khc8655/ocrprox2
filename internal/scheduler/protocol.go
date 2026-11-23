package scheduler

import (
	"fmt"
	"strings"

	"github.com/khc8655/llmproxy2/internal/types"
)

// EntryProtocol values: the two client dialects the inference dispatcher serves.
const (
	ProtoOpenAI    = "openai"
	ProtoAnthropic = "anthropic"
)

// EntryProtocol maps a client request path to the upstream dialect the caller
// must be served in. An empty result means the check does not apply.
//
// The gateway does not rewrite bodies between dialects: it picks the endpoint
// from the provider (base_url vs anthropic_base_url) and forwards the body
// untouched. So a caller on /v1/messages needs a provider that actually speaks
// Anthropic — otherwise the upstream receives an Anthropic body on an OpenAI
// path (or the reverse) and answers 400/404, which reads like a gateway bug.
func EntryProtocol(path string) string {
	p := strings.ToLower(strings.TrimSpace(path))
	if i := strings.IndexByte(p, '?'); i >= 0 {
		p = p[:i]
	}
	switch {
	case strings.HasSuffix(p, "/v1/messages"):
		return ProtoAnthropic
	case strings.HasSuffix(p, "/v1/chat/completions"), strings.HasSuffix(p, "/v1/responses"):
		return ProtoOpenAI
	}
	return ""
}

// protocolHints reports which chat dialects a provider declares, and whether it
// declared anything at all.
//
// Only an explicit declaration is enforced. A provider with no api_type, no
// protocols and no anthropic_base_url is legacy config: the gateway keeps
// forwarding for it as it always did, because there is nothing to compare
// against and a wrong 400 would break an existing setup.
//
//   - api_type "anthropic-messages" -> base_url is the Anthropic endpoint
//   - anthropic_base_url set        -> serves /v1/messages there as well
//     (the dual-endpoint vendors; independent of api_type)
//   - other chat api_types          -> OpenAI-family endpoint
//   - Protocols                     -> 1st-gen hint list, honoured either way
func protocolHints(p *types.ProviderConfig) (anthropic, openai, explicit bool) {
	if p == nil {
		return false, false, false
	}
	if strings.TrimSpace(p.AnthropicBaseURL) != "" {
		anthropic = true
		explicit = true
	}
	api := strings.ToLower(strings.TrimSpace(p.APIType))
	switch api {
	case "anthropic-messages", "anthropic", "messages":
		anthropic = true
		explicit = true
	case "openai-completions", "openai", "chat", "chat/completions", "responses", "gemini", "vertex", "vertexai":
		openai = true
		explicit = true
	}
	for _, x := range p.Protocols {
		switch strings.ToLower(strings.TrimSpace(x)) {
		case "anthropic", "messages", "anthropic-messages":
			anthropic = true
			explicit = true
		case "openai", "chat", "responses", "openai-completions", "chat/completions":
			openai = true
			explicit = true
		}
	}
	return anthropic, openai, explicit
}

// ProviderServesProtocol reports whether p can answer a client call made in
// proto. Anything undeclared counts as "unknown, let it through".
func ProviderServesProtocol(p *types.ProviderConfig, proto string) bool {
	if p == nil {
		return false
	}
	anthropic, openai, explicit := protocolHints(p)
	if !explicit {
		return true
	}
	if proto == ProtoAnthropic {
		return anthropic
	}
	return openai
}

func describeProvider(p *types.ProviderConfig) string {
	anthropic, openai, explicit := protocolHints(p)
	if !explicit {
		return "no declared dialect"
	}
	switch {
	case anthropic && openai:
		return "both dialects"
	case anthropic:
		return "anthropic only"
	case openai:
		return "openai-compatible only"
	default:
		return "no chat endpoint"
	}
}

// RouteServesProtocol reports whether at least one enabled candidate points at a
// provider that can answer proto. When none does, notes explains what each
// candidate does speak, so the 4xx can name the fix.
//
// A route with no enabled candidates returns (false, nil): that is "nothing
// configured to serve this model", which the existing 503 path already covers —
// it must not be reported as a protocol mismatch.
func RouteServesProtocol(route *types.AgentModelRoute, providers map[string]*types.ProviderConfig, proto string) (bool, []string) {
	if route == nil || proto == "" {
		return true, nil
	}
	var notes []string
	considered := 0
	for _, cand := range route.Candidates {
		if cand == nil || !cand.Enabled {
			continue
		}
		considered++
		prov := providers[cand.Provider]
		if ProviderServesProtocol(prov, proto) {
			return true, nil
		}
		desc := "unknown provider"
		if prov != nil {
			desc = describeProvider(prov)
		}
		notes = append(notes, fmt.Sprintf("%s (%s)", cand.Provider, desc))
	}
	if considered == 0 {
		return false, nil
	}
	return false, notes
}

// protocolMismatchMessage builds the 4xx body for a call whose dialect no
// candidate speaks: what is wrong, and the two ways to fix it. The remediation
// names the other entry point (the one these providers do answer) and the
// config change that would make this entry point work.
func protocolMismatchMessage(model, proto, entryPath string, notes []string) string {
	other, fix := "/v1/messages", "point it at an OpenAI-compatible base URL"
	if proto == ProtoAnthropic {
		other, fix = "/v1/chat/completions", "set an Anthropic Base URL on it when the upstream serves both dialects"
	}
	return fmt.Sprintf(
		"model %q cannot be served over %s: %s. Call %s instead, or %s.",
		model, entryPath, strings.Join(notes, ", "), other, fix,
	)
}
