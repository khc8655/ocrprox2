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

	// Node-sourced (origin != vault) keys are returned in plaintext: the operator owns
	// them and the console needs the value to display/copy it. Vault-synced keys are
	// masked separately (see TestAdminServer_VaultKeysMasked).
	bodyStr := string(rec.Body.Bytes())
	if !strings.Contains(bodyStr, "sk-real-secret-123456") {
		t.Errorf("locally added key should be returned plaintext, got %s", bodyStr)
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

func TestAdminServer_DefaultVaultFallback(t *testing.T) {
	dir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-key", "admin-pass")
	localSrc, _ := config.NewLocalSource(dir, "enc-pass")

	var seenAuth string
	hubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true,
			"providers": map[string]any{
				"vault-seed": map[string]any{"name": "Vault Seed", "base_url": "https://api.example.com"},
			},
		})
	}))
	defer hubServer.Close()

	srv := NewServer(authMgr, localSrc, nil, nil)
	srv.SetAllowPrivate(true)
	srv.SetAdminPassword("admin-pass")
	srv.SetDefaultVault(hubServer.URL, "stk_node_seed_token")

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Uninitialized GET /api/config should include pre-seeded vault URL with MASKED NodeToken
	req := httptest.NewRequest("GET", "/api/config", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/config status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "stk_node_seed_token") {
		t.Fatalf("SEC-06 violation: GET /api/config leaked plaintext stk_node_seed_token: %s", rec.Body.String())
	}
	var cfgResp struct {
		Vault *types.VaultClientConfig `json:"vault"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cfgResp); err != nil {
		t.Fatalf("decode config resp: %v", err)
	}
	if cfgResp.Vault == nil || cfgResp.Vault.URL != hubServer.URL || !config.IsMaskedSecret(cfgResp.Vault.NodeToken) {
		t.Fatalf("expected seeded vault with masked NodeToken in /api/config, got %+v", cfgResp.Vault)
	}

	// Vault manifest without query params should STILL send the unmasked SetDefaultVault token
	req = httptest.NewRequest("GET", "/api/vault/manifest", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/vault/manifest status=%d body=%s", rec.Code, rec.Body.String())
	}
	if seenAuth != "Bearer stk_node_seed_token" {
		t.Fatalf("expected Bearer stk_node_seed_token sent to hub, got %q", seenAuth)
	}

	// SEC-07: Overriding hub_url to a different server without supplying a new token MUST NOT send stk_node_seed_token!
	var evilSeenAuth string
	evilHub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		evilSeenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"providers":{}}`))
	}))
	defer evilHub.Close()

	req = httptest.NewRequest("GET", "/api/vault/manifest?hub_url="+evilHub.URL, nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if evilSeenAuth != "" {
		t.Fatalf("SEC-07 violation: stored node_token leaked to overridden hub_url! Authorization=%q", evilSeenAuth)
	}
}

// Vault-synced keys must never come back in plaintext from a node: the node does not
// own them and the console locks editing for them.
func TestAdminServer_VaultKeysMasked(t *testing.T) {
	authMgr := auth.NewAuthenticator("ck", "ap")
	obsMgr, _ := obs.NewManager(types.RoleFull, t.TempDir())
	defer obsMgr.Close()
	src, err := config.NewLocalSource(t.TempDir(), "ap")
	if err != nil {
		t.Fatalf("local source: %v", err)
	}
	if _, err := src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"shared": {
				ID: "shared", BaseURL: "https://x.example", Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "v1", Label: "from-hub", Key: "sk-vault-secret-9999", Enabled: true, Origin: "vault"},
					{ID: "l1", Label: "mine", Key: "sk-local-secret-8888", Enabled: true, Origin: "local"},
				},
			},
		},
	}); err != nil {
		t.Fatalf("save: %v", err)
	}

	srv := NewServer(authMgr, src, obsMgr, scheduler.NewScheduler(src, obsMgr, true))
	srv.SetAdminPassword("ap")
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	req.Header.Set("Authorization", "Bearer ap")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	body := rec.Body.String()
	if strings.Contains(body, "sk-vault-secret-9999") {
		t.Errorf("vault key leaked as plaintext: %s", body)
	}
	if !strings.Contains(body, "-...") {
		t.Errorf("expected a short mask hint for the vault key, got %s", body)
	}
	if !strings.Contains(body, "sk-local-secret-8888") {
		t.Errorf("locally added key should stay plaintext, got %s", body)
	}
}

