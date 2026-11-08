package adapters

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/khc8655/llmproxy2/internal/types"
)

var jsonBlockRegex = regexp.MustCompile("(?s)```(?:json)?\\s*([\\{\\[].*?[\\]\\}])\\s*```")

// DefaultEngine implements types.AdapterEngine.
type DefaultEngine struct{}

// NewDefaultEngine creates an AdapterEngine.
func NewDefaultEngine() *DefaultEngine {
	return &DefaultEngine{}
}

// PrepareRequest adapts client request body and headers according to provider rules.
func (e *DefaultEngine) PrepareRequest(
	endpoint string,
	reqBody []byte,
	provider *types.ProviderConfig,
	targetModel string,
	clientForcedStream bool,
) ([]byte, map[string]string, bool, error) {
	extraHeaders := make(map[string]string)
	var rules *types.AdapterRules
	if provider != nil {
		rules = provider.AdapterRules
	}

	// Fast-Path for large payloads (> 512KB) to eliminate AST heap expansion (OOM defense in 64MB containers)
	if len(reqBody) > 512*1024 {
		needsComplex := false
		if rules != nil {
			if rules.GeminiCompat || rules.StripReasoningEnabled || len(rules.StripParams) > 0 || len(rules.RenameParams) > 0 || len(rules.OverrideParams) > 0 {
				needsComplex = true
			}
		}
		if !needsComplex && strings.Contains(strings.ToLower(targetModel), "gemini") {
			needsComplex = true
		}
		if !needsComplex {
			currentModel, vStart, vEnd, found := findTopLevelString(reqBody, "model")
			if found && strings.Contains(strings.ToLower(currentModel), "gemini") {
				needsComplex = true
			}
			if bytes.Contains(reqBody, []byte(SigSep)) {
				needsComplex = true
			}

			if !needsComplex {
				// Fast path: zero JSON AST expansion
				if rules != nil && rules.ExtraHeaders != nil {
					for k, v := range rules.ExtraHeaders {
						extraHeaders[k] = v
					}
				}

				upstreamStream := clientForcedStream
				if rules != nil && rules.StreamOnly {
					upstreamStream = true
				} else if bVal, _, _, bFound := findTopLevelBool(reqBody, "stream"); bFound {
					upstreamStream = bVal
				}

				effectiveModel := targetModel
				if effectiveModel == "" && currentModel != "" && provider != nil && provider.ModelAliases != nil {
					if alias, exists := provider.ModelAliases[currentModel]; exists {
						effectiveModel = alias
					}
				}

				mutated := reqBody
				if effectiveModel != "" && effectiveModel != currentModel {
					if found {
						var buf bytes.Buffer
						buf.Grow(len(reqBody) - (vEnd - vStart) + len(effectiveModel))
						buf.Write(reqBody[:vStart])
						buf.WriteString(effectiveModel)
						buf.Write(reqBody[vEnd:])
						mutated = buf.Bytes()
					} else {
						// Inject model field at root
						if idx := bytes.IndexByte(mutated, '{'); idx >= 0 {
							inject := fmt.Sprintf(`"model":%q,`, effectiveModel)
							var buf bytes.Buffer
							buf.Grow(len(mutated) + len(inject))
							buf.Write(mutated[:idx+1])
							buf.WriteString(inject)
							buf.Write(mutated[idx+1:])
							mutated = buf.Bytes()
						}
					}
				}

				if rules != nil && rules.StreamOnly {
					if bVal, bStart, bEnd, bFound := findTopLevelBool(mutated, "stream"); bFound && !bVal {
						var buf bytes.Buffer
						buf.Grow(len(mutated) - (bEnd - bStart) + 4)
						buf.Write(mutated[:bStart])
						buf.WriteString("true")
						buf.Write(mutated[bEnd:])
						mutated = buf.Bytes()
					}
				}

				return mutated, extraHeaders, upstreamStream, nil
			}
		}
	}

	var bodyMap map[string]any
	if len(reqBody) > 0 {
		if err := json.Unmarshal(reqBody, &bodyMap); err != nil {
			return nil, nil, false, fmt.Errorf("adapters: json unmarshal request: %w", err)
		}
	} else {
		bodyMap = make(map[string]any)
	}

	// 1. Model Alias and Target Model override
	if targetModel != "" {
		bodyMap["model"] = targetModel
	} else if currentModel, ok := bodyMap["model"].(string); ok && provider != nil && provider.ModelAliases != nil {
		if alias, exists := provider.ModelAliases[currentModel]; exists {
			bodyMap["model"] = alias
		}
	}

	// 2. Extra Headers
	if rules != nil && rules.ExtraHeaders != nil {
		for k, v := range rules.ExtraHeaders {
			extraHeaders[k] = v
		}
	}

	upstreamStream := clientForcedStream
	if clientStream, ok := bodyMap["stream"].(bool); ok {
		upstreamStream = clientStream
	}

	if rules != nil {
		// 3. StreamOnly: upstream requires stream=true
		if rules.StreamOnly {
			upstreamStream = true
			bodyMap["stream"] = true
		}

		// 4. Strip Parameters
		for _, param := range rules.StripParams {
			delete(bodyMap, param)
		}

		// 5. Strip Reasoning Enabled (AMD Cloud)
		if rules.StripReasoningEnabled {
			if rObj, ok := bodyMap["reasoning"].(map[string]any); ok {
				delete(rObj, "enabled")
				if len(rObj) == 0 {
					delete(bodyMap, "reasoning")
				}
			}
			delete(bodyMap, "reasoning_effort")
		}

		// 6. Rename Parameters
		for oldKey, newKey := range rules.RenameParams {
			if val, exists := bodyMap[oldKey]; exists {
				bodyMap[newKey] = val
				delete(bodyMap, oldKey)
			}
		}

		// 7. Override Parameters
		for k, v := range rules.OverrideParams {
			bodyMap[k] = v
		}

		// 8. Gemini Compatibility
		activeModel, _ := bodyMap["model"].(string)
		if rules.GeminiCompat || strings.Contains(strings.ToLower(activeModel), "gemini") {
			ApplyGeminiThinking(bodyMap, activeModel)
			RestoreSignatures(bodyMap, true)

			// Clean tool schemas for Gemini
			if tools, ok := bodyMap["tools"].([]any); ok {
				for _, tObj := range tools {
					if tMap, ok := tObj.(map[string]any); ok {
						if fn, ok := tMap["function"].(map[string]any); ok {
							if params, ok := fn["parameters"].(map[string]any); ok {
								fn["parameters"] = SanitizeGeminiSchema(params)
							}
						}
					}
				}
			}
		} else {
			RestoreSignatures(bodyMap, false)
		}
	}

	mutated, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, nil, false, fmt.Errorf("adapters: json marshal request: %w", err)
	}

	return mutated, extraHeaders, upstreamStream, nil
}

