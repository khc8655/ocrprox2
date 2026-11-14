package obs

import (
	"sync"

	"github.com/khc8655/llmproxy2/internal/types"
)

const TraceCapacity = 60

// TraceBuffer maintains a thread-safe ring buffer of the most recent RequestTrace items.
type TraceBuffer struct {
	mu     sync.RWMutex
	traces []types.RequestTrace
	head   int
	count  int
}

// NewTraceBuffer creates a TraceBuffer with capacity 60.
func NewTraceBuffer() *TraceBuffer {
	return &TraceBuffer{
		traces: make([]types.RequestTrace, TraceCapacity),
	}
}

// Record adds a trace into the ring buffer.
func (b *TraceBuffer) Record(t types.RequestTrace) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.traces[b.head] = t
	b.head = (b.head + 1) % TraceCapacity
	if b.count < TraceCapacity {
		b.count++
	}
}

// Recent returns up to 60 traces in reverse chronological order (newest first).
// Recent returns up to 60 traces in reverse chronological order (newest first).
func (b *TraceBuffer) Recent(onlyFailedOrRetried bool) []types.RequestTrace {
	b.mu.RLock()
	defer b.mu.RUnlock()

	out := make([]types.RequestTrace, 0, b.count)
	idx := (b.head - 1 + TraceCapacity) % TraceCapacity

	for i := 0; i < b.count; i++ {
		t := b.traces[idx]
		idx = (idx - 1 + TraceCapacity) % TraceCapacity

		if onlyFailedOrRetried {
			isFailed := t.Status >= 400 || t.Status == 0
			hasRetries := len(t.Tries) > 1
			if !isFailed && !hasRetries {
				continue
			}
		}
		out = append(out, t)
	}

	return out
}

// Clear empties the ring buffer.
func (b *TraceBuffer) Clear() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.traces = make([]types.RequestTrace, TraceCapacity)
	b.head = 0
	b.count = 0
}

