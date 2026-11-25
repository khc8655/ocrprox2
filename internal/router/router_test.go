package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestReadOnlyGuard_LiteMode(t *testing.T) {
	dummy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := ReadOnlyGuard(types.RoleLite, dummy)

	// Allowed routes
	allowed := []struct {
		method string
		path   string
	}{
		{"GET", "/healthz"},
		{"GET", "/health"},
		{"GET", "/v1/models"},
		{"POST", "/v1/chat/completions"},
		{"POST", "/v1/messages"},
		{"POST", "/v1/responses"},
		{"POST", "/api/v1/chat/completions"},
	}

	for _, tc := range allowed {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("expected 200 for allowed %s %s, got %d", tc.method, tc.path, rec.Code)
		}
	}

	// Blocked routes in Lite mode
	blocked := []struct {
		method string
		path   string
	}{
		{"GET", "/api/config"},
		{"POST", "/api/config"},
		{"PUT", "/api/config"},
		{"GET", "/api/admin/config"},
		{"POST", "/api/admin/config"},
		{"PUT", "/api/admin/config"},
		{"GET", "/api/admin/config/export"},
		{"POST", "/api/admin/config/import"},
		{"POST", "/api/admin/test-candidate"},
		{"POST", "/api/admin/test-agent-model"},
		{"DELETE", "/api/admin/traces"},
		{"GET", "/api/admin/recent-requests"},
		{"GET", "/api/lanes"},
		{"GET", "/api/admin/lanes"},
		{"GET", "/admin"},
		{"POST", "/v1/ocr"},
		{"POST", "/api/admin/detect-provider"},
		{"POST", "/api/admin/balance"},
		{"POST", "/api/admin/test-provider"},
		{"POST", "/api/admin/autolist-sync"},
		{"GET", "/api/admin/presets-extra"},
		{"GET", "/api/admin/access-info"},
		{"POST", "/api/admin/access-key"},
		{"POST", "/api/admin/client-key"},
		{"POST", "/api/admin/auth/login"},
		{"POST", "/api/admin/auth/logout"},
		{"GET", "/api/admin/model-catalog"},
		{"POST", "/api/admin/model-catalog/sync"},
		{"POST", "/api/admin/model-catalog/lookup"},
	}

	for _, tc := range blocked {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403 for blocked %s %s, got %d", tc.method, tc.path, rec.Code)
		}
	}
}

func TestReadOnlyGuard_FullMode(t *testing.T) {
	dummy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := ReadOnlyGuard(types.RoleFull, dummy)

	// In Full mode, even /api/config is allowed through ReadOnlyGuard
	req := httptest.NewRequest("GET", "/api/config", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for full mode route, got %d", rec.Code)
	}
}

func TestSecurityAndCORS(t *testing.T) {
	dummy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	stack := SecurityHeadersMiddleware(CORSMiddleware(dummy))

	req := httptest.NewRequest("OPTIONS", "/v1/chat/completions", nil)
	rec := httptest.NewRecorder()
	stack.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204 for OPTIONS, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("expected Access-Control-Allow-Origin: *")
	}
	if rec.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("expected X-Frame-Options: DENY")
	}
}

func TestValidateRegisteredRoutes_Success(t *testing.T) {
	validRoutes := []string{
		"GET /healthz",
		"GET /health",
		"GET /v1/models",
		"POST /v1/chat/completions",
		"POST /v1/messages",
		"POST /v1/responses",
		"GET /api/v1/models",
		"POST /api/v1/chat/completions",
		"POST /api/v1/messages",
		"POST /api/v1/responses",
		"GET /admin",
		"/api/config",
		"GET /api/admin/config",
		"POST /api/admin/config",
		"PUT /api/admin/config",
		"GET /api/admin/config/export",
		"POST /api/admin/config/import",
		"POST /api/admin/test-candidate",
		"POST /api/admin/test-agent-model",
		"DELETE /api/admin/traces",
		"GET /api/admin/recent-requests",
		"GET /api/lanes",
		"GET /api/admin/lanes",
		"/api/admin/usage",
		"/api/admin/traces",
		"/api/admin/cooldowns",
		"/api/admin/probe-models",
		"/api/admin/verify-key",
		"/api/admin/oauth/start",
		"/api/admin/oauth/poll",
		"/api/vault/manifest",
		"/api/vault/fetch",
		"POST /v1/ocr",
		"POST /v1/embeddings",
		"POST /v1/rerank",
		"POST /api/v1/ocr",
		"POST /api/v1/embeddings",
		"POST /api/v1/rerank",
		"POST /api/admin/detect-provider",
		"POST /api/admin/test-provider",
		"GET /api/admin/presets-extra",
		"GET /api/admin/access-info",
		"POST /api/admin/access-key",
		"POST /api/admin/client-key",
		"POST /api/admin/auth/login",
		"POST /api/admin/auth/logout",
		"GET /api/admin/model-catalog",
		"POST /api/admin/model-catalog/sync",
		"POST /api/admin/model-catalog/lookup",
	}

	if err := ValidateRegisteredRoutes(validRoutes); err != nil {
		t.Fatalf("expected all valid routes to pass validation, got: %v", err)
	}

	// Also test via RouteMux.Validate()
	mux := NewRouteMux()
	for _, p := range validRoutes {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {})
	}
	if err := mux.Validate(); err != nil {
		t.Fatalf("expected RouteMux.Validate() to pass, got: %v", err)
	}
}

func TestValidateRegisteredRoutes_UnregisteredError(t *testing.T) {
	invalidSets := [][]string{
		{"POST /v1/unknown_evil_endpoint"},
		{"GET /api/backdoor"},
		{"POST /admin/drop_database"},
	}

	for _, set := range invalidSets {
		err := ValidateRegisteredRoutes(set)
		if err == nil {
			t.Errorf("expected validation error for unregistered pattern %v, but got nil", set)
		} else if !strings.Contains(err.Error(), "unregistered route pattern") {
			t.Errorf("expected error message to mention 'unregistered route pattern', got: %v", err)
		}
	}
}
