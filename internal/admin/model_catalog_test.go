package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/modelcatalog"
)

// catalogServer wires an admin Server whose vault credentials point at hubURL
// and whose model catalog store lives in dir.
func catalogServer(t *testing.T, hubURL string, dir string) (*Server, *http.ServeMux) {
	t.Helper()
	authMgr := auth.NewAuthenticator("ck", "ap")
	src, err := config.NewLocalSource(dir, "ap")
	if err != nil {
		t.Fatalf("NewLocalSource: %v", err)
	}
	srv := NewServer(authMgr, src, nil, nil)
	srv.SetAdminPassword("ap")
	srv.SetDefaultVault(hubURL, "stk_node_test")
	srv.SetModelCatalogStore(modelcatalog.NewStore(dir))
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)
	return srv, mux
}

func doCatalogReq(t *testing.T, mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	r.Header.Set("Authorization", "Bearer ap")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	return rec
}

const hubCatalogText = `{"schema":1,"source":"models.dev","fetched_at":"2026-04-04T00:00:00Z","model_count":2,` +
	`"providers":{"deepseek":{"deepseek-v4-pro":{"limit":{"context":1048576,"output":393216},` +
	`"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","high","max"]}],` +
	`"family":"deepseek-thinking","release_date":"2026-08-13"},"deepseek-chat":{}}}}`

func TestModelCatalog_StatusOnFreshNode(t *testing.T) {
	dir := t.TempDir()
	_, mux := catalogServer(t, "", dir)

	rec := doCatalogReq(t, mux, http.MethodGet, "/api/admin/model-catalog", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// Fresh node, no cache file: the embedded bundle answers.
	if got["ok"] != true || got["present"] != true || got["source"] != "bundled" {
		t.Fatalf("status body = %v, want ok/present/bundled", got)
	}
	if got["model_count"] != float64(8968) {
		t.Errorf("model_count = %v, want 8968", got["model_count"])
	}
	if got["cache_filename"] != modelcatalog.CacheFileName {
		t.Errorf("cache_filename = %v", got["cache_filename"])
	}
	if _, err := os.Stat(filepath.Join(dir, modelcatalog.CacheFileName)); !os.IsNotExist(err) {
		t.Error("GET status must not create the cache file")
	}

	// Unauthenticated.
	req := httptest.NewRequest(http.MethodGet, "/api/admin/model-catalog", nil)
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated status = %d, want 401", rec2.Code)
	}
}

func TestModelCatalog_SyncPullsFromHubAndCaches(t *testing.T) {
	var sawAuth, sawPath string
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(hubCatalogText))
	}))
	defer hub.Close()

	dir := t.TempDir()
	srv, mux := catalogServer(t, hub.URL, dir)
	srv.SetAllowPrivate(true) // 127.0.0.1 upstream would otherwise be blocked

	rec := doCatalogReq(t, mux, http.MethodPost, "/api/admin/model-catalog/sync", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("sync = %d: %s", rec.Code, rec.Body.String())
	}
	t.Logf("POST /api/admin/model-catalog/sync -> %d %s", rec.Code, rec.Body.String())

	// Request shape: node token only, never the admin password.
	if sawPath != "/api/admin/model-catalog/data" {
		t.Errorf("hub path = %q, want /api/admin/model-catalog/data", sawPath)
	}
	if sawAuth != "Bearer stk_node_test" {
		t.Errorf("hub auth = %q, want the node token", sawAuth)
	}

	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["ok"] != true || got["source"] != "cache" || got["model_count"] != float64(2) {
		t.Errorf("sync body = %v", got)
	}
	if got["fetched_at"] != "2026-04-04T00:00:00Z" {
		t.Errorf("fetched_at = %v", got["fetched_at"])
	}

	// Cache file written verbatim.
	onDisk, err := os.ReadFile(filepath.Join(dir, modelcatalog.CacheFileName))
	if err != nil {
		t.Fatalf("cache file: %v", err)
	}
	if string(onDisk) != hubCatalogText {
		t.Error("cache file differs from the Hub payload")
	}

	// A fresh node process picks it up instead of the bundle.
	fresh := modelcatalog.NewStore(dir).Status()
	if fresh.Source != "cache" || fresh.ModelCount != 2 {
		t.Errorf("fresh store status = %+v, want cache/2", fresh)
	}
}

