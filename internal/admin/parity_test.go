package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

func TestAdminServer_RouteAliases(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("localSrc: %v", err)
	}
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Save initial config
	cfg := types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: "https://api.p1.com",
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "hk-01", Key: "sk-real-123456", Enabled: true}},
			},
		},
	}
	_, err = localSrc.SaveConfig(&cfg)
	if err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	// 1. GET /api/admin/config (unauthorized)
	req := httptest.NewRequest("GET", "/api/admin/config", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthorized GET /api/admin/config, got %d", rec.Code)
	}

	// 2. GET /api/admin/config (authorized)
	req = httptest.NewRequest("GET", "/api/admin/config", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for authorized GET /api/admin/config, got %d", rec.Code)
	}
	var getResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &getResp)
	if getResp["ok"] != true {
		t.Errorf("expected ok: true, got %+v", getResp)
	}

	// 3. POST /api/admin/config
	cfgUpdate := cfg
	cfgUpdate.Version = 1
	b, _ := json.Marshal(cfgUpdate)
	req = httptest.NewRequest("POST", "/api/admin/config", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for POST /api/admin/config, got %d: %s", rec.Code, rec.Body.String())
	}

	// 4. PUT /api/admin/config
	cfgUpdate.Version = 2
	b, _ = json.Marshal(cfgUpdate)
	req = httptest.NewRequest("PUT", "/api/admin/config", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for PUT /api/admin/config, got %d: %s", rec.Code, rec.Body.String())
	}

	// 5. PUT /api/config
	cfgUpdate.Version = 3
	b, _ = json.Marshal(cfgUpdate)
	req = httptest.NewRequest("PUT", "/api/config", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for PUT /api/config, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAdminServer_ConfigExportImportRoundTrip(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("localSrc: %v", err)
	}
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Save initial config with unmasked key
	rawKey := "sk-super-secret-unmasked-key-999"
	initialCfg := types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"custom-prov": {
				ID:      "custom-prov",
				Name:    "Custom Provider",
				BaseURL: "https://api.custom.com/v1",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "k1",
						Label:   "prod-key",
						Key:     rawKey,
						Enabled: true,
					},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{
						Provider: "custom-prov",
						KeyLabel: "prod-key",
						Enabled:  true,
					},
				},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"chat": {
				{
					Provider: "custom-prov",
					Model:    "gpt-4o",
					KeyLabel: "prod-key",
					Enabled:  true,
				},
			},
		},
		Settings: types.RuntimeSettings{
			ClientKey: "cli-key-123",
		},
	}
	_, err = localSrc.SaveConfig(&initialCfg)
	if err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	// 1. GET /api/admin/config/export (unauthorized)
	req := httptest.NewRequest("GET", "/api/admin/config/export", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthorized export, got %d", rec.Code)
	}

	// 2. GET /api/admin/config/export (authorized)
	req = httptest.NewRequest("GET", "/api/admin/config/export", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for export, got %d", rec.Code)
	}
	disp := rec.Header().Get("Content-Disposition")
	if !strings.Contains(disp, "attachment; filename=\"llmproxy_config_") {
		t.Fatalf("unexpected Content-Disposition: %s", disp)
	}

	var exportMap map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &exportMap); err != nil {
		t.Fatalf("failed to decode export json: %v", err)
	}
	if exportMap["ok"] != true {
		t.Fatalf("expected ok: true in exportMap")
	}

	// Crucial check: Export MUST contain UNMASKED real keys!
	provsRaw, ok := exportMap["providers"].(map[string]any)
	if !ok {
		t.Fatalf("providers missing in export")
	}
	cpRaw := provsRaw["custom-prov"].(map[string]any)
	keysList := cpRaw["api_keys"].([]any)
	firstKey := keysList[0].(map[string]any)
	if firstKey["key"] != rawKey {
		t.Fatalf("exported key should be unmasked %q, got %q", rawKey, firstKey["key"])
	}

	// 3. Test Import with mode = "merge"
	importPayload := map[string]any{
		"mode": "merge",
		"config": map[string]any{
			"providers": map[string]any{
				"new-prov": map[string]any{
					"id":       "new-prov",
					"base_url": "https://api.newprov.com",
					"enabled":  true,
					"api_keys": []map[string]any{
						{"id": "k2", "label": "new-k", "key": "sk-new-key-888", "enabled": true},
					},
				},
			},
		},
	}
	importBytes, _ := json.Marshal(importPayload)
	req = httptest.NewRequest("POST", "/api/admin/config/import", bytes.NewReader(importBytes))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on import merge, got %d: %s", rec.Code, rec.Body.String())
	}
	var importResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &importResp)
	if importResp["ok"] != true || importResp["success"] != true {
		t.Fatalf("expected ok: true, success: true, got %+v", importResp)
	}

	// Verify both providers exist after merge
	snap, _ := localSrc.Current(context.Background(), false)
	if snap == nil || snap.Config == nil {
		t.Fatalf("snap is nil after import")
	}
	if len(snap.Config.Providers) != 2 {
		t.Fatalf("expected 2 providers after merge, got %d", len(snap.Config.Providers))
	}
	if snap.Config.Providers["custom-prov"].APIKeys[0].Key != rawKey {
		t.Fatalf("original key was overwritten during merge")
	}
	if snap.Config.Providers["new-prov"].APIKeys[0].Key != "sk-new-key-888" {
		t.Fatalf("new key missing after merge")
	}

	// 4. Test Import with mode = "overwrite"
	overwritePayload := map[string]any{
		"mode": "overwrite",
		"config": map[string]any{
			"providers": map[string]any{
				"only-prov": map[string]any{
					"id":       "only-prov",
					"base_url": "https://api.only.com",
					"enabled":  true,
					"api_keys": []map[string]any{
						{"id": "ko", "label": "only-k", "key": "sk-only-key-111", "enabled": true},
					},
				},
			},
		},
	}
	owBytes, _ := json.Marshal(overwritePayload)
	req = httptest.NewRequest("POST", "/api/admin/config/import", bytes.NewReader(owBytes))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on import overwrite, got %d: %s", rec.Code, rec.Body.String())
	}

	snap, _ = localSrc.Current(context.Background(), false)
	if len(snap.Config.Providers) != 1 || snap.Config.Providers["only-prov"] == nil {
		t.Fatalf("expected only 1 provider after overwrite, got %d", len(snap.Config.Providers))
	}
}