// TransformNonStreamResponse transforms upstream non-streaming response body.
func (e *DefaultEngine) TransformNonStreamResponse(
	endpoint string,
	respBody []byte,
	provider *types.ProviderConfig,
	reqModel string,
) ([]byte, error) {
	if len(respBody) == 0 || provider == nil || provider.AdapterRules == nil {
		return respBody, nil
	}

	rules := provider.AdapterRules
	var data map[string]any
	if err := json.Unmarshal(respBody, &data); err != nil {
		return respBody, nil
	}

	// 1. UnwrapRoot (e.g. data in {code: 0, data: {...}})
	if rules.UnwrapRoot != "" {
		if inner, ok := data[rules.UnwrapRoot].(map[string]any); ok {
			if inner["choices"] != nil || inner["id"] != nil {
				data = inner
			}
		}
	}

	// 2. Rescue From Text: extract markdown JSON tool call blocks into standard tool_calls
	if rules.RescueFromText {
		rescueToolCalls(data)
	}

	// 3. Gemini Thought Splitting for non-stream
	if rules.ThoughtTagMarker != "" || rules.GeminiCompat {
		splitNonStreamThoughts(data)
	}

	return json.Marshal(data)
}

func rescueToolCalls(data map[string]any) {
	choices, ok := data["choices"].([]any)
	if !ok {
		return
	}

	for _, chObj := range choices {
		ch, ok := chObj.(map[string]any)
		if !ok {
			continue
		}
		msg, ok := ch["message"].(map[string]any)
		if !ok {
			continue
		}

		content, ok := msg["content"].(string)
		if !ok || !strings.Contains(content, "```") {
			continue
		}

		match := jsonBlockRegex.FindStringSubmatch(content)
		if len(match) < 2 {
			continue
		}

		jsonStr := strings.TrimSpace(match[1])
		var parsed any
		if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
			continue
		}

		var toolCalls []map[string]any
		switch p := parsed.(type) {
		case map[string]any:
			if name, ok := p["name"].(string); ok {
				argsBytes, _ := json.Marshal(p["arguments"])
				toolCalls = append(toolCalls, map[string]any{
					"id":   "call_rescued_0",
					"type": "function",
					"function": map[string]any{
						"name":      name,
						"arguments": string(argsBytes),
					},
				})
			}
		case []any:
			for idx, item := range p {
				if itemMap, ok := item.(map[string]any); ok {
					if name, ok := itemMap["name"].(string); ok {
						argsBytes, _ := json.Marshal(itemMap["arguments"])
						toolCalls = append(toolCalls, map[string]any{
							"id":   fmt.Sprintf("call_rescued_%d", idx),
							"type": "function",
							"function": map[string]any{
								"name":      name,
								"arguments": string(argsBytes),
							},
						})
					}
				}
			}
		}

		if len(toolCalls) > 0 {
			cleanedContent := strings.TrimSpace(jsonBlockRegex.ReplaceAllString(content, ""))
			msg["content"] = cleanedContent
			msg["tool_calls"] = toolCalls
			ch["finish_reason"] = "tool_calls"
		}
	}
}

