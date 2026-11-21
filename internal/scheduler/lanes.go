package scheduler

import (
	"context"
	"sync"
	"time"
)

// Lane represents concurrency state for a key or provider lane.
// Direct reference to Lane in magpie internal/gateway/concurrency.go; the queueing semantics
// (a request at a full lane waits, it is not failed) and the move-to-a-free-mate behaviour
// (laneMate/waitMate) follow the same file. Upstream anchors are in
// docs/MAGPIE_UPSTREAM_SYNC.md §3.4.
type Lane struct {
	Busy    int `json:"busy"`
	Waiting int `json:"waiting"`
	Limit   int `json:"limit"`
}

// LaneTracker tracks busy and waiting requests per lane (provider:key).
//
// freed wakes a request parked in WaitAcquire. It is closed-and-replaced rather
// than sent to: every waiter holds the channel it waited on, so one release
// wakes all of them and each re-checks its own lane under the lock. A capacity
// of 1 would leave a wake-up behind with no waiter to take it, and a waiter
// that arrives just after a release would sleep through a free slot.
type LaneTracker struct {
	mu    sync.RWMutex
	lanes map[string]*laneState
	freed chan struct{}
}

type laneState struct {
	busy    int
	waiting int
	limit   int
}

// NewLaneTracker creates a new thread-safe LaneTracker.
func NewLaneTracker() *LaneTracker {
	return &LaneTracker{
		lanes: make(map[string]*laneState),
		freed: make(chan struct{}),
	}
}

// signalLocked wakes every request waiting for a free slot. Called with mu held
// whenever a busy slot is given back.
func (lt *LaneTracker) signalLocked() {
	if lt.freed == nil {
		lt.freed = make(chan struct{})
	}
	close(lt.freed)
	lt.freed = make(chan struct{})
}

// StartWaiting increments waiting count for a lane and returns a completion func.
func (lt *LaneTracker) StartWaiting(who string) func() {
	lt.mu.Lock()
	st, ok := lt.lanes[who]
	if !ok {
		st = &laneState{}
		lt.lanes[who] = st
	}
	st.waiting++
	lt.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			lt.mu.Lock()
			st.waiting--
			if st.waiting < 0 {
				st.waiting = 0
			}
			lt.cleanupLocked(who, st)
			lt.mu.Unlock()
		})
	}
}

// LaneChoice is one key a new request may be placed on: its lane tag and the
// soft concurrency cap it must stay under (0 = unlimited).
type LaneChoice struct {
	Tag string
	Cap int
}

// TryAcquire picks and occupies a lane in one step, so two simultaneous arrivals
// cannot both see room under the last free slot. It walks choices in preference
// order and takes the first lane still under its cap; when every lane is full it
// takes the least busy one, so a burst beyond total capacity spreads evenly
// instead of stacking up on a single key.
//
// The taken slot is an ordinary busy slot: the caller passes the returned release
// func to the request. One lane count is therefore the only accounting, for both
// admitted and reserved traffic, and nothing can be counted twice.
func (lt *LaneTracker) TryAcquire(choices []LaneChoice) (string, func(), bool) {
	if lt == nil || len(choices) == 0 {
		return "", nil, false
	}
	lt.mu.Lock()
	defer lt.mu.Unlock()

	bestTag, bestLoad := "", -1
	for _, ch := range choices {
		if ch.Tag == "" {
			continue
		}
		n := 0
		if st := lt.lanes[ch.Tag]; st != nil {
			// Only held slots count. `waiting` covers a request still preparing its
			// call, and a request that already holds a slot also sits in `waiting`
			// while it prepares — counting both would halve every cap.
			n = st.busy
		}
		if ch.Cap <= 0 || n < ch.Cap {
			return ch.Tag, lt.acquireLocked(ch.Tag, ch.Cap), true
		}
		if bestLoad < 0 || n < bestLoad {
			bestTag, bestLoad = ch.Tag, n
		}
	}
	if bestTag == "" {
		return "", nil, false
	}
	return bestTag, lt.acquireLocked(bestTag, capFor(choices, bestTag)), true
}