func TestAdminServer_TestCandidate(t *testing.T) {
	// Mock upstream service
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path

		switch {
		case strings.HasSuffix(path, "/chat/completions"):
			body, _ := io.ReadAll(r.Body)
			bodyStr := string(body)
			if strings.Contains(bodyStr, "data:image/png;base64") {
				// Vision / OCR test request
				_ = json.NewEncoder(w).Encode(map[string]any{
					"choices": []map[string]any{
						{"message": map[string]any{"content": "ocr extracted text"}},
					},
				})
			} else {
				// Standard chat test request
				_ = json.NewEncoder(w).Encode(map[string]any{
					"choices": []map[string]any{
						{"message": map[string]any{"content": "chat reply ok"}},
					},
				})
			}

		case strings.HasSuffix(path, "/embeddings"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"embedding": []float64{0.1, 0.2, 0.3}},
				},
			})

		case strings.HasSuffix(path, "/rerank"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []map[string]any{
					{"index": 0, "relevance_score": 0.95},
				},
			})

		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mockUpstream.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(mockUpstream.Client())
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	cfg := types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"mock-prov": {
				ID:      "mock-prov",
				BaseURL: mockUpstream.URL + "/v1",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "test-key", Key: "sk-mock-123456", Enabled: true},
				},
			},
		},
	}
	_, _ = localSrc.SaveConfig(&cfg)

	// Put test-key into cooldown first to verify test-candidate automatically clears it on pass!
	sched.Cooldowns().ApplyCooldown("mock-prov", "test-model", "test-key", 401, 15*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)
	if !sched.Cooldowns().IsCooledDown("mock-prov", "test-model", "test-key") {
		t.Fatalf("expected key to be cooled down before test")
	}

	// 1. Test Chat candidate
	chatReq := map[string]any{
		"provider": "mock-prov",
		"key":      "test-key",
		"type":     "chat",
		"model":    "test-model",
	}
	cb, _ := json.Marshal(chatReq)
	req := httptest.NewRequest("POST", "/api/admin/test-candidate", bytes.NewReader(cb))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for chat candidate test, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != true || resp["status"] != float64(200) || !strings.Contains(fmt.Sprint(resp["text"]), "chat reply ok") {
		t.Fatalf("unexpected chat test response: %+v", resp)
	}

	// Verify cooldown was automatically cleared!
	if sched.Cooldowns().IsCooledDown("mock-prov", "test-model", "test-key") {
		t.Fatalf("expected cooldown to be cleared after passing candidate test")
	}

	// 2. Test OCR candidate (with 1x1 PNG vision conversion)
	ocrReq := map[string]any{
		"provider": "mock-prov",
		"key":      "test-key",
		"type":     "ocr",
		"model":    "ocr-model",
	}
	ob, _ := json.Marshal(ocrReq)
	req = httptest.NewRequest("POST", "/api/admin/test-candidate", bytes.NewReader(ob))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for ocr candidate test, got %d", rec.Code)
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != true || !strings.Contains(fmt.Sprint(resp["text"]), "ocr extracted text") {
		t.Fatalf("unexpected ocr test response: %+v", resp)
	}

	// 3. Test Embedding candidate
	embReq := map[string]any{
		"provider": "mock-prov",
		"key":      "test-key",
		"type":     "embedding",
		"model":    "text-emb",
	}
	eb, _ := json.Marshal(embReq)
	req = httptest.NewRequest("POST", "/api/admin/test-candidate", bytes.NewReader(eb))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for embedding test, got %d", rec.Code)
	}

	// 4. Test Reranker candidate
	rrReq := map[string]any{
		"provider": "mock-prov",
		"key":      "test-key",
		"type":     "reranker",
		"model":    "bge-rerank",
	}
	rb, _ := json.Marshal(rrReq)
	req = httptest.NewRequest("POST", "/api/admin/test-candidate", bytes.NewReader(rb))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for reranker test, got %d", rec.Code)
	}
}