func TestModelCatalog_SyncFailureMapping(t *testing.T) {
	cases := []struct {
		name       string
		hubStatus  int
		wantStatus int
		wantError  string
	}{
		{"hub 401", http.StatusUnauthorized, http.StatusBadGateway, "hub_catalog_auth_required"},
		{"hub 403", http.StatusForbidden, http.StatusBadGateway, "hub_catalog_lite_forbidden"},
		{"hub 404", http.StatusNotFound, http.StatusNotFound, "catalog_not_found"},
		{"hub 500", http.StatusInternalServerError, http.StatusBadGateway, "hub_catalog_unreachable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.hubStatus)
			}))
			defer hub.Close()

			dir := t.TempDir()
			// Pre-existing cache: no failure may clobber it.
			if err := os.WriteFile(filepath.Join(dir, modelcatalog.CacheFileName), []byte(hubCatalogText), 0o600); err != nil {
				t.Fatal(err)
			}
			srv, mux := catalogServer(t, hub.URL, dir)
			srv.SetAllowPrivate(true)

			rec := doCatalogReq(t, mux, http.MethodPost, "/api/admin/model-catalog/sync", "")
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			var got map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got["error"] != tc.wantError {
				t.Errorf("error = %v, want %s", got["error"], tc.wantError)
			}
			t.Logf("%s -> %d %s", tc.name, rec.Code, rec.Body.String())

			onDisk, _ := os.ReadFile(filepath.Join(dir, modelcatalog.CacheFileName))
			if string(onDisk) != hubCatalogText {
				t.Error("failed sync modified the cache file")
			}
		})
	}
}

func TestModelCatalog_SyncRejectsInvalidPayload(t *testing.T) {
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"schema":2,"providers":{}}`))
	}))
	defer hub.Close()

	dir := t.TempDir()
	srv, mux := catalogServer(t, hub.URL, dir)
	srv.SetAllowPrivate(true)

	rec := doCatalogReq(t, mux, http.MethodPost, "/api/admin/model-catalog/sync", "")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "catalog_invalid") {
		t.Errorf("body = %s", rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, modelcatalog.CacheFileName)); !os.IsNotExist(err) {
		t.Error("invalid payload wrote a cache file")
	}
}

func TestModelCatalog_SyncRequiresHubURL(t *testing.T) {
	dir := t.TempDir()
	_, mux := catalogServer(t, "", dir)
	rec := doCatalogReq(t, mux, http.MethodPost, "/api/admin/model-catalog/sync", "")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "vault_hub_not_configured") {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestModelCatalog_SyncRejectsGet(t *testing.T) {
	// Routes are registered method-prefixed ("POST /api/admin/model-catalog/sync"),
	// so net/http's ServeMux answers 404 for other verbs — the same convention as
	// POST /api/admin/test-key. The handler's own 405 branch is defense in depth.
	_, mux := catalogServer(t, "", t.TempDir())
	rec := doCatalogReq(t, mux, http.MethodGet, "/api/admin/model-catalog/sync", "")
	if rec.Code == http.StatusOK {
		t.Fatalf("GET sync succeeded")
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET sync = %d, want 404 (method-prefixed route)", rec.Code)
	}
}

func TestModelCatalog_Lookup(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, modelcatalog.CacheFileName), []byte(hubCatalogText), 0o600); err != nil {
		t.Fatal(err)
	}
	_, mux := catalogServer(t, "", dir)

	rec := doCatalogReq(t, mux, http.MethodPost, "/api/admin/model-catalog/lookup",
		`{"preset_id":"deepseek","model_id":"deepseek-v4-pro"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("lookup = %d: %s", rec.Code, rec.Body.String())
	}
	t.Logf("POST /api/admin/model-catalog/lookup -> %d %s", rec.Code, rec.Body.String())
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["found"] != true || got["context_tokens"] != float64(1048576) || got["reasoning"] != true {
		t.Errorf("body = %v", got)
	}
	efforts, _ := got["efforts"].([]any)
	if len(efforts) != 3 || efforts[2] != "max" {
		t.Errorf("efforts = %v, want [low high max]", got["efforts"])
	}

	// Missing model: found=false, still 200, and every capability field is zero.
	rec = doCatalogReq(t, mux, http.MethodPost, "/api/admin/model-catalog/lookup",
		`{"preset_id":"deepseek","model_id":"nope"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("missing-model lookup = %d", rec.Code)
	}
	got = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["found"] != false || got["efforts"] != nil {
		t.Errorf("missing-model body = %v", got)
	}

	// Validation.
	rec = doCatalogReq(t, mux, http.MethodPost, "/api/admin/model-catalog/lookup", `{"preset_id":"deepseek"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("missing model_id = %d, want 400", rec.Code)
	}
	rec = doCatalogReq(t, mux, http.MethodPost, "/api/admin/model-catalog/lookup", `not json`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad json = %d, want 400", rec.Code)
	}
}

