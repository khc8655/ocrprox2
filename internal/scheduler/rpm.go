package scheduler

// Behaviour follows magpie internal/gateway/rpm.go (sliding window per key); this is an
// independent implementation: see docs/MAGPIE_UPSTREAM_SYNC.md §3.4.

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

// providerRPMKey returns the bucket id for a provider-wide RPM window.
//
// Semantics of Provider.RPMPerKey: 该供应商整体 RPM 上限（0=不限）— a ceiling shared
// by ALL keys of the provider, NOT a per-key limit. A key with MaxRPM <= 0 is
// unlimited on its own; it is only constrained by this provider-wide window.
//
// Provider-wide buckets live in their own RPMLimiter instance (Scheduler
// providerRPMLimiter), never in the same map as the per-key buckets: per-key
// buckets are keyed by the KeyTag ("provider:key_label"), and key strings alone
// cannot keep two such namespaces apart (a provider literally named "provider"
// with a key labelled like another provider's id would collide). Separate
// instances make the disjointness hold by construction.
func providerRPMKey(providerID string) string {
	return "provider:" + providerID
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

// TryAcquireToken is TryAcquire with an undo. When ok is true the caller holds
// one window slot and release removes exactly the timestamp this call recorded;
// call it when the pre-authorized request is skipped or fails before reaching
// the upstream, so the window is not consumed by traffic that never happened.
// A limit <= 0 is unlimited and returns a no-op release.
func (l *RPMLimiter) TryAcquireToken(who string, limit int) (release func(), ok bool) {
	if limit <= 0 {
		return func() {}, true
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	ts := l.pruneLocked(who, now)
	if len(ts) >= limit {
		return nil, false
	}
	l.requests[who] = append(ts, now)
	return func() { l.remove(who, now) }, true
}

// remove drops the first timestamp equal to at from who's window. Timestamps
// are unique in practice; if two acquires landed on the same clock tick,
// removing either one keeps the window count correct.
func (l *RPMLimiter) remove(who string, at time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	ts := l.requests[who]
	for i, t := range ts {
		if t.Equal(at) {
			ts = append(ts[:i], ts[i+1:]...)
			if len(ts) == 0 {
				delete(l.requests, who)
			} else {
				l.requests[who] = ts
			}
			return
		}
	}
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
