package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/modesched"
	"github.com/khc8655/llmproxy2/internal/oauth"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

func TestAdminServer_HTML(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// GET /
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for GET /, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `window.__HOST_KIND__="full"`) &&
		!strings.Contains(rec.Body.String(), `window.__HOST_KIND__ = "full"`) {
		t.Errorf("expected __HOST_KIND__ full in HTML response, got:\n%s", rec.Body.String()[:200])
	}

	// GET /admin
	req = httptest.NewRequest("GET", "/admin", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for GET /admin, got %d", rec.Code)
	}

	// GET /unknown -> 404
	req = httptest.NewRequest("GET", "/some/other/path", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown path, got %d", rec.Code)
	}
}

func TestAdminServer_ConfigAndAuth(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. Unauthorized GET /api/config
	req := httptest.NewRequest("GET", "/api/config", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthorized GET /api/config, got %d", rec.Code)
	}

	// 2. Authorized GET /api/config (initial empty)
	req = httptest.NewRequest("GET", "/api/config", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for authorized GET /api/config, got %d", rec.Code)
	}
	var getResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &getResp)
	if getResp["ok"] != true {
		t.Errorf("expected ok: true in GET /api/config, got %+v", getResp)
	}

	// 3. Authorized POST /api/config
	cfg := types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: "https://api.p1.com",
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "hk-01", Key: "sk-real-secret-123456", Enabled: true}},
			},
		},
	}
	body, _ := json.Marshal(cfg)

	req = httptest.NewRequest("POST", "/api/config", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on save config, got %d: %s", rec.Code, rec.Body.String())
	}

	var postResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &postResp)
	if postResp["ok"] != true {
		t.Errorf("expected ok: true in POST /api/config, got %+v", postResp)
	}

	// Returned config should have masked secret
	if !strings.Contains(rec.Body.String(), "●●●●●●") {
		t.Errorf("expected masked secret in response, got %s", rec.Body.String())
	}

	// 4. CAS Conflict: Send stale version 100
	staleCfg := types.ProxyConfig{
		Version: 100, // Conflict!
		Providers: map[string]*types.ProviderConfig{
			"p1": {ID: "p1", BaseURL: "https://api.p1.com"},
		},
	}
	staleBody, _ := json.Marshal(staleCfg)

	req = httptest.NewRequest("POST", "/api/config", bytes.NewReader(staleBody))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict on version mismatch, got %d", rec.Code)
	}

	var conflictResp struct {
		OK               bool   `json:"ok"`
		Error            string `json:"error"`
		CurrentVersion   int64  `json:"current_version"`
		SubmittedVersion int64  `json:"submitted_version"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &conflictResp)
	if conflictResp.OK != false || conflictResp.Error != "config_version_conflict" {
		t.Errorf("unexpected conflict response: %+v", conflictResp)
	}
	if conflictResp.SubmittedVersion != 100 {
		t.Errorf("expected submitted_version 100, got %d", conflictResp.SubmittedVersion)
	}
}

func TestAdminServer_Mode(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)
	modeSched := modesched.NewModeScheduler(types.ModeAgent, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetModeScheduler(modeSched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// GET /api/admin/mode
	req := httptest.NewRequest("GET", "/api/admin/mode", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var modeResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &modeResp)
	if modeResp["mode"] != "agent" {
		t.Errorf("expected mode agent, got %v", modeResp["mode"])
	}

	// POST /api/admin/mode -> "kb"
	req = httptest.NewRequest("POST", "/api/admin/mode", strings.NewReader(`{"mode":"kb"}`))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &modeResp)
	if modeResp["ok"] != true || modeResp["mode"] != "kb" {
		t.Errorf("expected ok: true, mode: kb, got %+v", modeResp)
	}

	if modeSched.CurrentMode() != types.ModeKB {
		t.Errorf("expected modeSched to be updated to kb, got %s", modeSched.CurrentMode())
	}
}

func TestAdminServer_VerifyKeyAndProbeModels(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader != "Bearer test-real-key" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid key"}`))
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"gpt-4o"},{"id":"claude-3-5-sonnet"}]}`))
	}))
	defer mockUpstream.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	// Save provider with real key
	_, _ = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"mock-prov": {
				ID:      "mock-prov",
				BaseURL: mockUpstream.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Key: "test-real-key", Enabled: true}},
			},
		},
	})

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(mockUpstream.Client())
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. VerifyKey with masked key (should resolve from localSrc)
	verifyBody := strings.NewReader(`{"provider":"mock-prov","api_key":"●●●●●●"}`)
	req := httptest.NewRequest("POST", "/api/admin/verify-key", verifyBody)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var vResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &vResp)
	if vResp["valid"] != true || vResp["status"] != float64(200) || vResp["models_count"] != float64(2) {
		t.Errorf("unexpected verify response: %+v", vResp)
	}

	// 2. ProbeModels with masked key
	probeBody := strings.NewReader(`{"provider":"mock-prov","api_key":"●●●●●●"}`)
	req = httptest.NewRequest("POST", "/api/admin/probe-models", probeBody)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var pResp struct {
		OK     bool     `json:"ok"`
		Models []string `json:"models"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &pResp)
	if !pResp.OK || len(pResp.Models) != 2 || pResp.Models[0] != "gpt-4o" {
		t.Errorf("unexpected probe models response: %+v", pResp)
	}
}