func TestAdminServer_ExportExcludesVaultSecrets(t *testing.T) {
	authMgr := auth.NewAuthenticator("ck", "ap")
	obsMgr, _ := obs.NewManager(types.RoleFull, t.TempDir())
	defer obsMgr.Close()
	src, err := config.NewLocalSource(t.TempDir(), "ap")
	if err != nil {
		t.Fatalf("local source: %v", err)
	}

	if _, err := src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"vault-only-prov": {
				ID:      "vault-only-prov",
				Name:    "Vault Provider",
				BaseURL: "https://vault.example/v1",
				Origin:  "vault",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "vk-only", Label: "hub-k1", Key: "sk-vault-top-secret-1111", Origin: "vault", Enabled: true},
				},
			},
			"mixed-local-prov": {
				ID:      "mixed-local-prov",
				Name:    "Local Provider With Mixed Keys",
				BaseURL: "https://local.example/v1",
				Origin:  "local",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "lk-1", Label: "my-local-key", Key: "sk-local-exportable-2222", Origin: "local", Enabled: true},
					{ID: "vk-2", Label: "merged-vault-key", Key: "sk-vault-merged-secret-3333", Origin: "vault", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled:    true,
				Candidates: []*types.RouteCandidate{{Provider: "mixed-local-prov", KeyLabel: "my-local-key", Enabled: true}},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {{Provider: "mixed-local-prov", Model: "ocr-v1", KeyLabel: "my-local-key", Enabled: true}},
		},
		Settings: types.RuntimeSettings{
			ClientKey: "sk-client-local-4444",
		},
		Vault: &types.VaultClientConfig{
			URL:       "https://hub.example.com",
			NodeToken: "stk_node_ultra_secret_5555",
		},
	}); err != nil {
		t.Fatalf("save: %v", err)
	}

	srv := NewServer(authMgr, src, obsMgr, scheduler.NewScheduler(src, obsMgr, true))
	srv.SetAdminPassword("ap")
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/api/admin/config/export", nil)
	req.Header.Set("Authorization", "Bearer ap")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on export, got %d: %s", rec.Code, rec.Body.String())
	}

	rawExport := rec.Body.String()
	// Zero vault secrets or node_token may appear anywhere in exported JSON
	for _, forbidden := range []string{
		"vault-only-prov",
		"sk-vault-top-secret-1111",
		"sk-vault-merged-secret-3333",
		"stk_node_ultra_secret_5555",
		"node_token",
	} {
		if strings.Contains(rawExport, forbidden) {
			t.Fatalf("SEC-06 export violation: exported JSON contained forbidden token/provider %q:\n%s", forbidden, rawExport)
		}
	}

	// Local provider/key, routes, settings, and vault.url must remain intact
	var parsed struct {
		Providers   map[string]*types.ProviderConfig  `json:"providers"`
		AgentModels map[string]*types.AgentModelRoute `json:"agent_models"`
		KBModels    map[string][]*types.KBCandidate   `json:"kb_models"`
		Settings    types.RuntimeSettings             `json:"settings"`
		Vault       map[string]any                    `json:"vault"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("unmarshal export: %v", err)
	}
	if _, exists := parsed.Providers["vault-only-prov"]; exists {
		t.Fatalf("vault-only-prov should be omitted from export")
	}
	lp := parsed.Providers["mixed-local-prov"]
	if lp == nil || len(lp.APIKeys) != 1 || lp.APIKeys[0].Key != "sk-local-exportable-2222" {
		t.Fatalf("expected mixed-local-prov with only its 1 local key, got %+v", lp)
	}
	if parsed.AgentModels["gpt-4o"] == nil || len(parsed.KBModels["ocr"]) != 1 || parsed.Settings.ClientKey != "sk-client-local-4444" {
		t.Fatalf("expected routes & settings intact in export")
	}
	if parsed.Vault["url"] != "https://hub.example.com" {
		t.Fatalf("expected vault.url preserved without node_token, got %+v", parsed.Vault)
	}
}

func TestAdminServer_VaultFetchKeysMap_SSRFDefault_And_BaseURLLock(t *testing.T) {
	hubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/vault/fetch" {
			_, _ = w.Write([]byte(`{
				"ok": true,
				"provider": "deepseek",
				"provider_config": {
					"name": "DeepSeek Hub",
					"preset_id": "deepseek",
					"base_url": "https://api.deepseek.com/v1",
					"hide_client_name": true,
					"keys": {
						"hk-01": "sk-ds-vault-secret-0001",
						"hk-02": "sk-ds-vault-secret-0002"
					}
				}
			}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer hubServer.Close()

	evilServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("SEC-06 violation: vault key sent to attacker URL: %s", r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer evilServer.Close()

	authMgr := auth.NewAuthenticator("ck", "ap")
	src, _ := config.NewLocalSource(t.TempDir(), "ap")
	srv := NewServer(authMgr, src, nil, nil)
	srv.SetAdminPassword("ap")

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. SEC-04: By default (allowPrivate=false), 127.0.0.1 hubServer is blocked by SSRF guard!
	fetchReq := httptest.NewRequest(http.MethodPost, "/api/vault/fetch",
		strings.NewReader(`{"hub_url":"`+hubServer.URL+`","node_token":"tok","provider":"deepseek"}`))
	fetchReq.Header.Set("Authorization", "Bearer ap")
	fetchRec := httptest.NewRecorder()
	mux.ServeHTTP(fetchRec, fetchReq)
	if fetchRec.Code != http.StatusBadGateway {
		t.Fatalf("SEC-04: expected 502 Bad Gateway when allowPrivate=false blocks 127.0.0.1, got %d: %s", fetchRec.Code, fetchRec.Body.String())
	}

	// 2. F-08: Enable SetAllowPrivate(true) for local test server -> Vault fetch converts keys map[string]string into APIKeys!
	srv.SetAllowPrivate(true)
	fetchReq2 := httptest.NewRequest(http.MethodPost, "/api/vault/fetch",
		strings.NewReader(`{"hub_url":"`+hubServer.URL+`","node_token":"tok","provider":"deepseek"}`))
	fetchReq2.Header.Set("Authorization", "Bearer ap")
	fetchRec2 := httptest.NewRecorder()
	mux.ServeHTTP(fetchRec2, fetchReq2)
	if fetchRec2.Code != http.StatusOK {
		t.Fatalf("expected 200 after SetAllowPrivate(true), got %d: %s", fetchRec2.Code, fetchRec2.Body.String())
	}

	snap, err := src.Current(context.Background(), false)
	if err != nil || snap == nil || snap.Config == nil {
		t.Fatalf("current snap err: %v", err)
	}
	ds := snap.Config.Providers["deepseek"]
	if ds == nil || ds.Origin != "vault" || !ds.Enabled || len(ds.APIKeys) != 2 {
		t.Fatalf("F-08: expected deepseek provider with 2 vault APIKeys persisted, got %+v", ds)
	}
	if ds.APIKeys[0].Label != "hk-01" || ds.APIKeys[0].Key != "sk-ds-vault-secret-0001" || ds.APIKeys[0].Origin != "vault" {
		t.Fatalf("F-08: unexpected first vault key: %+v", ds.APIKeys[0])
	}

	// 3. SEC-06: verify-key and probe-models must reject overriding base_url when resolving stored vault key!
	for _, ep := range []string{"/api/admin/verify-key", "/api/admin/probe-models"} {
		r := httptest.NewRequest(http.MethodPost, ep,
			strings.NewReader(`{"provider":"deepseek","base_url":"`+evilServer.URL+`","api_key":"sk--...0001"}`))
		r.Header.Set("Authorization", "Bearer ap")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("SEC-06: expected 403 Forbidden from %s when overriding base_url with vault key, got %d: %s", ep, w.Code, w.Body.String())
		}
	}
}

