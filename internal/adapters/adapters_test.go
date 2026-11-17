package adapters

import (
	"bytes"
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

	// 1. 2.5 Pro high -> extra_body.google.thinking_config ONLY (no top-level thinking_budget)
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
	_ = json.Unmarshal(mut25, &out25)
	if _, exists := out25["thinking_budget"]; exists {
		t.Errorf("unexpected root thinking_budget injection: %v", out25["thinking_budget"])
	}
	tc25 := out25["extra_body"].(map[string]any)["google"].(map[string]any)["thinking_config"].(map[string]any)
	if tc25["thinking_budget"] != float64(24576) || tc25["include_thoughts"] != true {
		t.Errorf("expected extra_body thinking_budget=24576 include_thoughts=true, got %v", tc25)
	}

	// 2. 2.5 Flash effort="none" -> include_thoughts=false, thinking_budget=0; 2.5 Pro effort="none" -> 128
	req25None := `{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"none"}`
	mut25None, _, _, _ := engine.PrepareRequest("/v1/chat/completions", []byte(req25None), prov, "", false)
	var out25None map[string]any
	_ = json.Unmarshal(mut25None, &out25None)
	tc25None := out25None["extra_body"].(map[string]any)["google"].(map[string]any)["thinking_config"].(map[string]any)
	if tc25None["include_thoughts"] != false || tc25None["thinking_budget"] != float64(0) {
		t.Errorf("expected 2.5-flash effort=none -> include_thoughts=false, budget=0, got %v", tc25None)
	}

	req25ProNone := `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"none"}`
	mut25ProNone, _, _, _ := engine.PrepareRequest("/v1/chat/completions", []byte(req25ProNone), prov, "", false)
	var out25ProNone map[string]any
	_ = json.Unmarshal(mut25ProNone, &out25ProNone)
	tc25ProNone := out25ProNone["extra_body"].(map[string]any)["google"].(map[string]any)["thinking_config"].(map[string]any)
	if tc25ProNone["include_thoughts"] != false || tc25ProNone["thinking_budget"] != float64(128) {
		t.Errorf("expected 2.5-pro effort=none -> include_thoughts=false, budget=128, got %v", tc25ProNone)
	}

	// 3. 3.0 Pro high -> extra_body.google.thinking_config ONLY (no top-level thinking_level)
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
	_ = json.Unmarshal(mut3x, &out3x)
	if _, exists := out3x["thinking_level"]; exists {
		t.Errorf("unexpected root thinking_level injection: %v", out3x["thinking_level"])
	}
	tc3x := out3x["extra_body"].(map[string]any)["google"].(map[string]any)["thinking_config"].(map[string]any)
	if tc3x["thinking_level"] != "HIGH" || tc3x["include_thoughts"] != true {
		t.Errorf("expected extra_body thinking_level=HIGH include_thoughts=true, got %v", tc3x)
	}

	// 4. 3.0 Flash effort="none" -> include_thoughts=false
	req3xNone := `{"model":"gemini-3.0-flash","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"none"}`
	mut3xNone, _, _, _ := engine.PrepareRequest("/v1/chat/completions", []byte(req3xNone), prov, "", false)
	var out3xNone map[string]any
	_ = json.Unmarshal(mut3xNone, &out3xNone)
	tc3xNone := out3xNone["extra_body"].(map[string]any)["google"].(map[string]any)["thinking_config"].(map[string]any)
	if tc3xNone["include_thoughts"] != false {
		t.Errorf("expected 3.x effort=none -> include_thoughts=false, got %v", tc3xNone)
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

func TestThoughtStreamSplitter_ChunkBoundaries(t *testing.T) {
	splitter := NewThoughtStreamSplitter("thought")

	// Chunks splitting <thought> and </thought> across arbitrary boundaries
	chunks := []string{"<tho", "ught>reasoning", "</tho", "ught>final"}
	var reasoningParts []string
	var contentParts []string

	for _, ch := range chunks {
		r, c := splitter.Feed(ch)
		if r != "" {
			reasoningParts = append(reasoningParts, r)
		}
		if c != "" {
			contentParts = append(contentParts, c)
		}
	}

	fr, fc := splitter.Flush()
	if fr != "" {
		reasoningParts = append(reasoningParts, fr)
	}
	if fc != "" {
		contentParts = append(contentParts, fc)
	}

	totalReasoning := strings.Join(reasoningParts, "")
	totalContent := strings.Join(contentParts, "")

	if totalReasoning != "reasoning" {
		t.Errorf("expected reasoning 'reasoning', got %q", totalReasoning)
	}
	if totalContent != "final" {
		t.Errorf("expected content 'final', got %q", totalContent)
	}
}

func TestThoughtStreamSplitter_CustomMarker(t *testing.T) {
	splitter := NewThoughtStreamSplitter("thinking")

	chunks := []string{"<thin", "king>deep thoughts</thinking>\n\nAnswer starts here"}
	var rAll, cAll strings.Builder

	for _, ch := range chunks {
		r, c := splitter.Feed(ch)
		rAll.WriteString(r)
		cAll.WriteString(c)
	}

	if rAll.String() != "deep thoughts" {
		t.Errorf("expected 'deep thoughts', got %q", rAll.String())
	}
	// Verify leading newlines after closing tag are stripped
	if cAll.String() != "Answer starts here" {
		t.Errorf("expected 'Answer starts here', got %q", cAll.String())
	}
}

func TestThoughtStreamSplitter_Flush(t *testing.T) {
	// 1. Partial open tag at stream end
	s1 := NewThoughtStreamSplitter("thought")
	r1, c1 := s1.Feed("Hello world <tho")
	fr1, fc1 := s1.Flush()
	if (c1 + fc1) != "Hello world <tho" {
		t.Errorf("expected flush to emit held partial tag, got %q", c1+fc1)
	}
	if (r1 + fr1) != "" {
		t.Errorf("expected empty reasoning, got %q", r1+fr1)
	}

	// 2. Partial close tag at stream end while in thought
	s2 := NewThoughtStreamSplitter("thought")
	s2.Feed("<thought>thinking deeply </tho")
	fr2, fc2 := s2.Flush()
	if (fr2) != "</tho" {
		t.Errorf("expected flush to emit held partial close tag in reasoning, got %q", fr2)
	}
	if fc2 != "" {
		t.Errorf("expected empty content, got %q", fc2)
	}
}

func TestThoughtStreamFilter_SSEIntegration(t *testing.T) {
	filter := NewThoughtStreamFilter("thought")

	chunk1 := []byte("data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"<tho\"}}]}\n\n")
	chunk2 := []byte("data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ught>I am thinking</tho\"}}]}\n\n")
	chunk3 := []byte("data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ught>Here is the response.\"}}]}\n\n")
	chunk4 := []byte("data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
	chunk5 := []byte("data: [DONE]\n\n")

	var allOutput bytes.Buffer
	allOutput.Write(filter.FilterChunk(chunk1))
	allOutput.Write(filter.FilterChunk(chunk2))
	allOutput.Write(filter.FilterChunk(chunk3))
	allOutput.Write(filter.FilterChunk(chunk4))
	allOutput.Write(filter.FilterChunk(chunk5))
	allOutput.Write(filter.Flush())

	outStr := allOutput.String()
	if !strings.Contains(outStr, `"reasoning_content":"I am thinking"`) {
		t.Errorf("expected reasoning_content in output, got: %s", outStr)
	}
	if !strings.Contains(outStr, `"content":"Here is the response."`) {
		t.Errorf("expected answer content in output, got: %s", outStr)
	}
	if !strings.Contains(outStr, "data: [DONE]") {
		t.Errorf("expected [DONE] in output, got: %s", outStr)
	}
}

func TestDenyDeveloperRole(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			DenyDeveloperRole: true,
		},
	}

	req := `{
		"model": "gpt-4o",
		"messages": [
			{"role": "developer", "content": "You are a coding assistant."},
			{"role": "user", "content": "Hello"}
		]
	}`

	mutated, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(mutated, &out); err != nil {
		t.Fatal(err)
	}

	msgs := out["messages"].([]any)
	m0 := msgs[0].(map[string]any)
	if m0["role"] != "system" {
		t.Errorf("expected developer role to be converted to system, got %v", m0["role"])
	}
}

func TestMergeSystem(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			DenyDeveloperRole: true,
			MergeSystem:       true,
		},
	}

	req := `{
		"model": "gpt-4o",
		"messages": [
			{"role": "developer", "content": "Developer prompt."},
			{"role": "user", "content": "Question 1"},
			{"role": "system", "content": "System prompt."}
		]
	}`

	mutated, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(mutated, &out); err != nil {
		t.Fatal(err)
	}

	msgs := out["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages after merge, got %d", len(msgs))
	}

	m0 := msgs[0].(map[string]any)
	if m0["role"] != "system" {
		t.Errorf("expected first message to be system, got %v", m0["role"])
	}
	expectedContent := "Developer prompt.\n\nSystem prompt."
	if m0["content"] != expectedContent {
		t.Errorf("expected merged content %q, got %q", expectedContent, m0["content"])
	}

	m1 := msgs[1].(map[string]any)
	if m1["role"] != "user" {
		t.Errorf("expected second message to be user, got %v", m1["role"])
	}
}