func splitNonStreamThoughts(data map[string]any) {
	choices, ok := data["choices"].([]any)
	if !ok {
		return
	}

	for _, chObj := range choices {
		ch, ok := chObj.(map[string]any)
		if !ok {
			continue
		}
		msg, ok := ch["message"].(map[string]any)
		if !ok {
			continue
		}
		content, ok := msg["content"].(string)
		if ok && strings.Contains(content, ThoughtOpenTag) {
			r, a := SplitThoughts(content)
			if r != "" {
				msg["reasoning_content"] = r
			}
			msg["content"] = a
		}
	}
}

// WrapStreamTransformer attaches stream transformations (ThoughtSplitter, Signature preservation).
func (e *DefaultEngine) WrapStreamTransformer(
	endpoint string,
	upstreamReader http.Flusher,
	provider *types.ProviderConfig,
	reqModel string,
) {
	// Handled at scheduler / peek level
}

// AggregateStreamToJSON converts an upstream SSE event stream into a complete non-streaming chat.completion JSON response.
func AggregateStreamToJSON(r io.Reader) ([]byte, error) {
	sc := bufio.NewScanner(r)
	var finalID string
	var finalModel string
	var contentBuilder strings.Builder
	var reasoningBuilder strings.Builder
	var role string
	var finishReason string

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[5:])
		if payload == "" || payload == "[DONE]" {
			continue
		}

		var chunk map[string]any
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}

		if id, ok := chunk["id"].(string); ok && id != "" {
			finalID = id
		}
		if model, ok := chunk["model"].(string); ok && model != "" {
			finalModel = model
		}

		choices, ok := chunk["choices"].([]any)
		if !ok || len(choices) == 0 {
			continue
		}

		ch, ok := choices[0].(map[string]any)
		if !ok {
			continue
		}

		if fr, ok := ch["finish_reason"].(string); ok && fr != "" {
			finishReason = fr
		}

		delta, ok := ch["delta"].(map[string]any)
		if !ok {
			continue
		}

		if r, ok := delta["role"].(string); ok && r != "" {
			role = r
		}
		if c, ok := delta["content"].(string); ok {
			contentBuilder.WriteString(c)
		}
		if rc, ok := delta["reasoning_content"].(string); ok {
			reasoningBuilder.WriteString(rc)
		}
	}

	if role == "" {
		role = "assistant"
	}
	if finishReason == "" {
		finishReason = "stop"
	}

	msg := map[string]any{
		"role":    role,
		"content": contentBuilder.String(),
	}
	if reasoningBuilder.Len() > 0 {
		msg["reasoning_content"] = reasoningBuilder.String()
	}

	result := map[string]any{
		"id":     finalID,
		"object": "chat.completion",
		"model":  finalModel,
		"choices": []any{
			map[string]any{
				"index":         0,
				"message":       msg,
				"finish_reason": finishReason,
			},
		},
	}

	return json.Marshal(result)
}

