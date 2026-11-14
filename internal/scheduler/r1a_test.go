package scheduler

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

type mockObsSink struct {
	mu     sync.Mutex
	traces []types.RequestTrace
}

func (m *mockObsSink) RecordRequest(trace types.RequestTrace) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.traces = append(m.traces, trace)
}

func (m *mockObsSink) RecentTraces(onlyFailedOrRetried bool) []types.RequestTrace {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.traces
}

func (m *mockObsSink) QueryUsage(period string, tzName string) (map[string]any, error) {
	return nil, nil
}

// 1. Test async PeekFirstChunk emitting real : keep-alive\n\n comments before the first chunk arrives
func TestAsyncPeekFirstChunk_KeepaliveEmission(t *testing.T) {
	pr, pw := io.Pipe()
	defer pr.Close()

	var keepaliveCount atomic.Int32
	keepaliveFunc := func() {
		keepaliveCount.Add(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resCh := make(chan *PeekResult, 1)
	errCh := make(chan error, 1)

	go func() {
		res, err := PeekFirstChunk(ctx, pr, 20*time.Millisecond, 0, keepaliveFunc)
		if err != nil {
			errCh <- err
			return
		}
		resCh <- res
	}()

	// Wait 60ms: keepaliveTicker (20ms) should fire at least 2 times
	time.Sleep(65 * time.Millisecond)

	if got := keepaliveCount.Load(); got < 2 {
		t.Errorf("expected keepalive ticker to fire at least 2 times before first chunk, got %d", got)
	}

	// Now deliver the first payload chunk
	payload := "data: {\"choices\":[{\"delta\":{\"content\":\"first token\"}}]}\n\n"
	_, _ = pw.Write([]byte(payload))

	select {
	case res := <-resCh:
		if res.IsError {
			t.Fatalf("expected successful peek, got error: %s", res.ErrorSnippet)
		}
		if !strings.Contains(string(res.FirstChunk), "first token") {
			t.Errorf("expected first chunk to contain 'first token', got %q", string(res.FirstChunk))
		}
		// Verify CombinedBody can be read
		buf := make([]byte, 1024)
		n, _ := res.CombinedBody.Read(buf)
		if !strings.Contains(string(buf[:n]), "first token") {
			t.Errorf("expected CombinedBody to contain payload, got %q", string(buf[:n]))
		}
	case err := <-errCh:
		t.Fatalf("PeekFirstChunk returned unexpected error: %v", err)
	case <-time.After(1 * time.Second):
		t.Fatalf("PeekFirstChunk timed out waiting for response")
	}
}

// 2. Test zero goroutine leak on cancellation
func TestAsyncPeekFirstChunk_Cancellation_ZeroGoroutineLeak(t *testing.T) {
	// Warm up runtime
	runtime.GC()
	time.Sleep(20 * time.Millisecond)
	baseGoroutines := runtime.NumGoroutine()

	pr, pw := io.Pipe()
	defer pw.Close()

	ctx, cancel := context.WithCancel(context.Background())

	errCh := make(chan error, 1)
	go func() {
		_, err := PeekFirstChunk(ctx, pr, 20*time.Millisecond, 0, nil)
		errCh <- err
	}()

	// Give reader time to block in ReadLine
	time.Sleep(30 * time.Millisecond)

	// Cancel context
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("expected context.Canceled, got %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Fatalf("timed out waiting for cancel unblock")
	}

	// Verify reader goroutine exited with zero leaks
	var finalGoroutines int
	for i := 0; i < 20; i++ {
		runtime.GC()
		time.Sleep(10 * time.Millisecond)
		finalGoroutines = runtime.NumGoroutine()
		if finalGoroutines <= baseGoroutines+1 {
			break
		}
	}

	if finalGoroutines > baseGoroutines+2 {
		t.Errorf("possible goroutine leak: base=%d, final=%d", baseGoroutines, finalGoroutines)
	}
}

// 3. Test zero goroutine leak on first-byte timeout
func TestAsyncPeekFirstChunk_FirstByteTimeout_ZeroGoroutineLeak(t *testing.T) {
	runtime.GC()
	time.Sleep(20 * time.Millisecond)
	baseGoroutines := runtime.NumGoroutine()

	pr, pw := io.Pipe()
	defer pw.Close()

	errCh := make(chan error, 1)
	go func() {
		_, err := PeekFirstChunk(context.Background(), pr, 50*time.Millisecond, 30*time.Millisecond, nil)
		errCh <- err
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, ErrFirstByteTimeout) {
			t.Errorf("expected ErrFirstByteTimeout, got %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Fatalf("timed out waiting for first-byte timeout")
	}

	// Check goroutine cleanup
	var finalGoroutines int
	for i := 0; i < 20; i++ {
		runtime.GC()
		time.Sleep(10 * time.Millisecond)
		finalGoroutines = runtime.NumGoroutine()
		if finalGoroutines <= baseGoroutines+1 {
			break
		}
	}
	if finalGoroutines > baseGoroutines+2 {
		t.Errorf("possible goroutine leak on timeout: base=%d, final=%d", baseGoroutines, finalGoroutines)
	}
}

// 4. Test key_bans.json persisting >= 300s bans across CooldownManager restarts and skipping disk I/O when banFile == ""
func TestPersistentKeyBans_LifecycleAndRestarts(t *testing.T) {
	tempDir := t.TempDir()
	banPath := filepath.Join(tempDir, "key_bans.json")

	cm1 := NewCooldownManager(banPath)

	// Short ban: 60s (< 300s) -> should NOT be persisted to disk
	cm1.ApplyCooldown("prov-1", "m1", "k-short", 429, 60*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)

	// Long ban: 86400s (>= 300s) -> MUST be persisted to disk
	cm1.ApplyCooldown("prov-1", "m1", "k-long", 401, 60*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)

	// Permanent ban: 410 Gone -> MUST be persisted to disk
	cm1.ApplyCooldown("prov-1", "m1", "k-perm", 410, 60*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)

	// Quota reset ban: -> MUST be persisted to disk
	sec, _, err := cm1.ApplyQuotaCooldown("prov-2", "m2", "k-quota", "00:00+08:00")
	if err != nil {
		t.Fatalf("ApplyQuotaCooldown error: %v", err)
	}
	if sec <= 0 {
		t.Errorf("expected positive remaining sec for quota reset, got %d", sec)
	}

	// Verify all 4 are cooled down in cm1
	if !cm1.IsCooledDown("prov-1", "m1", "k-short") {
		t.Errorf("k-short should be cooled down in memory")
	}
	if !cm1.IsCooledDown("prov-1", "m1", "k-long") {
		t.Errorf("k-long should be cooled down in memory")
	}
	if !cm1.IsCooledDown("prov-1", "m1", "k-perm") {
		t.Errorf("k-perm should be cooled down in memory")
	}
	if !cm1.IsCooledDown("prov-2", "m2", "k-quota") {
		t.Errorf("k-quota should be cooled down in memory")
	}

	// Restart 1: new CooldownManager loading banPath
	cm2 := NewCooldownManager(banPath)

	// k-short was < 300s -> must NOT be cooled down after restart
	if cm2.IsCooledDown("prov-1", "m1", "k-short") {
		t.Errorf("k-short (<300s) should not persist across restart")
	}
	// k-long (86400s >= 300s) -> MUST be cooled down
	if !cm2.IsCooledDown("prov-1", "m1", "k-long") {
		t.Errorf("k-long (>=300s) must persist across restart")
	}
	// k-perm (410 Gone) -> MUST be cooled down
	if !cm2.IsCooledDown("prov-1", "m1", "k-perm") {
		t.Errorf("k-perm (permanent) must persist across restart")
	}
	// k-quota -> MUST be cooled down
	if !cm2.IsCooledDown("prov-2", "m2", "k-quota") {
		t.Errorf("k-quota must persist across restart")
	}

	// Clear k-long in cm2 and verify persistence
	cm2.ClearKey("prov-1", "k-long")
	if cm2.IsCooledDown("prov-1", "m1", "k-long") {
		t.Errorf("k-long should be cleared in cm2")
	}

	// Restart 2: verify k-long is cleared from disk
	cm3 := NewCooldownManager(banPath)
	if cm3.IsCooledDown("prov-1", "m1", "k-long") {
		t.Errorf("k-long was cleared, should not be cooled down after restart")
	}
	// k-perm still active
	if !cm3.IsCooledDown("prov-1", "m1", "k-perm") {
		t.Errorf("k-perm should still be persisted")
	}
}

// 5. Test Lite mode: banFile == "" -> zero disk I/O
func TestPersistentKeyBans_LiteMode_ZeroDiskIO(t *testing.T) {
	cmLite := NewCooldownManager()
	if cmLite.BanFile() != "" {
		t.Errorf("expected empty banFile for Lite mode, got %q", cmLite.BanFile())
	}

	// Applying long and permanent bans in Lite mode must succeed with 0 disk I/O
	cmLite.ApplyCooldown("p1", "m1", "k1", 401, 15*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)
	cmLite.ApplyCooldown("p1", "m1", "k2", 410, 15*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)

	if !cmLite.IsCooledDown("p1", "m1", "k1") {
		t.Errorf("k1 should be cooled down in memory")
	}
	if !cmLite.IsCooledDown("p1", "m1", "k2") {
		t.Errorf("k2 should be cooled down in memory")
	}

	cmLite.ClearKey("p1", "k1")
	if cmLite.IsCooledDown("p1", "m1", "k1") {
		t.Errorf("k1 should be cleared")
	}
}

// 6. Test QuotaResetAt daily reset parsing
func TestQuotaResetAt_Parsing(t *testing.T) {
	// Base time: 2026-11-14 12:00:00 UTC (which is 20:00:00 +08:00)
	baseTime := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)

	// Format: "00:00+08:00" -> in +8, current time is 20:00. Next 00:00 is in 4 hours (16:00 UTC)
	t1, err := ParseNextQuotaReset("00:00+08:00", baseTime)
	if err != nil {
		t.Fatalf("ParseNextQuotaReset('00:00+08:00') error: %v", err)
	}
	diff := t1.Sub(baseTime)
	if diff != 4*time.Hour {
		t.Errorf("expected next reset in 4h, got %v", diff)
	}

	// Format: "08:00" -> in UTC (baseTime location), next 08:00 is tomorrow in 20 hours
	t2, err := ParseNextQuotaReset("08:00", baseTime)
	if err != nil {
		t.Fatalf("ParseNextQuotaReset('08:00') error: %v", err)
	}
	if t2.Sub(baseTime) != 20*time.Hour {
		t.Errorf("expected next reset in 20h, got %v", t2.Sub(baseTime))
	}

	// Format: "08:00:00-05:00"
	t3, err := ParseNextQuotaReset("08:00:00-05:00", baseTime)
	if err != nil {
		t.Fatalf("ParseNextQuotaReset('08:00:00-05:00') error: %v", err)
	}
	if !t3.After(baseTime) {
		t.Errorf("expected target reset time to be strictly in future, got %v <= %v", t3, baseTime)
	}

	// Invalid format
	if _, err := ParseNextQuotaReset("invalid", baseTime); err == nil {
		t.Errorf("expected error for invalid format, got nil")
	}
}

// 7. Test per-key sliding-window RPM rate limiter
func TestPerKeyRPM_SlidingWindowLimiter(t *testing.T) {
	limiter := NewRPMLimiter(80 * time.Millisecond)

	who := "openai:hk-01"

	// Limit = 2
	if !limiter.TryAcquire(who, 2) {
		t.Errorf("1st acquire should succeed")
	}
	if !limiter.TryAcquire(who, 2) {
		t.Errorf("2nd acquire should succeed")
	}
	// 3rd acquire in same window must fail!
	if limiter.TryAcquire(who, 2) {
		t.Errorf("3rd acquire should fail when limit is 2")
	}
	if limiter.Allow(who, 2) {
		t.Errorf("Allow should return false when at capacity")
	}

	// Wait 90ms for window to slide
	time.Sleep(95 * time.Millisecond)

	if !limiter.Allow(who, 2) {
		t.Errorf("Allow should return true after sliding window expires")
	}
	if !limiter.TryAcquire(who, 2) {
		t.Errorf("acquire should succeed after sliding window expires")
	}
}

// 8. Test Scheduler skipping over-quota keys before dialing upstream
func TestScheduler_Dispatch_PerKeyRPMSkipsKey(t *testing.T) {
	var k1Called, k2Called atomic.Int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if strings.Contains(auth, "key-1") {
			k1Called.Add(1)
		} else if strings.Contains(auth, "key-2") {
			k2Called.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "k1",
						Label:   "k1",
						Key:     "key-1",
						Enabled: true,
						MaxRPM:  1, // Key 1 has limit of 1 request per minute!
					},
					{
						ID:      "k2",
						Label:   "k2",
						Key:     "key-2",
						Enabled: true,
						MaxRPM:  100, // Key 2 has plenty of capacity
					},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:         true,
				RoutingStrategy: "sticky_failover",
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
					{Provider: "p1", KeyLabel: "k2", Enabled: true},
				},
			},
		},
	}

	obsSink := &mockObsSink{}
	sched := NewScheduler(&mockConfigSource{config: cfg}, obsSink, true)

	// 1st request -> routed to k1
	rec1 := httptest.NewRecorder()
	req1 := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`))
	err := sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`), "gpt-4o", false, rec1, req1)
	if err != nil {
		t.Fatalf("1st dispatch error: %v", err)
	}
	if k1Called.Load() != 1 || k2Called.Load() != 0 {
		t.Fatalf("expected k1 to be called once, got k1=%d, k2=%d", k1Called.Load(), k2Called.Load())
	}

	// 2nd request -> k1 has reached MaxRPM=1, so it must be SKIPPED before dialing upstream!
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi again"}]}`))
	err = sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi again"}]}`), "gpt-4o", false, rec2, req2)
	if err != nil {
		t.Fatalf("2nd dispatch error: %v", err)
	}

	// k1 must NOT have been called again (remains 1), k2 must have handled it (k2=1)!
	if k1Called.Load() != 1 {
		t.Errorf("k1 was over RPM quota and should have been skipped, but was called: %d", k1Called.Load())
	}
	if k2Called.Load() != 1 {
		t.Errorf("expected failover to k2 due to RPM limit, got k2=%d", k2Called.Load())
	}
}

