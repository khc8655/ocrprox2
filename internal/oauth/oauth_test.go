package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
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

func TestPKCE_Generation(t *testing.T) {
	v1, c1, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("GeneratePKCE err: %v", err)
	}
	if len(v1) < 43 {
		t.Errorf("verifier too short: %d", len(v1))
	}
	if c1 == "" {
		t.Errorf("empty challenge")
	}

	// Verify randomness
	v2, c2, _ := GeneratePKCE()
	if v1 == v2 || c1 == c2 {
		t.Errorf("GeneratePKCE produced duplicate values")
	}
}

func TestOAuth_PKCE_DeviceFlow(t *testing.T) {
	var receivedChallenge, receivedMethod, receivedVerifier string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/device/code" {
			_ = r.ParseForm()
			receivedChallenge = r.Form.Get("code_challenge")
			receivedMethod = r.Form.Get("code_challenge_method")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code":      "dev-pkce-1",
				"user_code":        "PKCE-9999",
				"verification_uri": "https://auth.example.com/activate",
				"expires_in":       600,
				"interval":         5,
			})
			return
		}
		if r.URL.Path == "/oauth/token" {
			_ = r.ParseForm()
			receivedVerifier = r.Form.Get("code_verifier")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "tok-pkce-1",
				"expires_in":   3600,
				"token_type":   "bearer",
			})
			return
		}
	}))
	defer ts.Close()

	mgr := NewManager(true)
	mgr.SetPKCE(true)
	ctx := context.Background()

	session, err := mgr.StartDeviceFlow(ctx, ts.URL+"/device/code", "client-1", "all")
	if err != nil {
		t.Fatalf("StartDeviceFlow with PKCE error: %v", err)
	}
	if receivedChallenge == "" || receivedMethod != "S256" {
		t.Fatalf("server did not receive PKCE challenge or S256 method: ch=%s, method=%s", receivedChallenge, receivedMethod)
	}
	if session.CodeVerifier == "" {
		t.Fatalf("session missing CodeVerifier")
	}

	tok, err := mgr.PollToken(ctx, ts.URL+"/oauth/token", "client-1", session.DeviceCode)
	if err != nil {
		t.Fatalf("PollToken error: %v", err)
	}
	if tok.AccessToken != "tok-pkce-1" {
		t.Errorf("unexpected access token: %s", tok.AccessToken)
	}
	if receivedVerifier != session.CodeVerifier {
		t.Errorf("server received verifier %q, want %q", receivedVerifier, session.CodeVerifier)
	}
}

func TestMiniMax_Quirks(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/device/code" {
			// MiniMax returns expired_in (instead of expires_in) and interval in milliseconds (5000)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code":      "mm-dev-1",
				"user_code":        "MM-5678",
				"verification_uri": "https://auth.minimax.chat/device",
				"expired_in":       3600,
				"interval":         5000,
			})
			return
		}
		if r.URL.Path == "/oauth/token" {
			// MiniMax returns expired_in instead of expires_in
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "mm-access-1",
				"refresh_token": "mm-refresh-1",
				"expired_in":    7200,
				"token_type":    "bearer",
			})
			return
		}
	}))
	defer ts.Close()

	mgr := NewManager(true)
	ctx := context.Background()

	sess, err := mgr.StartDeviceFlow(ctx, ts.URL+"/device/code", "minimax-client", "")
	if err != nil {
		t.Fatalf("StartDeviceFlow error: %v", err)
	}
	if sess.ExpiresIn != 3600 {
		t.Errorf("expected ExpiresIn 3600 from expired_in fallback, got %d", sess.ExpiresIn)
	}
	if sess.Interval != 5 {
		t.Errorf("expected Interval 5s from 5000ms, got %d", sess.Interval)
	}

	tok, err := mgr.PollToken(ctx, ts.URL+"/oauth/token", "minimax-client", sess.DeviceCode)
	if err != nil {
		t.Fatalf("PollToken error: %v", err)
	}
	if tok.AccessToken != "mm-access-1" {
		t.Errorf("expected access token mm-access-1, got %s", tok.AccessToken)
	}
	if tok.ExpiresIn != 7200 {
		t.Errorf("expected ExpiresIn 7200 from expired_in fallback, got %d", tok.ExpiresIn)
	}
}