// findTopLevelString scans a JSON object for a top-level string field like "model": "gpt-4o".
// It returns the string value, the index of the start of the value (after quote),
// the index of the end of the value (before quote), and whether it was found.
func findTopLevelString(data []byte, key string) (val string, valStart, valEnd int, found bool) {
	depth := 0
	inString := false
	escape := false
	n := len(data)

	for i := 0; i < n; i++ {
		b := data[i]
		if escape {
			escape = false
			continue
		}
		if b == '\\' && inString {
			escape = true
			continue
		}
		if b == '"' {
			inString = !inString
			if inString && depth == 1 {
				kStart := i + 1
				kEnd := -1
				for j := kStart; j < n; j++ {
					if data[j] == '\\' {
						j++
						continue
					}
					if data[j] == '"' {
						kEnd = j
						break
					}
				}
				if kEnd != -1 && string(data[kStart:kEnd]) == key {
					idx := kEnd + 1
					for idx < n && (data[idx] == ' ' || data[idx] == '\t' || data[idx] == '\r' || data[idx] == '\n' || data[idx] == ':') {
						idx++
					}
					if idx < n && data[idx] == '"' {
						vStart := idx + 1
						vEnd := -1
						for j := vStart; j < n; j++ {
							if data[j] == '\\' {
								j++
								continue
							}
							if data[j] == '"' {
								vEnd = j
								break
							}
						}
						if vEnd != -1 {
							return string(data[vStart:vEnd]), vStart, vEnd, true
						}
					}
				}
				if kEnd != -1 {
					i = kEnd
					inString = false
				}
			}
			continue
		}
		if inString {
			continue
		}
		if b == '{' {
			depth++
		} else if b == '}' {
			depth--
			if depth == 0 {
				break
			}
		}
	}
	return "", 0, 0, false
}

// findTopLevelBool scans a JSON object for a top-level boolean field like "stream": true.
// It returns the bool value, the start index of the literal, the end index of the literal,
// and whether it was found.
func findTopLevelBool(data []byte, key string) (val bool, valStart, valEnd int, found bool) {
	depth := 0
	inString := false
	escape := false
	n := len(data)

	for i := 0; i < n; i++ {
		b := data[i]
		if escape {
			escape = false
			continue
		}
		if b == '\\' && inString {
			escape = true
			continue
		}
		if b == '"' {
			inString = !inString
			if inString && depth == 1 {
				kStart := i + 1
				kEnd := -1
				for j := kStart; j < n; j++ {
					if data[j] == '\\' {
						j++
						continue
					}
					if data[j] == '"' {
						kEnd = j
						break
					}
				}
				if kEnd != -1 && string(data[kStart:kEnd]) == key {
					idx := kEnd + 1
					for idx < n && (data[idx] == ' ' || data[idx] == '\t' || data[idx] == '\r' || data[idx] == '\n' || data[idx] == ':') {
						idx++
					}
					if idx+4 <= n && string(data[idx:idx+4]) == "true" {
						return true, idx, idx + 4, true
					}
					if idx+5 <= n && string(data[idx:idx+5]) == "false" {
						return false, idx, idx + 5, true
					}
				}
				if kEnd != -1 {
					i = kEnd
					inString = false
				}
			}
			continue
		}
		if inString {
			continue
		}
		if b == '{' {
			depth++
		} else if b == '}' {
			depth--
			if depth == 0 {
				break
			}
		}
	}
	return false, 0, 0, false
}
