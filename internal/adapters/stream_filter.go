package adapters

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/khc8655/llmproxy2/internal/types"
)

// ThoughtStreamFilter transforms SSE events as they stream to the client.
// It detects and strips <thought>...</thought> (or custom marker tags) from delta.content,
// routes the thinking text to delta.reasoning_content, and preserves/signs tool call IDs.
type ThoughtStreamFilter struct {
	marker      string
	openTag     string
	closeTag    string
	buf         []byte
	splitters   map[int]*ThoughtStreamSplitter
	toolCallIDs map[string]string // key: "choiceIndex:toolCallIndex" -> tool_call_id
}

// NewThoughtStreamFilter creates a new ThoughtStreamFilter with configurable tag marker.
func NewThoughtStreamFilter(marker string) *ThoughtStreamFilter {
	if marker == "" {
		marker = "thought"
	}
	marker = strings.Trim(marker, "<>/")
	return &ThoughtStreamFilter{
		marker:      marker,
		openTag:     "<" + marker + ">",
		closeTag:    "</" + marker + ">",
		splitters:   make(map[int]*ThoughtStreamSplitter),
		toolCallIDs: make(map[string]string),
	}
}

// NewStreamFilterFromRules creates a filter if rules specify ThoughtTagMarker or GeminiCompat.
// Returns nil if no thought splitting is required.
func NewStreamFilterFromRules(rules *types.AdapterRules) *ThoughtStreamFilter {
	if rules == nil {
		return nil
	}
	if rules.ThoughtTagMarker != "" {
		return NewThoughtStreamFilter(rules.ThoughtTagMarker)
	}
	if rules.GeminiCompat {
		return NewThoughtStreamFilter("thought")
	}
	return nil
}

const maxStreamFilterBufBytes = 4 << 20 // 4 MiB cap on unsplit SSE event buffer

// FilterChunk processes an arbitrary raw byte chunk from upstream SSE stream.
// It buffers partial events across chunk boundaries and returns transformed SSE events.
func (f *ThoughtStreamFilter) FilterChunk(chunk []byte) []byte {
	if len(chunk) == 0 {
		return nil
	}

	// Keep-alive comment fast-path if buffer is empty
	if len(f.buf) == 0 && bytes.HasPrefix(chunk, []byte(":")) && bytes.HasSuffix(chunk, []byte("\n\n")) {
		return chunk
	}

	data := append(f.buf, chunk...)
	// Normalize CRLF to LF
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))

	parts := bytes.Split(data, []byte("\n\n"))
	done := bytes.Contains(chunk, []byte("[DONE]"))

	var complete [][]byte
	var overflowRaw []byte
	if done {
		f.buf = nil
		for _, p := range parts {
			if len(p) > 0 {
				complete = append(complete, p)
			}
		}
	} else {
		// Last part may be an incomplete event across chunk boundary
		tail := parts[len(parts)-1]
		if len(tail) > maxStreamFilterBufBytes {
			// Guard against unbounded memory growth if upstream omits SSE "\n\n" delimiters
			overflowRaw = tail
			f.buf = nil
		} else {
			f.buf = tail
		}
		complete = parts[:len(parts)-1]
	}

	if len(complete) == 0 && len(overflowRaw) == 0 {
		return nil
	}

	var out bytes.Buffer
	for _, event := range complete {
		processed := f.processEvent(event)
		out.Write(processed)
		out.Write([]byte("\n\n"))
	}
	if len(overflowRaw) > 0 {
		out.Write(overflowRaw)
	}
	return out.Bytes()
}

// Flush processes any remaining data held in buffer at stream EOF.
func (f *ThoughtStreamFilter) Flush() []byte {
	if len(bytes.TrimSpace(f.buf)) == 0 {
		f.buf = nil
		return nil
	}
	rest := f.buf
	f.buf = nil
	processed := f.processEvent(rest)
	if len(bytes.TrimSpace(processed)) == 0 {
		return nil
	}
	return append(processed, []byte("\n\n")...)
}

