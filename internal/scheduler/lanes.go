package scheduler

import (
	"sync"
)

// Lane represents concurrency state for a key or provider lane.
// Direct reference to Magpie concurrency.go Lane structure.
type Lane struct {
	Busy    int `json:"busy"`
	Waiting int `json:"waiting"`
	Limit   int `json:"limit"`
}

// LaneTracker tracks busy and waiting requests per lane (provider:key).
type LaneTracker struct {
	mu    sync.RWMutex
	lanes map[string]*laneState
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
	}
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
