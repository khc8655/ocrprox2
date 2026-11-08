package obs

import (
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestScrub(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"Authorization: Bearer sk-1234567890abcdef", "Bearer …"},
		{"https://api.openai.com/v1?key=AIzaSyA12345678901234567890", "key=…"},
		{"Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "Bearer …"},
	}

	for _, tc := range tests {
		got := ScrubString(tc.input)
		if !strings.Contains(got, "…") {
			t.Errorf("Scrub(%q) did not mask secret, got %q", tc.input, got)
		}
	}
}

func TestTraceBuffer(t *testing.T) {
	tb := NewTraceBuffer()
	for i := 1; i <= 70; i++ {
		tb.Record(types.RequestTrace{
			ID:     string(rune('A' + (i % 26))),
			Status: 200,
		})
	}

	recent := tb.Recent(false)
	if len(recent) != TraceCapacity {
		t.Fatalf("expected %d traces, got %d", TraceCapacity, len(recent))
	}
}

func TestUsageManager_FullMode(t *testing.T) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager error: %v", err)
	}
	defer mgr.Close()

	now := time.Now().Unix()
	// Record a success request (not retried)
	mgr.RecordRequest(types.RequestTrace{
		ID:              "req-1",
		Timestamp:       now,
		Mode:            "agent",
		Endpoint:        "/v1/chat/completions",
		ReqModel:        "gpt-4o",
		ServedModel:     "gpt-4o-2024-05-13",
		WinnerProvider:  "openai",
		WinnerKey:       "hk-01",
		Status:          200,
		InTokens:        100,
		OutTokens:       50,
		CacheReadTokens: 20,
		ReasoningTokens: 10,
		TTFTMillis:      150,
		TotalMillis:     500,
		Tries:           []types.Try{{Attempt: 1, Status: 200}},
	})

	// Record a retried request that failed with 500
	mgr.RecordRequest(types.RequestTrace{
		ID:            "req-2",
		Timestamp:     now,
		Mode:          "agent",
		Endpoint:      "/v1/chat/completions",
		ReqModel:      "gpt-4o",
		ServedModel:   "gpt-4o-2024-05-13",
		WinnerProvider:"openai",
		WinnerKey:     "hk-02",
		Status:        500,
		InTokens:      80,
		OutTokens:     0,
		TTFTMillis:    250,
		TotalMillis:   700,
		RetriedMillis: 300,
		Tries: []types.Try{
			{Attempt: 1, Status: 429, Reason: "rate_limit"},
			{Attempt: 2, Status: 500, Reason: "server_error"},
		},
	})

	stats, err := mgr.QueryUsage("today", "UTC")
	if err != nil {
		t.Fatalf("QueryUsage error: %v", err)
	}

	// 1. Top-level contract assertions
	if stats["ok"] != true {
		t.Errorf("expected ok=true, got %v", stats["ok"])
	}
	if stats["period"] != "today" {
		t.Errorf("expected period=today, got %v", stats["period"])
	}
	if stats["tz"] != "UTC" {
		t.Errorf("expected tz=UTC, got %v", stats["tz"])
	}

	// 2. Backward-compatible summary assertions
	summary, ok := stats["summary"].(map[string]any)
	if !ok {
		t.Fatalf("expected summary map, got %T", stats["summary"])
	}
	if summary["total_requests"] != 2 {
		t.Errorf("expected 2 requests in summary, got %v", summary["total_requests"])
	}
	if summary["success_requests"] != 1 {
		t.Errorf("expected 1 success request in summary, got %v", summary["success_requests"])
	}
	if summary["total_in_tokens"] != 180 {
		t.Errorf("expected 180 total_in_tokens, got %v", summary["total_in_tokens"])
	}
	if summary["total_out_tokens"] != 50 {
		t.Errorf("expected 50 total_out_tokens, got %v", summary["total_out_tokens"])
	}

	// 3. New contract totals assertions
	totals, ok := stats["totals"].(map[string]any)
	if !ok {
		t.Fatalf("expected totals map, got %T", stats["totals"])
	}
	if totals["requests"] != 2 {
		t.Errorf("expected totals.requests == 2, got %v", totals["requests"])
	}
	if totals["success"] != 1 {
		t.Errorf("expected totals.success == 1, got %v", totals["success"])
	}
	if totals["failed"] != 1 {
		t.Errorf("expected totals.failed == 1, got %v", totals["failed"])
	}
	if totals["retried_requests"] != 1 {
		t.Errorf("expected totals.retried_requests == 1, got %v", totals["retried_requests"])
	}
	if totals["input_tokens"] != 180 {
		t.Errorf("expected totals.input_tokens == 180, got %v", totals["input_tokens"])
	}
	if totals["output_tokens"] != 50 {
		t.Errorf("expected totals.output_tokens == 50, got %v", totals["output_tokens"])
	}
	if totals["cache_read_tokens"] != 20 {
		t.Errorf("expected totals.cache_read_tokens == 20, got %v", totals["cache_read_tokens"])
	}
	if totals["reasoning_tokens"] != 10 {
		t.Errorf("expected totals.reasoning_tokens == 10, got %v", totals["reasoning_tokens"])
	}
	// avg_ttft_ms: (150 + 250) / 2 = 200
	if totals["avg_ttft_ms"] != int64(200) {
		t.Errorf("expected totals.avg_ttft_ms == 200, got %v", totals["avg_ttft_ms"])
	}
	// avg_total_ms: (500 + 700) / 2 = 600
	if totals["avg_total_ms"] != int64(600) {
		t.Errorf("expected totals.avg_total_ms == 600, got %v", totals["avg_total_ms"])
	}
}