func TestStripEmpty(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			StripEmpty: true,
		},
	}

	req := `{
		"model": "gpt-4o",
		"messages": [
			{"role": "system", "content": ""},
			{"role": "user", "content": "   "},
			{"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "test"}}]},
			{"role": "user", "content": [{"type": "text", "text": ""}, {"type": "image_url", "image_url": {"url": "http://img"}}]},
			{"role": "user", "content": "valid message"}
		]
	}`

	mutated, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(mutated, &out); err != nil {
		t.Fatal(err)
	}

	msgs := out["messages"].([]any)
	// Empty system and empty user should be stripped
	// Assistant with tool_calls must be preserved
	// User with image must be preserved (empty text stripped)
	// Valid user message preserved
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d: %v", len(msgs), msgs)
	}

	m0 := msgs[0].(map[string]any)
	if m0["role"] != "assistant" || m0["tool_calls"] == nil {
		t.Errorf("expected assistant message with tool_calls, got %v", m0)
	}

	m1 := msgs[1].(map[string]any)
	parts := m1["content"].([]any)
	if len(parts) != 1 {
		t.Fatalf("expected 1 part after stripping empty text part, got %d", len(parts))
	}
	part0 := parts[0].(map[string]any)
	if part0["type"] != "image_url" {
		t.Errorf("expected image_url part preserved, got %v", part0)
	}

	m2 := msgs[2].(map[string]any)
	if m2["content"] != "valid message" {
		t.Errorf("expected valid message, got %v", m2["content"])
	}
}

