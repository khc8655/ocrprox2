package admin

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
)

const adminSessionCookie = "llmproxy_admin_session"

func (s *Server) computeSessionToken(adminPass string) string {
	mac := hmac.New(sha256.New, []byte(adminPass))
	mac.Write([]byte("llmproxy_admin_session_v1"))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) getAdminPassword() string {
	if s.adminPassword != "" {
		return s.adminPassword
	}
	return os.Getenv("ADMIN_PASSWORD")
}

func (s *Server) isAdminAuthorized(r *http.Request) bool {
	// 1. Check Bearer / header auth via Authenticator
	token := auth.ExtractToken(r)
	if token != "" {
		if s.authMgr.VerifyAdminAuth(r) {
			return true
		}
	}

	// 2. Check secure session cookie
	if cookie, err := r.Cookie(adminSessionCookie); err == nil && cookie.Value != "" {
		adminPass := s.getAdminPassword()
		if adminPass != "" {
			expected := s.computeSessionToken(adminPass)
			if subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(expected)) == 1 {
				return true
			}
		}
	}

	// 3. Fallback: if no valid token or cookie, verify with authMgr (records failure for anti-bruteforce)
	return s.authMgr.VerifyAdminAuth(r)
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Password == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "missing password",
		})
		return
	}

	// Check anti-bruteforce and verify password via authMgr
	// Lockout state is sampled first: the attempt that trips the 5th failure
	// still answers 401 ("bad credentials"), later attempts answer 429.
	blockedBefore := s.adminIPBlocked(r)
	fakeReq := httptest.NewRequest(http.MethodGet, "/test", nil)
	fakeReq.Header.Set("Authorization", "Bearer "+req.Password)
	fakeReq.RemoteAddr = r.RemoteAddr
	if !s.authMgr.VerifyAdminAuth(fakeReq) {
		if blockedBefore {
			if remaining := s.authMgr.BlockRemaining(auth.GetClientIP(r)); remaining > 0 {
				secs := int(remaining.Seconds())
				if secs < 1 {
					secs = 1
				}
				w.Header().Set("Retry-After", strconv.Itoa(secs))
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ok":              false,
					"error":           "too many failed attempts, retry later",
					"retry_after_sec": secs,
				})
				return
			}
		}
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "unauthorized admin credentials",
		})
		return
	}

	s.adminPassword = req.Password
	token := s.computeSessionToken(req.Password)

	http.SetCookie(w, &http.Cookie{
		Name:     adminSessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   7 * 24 * 3600, // 7 days
	})

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true,
	})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     adminSessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true,
	})
}
