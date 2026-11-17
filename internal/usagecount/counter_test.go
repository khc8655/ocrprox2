package usagecount

import (
	"fmt"
	"sync"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestCounter_Cap64AndConcurrentRaceFree(t *testing.T) {
	c := New()

	// Pre-populate 64 distinct models
	for i := 0; i < maxModels; i++ {
		c.RecordRequest(types.RequestTrace{
			ServedModel: fmt.Sprintf("model-%02d", i),
			Status:      200,
			InTokens:    10,
			OutTokens:   5,
		})
	}
	if got := c.DroppedModels(); got != 0 {
		t.Fatalf("expected 0 dropped models at cap=%d, got %d", maxModels, got)
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
	if len(d.Models) != maxModels {
		t.Fatalf("expected tracked models capped at %d, got %d", maxModels, len(d.Models))
	}
	if got := c.DroppedModels(); got != 16*20 {
		t.Fatalf("expected %d dropped overflow recordings, got %d", 16*20, got)
	}
	if d.Requests != maxModels+16*20 {
		t.Fatalf("expected total requests %d, got %d", maxModels+16*20, d.Requests)
	}
}
