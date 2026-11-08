// Package oauth implements RFC 8628 OAuth 2.0 Device Authorization Flow + PKCE
// and token refresh lifecycle for subscription providers like MiniMax Code Plan.
package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

var (
	ErrDevicePending       = errors.New("oauth: authorization pending, user has not completed verification")
	ErrDeviceExpired       = errors.New("oauth: device code expired")
	ErrTokenRefreshFailed  = errors.New("oauth: failed to refresh oauth token")
	ErrInvalidOAuthResponse = errors.New("oauth: invalid oauth response from server")
)

// DeviceSession holds the active RFC 8628 session for user verification.
type DeviceSession struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
	CreatedAt       int64  `json:"created_at"`
}

// TokenResult holds the token response.
type TokenResult struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int64  `json:"expires_in"`
	TokenType    string `json:"token_type"`
}

// Manager coordinates OAuth device flow and automatic token renewals.
type Manager struct {
	mu         sync.Mutex
	client     *http.Client
	sessions   map[string]*DeviceSession
	tokenLocks map[string]*sync.Mutex
}

// NewManager creates an OAuth Manager.
func NewManager(allowPrivate bool) *Manager {
	return &Manager{
		client:     upstream.DefaultClient(15*time.Second, allowPrivate),
		sessions:   make(map[string]*DeviceSession),
		tokenLocks: make(map[string]*sync.Mutex),
	}
}

// StartDeviceFlow initiates RFC 8628 device authorization.
func (m *Manager) StartDeviceFlow(ctx context.Context, endpoint, clientID, scope string) (*DeviceSession, error) {
	data := url.Values{}
	data.Set("client_id", clientID)
	if scope != "" {
		data.Set("scope", scope)
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

	var session DeviceSession
	if err := json.NewDecoder(resp.Body).Decode(&session); err != nil {
		return nil, ErrInvalidOAuthResponse
	}
	session.CreatedAt = time.Now().Unix()
	if session.Interval <= 0 {
		session.Interval = 5
	}

	m.mu.Lock()
	m.sessions[session.DeviceCode] = &session
	m.mu.Unlock()

	return &session, nil
}

// PollToken polls the token endpoint for device code authorization.
func (m *Manager) PollToken(ctx context.Context, endpoint, clientID, deviceCode string) (*TokenResult, error) {
	data := url.Values{}
	data.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	data.Set("client_id", clientID)
	data.Set("device_code", deviceCode)

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

	var tok TokenResult
	if err := json.Unmarshal(body, &tok); err != nil {
		return nil, ErrInvalidOAuthResponse
	}

	m.mu.Lock()
	delete(m.sessions, deviceCode)
	m.mu.Unlock()

	return &tok, nil
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

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("oauth: refresh HTTP %d: %s", resp.StatusCode, string(b))
	}

	var tok TokenResult
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return nil, ErrInvalidOAuthResponse
	}

	return &tok, nil
}

// EnsureValidToken checks if key entry's token is close to expiry (within 1 hour) and refreshes if needed.
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

	return nil
}
