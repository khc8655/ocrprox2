// Package adapters provides declarative request/response adaptation, Gemini 2.5/3.x compatibility,
// thought tag streaming splitting, tool signature preservation, and schema sanitization.
package adapters

import (
	"strings"
	"sync"
)

const (
	ThoughtOpenTag  = "<thought>"
	ThoughtCloseTag = "</thought>"
	SigSep          = ":::"
	SkipSignature   = "skip_thought_signature_validator"
)

// LRUSigCache is an in-memory LRU cache for Gemini tool call thought signatures.
type LRUSigCache struct {
	mu       sync.Mutex
	capacity int
	items    map[string]string
	keys     []string
}

// GlobalSigCache holds up to 2000 tool call thought signatures.
var GlobalSigCache = NewLRUSigCache(2000)

func NewLRUSigCache(cap int) *LRUSigCache {
	return &LRUSigCache{
		capacity: cap,
		items:    make(map[string]string),
		keys:     make([]string, 0, cap),
	}
}

func (c *LRUSigCache) Put(k, v string) {
	if k == "" || v == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, ok := c.items[k]; !ok {
		if len(c.keys) >= c.capacity {
			oldest := c.keys[0]
			c.keys = c.keys[1:]
			delete(c.items, oldest)
		}
		c.keys = append(c.keys, k)
	}
	c.items[k] = v
}

func (c *LRUSigCache) Get(k string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.items[k]
}

// SanitizeGeminiSchema recursively removes unsupported keywords ($schema, title, default, additionalProperties, $defs, $ref).
func SanitizeGeminiSchema(schema any) any {
	switch v := schema.(type) {
	case map[string]any:
		clean := make(map[string]any)
		for k, val := range v {
			if k == "$schema" || k == "additionalProperties" || k == "$defs" || k == "$ref" || k == "title" || k == "default" {
				continue
			}
			clean[k] = SanitizeGeminiSchema(val)
		}

		// Clean required list: keep only keys present in properties
		if props, ok := clean["properties"].(map[string]any); ok {
			if reqList, ok := clean["required"].([]any); ok {
				var validReq []any
				for _, r := range reqList {
					if rStr, ok := r.(string); ok && props[rStr] != nil {
						validReq = append(validReq, rStr)
					}
				}
				if len(validReq) > 0 {
					clean["required"] = validReq
				} else {
					delete(clean, "required")
				}
			}
		} else {
			delete(clean, "required")
		}

		return clean

	case []any:
		var list []any
		for _, elem := range v {
			list = append(list, SanitizeGeminiSchema(elem))
		}
		return list

	default:
		return schema
	}
}

// SplitThoughts splits text containing <thought>...</thought> into reasoning and answer.
func SplitThoughts(text string) (reasoning string, answer string) {
	return SplitThoughtsWithMarker(text, "thought")
}

// SplitThoughtsWithMarker splits text containing <marker>...</marker> into reasoning and answer.
func SplitThoughtsWithMarker(text string, marker string) (reasoning string, answer string) {
	if marker == "" {
		marker = "thought"
	}
	marker = strings.Trim(marker, "<>/")
	openTag := "<" + marker + ">"
	closeTag := "</" + marker + ">"

	if !strings.Contains(text, openTag) {
		return "", text
	}

	var reasoningParts []string
	var answerParts []string

	rest := text
	for len(rest) > 0 {
		i := strings.Index(rest, openTag)
		if i < 0 {
			answerParts = append(answerParts, rest)
			break
		}
		answerParts = append(answerParts, rest[:i])
		rest = rest[i+len(openTag):]

		j := strings.Index(rest, closeTag)
		if j < 0 {
			reasoningParts = append(reasoningParts, rest)
			break
		}
		reasoningParts = append(reasoningParts, rest[:j])
		rest = rest[j+len(closeTag):]
	}

	return strings.TrimSpace(strings.Join(reasoningParts, "")),
		strings.TrimLeft(strings.Join(answerParts, ""), "\n")
}

// ThoughtStreamSplitter splits streaming chunks where tags might span chunks.
type ThoughtStreamSplitter struct {
	InThought  bool
	Hold       string
	AfterClose bool
	OpenTag    string
	CloseTag   string
}

// NewThoughtStreamSplitter creates a new ThoughtStreamSplitter with a configurable marker tag.
func NewThoughtStreamSplitter(marker string) *ThoughtStreamSplitter {
	if marker == "" {
		marker = "thought"
	}
	marker = strings.Trim(marker, "<>/")
	return &ThoughtStreamSplitter{
		OpenTag:  "<" + marker + ">",
		CloseTag: "</" + marker + ">",
	}
}

func (s *ThoughtStreamSplitter) getOpenTag() string {
	if s.OpenTag != "" {
		return s.OpenTag
	}
	return ThoughtOpenTag
}

func (s *ThoughtStreamSplitter) getCloseTag() string {
	if s.CloseTag != "" {
		return s.CloseTag
	}
	return ThoughtCloseTag
}

