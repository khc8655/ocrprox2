package adapters

import (
	"encoding/json"
	"strings"
	"testing"
)

// Upstreams that ignore stream=true return a plain completion body. The gateway must
// convert it into a valid SSE stream instead of forwarding raw JSON under a
// text/event-stream header.
func TestSynthesizeSSEFromJSON_OpenAIShape(t *testing.T) {
	body := []byte(`{"id":"chatcmpl-x","object":"chat.completion","created":1700000000,"model":"m1",
		"choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`)

	out := string(SynthesizeSSEFromJSON(body))

	if !strings.HasPrefix(out, "data: ") {
		t.Fatalf("output must start with a data: frame, got %q", out[:min(40, len(out))])
	}
	if !strings.HasSuffix(out, "data: [DONE]\n\n") {
		t.Fatalf("output must end with data: [DONE], got tail %q", out[max(0, len(out)-40):])
	}

	frames := []string{}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "data: ") {
			payload := strings.TrimPrefix(line, "data: ")
			if payload == "[DONE]" {
				continue
			}
			frames = append(frames, payload)
		}
	}
	if len(frames) != 2 {
		t.Fatalf("expected 2 data frames (delta + final), got %d", len(frames))
	}

	var delta map[string]any
	if err := json.Unmarshal([]byte(frames[0]), &delta); err != nil {
		t.Fatalf("delta frame is not JSON: %v", err)
	}
	choices, _ := delta["choices"].([]any)
	if len(choices) != 1 {
		t.Fatalf("delta frame must carry one choice")
	}
	ch := choices[0].(map[string]any)
	d, _ := ch["delta"].(map[string]any)
	if d["content"] != "hello" {
		t.Fatalf("delta content mismatch: %v", d["content"])
	}

	var final map[string]any
	if err := json.Unmarshal([]byte(frames[1]), &final); err != nil {
		t.Fatalf("final frame is not JSON: %v", err)
	}
	usage, ok := final["usage"].(map[string]any)
	if !ok {
		t.Fatalf("final frame must carry usage so streaming stats are not lost")
	}
	if usage["total_tokens"].(float64) != 7 {
		t.Fatalf("usage total mismatch: %v", usage["total_tokens"])
	}
	fchoices, _ := final["choices"].([]any)
	fch := fchoices[0].(map[string]any)
	if fch["finish_reason"] != "stop" {
		t.Fatalf("finish_reason mismatch: %v", fch["finish_reason"])
	}
}

func TestSynthesizeSSEFromJSON_ToolCallsAndEmpty(t *testing.T) {
	body := []byte(`{"id":"c","model":"m","choices":[{"message":{"role":"assistant","tool_calls":[{"id":"t1","type":"function"}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":9}}`)
	out := string(SynthesizeSSEFromJSON(body))
	if !strings.Contains(out, "tool_calls") {
		t.Fatalf("tool_calls must survive synthesis: %s", out)
	}
	if !strings.Contains(out, `"finish_reason":"tool_calls"`) {
		t.Fatalf("finish_reason must be preserved: %s", out)
	}

	// Empty body still yields a well-formed stream.
	if got := string(SynthesizeSSEFromJSON(nil)); got != "data: [DONE]\n\n" {
		t.Fatalf("empty body should yield only [DONE], got %q", got)
	}

	// Non-JSON body is forwarded as one opaque frame so the client still parses SSE.
	got := string(SynthesizeSSEFromJSON([]byte("not json")))
	if !strings.Contains(got, "data: not json") || !strings.HasSuffix(got, "data: [DONE]\n\n") {
		t.Fatalf("non-JSON body must be wrapped in a data frame: %q", got)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
