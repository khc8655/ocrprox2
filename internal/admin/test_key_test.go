package admin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

const testKeySecret = "sk-test-key-secret-9f8e7d6c"

// newTestKeyServer wires a Full admin server around one mock provider.
func newTestKeyServer(t *testing.T, upstreamURL string) (*Server, *config.LocalSource, *obs.Manager, *http.ServeMux, string) {
	t.Helper()
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource: %v", err)
	}
	obsMgr, err := obs.NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	_, err = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"mock-prov": {
				ID:      "mock-prov",
				BaseURL: upstreamURL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k-one", Key: testKeySecret, Enabled: true},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)
	return srv, localSrc, obsMgr, mux, tmpDir
}

func postTestKey(t *testing.T, mux *http.ServeMux, body string) (*httptest.ResponseRecorder, testKeyResponse) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/admin/test-key", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	var parsed testKeyResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	return rec, parsed
}

func TestAdminServer_TestKey_Success(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"chatcmpl_1","choices":[{"message":{"role":"assistant","content":"你好！我是测试回复。"}}]}`))
	}))
	defer upstream.Close()

	srv, _, _, mux, _ := newTestKeyServer(t, upstream.URL)
	srv.SetHTTPClient(upstream.Client())

	rec, resp := postTestKey(t, mux, `{"provider":"mock-prov"}`)
	t.Logf("test-key success response: %s", rec.Body.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !resp.OK || !resp.Valid {
		t.Fatalf("expected ok+valid, got %+v", resp)
	}
	if resp.Status != 200 || resp.ReplyText != "你好！我是测试回复。" {
		t.Fatalf("unexpected reply: %+v", resp)
	}
	if resp.Model != "gpt-4o-mini" || resp.ModelSource != "fallback" {
		t.Errorf("expected fallback model gpt-4o-mini, got model=%q source=%q", resp.Model, resp.ModelSource)
	}
	if resp.APIType != "openai-completions" || resp.KeyLabel != "k-one" || resp.KeyID != "k1" {
		t.Errorf("unexpected protocol/key fields: %+v", resp)
	}

	// The upstream call carries the real key, the protocol request shape, and
	// the fixed "你好" probe prompt.
	if gotPath != "/v1/chat/completions" {
		t.Errorf("expected /v1/chat/completions, got %q", gotPath)
	}
	if gotAuth != "Bearer "+testKeySecret {
		t.Errorf("unexpected auth header: %q", gotAuth)
	}
	if gotBody["model"] != "gpt-4o-mini" || gotBody["max_tokens"] != float64(16) || gotBody["stream"] != false {
		t.Errorf("unexpected upstream body: %+v", gotBody)
	}
	msgs, _ := gotBody["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("expected exactly one message, got %+v", gotBody["messages"])
	}
	msg, _ := msgs[0].(map[string]any)
	if msg["role"] != "user" || msg["content"] != "你好" {
		t.Errorf("expected user prompt 你好, got %+v", msg)
	}

	// Red line: the response must never echo the key.
	if strings.Contains(rec.Body.String(), testKeySecret) {
		t.Fatalf("response leaked the api key: %s", rec.Body.String())
	}
}

func TestAdminServer_TestKey_AuthInvalid(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-request-id", "req-upstream-42")
		w.WriteHeader(http.StatusUnauthorized)
		// The upstream echoes the full key in its message on purpose: the
		// response must still never contain it.
		_, _ = w.Write([]byte(`{"error":{"type":"invalid_api_key","message":"Incorrect API key provided: ` + testKeySecret + `"}}`))
	}))
	defer upstream.Close()

	srv, _, _, mux, _ := newTestKeyServer(t, upstream.URL)
	srv.SetHTTPClient(upstream.Client())

	rec, resp := postTestKey(t, mux, `{"provider":"mock-prov","key_label":"k-one"}`)
	t.Logf("test-key auth_invalid response: %s", rec.Body.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 (the test ran), got %d: %s", rec.Code, rec.Body.String())
	}
	if resp.Valid {
		t.Fatalf("expected invalid, got %+v", resp)
	}
	if resp.Status != 401 || resp.Reason != scheduler.ReasonAuthInvalid || resp.ErrType != "invalid_api_key" {
		t.Errorf("unexpected failure taxonomy: %+v", resp)
	}
	if !strings.Contains(resp.Error, "Incorrect API key") {
		t.Errorf("expected upstream message in error, got %q", resp.Error)
	}
	if strings.Contains(rec.Body.String(), testKeySecret) {
		t.Fatalf("response leaked the api key: %s", rec.Body.String())
	}
	if !strings.Contains(resp.Error, "…") {
		t.Errorf("expected the echoed key to be scrubbed to …, got %q", resp.Error)
	}
}

func TestAdminServer_TestKey_Timeout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"late"}}]}`))
	}))
	defer upstream.Close()

	srv, _, _, mux, _ := newTestKeyServer(t, upstream.URL)
	// The probe budget is 20s; a short client timeout exercises the same
	// timeout classification without making the test suite wait 20 seconds.
	srv.SetHTTPClient(&http.Client{Timeout: 50 * time.Millisecond})

	rec, resp := postTestKey(t, mux, `{"provider":"mock-prov"}`)
	t.Logf("test-key timeout response: %s", rec.Body.String())
	if resp.Valid {
		t.Fatalf("expected invalid on timeout, got %+v", resp)
	}
	if resp.Reason != scheduler.ReasonTimeout {
		t.Errorf("expected reason=timeout, got reason=%q err=%q", resp.Reason, resp.Error)
	}
	if resp.Status != 0 {
		t.Errorf("expected status 0 for a transport timeout, got %d", resp.Status)
	}
}