func TestAdminServer_Cooldowns(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Apply a cooldown
	sched.Cooldowns().ApplyCooldown("p1", "m1", "k1", 429, 30*time.Second, 0, 0, 0)

	// GET /api/admin/cooldowns
	req := httptest.NewRequest("GET", "/api/admin/cooldowns", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var cdResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &cdResp)
	if cdResp["ok"] != true || cdResp["total"] != float64(1) {
		t.Errorf("unexpected cooldown response: %+v", cdResp)
	}

	// DELETE /api/admin/cooldowns
	req = httptest.NewRequest("DELETE", "/api/admin/cooldowns", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// GET again -> should be 0
	req = httptest.NewRequest("GET", "/api/admin/cooldowns", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	_ = json.Unmarshal(rec.Body.Bytes(), &cdResp)
	if cdResp["total"] != float64(0) {
		t.Errorf("expected 0 cooldowns after delete, got %v", cdResp["total"])
	}
}

func TestAdminServer_OAuth(t *testing.T) {
	oauthServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "code") {
			_, _ = w.Write([]byte(`{
				"device_code": "dev-12345",
				"user_code": "USER-9999",
				"verification_uri": "https://auth.example.com/activate",
				"expires_in": 300,
				"interval": 5
			}`))
			return
		}
		if strings.Contains(r.URL.Path, "token") {
			_, _ = w.Write([]byte(`{
				"access_token": "at-secret-token",
				"refresh_token": "rt-secret-token",
				"expires_in": 3600,
				"token_type": "Bearer"
			}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer oauthServer.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	oauthMgr := oauth.NewManager(true)
	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetOAuthManager(oauthMgr)
	srv.SetHTTPClient(oauthServer.Client())

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. POST /api/admin/oauth/start
	startBody := strings.NewReader(`{"endpoint":"` + oauthServer.URL + `/code","client_id":"c1"}`)
	req := httptest.NewRequest("POST", "/api/admin/oauth/start", startBody)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for oauth start, got %d: %s", rec.Code, rec.Body.String())
	}
	var startResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &startResp)
	if startResp["device_code"] != "dev-12345" || startResp["user_code"] != "USER-9999" {
		t.Errorf("unexpected oauth start response: %+v", startResp)
	}

	// 2. POST /api/admin/oauth/poll
	pollBody := strings.NewReader(`{"endpoint":"` + oauthServer.URL + `/token","client_id":"c1","device_code":"dev-12345"}`)
	req = httptest.NewRequest("POST", "/api/admin/oauth/poll", pollBody)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for oauth poll, got %d: %s", rec.Code, rec.Body.String())
	}
	var pollResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &pollResp)
	if pollResp["ok"] != true {
		t.Errorf("expected ok: true in oauth poll response, got %+v", pollResp)
	}
}

func TestAdminServer_VaultSync(t *testing.T) {
	hubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/vault/manifest" {
			_, _ = w.Write([]byte(`{
				"ok": true,
				"_version": 10,
				"providers": {
					"vault-p1": {"name": "Vault P1", "base_url": "https://api.vault1.com"}
				}
			}`))
			return
		}
		if r.URL.Path == "/api/vault/fetch" {
			_, _ = w.Write([]byte(`{
				"ok": true,
				"provider": "vault-p1",
				"provider_config": {
					"id": "vault-p1",
					"name": "Vault P1",
					"base_url": "https://api.vault1.com",
					"enabled": true,
					"api_keys": [
						{"id": "k-vault", "label": "vk1", "key": "sk-vault-123", "enabled": true}
					]
				}
			}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer hubServer.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(hubServer.Client())

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. GET /api/vault/manifest
	req := httptest.NewRequest("GET", "/api/vault/manifest?hub_url="+hubServer.URL+"&node_token=tok1", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for manifest, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "vault-p1") {
		t.Errorf("expected vault-p1 in manifest response, got %s", rec.Body.String())
	}

	// 2. POST /api/vault/fetch (fetches and auto-merges into localSrc)
	fetchBody := strings.NewReader(`{"hub_url":"` + hubServer.URL + `","node_token":"tok1","provider":"vault-p1"}`)
	req = httptest.NewRequest("POST", "/api/vault/fetch", fetchBody)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for vault fetch, got %d: %s", rec.Code, rec.Body.String())
	}

	// Verify localSrc now contains vault-p1 with origin "vault"
	snap, err := localSrc.Current(context.Background(), false)
	if err != nil || snap == nil || snap.Config == nil {
		t.Fatalf("failed to get local config snapshot: %v", err)
	}
	vp, exists := snap.Config.Providers["vault-p1"]
	if !exists {
		t.Fatalf("expected vault-p1 to be merged into local config")
	}
	if vp.Origin != "vault" {
		t.Errorf("expected provider origin vault, got %s", vp.Origin)
	}
	if len(vp.APIKeys) != 1 || vp.APIKeys[0].Key != "sk-vault-123" {
		t.Errorf("unexpected merged api keys: %+v", vp.APIKeys)
	}
}