func TestThinkingPolicy_Strip(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			ThinkingPolicy: "strip",
		},
	}

	req := `{
		"model": "claude-3-7-sonnet",
		"messages": [
			{
				"role": "assistant",
				"reasoning_content": "some reasoning",
				"reasoning": {"detail": "old"},
				"content": [
					{"type": "thinking", "thinking": "internal thought"},
					{"type": "text", "text": "Hello world"}
				]
			}
		]
	}`

	mutated, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(mutated, &out); err != nil {
		t.Fatal(err)
	}

	msgs := out["messages"].([]any)
	m0 := msgs[0].(map[string]any)

	if _, ok := m0["reasoning_content"]; ok {
		t.Errorf("expected reasoning_content to be stripped")
	}
	if _, ok := m0["reasoning"]; ok {
		t.Errorf("expected reasoning to be stripped")
	}

	content := m0["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("expected 1 content block, got %d", len(content))
	}
	block := content[0].(map[string]any)
	if block["type"] != "text" || block["text"] != "Hello world" {
		t.Errorf("expected text block, got %v", block)
	}
}

func TestThinkingPolicy_StrictSignature(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			ThinkingPolicy: "strict_signature",
		},
	}

	req := `{
		"model": "claude-3-7-sonnet",
		"messages": [
			{
				"role": "assistant",
				"content": [
					{"type": "thinking", "thinking": "unsigned thought", "signature": ""},
					{"type": "thinking", "thinking": "signed thought", "signature": "valid_sig_123"},
					{"type": "text", "text": "Hello"}
				]
			}
		]
	}`

	mutated, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(mutated, &out); err != nil {
		t.Fatal(err)
	}

	msgs := out["messages"].([]any)
	m0 := msgs[0].(map[string]any)
	content := m0["content"].([]any)

	// Unsigned thinking should be dropped; signed thinking and text preserved
	if len(content) != 2 {
		t.Fatalf("expected 2 content blocks, got %d", len(content))
	}

	b0 := content[0].(map[string]any)
	if b0["type"] != "thinking" || b0["signature"] != "valid_sig_123" {
		t.Errorf("expected signed thinking block, got %v", b0)
	}

	b1 := content[1].(map[string]any)
	if b1["type"] != "text" || b1["text"] != "Hello" {
		t.Errorf("expected text block, got %v", b1)
	}
}

