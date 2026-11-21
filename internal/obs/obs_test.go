package obs

import (
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestScrub(t *testing.T) {
	tests := []struct {
		input      string
		mustNotSee string
	}{
		{"Authorization: Bearer sk-1234567890abcdef", "sk-1234567890abcdef"},
		{"nvidia error key nvapi-1234567890abcdef", "nvapi-1234567890abcdef"},
		{"groq error key gsk_1234567890abcdef", "gsk_1234567890abcdef"},
		{"xai error key xai-1234567890abcdef", "xai-1234567890abcdef"},
		{"pplx error key pplx-1234567890abcdef", "pplx-1234567890abcdef"},
		{"https://api.openai.com/v1?key=AIzaSyA12345678901234567890", "AIzaSyA12345678901234567890"},
		{"https://generativelanguage.googleapis.com/v1beta/models?key=shortSecretKey99&alt=sse", "shortSecretKey99"},
		{"node_token=stk_node_0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"},
		{"X-Api-Key: custom-secret-value-1234", "custom-secret-value-1234"},
		{"x-goog-api-key=goog-secret-9988", "goog-secret-9988"},
		{`{"api-key": "azure-secret-key-0011"}`, "azure-secret-key-0011"},
		{"Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"},
	}

	for _, tc := range tests {
		got := ScrubString(tc.input)
		if !strings.Contains(got, "…") {
			t.Errorf("Scrub(%q) did not mask secret, got %q", tc.input, got)
		}
		if strings.Contains(got, tc.mustNotSee) {
			t.Errorf("Scrub(%q) leaked %q in %q", tc.input, tc.mustNotSee, got)
		}
	}
}

func TestScrubWithSecrets(t *testing.T) {
	rawInput := "upstream error: invalid key my-raw-provider-secret-99887766 for ok1"
	got := ScrubStringWithSecrets(rawInput, "my-raw-provider-secret-99887766", "ok1", "short")
	if strings.Contains(got, "my-raw-provider-secret-99887766") {
		t.Fatalf("expected ScrubStringWithSecrets to mask arbitrary secret, got %q", got)
	}
	if !strings.Contains(got, "ok1") {
		t.Fatalf("expected ScrubStringWithSecrets to ignore short strings (<8 chars), got %q", got)
	}
	if !strings.Contains(got, "…") {
		t.Fatalf("expected ScrubStringWithSecrets output to contain ellipsis marker, got %q", got)
	}

	// Ensure caller byte slice is not mutated when secret is masked
	orig := []byte("echoed my-raw-provider-secret-99887766 in error")
	origCopy := append([]byte(nil), orig...)
	scrubbed := ScrubWithSecrets(orig, "my-raw-provider-secret-99887766")
	if strings.Contains(string(scrubbed), "my-raw-provider-secret-99887766") {
		t.Fatalf("expected ScrubWithSecrets to mask secret, got %q", string(scrubbed))
	}
	if string(orig) != string(origCopy) {
		t.Fatalf("expected ScrubWithSecrets not to mutate caller buffer")
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

func TestUsage_NonStreamTPSNeverInflated(t *testing.T) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager error: %v", err)
	}
	defer mgr.Close()

	now := time.Now().Unix()

	// Non-streaming request where TotalMillis=1836 and TTFTMillis=1835 (1ms apart) with 20 OutTokens.
	// Must use TotalMillis (1.836s) -> ~10.89 tok/s, NEVER (1836-1835)=1ms -> 20000.0 tok/s!
	mgr.RecordRequest(types.RequestTrace{
		ID:             "req-nonstream-tps",
		Timestamp:      now,
		Mode:           "agent",
		Endpoint:       "/v1/chat/completions",
		ReqModel:       "gpt-4o",
		ServedModel:    "gpt-4o",
		WinnerProvider: "openai",
		WinnerKey:      "k1",
		Status:         200,
		Stream:         false,
		InTokens:       50,
		OutTokens:      20,
		TTFTMillis:     1835,
		FlowMillis:     0,
		TotalMillis:    1836,
		Tries:          []types.Try{{Attempt: 1, Status: 200}},
	})

	stats, err := mgr.QueryUsage("today", "UTC")
	if err != nil {
		t.Fatalf("QueryUsage error: %v", err)
	}

	totals := stats["totals"].(map[string]any)
	tps, ok := totals["tps"].(float64)
	if !ok {
		t.Fatalf("expected float64 tps, got %T", totals["tps"])
	}
	// 20 / 1.836 = 10.8932 -> 10.89
	if tps < 10.5 || tps > 11.5 {
		t.Fatalf("expected realistic non-streaming TPS ~10.89 tok/s, got %v", tps)
	}

	// Also verify streaming request with tiny post-TTFT delta (< 20ms) falls back to TotalMillis
	mgr2, err := NewManager(types.RoleLite, "")
	if err != nil {
		t.Fatalf("NewManager lite error: %v", err)
	}
	defer mgr2.Close()

	mgr2.RecordRequest(types.RequestTrace{
		ID:          "req-burst-stream",
		Timestamp:   now,
		Mode:        "agent",
		ReqModel:    "gpt-4o",
		ServedModel: "gpt-4o",
		Status:      200,
		Stream:      true,
		OutTokens:   20,
		TTFTMillis:  1830,
		FlowMillis:  5,
		TotalMillis: 1836,
	})
	stats2, err := mgr2.QueryUsage("today", "UTC")
	if err != nil {
		t.Fatalf("QueryUsage lite error: %v", err)
	}
	tps2 := stats2["totals"].(map[string]any)["tps"].(float64)
	if tps2 < 10.5 || tps2 > 11.5 {
		t.Fatalf("expected burst stream (<20ms delta) TPS ~10.89 tok/s, got %v", tps2)
	}

	// Verify genuine streaming request (TTFT=200ms, Total=1200ms -> 1000ms generation for 60 tokens = 60 tok/s)
	mgr3, _ := NewManager(types.RoleLite, "")
	defer mgr3.Close()
	mgr3.RecordRequest(types.RequestTrace{
		ID:          "req-real-stream",
		Timestamp:   now,
		Mode:        "agent",
		ReqModel:    "gpt-4o",
		ServedModel: "gpt-4o",
		Status:      200,
		Stream:      true,
		OutTokens:   60,
		TTFTMillis:  200,
		TotalMillis: 1200,
	})
	stats3, _ := mgr3.QueryUsage("today", "UTC")
	tps3 := stats3["totals"].(map[string]any)["tps"].(float64)
	if tps3 != 60.0 {
		t.Fatalf("expected streaming TPS 60.0 tok/s, got %v", tps3)
	}
}