func capFor(choices []LaneChoice, tag string) int {
	for _, ch := range choices {
		if ch.Tag == tag {
			return ch.Cap
		}
	}
	return 0
}

// TryAcquireFirst takes the first lane in choices that is still under its cap and
// reports failure when every lane is at its cap.
//
// Unlike TryAcquire it has no least-busy fallback: a full lane is a lane the
// upstream will reject, so the caller must move on to another candidate. That is
// the knowledge-base case, where max_concurrency is a limit the provider counts
// per key and exceeding it earns a 429 rather than a slightly slower answer.
func (lt *LaneTracker) TryAcquireFirst(choices []LaneChoice) (string, func(), bool) {
	if lt == nil || len(choices) == 0 {
		return "", nil, false
	}
	lt.mu.Lock()
	defer lt.mu.Unlock()

	for _, ch := range choices {
		if ch.Tag == "" {
			continue
		}
		n := 0
		if st := lt.lanes[ch.Tag]; st != nil {
			n = st.busy
		}
		if ch.Cap <= 0 || n < ch.Cap {
			return ch.Tag, lt.acquireLocked(ch.Tag, ch.Cap), true
		}
	}
	return "", nil, false
}

// TryAcquireOne takes a slot on one named lane, refusing when it is already at
// limit. A simple, explicit form for a caller that has already chosen the lane.
func (lt *LaneTracker) TryAcquireOne(who string, limit int) (func(), bool) {
	if lt == nil || who == "" {
		return nil, false
	}
	lt.mu.Lock()
	defer lt.mu.Unlock()

	if limit > 0 {
		if st := lt.lanes[who]; st != nil && st.busy >= limit {
			return nil, false
		}
	}
	return lt.acquireLocked(who, limit), true
}

// WaitAcquire takes a slot on who, waiting for one to free up rather than
// overfilling the lane. It is WaitAcquireChoices with a single candidate.
func (lt *LaneTracker) WaitAcquire(ctx context.Context, who string, limit int, maxWait time.Duration) (func(), bool) {
	_, rel, ok := lt.WaitAcquireChoices(ctx, []LaneChoice{{Tag: who, Cap: limit}}, maxWait)
	return rel, ok
}

