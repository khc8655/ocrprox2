// Package oauth implements RFC 8628 OAuth 2.0 Device Authorization Flow + PKCE
// and token refresh lifecycle for subscription providers like MiniMax Code Plan.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

var (
	ErrDevicePending        = errors.New("oauth: authorization pending, user has not completed verification")
	ErrDeviceExpired        = errors.New("oauth: device code expired")
	ErrTokenRefreshFailed   = errors.New("oauth: failed to refresh oauth token")
	ErrInvalidOAuthResponse = errors.New("oauth: invalid oauth response from server")
)

// PersistFunc is a callback invoked after a token is refreshed, allowing callers
// (such as LocalSource in Full mode) to atomically persist the updated KeyEntry.
type PersistFunc func(ctx context.Context, entry *types.KeyEntry) error

// DeviceSession holds the active RFC 8628 session for user verification.
type DeviceSession struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
	CreatedAt       int64  `json:"created_at"`
	CodeVerifier    string `json:"code_verifier,omitempty"`
}

// TokenResult holds the token response.
type TokenResult struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int64  `json:"expires_in"`
	TokenType    string `json:"token_type"`
}

// Manager coordinates OAuth device flow, PKCE S256, and automatic token renewals.
type Manager struct {
	mu          sync.Mutex
	client      *http.Client
	sessions    map[string]*DeviceSession
	tokenLocks  map[string]*sync.Mutex
	persistFn   PersistFunc
	enablePKCE  bool
}

// NewManager creates an OAuth Manager.
func NewManager(allowPrivate bool) *Manager {
	return &Manager{
		client:     upstream.DefaultClient(15*time.Second, allowPrivate),
		sessions:   make(map[string]*DeviceSession),
		tokenLocks: make(map[string]*sync.Mutex),
		enablePKCE: false,
	}
}

// SetPKCE configures whether PKCE S256 is enabled by default for device flow.
func (m *Manager) SetPKCE(enabled bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.enablePKCE = enabled
}

// IsPKCEEnabled returns whether PKCE S256 is currently enabled.
func (m *Manager) IsPKCEEnabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.enablePKCE
}

// SetPersistFunc sets the callback invoked when a token refresh successfully completes.
func (m *Manager) SetPersistFunc(fn PersistFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.persistFn = fn
}

// GeneratePKCE generates a cryptographically random code_verifier and its S256 code_challenge.
func GeneratePKCE() (verifier string, challenge string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("oauth: generate pkce entropy: %w", err)
	}
	verifier = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(h[:])
	return verifier, challenge, nil
}

// StartDeviceFlow initiates RFC 8628 device authorization with optional PKCE.
func (m *Manager) StartDeviceFlow(ctx context.Context, endpoint, clientID, scope string) (*DeviceSession, error) {
	m.mu.Lock()
	pkce := m.enablePKCE
	m.mu.Unlock()
	return m.StartDeviceFlowPKCE(ctx, endpoint, clientID, scope, pkce)
}

// StartDeviceFlowPKCE initiates RFC 8628 device authorization with explicit PKCE flag.
func (m *Manager) StartDeviceFlowPKCE(ctx context.Context, endpoint, clientID, scope string, usePKCE bool) (*DeviceSession, error) {
	data := url.Values{}
	data.Set("client_id", clientID)
	if scope != "" {
		data.Set("scope", scope)
	}

	var verifier string
	if usePKCE {
		var challenge string
		var err error
		verifier, challenge, err = GeneratePKCE()
		if err != nil {
			return nil, err
		}
		data.Set("code_challenge", challenge)
		data.Set("code_challenge_method", "S256")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oauth: device flow start: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("oauth: device flow error HTTP %d: %s", resp.StatusCode, string(b))
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("oauth: read device session body: %w", err)
	}

	// Parse with MiniMax quirks handling (expired_in fallback, millisecond interval)
	session, err := parseDeviceSession(bodyBytes)
	if err != nil {
		return nil, err
	}
	session.CreatedAt = time.Now().Unix()
	if verifier != "" {
		session.CodeVerifier = verifier
	}

	m.mu.Lock()
	m.sessions[session.DeviceCode] = session
	m.mu.Unlock()

	return session, nil
}