func TestAdminServer_UnifiedVaultSync_And_ExportStripsVaultRoutes(t *testing.T) {
	var seenAuth, seenNodeVer string
	hubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/node/config" && r.Method == http.MethodPost {
			seenAuth = r.Header.Get("Authorization")
			seenNodeVer = r.Header.Get("X-Node-Version")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"ok": true,
				"config_version": 42,
				"payload": {
					"providers": {
						"hub-deepseek": {
							"id": "hub-deepseek",
							"name": "DeepSeek Hub",
							"base_url": "https://api.deepseek.com/v1",
							"enabled": true,
							"api_keys": [
								{"id": "hk-01", "label": "hk-01", "key": "sk-hub-ds-secret-9999", "enabled": true}
							]
						}
					},
					"agent_models": {
						"deepseek-v3": {
							"enabled": true,
							"candidates": [
								{"provider": "hub-deepseek", "key_label": "hk-01", "target_model": "deepseek-chat", "enabled": true}
							]
						}
					},
					"kb_models": {
						"ocr": [
							{"provider": "hub-deepseek", "model": "deepseek-vl", "key_label": "hk-01", "enabled": true}
						]
					},
					"settings": {
						"client_key": "sk-llmproxy-hub-seeded"
					}
				}
			}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer hubServer.Close()

	authMgr := auth.NewAuthenticator("", "ap")
	src, _ := config.NewLocalSource(t.TempDir(), "ap")
	// Pre-seed 1 local provider + 1 local model + 1 stale vault provider
	_, _ = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"my-local": {
				ID: "my-local", BaseURL: "https://local.example/v1", Origin: "local", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "lk1", Label: "lk1", Key: "sk-local-plain-1234", Origin: "local", Enabled: true}},
			},
			"old-vault": {
				ID: "old-vault", BaseURL: "https://old.vault/v1", Origin: "vault", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "ov1", Label: "ov1", Key: "sk-old-vault-0000", Origin: "vault", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"my-local-model": {
				Enabled:    true,
				Origin:     "local",
				Candidates: []*types.RouteCandidate{{Provider: "my-local", KeyLabel: "lk1", Enabled: true}},
			},
		},
	})

	srv := NewServer(authMgr, src, nil, nil)
	srv.SetAllowPrivate(true)
	srv.SetAdminPassword("ap")
	srv.SetBuildInfo("v20261118-02", "2.4.4", "abcdef")
	srv.SetDefaultVault(hubServer.URL, "stk_node_sync_tok")

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. POST /api/vault/sync
	req := httptest.NewRequest(http.MethodPost, "/api/vault/sync", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer ap")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/vault/sync status=%d body=%s", rec.Code, rec.Body.String())
	}
	if seenAuth != "Bearer stk_node_sync_tok" || seenNodeVer != "v20261118-02" {
		t.Fatalf("unexpected hub request headers: auth=%q ver=%q", seenAuth, seenNodeVer)
	}
	if strings.Contains(rec.Body.String(), "sk-hub-ds-secret-9999") {
		t.Fatalf("POST /api/vault/sync leaked plaintext vault key in response: %s", rec.Body.String())
	}

	var syncResp struct {
		OK              bool               `json:"ok"`
		Version         int64              `json:"_version"`
		SyncedProviders int                `json:"synced_providers"`
		SyncedModels    int                `json:"synced_models"`
		Config          *types.ProxyConfig `json:"config"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &syncResp); err != nil {
		t.Fatalf("decode syncResp: %v", err)
	}
	if !syncResp.OK || syncResp.SyncedProviders != 1 || syncResp.SyncedModels != 1 || syncResp.Config == nil {
		t.Fatalf("unexpected syncResp: %+v", syncResp)
	}
	if _, hasOld := syncResp.Config.Providers["old-vault"]; hasOld {
		t.Fatalf("expected old-vault removed")
	}
	if syncResp.Config.AgentModels["deepseek-v3"] == nil || syncResp.Config.AgentModels["my-local-model"] == nil {
		t.Fatalf("expected both deepseek-v3 and my-local-model in merged config")
	}

	// 2. GET /api/admin/config/export must omit hub-deepseek AND omit vault-only deepseek-v3 + vault ocr candidate!
	expReq := httptest.NewRequest(http.MethodGet, "/api/admin/config/export", nil)
	expReq.Header.Set("Authorization", "Bearer ap")
	expRec := httptest.NewRecorder()
	mux.ServeHTTP(expRec, expReq)
	if expRec.Code != http.StatusOK {
		t.Fatalf("export status=%d", expRec.Code)
	}
	expStr := expRec.Body.String()
	for _, forbidden := range []string{"hub-deepseek", "deepseek-v3", "deepseek-vl", "sk-hub-ds-secret-9999"} {
		if strings.Contains(expStr, forbidden) {
			t.Fatalf("export leaked vault artifact %q:\n%s", forbidden, expStr)
		}
	}
	if !strings.Contains(expStr, "my-local-model") || !strings.Contains(expStr, "sk-local-plain-1234") {
		t.Fatalf("export missing local provider/model:\n%s", expStr)
	}
}

func TestAdminServer_AnthropicProbe_EmptyKeyLabelCandidate_And_NumericSettingsValidation(t *testing.T) {
	var seenXAPIKey, seenAnthVer string
	mockAnth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenXAPIKey = r.Header.Get("x-api-key")
		seenAnthVer = r.Header.Get("anthropic-version")
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/models") {
			_, _ = w.Write([]byte(`{"data":[{"id":"claude-sonnet-4-5"}]}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"pong"}]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer mockAnth.Close()

	authMgr := auth.NewAuthenticator("ck", "ap")
	src, _ := config.NewLocalSource(t.TempDir(), "ap")
	srv := NewServer(authMgr, src, nil, nil)
	srv.SetAllowPrivate(true)
	srv.SetAdminPassword("ap")

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. P1-3: Uninitialized GET /api/config returns cold-start schema default settings
	getReq := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	getReq.Header.Set("Authorization", "Bearer ap")
	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, getReq)
	var coldCfg struct {
		Settings types.RuntimeSettings `json:"settings"`
	}
	_ = json.Unmarshal(getRec.Body.Bytes(), &coldCfg)
	if coldCfg.Settings.AgentFirstByteTimeoutSec != 120 || coldCfg.Settings.OCRMaxInflight != 4 || coldCfg.Settings.KBGlobalMaxConcurrency != 16 {
		t.Fatalf("P1-3: expected cold-start default settings on GET /api/config, got %+v", coldCfg.Settings)
	}

	// 2. P1-4: Negative cooldown or out-of-range timeout/concurrency rejected with 400 Bad Request
	for _, badJSON := range []string{
		`{"providers":{},"settings":{"cooldown_rate_limit_sec":-1}}`,
		`{"providers":{},"settings":{"agent_first_byte_timeout_sec":3}}`,
		`{"providers":{},"settings":{"ocr_max_inflight":99}}`,
		`{"providers":{},"settings":{"kb_global_max_concurrency":300}}`,
	} {
		r := httptest.NewRequest(http.MethodPost, "/api/config", strings.NewReader(badJSON))
		r.Header.Set("Authorization", "Bearer ap")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("P1-4: expected 400 Bad Request for %s, got %d: %s", badJSON, w.Code, w.Body.String())
		}
	}

	// 3. P0-07: Anthropic verify-key & probe-models send x-api-key + anthropic-version: 2023-06-01
	vReq := httptest.NewRequest(http.MethodPost, "/api/admin/verify-key",
		strings.NewReader(`{"base_url":"`+mockAnth.URL+`/v1","api_key":"sk-ant-test-key-123456","api_type":"anthropic-messages"}`))
	vReq.Header.Set("Authorization", "Bearer ap")
	vRec := httptest.NewRecorder()
	mux.ServeHTTP(vRec, vReq)
	if vRec.Code != http.StatusOK || seenXAPIKey != "sk-ant-test-key-123456" || seenAnthVer != "2023-06-01" {
		t.Fatalf("P0-07: expected Anthropic headers on verify-key, got code=%d x-api-key=%q ver=%q", vRec.Code, seenXAPIKey, seenAnthVer)
	}

	// 4. P0-06: test-candidate & test-agent-model with key_label == "" ("留空=全部启用Key") resolve first enabled key!
	_, _ = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"anth-prov": {
				ID:               "anth-prov",
				APIType:          "anthropic",
				AnthropicBaseURL: mockAnth.URL + "/v1",
				Enabled:          true,
				APIKeys: []*types.KeyEntry{
					{ID: "ak1", Label: "claude-main", Key: "sk-ant-stored-999", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"claude-sonnet": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "anth-prov", KeyLabel: "", TargetModel: "claude-sonnet-4-5", Enabled: true},
				},
			},
		},
	})

	tcReq := httptest.NewRequest(http.MethodPost, "/api/admin/test-candidate",
		strings.NewReader(`{"provider":"anth-prov","key_label":"","type":"chat","model":""}`))
	tcReq.Header.Set("Authorization", "Bearer ap")
	tcRec := httptest.NewRecorder()
	mux.ServeHTTP(tcRec, tcReq)
	if tcRec.Code != http.StatusOK || !strings.Contains(tcRec.Body.String(), `"ok":true`) {
		t.Fatalf("P0-06: expected test-candidate with empty key_label & model to succeed, got %d: %s", tcRec.Code, tcRec.Body.String())
	}

	tamReq := httptest.NewRequest(http.MethodPost, "/api/admin/test-agent-model",
		strings.NewReader(`{"model":"claude-sonnet"}`))
	tamReq.Header.Set("Authorization", "Bearer ap")
	tamRec := httptest.NewRecorder()
	mux.ServeHTTP(tamRec, tamReq)
	if tamRec.Code != http.StatusOK || !strings.Contains(tamRec.Body.String(), `"passed":1`) {
		t.Fatalf("P0-06: expected test-agent-model with empty key_label candidate to pass, got %d: %s", tamRec.Code, tamRec.Body.String())
	}
}
