package adapters

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestStreamOnlyAggregation(t *testing.T) {
	streamChunks := "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"deepseek-ai/DeepSeek-V2.5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"}}]}\n\n" +
		"data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"deepseek-ai/DeepSeek-V2.5\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world!\"}}]}\n\n" +
		"data: [DONE]\n\n"

	resBytes, err := AggregateStreamToJSON(strings.NewReader(streamChunks))
	if err != nil {
		t.Fatalf("AggregateStreamToJSON error: %v", err)
	}

	var res map[string]any
	if err := json.Unmarshal(resBytes, &res); err != nil {
		t.Fatal(err)
	}

	choices := res["choices"].([]any)
	ch := choices[0].(map[string]any)
	msg := ch["message"].(map[string]any)

	if msg["content"] != "Hello world!" {
		t.Errorf("expected 'Hello world!', got %q", msg["content"])
	}
}

func TestRescueFromText(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			RescueFromText: true,
		},
	}

	resp := "{\n" +
		"  \"id\": \"cmpl-rescue-1\",\n" +
		"  \"choices\": [\n" +
		"    {\n" +
		"      \"index\": 0,\n" +
		"      \"message\": {\n" +
		"        \"role\": \"assistant\",\n" +
		"        \"content\": \"I will check the weather for you.\\n```json\\n{\\n  \\\"name\\\": \\\"get_current_weather\\\",\\n  \\\"arguments\\\": {\\\"location\\\": \\\"Tokyo\\\", \\\"unit\\\": \\\"celsius\\\"}\\n}\\n```\"\n" +
		"      },\n" +
		"      \"finish_reason\": \"stop\"\n" +
		"    }\n" +
		"  ]\n" +
		"}"

	outBytes, err := engine.TransformNonStreamResponse("/v1/chat/completions", []byte(resp), prov, "test-model")
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(outBytes, &out); err != nil {
		t.Fatal(err)
	}

	choices := out["choices"].([]any)
	ch := choices[0].(map[string]any)
	if ch["finish_reason"] != "tool_calls" {
		t.Errorf("expected finish_reason 'tool_calls', got %v", ch["finish_reason"])
	}

	msg := ch["message"].(map[string]any)
	toolCalls, ok := msg["tool_calls"].([]any)
	if !ok || len(toolCalls) == 0 {
		t.Fatalf("expected rescued tool_calls, got none")
	}

	tc := toolCalls[0].(map[string]any)
	fn := tc["function"].(map[string]any)
	if fn["name"] != "get_current_weather" {
		t.Errorf("expected name 'get_current_weather', got %v", fn["name"])
	}
}

func TestUnwrapRoot(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			UnwrapRoot: "data",
		},
	}

	raw := `{
		"code": 0,
		"msg": "success",
		"data": {
			"id": "sn-chat-1",
			"choices": [
				{
					"index": 0,
					"message": {"role": "assistant", "content": "SenseNova answer"}
				}
			]
		}
	}`

	outBytes, err := engine.TransformNonStreamResponse("/v1/chat/completions", []byte(raw), prov, "model")
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(outBytes, &out); err != nil {
		t.Fatal(err)
	}

	if out["id"] != "sn-chat-1" {
		t.Errorf("expected id 'sn-chat-1', got %v", out["id"])
	}
}

func TestAMDStripReasoning(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			StripReasoningEnabled: true,
		},
	}

	req := `{
		"model": "deepseek-r1",
		"messages": [{"role": "user", "content": "calculate 2+2"}],
		"reasoning": {"enabled": true},
		"reasoning_effort": "high"
	}`

	mutated, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(mutated, &out); err != nil {
		t.Fatal(err)
	}

	if _, ok := out["reasoning"]; ok {
		t.Errorf("expected reasoning to be stripped")
	}
	if _, ok := out["reasoning_effort"]; ok {
		t.Errorf("expected reasoning_effort to be stripped")
	}
}

