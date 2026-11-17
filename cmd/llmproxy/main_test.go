package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/admin"
	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/hubsync"
	"github.com/khc8655/llmproxy2/internal/kb"
	"github.com/khc8655/llmproxy2/internal/oauth"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/router"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

func TestFullMode_RouteValidationAndUnifiedEndpoints(t *testing.T) {
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

	// Save initial config with 1 agent model and KB models
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
	})
	if err != nil {
		t.Fatalf("save initial config: %v", err)
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

	// Models (unified Agent + KB)
	handleModels := wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		forceRefresh := r.Header.Get("X-Node-Refresh") == "1"
		snap, err := localSrc.Current(r.Context(), forceRefresh)
		if err != nil || snap == nil || snap.Config == nil {
			http.Error(w, "config unavailable", http.StatusServiceUnavailable)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data": []map[string]any{
				{"id": "agent-model-1"},
				{"id": "chat"},
				{"id": "embedding"},
				{"id": "reranker"},
				{"id": "ocr"},
			},
		})
	})
	mux.HandleFunc("GET /v1/models", handleModels)
	mux.HandleFunc("GET /api/v1/models", handleModels)

	// Inference
	largeBodySem := make(chan struct{}, 1)
	handleInference := wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		_, cleanup, ok := readInferenceBody(w, r, largeBodySem)
		if !ok {
			return
		}
		defer cleanup()

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

	// KB endpoints (always active in Full mode)
	mux.HandleFunc("POST /v1/ocr", wrapAuth(kbPipeline.HandleOCR))
	mux.HandleFunc("POST /api/v1/ocr", wrapAuth(kbPipeline.HandleOCR))
	mux.HandleFunc("POST /v1/embeddings", wrapAuth(kbPipeline.HandleEmbeddings))
	mux.HandleFunc("POST /api/v1/embeddings", wrapAuth(kbPipeline.HandleEmbeddings))
	mux.HandleFunc("POST /v1/rerank", wrapAuth(kbPipeline.HandleRerank))
	mux.HandleFunc("POST /api/v1/rerank", wrapAuth(kbPipeline.HandleRerank))

	adminSrv := admin.NewServer(authMgr, localSrc, obsMgr, sched)
	adminSrv.SetAllowPrivate(true)
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

	// Test X-Node-Refresh: 1 header
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
	largeBodySem := make(chan struct{}, 1)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authMgr.VerifyClientKey(r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		bodyBytes, cleanup, ok := readInferenceBody(w, r, largeBodySem)
		if !ok {
			return
		}
		defer cleanup()

		if len(bodyBytes) == 0 {
			w.WriteHeader(http.StatusBadRequest)
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

type countingReader struct {
	remaining int
	readBytes *atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	if c.remaining <= 0 {
		return 0, io.EOF
	}
	n := len(p)
	if n > c.remaining {
		n = c.remaining
	}
	for i := 0; i < n; i++ {
		p[i] = 'a'
	}
	c.remaining -= n
	c.readBytes.Add(int64(n))
	return n, nil
}

func TestLargeBodySem_PreReadSerialization_ContentLength_And_Chunked(t *testing.T) {
	largeBodySem := make(chan struct{}, 1)
	// Pre-hold semaphore to simulate an active large request in flight
	largeBodySem <- struct{}{}

	// 1. Content-Length > 1 MiB must block on largeBodySem BEFORE reading ANY bytes from r.Body!
	var clBytesRead atomic.Int64
	ctxCL, cancelCL := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancelCL()
	reqCL := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", &countingReader{
		remaining: 2 << 20,
		readBytes: &clBytesRead,
	}).WithContext(ctxCL)
	reqCL.ContentLength = 2 << 20
	recCL := httptest.NewRecorder()
	_, cleanupCL, okCL := readInferenceBody(recCL, reqCL, largeBodySem)
	defer cleanupCL()
	if okCL || recCL.Code != http.StatusRequestTimeout {
		t.Fatalf("expected 408 timeout while largeBodySem held, got ok=%v status=%d", okCL, recCL.Code)
	}
	if clBytesRead.Load() != 0 {
		t.Fatalf("F-04 violation: read %d bytes before acquiring largeBodySem on Content-Length > 1MiB!", clBytesRead.Load())
	}

	// 2. Chunked (Content-Length == -1) > 1 MiB must read at most 1 MiB + 1 bytes before blocking on largeBodySem!
	var chunkedBytesRead atomic.Int64
	ctxCh, cancelCh := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancelCh()
	reqCh := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", &countingReader{
		remaining: 5 << 20,
		readBytes: &chunkedBytesRead,
	}).WithContext(ctxCh)
	reqCh.ContentLength = -1
	recCh := httptest.NewRecorder()
	_, cleanupCh, okCh := readInferenceBody(recCh, reqCh, largeBodySem)
	defer cleanupCh()
	if okCh || recCh.Code != http.StatusRequestTimeout {
		t.Fatalf("expected 408 timeout on chunked >1MiB while largeBodySem held, got ok=%v status=%d", okCh, recCh.Code)
	}
	if chunkedBytesRead.Load() != largeBodyThreshold+1 {
		t.Fatalf("F-04 violation: expected chunked reader to stop at %d bytes before semaphore, read %d", largeBodyThreshold+1, chunkedBytesRead.Load())
	}

	// 3. Release semaphore and verify concurrent 2 MiB requests serialize cleanly with max 1 active at a time
	<-largeBodySem

	var activeLarge atomic.Int32
	var maxActiveLarge atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var rb atomic.Int64
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", &countingReader{
				remaining: 2 << 20,
				readBytes: &rb,
			})
			req.ContentLength = 2 << 20
			rec := httptest.NewRecorder()
			body, cleanup, ok := readInferenceBody(rec, req, largeBodySem)
			if !ok {
				t.Errorf("unexpected readInferenceBody failure: %d", rec.Code)
				return
			}
			cur := activeLarge.Add(1)
			for {
				prev := maxActiveLarge.Load()
				if cur <= prev || maxActiveLarge.CompareAndSwap(prev, cur) {
					break
				}
			}
			if len(body) != 2<<20 {
				t.Errorf("expected 2MiB body, got %d", len(body))
			}
			time.Sleep(10 * time.Millisecond)
			activeLarge.Add(-1)
			cleanup()
		}()
	}
	wg.Wait()
	if maxActiveLarge.Load() != 1 {
		t.Fatalf("F-04: expected maxActiveLarge=1 under largeBodySem, got %d", maxActiveLarge.Load())
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
			// 24h key ban on upstream 401 is the schema default; state it explicitly
			// because 0 now means disabled (see TestFullMode_ZeroAuthCooldownDoesNotBan).
			CooldownAuthErrorSec: 86400,
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

// cooldown_auth_error_sec = 0 must mean "do not ban" rather than "fall back to
// the 24h default": one upstream 401 previously persisted a full-day key ban.
func TestFullMode_ZeroAuthCooldownDoesNotBan(t *testing.T) {
	tmpDir := t.TempDir()

	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"Invalid API key","type":"authentication_error"}}`))
	}))
	defer mockUpstream.Close()

	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("local source error: %v", err)
	}
	if _, err := localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p-auth": {
				ID:      "p-auth",
				BaseURL: mockUpstream.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k-bad", Label: "k-bad", Key: "sk-invalid", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"auth-model": {
				Enabled:    true,
				Candidates: []*types.RouteCandidate{{Provider: "p-auth", TargetModel: "m1", KeyLabel: "k-bad", Enabled: true}},
			},
		},
		Settings: types.RuntimeSettings{CooldownAuthErrorSec: 0},
	}); err != nil {
		t.Fatalf("save config: %v", err)
	}

	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)
	if err := sched.InitBans(types.RoleFull, tmpDir); err != nil {
		t.Fatalf("InitBans error: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"auth-model","messages":[{"role":"user","content":"x"}]}`))
	_ = sched.Dispatch(context.Background(), "/v1/chat/completions",
		[]byte(`{"model":"auth-model","messages":[{"role":"user","content":"x"}]}`), "auth-model", false, rec, req)

	if sched.Cooldowns().IsCooledDown("p-auth", "m1", "k-bad") {
		t.Fatalf("cooldown_auth_error_sec=0 must not cool down the key")
	}
	if _, err := os.Stat(filepath.Join(tmpDir, "key_bans.json")); err == nil {
		t.Fatalf("cooldown_auth_error_sec=0 must not persist key_bans.json")
	}
}