func (s *ThoughtStreamSplitter) Feed(chunk string) (reasoning string, content string) {
	buf := s.Hold + chunk
	s.Hold = ""

	openTag := s.getOpenTag()
	closeTag := s.getCloseTag()

	var rParts []string
	var aParts []string

	for len(buf) > 0 {
		tag := openTag
		if s.InThought {
			tag = closeTag
		}

		i := strings.Index(buf, tag)
		if i >= 0 {
			part := buf[:i]
			if s.InThought {
				rParts = append(rParts, part)
			} else {
				aParts = append(aParts, part)
			}

			buf = buf[i+len(tag):]
			s.AfterClose = s.InThought
			s.InThought = !s.InThought
			continue
		}

		// Check if tail might be a partial prefix of tag
		keep := 0
		maxCheck := len(tag) - 1
		if len(buf) < maxCheck {
			maxCheck = len(buf)
		}
		for k := maxCheck; k > 0; k-- {
			if strings.HasPrefix(tag, buf[len(buf)-k:]) {
				keep = k
				break
			}
		}

		if keep > 0 {
			part := buf[:len(buf)-keep]
			s.Hold = buf[len(buf)-keep:]
			if s.InThought {
				rParts = append(rParts, part)
			} else {
				aParts = append(aParts, part)
			}
		} else {
			if s.InThought {
				rParts = append(rParts, buf)
			} else {
				aParts = append(aParts, buf)
			}
		}
		break
	}

	ans := strings.Join(aParts, "")
	if s.AfterClose && len(ans) > 0 {
		ans = strings.TrimLeft(ans, "\n")
		if len(ans) > 0 {
			s.AfterClose = false
		}
	}

	return strings.Join(rParts, ""), ans
}

// Flush emits any remaining buffered text when stream ends.
func (s *ThoughtStreamSplitter) Flush() (reasoning string, content string) {
	h := s.Hold
	s.Hold = ""
	if s.InThought {
		return h, ""
	}
	return "", h
}

// ApplyGeminiThinking configures Gemini 2.5 thinking_budget or 3.x thinking_level.
func ApplyGeminiThinking(reqMap map[string]any, modelName string) {
	mName := strings.ToLower(modelName)
	effort, hasEffort := reqMap["reasoning_effort"].(string)

	is25 := strings.Contains(mName, "gemini-2.5") || strings.Contains(mName, "2.5-")
	is3x := strings.Contains(mName, "gemini-3") || strings.Contains(mName, "3.0-") || strings.Contains(mName, "3.8-")

	if !hasEffort && !is25 && !is3x {
		return
	}

	effort = strings.ToLower(effort)
	if effort == "xhigh" || effort == "max" {
		effort = "high"
	}

	extraBody, _ := reqMap["extra_body"].(map[string]any)
	if extraBody == nil {
		extraBody = make(map[string]any)
	}
	google, _ := extraBody["google"].(map[string]any)
	if google == nil {
		google = make(map[string]any)
	}

	if is25 {
		budget := 8192
		switch effort {
		case "minimal", "low":
			budget = 1024
		case "medium":
			budget = 8192
		case "high":
			budget = 24576
		}
		google["thinking_config"] = map[string]any{
			"include_thoughts": true,
			"thinking_budget":  budget,
		}
		// Also provide top-level thinking_budget for direct JSON tests
		reqMap["thinking_budget"] = budget
	} else if is3x {
		level := "MEDIUM"
		switch effort {
		case "minimal", "low":
			level = "LOW"
		case "medium":
			level = "MEDIUM"
		case "high":
			level = "HIGH"
		}
		google["thinking_config"] = map[string]any{
			"include_thoughts": true,
			"thinking_level":   level,
		}
		reqMap["thinking_level"] = level
	}

	extraBody["google"] = google
	reqMap["extra_body"] = extraBody
	delete(reqMap, "reasoning_effort")
}

// RestoreSignatures handles Gemini tool call thought signatures.
func RestoreSignatures(reqMap map[string]any, keep bool) {
	msgs, ok := reqMap["messages"].([]any)
	if !ok {
		return
	}

	for _, mObj := range msgs {
		m, ok := mObj.(map[string]any)
		if !ok {
			continue
		}

		if tcID, ok := m["tool_call_id"].(string); ok && strings.Contains(tcID, SigSep) {
			m["tool_call_id"] = strings.Split(tcID, SigSep)[0]
		}

		tcs, ok := m["tool_calls"].([]any)
		if !ok || m["role"] != "assistant" {
			continue
		}

		firstMissing := true
		for i, tcObj := range tcs {
			tc, ok := tcObj.(map[string]any)
			if !ok {
				continue
			}

			idStr, _ := tc["id"].(string)
			realID := idStr
			sig := ""
			if strings.Contains(idStr, SigSep) {
				parts := strings.SplitN(idStr, SigSep, 2)
				realID = parts[0]
				sig = parts[1]
			}
			tc["id"] = realID

			if !keep {
				continue
			}

			if sig == "" {
				sig = GlobalSigCache.Get(realID)
			}
			if sig == "" && i == 0 && firstMissing {
				sig = SkipSignature
			}

			if sig != "" {
				ec, _ := tc["extra_content"].(map[string]any)
				if ec == nil {
					ec = make(map[string]any)
				}
				g, _ := ec["google"].(map[string]any)
				if g == nil {
					g = make(map[string]any)
				}
				g["thought_signature"] = sig
				ec["google"] = g
				tc["extra_content"] = ec
				firstMissing = false
			}
		}
	}
}
