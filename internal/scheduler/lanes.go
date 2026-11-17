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

// Acquire increments busy count and sets lane limit. Returns a release func.
func (lt *LaneTracker) Acquire(who string, limit int) func() {
	lt.mu.Lock()
	st, ok := lt.lanes[who]
	if !ok {
		st = &laneState{}
		lt.lanes[who] = st
	}
	st.busy++
	if limit > 0 {
		st.limit = limit
	}
	lt.mu.Unlock()

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

func (lt *LaneTracker) cleanupLocked(who string, st *laneState) {
	if st.busy <= 0 && st.waiting <= 0 {
		delete(lt.lanes, who)
	}
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
