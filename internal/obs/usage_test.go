package obs

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestUsage_AsyncWriter_NoDataLossAfterFlush(t *testing.T) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager error: %v", err)
	}
	defer mgr.Close()

	now := time.Now().Unix()
	const numRecords = 200

	for i := 0; i < numRecords; i++ {
		mgr.RecordRequest(types.RequestTrace{
			ID:                 "req-trace",
			Timestamp:          now,
			Mode:               "agent",
			Endpoint:           "/v1/chat/completions",
			ReqModel:           "gpt-4o",
			ServedModel:        "gpt-4o-2024-05-13",
			WinnerProvider:     "openai",
			WinnerKey:          "key-01",
			Status:             200,
			InTokens:           100,
			OutTokens:          50,
			CacheReadTokens:    25,
			CacheWriteTokens:   15,
			CacheWrite1hTokens: 5,
			FlowMillis:         1000, // 50 out tokens in 1s = 50 tok/s TPS
			TotalMillis:        1200,
			TTFTMillis:         200,
			Tries:              []types.Try{{Attempt: 1, Status: 200}},
		})
	}

	// Flush to disk
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush error: %v", err)
	}

	// Read usage.jsonl directly from disk and verify all 200 lines were written
	ledgerFile := filepath.Join(tmpDir, "usage.jsonl")
	f, err := os.Open(ledgerFile)
	if err != nil {
		t.Fatalf("Open usage.jsonl err: %v", err)
	}
	defer f.Close()

	lineCount := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		lineCount++
		var rec UsageRecord
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			t.Fatalf("invalid json line %d: %v", lineCount, err)
		}
		if rec.OutTokens != 50 || rec.CacheWriteTokens != 15 || rec.FlowMillis != 1000 {
			t.Errorf("unexpected record contents: %+v", rec)
		}
	}
	if lineCount != numRecords {
		t.Fatalf("expected %d records written to disk, got %d", numRecords, lineCount)
	}
}

func TestUsage_LiteMode_ZeroDiskWrites(t *testing.T) {
	// Lite mode with empty dataDir
	mgr, err := NewManager(types.RoleLite, "")
	if err != nil {
		t.Fatalf("NewManager error: %v", err)
	}
	defer mgr.Close()

	mgr.RecordRequest(types.RequestTrace{
		ID:          "lite-req",
		Timestamp:   time.Now().Unix(),
		Mode:        "agent",
		Endpoint:    "/v1/messages",
		ReqModel:    "claude-3-5-sonnet",
		ServedModel: "claude-3-5-sonnet-20241022",
		Status:      200,
		InTokens:    100,
		OutTokens:   200,
	})

	stats, err := mgr.QueryUsage("today", "UTC")
	if err != nil {
		t.Fatalf("QueryUsage error: %v", err)
	}

	totals := stats["totals"].(map[string]any)
	if totals["requests"] != 1 {
		t.Errorf("expected 1 request in memory for Lite mode, got %v", totals["requests"])
	}
}

