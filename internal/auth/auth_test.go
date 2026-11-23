package auth

import (
	"fmt"
	"net/http/httptest"
	"testing"
)

func TestVerifyClientKey(t *testing.T) {
	auth := NewAuthenticator("my-client-key", "admin-pass")

	// Missing auth header -> fail
	req := httptest.NewRequest("GET", "/v1/models", nil)
	if auth.VerifyClientKey(req) {
		t.Errorf("expected fail for missing auth header")
	}

	// Correct bearer token -> success
	req = httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer my-client-key")
	if !auth.VerifyClientKey(req) {
		t.Errorf("expected success for valid client key")
	}

	// Loopback request without key -> MUST FAIL (CLIENT_KEY enforced for all including 127.0.0.1)
	req = httptest.NewRequest("GET", "/v1/models", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	if auth.VerifyClientKey(req) {
		t.Errorf("expected loopback request without key to be rejected")
	}

	// Admin password MUST BE REJECTED on /v1/* client key verification (SEC-08)
	req = httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	if auth.VerifyClientKey(req) {
		t.Errorf("expected admin password to be rejected on VerifyClientKey")
	}
}

// Query-string credentials are now ACCEPTED by the admin plane. Historically this
// test asserted the opposite (TestVerifyAdminAuth_RejectsQueryStringTokens); the
// semantics changed by explicit user request: the admin console must support
// ?key=<admin_password> direct login, matching magpie's convenience. This is a
// deliberate security tradeoff for a private deployment — the user accepts the
// URL-leakage risk (browser history, referrer headers, access logs) in exchange
// for one-click console access. Only the admin plane relaxes; the /v1/* data
// plane (VerifyClientKey) is untouched.
func TestVerifyAdminAuth_AcceptsQueryStringTokens(t *testing.T) {
	a := NewAuthenticator("my-client-key", "admin-pass")

	// ?key=<correct> succeeds
	req := httptest.NewRequest("GET", "/api/config?key=admin-pass", nil)
	req.RemoteAddr = "192.168.1.77:54321"
	if !a.VerifyAdminAuth(req) {
		t.Fatalf("expected VerifyAdminAuth to accept ?key=<admin_password> (user-requested convenience tradeoff)")
	}

	// ?token= and ?password= are accepted as fallbacks too
	reqTok := httptest.NewRequest("GET", "/api/config?token=admin-pass", nil)
	reqTok.RemoteAddr = "192.168.1.77:54321"
	if !a.VerifyAdminAuth(reqTok) {
		t.Fatalf("expected VerifyAdminAuth to accept ?token=<admin_password>")
	}

	reqPwd := httptest.NewRequest("GET", "/api/config?password=admin-pass", nil)
	reqPwd.RemoteAddr = "192.168.1.77:54321"
	if !a.VerifyAdminAuth(reqPwd) {
		t.Fatalf("expected VerifyAdminAuth to accept ?password=<admin_password>")
	}

	// Priority: header beats query string — wrong ?key with a correct header must succeed.
	reqHdrWins := httptest.NewRequest("GET", "/api/config?key=wrong", nil)
	reqHdrWins.RemoteAddr = "192.168.1.77:54321"
	reqHdrWins.Header.Set("X-Api-Key", "admin-pass")
	if !a.VerifyAdminAuth(reqHdrWins) {
		t.Fatalf("expected header credential to take priority over query string")
	}

	// Priority within the query string: key beats token — wrong ?key must fail even
	// when ?token carries the correct password.
	reqKeyWins := httptest.NewRequest("GET", "/api/config?key=wrong&token=admin-pass", nil)
	reqKeyWins.RemoteAddr = "192.168.1.77:54321"
	if a.VerifyAdminAuth(reqKeyWins) {
		t.Fatalf("expected ?key to take priority over ?token (wrong key must fail)")
	}

	// Header path still works unchanged
	reqHdr := httptest.NewRequest("GET", "/api/config", nil)
	reqHdr.RemoteAddr = "192.168.1.77:54321"
	reqHdr.Header.Set("X-Api-Key", "admin-pass")
	if !a.VerifyAdminAuth(reqHdr) {
		t.Fatalf("expected VerifyAdminAuth to accept X-Api-Key header")
	}
}

// A wrong query-string credential must be treated exactly like a wrong header:
// it fails and consumes the anti-bruteforce budget.
func TestVerifyAdminAuth_WrongQueryKeyCountsTowardLockout(t *testing.T) {
	a := NewAuthenticator("my-client-key", "admin-pass")
	ip := "192.168.1.78"

	for i := 0; i < MaxFailedAttempts-1; i++ {
		req := httptest.NewRequest("GET", "/api/config?key=wrong", nil)
		req.RemoteAddr = ip + ":54321"
		if a.VerifyAdminAuth(req) {
			t.Fatalf("expected wrong ?key to fail")
		}
		if a.IsIPBlocked(ip) {
			t.Fatalf("should not be blocked after %d attempts", i+1)
		}
	}

	// 5th failed attempt via ?key= -> should block
	req := httptest.NewRequest("GET", "/api/config?key=wrong", nil)
	req.RemoteAddr = ip + ":54321"
	a.VerifyAdminAuth(req)

	if !a.IsIPBlocked(ip) {
		t.Fatalf("expected IP %s to be blocked after %d wrong ?key attempts", ip, MaxFailedAttempts)
	}

	// Correct ?key must then be refused: the block applies regardless of transport.
	okReq := httptest.NewRequest("GET", "/api/config?key=admin-pass", nil)
	okReq.RemoteAddr = ip + ":54321"
	if a.VerifyAdminAuth(okReq) {
		t.Fatalf("expected blocked IP to fail even with correct ?key")
	}
}

func TestGetClientIP_AntiSpoofingRightmostXFF(t *testing.T) {
	t.Setenv("TRUST_PROXY_HEADERS", "")

	// 1. Non-loopback RemoteAddr without TRUST_PROXY_HEADERS must ignore X-Forwarded-For
	rDirect := httptest.NewRequest("POST", "/api/config", nil)
	rDirect.RemoteAddr = "203.0.113.50:4444"
	rDirect.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := GetClientIP(rDirect); got != "203.0.113.50" {
		t.Errorf("expected direct RemoteAddr 203.0.113.50, got %q", got)
	}

	// 2. Loopback reverse proxy: client prepends fake IP "1.1.1.1", proxy appends real "198.51.100.99"
	// Must select rightmost non-loopback IP "198.51.100.99", NOT spoofed parts[0]!
	rProxy := httptest.NewRequest("POST", "/api/config", nil)
	rProxy.RemoteAddr = "127.0.0.1:50000"
	rProxy.Header.Set("X-Forwarded-For", "1.1.1.1, 8.8.8.8, 198.51.100.99")
	if got := GetClientIP(rProxy); got != "198.51.100.99" {
		t.Errorf("expected rightmost XFF IP 198.51.100.99, got %q", got)
	}

	// 3. Chained local proxies: "1.1.1.1, 198.51.100.99, 127.0.0.1" -> rightmost non-loopback "198.51.100.99"
	rChain := httptest.NewRequest("POST", "/api/config", nil)
	rChain.RemoteAddr = "[::1]:50000"
	rChain.Header.Set("X-Forwarded-For", "1.1.1.1, 198.51.100.99, 127.0.0.1")
	if got := GetClientIP(rChain); got != "198.51.100.99" {
		t.Errorf("expected rightmost non-loopback XFF IP 198.51.100.99, got %q", got)
	}
}

func TestAuthenticator_BoundedMaps(t *testing.T) {
	a := NewAuthenticator("client-key", "admin-pass")

	for i := 0; i < MaxTrackedIPs+200; i++ {
		ip := fmt.Sprintf("10.%d.%d.%d", (i>>16)&0xff, (i>>8)&0xff, (i%250)+1)
		for attempt := 0; attempt < MaxFailedAttempts; attempt++ {
			req := httptest.NewRequest("POST", "/api/config", nil)
			req.RemoteAddr = ip + ":12345"
			req.Header.Set("Authorization", "Bearer wrong")
			a.VerifyAdminAuth(req)
		}
	}

	a.mu.RLock()
	failedLen := len(a.failedAttempts)
	blockedLen := len(a.blockedIPs)
	a.mu.RUnlock()

	if failedLen > MaxTrackedIPs {
		t.Errorf("failedAttempts exceeded cap %d: got %d", MaxTrackedIPs, failedLen)
	}
	if blockedLen > MaxTrackedIPs {
		t.Errorf("blockedIPs exceeded cap %d: got %d", MaxTrackedIPs, blockedLen)
	}
}

func TestVerifyAdminAuth_AntiBruteforce(t *testing.T) {
	auth := NewAuthenticator("my-client-key", "admin-pass")

	ip := "192.168.1.50"
	remoteAddr := ip + ":54321"

	// 4 failed attempts
	for i := 0; i < 4; i++ {
		req := httptest.NewRequest("POST", "/api/config", nil)
		req.RemoteAddr = remoteAddr
		req.Header.Set("Authorization", "Bearer wrong-pass")
		if auth.VerifyAdminAuth(req) {
			t.Fatalf("expected wrong pass to fail")
		}
		if auth.IsIPBlocked(ip) {
			t.Fatalf("should not be blocked after %d attempts", i+1)
		}
	}

	// 5th failed attempt -> should block
	req := httptest.NewRequest("POST", "/api/config", nil)
	req.RemoteAddr = remoteAddr
	req.Header.Set("Authorization", "Bearer wrong-pass")
	auth.VerifyAdminAuth(req)

	if !auth.IsIPBlocked(ip) {
		t.Fatalf("expected IP %s to be blocked after 5 attempts", ip)
	}

	// Even with correct password, blocked IP must fail
	req = httptest.NewRequest("POST", "/api/config", nil)
	req.RemoteAddr = remoteAddr
	req.Header.Set("Authorization", "Bearer admin-pass")
	if auth.VerifyAdminAuth(req) {
		t.Fatalf("expected blocked IP to fail even with correct password")
	}
}

func TestVerifyAdminAuth_CredentiallessRequestsDoNotLock(t *testing.T) {
	a := NewAuthenticator("my-client-key", "admin-pass")

	ip := "192.168.1.51"
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest("GET", "/api/config", nil)
		req.RemoteAddr = ip + ":54321"
		if a.VerifyAdminAuth(req) {
			t.Fatalf("credential-less request must not authenticate")
		}
	}

	if a.IsIPBlocked(ip) {
		t.Fatalf("credential-less requests must not consume the brute-force budget")
	}

	req := httptest.NewRequest("GET", "/api/config", nil)
	req.RemoteAddr = ip + ":54321"
	req.Header.Set("Authorization", "Bearer admin-pass")
	if !a.VerifyAdminAuth(req) {
		t.Fatalf("correct password must still work after credential-less requests")
	}
}

