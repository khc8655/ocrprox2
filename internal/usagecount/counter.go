// Package usagecount provides a deliberately tiny in-memory usage counter for
// Lite nodes. Lite must stay zero-disk and near-zero-RAM (no trace ring buffer,
// no usage.jsonl), but it still has to tell the hub which models it actually
// serves and their exact per-model success/failure/token breakdown.
package usagecount

import (
	"sync"
	"sync/atomic"

	"github.com/khc8655/llmproxy2/internal/types"
)

// ModelStat holds exact per-model counters within the bounded 64-model table.
type ModelStat struct {
	Calls     int64 `json:"calls"`
	Successes int64 `json:"successes"`
	Failed    int64 `json:"failed"`
	InTokens  int64 `json:"in_tokens"`
	OutTokens int64 `json:"out_tokens"`
}

// Digest mirrors obs.UsageDigest so it can be serialized into the X-Node-Usage
// header the hub understands, including both legacy Models call counts and
// exact per-model ModelStats.
type Digest struct {
	Models     map[string]int64     `json:"models"`
	ModelStats map[string]ModelStat `json:"model_stats,omitempty"`
	Requests   int64                `json:"requests"`
	Successes  int64                `json:"successes"`
	Failed     int64                `json:"failed"`
	InTokens   int64                `json:"in_tokens"`
	OutTokens  int64                `json:"out_tokens"`
}

const (
	maxTrackedModels = 64
	maxModels        = maxTrackedModels
)

// Counter implements types.ObservabilitySink with the smallest possible surface:
// traces and period queries are unimplemented because Lite never exposes them.
type Counter struct {
	mu        sync.Mutex
	models    map[string]ModelStat
	requests  int64
	successes int64
	failed    int64
	inTokens  int64
	outTokens int64
	dropped   int64
}

// New creates an empty counter.
func New() *Counter {
	return &Counter{models: make(map[string]ModelStat, 8)}
}

// RecordUsage accumulates one finished request into node-level and per-model counters.
func (c *Counter) RecordUsage(trace types.RequestTrace) {
	c.RecordRequest(trace)
}

// RecordRequest accumulates one finished request.
func (c *Counter) RecordRequest(trace types.RequestTrace) {
	model := trace.ServedModel
	if model == "" {
		model = trace.ReqModel
	}
	isSuccess := trace.Status >= 200 && trace.Status < 400

	c.mu.Lock()
	c.requests++
	if isSuccess {
		c.successes++
	} else {
		c.failed++
	}
	c.inTokens += int64(trace.InTokens)
	c.outTokens += int64(trace.OutTokens)
	if model != "" {
		if st, seen := c.models[model]; seen || len(c.models) < maxTrackedModels {
			st.Calls++
			if isSuccess {
				st.Successes++
			} else {
				st.Failed++
			}
			st.InTokens += int64(trace.InTokens)
			st.OutTokens += int64(trace.OutTokens)
			c.models[model] = st
		} else {
			atomic.AddInt64(&c.dropped, 1)
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
	models := make(map[string]int64, len(c.models))
	var modelStats map[string]ModelStat
	if len(c.models) > 0 {
		modelStats = make(map[string]ModelStat, len(c.models))
	}
	for k, st := range c.models {
		models[k] = st.Calls
		modelStats[k] = st
	}
	return Digest{
		Models:     models,
		ModelStats: modelStats,
		Requests:   c.requests,
		Successes:  c.successes,
		Failed:     c.failed,
		InTokens:   c.inTokens,
		OutTokens:  c.outTokens,
	}
}

// DroppedModels reports how many distinct models were not tracked because the
// per-process cap was reached (for diagnostics only).
func (c *Counter) DroppedModels() int64 { return atomic.LoadInt64(&c.dropped) }