// parseDeviceSession parses raw device session JSON, accommodating MiniMax quirks:
// 1. "expired_in" fallback when "expires_in" is absent.
// 2. "interval" in milliseconds (e.g. 5000 -> 5s).
func parseDeviceSession(raw []byte) (*DeviceSession, error) {
	var aux struct {
		DeviceCode      string          `json:"device_code"`
		UserCode        string          `json:"user_code"`
		VerificationURI string          `json:"verification_uri"`
		ExpiresIn       json.Number     `json:"expires_in"`
		ExpiredIn       json.Number     `json:"expired_in"`
		Interval        json.Number     `json:"interval"`
	}

	if err := json.Unmarshal(raw, &aux); err != nil {
		return nil, ErrInvalidOAuthResponse
	}

	if aux.DeviceCode == "" && aux.UserCode == "" {
		return nil, ErrInvalidOAuthResponse
	}

	s := &DeviceSession{
		DeviceCode:      aux.DeviceCode,
		UserCode:        aux.UserCode,
		VerificationURI: aux.VerificationURI,
	}

	// Parse expires_in / expired_in
	exp := parseNumberInt(aux.ExpiresIn)
	if exp <= 0 {
		exp = parseNumberInt(aux.ExpiredIn)
	}
	s.ExpiresIn = exp

	// Parse interval (MiniMax millisecond check)
	iv := parseNumberInt(aux.Interval)
	if iv >= 1000 {
		iv = iv / 1000
	}
	if iv <= 0 {
		iv = 5
	}
	s.Interval = iv

	return s, nil
}

// PollToken polls the token endpoint for device code authorization.
// If codeVerifier is not supplied, it automatically retrieves it from the active DeviceSession.
func (m *Manager) PollToken(ctx context.Context, endpoint, clientID, deviceCode string, codeVerifier ...string) (*TokenResult, error) {
	data := url.Values{}
	data.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	data.Set("client_id", clientID)
	data.Set("device_code", deviceCode)

	var verifier string
	if len(codeVerifier) > 0 && codeVerifier[0] != "" {
		verifier = codeVerifier[0]
	} else {
		m.mu.Lock()
		if s, ok := m.sessions[deviceCode]; ok && s != nil {
			verifier = s.CodeVerifier
		}
		m.mu.Unlock()
	}

	if verifier != "" {
		data.Set("code_verifier", verifier)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode == http.StatusBadRequest {
		var errResp struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &errResp)
		if errResp.Error == "authorization_pending" {
			return nil, ErrDevicePending
		}
		if errResp.Error == "expired_token" {
			return nil, ErrDeviceExpired
		}
		return nil, fmt.Errorf("oauth: error %s", errResp.Error)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oauth: poll HTTP %d: %s", resp.StatusCode, string(body))
	}

	tok, err := parseTokenResult(body)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	delete(m.sessions, deviceCode)
	m.mu.Unlock()

	return tok, nil
}

// RefreshToken exchanges a refresh_token for a new access_token.
func (m *Manager) RefreshToken(ctx context.Context, endpoint, clientID, refreshToken string) (*TokenResult, error) {
	data := url.Values{}
	data.Set("grant_type", "refresh_token")
	data.Set("client_id", clientID)
	data.Set("refresh_token", refreshToken)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oauth: refresh HTTP %d: %s", resp.StatusCode, string(body))
	}

	return parseTokenResult(body)
}

