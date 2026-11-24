package hubheartbeat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// newTestClient builds a client pointed at srv with no startup delay.
func newTestClient(t *testing.T, srv *httptest.Server, interval time.Duration) (*Client, *[]int64) {
	t.Helper()
	var seen []int64
	var mu sync.Mutex
	c := NewClient(srv.URL, "stk_node_deadbeef", "v-test", interval, func(string, ...any) {})
	c.initialDelay = 0
	c.SetBeatHandler(func(b Beat) {
		mu.Lock()
		if b.ConfigVersion > 0 {
			seen = append(seen, b.ConfigVersion)
		}
		mu.Unlock()
	})
	t.Cleanup(func() { mu.Lock(); mu.Unlock() })
	return c, &seen
}

// The hub answers heartbeats with the current config_version; the client must
// surface it so the node can pull a template the operator just changed.
func TestHeartbeat_ReportsHubConfigVersion(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if got := r.Header.Get("X-Node-Version"); got != "v-test" {
			t.Errorf("expected X-Node-Version v-test, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "config_version": 7})
	}))
	defer srv.Close()

	c, seen := newTestClient(t, srv, time.Hour)
	c.send(context.Background())

	if atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("expected 1 heartbeat, got %d", hits)
	}
	if len(*seen) != 1 || (*seen)[0] != 7 {
		t.Fatalf("expected config_version 7 to be reported, got %v", *seen)
	}
}

// An older hub still answers a bodyless 204; that must not be an error and must
// not report a bogus version.
func TestHeartbeat_LegacyHub204ReportsNothing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c, seen := newTestClient(t, srv, time.Hour)
	c.send(context.Background())

	if len(*seen) != 0 {
		t.Fatalf("a 204 must report no version, got %v", *seen)
	}
}

// A revoked node answers 401: that must surface as a revocation so the caller
// stops serving at once, rather than waiting out a 24h lease.
func TestHeartbeat_UnauthorizedReportsRevocation(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"ok":false,"error":"node_revoked_or_invalid"}`))
	}))
	defer srv.Close()

	var beats []Beat
	c, _ := newTestClient(t, srv, time.Hour)
	c.SetBeatHandler(func(b Beat) { beats = append(beats, b) })
	c.send(context.Background())

	if atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("expected exactly one attempt, got %d", hits)
	}
	if len(beats) != 1 || !beats[0].Revoked {
		t.Fatalf("a 401 must report Revoked=true, got %+v", beats)
	}
	if beats[0].ConfigVersion != 0 {
		t.Fatalf("a revoked beat carries no config version, got %d", beats[0].ConfigVersion)
	}
}

// A 403 (deleted node) is the same signal as a 401.
func TestHeartbeat_ForbiddenReportsRevocation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	var beats []Beat
	c, _ := newTestClient(t, srv, time.Hour)
	c.SetBeatHandler(func(b Beat) { beats = append(beats, b) })
	c.send(context.Background())

	if len(beats) != 1 || !beats[0].Revoked {
		t.Fatalf("a 403 must report Revoked=true, got %+v", beats)
	}
}

// A successful beat is not a revocation — the caller must not purge on it.
func TestHeartbeat_SuccessIsNotRevoked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "config_version": 3})
	}))
	defer srv.Close()

	var beats []Beat
	c, _ := newTestClient(t, srv, time.Hour)
	c.SetBeatHandler(func(b Beat) { beats = append(beats, b) })
	c.send(context.Background())

	if len(beats) != 1 || beats[0].Revoked {
		t.Fatalf("a 200 must not report Revoked, got %+v", beats)
	}
	if beats[0].ConfigVersion != 3 {
		t.Fatalf("expected config_version 3, got %d", beats[0].ConfigVersion)
	}
}

// A body larger than the cap must be ignored rather than buffered: a heartbeat
// must never block on a chatty upstream.
func TestHeartbeat_OversizedBodyIsIgnored(t *testing.T) {
	big := make([]byte, 8192)
	for i := range big {
		big[i] = 'x'
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(big)
	}))
	defer srv.Close()

	c, seen := newTestClient(t, srv, time.Hour)
	c.send(context.Background())

	if len(*seen) != 0 {
		t.Fatalf("an oversized/invalid body must report nothing, got %v", *seen)
	}
}
