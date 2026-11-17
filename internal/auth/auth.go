// Package auth provides constant-time SHA-256 and digest comparison authentication,
// anti-bruteforce IP rate limiting, and client key verification.
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	MaxFailedAttempts = 5
	WindowDuration    = 10 * time.Minute
	BlockDuration     = 10 * time.Minute
	MaxTrackedIPs     = 4096
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

// ExtractHeaderToken extracts auth token strictly from request headers
// (Authorization, X-Api-Key, x-goog-api-key), ignoring URL query parameters.
func ExtractHeaderToken(r *http.Request) string {
	if r == nil {
		return ""
	}
	if h := r.Header.Get("Authorization"); h != "" {
		if len(h) >= 7 && strings.EqualFold(h[:7], "bearer ") {
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
	return ""
}

// ExtractToken extracts auth token from request headers (Authorization, X-Api-Key, x-goog-api-key) or query parameter.
func ExtractToken(r *http.Request) string {
	if tok := ExtractHeaderToken(r); tok != "" {
		return tok
	}
	if r == nil || r.URL == nil {
		return ""
	}
	if q := r.URL.Query().Get("key"); q != "" {
		return strings.TrimSpace(q)
	}
	if q := r.URL.Query().Get("token"); q != "" {
		return strings.TrimSpace(q)
	}
	return ""
}

// GetClientIP resolves the client IP, respecting X-Forwarded-For only from loopback
// (or when TRUST_PROXY_HEADERS=1) and extracting the rightmost non-loopback IP so
// client-prepended X-Forwarded-For values cannot spoof arbitrary IPs behind a local proxy.
func GetClientIP(r *http.Request) string {
	if r == nil {
		return "127.0.0.1"
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	if host == "" {
		host = "127.0.0.1"
	}

	remoteAddr, parseErr := netip.ParseAddr(host)
	isLoopback := (parseErr == nil && remoteAddr.Unmap().IsLoopback()) || host == "127.0.0.1" || host == "::1"

	trustEnv := strings.TrimSpace(os.Getenv("TRUST_PROXY_HEADERS"))
	trustHeaders := trustEnv == "1" || strings.EqualFold(trustEnv, "true")

	if isLoopback || trustHeaders {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			var fallbackLoopback string
			for i := len(parts) - 1; i >= 0; i-- {
				cand := strings.TrimSpace(parts[i])
				if cand == "" {
					continue
				}
				parsed, pErr := netip.ParseAddr(cand)
				if pErr != nil {
					continue
				}
				u := parsed.Unmap()
				if !u.IsLoopback() {
					return u.String()
				}
				if fallbackLoopback == "" {
					fallbackLoopback = u.String()
				}
			}
			if fallbackLoopback != "" {
				return fallbackLoopback
			}
		}
		if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
			if parsed, pErr := netip.ParseAddr(xrip); pErr == nil {
				return parsed.Unmap().String()
			}
		}
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
// Strictly accepts only configured clientKey or extraKeys (never adminPassword).
func (a *Authenticator) VerifyClientKey(r *http.Request) bool {
	token := ExtractToken(r)
	if token == "" {
		return false
	}

	a.mu.RLock()
	ck := a.clientKey
	extras := make([]string, len(a.extraKeys))
	copy(extras, a.extraKeys)
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

	return false
}

// VerifyAdminAuth verifies admin authentication for management endpoints with anti-bruteforce lockout.
// Accepts credentials strictly via HTTP headers (never URL query parameters).
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

	token := ExtractHeaderToken(r)
	if token == "" {
		// Credential-less requests (page loads, health probes, unauthenticated
		// scripts) must NOT consume the brute-force budget: the admin console
		// itself issues a GET /api/config before login. Only an actually wrong
		// credential counts as a brute-force attempt.
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
	// Clean attempts older than window for this IP
	var fresh []time.Time
	for _, t := range a.failedAttempts[ip] {
		if now.Sub(t) < WindowDuration {
			fresh = append(fresh, t)
		}
	}
	fresh = append(fresh, now)

	if _, exists := a.failedAttempts[ip]; !exists && len(a.failedAttempts) >= MaxTrackedIPs {
		a.evictFailedAttemptsLocked(now)
	}
	a.failedAttempts[ip] = fresh

	if len(fresh) >= MaxFailedAttempts {
		if _, exists := a.blockedIPs[ip]; !exists && len(a.blockedIPs) >= MaxTrackedIPs {
			a.evictBlockedIPsLocked(now)
		}
		a.blockedIPs[ip] = now.Add(BlockDuration)
	}
}

func (a *Authenticator) evictFailedAttemptsLocked(now time.Time) {
	var oldestKey string
	var oldestTime time.Time
	for k, ts := range a.failedAttempts {
		if len(ts) == 0 || now.Sub(ts[len(ts)-1]) >= WindowDuration {
			delete(a.failedAttempts, k)
			continue
		}
		last := ts[len(ts)-1]
		if oldestKey == "" || last.Before(oldestTime) {
			oldestKey = k
			oldestTime = last
		}
	}
	if len(a.failedAttempts) >= MaxTrackedIPs && oldestKey != "" {
		delete(a.failedAttempts, oldestKey)
	}
}

func (a *Authenticator) evictBlockedIPsLocked(now time.Time) {
	var oldestKey string
	var oldestUntil time.Time
	for k, until := range a.blockedIPs {
		if !now.Before(until) {
			delete(a.blockedIPs, k)
			continue
		}
		if oldestKey == "" || until.Before(oldestUntil) {
			oldestKey = k
			oldestUntil = until
		}
	}
	if len(a.blockedIPs) >= MaxTrackedIPs && oldestKey != "" {
		delete(a.blockedIPs, oldestKey)
	}
}

// IsIPBlocked returns whether the given IP is currently blocked by anti-bruteforce rules.
func (a *Authenticator) IsIPBlocked(ip string) bool {
	return a.BlockRemaining(ip) > 0
}

// BlockRemaining returns how long the given IP stays blocked (0 when not blocked).
func (a *Authenticator) BlockRemaining(ip string) time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	until, ok := a.blockedIPs[ip]
	if !ok {
		return 0
	}
	if d := until.Sub(time.Now()); d > 0 {
		return d
	}
	delete(a.blockedIPs, ip)
	return 0
}
