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

func TestVerifyAdminAuth_RejectsQueryStringTokens(t *testing.T) {
	a := NewAuthenticator("my-client-key", "admin-pass")

	req := httptest.NewRequest("GET", "/api/config?key=admin-pass&token=admin-pass", nil)
	req.RemoteAddr = "192.168.1.77:54321"
	if a.VerifyAdminAuth(req) {
		t.Fatalf("expected VerifyAdminAuth to reject credentials supplied via URL query string")
	}

	reqHdr := httptest.NewRequest("GET", "/api/config", nil)
	reqHdr.RemoteAddr = "192.168.1.77:54321"
	reqHdr.Header.Set("X-Api-Key", "admin-pass")
	if !a.VerifyAdminAuth(reqHdr) {
		t.Fatalf("expected VerifyAdminAuth to accept X-Api-Key header")
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

func TestUpdateClientKeys_MultiKeyAndHotReload(t *testing.T) {
	a := NewAuthenticator("initial-key", "admin-pass")

	// 1. Initial key works
	req := httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer initial-key")
	if !a.VerifyClientKey(req) {
		t.Errorf("expected initial key to succeed")
	}

	// 2. Extra key doesn't work yet
	req2 := httptest.NewRequest("GET", "/v1/models", nil)
	req2.Header.Set("Authorization", "Bearer extra-key-1")
	if a.VerifyClientKey(req2) {
		t.Errorf("expected extra key to fail before update")
	}

	// 3. Hot update with new primary and multiple extra keys
	a.UpdateClientKeys("primary-v2", []string{"extra-key-1", "extra-key-2", "  extra-key-3  "})

	// Primary key works
	req3 := httptest.NewRequest("GET", "/v1/models", nil)
	req3.Header.Set("Authorization", "Bearer primary-v2")
	if !a.VerifyClientKey(req3) {
		t.Errorf("expected new primary key to succeed")
	}

	// Old initial key now fails
	if a.VerifyClientKey(req) {
		t.Errorf("expected old initial key to fail after update")
	}

	// All extra keys succeed (via header or query param)
	for _, ek := range []string{"extra-key-1", "extra-key-2", "extra-key-3"} {
		r := httptest.NewRequest("GET", "/v1/models", nil)
		r.Header.Set("Authorization", "Bearer "+ek)
		if !a.VerifyClientKey(r) {
			t.Errorf("expected extra key %q to succeed via Authorization header", ek)
		}

		// Also test X-Api-Key
		rx := httptest.NewRequest("GET", "/v1/models", nil)
		rx.Header.Set("X-Api-Key", ek)
		if !a.VerifyClientKey(rx) {
			t.Errorf("expected extra key %q to succeed via X-Api-Key", ek)
		}
	}

	// Check GetClientKeys
	prim, extras := a.GetClientKeys()
	if prim != "primary-v2" {
		t.Errorf("expected primary-v2, got %s", prim)
	}
	if len(extras) != 3 || extras[2] != "extra-key-3" {
		t.Errorf("expected 3 trimmed extras, got %v", extras)
	}
}