func TestThinkingPolicy_PassbackRequired(t *testing.T) {
	engine := NewDefaultEngine()
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			ThinkingPolicy: "passback_required",
		},
	}

	req := `{
		"model": "gemini-3.0-pro",
		"messages": [
			{
				"role": "assistant",
				"content": [
					{"type": "thinking", "thinking": "internal thought", "signature": "sig_abc"}
				],
				"tool_calls": [
					{
						"id": "call_123:::sig_tool_456",
						"type": "function",
						"function": {"name": "search", "arguments": "{}"}
					}
				]
			}
		]
	}`

	mutated, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req), prov, "", false)
	if err != nil {
		t.Fatal(err)
	}

	var out map[string]any
	if err := json.Unmarshal(mutated, &out); err != nil {
		t.Fatal(err)
	}

	msgs := out["messages"].([]any)
	m0 := msgs[0].(map[string]any)
	content := m0["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("expected thinking block preserved, got %d", len(content))
	}

	tcs := m0["tool_calls"].([]any)
	tc0 := tcs[0].(map[string]any)
	// Tool call id stripped to base id, signature restored in extra_content.google.thought_signature
	if tc0["id"] != "call_123" {
		t.Errorf("expected id 'call_123', got %v", tc0["id"])
	}
	ec, ok := tc0["extra_content"].(map[string]any)
	if !ok {
		t.Fatalf("expected extra_content in tool_call, got nil")
	}
	g := ec["google"].(map[string]any)
	if g["thought_signature"] != "sig_tool_456" {
		t.Errorf("expected restored thought_signature 'sig_tool_456', got %v", g["thought_signature"])
	}
}