func TestAdminServer_TestKey_ModelSourceRoute(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer upstream.Close()

	srv, localSrc, _, mux, _ := newTestKeyServer(t, upstream.URL)
	srv.SetHTTPClient(upstream.Client())

	// A route that names this provider wins over preset/fallback.
	if _, err := localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"mock-prov": {
				ID:      "mock-prov",
				BaseURL: upstream.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k-one", Key: testKeySecret, Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"chat": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "mock-prov", KeyLabel: "k-one", TargetModel: "vendor-model-x", Enabled: true},
				},
			},
		},
	}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	_, resp := postTestKey(t, mux, `{"provider":"mock-prov"}`)
	if resp.Model != "vendor-model-x" || resp.ModelSource != "route" {
		t.Errorf("expected route model, got model=%q source=%q", resp.Model, resp.ModelSource)
	}

	_, resp = postTestKey(t, mux, `{"provider":"mock-prov","model":"explicit-model-y"}`)
	if resp.Model != "explicit-model-y" || resp.ModelSource != "request" {
		t.Errorf("expected request model, got model=%q source=%q", resp.Model, resp.ModelSource)
	}
}

func TestAdminServer_TestKey_SelectsTargetKey(t *testing.T) {
	var seenAuth []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = append(seenAuth, r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer upstream.Close()

	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, _ := config.NewLocalSource(tmpDir, "pass")
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)
	_, _ = localSrc.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"two-keys": {
				ID:      "two-keys",
				BaseURL: upstream.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k_old", Label: "old", Key: "sk-old-key-11111111", Enabled: false},
					{ID: "k_live", Label: "live", Key: "sk-live-key-22222222", Enabled: true},
				},
			},
		},
	})
	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetHTTPClient(upstream.Client())
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Explicit label targets the disabled key (operator decides re-enable).
	_, resp := postTestKey(t, mux, `{"provider":"two-keys","key_label":"old"}`)
	if !resp.Valid || resp.KeyLabel != "old" {
		t.Fatalf("expected explicit label to hit disabled key, got %+v", resp)
	}
	// No target: first enabled key.
	_, resp = postTestKey(t, mux, `{"provider":"two-keys"}`)
	if !resp.Valid || resp.KeyLabel != "live" || resp.KeyID != "k_live" {
		t.Fatalf("expected first enabled key, got %+v", resp)
	}
	if len(seenAuth) != 2 ||
		seenAuth[0] != "Bearer sk-old-key-11111111" ||
		seenAuth[1] != "Bearer sk-live-key-22222222" {
		t.Errorf("unexpected auth sequence: %v", seenAuth)
	}
}

