// Package auth provides constant-time SHA-256 and digest comparison authentication,
// anti-bruteforce IP rate limiting, and client key verification.
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	MaxFailedAttempts = 5
	WindowDuration    = 10 * time.Minute
	BlockDuration     = 10 * time.Minute
)

// Authenticator handles client key and admin password authentication with anti-bruteforce defense.
type Authenticator struct {
	mu             sync.RWMutex
	failedAttempts map[string][]time.Time
	blockedIPs     map[string]time.Time
	clientKey      string
	extraKeys      []string
	adminPassword  string
}

// NewAuthenticator creates a new Authenticator.
func NewAuthenticator(clientKey, adminPassword string) *Authenticator {
	return &Authenticator{
		failedAttempts: make(map[string][]time.Time),
		blockedIPs:     make(map[string]time.Time),
		clientKey:      clientKey,
		adminPassword:  adminPassword,
	}
}

// SetClientKey updates the active client key dynamically.
func (a *Authenticator) SetClientKey(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.clientKey = key
}

// UpdateClientKeys dynamically updates the primary client key and additional proxy keys.
func (a *Authenticator) UpdateClientKeys(primary string, extra []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.clientKey = primary
	a.extraKeys = make([]string, 0, len(extra))
	for _, k := range extra {
		trimmed := strings.TrimSpace(k)
		if trimmed != "" {
			a.extraKeys = append(a.extraKeys, trimmed)
		}
	}
}

// GetClientKeys returns the current primary key and extra keys.
func (a *Authenticator) GetClientKeys() (string, []string) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	copied := make([]string, len(a.extraKeys))
	copy(copied, a.extraKeys)
	return a.clientKey, copied
}

// SetAdminPassword updates the admin password dynamically.
func (a *Authenticator) SetAdminPassword(pass string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.adminPassword = pass
}

// ExtractToken extracts auth token from request headers (Authorization, X-Api-Key, x-goog-api-key) or query parameter.
func ExtractToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(strings.ToLower(h), "bearer ") {
			return strings.TrimSpace(h[7:])
		}
		return strings.TrimSpace(h)
	}
	if k := r.Header.Get("X-Api-Key"); k != "" {
		return strings.TrimSpace(k)
	}
	if k := r.Header.Get("x-goog-api-key"); k != "" {
		return strings.TrimSpace(k)
	}
	if q := r.URL.Query().Get("key"); q != "" {
		return strings.TrimSpace(q)
	}
	if q := r.URL.Query().Get("token"); q != "" {
		return strings.TrimSpace(q)
	}
	return ""
}

// GetClientIP resolves the client IP, respecting X-Forwarded-For only from loopback or trusted proxies.
func GetClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}

	trustHeaders := os.Getenv("TRUST_PROXY_HEADERS") == "1" ||
		strings.ToLower(os.Getenv("TRUST_PROXY_HEADERS")) == "true"

	if trustHeaders || host == "127.0.0.1" || host == "::1" {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[0])
		}
		if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
			return strings.TrimSpace(xrip)
		}
	}

	if host == "" {
		return "127.0.0.1"
	}
	return host
}

// ConstantTimeCompare performs timing-attack resistant comparison.
func ConstantTimeCompare(a, b string) bool {
	h1 := sha256.Sum256([]byte(a))
	h2 := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(h1[:], h2[:]) == 1
}

// VerifyClientKey verifies client request authentication for /v1/* endpoints.
// Enforced for ALL sources including 127.0.0.1 and ::1.
func (a *Authenticator) VerifyClientKey(r *http.Request) bool {
	token := ExtractToken(r)
	if token == "" {
		return false
	}

	a.mu.RLock()
	ck := a.clientKey
	extras := make([]string, len(a.extraKeys))
	copy(extras, a.extraKeys)
	ap := a.adminPassword
	a.mu.RUnlock()

	// Check against configured CLIENT_KEY
	if ck != "" && ConstantTimeCompare(token, ck) {
		return true
	}

	// Check against extra proxy keys
	for _, ek := range extras {
		if ek != "" && ConstantTimeCompare(token, ek) {
			return true
		}
	}

	// Also allow ADMIN_PASSWORD as override/management testing
	if ap != "" && ConstantTimeCompare(token, ap) {
		return true
	}

	return false
}

// VerifyAdminAuth verifies admin authentication for management endpoints with anti-bruteforce lockout.
func (a *Authenticator) VerifyAdminAuth(r *http.Request) bool {
	ip := GetClientIP(r)

	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()

	// Check if IP is currently blocked
	if blockedUntil, ok := a.blockedIPs[ip]; ok {
		if now.Before(blockedUntil) {
			return false
		}
		delete(a.blockedIPs, ip)
	}

	if a.adminPassword == "" {
		return false
	}

	token := ExtractToken(r)
	if token == "" {
		a.recordAdminFailure(ip, now)
		return false
	}

	if !ConstantTimeCompare(token, a.adminPassword) {
		a.recordAdminFailure(ip, now)
		return false
	}

	// Success: clear failed attempts
	delete(a.failedAttempts, ip)
	return true
}

func (a *Authenticator) recordAdminFailure(ip string, now time.Time) {
	// Clean attempts older than window
	var fresh []time.Time
	for _, t := range a.failedAttempts[ip] {
		if now.Sub(t) < WindowDuration {
			fresh = append(fresh, t)
		}
	}
	fresh = append(fresh, now)
	a.failedAttempts[ip] = fresh

	if len(fresh) >= MaxFailedAttempts {
		a.blockedIPs[ip] = now.Add(BlockDuration)
	}
}

// IsIPBlocked returns whether the given IP is currently blocked by anti-bruteforce rules.
func (a *Authenticator) IsIPBlocked(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	until, ok := a.blockedIPs[ip]
	return ok && time.Now().Before(until)
}
