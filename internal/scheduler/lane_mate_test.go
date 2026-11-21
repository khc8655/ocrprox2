package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func laneWaiting(lt *LaneTracker) int {
	total := 0
	for _, l := range lt.Snapshot() {
		total += l.Waiting
	}
	return total
}

func waitForWaiters(t *testing.T, lt *LaneTracker, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if laneWaiting(lt) == want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("waiting count never reached %d: %+v", want, lt.Snapshot())
}

// TestLaneTracker_WaitChoicesTakesAFreeMate: with every candidate full, waiters
// queue on the preferred lane but must be admitted to a sibling lane as soon as
// one frees — not only when the preferred lane comes back.
func TestLaneTracker_WaitChoicesTakesAFreeMate(t *testing.T) {
	lt := NewLaneTracker()
	choices := []LaneChoice{{Tag: "p1:k1", Cap: 1}, {Tag: "p1:k2", Cap: 1}, {Tag: "p1:k3", Cap: 1}}
	hold1, _ := lt.TryAcquireOne("p1:k1", 1)
	hold2, _ := lt.TryAcquireOne("p1:k2", 1)
	hold3, _ := lt.TryAcquireOne("p1:k3", 1)
	defer hold1()
	defer hold2()
	defer hold3()

	tags := make(chan string, 2)
	releaseAll := make(chan struct{})
	for i := 0; i < 2; i++ {
		go func() {
			tag, rel, ok := lt.WaitAcquireChoices(context.Background(), choices, 5*time.Second)
			if !ok {
				tags <- "failed"
				return
			}
			tags <- tag
			<-releaseAll // hold the slot until both are admitted
			rel()
		}()
	}
	defer close(releaseAll)
	waitForWaiters(t, lt, 2)

	start := time.Now()
	hold2()
	hold3()

	took := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case tag := <-tags:
			if tag == "p1:k1" {
				t.Fatalf("waiter was admitted to the preferred lane while it was still full")
			}
			took[tag] = true
		case <-time.After(300 * time.Millisecond):
			t.Fatalf("only %d of 2 waiters took a freed sibling lane within 300ms", len(took))
		}
	}
	if !took["p1:k2"] || !took["p1:k3"] {
		t.Fatalf("waiters took %v, want both freed sibling lanes", took)
	}
	t.Logf("both waiters admitted to freed mates after %.1fms", float64(time.Since(start).Microseconds())/1000)
}

// TestLaneTracker_WaitAcquireStaysOnItsLane is the control for the single-lane
// form: it must keep waiting for that one lane even when others are free.
func TestLaneTracker_WaitAcquireStaysOnItsLane(t *testing.T) {
	lt := NewLaneTracker()
	hold1, _ := lt.TryAcquireOne("p1:k1", 1)
	hold2, _ := lt.TryAcquireOne("p1:k2", 1)
	defer hold2()

	done := make(chan bool, 1)
	go func() {
		rel, ok := lt.WaitAcquire(context.Background(), "p1:k1", 1, 2*time.Second)
		if ok {
			rel()
		}
		done <- ok
	}()
	waitForWaiters(t, lt, 1)
	hold2() // frees a lane the single-lane waiter never asked for
	select {
	case <-done:
		t.Fatal("single-lane WaitAcquire was admitted to a different lane")
	case <-time.After(100 * time.Millisecond):
	}
	hold1() // now its own lane frees
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("single-lane WaitAcquire did not take its lane once free")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("single-lane WaitAcquire did not wake after its lane was released")
	}
}

// TestLaneTracker_WaitChoicesWaitingDoesNotInflate: `waiting` is observability
// only, and must be back to zero once the waiters are gone, however many wake-ups
// they took. A wake must decrement the count it incremented.
func TestLaneTracker_WaitChoicesWaitingDoesNotInflate(t *testing.T) {
	lt := NewLaneTracker()
	choices := []LaneChoice{{Tag: "p1:k1", Cap: 1}, {Tag: "p1:k2", Cap: 1}}
	hold1, _ := lt.TryAcquireOne("p1:k1", 1)
	hold2, _ := lt.TryAcquireOne("p1:k2", 1)

	const waiters = 3
	var wg sync.WaitGroup
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
			defer cancel()
			if _, rel, ok := lt.WaitAcquireChoices(ctx, choices, 0); ok {
				rel()
			}
		}()
	}
	waitForWaiters(t, lt, waiters)

	// A wake-up storm: each release wakes every waiter, which then re-parks. A
	// wake that did not decrement would leave `waiting` above the real count.
	// A waiter may win the freed slot, so each round waits for it to come back.
	for i := 0; i < 5; i++ {
		hold2()
		deadline := time.Now().Add(time.Second)
		got := false
		for time.Now().Before(deadline) {
			if rel, ok := lt.TryAcquireOne("p1:k2", 1); ok {
				hold2, got = rel, true
				break
			}
			time.Sleep(time.Millisecond)
		}
		if !got {
			break
		}
	}
	hold1()
	hold2()
	wg.Wait()
	waitForWaiters(t, lt, 0)
	if got := laneWaiting(lt); got != 0 {
		t.Fatalf("waiting = %d after every waiter left, want 0", got)
	}
}