// WaitAcquireChoices waits for a slot on any of choices and reports which lane it
// took, giving up when ctx ends or maxWait elapses (maxWait <= 0 means no deadline
// of its own).
//
// This is the answer to a full candidate set: the request is delayed, not failed.
// Magpie's lane queue works the same way — "a request queued is never passed to a
// fallback for want of a free slot" — because failing over to a candidate that is
// also full only spends the caller's retry budget.
//
// While parked it waits on choices[0], the routing's first choice, but every wake
// re-walks the whole list: each time a slot of any lane comes back, the first
// candidate with room takes this request (magpie's waitMate). Waiting only for the
// preferred lane would leave a sibling slot idle for as long as that lane's turn
// runs — seconds or minutes under a closed batch, which is exactly the shape of a
// knowledge-base ingestion burst.
//
// While parked the request counts in `waiting` on the preferred lane, which is
// observability only; the slot it eventually takes is the same `busy` count every
// other admission uses, so one limit still has exactly one counter.
func (lt *LaneTracker) WaitAcquireChoices(ctx context.Context, choices []LaneChoice, maxWait time.Duration) (string, func(), bool) {
	if lt == nil || len(choices) == 0 {
		return "", nil, false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pref := ""
	for _, ch := range choices {
		if ch.Tag != "" {
			pref = ch.Tag
			break
		}
	}
	if pref == "" {
		return "", nil, false
	}

	var deadline <-chan time.Time
	if maxWait > 0 {
		t := time.NewTimer(maxWait)
		defer t.Stop()
		deadline = t.C
	}

	for {
		lt.mu.Lock()
		for _, ch := range choices {
			if ch.Tag == "" {
				continue
			}
			if ch.Cap <= 0 || lt.busyLocked(ch.Tag) < ch.Cap {
				rel := lt.acquireLocked(ch.Tag, ch.Cap)
				lt.mu.Unlock()
				return ch.Tag, rel, true
			}
		}
		st := lt.stateLocked(pref)
		st.waiting++
		wake := lt.freed
		lt.mu.Unlock()

		select {
		case <-wake:
			// The increment above is paired here before re-checking, so a wake
			// storm cannot inflate the count: `waiting` is observability only.
			lt.stopWaiting(pref, st)
		case <-ctx.Done():
			lt.stopWaiting(pref, st)
			return "", nil, false
		case <-deadline:
			lt.stopWaiting(pref, st)
			return "", nil, false
		}
	}
}

// busyLocked is the held-slot count of a lane; mu must be held. Only held slots
// count towards a cap — `waiting` must never halve it.
func (lt *LaneTracker) busyLocked(who string) int {
	if st := lt.lanes[who]; st != nil {
		return st.busy
	}
	return 0
}

// stateLocked returns the lane's state, creating it when absent; mu must be held.
func (lt *LaneTracker) stateLocked(who string) *laneState {
	st, ok := lt.lanes[who]
	if !ok {
		st = &laneState{}
		lt.lanes[who] = st
	}
	return st
}

func (lt *LaneTracker) stopWaiting(who string, st *laneState) {
	lt.mu.Lock()
	st.waiting--
	if st.waiting < 0 {
		st.waiting = 0
	}
	lt.cleanupLocked(who, st)
	lt.mu.Unlock()
}

// acquireLocked increments busy for who, recording limit when it is set.
func (lt *LaneTracker) acquireLocked(who string, limit int) func() {
	st, ok := lt.lanes[who]
	if !ok {
		st = &laneState{}
		lt.lanes[who] = st
	}
	st.busy++
	if limit > 0 {
		st.limit = limit
	}

	var once sync.Once
	return func() {
		once.Do(func() {
			lt.mu.Lock()
			st.busy--
			if st.busy < 0 {
				st.busy = 0
			}
			lt.signalLocked()
			lt.cleanupLocked(who, st)
			lt.mu.Unlock()
		})
	}
}

// Acquire increments busy count and sets lane limit. Returns a release func.
func (lt *LaneTracker) Acquire(who string, limit int) func() {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	return lt.acquireLocked(who, limit)
}

func (lt *LaneTracker) cleanupLocked(who string, st *laneState) {
	if st.busy <= 0 && st.waiting <= 0 {
		delete(lt.lanes, who)
	}
}

// BusyCount returns the number of slots a lane has handed out: requests admitted
// to it, whether they are being prepared or already on the wire. This is the
// count caps are enforced against.
func (lt *LaneTracker) BusyCount(who string) int {
	lt.mu.RLock()
	defer lt.mu.RUnlock()
	if st, ok := lt.lanes[who]; ok && st != nil {
		return st.busy
	}
	return 0
}

// ActiveCount returns busy + waiting request count for a lane.
func (lt *LaneTracker) ActiveCount(who string) int {
	lt.mu.RLock()
	defer lt.mu.RUnlock()
	st, ok := lt.lanes[who]
	if !ok || st == nil {
		return 0
	}
	return st.busy + st.waiting
}

// Snapshot returns a copy of all current lanes with non-zero activity or limits.
func (lt *LaneTracker) Snapshot() map[string]Lane {
	lt.mu.RLock()
	defer lt.mu.RUnlock()

	res := make(map[string]Lane, len(lt.lanes))
	for k, st := range lt.lanes {
		res[k] = Lane{
			Busy:    st.busy,
			Waiting: st.waiting,
			Limit:   st.limit,
		}
	}
	return res
}
