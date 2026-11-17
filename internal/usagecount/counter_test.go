package usagecount

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestCounter_Cap64AndConcurrentRaceFree(t *testing.T) {
	c := New()

	// Pre-populate 64 distinct models
	for i := 0; i < maxTrackedModels; i++ {
		c.RecordRequest(types.RequestTrace{
			ServedModel: fmt.Sprintf("model-%02d", i),
			Status:      200,
			InTokens:    10,
			OutTokens:   5,
		})
	}
	if got := c.DroppedModels(); got != 0 {
		t.Fatalf("expected 0 dropped models at cap=%d, got %d", maxTrackedModels, got)
	}

	// Concurrent overflow + reads of DroppedModels() and Digest() under -race
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				c.RecordRequest(types.RequestTrace{
					ServedModel: fmt.Sprintf("overflow-%d-%d", id, j),
					Status:      200,
					InTokens:    1,
					OutTokens:   1,
				})
				_ = c.DroppedModels()
				_ = c.Digest()
			}
		}(g)
	}
	wg.Wait()

	d := c.Digest()
	if len(d.Models) != maxTrackedModels || len(d.ModelStats) != maxTrackedModels {
		t.Fatalf("expected tracked models capped at %d, got models=%d stats=%d", maxTrackedModels, len(d.Models), len(d.ModelStats))
	}
	if got := c.DroppedModels(); got != 16*20 {
		t.Fatalf("expected %d dropped overflow recordings, got %d", 16*20, got)
	}
	if d.Requests != int64(maxTrackedModels+16*20) {
		t.Fatalf("expected total requests %d, got %d", maxTrackedModels+16*20, d.Requests)
	}
}

func TestCounter_PerModelSuccessFailAndTokens(t *testing.T) {
	c := New()

	// Healthy model: 2 successes
	c.RecordUsage(types.RequestTrace{
		ReqModel:    "gpt-4o",
		ServedModel: "gpt-4o",
		Status:      200,
		InTokens:    120,
		OutTokens:   60,
	})
	c.RecordUsage(types.RequestTrace{
		ReqModel:    "gpt-4o",
		ServedModel: "gpt-4o",
		Status:      200,
		InTokens:    80,
		OutTokens:   40,
	})

	// 100% failing model (HTTP 400): must record 0 successes, 1 failed, 0 tokens (never prorated from gpt-4o!)
	c.RecordUsage(types.RequestTrace{
		ReqModel: "broken-model",
		Status:   400,
	})

	// Partially failing model: 1 success, 1 HTTP 502 failure
	c.RecordUsage(types.RequestTrace{
		ServedModel: "claude-sonnet-4",
		Status:      200,
		InTokens:    300,
		OutTokens:   150,
	})
	c.RecordUsage(types.RequestTrace{
		ReqModel: "claude-sonnet-4",
		Status:   502,
	})

	d := c.Digest()
	if d.Requests != 5 || d.Successes != 3 || d.Failed != 2 {
		t.Fatalf("unexpected node totals: %+v", d)
	}
	if d.InTokens != 500 || d.OutTokens != 250 {
		t.Fatalf("unexpected node tokens: in=%d out=%d", d.InTokens, d.OutTokens)
	}

	// Backward-compatible Models call map
	if d.Models["gpt-4o"] != 2 || d.Models["broken-model"] != 1 || d.Models["claude-sonnet-4"] != 2 {
		t.Fatalf("unexpected legacy Models map: %+v", d.Models)
	}

	// Exact per-model ModelStats assertions
	gpt := d.ModelStats["gpt-4o"]
	if gpt.Calls != 2 || gpt.Successes != 2 || gpt.Failed != 0 || gpt.InTokens != 200 || gpt.OutTokens != 100 {
		t.Errorf("unexpected gpt-4o ModelStat: %+v", gpt)
	}

	broken := d.ModelStats["broken-model"]
	if broken.Calls != 1 || broken.Successes != 0 || broken.Failed != 1 || broken.InTokens != 0 || broken.OutTokens != 0 {
		t.Errorf("expected broken-model 0/1 success/fail and 0 tokens, got %+v", broken)
	}

	claude := d.ModelStats["claude-sonnet-4"]
	if claude.Calls != 2 || claude.Successes != 1 || claude.Failed != 1 || claude.InTokens != 300 || claude.OutTokens != 150 {
		t.Errorf("unexpected claude-sonnet-4 ModelStat: %+v", claude)
	}

	// Verify JSON serialization contains model_stats
	raw, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("json.Marshal Digest error: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("json.Unmarshal Digest error: %v", err)
	}
	msMap, ok := decoded["model_stats"].(map[string]any)
	if !ok || msMap["broken-model"] == nil {
		t.Fatalf("expected model_stats.broken-model in JSON output, got %s", string(raw))
	}
}
