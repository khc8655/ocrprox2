package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestStreamUsageTracker_OpenAIChat(t *testing.T) {
	reqStart := time.Now().Add(-100 * time.Millisecond)
	tracker := NewStreamUsageTracker(reqStart, 50)

	chunk1 := []byte("data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello \"}}]}\n\n")
	chunk2 := []byte("data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"world!\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":15,\"completion_tokens\":35,\"total_tokens\":50,\"prompt_tokens_details\":{\"cached_tokens\":10},\"completion_tokens_details\":{\"reasoning_tokens\":12}}}\n\n")
	chunk3 := []byte("data: [DONE]\n\n")

	tracker.FeedChunk(chunk1)
	tracker.FeedChunk(chunk2)
	tracker.FeedChunk(chunk3)
	tracker.Finish()

	if tracker.InTokens != 15 {
		t.Errorf("expected InTokens 15, got %d", tracker.InTokens)
	}
	if tracker.OutTokens != 35 {
		t.Errorf("expected OutTokens 35, got %d", tracker.OutTokens)
	}
	if tracker.TotalTokens != 50 {
		t.Errorf("expected TotalTokens 50, got %d", tracker.TotalTokens)
	}
	if tracker.CacheReadTokens != 10 {
		t.Errorf("expected CacheReadTokens 10, got %d", tracker.CacheReadTokens)
	}
	if tracker.ReasoningTokens != 12 {
		t.Errorf("expected ReasoningTokens 12, got %d", tracker.ReasoningTokens)
	}
	if tracker.StopReason != "stop" {
		t.Errorf("expected StopReason 'stop', got %q", tracker.StopReason)
	}
	if tracker.TTFTMillis != 50 {
		t.Errorf("expected TTFTMillis 50, got %d", tracker.TTFTMillis)
	}
}

func TestStreamUsageTracker_OpenAIResponses(t *testing.T) {
	reqStart := time.Now().Add(-80 * time.Millisecond)
	tracker := NewStreamUsageTracker(reqStart, 40)

	chunk1 := []byte("data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"text\",\"text\":\"response output\"}]}}\n\n")
	chunk2 := []byte("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":20,\"output_tokens\":40,\"total_tokens\":60,\"input_tokens_details\":{\"cached_tokens\":8},\"output_tokens_details\":{\"reasoning_tokens\":16}}}}\n\n")

	tracker.FeedChunk(chunk1)
	tracker.FeedChunk(chunk2)
	tracker.Finish()

	if tracker.InTokens != 20 {
		t.Errorf("expected InTokens 20, got %d", tracker.InTokens)
	}
	if tracker.OutTokens != 40 {
		t.Errorf("expected OutTokens 40, got %d", tracker.OutTokens)
	}
	if tracker.TotalTokens != 60 {
		t.Errorf("expected TotalTokens 60, got %d", tracker.TotalTokens)
	}
	if tracker.CacheReadTokens != 8 {
		t.Errorf("expected CacheReadTokens 8, got %d", tracker.CacheReadTokens)
	}
	if tracker.ReasoningTokens != 16 {
		t.Errorf("expected ReasoningTokens 16, got %d", tracker.ReasoningTokens)
	}
	if tracker.StopReason != "completed" {
		t.Errorf("expected StopReason 'completed', got %q", tracker.StopReason)
	}
}

func TestStreamUsageTracker_AnthropicMessages(t *testing.T) {
	reqStart := time.Now().Add(-120 * time.Millisecond)
	tracker := NewStreamUsageTracker(reqStart, 60)

	chunk1 := []byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":30,\"cache_read_input_tokens\":15,\"cache_creation_input_tokens\":10,\"cache_creation\":{\"ephemeral_1h_input_tokens\":5}}}}\n\n")
	chunk2 := []byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Anthropic text response.\"}}\n\n")
	chunk3 := []byte("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":50}}\n\n")

	tracker.FeedChunk(chunk1)
	tracker.FeedChunk(chunk2)
	tracker.FeedChunk(chunk3)
	tracker.Finish()

	if tracker.InTokens != 30 {
		t.Errorf("expected InTokens 30, got %d", tracker.InTokens)
	}
	if tracker.OutTokens != 50 {
		t.Errorf("expected OutTokens 50, got %d", tracker.OutTokens)
	}
	if tracker.CacheReadTokens != 15 {
		t.Errorf("expected CacheReadTokens 15, got %d", tracker.CacheReadTokens)
	}
	if tracker.CacheWriteTokens != 10 {
		t.Errorf("expected CacheWriteTokens 10, got %d", tracker.CacheWriteTokens)
	}
	if tracker.CacheWrite1hTokens != 5 {
		t.Errorf("expected CacheWrite1hTokens 5, got %d", tracker.CacheWrite1hTokens)
	}
	if tracker.StopReason != "end_turn" {
		t.Errorf("expected StopReason 'end_turn', got %q", tracker.StopReason)
	}
}

