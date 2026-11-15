package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
		if r.ContentLength > maxRequestBodySize {
			writePayloadTooLarge(w)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)

		buf := bufferPool.Get().(*bytes.Buffer)
		buf.Reset()
		defer func() {
			if buf.Cap() <= 4<<20 {
				bufferPool.Put(buf)
			}
		}()

		_, err := buf.ReadFrom(r.Body)
		if err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				writePayloadTooLarge(w)
				return
			}
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}
		bodyBytes := buf.Bytes()

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
	_, wantSemver := releaseMeta(t)
	if healthResp["app_version"] != version || healthResp["semver"] != wantSemver {
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

// releaseMeta reads version.json so the built-in defaults are guarded against
// drifting from the release metadata (build-release.mjs injects the same values
// through -ldflags; plain `go build` must not lag behind).
func releaseMeta(t *testing.T) (string, string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "version.json"))
	if err != nil {
		t.Fatalf("read version.json: %v", err)
	}
	var meta struct {
		Version string `json:"version"`
		Semver  string `json:"semver"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatalf("parse version.json: %v", err)
	}
	return meta.Version, meta.Semver
}

func TestVersionVariables(t *testing.T) {
	wantVersion, wantSemver := releaseMeta(t)
	if version != wantVersion {
		t.Errorf("version %s drifts from version.json (%s)", version, wantVersion)
	}
	if AppVersion != wantSemver {
		t.Errorf("AppVersion %s drifts from version.json (%s)", AppVersion, wantSemver)
	}
}

func TestMaxBodyLimit_20MB_ContentLength_And_Chunked(t *testing.T) {
	authMgr := auth.NewAuthenticator("test-client-key", "")

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authMgr.VerifyClientKey(r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		// Enforce hard 20MB limit (P3)
		if r.ContentLength > maxRequestBodySize {
			writePayloadTooLarge(w)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)

		buf := bufferPool.Get().(*bytes.Buffer)
		buf.Reset()
		defer func() {
			if buf.Cap() <= 4<<20 {
				bufferPool.Put(buf)
			}
		}()

		_, err := buf.ReadFrom(r.Body)
		if err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				writePayloadTooLarge(w)
				return
			}
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// 1. ContentLength > 20MB -> 413 Payload Too Large
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"chat"}`))
	req.Header.Set("Authorization", "Bearer test-client-key")
	req.ContentLength = 21 * 1024 * 1024 // 21MB
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized ContentLength, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Errorf("expected payload_too_large in response, got %s", rec.Body.String())
	}

	// 2. Chunked transfer encoding (ContentLength == -1) exceeding 20MB -> 413
	oversizedReader := io.LimitReader(newPatternReader(), 20<<20+1024)
	req2 := httptest.NewRequest("POST", "/v1/chat/completions", oversizedReader)
	req2.Header.Set("Authorization", "Bearer test-client-key")
	req2.ContentLength = -1 // Chunked / unknown length
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for chunked transfer exceeding 20MB, got %d", rec2.Code)
	}
	if !strings.Contains(rec2.Body.String(), "payload_too_large") {
		t.Errorf("expected payload_too_large in response, got %s", rec2.Body.String())
	}

	// 3. Normal request < 20MB -> 200 OK
	normalBody := `{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}`
	req3 := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(normalBody))
	req3.Header.Set("Authorization", "Bearer test-client-key")
	rec3 := httptest.NewRecorder()
	handler.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusOK {
		t.Fatalf("expected 200 for normal request, got %d: %s", rec3.Code, rec3.Body.String())
	}
}

// newPatternReader generates an infinite stream of repetitive bytes.
type patternReader struct{}

func newPatternReader() io.Reader { return &patternReader{} }

func (p *patternReader) Read(b []byte) (n int, err error) {
	for i := range b {
		b[i] = 'A'
	}
	return len(b), nil
}

