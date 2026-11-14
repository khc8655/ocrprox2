package scheduler

import (
	"bytes"
	"encoding/json"
	"time"
)

// StreamUsageTracker inspects SSE event streams in real time as bytes flow to the client,
// extracting usage tokens (input, output, cache read/write, reasoning) and stop reasons
// for OpenAI chat, OpenAI /v1/responses, and Anthropic messages protocols with zero buffering delay.
type StreamUsageTracker struct {
	StartTime          time.Time
	FirstChunkTime     time.Time
	FirstTextTime      time.Time
	TTFTMillis         int64
	FirstTextMillis    int64
	FlowMillis         int64

	InTokens           int
	OutTokens          int
	TotalTokens        int
	CacheReadTokens    int
	CacheWriteTokens   int
	CacheWrite1hTokens int
	ReasoningTokens    int
	StopReason         string

	tail               []byte
	hasRecordedTTFT    bool
	hasRecordedText    bool
}

// NewStreamUsageTracker creates a StreamUsageTracker initialized with request start time and pre-computed TTFT.
func NewStreamUsageTracker(reqStart time.Time, ttftMillis int64) *StreamUsageTracker {
	if reqStart.IsZero() {
		reqStart = time.Now()
	}
	return &StreamUsageTracker{
		StartTime:       reqStart,
		TTFTMillis:      ttftMillis,
		hasRecordedTTFT: ttftMillis > 0,
		FirstChunkTime:  time.Now(),
	}
}

// FeedChunk inspects an arbitrary streamed byte slice as it flows through the proxy.
func (t *StreamUsageTracker) FeedChunk(chunk []byte) {
	if len(chunk) == 0 {
		return
	}

	if !t.hasRecordedTTFT {
		trimmed := bytes.TrimSpace(chunk)
		if len(trimmed) > 0 && !bytes.HasPrefix(trimmed, []byte(":")) {
			t.FirstChunkTime = time.Now()
			t.TTFTMillis = time.Since(t.StartTime).Milliseconds()
			t.hasRecordedTTFT = true
		}
	}

	buf := append(t.tail, chunk...)
	cut := bytes.LastIndexByte(buf, '\n')
	if cut < 0 {
		if len(buf) <= 64*1024 {
			t.tail = buf
		} else {
			t.tail = nil
		}
		return
	}

	complete := buf[:cut]
	t.tail = make([]byte, len(buf)-(cut+1))
	copy(t.tail, buf[cut+1:])

	// Quick keyword check before line splitting
	if !t.hasRecordedText {
		if bytes.Contains(complete, []byte(`"content"`)) ||
			bytes.Contains(complete, []byte(`"text"`)) ||
			bytes.Contains(complete, []byte(`"reasoning"`)) ||
			bytes.Contains(complete, []byte(`content_block_delta`)) {
			t.hasRecordedText = true
			t.FirstTextTime = time.Now()
			t.FirstTextMillis = time.Since(t.StartTime).Milliseconds()
		}
	}

	if !bytes.Contains(complete, []byte(`"usage"`)) &&
		!bytes.Contains(complete, []byte(`"finish_reason"`)) &&
		!bytes.Contains(complete, []byte(`"stop_reason"`)) &&
		!bytes.Contains(complete, []byte(`"message_start"`)) &&
		!bytes.Contains(complete, []byte(`"message_delta"`)) &&
		!bytes.Contains(complete, []byte(`"response.completed"`)) &&
		!bytes.Contains(complete, []byte(`"response"`)) {
		return
	}

	lines := bytes.Split(complete, []byte("\n"))
	for _, ln := range lines {
		trimmed := bytes.TrimSpace(ln)
		if !bytes.HasPrefix(trimmed, []byte("data:")) {
			continue
		}
		payload := bytes.TrimSpace(trimmed[5:])
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}

		var obj map[string]any
		if err := json.Unmarshal(payload, &obj); err != nil {
			continue
		}

		t.ParseJSON(obj)
	}
}