// TestModelCatalog_NotPartOfConfigExport proves the catalog cache is data, not
// configuration: export serializes types.ProxyConfig only (handleConfigExport
// marshals snap.Config), and import unmarshals into types.ProxyConfig, so a
// model-catalog blob in a payload can never round-trip through them.
func TestModelCatalog_NotPartOfConfigExport(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, modelcatalog.CacheFileName), []byte(hubCatalogText), 0o600); err != nil {
		t.Fatal(err)
	}
	_, mux := catalogServer(t, "", dir)

	// Force at least one config save so export has a snapshot with providers.
	save := doCatalogReq(t, mux, http.MethodPost, "/api/config", `{"providers":{}}`)
	if save.Code != http.StatusOK {
		t.Fatalf("config save = %d: %s", save.Code, save.Body.String())
	}

	rec := doCatalogReq(t, mux, http.MethodGet, "/api/admin/config/export", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("export = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, needle := range []string{"deepseek-v4-pro", "model-catalog", "model_catalog", "1048576"} {
		if strings.Contains(body, needle) {
			t.Errorf("config export leaked catalog content %q", needle)
		}
	}

	// Import of a payload carrying a catalog blob: the unknown field is dropped.
	imp := doCatalogReq(t, mux, http.MethodPost, "/api/admin/config/import",
		`{"config":{"providers":{},"model_catalog":{"schema":1,"providers":{"p":{"m":{}}}}}}`)
	if imp.Code != http.StatusOK {
		t.Fatalf("import = %d: %s", imp.Code, imp.Body.String())
	}
	exp2 := doCatalogReq(t, mux, http.MethodGet, "/api/admin/config/export", "")
	if strings.Contains(exp2.Body.String(), "model_catalog") {
		t.Error("imported model_catalog field survived into the stored config")
	}
}

func TestModelCatalog_EndpointsUnavailableWithoutStore(t *testing.T) {
	authMgr := auth.NewAuthenticator("ck", "ap")
	src, _ := config.NewLocalSource(t.TempDir(), "ap")
	srv := NewServer(authMgr, src, nil, nil)
	srv.SetAdminPassword("ap")
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/model-catalog"},
		{http.MethodPost, "/api/admin/model-catalog/sync"},
		{http.MethodPost, "/api/admin/model-catalog/lookup"},
	} {
		rec := doCatalogReq(t, mux, tc.method, tc.path, "")
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s = %d, want 503", tc.method, tc.path, rec.Code)
		}
	}
}