// 9. Test LaneTracker concurrency tracking
func TestLaneTracker_Concurrency(t *testing.T) {
	lt := NewLaneTracker()
	who := "openai:hk-01"

	stopWait := lt.StartWaiting(who)
	snap1 := lt.Snapshot()
	if snap1[who].Waiting != 1 || snap1[who].Busy != 0 {
		t.Errorf("expected Waiting=1, Busy=0; got %+v", snap1[who])
	}

	relBusy := lt.Acquire(who, 5)
	stopWait()

	snap2 := lt.Snapshot()
	if snap2[who].Waiting != 0 || snap2[who].Busy != 1 || snap2[who].Limit != 5 {
		t.Errorf("expected Waiting=0, Busy=1, Limit=5; got %+v", snap2[who])
	}

	relBusy()
	snap3 := lt.Snapshot()
	if _, ok := snap3[who]; ok {
		t.Errorf("expected idle lane to be removed from snapshot, got %+v", snap3[who])
	}
}

// 10. Test Latency Waterfall Instrumentation
func TestScheduler_LatencyWaterfallInstrumentation(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("X-Custom-Resp", "safe-value")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"token-1\"}}]}\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(20 * time.Millisecond)
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"token-2\"}}]}\n\n"))
		w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: "key-1", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
				},
			},
		},
	}

	obsSink := &mockObsSink{}
	sched := NewScheduler(&mockConfigSource{config: cfg}, obsSink, true)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer sk-secret-client-token")
	req.Header.Set("X-Client-App", "test-runner")

	err := sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`), "gpt-4o", true, rec, req)
	if err != nil {
		t.Fatalf("Dispatch error: %v", err)
	}

	traces := obsSink.RecentTraces(false)
	if len(traces) != 1 {
		t.Fatalf("expected 1 recorded trace, got %d", len(traces))
	}

	tr := traces[0]
	if tr.Status != 200 {
		t.Errorf("expected Status 200, got %d", tr.Status)
	}
	if tr.UpBytes <= 0 {
		t.Errorf("expected UpBytes > 0, got %d", tr.UpBytes)
	}
	if tr.DownBytes <= 0 {
		t.Errorf("expected DownBytes > 0, got %d", tr.DownBytes)
	}
	if tr.FlowMillis < 0 {
		t.Errorf("expected FlowMillis >= 0, got %d", tr.FlowMillis)
	}
	if tr.TotalMillis <= 0 {
		t.Errorf("expected TotalMillis > 0, got %d", tr.TotalMillis)
	}

	// Verify header sanitization on ReqHeaders
	if tr.ReqHeaders["Authorization"] != "[REDACTED]" {
		t.Errorf("expected Authorization header to be [REDACTED], got %q", tr.ReqHeaders["Authorization"])
	}
	if tr.ReqHeaders["X-Client-App"] != "test-runner" {
		t.Errorf("expected X-Client-App header preserved, got %q", tr.ReqHeaders["X-Client-App"])
	}

	// Verify tries populated
	if len(tr.Tries) != 1 {
		t.Fatalf("expected 1 try, got %d", len(tr.Tries))
	}
	try0 := tr.Tries[0]
	if try0.Status != 200 {
		t.Errorf("expected try status 200, got %d", try0.Status)
	}
	if try0.RespHeaders["X-Custom-Resp"] != "safe-value" {
		t.Errorf("expected X-Custom-Resp in try RespHeaders, got %q", try0.RespHeaders["X-Custom-Resp"])
	}
}