func TestEnsureValidToken_PersistFunc(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "rotated-access-tok",
			"refresh_token": "rotated-refresh-tok",
			"expires_in":    7200,
			"token_type":    "bearer",
		})
	}))
	defer ts.Close()

	mgr := NewManager(true)
	var persistedEntry *types.KeyEntry
	mgr.SetPersistFunc(func(ctx context.Context, entry *types.KeyEntry) error {
		persistedEntry = entry
		return nil
	})

	keyEntry := &types.KeyEntry{
		ID:    "key-1",
		Label: "minimax-main",
		Key:   "old-token",
		OAuthMeta: &types.OAuthMeta{
			Provider:     "minimax",
			ClientID:     "client-1",
			RefreshToken: "old-refresh-tok",
			ExpiresAt:    time.Now().Unix() + 10, // expiring soon
		},
	}

	err := mgr.EnsureValidToken(context.Background(), keyEntry, ts.URL+"/oauth/token")
	if err != nil {
		t.Fatalf("EnsureValidToken err: %v", err)
	}

	if keyEntry.Key != "rotated-access-tok" {
		t.Errorf("keyEntry.Key was not updated: %s", keyEntry.Key)
	}
	if keyEntry.OAuthMeta.RefreshToken != "rotated-refresh-tok" {
		t.Errorf("keyEntry.OAuthMeta.RefreshToken was not updated: %s", keyEntry.OAuthMeta.RefreshToken)
	}
	if persistedEntry == nil {
		t.Fatalf("PersistFunc was not called")
	}
	if persistedEntry.Key != "rotated-access-tok" {
		t.Errorf("persisted entry key mismatch: %s", persistedEntry.Key)
	}
}

func TestOAuth_ConcurrentRefreshRaceFreeAndSessionPruning(t *testing.T) {
	var refreshHits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/device/code" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code":      "fresh-dev-code",
				"user_code":        "FRESH-1",
				"verification_uri": "https://auth.example.com",
				"expires_in":       600,
				"interval":         5,
			})
			return
		}
		refreshHits.Add(1)
		time.Sleep(10 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "concurrent-access-tok",
			"refresh_token": "concurrent-refresh-tok",
			"expires_in":    7200,
			"token_type":    "bearer",
		})
	}))
	defer ts.Close()

	mgr := NewManager(true)

	// Seed a stale session older than 15 minutes
	mgr.mu.Lock()
	mgr.sessions["stale-dev-code"] = &DeviceSession{
		DeviceCode: "stale-dev-code",
		CreatedAt:  time.Now().Unix() - (SessionMaxAgeSec + 60),
	}
	mgr.mu.Unlock()

	if _, err := mgr.StartDeviceFlow(context.Background(), ts.URL+"/device/code", "cid", ""); err != nil {
		t.Fatalf("StartDeviceFlow err: %v", err)
	}
	mgr.mu.Lock()
	_, staleExists := mgr.sessions["stale-dev-code"]
	mgr.mu.Unlock()
	if staleExists {
		t.Fatalf("expected stale session (>15m) to be pruned during StartDeviceFlow")
	}

	// Hammer EnsureValidToken + GetAccessToken from 16 goroutines under -race
	keyEntry := &types.KeyEntry{
		Key: "expiring-tok",
		OAuthMeta: &types.OAuthMeta{
			Provider:     "minimax",
			ClientID:     "cid",
			RefreshToken: "rtok",
			ExpiresAt:    time.Now().Unix() + 30,
		},
	}

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := mgr.EnsureValidToken(context.Background(), keyEntry, ts.URL+"/oauth/token"); err != nil {
				t.Errorf("EnsureValidToken err: %v", err)
			}
			_ = mgr.GetAccessToken(keyEntry)
		}()
	}
	wg.Wait()

	if refreshHits.Load() != 1 {
		t.Errorf("expected singleflight per-key lock to refresh exactly once, got %d", refreshHits.Load())
	}
	if got := mgr.GetAccessToken(keyEntry); got != "concurrent-access-tok" {
		t.Errorf("expected refreshed token 'concurrent-access-tok', got %q", got)
	}
}
