package hubheartbeat

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestParseInterval(t *testing.T) {
	cases := []struct {
		name         string
		raw          string
		wantInterval time.Duration
		wantEnabled  bool
		wantExplicit bool
		wantParseErr bool
	}{
		{"unset uses default", "", DefaultInterval, true, false, false},
		{"whitespace unset uses default", "   ", DefaultInterval, true, false, false},
		{"explicit default", "600", 600 * time.Second, true, true, false},
		{"below minimum clamps to 60s", "30", MinInterval, true, true, false},
		{"one second clamps to 60s", "1", MinInterval, true, true, false},
		{"above default passes through", "900", 900 * time.Second, true, true, false},
		{"zero disables", "0", 0, false, true, false},
		{"off disables", "off", 0, false, true, false},
		{"OFF uppercase disables", "OFF", 0, false, true, false},
		{"false disables", "false", 0, false, true, false},
		{"no disables", "no", 0, false, true, false},
		{"disabled disables", "disabled", 0, false, true, false},
		{"negative invalid falls back to default", "-5", DefaultInterval, true, true, true},
		{"garbage invalid falls back to default", "abc", DefaultInterval, true, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			interval, enabled, explicit, err := ParseInterval(tc.raw)
			if interval != tc.wantInterval || enabled != tc.wantEnabled || explicit != tc.wantExplicit {
				t.Fatalf("ParseInterval(%q) = (%v, %v, %v), want (%v, %v, %v)",
					tc.raw, interval, enabled, explicit, tc.wantInterval, tc.wantEnabled, tc.wantExplicit)
			}
			if (err != nil) != tc.wantParseErr {
				t.Fatalf("ParseInterval(%q) err = %v, want err=%v", tc.raw, err, tc.wantParseErr)
			}
		})
	}
}

func TestShouldEnable(t *testing.T) {
	cases := []struct {
		name     string
		role     types.Role
		enabled  bool
		explicit bool
		want     bool
	}{
		{"full default on", types.RoleFull, true, false, true},
		{"full explicit on", types.RoleFull, true, true, true},
		{"full explicit off", types.RoleFull, false, true, false},
		{"lite default off", types.RoleLite, true, false, false},
		{"lite explicit on", types.RoleLite, true, true, true},
		{"lite explicit off", types.RoleLite, false, true, false},
		{"unknown role defaults opt-in", types.Role("unknown"), true, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ShouldEnable(tc.role, tc.enabled, tc.explicit); got != tc.want {
				t.Fatalf("ShouldEnable(%q, %v, %v) = %v, want %v", tc.role, tc.enabled, tc.explicit, got, tc.want)
			}
		})
	}
}

func TestSendHeadersAndPath(t *testing.T) {
	const token = "stk_node_synthetic_test_token_1234567890"
	const ver = "v20261123-03"

	var gotPath, gotAuth, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotVersion = r.Header.Get("X-Node-Version")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	logs := make([]string, 0)
	c := NewClient(srv.URL+"/", token, ver, MinInterval, func(format string, args ...any) {
		logs = append(logs, format)
	})
	c.send(context.Background())

	if gotPath != heartbeatPath {
		t.Fatalf("path = %q, want %q", gotPath, heartbeatPath)
	}
	if gotAuth != "Bearer "+token {
		t.Fatalf("Authorization = %q, want Bearer <token>", gotAuth)
	}
	if gotVersion != ver {
		t.Fatalf("X-Node-Version = %q, want %q", gotVersion, ver)
	}
	for _, l := range logs {
		if strings.Contains(l, token) {
			t.Fatalf("debug log leaked token: %q", l)
		}
	}
}

func TestSendFailureDoesNotPanic(t *testing.T) {
	// No server running at this address: the request must fail silently.
	c := NewClient("http://127.0.0.1:1", "stk_node_synthetic", "v1", MinInterval, func(string, ...any) {})
	c.send(context.Background()) // must not panic
}

func TestSendNon2xxDoesNotPanic(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusNoContent, http.StatusOK} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		c := NewClient(srv.URL, "stk_node_synthetic", "v1", MinInterval, func(string, ...any) {})
		c.send(context.Background()) // must not panic for any status
		srv.Close()
	}
}

func TestRunBlockSendsImmediatelyThenOnTicker(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "stk_node_synthetic", "v1", 40*time.Millisecond, func(string, ...any) {})
	c.initialDelay = 5 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.RunBlock(ctx); close(done) }()

	deadline := time.Now().Add(2 * time.Second)
	for hits.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunBlock did not exit on context cancel")
	}
	if hits.Load() < 2 {
		t.Fatalf("expected initial + at least one ticker heartbeat, got %d", hits.Load())
	}
	count := hits.Load()
	time.Sleep(80 * time.Millisecond)
	if hits.Load() != count {
		t.Fatalf("heartbeats continued after cancel: %d -> %d", count, hits.Load())
	}
}

func TestRunBlockSkipsWhenIncomplete(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer srv.Close()

	// Missing token -> no start.
	c := NewClient(srv.URL, "", "v1", 40*time.Millisecond, func(string, ...any) {})
	c.initialDelay = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.RunBlock(ctx); close(done) }()
	time.Sleep(60 * time.Millisecond)
	cancel()
	<-done
	if hits.Load() != 0 {
		t.Fatalf("heartbeat sent with empty token: %d", hits.Load())
	}

	// Empty URL -> no start.
	c2 := NewClient("", "stk_node_synthetic", "v1", 40*time.Millisecond, func(string, ...any) {})
	c2.initialDelay = 5 * time.Millisecond
	ctx2, cancel2 := context.WithCancel(context.Background())
	done2 := make(chan struct{})
	go func() { c2.RunBlock(ctx2); close(done2) }()
	time.Sleep(60 * time.Millisecond)
	cancel2()
	<-done2
	if hits.Load() != 0 {
		t.Fatalf("heartbeat sent with empty URL: %d", hits.Load())
	}
}
