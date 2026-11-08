package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestOAuth_Lifecycle(t *testing.T) {
	pollAttempts := 0

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")

		if path == "/device/code" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code":      "dev-code-123",
				"user_code":        "ABCD-1234",
				"verification_uri": "https://auth.example.com/activate",
				"expires_in":       600,
				"interval":         5,
			})
			return
		}

		if path == "/oauth/token" {
			grantType := r.FormValue("grant_type")
			if grantType == "urn:ietf:params:oauth:grant-type:device_code" {
				pollAttempts++
				if pollAttempts == 1 {
					w.WriteHeader(http.StatusBadRequest)
					_ = json.NewEncoder(w).Encode(map[string]any{"error": "authorization_pending"})
					return
				}
				// 2nd poll succeeds
				w.WriteHeader(http.StatusOK)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"access_token":  "access-tok-1",
					"refresh_token": "refresh-tok-1",
					"expires_in":    7200,
					"token_type":    "bearer",
				})
				return
			}

			if grantType == "refresh_token" {
				w.WriteHeader(http.StatusOK)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"access_token":  "new-access-tok-2",
					"refresh_token": "new-refresh-tok-2",
					"expires_in":    7200,
					"token_type":    "bearer",
				})
				return
			}
		}
	}))
	defer ts.Close()

	mgr := NewManager(true)
	ctx := context.Background()

	// 1. Start device flow
	session, err := mgr.StartDeviceFlow(ctx, ts.URL+"/device/code", "client-id-1", "all")
	if err != nil {
		t.Fatalf("StartDeviceFlow error: %v", err)
	}
	if session.UserCode != "ABCD-1234" {
		t.Errorf("expected user code ABCD-1234, got %s", session.UserCode)
	}

	// 2. Poll token 1: pending
	_, err = mgr.PollToken(ctx, ts.URL+"/oauth/token", "client-id-1", session.DeviceCode)
	if err != ErrDevicePending {
		t.Fatalf("expected ErrDevicePending on first poll, got %v", err)
	}

	// 3. Poll token 2: success
	tok, err := mgr.PollToken(ctx, ts.URL+"/oauth/token", "client-id-1", session.DeviceCode)
	if err != nil {
		t.Fatalf("PollToken error on 2nd poll: %v", err)
	}
	if tok.AccessToken != "access-tok-1" {
		t.Errorf("expected access_token 'access-tok-1', got %s", tok.AccessToken)
	}

	// 4. EnsureValidToken
	keyEntry := &types.KeyEntry{
		Key: tok.AccessToken,
		OAuthMeta: &types.OAuthMeta{
			ClientID:     "client-id-1",
			RefreshToken: tok.RefreshToken,
			ExpiresAt:    time.Now().Unix() + 100, // Expiring soon (< 1h)
		},
	}

	err = mgr.EnsureValidToken(ctx, keyEntry, ts.URL+"/oauth/token")
	if err != nil {
		t.Fatalf("EnsureValidToken error: %v", err)
	}
	if keyEntry.Key != "new-access-tok-2" {
		t.Errorf("expected refreshed key 'new-access-tok-2', got %s", keyEntry.Key)
	}
}