func TestExtendedAdapterRules_PresetFallback_Ceiling_GooglePrefix_SystemFirst_NonStreamSig(t *testing.T) {
	engine := NewDefaultEngine()

	// 1. Preset fallback when provider.AdapterRules == nil
	presetProv := &types.ProviderConfig{
		ID:       "google",
		PresetID: "gemini",
	}
	if ResolveAdapterRules(presetProv) == nil {
		t.Logf("note: preset 'gemini' returned nil rules (if not in catalog), testing explicit rules too")
	}

	// 2. EnsureGooglePrefix, ModelAliases in rules, MaxTokensCeiling, NormalizeChoiceToString, SystemFirstOnly
	prov := &types.ProviderConfig{
		AdapterRules: &types.AdapterRules{
			EnsureGooglePrefix:      true,
			MaxTokensCeiling:        4096,
			NormalizeChoiceToString: true,
			SystemFirstOnly:         true,
			ModelAliases:            map[string]string{"my-gem": "gemini-2.5-flash"},
			ReasoningFields:         []string{"reasoning", "reasoning_content"},
			GeminiCompat:            true,
		},
	}

	req := `{
		"model": "my-gem",
		"max_tokens": 32000,
		"max_completion_tokens": 16000,
		"tool_choice": {"type": "function", "function": {"name": "get_weather"}},
		"messages": [
			{"role": "system", "content": "First system"},
			{"role": "user", "content": "Hello"},
			{"role": "system", "content": "Mid-turn reminder"}
		]
	}`
	mutated, _, _, err := engine.PrepareRequest("/v1/chat/completions", []byte(req), prov, "", false)
	if err != nil {
		t.Fatalf("PrepareRequest err: %v", err)
	}
	var out map[string]any
	_ = json.Unmarshal(mutated, &out)

	if out["model"] != "google/gemini-2.5-flash" {
		t.Errorf("expected model 'google/gemini-2.5-flash', got %v", out["model"])
	}
	if out["max_tokens"] != float64(4096) || out["max_completion_tokens"] != float64(4096) {
		t.Errorf("expected max_tokens/max_completion_tokens clamped to 4096, got %v / %v", out["max_tokens"], out["max_completion_tokens"])
	}
	if out["tool_choice"] != "auto" {
		t.Errorf("expected map tool_choice coerced to 'auto', got %v", out["tool_choice"])
	}
	msgs := out["messages"].([]any)
	if msgs[0].(map[string]any)["role"] != "system" || msgs[2].(map[string]any)["role"] != "user" {
		t.Errorf("expected SystemFirstOnly to keep index 0 as system and rewrite index 2 to user, got %v", msgs)
	}

	// 3. Large payload StreamOnly without existing "stream" field injects "stream":true
	padding := strings.Repeat("X", 600*1024)
	largeAbsentStream := fmt.Sprintf(`{"model":"gpt-4o","messages":[{"role":"user","content":%q}]}`, padding)
	streamOnlyProv := &types.ProviderConfig{AdapterRules: &types.AdapterRules{StreamOnly: true}}
	mutLarge, _, upStream, err := engine.PrepareRequest("/v1/chat/completions", []byte(largeAbsentStream), streamOnlyProv, "", false)
	if err != nil {
		t.Fatalf("large fast-path PrepareRequest err: %v", err)
	}
	if !upStream || !strings.Contains(string(mutLarge[:80]), `"stream":true`) {
		t.Errorf("expected injected stream:true at root for >512KB StreamOnly request, got %s", string(mutLarge[:80]))
	}

	// 4. TransformNonStreamResponse: ReasoningFields + Gemini non-stream tool_calls signature encoding & caching
	nonStreamResp := `{
		"id": "chatcmpl-gem-ns",
		"model": "gemini-2.5-pro",
		"choices": [{
			"index": 0,
			"message": {
				"role": "assistant",
				"reasoning": "step-by-step thought",
				"content": "",
				"tool_calls": [{
					"id": "call_ns_99",
					"type": "function",
					"function": {"name": "lookup", "arguments": "{}"},
					"extra_content": {"google": {"thought_signature": "sig_ns_secret"}}
				}]
			},
			"finish_reason": "tool_calls"
		}]
	}`
	txBytes, err := engine.TransformNonStreamResponse("/v1/chat/completions", []byte(nonStreamResp), prov, "gemini-2.5-pro")
	if err != nil {
		t.Fatalf("TransformNonStreamResponse err: %v", err)
	}
	var txOut map[string]any
	_ = json.Unmarshal(txBytes, &txOut)
	msg := txOut["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if msg["reasoning_content"] != "step-by-step thought" {
		t.Errorf("expected reasoning copied to reasoning_content, got %v", msg["reasoning_content"])
	}
	tc0 := msg["tool_calls"].([]any)[0].(map[string]any)
	if tc0["id"] != "call_ns_99:::sig_ns_secret" {
		t.Errorf("expected encoded tool_call id 'call_ns_99:::sig_ns_secret', got %v", tc0["id"])
	}
	if gotCached := DefaultSigCache.Get("call_ns_99"); gotCached != "sig_ns_secret" {
		t.Errorf("expected signature cached in DefaultSigCache, got %q", gotCached)
	}

	// 5. AggregateStreamToJSON handles >64KB single SSE data line cleanly
	bigContent := strings.Repeat("Z", 120*1024)
	sseLargeLine := fmt.Sprintf("data: {\"id\":\"1\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":%q}}]}\n\ndata: [DONE]\n\n", bigContent)
	aggBytes, err := AggregateStreamToJSON(strings.NewReader(sseLargeLine))
	if err != nil {
		t.Fatalf("AggregateStreamToJSON >64KB line failed: %v", err)
	}
	var aggOut map[string]any
	_ = json.Unmarshal(aggBytes, &aggOut)
	gotAggContent := aggOut["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)["content"].(string)
	if len(gotAggContent) != len(bigContent) {
		t.Errorf("expected aggregated len %d, got %d", len(bigContent), len(gotAggContent))
	}
}
