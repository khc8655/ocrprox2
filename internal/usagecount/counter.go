// Package usagecount provides a deliberately tiny in-memory usage counter for
// Lite nodes. Lite must stay zero-disk and near-zero-RAM (no trace ring buffer,
// no usage.jsonl), but it still has to tell the hub which models it actually
// serves, so only rolling per-model counters are kept here.
package usagecount

import (
	"sync"
	"sync/atomic"

	"github.com/khc8655/llmproxy2/internal/types"
)

// Digest mirrors obs.UsageDigest so it can be serialized into the same
// X-Node-Usage header the hub already understands.
type Digest struct {
	Models    map[string]int `json:"models"`
	Requests  int            `json:"requests"`
	Successes int            `json:"successes"`
	Failed    int            `json:"failed"`
	InTokens  int            `json:"in_tokens"`
	OutTokens int            `json:"out_tokens"`
}

const maxModels = 64

// Counter implements types.ObservabilitySink with the smallest possible surface:
// traces and period queries are unimplemented because Lite never exposes them.
type Counter struct {
	mu        sync.Mutex
	models    map[string]int
	requests  int
	successes int
	failed    int
	inTokens  int
	outTokens int
	dropped   int64
}

// New creates an empty counter.
func New() *Counter {
	return &Counter{models: make(map[string]int, 8)}
}

// RecordRequest accumulates one finished request.
func (c *Counter) RecordRequest(trace types.RequestTrace) {
	model := trace.ServedModel
	if model == "" {
		model = trace.ReqModel
	}

	c.mu.Lock()
	c.requests++
	if trace.Status >= 200 && trace.Status < 300 {
		c.successes++
	} else {
		c.failed++
	}
	c.inTokens += trace.InTokens
	c.outTokens += trace.OutTokens
	if model != "" {
		if _, seen := c.models[model]; seen || len(c.models) < maxModels {
			c.models[model]++
		} else {
			c.dropped++
		}
	}
	c.mu.Unlock()
}

// RecentTraces is intentionally empty on Lite (no trace buffer by design).
func (c *Counter) RecentTraces(bool) []types.RequestTrace { return nil }

// QueryUsage is intentionally unsupported on Lite.
func (c *Counter) QueryUsage(string, string) (map[string]any, error) {
	return nil, nil
}

// Digest returns a copy of the current counters.
func (c *Counter) Digest() Digest {
	c.mu.Lock()
	defer c.mu.Unlock()
	models := make(map[string]int, len(c.models))
	for k, v := range c.models {
		models[k] = v
	}
	return Digest{
		Models:    models,
		Requests:  c.requests,
		Successes: c.successes,
		Failed:    c.failed,
		InTokens:  c.inTokens,
		OutTokens: c.outTokens,
	}
}

// DroppedModels reports how many distinct models were not tracked because the
// per-process cap was reached (for diagnostics only).
func (c *Counter) DroppedModels() int64 { return atomic.LoadInt64(&c.dropped) }