func TestFullMode_AuthHotReloadAndMultiKeys(t *testing.T) {
	tmpDir := t.TempDir()
	cliKey := "cli-primary-key"
	authMgr := auth.NewAuthenticator(cliKey, "admin-pass")

	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	// Wire auth update from settings (matching main.go logic)
	updateAuthFromSettings := func(cfg *types.ProxyConfig) {
		if cfg == nil {
			return
		}
		primary := cliKey
		var extras []string
		if primary == "" {
			if cfg.Settings.ClientKey != "" {
				primary = cfg.Settings.ClientKey
			} else if cfg.Settings.ProxyAPIKey != "" {
				primary = cfg.Settings.ProxyAPIKey
			}
			extras = cfg.Settings.ProxyKeys
		} else {
			if cfg.Settings.ClientKey != "" && cfg.Settings.ClientKey != primary {
				extras = append(extras, cfg.Settings.ClientKey)
			}
			if cfg.Settings.ProxyAPIKey != "" && cfg.Settings.ProxyAPIKey != primary {
				extras = append(extras, cfg.Settings.ProxyAPIKey)
			}
			extras = append(extras, cfg.Settings.ProxyKeys...)
		}
		authMgr.UpdateClientKeys(primary, extras)
	}
	localSrc.OnConfigChange(updateAuthFromSettings)

	// Save initial config with ProxyKeys
	_, err = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p1": {ID: "p1", BaseURL: "https://mock.api", Enabled: true},
		},
		Settings: types.RuntimeSettings{
			ClientKey: "settings-client-key",
			ProxyKeys: []string{"extra-token-1", "extra-token-2"},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig err: %v", err)
	}

	// Verify CLI key takes primary precedence
	rCLI := httptest.NewRequest("GET", "/v1/models", nil)
	rCLI.Header.Set("Authorization", "Bearer cli-primary-key")
	if !authMgr.VerifyClientKey(rCLI) {
		t.Errorf("expected cli-primary-key to authenticate")
	}

	// Verify extra keys from settings authenticate
	rExtra1 := httptest.NewRequest("GET", "/v1/models", nil)
	rExtra1.Header.Set("Authorization", "Bearer extra-token-1")
	if !authMgr.VerifyClientKey(rExtra1) {
		t.Errorf("expected extra-token-1 to authenticate")
	}

	rExtra2 := httptest.NewRequest("GET", "/v1/models", nil)
	rExtra2.Header.Set("Authorization", "Bearer extra-token-2")
	if !authMgr.VerifyClientKey(rExtra2) {
		t.Errorf("expected extra-token-2 to authenticate")
	}

	// Verify settings-client-key also authenticates as extra
	rSettings := httptest.NewRequest("GET", "/v1/models", nil)
	rSettings.Header.Set("Authorization", "Bearer settings-client-key")
	if !authMgr.VerifyClientKey(rSettings) {
		t.Errorf("expected settings-client-key to authenticate")
	}

	// Dynamic update: reload with changed ProxyKeys (pass current version 1 for CAS)
	_, err = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p1": {ID: "p1", BaseURL: "https://mock.api", Enabled: true},
		},
		Settings: types.RuntimeSettings{
			ProxyKeys: []string{"extra-token-3"},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig v2 err: %v", err)
	}

	// extra-token-3 now works
	rExtra3 := httptest.NewRequest("GET", "/v1/models", nil)
	rExtra3.Header.Set("Authorization", "Bearer extra-token-3")
	if !authMgr.VerifyClientKey(rExtra3) {
		t.Errorf("expected extra-token-3 to authenticate after hot reload")
	}

	// extra-token-1 should now fail
	if authMgr.VerifyClientKey(rExtra1) {
		t.Errorf("expected extra-token-1 to fail after being removed in hot reload")
	}
}