func TestAdminServer_TestAgentModel(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"content": "ok"}},
			},
		})
	}))
	defer mockUpstream.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(mockUpstream.Client())
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	cfg := types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"prov-a": {
				ID:      "prov-a",
				BaseURL: mockUpstream.URL + "/v1",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "key-1", Key: "sk-1", Enabled: true},
					{ID: "k2", Label: "key-2", Key: "sk-2", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"qwen-turbo": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "prov-a", KeyLabel: "key-1", Enabled: true},
					{Provider: "prov-a", KeyLabel: "key-2", Enabled: true},
				},
			},
		},
	}
	_, _ = localSrc.SaveConfig(&cfg)

	// Set cooldown on key-1
	sched.Cooldowns().ApplyCooldown("prov-a", "qwen-turbo", "key-1", 401, 15*time.Second, 30*time.Second, 15*time.Second, 86400*time.Second)
	if !sched.Cooldowns().IsCooledDown("prov-a", "qwen-turbo", "key-1") {
		t.Fatalf("expected key-1 to be cooled down")
	}

	// Test agent model
	testReq := map[string]any{
		"model": "qwen-turbo",
	}
	tb, _ := json.Marshal(testReq)
	req := httptest.NewRequest("POST", "/api/admin/test-agent-model", bytes.NewReader(tb))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != true || resp["total"] != float64(2) || resp["passed"] != float64(2) {
		t.Fatalf("unexpected agent model test response: %+v", resp)
	}

	// Cooldown for key-1 must have been cleared!
	if sched.Cooldowns().IsCooledDown("prov-a", "qwen-turbo", "key-1") {
		t.Fatalf("expected key-1 cooldown to be cleared after passing agent model test")
	}
}

func TestAdminServer_TracesClear(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Record a sample trace
	obsMgr.RecordRequest(types.RequestTrace{
		ID:       "req-12345",
		ReqModel: "test-model",
		Status:   200,
	})

	// Verify trace exists in GET /api/admin/traces
	req := httptest.NewRequest("GET", "/api/admin/traces", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	var tracesResp struct {
		OK     bool                 `json:"ok"`
		Traces []types.RequestTrace `json:"traces"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &tracesResp)
	if !tracesResp.OK || len(tracesResp.Traces) == 0 {
		t.Fatalf("expected at least 1 trace before delete, got %+v", tracesResp)
	}

	// DELETE /api/admin/traces
	delReq := httptest.NewRequest("DELETE", "/api/admin/traces", nil)
	delReq.Header.Set("Authorization", "Bearer admin-pass")
	delRec := httptest.NewRecorder()
	mux.ServeHTTP(delRec, delReq)

	if delRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for DELETE /api/admin/traces, got %d", delRec.Code)
	}

	// Verify traces are empty now
	req = httptest.NewRequest("GET", "/api/admin/traces", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	_ = json.Unmarshal(rec.Body.Bytes(), &tracesResp)
	if len(tracesResp.Traces) != 0 {
		t.Fatalf("expected 0 traces after DELETE, got %d", len(tracesResp.Traces))
	}
}

func TestAdminServer_Lanes(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Acquire a lane
	release1 := sched.Lanes().Acquire("minimax:hk-01", 10)
	cancelWait := sched.Lanes().StartWaiting("minimax:hk-01")

	// Call GET /api/lanes
	req := httptest.NewRequest("GET", "/api/lanes", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for GET /api/lanes, got %d", rec.Code)
	}

	var resp struct {
		OK    bool `json:"ok"`
		Lanes []struct {
			Lane    string `json:"lane"`
			Busy    int    `json:"busy"`
			Waiting int    `json:"waiting"`
			Limit   int    `json:"limit"`
		} `json:"lanes"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if !resp.OK || len(resp.Lanes) == 0 {
		t.Fatalf("expected active lanes, got %+v", resp)
	}

	found := false
	for _, l := range resp.Lanes {
		if l.Lane == "minimax:hk-01" {
			found = true
			if l.Busy != 1 || l.Waiting != 1 || l.Limit != 10 {
				t.Fatalf("unexpected lane stats: %+v", l)
			}
		}
	}
	if !found {
		t.Fatalf("lane 'minimax:hk-01' not found in response")
	}

	// Release lane
	cancelWait()
	release1()

	// Call GET /api/lanes again
	req = httptest.NewRequest("GET", "/api/lanes", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Lanes) != 0 {
		t.Fatalf("expected 0 lanes after release, got %d", len(resp.Lanes))
	}
}