func TestStreamUsageTracker_ChunkFragmentations(t *testing.T) {
	reqStart := time.Now()
	tracker := NewStreamUsageTracker(reqStart, 30)

	// Break SSE lines in the middle of a JSON string
	p1 := []byte("data: {\"type\":\"message_st")
	p2 := []byte("art\",\"message\":{\"usage\":{\"input_tokens\":42,")
	p3 := []byte("\"cache_read_input_tokens\":21}}}\n\n")
	p4 := []byte("data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"},\"usage\":{\"output_tokens\":84}}\n\n")

	tracker.FeedChunk(p1)
	tracker.FeedChunk(p2)
	tracker.FeedChunk(p3)
	tracker.FeedChunk(p4)
	tracker.Finish()

	if tracker.InTokens != 42 {
		t.Errorf("expected InTokens 42, got %d", tracker.InTokens)
	}
	if tracker.OutTokens != 84 {
		t.Errorf("expected OutTokens 84, got %d", tracker.OutTokens)
	}
	if tracker.CacheReadTokens != 21 {
		t.Errorf("expected CacheReadTokens 21, got %d", tracker.CacheReadTokens)
	}
	if tracker.StopReason != "max_tokens" {
		t.Errorf("expected StopReason 'max_tokens', got %q", tracker.StopReason)
	}
}

type recordSink struct {
	traces []types.RequestTrace
}

func (s *recordSink) RecordRequest(trace types.RequestTrace) {
	s.traces = append(s.traces, trace)
}
func (s *recordSink) RecentTraces(onlyFailedOrRetried bool) []types.RequestTrace {
	return s.traces
}
func (s *recordSink) QueryUsage(period string, tzName string) (map[string]any, error) {
	return nil, nil
}

func TestScheduler_Streaming_TraceMetricsRecorded(t *testing.T) {
	// Upstream server streaming OpenAI Chat with usage
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)

		time.Sleep(5 * time.Millisecond)

		// First event
		_, _ = w.Write([]byte("data: {\"id\":\"chatcmpl-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"streaming test response\"}}]}\n\n"))
		if flusher != nil {
			flusher.Flush()
		}

		time.Sleep(10 * time.Millisecond)

		// Final event with usage and finish_reason
		_, _ = w.Write([]byte("data: {\"id\":\"chatcmpl-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":18,\"completion_tokens\":42,\"total_tokens\":60,\"prompt_tokens_details\":{\"cached_tokens\":9},\"completion_tokens_details\":{\"reasoning_tokens\":14}}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer upstreamServer.Close()

	sink := &recordSink{}
	providers := map[string]*types.ProviderConfig{
		"test-prov": {
			ID:      "test-prov",
			BaseURL: upstreamServer.URL,
			Enabled: true,
			APIKeys: []*types.KeyEntry{
				{ID: "k1", Label: "k1", Key: "test-key-1", Enabled: true},
			},
		},
	}
	routes := map[string]*types.AgentModelRoute{
		"test-model": {
			Enabled: true,
			Candidates: []*types.RouteCandidate{
				{Provider: "test-prov", KeyLabel: "k1", Enabled: true},
			},
		},
	}

	cfg := &types.ProxyConfig{
		Providers:   providers,
		AgentModels: routes,
	}
	sched := NewScheduler(&mockConfigSource{config: cfg}, sink, true)

	reqBody := []byte(`{"model":"test-model","stream":true,"messages":[{"role":"user","content":"hello"}]}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(reqBody)))
	ctx := context.Background()

	err := sched.Dispatch(ctx, "/v1/chat/completions", reqBody, "test-model", true, rec, req)
	if err != nil {
		t.Fatalf("unexpected dispatch error: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}

	if len(sink.traces) != 1 {
		t.Fatalf("expected 1 trace recorded in sink, got %d", len(sink.traces))
	}

	tr := sink.traces[0]
	if tr.InTokens != 18 {
		t.Errorf("expected InTokens 18, got %d", tr.InTokens)
	}
	if tr.OutTokens != 42 {
		t.Errorf("expected OutTokens 42, got %d", tr.OutTokens)
	}
	if tr.CacheReadTokens != 9 {
		t.Errorf("expected CacheReadTokens 9, got %d", tr.CacheReadTokens)
	}
	if tr.ReasoningTokens != 14 {
		t.Errorf("expected ReasoningTokens 14, got %d", tr.ReasoningTokens)
	}
	if tr.StopReason != "stop" {
		t.Errorf("expected StopReason 'stop', got %q", tr.StopReason)
	}
	if tr.TTFTMillis <= 0 {
		t.Errorf("expected positive TTFTMillis, got %d", tr.TTFTMillis)
	}
}