func TestFullMode_InitBans_401PersistsAndReloads(t *testing.T) {
	tmpDir := t.TempDir()

	// 1. Mock upstream returning 401 Unauthorized
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"Invalid API key","type":"authentication_error"}}`))
	}))
	defer mockUpstream.Close()

	// 2. Local config source in tmpDir
	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("local source error: %v", err)
	}

	_, err = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p-auth": {
				ID:      "p-auth",
				BaseURL: mockUpstream.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k-bad", Label: "k-bad", Key: "sk-invalid", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"auth-model": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "p-auth", TargetModel: "m1", KeyLabel: "k-bad", Enabled: true},
				},
			},
		},
		Settings: types.RuntimeSettings{
			RunMode: types.ModeAgent,
		},
	})
	if err != nil {
		t.Fatalf("save initial config: %v", err)
	}

	authMgr := auth.NewAuthenticator("client-key", "admin-pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()

	// 3. Scheduler with RoleFull and InitBans wired
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)
	role := types.RoleFull
	if role == types.RoleFull {
		if err := sched.InitBans(role, tmpDir); err != nil {
			t.Fatalf("sched.InitBans error: %v", err)
		}
	}

	// 4. Dispatch a request to auth-model -> upstream returns 401
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"auth-model","messages":[{"role":"user","content":"test"}]}`))
	_ = sched.Dispatch(context.Background(), "/v1/chat/completions", []byte(`{"model":"auth-model","messages":[{"role":"user","content":"test"}]}`), "auth-model", false, rec, req)

	// Verify candidate key p-auth:k-bad is cooled down
	if !sched.Cooldowns().IsCooledDown("p-auth", "m1", "k-bad") {
		t.Fatalf("expected candidate p-auth:k-bad to be cooled down after 401")
	}

	// 5. Verify key_bans.json was written to tmpDir
	banFilePath := filepath.Join(tmpDir, "key_bans.json")
	data, err := os.ReadFile(banFilePath)
	if err != nil {
		t.Fatalf("expected key_bans.json to exist in config-dir after 401, got err: %v", err)
	}

	var persisted scheduler.PersistedBansData
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatalf("failed to unmarshal key_bans.json: %v", err)
	}
	expectedTarget := "p:p-auth:k:k-bad"
	if _, ok := persisted.Bans[expectedTarget]; !ok {
		t.Fatalf("expected target %q in key_bans.json, got: %+v", expectedTarget, persisted.Bans)
	}

	// 6. Simulate restart: create a new Scheduler with the same config-dir & role
	sched2 := scheduler.NewScheduler(localSrc, obsMgr, true)
	if role == types.RoleFull {
		if err := sched2.InitBans(role, tmpDir); err != nil {
			t.Fatalf("sched2.InitBans error: %v", err)
		}
	}

	// Verify ban is restored in-memory on new scheduler
	if !sched2.Cooldowns().IsCooledDown("p-auth", "m1", "k-bad") {
		t.Fatalf("expected candidate p-auth:k-bad to remain cooled down on reloaded scheduler")
	}

	// Verify via Admin API GET /api/admin/cooldowns
	adminSrv2 := admin.NewServer(authMgr, localSrc, obsMgr, sched2)
	adminMux := http.NewServeMux()
	adminSrv2.RegisterRoutes(adminMux)

	cdReq := httptest.NewRequest("GET", "/api/admin/cooldowns", nil)
	cdReq.Header.Set("Authorization", "Bearer admin-pass")
	cdRec := httptest.NewRecorder()
	adminMux.ServeHTTP(cdRec, cdReq)

	if cdRec.Code != http.StatusOK {
		t.Fatalf("expected 200 from /api/admin/cooldowns, got %d: %s", cdRec.Code, cdRec.Body.String())
	}

	var cdResp map[string]any
	if err := json.Unmarshal(cdRec.Body.Bytes(), &cdResp); err != nil {
		t.Fatalf("failed to parse /api/admin/cooldowns response: %v", err)
	}
	if cdResp["ok"] != true {
		t.Fatalf("expected ok: true in cooldowns response, got: %+v", cdResp)
	}
	total, _ := cdResp["total"].(float64)
	if total < 1 {
		t.Fatalf("expected at least 1 cooldown in admin response, got %v", total)
	}

	// 7. Verify Lite mode: banFile remains empty and no disk bans are loaded or written
	schedLite := scheduler.NewScheduler(localSrc, obsMgr, true)
	liteRole := types.RoleLite
	if liteRole == types.RoleFull {
		_ = schedLite.InitBans(liteRole, tmpDir)
	}
	if schedLite.Cooldowns().BanFile() != "" {
		t.Errorf("expected Lite mode banFile to be empty, got %q", schedLite.Cooldowns().BanFile())
	}
}
