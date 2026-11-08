package auth

import (
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

	// Admin password as fallback -> success
	req = httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	if !auth.VerifyClientKey(req) {
		t.Errorf("expected admin password to pass as client key fallback")
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