func (f *ThoughtStreamFilter) processEvent(event []byte) []byte {
	lines := bytes.Split(event, []byte("\n"))
	outLines := make([][]byte, 0, len(lines))

	for _, ln := range lines {
		trimmed := bytes.TrimSpace(ln)
		if !bytes.HasPrefix(trimmed, []byte("data:")) {
			outLines = append(outLines, ln)
			continue
		}
		payload := bytes.TrimSpace(trimmed[5:])
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			outLines = append(outLines, ln)
			continue
		}

		var obj map[string]any
		if err := json.Unmarshal(payload, &obj); err != nil {
			outLines = append(outLines, ln)
			continue
		}

		choices, ok := obj["choices"].([]any)
		if !ok || len(choices) == 0 {
			outLines = append(outLines, ln)
			continue
		}

		changed := false
		for _, chObj := range choices {
			ch, ok := chObj.(map[string]any)
			if !ok {
				continue
			}
			delta, ok := ch["delta"].(map[string]any)
			if !ok {
				continue
			}

			idx := 0
			if idxVal, ok := ch["index"].(float64); ok {
				idx = int(idxVal)
			} else if idxVal, ok := ch["index"].(int); ok {
				idx = idxVal
			}

			c, hasContent := delta["content"].(string)
			sp := f.splitters[idx]

			tagPrefix := "<"
			if len(f.openTag) > 0 {
				tagPrefix = f.openTag[:1]
			}

			if hasContent && (sp != nil || strings.Contains(c, tagPrefix)) {
				if sp == nil {
					sp = NewThoughtStreamSplitter(f.marker)
					f.splitters[idx] = sp
				}
				r, a := sp.Feed(c)
				fr, _ := ch["finish_reason"].(string)
				if fr != "" {
					flushR, flushA := sp.Flush()
					r += flushR
					a += flushA
				}
				if r != "" {
					existingRC, _ := delta["reasoning_content"].(string)
					delta["reasoning_content"] = existingRC + r
				}
				delta["content"] = a
				changed = true
			} else if sp != nil {
				fr, _ := ch["finish_reason"].(string)
				if fr != "" {
					flushR, flushA := sp.Flush()
					if flushR != "" {
						existingRC, _ := delta["reasoning_content"].(string)
						delta["reasoning_content"] = existingRC + flushR
						changed = true
					}
					if flushA != "" {
						existingC, _ := delta["content"].(string)
						delta["content"] = existingC + flushA
						changed = true
					}
				}
			}

			// Handle tool_calls for thought signatures
			if tcs, ok := delta["tool_calls"].([]any); ok {
				for _, tcObj := range tcs {
					tc, ok := tcObj.(map[string]any)
					if !ok {
						continue
					}
					tcIdx := 0
					if tcIdxVal, ok := tc["index"].(float64); ok {
						tcIdx = int(tcIdxVal)
					} else if tcIdxVal, ok := tc["index"].(int); ok {
						tcIdx = tcIdxVal
					}
					key := fmt.Sprintf("%d:%d", idx, tcIdx)

					var sig string
					if ec, ok := tc["extra_content"].(map[string]any); ok {
						if g, ok := ec["google"].(map[string]any); ok {
							if s, ok := g["thought_signature"].(string); ok {
								sig = s
							}
						}
					}

					idStr, hasID := tc["id"].(string)
					if hasID && idStr != "" {
						f.toolCallIDs[key] = idStr
						if sig != "" && !strings.Contains(idStr, SigSep) {
							GlobalSigCache.Put(idStr, sig)
							tc["id"] = idStr + SigSep + sig
							changed = true
						}
					} else if sig != "" {
						if prevID, exists := f.toolCallIDs[key]; exists {
							GlobalSigCache.Put(prevID, sig)
						}
					}
				}
			}
		}

		if changed {
			newJSON, err := json.Marshal(obj)
			if err == nil {
				outLines = append(outLines, append([]byte("data: "), newJSON...))
			} else {
				outLines = append(outLines, ln)
			}
		} else {
			outLines = append(outLines, ln)
		}
	}

	return bytes.Join(outLines, []byte("\n"))
}
