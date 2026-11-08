// Package router provides HTTP routing guards and middleware.
package router

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/khc8655/llmproxy2/internal/types"
)

// AllowedLiteRoutes defines the strict set of routes allowed in lite mode.
var AllowedLiteRoutes = map[string]bool{
	"GET /healthz":                  true,
	"GET /health":                   true,
	"GET /v1/models":                true,
	"POST /v1/chat/completions":     true,
	"POST /v1/messages":             true,
	"POST /v1/responses":            true,
	"GET /api/v1/models":            true,
	"POST /api/v1/chat/completions": true,
	"POST /api/v1/messages":         true,
	"POST /api/v1/responses":        true,
}

// FullOnlyRoutes defines the whitelist of routes available exclusively in full mode.
var FullOnlyRoutes = map[string]bool{
	"/":                           true,
	"GET /":                       true,
	"/admin":                      true,
	"GET /admin":                  true,
	"/admin/":                     true,
	"GET /admin/":                 true,
	"/api/config":                 true,
	"GET /api/config":             true,
	"POST /api/config":            true,
	"/api/admin/usage":            true,
	"GET /api/admin/usage":        true,
	"/api/admin/traces":           true,
	"GET /api/admin/traces":       true,
	"/api/admin/cooldowns":        true,
	"GET /api/admin/cooldowns":    true,
	"POST /api/admin/cooldowns":   true,
	"DELETE /api/admin/cooldowns":  true,
	"/api/admin/mode":             true,
	"GET /api/admin/mode":         true,
	"POST /api/admin/mode":        true,
	"/api/admin/probe-models":     true,
	"GET /api/admin/probe-models": true,
	"POST /api/admin/probe-models": true,
	"/api/admin/verify-key":       true,
	"POST /api/admin/verify-key":  true,
	"/api/admin/oauth/start":      true,
	"POST /api/admin/oauth/start": true,
	"/api/admin/oauth/poll":       true,
	"GET /api/admin/oauth/poll":   true,
	"POST /api/admin/oauth/poll":  true,
	"/api/vault/manifest":         true,
	"GET /api/vault/manifest":     true,
	"/api/vault/fetch":            true,
	"POST /api/vault/fetch":       true,
	"/v1/ocr":                     true,
	"POST /v1/ocr":                true,
	"/v1/embeddings":              true,
	"POST /v1/embeddings":         true,
	"/v1/rerank":                  true,
	"POST /v1/rerank":             true,
	"/api/v1/ocr":                 true,
	"POST /api/v1/ocr":            true,
	"/api/v1/embeddings":          true,
	"POST /api/v1/embeddings":     true,
	"/api/v1/rerank":              true,
	"POST /api/v1/rerank":         true,
}

// ValidateRegisteredRoutes checks that all given route patterns are explicitly registered
// in either AllowedLiteRoutes or FullOnlyRoutes. Returns an error if any unregistered pattern is found.
func ValidateRegisteredRoutes(patterns []string) error {
	for _, p := range patterns {
		if !isPatternRegistered(p) {
			return fmt.Errorf("unregistered route pattern %q: must be declared in AllowedLiteRoutes or FullOnlyRoutes", p)
		}
	}
	return nil
}

func isPatternRegistered(pattern string) bool {
	if AllowedLiteRoutes[pattern] || FullOnlyRoutes[pattern] {
		return true
	}
	// If pattern is "METHOD /path", also check if "/path" is registered
	parts := strings.SplitN(pattern, " ", 2)
	if len(parts) == 2 {
		if AllowedLiteRoutes[parts[1]] || FullOnlyRoutes[parts[1]] {
			return true
		}
	} else {
		// Pattern is path only, e.g. "/api/config". Check if any entry ends with " /path"
		suffix := " " + pattern
		for k := range AllowedLiteRoutes {
			if strings.HasSuffix(k, suffix) {
				return true
			}
		}
		for k := range FullOnlyRoutes {
			if strings.HasSuffix(k, suffix) {
				return true
			}
		}
	}
	return false
}

// RouteMux wraps http.ServeMux to record registered patterns for test auditing.
type RouteMux struct {
	*http.ServeMux
	patterns []string
}

// NewRouteMux creates a new RouteMux.
func NewRouteMux() *RouteMux {
	return &RouteMux{
		ServeMux: http.NewServeMux(),
		patterns: make([]string, 0),
	}
}

// HandleFunc records pattern and registers handler.
func (m *RouteMux) HandleFunc(pattern string, h http.HandlerFunc) {
	m.patterns = append(m.patterns, pattern)
	m.ServeMux.HandleFunc(pattern, h)
}

// Patterns returns all registered route patterns.
func (m *RouteMux) Patterns() []string {
	return append([]string(nil), m.patterns...)
}

// Validate checks all registered patterns against AllowedLiteRoutes and FullOnlyRoutes.
func (m *RouteMux) Validate() error {
	return ValidateRegisteredRoutes(m.patterns)
}

// ReadOnlyGuard creates an HTTP middleware that enforces the lite mode route whitelist.
func ReadOnlyGuard(role types.Role, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if role == types.RoleLite {
			method := r.Method
			path := r.URL.Path

			// Check exact match
			key := method + " " + path
			if !AllowedLiteRoutes[key] {
				// Check prefix match for /api/v1/*
				if !(strings.HasPrefix(path, "/api/v1/") && (method == "GET" || method == "POST")) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusForbidden)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"error": map[string]any{
							"message": "route is disabled in lite mode",
							"type":    "permission_error",
							"code":    "lite_mode_forbidden",
						},
					})
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