func TestAdminServer_TestKey_RecordsProbeTraceWithoutLedger(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"}}]}`))
	}))
	defer upstream.Close()

	srv, _, obsMgr, mux, tmpDir := newTestKeyServer(t, upstream.URL)
	srv.SetHTTPClient(upstream.Client())

	if rec, resp := postTestKey(t, mux, `{"provider":"mock-prov"}`); rec.Code != http.StatusOK || !resp.Valid {
		t.Fatalf("test-key failed: %d %+v", rec.Code, resp)
	}

	traces := obsMgr.RecentTraces(false)
	probes := 0
	for _, tr := range traces {
		if tr.Source == "probe" {
			probes++
			if tr.Endpoint != "/admin/test-key" {
				t.Errorf("unexpected probe endpoint %q", tr.Endpoint)
			}
			if tr.WinnerProvider != "mock-prov" || tr.WinnerKey != "k-one" {
				t.Errorf("probe trace missing provider/key: %+v", tr)
			}
			if tr.ReqModel != "gpt-4o-mini" || tr.ServedModel != "gpt-4o-mini" {
				t.Errorf("probe trace missing model: %+v", tr)
			}
			if tr.Status != 200 || tr.TotalMillis < 0 || tr.TTFTMillis < 0 {
				t.Errorf("probe trace status/millis: %+v", tr)
			}
			if len(tr.Tries) != 1 || tr.Tries[0].Provider != "mock-prov" || tr.Tries[0].Status != 200 {
				t.Errorf("probe trace tries: %+v", tr.Tries)
			}
		}
	}
	if probes != 1 {
		t.Fatalf("expected exactly one probe trace, got %d (all traces: %d)", probes, len(traces))
	}

	// The usage ledger must not carry the probe.
	if err := obsMgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	ledger := filepath.Join(tmpDir, "usage.jsonl")
	if raw, err := os.ReadFile(ledger); err == nil && len(bytes.TrimSpace(raw)) > 0 {
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if strings.Contains(line, "/admin/test-key") || strings.Contains(line, `"ep":"`+testKeyEndpoint) {
				t.Fatalf("usage ledger recorded the probe: %s", line)
			}
		}
		t.Fatalf("usage ledger should be empty after a probe-only request, got %s", string(raw))
	}
}

func TestAdminServer_TestKey_LastTestPersists(t *testing.T) {
	_, _, _, mux, _ := newTestKeyServer(t, "https://api.mock.invalid/v1")

	// The console stamps last_test on the KeyEntry and saves the provider; the
	// typed round-trip must preserve it so a refresh still shows the pill.
	lastTest := &types.KeyLastTest{
		OK:        true,
		Status:    200,
		LatencyMS: 812,
		ReplyText: "你好！",
		At:        "2026-11-25T10:00:00Z",
	}
	cfg := types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"mock-prov": {
				ID:      "mock-prov",
				BaseURL: "https://api.mock.invalid/v1",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k-one", Key: testKeySecret, Enabled: true, LastTest: lastTest},
				},
			},
		},
	}
	body, _ := json.Marshal(cfg)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/config", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("save config: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/config", nil)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	var got types.ProxyConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	keys := got.Providers["mock-prov"].APIKeys
	if len(keys) != 1 || keys[0].LastTest == nil {
		t.Fatalf("last_test missing after round-trip: %s", rec.Body.String())
	}
	if keys[0].LastTest.ReplyText != "你好！" || keys[0].LastTest.LatencyMS != 812 || !keys[0].LastTest.OK {
		t.Errorf("last_test not preserved: %+v", keys[0].LastTest)
	}
}
