package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/admin"
	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/kb"
	"github.com/khc8655/llmproxy2/internal/modesched"
	"github.com/khc8655/llmproxy2/internal/oauth"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/router"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

func TestFullMode_RouteValidationAndModeGates(t *testing.T) {
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("test-client-key", "test-admin-pass")
	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("local source error: %v", err)
	}

	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()

	sched := scheduler.NewScheduler(localSrc, obsMgr, true)
	oauthMgr := oauth.NewManager(true)
	sched.SetOAuthRefresher(oauthMgr)

	kbPipeline := kb.NewPipeline(localSrc, 4, 16, true)
	kbPipeline.SetObservabilitySink(obsMgr)

	modeSched := modesched.NewModeScheduler(types.ModeAgent, true)

	// Save initial config with 1 agent model and 1 kb model
	_, err = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: "https://mock.api",
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Key: "sk-1", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"agent-model-1": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", TargetModel: "m1", KeyLabel: "k1", Enabled: true},
				},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"chat":      {{Provider: "p1", Enabled: true}},
			"ocr":       {{Provider: "p1", Enabled: true}},
			"embedding": {{Provider: "p1", Enabled: true}},
			"reranker":  {{Provider: "p1", Enabled: true}},
		},
		Settings: types.RuntimeSettings{
			RunMode: types.ModeAgent,
		},
	})
	if err != nil {
		t.Fatalf("save initial config: %v", err)
	}

	getEffectiveMode := func(ctx context.Context) types.RunMode {
		snap, err := localSrc.Current(ctx, false)
		if err == nil && snap != nil && snap.Config != nil {
			if snap.Config.Settings.ModeScheduleEnabled && modeSched != nil {
				return modeSched.CurrentMode()
			}
			if snap.Config.Settings.RunMode != "" {
				return snap.Config.Settings.RunMode
			}
		}
		if modeSched != nil {
			return modeSched.CurrentMode()
		}
		return types.ModeAgent
	}

	mux := router.NewRouteMux()

	// 1. Healthz
	handleHealth := func(w http.ResponseWriter, r *http.Request) {
		status, state, valid, ver := localSrc.HealthState()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":         status,
			"state":          state,
			"lease_valid":    valid,
			"version":        ver,
			"config_version": ver,
			"role":           types.RoleFull,
			"app_version":    version,
			"semver":         AppVersion,
			"commit":         commit,
		})
	}
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("GET /health", handleHealth)

	// Auth wrapper
	wrapAuth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !authMgr.VerifyClientKey(r) {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}

	// Models
	handleModels := wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		forceRefresh := r.Header.Get("X-Node-Refresh") == "1"
		snap, err := localSrc.Current(r.Context(), forceRefresh)
		if err != nil || snap == nil || snap.Config == nil {
			http.Error(w, "config unavailable", http.StatusServiceUnavailable)
			return
		}

		mode := getEffectiveMode(r.Context())
		if mode == types.ModeKB {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"object": "list",
				"data": []map[string]any{
					{"id": "chat"},
					{"id": "embedding"},
					{"id": "reranker"},
					{"id": "ocr"},
				},
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data": []map[string]any{
				{"id": "agent-model-1"},
			},
		})
	})
	mux.HandleFunc("GET /v1/models", handleModels)
	mux.HandleFunc("GET /api/v1/models", handleModels)

	// Inference
	handleInference := wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		effectiveMode := getEffectiveMode(r.Context())
		isMessagesOrResponses := strings.HasSuffix(r.URL.Path, "/messages") || strings.HasSuffix(r.URL.Path, "/responses")
		if effectiveMode == types.ModeKB && isMessagesOrResponses {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"message": "endpoint disabled in kb mode",
					"type":    "invalid_request_error",
				},
			})
			return
		}

		bodyBytes, _ := io.ReadAll(r.Body)
		var q struct {
			Model  string `json:"model"`
			Stream bool   `json:"stream"`
		}
		_ = json.Unmarshal(bodyBytes, &q)

		if effectiveMode == types.ModeKB {
			if q.Model != "chat" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "only model 'chat' is supported in kb mode"}})
				return
			}
			if q.Stream {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "streaming is not supported in kb chat mode"}})
				return
			}
			kbPipeline.HandleChat(w, r, bodyBytes)
			return
		}

		// Agent mode OK mock response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"agent response"}}]}`))
	})

	mux.HandleFunc("POST /v1/chat/completions", handleInference)
	mux.HandleFunc("POST /api/v1/chat/completions", handleInference)
	mux.HandleFunc("POST /v1/messages", handleInference)
	mux.HandleFunc("POST /api/v1/messages", handleInference)
	mux.HandleFunc("POST /v1/responses", handleInference)
	mux.HandleFunc("POST /api/v1/responses", handleInference)

	// KB endpoints
	wrapKBMode := func(handler http.HandlerFunc) http.HandlerFunc {
		return wrapAuth(func(w http.ResponseWriter, r *http.Request) {
			mode := getEffectiveMode(r.Context())
			if mode == types.ModeAgent {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"message": "kb endpoint disabled in agent mode",
						"type":    "invalid_request_error",
					},
				})
				return
			}
			handler(w, r)
		})
	}

	mux.HandleFunc("POST /v1/ocr", wrapKBMode(kbPipeline.HandleOCR))
	mux.HandleFunc("POST /api/v1/ocr", wrapKBMode(kbPipeline.HandleOCR))
	mux.HandleFunc("POST /v1/embeddings", wrapKBMode(kbPipeline.HandleEmbeddings))
	mux.HandleFunc("POST /api/v1/embeddings", wrapKBMode(kbPipeline.HandleEmbeddings))
	mux.HandleFunc("POST /v1/rerank", wrapKBMode(kbPipeline.HandleRerank))
	mux.HandleFunc("POST /api/v1/rerank", wrapKBMode(kbPipeline.HandleRerank))

	adminSrv := admin.NewServer(authMgr, localSrc, obsMgr, sched)
	adminSrv.SetModeScheduler(modeSched)
	adminSrv.SetOAuthManager(oauthMgr)
	adminSrv.RegisterRoutes(mux)

	// 1. Strict Route Validation against AllowedLiteRoutes + FullOnlyRoutes
	if err := mux.Validate(); err != nil {
		t.Fatalf("mux route validation failed: %v", err)
	}

	// 2. Test Healthz
	req := httptest.NewRequest("GET", "/healthz", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for /healthz, got %d", rec.Code)
	}
	var healthResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &healthResp)
	if healthResp["app_version"] != version || healthResp["semver"] != "2.0.0" {
		t.Errorf("unexpected healthz response: %+v", healthResp)
	}

	// 3. In AGENT mode:
	// GET /v1/models returns agent-model-1
	req = httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer test-client-key")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), "agent-model-1") {
		t.Errorf("expected agent-model-1 in agent mode, got %s", rec.Body.String())
	}

	// POST /v1/ocr in AGENT mode -> 404
	req = httptest.NewRequest("POST", "/v1/ocr", strings.NewReader("image-data"))
	req.Header.Set("Authorization", "Bearer test-client-key")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for /v1/ocr in agent mode, got %d: %s", rec.Code, rec.Body.String())
	}

	// POST /v1/messages in AGENT mode -> 200
	req = httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"agent-model-1"}`))
	req.Header.Set("Authorization", "Bearer test-client-key")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for /v1/messages in agent mode, got %d: %s", rec.Code, rec.Body.String())
	}

	// 4. Switch to KB mode
	_, _ = localSrc.UpdateRunMode(types.ModeKB)
	modeSched.SetManualMode(types.ModeKB)

	// GET /v1/models returns chat, embedding, reranker, ocr
	req = httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer test-client-key")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"id":"chat"`) || !strings.Contains(rec.Body.String(), `"id":"ocr"`) {
		t.Errorf("expected kb models in kb mode, got %s", rec.Body.String())
	}

	// POST /v1/messages in KB mode -> 404
	req = httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"chat"}`))
	req.Header.Set("Authorization", "Bearer test-client-key")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for /v1/messages in kb mode, got %d: %s", rec.Code, rec.Body.String())
	}

	// POST /v1/chat/completions with model != "chat" -> 404
	req = httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"wrong-model"}`))
	req.Header.Set("Authorization", "Bearer test-client-key")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for /v1/chat/completions with wrong model in kb mode, got %d: %s", rec.Code, rec.Body.String())
	}

	// POST /v1/chat/completions with stream = true -> 400
	req = httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"chat","stream":true}`))
	req.Header.Set("Authorization", "Bearer test-client-key")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for streaming in kb chat mode, got %d: %s", rec.Code, rec.Body.String())
	}

	// 5. Test X-Node-Refresh: 1 header
	req = httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer test-client-key")
	req.Header.Set("X-Node-Refresh", "1")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 with X-Node-Refresh: 1, got %d", rec.Code)
	}
}

func TestLiteMode_RouteValidationAndReadOnlyGuard(t *testing.T) {
	mux := router.NewRouteMux()

	handleHealth := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "role": "lite"})
	}
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("GET /health", handleHealth)

	dummyHandler := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}
	mux.HandleFunc("GET /v1/models", dummyHandler)
	mux.HandleFunc("GET /api/v1/models", dummyHandler)
	mux.HandleFunc("POST /v1/chat/completions", dummyHandler)
	mux.HandleFunc("POST /api/v1/chat/completions", dummyHandler)
	mux.HandleFunc("POST /v1/messages", dummyHandler)
	mux.HandleFunc("POST /api/v1/messages", dummyHandler)
	mux.HandleFunc("POST /v1/responses", dummyHandler)
	mux.HandleFunc("POST /api/v1/responses", dummyHandler)

	// Validate mux against AllowedLiteRoutes
	if err := mux.Validate(); err != nil {
		t.Fatalf("lite mode route validation failed: %v", err)
	}

	handler := router.ReadOnlyGuard(types.RoleLite, mux)

	// 1. Allowed data plane route
	req := httptest.NewRequest("GET", "/v1/models", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for /v1/models in lite mode, got %d", rec.Code)
	}

	// 2. Disallowed route (e.g. /v1/ocr) should be rejected with 403 or 404
	req = httptest.NewRequest("POST", "/v1/ocr", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusNotFound {
		t.Errorf("expected 403 or 404 for /v1/ocr in lite mode, got %d", rec.Code)
	}

	// 3. Disallowed route (e.g. /api/config) should be rejected
	req = httptest.NewRequest("GET", "/api/config", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusNotFound {
		t.Errorf("expected 403 or 404 for /api/config in lite mode, got %d", rec.Code)
	}
}

func TestVersionVariables(t *testing.T) {
	if version != "v20261108-01" {
		t.Errorf("unexpected version: %s", version)
	}
	if AppVersion != "2.0.0" {
		t.Errorf("unexpected AppVersion: %s", AppVersion)
	}
}