// parseTokenResult parses raw token response JSON, supporting MiniMax "expired_in" fallback.
func parseTokenResult(raw []byte) (*TokenResult, error) {
	var aux struct {
		AccessToken  string      `json:"access_token"`
		RefreshToken string      `json:"refresh_token"`
		ExpiresIn    json.Number `json:"expires_in"`
		ExpiredIn    json.Number `json:"expired_in"`
		TokenType    string      `json:"token_type"`
	}

	if err := json.Unmarshal(raw, &aux); err != nil {
		return nil, ErrInvalidOAuthResponse
	}

	if aux.AccessToken == "" {
		return nil, ErrInvalidOAuthResponse
	}

	exp := parseNumberInt64(aux.ExpiresIn)
	if exp <= 0 {
		exp = parseNumberInt64(aux.ExpiredIn)
	}

	return &TokenResult{
		AccessToken:  aux.AccessToken,
		RefreshToken: aux.RefreshToken,
		ExpiresIn:    exp,
		TokenType:    aux.TokenType,
	}, nil
}

func parseNumberInt(n json.Number) int {
	s := n.String()
	if s == "" {
		return 0
	}
	if v, err := strconv.Atoi(s); err == nil {
		return v
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return int(f)
	}
	return 0
}

func parseNumberInt64(n json.Number) int64 {
	s := n.String()
	if s == "" {
		return 0
	}
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		return v
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return int64(f)
	}
	return 0
}

// EnsureValidToken checks if key entry's token is close to expiry (within 1 hour) and refreshes if needed.
// When a refresh succeeds, if a PersistFunc is configured, it is called to immediately persist the rotated token.
func (m *Manager) EnsureValidToken(ctx context.Context, keyEntry *types.KeyEntry, endpoint string) error {
	if keyEntry == nil || keyEntry.OAuthMeta == nil {
		return nil
	}

	now := time.Now().Unix()
	// If expires in > 1 hour (3600s), token is still fresh
	if keyEntry.OAuthMeta.ExpiresAt > now+3600 {
		return nil
	}

	if keyEntry.OAuthMeta.RefreshToken == "" {
		return errors.New("oauth: token expiring and no refresh_token present")
	}

	if endpoint == "" {
		if keyEntry.OAuthMeta.Provider == "minimax" || strings.Contains(strings.ToLower(keyEntry.OAuthMeta.Provider), "minimax") {
			endpoint = "https://api.minimax.chat/oauth/token"
		} else {
			return errors.New("oauth: empty token endpoint")
		}
	}

	// Lock per key to prevent thundering-herd concurrent refreshes on the same account
	keyTag := keyEntry.Label
	if keyTag == "" {
		keyTag = keyEntry.ID
	}
	if keyTag == "" {
		keyTag = keyEntry.Key
	}

	m.mu.Lock()
	lk, ok := m.tokenLocks[keyTag]
	if !ok {
		lk = &sync.Mutex{}
		m.tokenLocks[keyTag] = lk
	}
	m.mu.Unlock()

	lk.Lock()
	defer lk.Unlock()

	// Double-check expiry after acquiring per-key lock
	now = time.Now().Unix()
	if keyEntry.OAuthMeta.ExpiresAt > now+3600 {
		return nil
	}

	tok, err := m.RefreshToken(ctx, endpoint, keyEntry.OAuthMeta.ClientID, keyEntry.OAuthMeta.RefreshToken)
	if err != nil {
		return err
	}

	keyEntry.Key = tok.AccessToken
	if tok.RefreshToken != "" {
		keyEntry.OAuthMeta.RefreshToken = tok.RefreshToken
	}
	if tok.ExpiresIn > 0 {
		keyEntry.OAuthMeta.ExpiresAt = time.Now().Unix() + tok.ExpiresIn
	}

	// Invoke atomic persistence callback if configured
	m.mu.Lock()
	persist := m.persistFn
	m.mu.Unlock()

	if persist != nil {
		if err := persist(ctx, keyEntry); err != nil {
			return fmt.Errorf("oauth: persist refreshed token: %w", err)
		}
	}

	return nil
}