func TestLiteMode_HubSyncedClientKeys(t *testing.T) {
	mockHub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Lease-Until", time.Now().Add(1*time.Hour).Format(time.RFC3339Nano))
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":             true,
			"config_version": 3,
			"payload": types.ProxyConfig{
				Version: 3,
				Settings: types.RuntimeSettings{
					ClientKey: "sk-hub-synced-primary",
					ProxyKeys: []string{"sk-hub-synced-extra"},
				},
			},
		})
	}))
	defer mockHub.Close()

	hubSrc := hubsync.NewHubSource(mockHub.URL, "stk_node_abc", true)
	authMgr := auth.NewAuthenticator("", "")
	hubSrc.OnConfigChange(func(cfg *types.ProxyConfig) {
		if cfg != nil {
			authMgr.UpdateClientKeys(cfg.Settings.ClientKey, cfg.Settings.ProxyKeys)
		}
	})

	// Before first request: unknown key fails auth, so lazy sync is triggered
	req1 := httptest.NewRequest("GET", "/v1/models", nil)
	req1.Header.Set("Authorization", "Bearer sk-hub-synced-primary")
	if authMgr.VerifyClientKey(req1) {
		t.Fatalf("expected authMgr empty before first hub sync")
	}

	if _, err := hubSrc.Current(context.Background(), false); err != nil {
		t.Fatalf("hubSrc.Current err: %v", err)
	}

	if !authMgr.VerifyClientKey(req1) {
		t.Fatalf("expected Hub-synced primary client_key to authenticate")
	}

	req2 := httptest.NewRequest("GET", "/v1/models", nil)
	req2.Header.Set("Authorization", "Bearer sk-hub-synced-extra")
	if !authMgr.VerifyClientKey(req2) {
		t.Fatalf("expected Hub-synced proxy_keys to authenticate")
	}
}