func TestUsage_TPS_CacheHitRate_Series_Heatmap(t *testing.T) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager error: %v", err)
	}
	defer mgr.Close()

	loc := time.UTC
	now := time.Now().In(loc)

	// Record 1: 100 in, 50 out, 50 cache read, FlowMillis 500ms -> TPS = 50 / 0.5s = 100 tok/s
	mgr.RecordRequest(types.RequestTrace{
		ID:               "req-1",
		Timestamp:        now.Unix(),
		Mode:             "agent",
		Endpoint:         "/v1/chat/completions",
		ReqModel:         "claude-3-7-sonnet",
		ServedModel:      "claude-3-7-sonnet-20250219",
		WinnerProvider:   "anthropic",
		WinnerKey:        "ant-key-1",
		Status:           200,
		InTokens:         100,
		OutTokens:        50,
		CacheReadTokens:  50,
		CacheWriteTokens: 20,
		TTFTMillis:       200,
		FlowMillis:       500,
		TotalMillis:      700,
		Tries:            []types.Try{{Attempt: 1, Status: 200}},
	})

	// Record 2: 200 in, 100 out, 0 cache read, FlowMillis 1000ms -> TPS = 100 / 1.0s = 100 tok/s
	mgr.RecordRequest(types.RequestTrace{
		ID:               "req-2",
		Timestamp:        now.Unix(),
		Mode:             "agent",
		Endpoint:         "/v1/chat/completions",
		ReqModel:         "claude-3-7-sonnet",
		ServedModel:      "claude-3-7-sonnet-20250219",
		WinnerProvider:   "anthropic",
		WinnerKey:        "ant-key-1",
		Status:           200,
		InTokens:         200,
		OutTokens:        100,
		CacheReadTokens:  0,
		CacheWriteTokens: 0,
		TTFTMillis:       300,
		FlowMillis:       1000,
		TotalMillis:      1300,
		Tries:            []types.Try{{Attempt: 1, Status: 200}},
	})

	// 1. Check Today (hourly buckets)
	statsToday, err := mgr.QueryUsage("today", "UTC")
	if err != nil {
		t.Fatalf("QueryUsage today err: %v", err)
	}

	totals := statsToday["totals"].(map[string]any)
	if totals["requests"] != 2 {
		t.Errorf("expected 2 requests, got %v", totals["requests"])
	}

	// TPS calculation: (50 + 100) / (0.5s + 1.0s) = 150 / 1.5s = 100 tok/s
	tpsVal, ok := totals["tps"].(float64)
	if !ok || tpsVal != 100.0 {
		t.Errorf("expected TPS 100.0, got %v", totals["tps"])
	}
	if totals["tok_per_sec"] != 100.0 {
		t.Errorf("expected tok_per_sec 100.0, got %v", totals["tok_per_sec"])
	}

	// Cache hit rate calculation:
	// cache_read = 50, in_tokens = 300, totalPrompt = 350 -> 50 / 350 = ~0.1429
	hitRate, ok := totals["cache_hit_rate"].(float64)
	if !ok || hitRate < 0.14 || hitRate > 0.15 {
		t.Errorf("expected cache_hit_rate ~0.1429, got %v", totals["cache_hit_rate"])
	}

	// Series for "today" must have 24 hourly points
	if statsToday["bucket"] != "hour" {
		t.Errorf("expected bucket 'hour', got %v", statsToday["bucket"])
	}
	seriesToday, ok := statsToday["series"].([]SeriesPoint)
	if !ok {
		t.Fatalf("expected []SeriesPoint, got %T", statsToday["series"])
	}
	if len(seriesToday) != 24 {
		t.Fatalf("expected 24 hourly series points, got %d", len(seriesToday))
	}
	currentHour := now.Hour()
	if seriesToday[currentHour].Requests != 2 {
		t.Errorf("expected 2 requests in hour %d bucket, got %d", currentHour, seriesToday[currentHour].Requests)
	}

	// 2. Check 7d (daily buckets)
	stats7d, err := mgr.QueryUsage("7d", "UTC")
	if err != nil {
		t.Fatalf("QueryUsage 7d err: %v", err)
	}
	if stats7d["bucket"] != "day" {
		t.Errorf("expected bucket 'day' for 7d, got %v", stats7d["bucket"])
	}
	series7d, ok := stats7d["series"].([]SeriesPoint)
	if !ok || len(series7d) != 7 {
		t.Fatalf("expected 7 daily series points, got %d", len(series7d))
	}

	// 3. Check Heatmap (53 weeks)
	heatmap, ok := statsToday["heatmap"].(Heatmap)
	if !ok {
		t.Fatalf("expected Heatmap struct, got %T", statsToday["heatmap"])
	}
	if heatmap.From == "" || heatmap.To == "" {
		t.Errorf("heatmap From or To is empty: %+v", heatmap)
	}
	if len(heatmap.Days) == 0 {
		t.Errorf("expected at least 1 day with calls in heatmap, got %d", len(heatmap.Days))
	} else {
		todayStr := now.Format("2006-01-02")
		foundToday := false
		for _, d := range heatmap.Days {
			if d.Date == todayStr {
				foundToday = true
				if d.Calls != 2 {
					t.Errorf("expected 2 calls on today in heatmap, got %d", d.Calls)
				}
			}
		}
		if !foundToday {
			t.Errorf("did not find today %s in heatmap days: %+v", todayStr, heatmap.Days)
		}
	}
}
