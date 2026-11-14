package scheduler

import (
	"sync"
	"time"
)

// RPMLimiter tracks sliding-window request timestamps per key.
type RPMLimiter struct {
	mu       sync.Mutex
	window   time.Duration
	requests map[string][]time.Time
}

// NewRPMLimiter creates a sliding-window RPM limiter.
// Default window is 1 minute (60 seconds) if omitted or non-positive.
func NewRPMLimiter(window ...time.Duration) *RPMLimiter {
	w := 60 * time.Second
	if len(window) > 0 && window[0] > 0 {
		w = window[0]
	}
	return &RPMLimiter{
		window:   w,
		requests: make(map[string][]time.Time),
	}
}

// pruneLocked removes timestamps older than now - window for key who.
func (l *RPMLimiter) pruneLocked(who string, now time.Time) []time.Time {
	cutoff := now.Add(-l.window)
	ts := l.requests[who]
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	ts = ts[i:]
	if len(ts) == 0 {
		delete(l.requests, who)
		return nil
	}
	l.requests[who] = ts
	return ts
}

// Allow returns true if who has room for another request within its sliding window limit.
// A limit <= 0 means unlimited.
func (l *RPMLimiter) Allow(who string, limit int) bool {
	if limit <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	ts := l.pruneLocked(who, now)
	return len(ts) < limit
}

// TryAcquire checks if who has room under limit. If true, records a request timestamp at now
// and returns true; otherwise returns false without modifying timestamps.
// A limit <= 0 means unlimited.
func (l *RPMLimiter) TryAcquire(who string, limit int) bool {
	if limit <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	ts := l.pruneLocked(who, now)
	if len(ts) >= limit {
		return false
	}
	l.requests[who] = append(ts, now)
	return true
}

// Record explicitly records a request timestamp for who.
func (l *RPMLimiter) Record(who string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	ts := l.pruneLocked(who, now)
	l.requests[who] = append(ts, now)
}

// Count returns active requests in the sliding window for who.
func (l *RPMLimiter) Count(who string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.pruneLocked(who, time.Now()))
}

// Reset clears recorded timestamps for the specified who or all keys if none provided.
func (l *RPMLimiter) Reset(who ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(who) == 0 {
		l.requests = make(map[string][]time.Time)
		return
	}
	for _, w := range who {
		delete(l.requests, w)
	}
}