// TestLaneWait_MakespanUnderASlowPreferredLane measures the closed-batch case:
// one key answers slowly, four answer fast, 10 slots in all, and 20 requests
// arrive after every slot is taken. Waiting on the preferred key alone (the
// single-lane form) leaves the fast keys idle for the whole first key's turn;
// walking the candidates on each wake spreads the batch over whoever frees up.
func TestLaneWait_MakespanUnderASlowPreferredLane(t *testing.T) {
	lanes := []string{"p1:k1", "p1:k2", "p1:k3", "p1:k4", "p1:k5"}
	const cap = 2
	choices := make([]LaneChoice, 0, len(lanes))
	for _, l := range lanes {
		choices = append(choices, LaneChoice{Tag: l, Cap: cap})
	}
	serviceTime := func(tag string) time.Duration {
		if tag == "p1:k1" {
			return 120 * time.Millisecond
		}
		return 15 * time.Millisecond
	}

	run := func(single bool) time.Duration {
		lt := NewLaneTracker()
		var wg sync.WaitGroup
		work := func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			var tag string
			var rel func()
			var ok bool
			if single {
				rel, ok = lt.WaitAcquire(ctx, lanes[0], cap, 0)
				tag = lanes[0]
			} else {
				tag, rel, ok = lt.WaitAcquireChoices(ctx, choices, 0)
			}
			if !ok {
				return
			}
			defer rel()
			time.Sleep(serviceTime(tag))
		}

		start := time.Now()
		// 10 requests fill every slot at t=0; the other 20 arrive at once and queue.
		for i := 0; i < 10+20; i++ {
			wg.Add(1)
			go work()
		}
		wg.Wait()
		return time.Since(start)
	}

	single := run(true)
	all := run(false)
	t.Logf("closed batch of 30 over 10 slots (1 slow key at 120ms, 4 at 15ms): "+
		"preferred-lane-only %v, walk-candidates-on-wake %v", single.Round(time.Millisecond), all.Round(time.Millisecond))
	if all >= single/2 {
		t.Fatalf("candidate walk gave %v vs %v: expected the batch to drain far sooner", all, single)
	}
}

// TestExecuteEndpoint_QueuedRequestTakesAFreedMate proves the endpoint path does
// not leave a queued request behind when a sibling key frees up. Every candidate
// is full when the third request arrives (so it queues on the preferred key); the
// second key's first request then finishes, and the queued request must be
// admitted there instead of waiting for the preferred key.
func TestExecuteEndpoint_QueuedRequestTakesAFreedMate(t *testing.T) {
	var hitK1, hitK2 atomic.Int32
	arrived := make(chan string, 8)
	releaseKey := map[string]chan struct{}{"k1": make(chan struct{}), "k2": make(chan struct{})}
	var mu sync.Mutex
	firstOfKey := map[string]bool{"k1": true, "k2": true}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := "k1"
		if strings.Contains(r.Header.Get("Authorization"), "key-2") {
			key = "k2"
		}
		if key == "k1" {
			hitK1.Add(1)
		} else {
			hitK2.Add(1)
		}
		mu.Lock()
		blockFirst := firstOfKey[key]
		firstOfKey[key] = false
		mu.Unlock()
		arrived <- key
		if blockFirst {
			select {
			case <-releaseKey[key]:
			case <-time.After(5 * time.Second):
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1]}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID: "p1", BaseURL: ts.URL, Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
					{ID: "k2", Label: "k2", Key: "key-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"embedding": {
				Enabled:         true,
				RoutingStrategy: "manual",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", TargetModel: "text-emb", Enabled: true, MaxConc: 1},
					{Provider: "p1", KeyLabel: "k2", TargetModel: "text-emb", Enabled: true, MaxConc: 1},
				},
			},
		},
	}

	sched := NewScheduler(&mockConfigSource{config: cfg}, nil, true)

	call := func() {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", nil)
		_ = sched.ExecuteEndpoint(context.Background(), EndpointRequestSpec{
			Endpoint:      "/v1/embeddings",
			Category:      "embedding",
			ReqModel:      "embedding",
			ForceStrategy: "manual",
			QueueWait:     3 * time.Second,
			RawBody:       []byte(`{"model":"embedding","input":"hello"}`),
		}, rec, req)
	}

	go call() // A -> k1, blocks in the upstream
	if got := <-arrived; got != "k1" {
		t.Fatalf("first request went to %s, want k1", got)
	}
	go call() // B -> k2, blocks in the upstream
	if got := <-arrived; got != "k2" {
		t.Fatalf("second request went to %s, want k2", got)
	}
	go call() // C -> every lane is full, queues on the preferred key k1
	waitForWaiters(t, sched.Lanes(), 1)

	start := time.Now()
	close(releaseKey["k2"])
	select {
	case got := <-arrived:
		t.Logf("queued request reached upstream on %s after %.1fms", got, float64(time.Since(start).Microseconds())/1000)
		if got != "k2" {
			t.Errorf("queued request went to %s, want the freed mate k2", got)
		}
	case <-time.After(500 * time.Millisecond):
		t.Errorf("queued request did not take the freed k2 within 500ms: k1=%d k2=%d", hitK1.Load(), hitK2.Load())
	}

	close(releaseKey["k1"])
}