// ParseJSON parses a single parsed JSON event object or non-streaming response body.
func (t *StreamUsageTracker) ParseJSON(obj map[string]any) {
	// 1. OpenAI Chat Completions choices finish_reason and text detection
	if chs, ok := obj["choices"].([]any); ok && len(chs) > 0 {
		if ch, ok := chs[0].(map[string]any); ok {
			if fr, ok := ch["finish_reason"].(string); ok && fr != "" {
				t.StopReason = fr
			}
			if !t.hasRecordedText {
				if delta, ok := ch["delta"].(map[string]any); ok {
					if c, ok := delta["content"].(string); ok && c != "" {
						t.hasRecordedText = true
						t.FirstTextTime = time.Now()
						t.FirstTextMillis = time.Since(t.StartTime).Milliseconds()
					} else if rc, ok := delta["reasoning_content"].(string); ok && rc != "" {
						t.hasRecordedText = true
						t.FirstTextTime = time.Now()
						t.FirstTextMillis = time.Since(t.StartTime).Milliseconds()
					}
				}
			}
		}
	}

	// 2. OpenAI Chat Completions top-level usage
	if u, ok := obj["usage"].(map[string]any); ok {
		t.extractOpenAIUsage(u)
	}

	// 3. OpenAI Responses API (/v1/responses)
	if resp, ok := obj["response"].(map[string]any); ok {
		if u, ok := resp["usage"].(map[string]any); ok {
			t.extractResponsesUsage(u)
		}
		if st, ok := resp["status"].(string); ok && st != "" && t.StopReason == "" {
			t.StopReason = st
		}
	}

	// 4. Anthropic Messages API
	typ, _ := obj["type"].(string)
	switch typ {
	case "message_start":
		if msg, ok := obj["message"].(map[string]any); ok {
			if u, ok := msg["usage"].(map[string]any); ok {
				t.extractAnthropicUsage(u)
			}
		}
	case "message_delta":
		if u, ok := obj["usage"].(map[string]any); ok {
			t.extractAnthropicUsage(u)
		}
		if delta, ok := obj["delta"].(map[string]any); ok {
			if sr, ok := delta["stop_reason"].(string); ok && sr != "" {
				t.StopReason = sr
			}
		}
	case "content_block_delta", "content_block_start":
		if !t.hasRecordedText {
			t.hasRecordedText = true
			t.FirstTextTime = time.Now()
			t.FirstTextMillis = time.Since(t.StartTime).Milliseconds()
		}
	case "message":
		// Non-streaming Anthropic response
		if sr, ok := obj["stop_reason"].(string); ok && sr != "" {
			t.StopReason = sr
		}
		if u, ok := obj["usage"].(map[string]any); ok {
			t.extractAnthropicUsage(u)
		}
	}
}

func (t *StreamUsageTracker) extractOpenAIUsage(u map[string]any) {
	if pt := toInt(u["prompt_tokens"]); pt > t.InTokens {
		t.InTokens = pt
	}
	if ct := toInt(u["completion_tokens"]); ct > t.OutTokens {
		t.OutTokens = ct
	}
	if tt := toInt(u["total_tokens"]); tt > t.TotalTokens {
		t.TotalTokens = tt
	}
	if ptd, ok := u["prompt_tokens_details"].(map[string]any); ok {
		if cr := toInt(ptd["cached_tokens"]); cr > t.CacheReadTokens {
			t.CacheReadTokens = cr
		}
	}
	if ctd, ok := u["completion_tokens_details"].(map[string]any); ok {
		if rt := toInt(ctd["reasoning_tokens"]); rt > t.ReasoningTokens {
			t.ReasoningTokens = rt
		}
	}
}

func (t *StreamUsageTracker) extractResponsesUsage(u map[string]any) {
	if it := toInt(u["input_tokens"]); it > t.InTokens {
		t.InTokens = it
	}
	if ot := toInt(u["output_tokens"]); ot > t.OutTokens {
		t.OutTokens = ot
	}
	if tt := toInt(u["total_tokens"]); tt > t.TotalTokens {
		t.TotalTokens = tt
	}
	if itd, ok := u["input_tokens_details"].(map[string]any); ok {
		if cr := toInt(itd["cached_tokens"]); cr > t.CacheReadTokens {
			t.CacheReadTokens = cr
		}
	}
	if otd, ok := u["output_tokens_details"].(map[string]any); ok {
		if rt := toInt(otd["reasoning_tokens"]); rt > t.ReasoningTokens {
			t.ReasoningTokens = rt
		}
	}
}

func (t *StreamUsageTracker) extractAnthropicUsage(u map[string]any) {
	if it := toInt(u["input_tokens"]); it > t.InTokens {
		t.InTokens = it
	}
	if ot := toInt(u["output_tokens"]); ot > t.OutTokens {
		t.OutTokens = ot
	}
	if cr := toInt(u["cache_read_input_tokens"]); cr > t.CacheReadTokens {
		t.CacheReadTokens = cr
	}
	if cw := toInt(u["cache_creation_input_tokens"]); cw > t.CacheWriteTokens {
		t.CacheWriteTokens = cw
	}
	if cc, ok := u["cache_creation"].(map[string]any); ok {
		if c1h := toInt(cc["ephemeral_1h_input_tokens"]); c1h > t.CacheWrite1hTokens {
			t.CacheWrite1hTokens = c1h
		}
	}
	if c1h := toInt(u["cache_creation_1h_input_tokens"]); c1h > t.CacheWrite1hTokens {
		t.CacheWrite1hTokens = c1h
	}
	if c1h := toInt(u["ephemeral_1h_input_tokens"]); c1h > t.CacheWrite1hTokens {
		t.CacheWrite1hTokens = c1h
	}
}

// Finish flushes any trailing buffer and calculates final flow metrics.
func (t *StreamUsageTracker) Finish() {
	if len(t.tail) > 0 {
		t.FeedChunk([]byte("\n"))
		t.tail = nil
	}
	if t.TotalTokens == 0 && (t.InTokens > 0 || t.OutTokens > 0) {
		t.TotalTokens = t.InTokens + t.OutTokens
	}
	if !t.FirstTextTime.IsZero() {
		t.FlowMillis = time.Since(t.FirstTextTime).Milliseconds()
	} else if !t.FirstChunkTime.IsZero() {
		t.FlowMillis = time.Since(t.FirstChunkTime).Milliseconds()
	} else if t.TTFTMillis > 0 {
		total := time.Since(t.StartTime).Milliseconds()
		t.FlowMillis = total - t.TTFTMillis
	}
	if t.FlowMillis < 0 {
		t.FlowMillis = 0
	}
}

func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}
