package obs

import (
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func BenchmarkQueryUsage_10kRecords(b *testing.B) {
	dir := b.TempDir()
	mgr, err := NewManager(types.RoleFull, dir)
	if err != nil {
		b.Fatalf("NewManager: %v", err)
	}
	defer mgr.Close()

	now := time.Now().Unix()
	for i := 0; i < 10000; i++ {
		mgr.RecordRequest(types.RequestTrace{
			ID:             "bench",
			Timestamp:      now - int64(i%86400*14),
			Mode:           "agent",
			Endpoint:       "/v1/chat/completions",
			ReqModel:       "claude-sonnet-4",
			ServedModel:    "claude-sonnet-4",
			WinnerProvider: "anthropic",
			WinnerKey:      "k1",
			Status:         200,
			InTokens:       500,
			OutTokens:      120,
			TTFTMillis:     180,
			FlowMillis:     600,
			TotalMillis:    780,
			Tries:          []types.Try{{Attempt: 1, Provider: "anthropic", KeyID: "k1", Status: 200}},
		})
	}
	if err := mgr.Flush(); err != nil {
		b.Fatalf("Flush: %v", err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := mgr.QueryUsage("30d", "Asia/Shanghai"); err != nil {
			b.Fatalf("QueryUsage: %v", err)
		}
	}
}

func BenchmarkLiteObs_NilSink(b *testing.B) {
	var sink types.ObservabilitySink
	tr := types.RequestTrace{
		ID:             "lite-1",
		Timestamp:      time.Now().Unix(),
		WinnerProvider: "openai",
		WinnerKey:      "k1",
		Status:         200,
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if sink != nil {
			sink.RecordRequest(tr)
		}
	}
}
