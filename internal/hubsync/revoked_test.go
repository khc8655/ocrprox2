package hubsync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// A revoked node must be able to come back on its own. The hub's revocation is
// reversible (the operator can re-enable the node), but purgeAndRevoke used to
// wipe nodeToken — after which the process had nothing to authenticate with and
// stayed 503 until systemd restarted it. Found in the 2026-11-24 lite E2E:
// PATCH {enabled:false} → 503, PATCH {enabled:true} → still 503 forever.
func TestHubSource_RevokedNodeRecoversWithoutRestart(t *testing.T) {
	var revoked int32 = 0
	var requestCount int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		if atomic.LoadInt32(&revoked) == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"ok":false,"error":"node_revoked_or_invalid"}`))
			return
		}
		w.Header().Set("ETag", `"v2"`)
		w.Header().Set("X-Lease-Until", time.Now().Add(time.Hour).Format(time.RFC3339Nano))
		w.Header().Set("X-Grace-Until", time.Now().Add(2*time.Hour).Format(time.RFC3339Nano))
		_, _ = w.Write([]byte(`{"ok":true,"config_version":2,"lease_ttl":3600,"grace_ttl":600,"payload":{` +
			`"providers":{"p1":{"id":"p1","base_url":"https://example.com/v1","enabled":true,"api_keys":[{"id":"k1","label":"k1","key":"sk-secret","enabled":true}]}},` +
			`"agent_models":{"m1":{"enabled":true,"candidates":[{"provider":"p1","key_label":"k1","enabled":true}]}},` +
			`"settings":{}}}`))
	}))
	defer ts.Close()

	src := NewHubSource(ts.URL, "stk_node_deadbeef", true)
	ctx := context.Background()

	// 1. First sync succeeds.
	snap, err := src.Current(ctx, true)
	if err != nil {
		t.Fatalf("initial sync failed: %v", err)
	}
	if snap == nil || snap.Config.Providers["p1"] == nil {
		t.Fatalf("expected a usable snapshot, got %+v", snap)
	}
	if got := snap.Config.Providers["p1"].APIKeys[0].Key; got != "sk-secret" {
		t.Fatalf("expected the key to be present, got %q", got)
	}

	// 2. Hub revokes: state goes revoked and secrets are purged.
	atomic.StoreInt32(&revoked, 1)
	// Force the next call to actually hit the hub rather than serve the lease.
	src.mu.Lock()
	src.snapshot.Store(nil)
	src.mu.Unlock()

	if _, err := src.Current(ctx, true); err != ErrNodeUnauthorized {
		t.Fatalf("expected ErrNodeUnauthorized after revoke, got %v", err)
	}
	if _, state, _, _ := src.HealthState(); state != StateRevoked {
		t.Fatalf("expected state revoked, got %s", state)
	}

	// 3. Inside the retry window it still fails fast (no hub hammering)...
	before := atomic.LoadInt32(&requestCount)
	if _, err := src.Current(ctx, false); err != ErrNodeUnauthorized {
		t.Fatalf("expected fast-fail inside the retry window, got %v", err)
	}
	if after := atomic.LoadInt32(&requestCount); after != before {
		t.Fatalf("a call inside the retry window must not reach the hub (before=%d after=%d)", before, after)
	}

	// 4. ...but the token must still be there, so recovery is possible.
	if src.nodeToken == "" {
		t.Fatal("purgeAndRevoke must keep nodeToken: revocation is reversible on the hub side")
	}

	// 5. Operator re-enables the node. Once the window elapses the source heals
	//    with no restart and no manual intervention.
	atomic.StoreInt32(&revoked, 0)
	src.mu.Lock()
	src.revokedAt = time.Now().Add(-2 * revokedRetryAfter)
	src.mu.Unlock()

	snap, err = src.Current(ctx, false)
	if err != nil {
		t.Fatalf("expected recovery after re-enable, got %v", err)
	}
	if snap == nil || snap.Config.Providers["p1"] == nil {
		t.Fatalf("expected a usable snapshot after recovery, got %+v", snap)
	}
	if _, state, _, _ := src.HealthState(); state != StateReady {
		t.Fatalf("expected state ready after recovery, got %s", state)
	}
}

// A genuinely revoked node must not spam the hub: the retry window is rate
// limiting, not a retry storm.
func TestHubSource_RevokedRetryIsRateLimited(t *testing.T) {
	var requestCount int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer ts.Close()

	src := NewHubSource(ts.URL, "stk_node_deadbeef", true)
	ctx := context.Background()

	if _, err := src.Current(ctx, true); err != ErrNodeUnauthorized {
		t.Fatalf("expected revoke, got %v", err)
	}
	first := atomic.LoadInt32(&requestCount)

	for i := 0; i < 20; i++ {
		if _, err := src.Current(ctx, true); err != ErrNodeUnauthorized {
			t.Fatalf("call %d: expected ErrNodeUnauthorized, got %v", i, err)
		}
	}
	if n := atomic.LoadInt32(&requestCount); n != first {
		t.Fatalf("20 revoked calls must cost 0 extra hub requests, but %d → %d", first, n)
	}
}

// The heartbeat calls MarkRevoked when the hub reports the node is disabled.
// That must drop the cached keys immediately: a node with an unexpired lease
// would otherwise keep serving them for up to 24h (the data plane only re-checks
// the hub when the lease runs out).
func TestHubSource_MarkRevokedPurgesImmediately(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("X-Lease-Until", time.Now().Add(24*time.Hour).Format(time.RFC3339Nano))
		w.Header().Set("X-Grace-Until", time.Now().Add(25*time.Hour).Format(time.RFC3339Nano))
		_, _ = w.Write([]byte(`{"ok":true,"config_version":1,"lease_ttl":86400,"grace_ttl":3600,"payload":{` +
			`"providers":{"p1":{"id":"p1","base_url":"https://example.com/v1","enabled":true,"api_keys":[{"id":"k1","label":"k1","key":"sk-secret","enabled":true}]}},` +
			`"agent_models":{"m1":{"enabled":true,"candidates":[{"provider":"p1","key_label":"k1","enabled":true}]}},` +
			`"settings":{}}}`))
	}))
	defer ts.Close()

	src := NewHubSource(ts.URL, "stk_node_deadbeef", true)
	ctx := context.Background()

	snap, err := src.Current(ctx, true)
	if err != nil {
		t.Fatalf("initial sync failed: %v", err)
	}
	// 24h lease: without MarkRevoked the source would keep serving from cache.
	if !time.Now().Before(snap.LeaseUntil) {
		t.Fatal("fixture should produce a live lease")
	}

	src.MarkRevoked()

	if got := snap.Config.Providers["p1"].APIKeys[0].Key; got != "" {
		t.Fatalf("MarkRevoked must purge cached keys, got %q", got)
	}
	if _, state, _, _ := src.HealthState(); state != StateRevoked {
		t.Fatalf("expected state revoked, got %s", state)
	}
	if _, err := src.Current(ctx, false); err != ErrNodeUnauthorized {
		t.Fatalf("expected ErrNodeUnauthorized right after MarkRevoked, got %v", err)
	}
}
