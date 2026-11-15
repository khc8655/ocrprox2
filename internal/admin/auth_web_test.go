package admin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

func TestAuthWeb_Login_Logout_And_CookieAuth(t *testing.T) {
	tmpDir := t.TempDir()
	adminPass := "super-secure-admin-pass-123"
	authMgr := auth.NewAuthenticator("client-key-1", adminPass)
	localSrc, err := config.NewLocalSource(tmpDir, adminPass)
	if err != nil {
		t.Fatalf("local source error: %v", err)
	}
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetAdminPassword(adminPass)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// 1. Try accessing protected endpoint without auth -> 401
	{
		req := httptest.NewRequest(http.MethodGet, "/api/admin/access-info", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for unauthenticated request, got %d", rec.Code)
		}
	}

	// 2. Try login with wrong password -> 401
	{
		body, _ := json.Marshal(map[string]string{"password": "wrong-password"})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/auth/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for wrong password, got %d", rec.Code)
		}
	}

	// 3. Login with correct password -> 200 + sets session cookie
	var sessionCookie *http.Cookie
	{
		body, _ := json.Marshal(map[string]string{"password": adminPass})
		req := httptest.NewRequest(http.MethodPost, "/api/admin/auth/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for correct login, got %d: %s", rec.Code, rec.Body.String())
		}

		cookies := rec.Result().Cookies()
		for _, c := range cookies {
			if c.Name == adminSessionCookie {
				sessionCookie = c
				break
			}
		}
		if sessionCookie == nil {
			t.Fatalf("expected session cookie %q to be set", adminSessionCookie)
		}
		if !sessionCookie.HttpOnly {
			t.Errorf("expected session cookie HttpOnly=true")
		}
		if sessionCookie.SameSite != http.SameSiteStrictMode {
			t.Errorf("expected session cookie SameSite=Strict")
		}
		if sessionCookie.Path != "/" {
			t.Errorf("expected session cookie Path=/, got %s", sessionCookie.Path)
		}
	}

	// 4. Access protected endpoint using ONLY session cookie (no Bearer header) -> 200
	{
		req := httptest.NewRequest(http.MethodGet, "/api/admin/access-info", nil)
		req.AddCookie(sessionCookie)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 with session cookie, got %d: %s", rec.Code, rec.Body.String())
		}
	}

	// 5. Access protected endpoint using Bearer auth -> 200 (still 100% compatible!)
	{
		req := httptest.NewRequest(http.MethodGet, "/api/admin/access-info", nil)
		req.Header.Set("Authorization", "Bearer "+adminPass)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 with Bearer auth, got %d: %s", rec.Code, rec.Body.String())
		}
	}

	// 6. Access protected endpoint with tampered cookie -> 401
	{
		badCookie := &http.Cookie{
			Name:  adminSessionCookie,
			Value: "forged_tampered_cookie_value_here",
			Path:  "/",
		}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/access-info", nil)
		req.AddCookie(badCookie)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 with tampered cookie, got %d", rec.Code)
		}
	}

	// 7. Logout -> 200 + clears session cookie
	{
		req := httptest.NewRequest(http.MethodPost, "/api/admin/auth/logout", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for logout, got %d", rec.Code)
		}

		cookies := rec.Result().Cookies()
		cleared := false
		for _, c := range cookies {
			if c.Name == adminSessionCookie && (c.MaxAge < 0 || c.Value == "") {
				cleared = true
				break
			}
		}
		if !cleared {
			t.Fatalf("expected session cookie to be cleared on logout")
		}
	}
}

func TestAuthWeb_LockoutReturns429WithRetryAfter(t *testing.T) {
	tmpDir := t.TempDir()
	adminPass := "lockout-admin-pass-456"
	authMgr := auth.NewAuthenticator("client-key-1", adminPass)
	localSrc, err := config.NewLocalSource(tmpDir, adminPass)
	if err != nil {
		t.Fatalf("local source error: %v", err)
	}
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetAdminPassword(adminPass)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	const remote = "203.0.113.9:1234"
	wrong, _ := json.Marshal(map[string]string{"password": "wrong-password"})

	for i := 0; i < auth.MaxFailedAttempts; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/auth/login", bytes.NewReader(wrong))
		req.RemoteAddr = remote
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401 before lockout, got %d", i+1, rec.Code)
		}
	}

	// Locked out: even the correct password must get 429 + Retry-After.
	good, _ := json.Marshal(map[string]string{"password": adminPass})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/auth/login", bytes.NewReader(good))
	req.RemoteAddr = remote
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 while locked out, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatalf("expected Retry-After header on 429")
	}
}