func TestGeminiThinkingCompat(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			GeminiCompat: true,
		},
	}

	// 2.5 Pro
	req25 := `{
		"model": "gemini-2.5-pro",
		"messages": [{"role": "user", "content": "hello"}],
		"reasoning_effort": "high"
	}`
	mut25, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req25), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}
	var out25 map[string]any
	json.Unmarshal(mut25, &out25)
	if out25["thinking_budget"] != float64(24576) {
		t.Errorf("expected thinking_budget 24576, got %v", out25["thinking_budget"])
	}

	// 3.0 Pro
	req3x := `{
		"model": "gemini-3.0-pro",
		"messages": [{"role": "user", "content": "hello"}],
		"reasoning_effort": "high"
	}`
	mut3x, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req3x), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}
	var out3x map[string]any
	json.Unmarshal(mut3x, &out3x)
	if out3x["thinking_level"] != "HIGH" {
		t.Errorf("expected thinking_level HIGH, got %v", out3x["thinking_level"])
	}
}

func TestThoughtStreamSplitter(t *testing.T) {
	splitter := &ThoughtStreamSplitter{}
	chunk := "<thought>Analyzing the logic...</thought>The result is 42."
	r, c := splitter.Feed(chunk)

	if r != "Analyzing the logic..." {
		t.Errorf("expected 'Analyzing the logic...', got %q", r)
	}
	if c != "The result is 42." {
		t.Errorf("expected 'The result is 42.', got %q", c)
	}
}

func TestGeminiSchemaClean(t *testing.T) {
	schemaJSON := `{
		"$schema": "http://json-schema.org/draft-07/schema#",
		"title": "SearchQuery",
		"type": "object",
		"properties": {
			"query": {
				"type": "string",
				"title": "QueryString",
				"default": "default query"
			}
		},
		"required": ["query"]
	}`

	var schema map[string]any
	json.Unmarshal([]byte(schemaJSON), &schema)

	cleaned := SanitizeGeminiSchema(schema).(map[string]any)

	if _, ok := cleaned["$schema"]; ok {
		t.Errorf("$schema not removed")
	}
	if _, ok := cleaned["title"]; ok {
		t.Errorf("title not removed")
	}

	props := cleaned["properties"].(map[string]any)
	queryProp := props["query"].(map[string]any)
	if _, ok := queryProp["default"]; ok {
		t.Errorf("default not removed")
	}
}

func TestPrepareRequest_LargePayload_FastPath(t *testing.T) {
	engine := NewDefaultEngine()

	// Construct an 8MB payload
	padding := strings.Repeat("A", 8*1024*1024)
	largeJSON := fmt.Sprintf(`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":%q}]}`, padding)
	largeBytes := []byte(largeJSON)

	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			ExtraHeaders: map[string]string{
				"X-Custom-Header": "value",
			},
		},
	}

	// 1. Same model: should return original slice without allocation/mutation
	mutated, headers, isStream, err := engine.PrepareRequest("/v1/chat/completions", largeBytes, prov, "gpt-4o", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !isStream {
		t.Errorf("expected stream=true")
	}
	if headers["X-Custom-Header"] != "value" {
		t.Errorf("expected extra header, got %v", headers)
	}
	if len(mutated) != len(largeBytes) {
		t.Errorf("expected len %d, got %d", len(largeBytes), len(mutated))
	}
	// Verify zero-copy: pointing to same underlying slice
	if &mutated[0] != &largeBytes[0] {
		t.Errorf("expected zero-copy slice reuse for unchanged model")
	}

	// 2. Target model override: should replace model string cleanly
	mutated2, _, _, err := engine.PrepareRequest("/v1/chat/completions", largeBytes, prov, "gpt-4o-mini", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(string(mutated2[:100]), `"model":"gpt-4o-mini"`) {
		t.Errorf("expected mutated model to be gpt-4o-mini, got %s", string(mutated2[:100]))
	}

	// 3. StreamOnly rule: should enforce stream=true
	provStreamOnly := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			StreamOnly: true,
		},
	}
	largeNonStreamJSON := fmt.Sprintf(`{"model":"gpt-4o","stream":false,"messages":[{"role":"user","content":%q}]}`, padding)
	mutated3, _, isStream3, err := engine.PrepareRequest("/v1/chat/completions", []byte(largeNonStreamJSON), provStreamOnly, "", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !isStream3 {
		t.Errorf("expected stream=true for StreamOnly provider")
	}
	if !strings.Contains(string(mutated3[:100]), `"stream":true`) {
		t.Errorf("expected body to have stream:true, got %s", string(mutated3[:100]))
	}
}