func TestVerifyAdminAuth_BlockRemaining(t *testing.T) {
	a := NewAuthenticator("", "admin-pass")
	ip := "192.168.1.52"

	if got := a.BlockRemaining(ip); got != 0 {
		t.Fatalf("expected no block duration, got %v", got)
	}

	for i := 0; i < MaxFailedAttempts; i++ {
		req := httptest.NewRequest("GET", "/api/config", nil)
		req.RemoteAddr = ip + ":54321"
		req.Header.Set("Authorization", "Bearer wrong")
		a.VerifyAdminAuth(req)
	}

	remaining := a.BlockRemaining(ip)
	if remaining <= 0 || remaining > BlockDuration {
		t.Fatalf("expected remaining block within (0, %v], got %v", BlockDuration, remaining)
	}
}

func TestSetClientKey_HotReloadSingleKey(t *testing.T) {
	a := NewAuthenticator("initial-key", "admin-pass")

	// 1. Initial key works
	req := httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer initial-key")
	if !a.VerifyClientKey(req) {
		t.Errorf("expected initial key to succeed")
	}

	// 2. A key that was never configured fails
	req2 := httptest.NewRequest("GET", "/v1/models", nil)
	req2.Header.Set("Authorization", "Bearer extra-key-1")
	if a.VerifyClientKey(req2) {
		t.Errorf("expected unconfigured key to fail")
	}

	// 3. Hot update replaces the single key
	a.SetClientKey("primary-v2")

	req3 := httptest.NewRequest("GET", "/v1/models", nil)
	req3.Header.Set("Authorization", "Bearer primary-v2")
	if !a.VerifyClientKey(req3) {
		t.Errorf("expected new primary key to succeed")
	}

	// Old initial key now fails
	if a.VerifyClientKey(req) {
		t.Errorf("expected old initial key to fail after update")
	}

	// #8: no second slot exists, so the old multi-key extras never authenticate
	for _, ek := range []string{"extra-key-1", "extra-key-2", "extra-key-3"} {
		r := httptest.NewRequest("GET", "/v1/models", nil)
		r.Header.Set("Authorization", "Bearer "+ek)
		if a.VerifyClientKey(r) {
			t.Errorf("#8 violation: extra key %q authenticated", ek)
		}
	}

	// The same single key is accepted via X-Api-Key and the x-goog-api-key header
	for _, header := range []string{"X-Api-Key", "x-goog-api-key"} {
		rx := httptest.NewRequest("GET", "/v1/models", nil)
		rx.Header.Set(header, "primary-v2")
		if !a.VerifyClientKey(rx) {
			t.Errorf("expected single client key to succeed via %s", header)
		}
	}

	if got := a.GetClientKey(); got != "primary-v2" {
		t.Errorf("expected primary-v2, got %s", got)
	}
}
