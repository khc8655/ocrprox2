package admin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/provider"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

func setupTestMockUpstream() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(path, "/chat/completions"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"hello"}}]}`))

		case strings.Contains(path, "/responses"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"output":[{"content":[{"text":"hello"}]}]}`))

		case strings.Contains(path, "/messages"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"hello"}]}`))

		case strings.Contains(path, "generateContent"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}`))

		case strings.Contains(path, "/user/balance"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{
				"is_available": true,
				"balance_infos": [
					{"currency": "CNY", "total_balance": 100.50, "granted_balance": 20.50, "topped_up_balance": 80.00}
				]
			}`))

		case strings.Contains(path, "/custom/balance"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"data": {"balance": "$42.00"}}`))

		case strings.Contains(path, "/models"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{
				"data": [
					{"id": "deepseek-chat"},
					{"id": "deepseek-reasoner"},
					{"id": "gpt-4o-mini"},
					{"id": "qwen-max"}
				]
			}`))

		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok": true}`))
		}
	}))
}

func TestAdmin_DetectProvider(t *testing.T) {
	mockUpstream := setupTestMockUpstream()
	defer mockUpstream.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-key-1", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(mockUpstream.Client())

	// Seed stored provider
	_, _ = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"stored-prov": {
				ID:      "stored-prov",
				BaseURL: mockUpstream.URL + "/v1",
				APIKeys: []*types.KeyEntry{{ID: "k1", Key: "sk-real-secret-123", Label: "main"}},
			},
		},
	})

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. Missing base URL -> 400
	{
		body, _ := json.Marshal(map[string]string{"base_url": ""})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/detect-provider", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for empty base_url, got %d", rec.Code)
		}
	}

	// 2. Direct base_url probe
	{
		body, _ := json.Marshal(map[string]string{
			"base_url": mockUpstream.URL + "/v1",
			"api_key":  "test-key",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/detect-provider", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for detect, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK        bool                        `json:"ok"`
			Protocols []string                    `json:"protocols"`
			Results   map[string]provider.ProtocolDetection `json:"results"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK {
			t.Fatalf("expected ok=true")
		}
		if len(res.Protocols) == 0 {
			t.Fatalf("expected detected protocols > 0")
		}
	}

	// 3. Resolve stored provider and unmasked key
	{
		body, _ := json.Marshal(map[string]string{
			"provider": "stored-prov",
			"api_key":  "sk-...1234", // masked key
		})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/detect-provider", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for stored prov detect, got %d: %s", rec.Code, rec.Body.String())
		}
	}
}

func TestAdmin_Balance(t *testing.T) {
	mockUpstream := setupTestMockUpstream()
	defer mockUpstream.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-key-1", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(mockUpstream.Client())

	_, _ = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"ds-prov": {
				ID:         "ds-prov",
				PresetID:   "deepseek",
				BaseURL:    mockUpstream.URL + "/v1",
				BalanceURL: mockUpstream.URL + "/user/balance",
				APIKeys:    []*types.KeyEntry{{ID: "k1", Key: "sk-ds-key", Label: "main"}},
			},
		},
	})

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. DeepSeek provider balance
	{
		body, _ := json.Marshal(map[string]string{
			"provider": "ds-prov",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/balance", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for balance, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK      bool                    `json:"ok"`
			Balance *provider.BalanceResult `json:"balance"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK || res.Balance == nil {
			t.Fatalf("expected ok=true with balance result")
		}
		if res.Balance.Amount != "¥100.50" {
			t.Errorf("expected balance ¥100.50, got %s", res.Balance.Amount)
		}
	}

	// 2. Custom balance endpoint and path
	{
		body, _ := json.Marshal(map[string]string{
			"balance_url":  mockUpstream.URL + "/custom/balance",
			"balance_path": "data.balance",
			"api_key":      "sk-custom",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/balance", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for custom balance, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK      bool                    `json:"ok"`
			Balance *provider.BalanceResult `json:"balance"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK || res.Balance == nil || res.Balance.Amount != "$42.00" {
			t.Fatalf("expected balance $42.00, got %+v", res.Balance)
		}
	}
}

func TestAdmin_TestProvider_And_CooldownClearing(t *testing.T) {
	mockUpstream := setupTestMockUpstream()
	defer mockUpstream.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-key-1", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(mockUpstream.Client())

	_, _ = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"test-prov": {
				ID:        "test-prov",
				BaseURL:   mockUpstream.URL + "/v1",
				Protocols: []string{"chat"},
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Key: "sk-key-1", Label: "k1-label", Enabled: true},
					{ID: "k2", Key: "sk-key-2", Label: "k2-label", Enabled: true},
				},
			},
		},
	})

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Apply cooldown to k1
	sched.Cooldowns().ApplyCooldown("test-prov", "gpt-4o-mini", "k1-label", 429, 15*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)
	if !sched.Cooldowns().IsCooledDown("test-prov", "gpt-4o-mini", "k1-label") {
		t.Fatalf("expected k1-label to be cooled down")
	}

	// 1. Single test on k1-label -> should succeed and clear cooldown!
	{
		body, _ := json.Marshal(map[string]any{
			"provider":  "test-prov",
			"key_label": "k1-label",
			"model":     "gpt-4o-mini",
			"protocol":  "chat",
			"batch":     false,
		})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/test-provider", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for test-provider, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK      bool                          `json:"ok"`
			Results []provider.ProtocolTestResult `json:"results"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK || len(res.Results) == 0 || !res.Results[0].OK {
			t.Fatalf("expected successful test result: %+v", res.Results)
		}

		// Verify cooldown was cleared!
		if sched.Cooldowns().IsCooledDown("test-prov", "gpt-4o-mini", "k1-label") {
			t.Fatalf("expected cooldown for k1-label to be cleared after passing test")
		}
	}

	// Apply cooldown to k2
	sched.Cooldowns().ApplyCooldown("test-prov", "gpt-4o-mini", "k2-label", 401, 15*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)
	if !sched.Cooldowns().IsCooledDown("test-prov", "gpt-4o-mini", "k2-label") {
		t.Fatalf("expected k2-label to be cooled down")
	}

	// 2. Batch test -> should test all keys and clear k2 cooldown!
	{
		body, _ := json.Marshal(map[string]any{
			"provider": "test-prov",
			"batch":    true,
			"model":    "gpt-4o-mini",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/test-provider", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for batch test, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK      bool                     `json:"ok"`
			Results []provider.KeyTestResult `json:"results"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK || len(res.Results) != 2 {
			t.Fatalf("expected 2 batch key results, got %d", len(res.Results))
		}

		// Verify k2 cooldown cleared
		if sched.Cooldowns().IsCooledDown("test-prov", "gpt-4o-mini", "k2-label") {
			t.Fatalf("expected cooldown for k2-label to be cleared after passing batch test")
		}
	}
}

func TestAdmin_AutolistSync(t *testing.T) {
	mockUpstream := setupTestMockUpstream()
	defer mockUpstream.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-key-1", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(mockUpstream.Client())

	_, _ = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"autolist-prov": {
				ID:          "autolist-prov",
				BaseURL:     mockUpstream.URL + "/v1",
				AutoInclude: "deepseek-*",
				APIKeys:     []*types.KeyEntry{{ID: "k1", Key: "sk-key-1", Label: "main"}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"existing-model": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "other-prov", TargetModel: "existing-model", Enabled: true},
				},
			},
		},
	})

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. Dry-run autolist-sync (apply=false)
	{
		body, _ := json.Marshal(map[string]any{
			"provider": "autolist-prov",
			"apply":    false,
		})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/autolist-sync", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for autolist-sync dry-run, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK      bool     `json:"ok"`
			Models  []string `json:"models"`
			Matched []string `json:"matched"`
			Added   []string `json:"added"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK || len(res.Matched) != 2 {
			t.Fatalf("expected 2 matched models ('deepseek-chat', 'deepseek-reasoner'), got %+v", res.Matched)
		}
		if len(res.Added) != 0 {
			t.Fatalf("expected 0 added on dry run, got %d", len(res.Added))
		}
	}

	// 2. Apply autolist-sync (apply=true)
	{
		body, _ := json.Marshal(map[string]any{
			"provider": "autolist-prov",
			"apply":    true,
		})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/autolist-sync", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for autolist-sync apply, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK      bool     `json:"ok"`
			Models  []string `json:"models"`
			Matched []string `json:"matched"`
			Added   []string `json:"added"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK || len(res.Added) != 2 {
			t.Fatalf("expected 2 added models, got %+v", res.Added)
		}

		// Verify stored in localSrc
		snap, _ := localSrc.Current(nil, false)
		if snap.Config.AgentModels["deepseek-chat"] == nil {
			t.Fatalf("expected deepseek-chat to be added to agent_models")
		}
		if snap.Config.AgentModels["deepseek-reasoner"] == nil {
			t.Fatalf("expected deepseek-reasoner to be added to agent_models")
		}
	}
}

func TestAdmin_PresetsExtra(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-key-1", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/api/admin/presets-extra", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for presets-extra, got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		OK      bool                 `json:"ok"`
		Presets []provider.PresetDef `json:"presets"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&res)
	if !res.OK || len(res.Presets) < 10 {
		t.Fatalf("expected >= 10 presets, got %d", len(res.Presets))
	}
}

func TestAdmin_AccessInfo_And_AccessKey(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("initial-client-key", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)

	_, _ = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		AgentModels: map[string]*types.AgentModelRoute{
			"model-a": {Enabled: true},
			"model-b": {Enabled: true},
		},
		Settings: types.RuntimeSettings{
			ClientKey: "initial-client-key",
			RunMode:   types.ModeAgent,
			ProxyKeys: []string{"extra-1", "extra-2"},
		},
	})

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. GET /api/admin/access-info
	{
		req := httptest.NewRequest(http.MethodGet, "/api/admin/access-info", nil)
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for access-info, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK                  bool     `json:"ok"`
			Mode                string   `json:"mode"`
			ClientKeyConfigured bool     `json:"client_key_configured"`
			ClientKeyMasked     string   `json:"client_key_masked"`
			ProxyKeysCount      int      `json:"proxy_keys_count"`
			Endpoints           []string `json:"endpoints"`
			Models              []string `json:"models"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK || !res.ClientKeyConfigured || len(res.Models) != 2 {
			t.Fatalf("unexpected access-info response: %+v", res)
		}
	}

	// 2. POST /api/admin/access-key with generate: true
	var generatedKey string
	{
		body, _ := json.Marshal(map[string]any{"generate": true})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/access-key", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for access-key generate, got %d: %s", rec.Code, rec.Body.String())
		}
		var res struct {
			OK        bool   `json:"ok"`
			ClientKey string `json:"client_key"`
			Masked    string `json:"masked"`
		}
		_ = json.NewDecoder(rec.Body).Decode(&res)
		if !res.OK || !strings.HasPrefix(res.ClientKey, "sk-llmproxy-") {
			t.Fatalf("unexpected generated key: %s", res.ClientKey)
		}
		generatedKey = res.ClientKey

		// Verify authMgr updated
		testReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		testReq.Header.Set("Authorization", "Bearer "+generatedKey)
		if !authMgr.VerifyClientKey(testReq) {
			t.Fatalf("expected authMgr to verify newly generated client key")
		}
	}

	// 3. POST /api/admin/client-key alias with specific key
	{
		customKey := "my-custom-prod-key-999"
		body, _ := json.Marshal(map[string]any{"client_key": customKey})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/client-key", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-pass")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for client-key update, got %d: %s", rec.Code, rec.Body.String())
		}
		testReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		testReq.Header.Set("Authorization", "Bearer "+customKey)
		if !authMgr.VerifyClientKey(testReq) {
			t.Fatalf("expected authMgr to verify custom client key")
		}
	}
}
