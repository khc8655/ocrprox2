// Package admin provides administrative HTTP API handlers for Full mode:
// configuration management with CAS 409, embedded web console, usage queries, traces,
// cooldown diagnostics, key verification, model probing, and on-demand vault fetch.
package admin

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/modelcatalog"
	"github.com/khc8655/llmproxy2/internal/oauth"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

//go:embed assets/index.html
var embeddedIndexHTML []byte

//go:embed assets/THIRD_PARTY_NOTICES
var embeddedThirdPartyNotices []byte

// ThirdPartyNotices returns the embedded open source licenses.
func ThirdPartyNotices() []byte {
	return embeddedThirdPartyNotices
}

// RouteRegistrar allows route registration onto either *http.ServeMux or *router.RouteMux.
type RouteRegistrar interface {
	HandleFunc(pattern string, handler http.HandlerFunc)
}

// Server coordinates admin management endpoints.
type Server struct {
	authMgr    *auth.Authenticator
	localSrc   *config.LocalSource
	obsSink    types.ObservabilitySink
	scheduler  *scheduler.Scheduler
	oauthMgr   *oauth.Manager
	httpClient *http.Client
	// httpClientInjected is true when SetHTTPClient injected a caller-owned
	// client (tests). Probe endpoints then use it verbatim; otherwise they get
	// their own client with their own timeout budget (see probeClient).
	httpClientInjected bool
	allowPrivate       bool
	adminPassword      string
	buildVersion       string
	buildSemver        string
	buildCommit        string
	updateAPIBase      string
	defaultVault       *types.VaultClientConfig
	defaultClientKey   string
	// catalogStore backs the node-local model catalog endpoints. nil on nodes
	// that never set it (all lite nodes, and tests that do not exercise it).
	catalogStore *modelcatalog.Store
}

// NewServer creates a new admin Server.
func NewServer(
	authMgr *auth.Authenticator,
	localSrc *config.LocalSource,
	obsSink types.ObservabilitySink,
	sched *scheduler.Scheduler,
) *Server {
	return &Server{
		authMgr:       authMgr,
		localSrc:      localSrc,
		obsSink:       obsSink,
		scheduler:     sched,
		allowPrivate:  false,
		httpClient:    upstream.DefaultClient(15*time.Second, false),
		adminPassword: os.Getenv("ADMIN_PASSWORD"),
	}
}

// SetAllowPrivate configures whether outbound admin/probe/update HTTP requests allow private/loopback IPs.
func (s *Server) SetAllowPrivate(allow bool) {
	s.allowPrivate = allow
	s.httpClient = upstream.DefaultClient(15*time.Second, allow)
	s.httpClientInjected = false
}

func (s *Server) outboundClient(timeout time.Duration) *http.Client {
	if s.httpClient != nil {
		return s.httpClient
	}
	return upstream.DefaultClient(timeout, s.allowPrivate)
}

// SetAdminPassword sets the admin password explicitly for session cookie verification.
func (s *Server) SetAdminPassword(pass string) {
	s.adminPassword = pass
}

// SetOAuthManager connects the OAuth manager to the admin server.
func (s *Server) SetOAuthManager(om *oauth.Manager) {
	s.oauthMgr = om
}

// SetDefaultVault configures fallback Hub URL and NodeToken supplied via CLI/env for Full mode.
func (s *Server) SetDefaultVault(hubURL, nodeToken string) {
	hubURL = strings.TrimSpace(hubURL)
	nodeToken = strings.TrimSpace(nodeToken)
	if hubURL == "" && nodeToken == "" {
		s.defaultVault = nil
		return
	}
	s.defaultVault = &types.VaultClientConfig{
		URL:       hubURL,
		NodeToken: nodeToken,
	}
}

// SetDefaultClientKey configures fallback client API key supplied via CLI/env for Full mode UI display.
func (s *Server) SetDefaultClientKey(clientKey string) {
	s.defaultClientKey = strings.TrimSpace(clientKey)
}

func (s *Server) effectiveVault(cfgVault *types.VaultClientConfig) *types.VaultClientConfig {
	var url, tok string
	if cfgVault != nil {
		url = strings.TrimSpace(cfgVault.URL)
		tok = strings.TrimSpace(cfgVault.NodeToken)
		if config.IsMaskedSecret(tok) {
			tok = ""
		}
	}
	if s.defaultVault != nil {
		if url == "" {
			url = s.defaultVault.URL
			if tok == "" {
				tok = s.defaultVault.NodeToken
			}
		} else if tok == "" && s.defaultVault.URL != "" &&
			strings.TrimRight(url, "/") == strings.TrimRight(s.defaultVault.URL, "/") {
			tok = s.defaultVault.NodeToken
		}
	}
	if url == "" && tok == "" {
		return nil
	}
	return &types.VaultClientConfig{URL: url, NodeToken: tok}
}

func (s *Server) resolveVaultCredentials(snap *types.RuntimeSnapshot, explicitURL, explicitToken string) (string, string) {
	hubURL := strings.TrimSpace(explicitURL)
	nodeToken := strings.TrimSpace(explicitToken)
	if config.IsMaskedSecret(nodeToken) {
		nodeToken = ""
	}
	var cfgVault *types.VaultClientConfig
	if snap != nil && snap.Config != nil {
		cfgVault = snap.Config.Vault
	}
	eff := s.effectiveVault(cfgVault)
	if eff != nil {
		if hubURL == "" {
			hubURL = eff.URL
			if nodeToken == "" {
				nodeToken = eff.NodeToken
			}
		} else if nodeToken == "" && eff.URL != "" &&
			strings.TrimRight(hubURL, "/") == strings.TrimRight(eff.URL, "/") {
			nodeToken = eff.NodeToken
		}
	}
	return hubURL, nodeToken
}

// SetBuildInfo sets the running binary's version, semver, and commit metadata.
func (s *Server) SetBuildInfo(version, semver, commit string) {
	s.buildVersion = version
	s.buildSemver = semver
	s.buildCommit = commit
}

// SetHTTPClient overrides the internal HTTP client (useful for unit testing).
func (s *Server) SetHTTPClient(client *http.Client) {
	s.httpClient = client
	s.httpClientInjected = true
}

// RegisterRoutes registers admin API and web console routes onto either *router.RouteMux or *http.ServeMux.
func (s *Server) RegisterRoutes(r any) {
	var register func(pattern string, h http.HandlerFunc)
	switch m := r.(type) {
	case RouteRegistrar:
		register = m.HandleFunc
	case *http.ServeMux:
		register = func(pattern string, h http.HandlerFunc) {
			m.HandleFunc(pattern, h)
		}
	default:
		panic(fmt.Sprintf("admin: unsupported router type %T", r))
	}

	register("GET /", s.handleIndexHTML)
	register("GET /admin", s.handleIndexHTML)
	register("GET /admin/", s.handleIndexHTML)
	register("GET /api/config", s.handleConfig)
	register("POST /api/config", s.handleConfig)
	register("PUT /api/config", s.handleConfig)
	register("GET /api/admin/config", s.handleConfig)
	register("POST /api/admin/config", s.handleConfig)
	register("PUT /api/admin/config", s.handleConfig)
	register("GET /api/admin/config/export", s.handleConfigExport)
	register("POST /api/admin/config/import", s.handleConfigImport)
	register("POST /api/admin/test-candidate", s.handleTestCandidate)
	register("POST /api/admin/test-agent-model", s.handleTestAgentModel)
	register("GET /api/admin/usage", s.handleUsage)
	register("GET /api/admin/traces", s.handleTraces)
	register("DELETE /api/admin/traces", s.handleTraces)
	register("GET /api/admin/recent-requests", s.handleRecentRequests)
	register("GET /api/admin/cooldowns", s.handleCooldowns)
	register("DELETE /api/admin/cooldowns", s.handleCooldowns)
	register("GET /api/lanes", s.handleLanes)
	register("GET /api/admin/lanes", s.handleLanes)
	register("POST /api/admin/verify-key", s.handleVerifyKey)
	register("POST /api/admin/test-key", s.handleTestKey)
	register("POST /api/admin/probe-models", s.handleProbeModels)
	register("GET /api/admin/model-catalog", s.handleModelCatalog)
	register("POST /api/admin/model-catalog/sync", s.handleModelCatalogSync)
	register("POST /api/admin/model-catalog/lookup", s.handleModelCatalogLookup)
	register("GET /api/vault/manifest", s.handleVaultManifest)
	register("POST /api/vault/manifest", s.handleVaultManifest)
	register("POST /api/vault/fetch", s.handleVaultFetch)
	register("GET /api/admin/providers/preset-status", s.handleProvidersPresetStatus)
	register("POST /api/admin/providers/sync", s.handleProvidersSync)
	register("POST /api/admin/oauth/start", s.handleOAuthStart)
	register("GET /api/admin/oauth/poll", s.handleOAuthPoll)
	register("POST /api/admin/oauth/poll", s.handleOAuthPoll)
	register("POST /api/admin/detect-provider", s.handleDetectProvider)
	register("POST /api/admin/test-provider", s.handleTestProvider)
	register("GET /api/admin/presets-extra", s.handlePresetsExtra)
	register("GET /api/admin/access-info", s.handleAccessInfo)
	register("POST /api/admin/access-key", s.handleAccessKey)
	register("POST /api/admin/client-key", s.handleAccessKey)
	register("POST /api/admin/auth/login", s.handleAuthLogin)
	register("POST /api/admin/auth/logout", s.handleAuthLogout)
	register("GET /api/admin/system/version", s.handleSystemVersion)
	register("GET /api/admin/system/check-update", s.handleSystemCheckUpdate)
	register("POST /api/admin/system/upgrade", s.handleSystemUpgrade)
	register("POST /api/admin/restart", s.handleSystemRestart)
}

func (s *Server) checkAuth(w http.ResponseWriter, r *http.Request) bool {
	// Sample the lockout state BEFORE authenticating: callers already inside the
	// anti-bruteforce lockout receive 429 + Retry-After immediately (even if they
	// present a cookie); the attempt that trips the 5th failure still gets 401.
	if s.adminIPBlocked(r) {
		s.writeAuthFailure(w, r, true)
		return false
	}
	if !s.isAdminAuthorized(r) {
		s.writeAuthFailure(w, r, false)
		return false
	}
	return true
}

func (s *Server) adminIPBlocked(r *http.Request) bool {
	return s.authMgr != nil && s.authMgr.BlockRemaining(auth.GetClientIP(r)) > 0
}

// writeAuthFailure emits 429 + Retry-After for callers already inside the
// anti-bruteforce lockout, and 401 otherwise. Distinguishing the two lets the
// console tell "wrong password" apart from "temporarily locked out".
func (s *Server) writeAuthFailure(w http.ResponseWriter, r *http.Request, blocked bool) {
	w.Header().Set("Content-Type", "application/json")
	if blocked && s.authMgr != nil {
		if remaining := s.authMgr.BlockRemaining(auth.GetClientIP(r)); remaining > 0 {
			secs := int(remaining.Seconds())
			if secs < 1 {
				secs = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": false,
				"error": map[string]any{
					"message":         "too many failed admin attempts, retry later",
					"type":            "rate_limit_error",
					"retry_after_sec": secs,
				},
			})
			return
		}
	}
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": false,
		"error": map[string]any{
			"message": "unauthorized admin credentials",
			"type":    "auth_error",
		},
	})
}

func loadAdminHTML() []byte {
	if diskData, err := os.ReadFile("shared/admin/dist/index.html"); err == nil && len(diskData) > 0 {
		return injectHostKind(diskData)
	}
	return injectHostKind(embeddedIndexHTML)
}

func injectHostKind(data []byte) []byte {
	s := string(data)
	if strings.Contains(s, `window.__HOST_KIND__="full"`) || strings.Contains(s, `window.__HOST_KIND__ = "full"`) {
		return data
	}
	const injection = `<script>window.__HOST_KIND__="full";</script>`
	if idx := strings.Index(s, "<head>"); idx != -1 {
		res := s[:idx+6] + injection + s[idx+6:]
		return []byte(res)
	}
	return append([]byte(injection), data...)
}

func (s *Server) handleIndexHTML(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/admin" && r.URL.Path != "/admin/" {
		http.NotFound(w, r)
		return
	}
	html := loadAdminHTML()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(html)
}

func (s *Server) maskedEffectiveVault(cfgVault *types.VaultClientConfig) *types.VaultClientConfig {
	dv := s.effectiveVault(cfgVault)
	if dv == nil {
		return nil
	}
	out := *dv
	if out.NodeToken != "" {
		out.NodeToken = maskSecret(out.NodeToken)
	}
	return &out
}

func validateAndNormalizeSettings(st *types.RuntimeSettings) error {
	if st == nil {
		return nil
	}
	if st.CooldownRateLimitSec < 0 ||
		st.CooldownServerErrorSec < 0 ||
		st.CooldownNetworkErrorSec < 0 ||
		st.CooldownAuthErrorSec < 0 {
		return errors.New("cooldown settings must be >= 0")
	}
	if st.AgentFirstByteTimeoutSec < 0 || (st.AgentFirstByteTimeoutSec > 0 && (st.AgentFirstByteTimeoutSec < 5 || st.AgentFirstByteTimeoutSec > 600)) {
		return errors.New("agent_first_byte_timeout_sec must be between 5 and 600")
	}
	if st.OCRMaxInflight < 0 || st.OCRMaxInflight > 64 {
		return errors.New("ocr_max_inflight must be between 1 and 64")
	}
	if st.KBGlobalMaxConcurrency < 0 || st.KBGlobalMaxConcurrency > 256 {
		return errors.New("kb_global_max_concurrency must be between 1 and 256")
	}

	if st.AgentRoutingStrategy == "" {
		st.AgentRoutingStrategy = "sticky_failover"
	}
	if st.AgentFirstByteTimeoutSec == 0 {
		st.AgentFirstByteTimeoutSec = 120
	}
	if st.OCRMaxInflight == 0 {
		st.OCRMaxInflight = 4
	}
	if st.KBGlobalMaxConcurrency == 0 {
		st.KBGlobalMaxConcurrency = 16
	}
	return nil
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		snap, err := s.localSrc.Current(r.Context(), false)
		if err != nil || snap == nil || snap.Config == nil {
			var vaultVal any = map[string]any{}
			if dv := s.maskedEffectiveVault(nil); dv != nil {
				vaultVal = dv
			}
			defSettings := config.DefaultRuntimeSettings()
			if s.defaultClientKey != "" {
				defSettings.ClientKey = s.defaultClientKey
			}
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":           true,
				"_version":     0,
				"providers":    map[string]any{},
				"agent_models": map[string]any{},
				"kb_models":    map[string]any{},
				"settings":     defSettings,
				"vault":        vaultVal,
			})
			return
		}

		masked := maskConfigSecrets(snap.Config)
		if masked.Settings.ClientKey == "" && masked.Settings.ProxyAPIKey == "" && s.defaultClientKey != "" {
			masked.Settings.ClientKey = s.defaultClientKey
		}
		if dv := s.maskedEffectiveVault(snap.Config.Vault); dv != nil {
			masked.Vault = dv
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":           true,
			"_version":     masked.Version,
			"providers":    masked.Providers,
			"agent_models": masked.AgentModels,
			"kb_models":    masked.KBModels,
			"settings":     masked.Settings,
			"vault":        masked.Vault,
		})

	case http.MethodPost, http.MethodPut:
		var newCfg types.ProxyConfig
		if err := json.NewDecoder(r.Body).Decode(&newCfg); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": false,
				"error": map[string]any{
					"message": "invalid JSON configuration",
					"type":    "invalid_request_error",
				},
			})
			return
		}

		if err := validateAndNormalizeSettings(&newCfg.Settings); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": false,
				"error": map[string]any{
					"message": err.Error(),
					"type":    "invalid_request_error",
				},
			})
			return
		}

		savedSnap, err := s.localSrc.SaveConfig(&newCfg)
		if err != nil {
			var vce *config.VersionConflictError
			if errors.As(err, &vce) {
				w.WriteHeader(http.StatusConflict) // 409
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ok":                false,
					"error":             "config_version_conflict",
					"current_version":   vce.CurrentVersion,
					"submitted_version": vce.SubmittedVersion,
				})
				return
			}
			// 约定 C：本地 Key 与中枢 Key 同标签 → 400 key_label_conflict（带标签名，
			// 控制台据此提示改标签）。这条在写盘前从 enforceVaultLock 抛出，配置未被改动。
			var klc *config.KeyLabelConflictError
			if errors.As(err, &klc) {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ok":    false,
					"error": "key_label_conflict",
					"label": klc.Label,
				})
				return
			}

			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": false,
				"error": map[string]any{
					"message": err.Error(),
					"type":    "internal_error",
				},
			})
			return
		}

		w.WriteHeader(http.StatusOK)
		masked := maskConfigSecrets(savedSnap.Config)
		if dv := s.maskedEffectiveVault(savedSnap.Config.Vault); dv != nil {
			masked.Vault = dv
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":           true,
			"_version":     masked.Version,
			"providers":    masked.Providers,
			"agent_models": masked.AgentModels,
			"kb_models":    masked.KBModels,
			"settings":     masked.Settings,
			"vault":        masked.Vault,
		})

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleConfigExport(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	snap, err := s.localSrc.Current(r.Context(), false)
	nowStr := time.Now().Format("20060102_150405")
	filename := fmt.Sprintf("llmproxy_config_%s.json", nowStr)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.WriteHeader(http.StatusOK)

	if err != nil || snap == nil || snap.Config == nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":           true,
			"_version":     0,
			"_exported_at": time.Now().Format("2006-01-02 15:04:05"),
			"providers":    map[string]any{},
			"agent_models": map[string]any{},
			"kb_models":    map[string]any{},
			"settings":     map[string]any{},
		})
		return
	}

	// Deep copy and strip all Vault-originated providers/keys, Vault route candidates, and Vault.NodeToken (SEC-06 / local-only export rule).
	raw, _ := json.Marshal(snap.Config)
	var copyCfg types.ProxyConfig
	_ = json.Unmarshal(raw, &copyCfg)

	vaultProvIDs := make(map[string]bool)
	localProviders := make(map[string]*types.ProviderConfig)
	for pID, p := range copyCfg.Providers {
		if p == nil {
			continue
		}
		if p.Origin == "vault" {
			vaultProvIDs[pID] = true
			continue
		}
		localKeys := make([]*types.KeyEntry, 0, len(p.APIKeys))
		for _, k := range p.APIKeys {
			if k == nil || k.Origin == "vault" {
				continue
			}
			localKeys = append(localKeys, k)
		}
		p.APIKeys = localKeys
		localProviders[pID] = p
	}

	localAgentModels := make(map[string]*types.AgentModelRoute)
	for mID, route := range copyCfg.AgentModels {
		if route == nil {
			continue
		}
		keptCands := make([]*types.RouteCandidate, 0, len(route.Candidates))
		for _, c := range route.Candidates {
			if c == nil || vaultProvIDs[c.Provider] {
				continue
			}
			keptCands = append(keptCands, c)
		}
		if route.Origin == "vault" && len(keptCands) == 0 {
			continue
		}
		if route.Origin == "vault" {
			route.Origin = "local"
		}
		route.Candidates = keptCands
		localAgentModels[mID] = route
	}

	localKBModels := make(map[string][]*types.KBCandidate)
	for cat, list := range copyCfg.KBModels {
		var kept []*types.KBCandidate
		for _, c := range list {
			if c == nil || vaultProvIDs[c.Provider] {
				continue
			}
			kept = append(kept, c)
		}
		if len(kept) > 0 {
			localKBModels[cat] = kept
		}
	}

	exportData := map[string]any{
		"ok":           true,
		"_version":     copyCfg.Version,
		"_exported_at": time.Now().Format("2006-01-02 15:04:05"),
		"providers":    localProviders,
		"agent_models": localAgentModels,
		"kb_models":    localKBModels,
		"settings":     copyCfg.Settings,
	}
	if copyCfg.Vault != nil {
		exportData["vault"] = map[string]string{
			"url": copyCfg.Vault.URL,
		}
	}

	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(exportData)
}

func (s *Server) handleConfigImport(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	// 2MB payload limit
	if r.ContentLength > 2*1024*1024 {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "import payload too large (max 2MB)",
		})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)

	var rawBody map[string]any
	if err := json.NewDecoder(r.Body).Decode(&rawBody); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "invalid JSON payload",
		})
		return
	}

	mode, _ := rawBody["mode"].(string)
	if mode == "" {
		mode = "merge"
	}
	if mode != "merge" && mode != "overwrite" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "invalid mode: must be 'merge' or 'overwrite'",
		})
		return
	}

	configRaw := rawBody
	if subCfg, ok := rawBody["config"].(map[string]any); ok && subCfg != nil {
		configRaw = subCfg
	}
	normalizeImportedConfig(configRaw)

	cfgBytes, err := json.Marshal(configRaw)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "failed to encode config payload",
		})
		return
	}

	var incoming types.ProxyConfig
	if err := json.Unmarshal(cfgBytes, &incoming); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "invalid configuration structure: " + err.Error(),
		})
		return
	}

	if incoming.Providers == nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "invalid configuration: providers must be an object",
		})
		return
	}

	currentSnap, _ := s.localSrc.Current(r.Context(), false)
	var currentCfg *types.ProxyConfig
	if currentSnap != nil {
		currentCfg = currentSnap.Config
	}

	var targetCfg types.ProxyConfig
	if mode == "overwrite" || currentCfg == nil {
		targetCfg = incoming
		if currentCfg != nil {
			targetCfg.Version = currentCfg.Version
		}
	} else {
		curBytes, _ := json.Marshal(currentCfg)
		_ = json.Unmarshal(curBytes, &targetCfg)

		if targetCfg.Providers == nil {
			targetCfg.Providers = make(map[string]*types.ProviderConfig)
		}
		for pID, inP := range incoming.Providers {
			if inP == nil {
				continue
			}
			exP, exists := targetCfg.Providers[pID]
			if !exists {
				targetCfg.Providers[pID] = inP
				continue
			}
			if inP.BaseURL != "" {
				exP.BaseURL = inP.BaseURL
			}
			if inP.AnthropicBaseURL != "" {
				exP.AnthropicBaseURL = inP.AnthropicBaseURL
			}
			if inP.PresetID != "" {
				exP.PresetID = inP.PresetID
			}
			if inP.Name != "" {
				exP.Name = inP.Name
			}
			if inP.RPMPerKey > 0 {
				exP.RPMPerKey = inP.RPMPerKey
			}
			if inP.HideClientName {
				exP.HideClientName = true
			}
			if inP.AdapterRules != nil {
				exP.AdapterRules = inP.AdapterRules
			}
			if inP.ModelAliases != nil {
				if exP.ModelAliases == nil {
					exP.ModelAliases = make(map[string]string)
				}
				for k, v := range inP.ModelAliases {
					exP.ModelAliases[k] = v
				}
			}
			for _, inK := range inP.APIKeys {
				if inK == nil {
					continue
				}
				found := false
				for i, exK := range exP.APIKeys {
					if (inK.ID != "" && exK.ID == inK.ID) || (inK.Label != "" && exK.Label == inK.Label) {
						found = true
						if !config.IsMaskedSecret(inK.Key) && inK.Key != "" {
							exP.APIKeys[i].Key = inK.Key
						}
						exP.APIKeys[i].Enabled = inK.Enabled
						if inK.Remark != "" {
							exP.APIKeys[i].Remark = inK.Remark
						}
						break
					}
				}
				if !found {
					exP.APIKeys = append(exP.APIKeys, inK)
				}
			}
		}

		if incoming.AgentModels != nil {
			if targetCfg.AgentModels == nil {
				targetCfg.AgentModels = make(map[string]*types.AgentModelRoute)
			}
			for mName, inM := range incoming.AgentModels {
				if inM == nil {
					continue
				}
				exM, exists := targetCfg.AgentModels[mName]
				if !exists {
					targetCfg.AgentModels[mName] = inM
					continue
				}
				if inM.RoutingStrategy != "" {
					exM.RoutingStrategy = inM.RoutingStrategy
				}
				if inM.ActiveKey != "" {
					exM.ActiveKey = inM.ActiveKey
				}
				for _, inC := range inM.Candidates {
					if inC == nil {
						continue
					}
					cExists := false
					for _, exC := range exM.Candidates {
						if exC != nil && exC.Provider == inC.Provider && exC.KeyLabel == inC.KeyLabel && exC.TargetModel == inC.TargetModel {
							cExists = true
							break
						}
					}
					if !cExists {
						exM.Candidates = append(exM.Candidates, inC)
					}
				}
			}
		}

		if incoming.KBModels != nil {
			if targetCfg.KBModels == nil {
				targetCfg.KBModels = make(map[string][]*types.KBCandidate)
			}
			for cat, inList := range incoming.KBModels {
				for _, inC := range inList {
					if inC == nil {
						continue
					}
					cExists := false
					for _, exC := range targetCfg.KBModels[cat] {
						if exC != nil && exC.Provider == inC.Provider && exC.Model == inC.Model && exC.KeyLabel == inC.KeyLabel {
							cExists = true
							break
						}
					}
					if !cExists {
						targetCfg.KBModels[cat] = append(targetCfg.KBModels[cat], inC)
					}
				}
			}
		}

		if incoming.Settings.AgentRoutingStrategy != "" {
			targetCfg.Settings.AgentRoutingStrategy = incoming.Settings.AgentRoutingStrategy
		}
		if incoming.Settings.AgentFirstByteTimeoutSec > 0 {
			targetCfg.Settings.AgentFirstByteTimeoutSec = incoming.Settings.AgentFirstByteTimeoutSec
		}
		if incoming.Settings.CooldownRateLimitSec > 0 {
			targetCfg.Settings.CooldownRateLimitSec = incoming.Settings.CooldownRateLimitSec
		}
		if incoming.Settings.CooldownServerErrorSec > 0 {
			targetCfg.Settings.CooldownServerErrorSec = incoming.Settings.CooldownServerErrorSec
		}
		if incoming.Settings.CooldownNetworkErrorSec > 0 {
			targetCfg.Settings.CooldownNetworkErrorSec = incoming.Settings.CooldownNetworkErrorSec
		}
		if incoming.Settings.CooldownAuthErrorSec > 0 {
			targetCfg.Settings.CooldownAuthErrorSec = incoming.Settings.CooldownAuthErrorSec
		}
		if incoming.Settings.ClientKey != "" {
			targetCfg.Settings.ClientKey = incoming.Settings.ClientKey
		}
		if incoming.Settings.ProxyAPIKey != "" {
			targetCfg.Settings.ProxyAPIKey = incoming.Settings.ProxyAPIKey
		}
		targetCfg.Version = currentCfg.Version
	}

	savedSnap, err := s.localSrc.SaveConfig(&targetCfg)
	if err != nil {
		var vce *config.VersionConflictError
		if errors.As(err, &vce) {
			w.WriteHeader(http.StatusConflict) // 409
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":                false,
				"error":             "config_version_conflict",
				"current_version":   vce.CurrentVersion,
				"submitted_version": vce.SubmittedVersion,
			})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": err.Error(),
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":       true,
		"success":  true,
		"mode":     mode,
		"message":  "配置导入成功",
		"_version": savedSnap.Config.Version,
	})
}

func (s *Server) handleTestCandidate(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		Provider   string `json:"provider"`
		Key        string `json:"key"`
		KeyLabel   string `json:"key_label"`
		Type       string `json:"type"` // "chat" | "ocr" | "embedding" | "reranker"
		Model      string `json:"model"`
		ModelName  string `json:"model_name"`
		Category   string `json:"category"`
		AgentModel string `json:"agent_model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "invalid JSON",
		})
		return
	}

	providerName := strings.TrimSpace(req.Provider)
	keyLabel := strings.TrimSpace(req.Key)
	if keyLabel == "" {
		keyLabel = strings.TrimSpace(req.KeyLabel)
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = strings.TrimSpace(req.ModelName)
	}
	if model == "" {
		model = strings.TrimSpace(req.AgentModel)
	}
	candType := strings.ToLower(strings.TrimSpace(req.Type))
	if candType == "" {
		candType = strings.ToLower(strings.TrimSpace(req.Category))
	}
	if candType == "" {
		candType = "chat"
	}

	if providerName == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "missing provider",
		})
		return
	}

	snap, _ := s.localSrc.Current(r.Context(), false)
	if snap == nil || snap.Config == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "config unavailable",
		})
		return
	}

	prov, exists := snap.Config.Providers[providerName]
	if !exists || prov == nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": fmt.Sprintf("provider '%s' not found", providerName),
		})
		return
	}

	var apiKey string
	resolvedKeyLabel := keyLabel
	if keyLabel != "" {
		for _, k := range prov.APIKeys {
			if k != nil && (k.Label == keyLabel || k.ID == keyLabel || k.Key == keyLabel) {
				apiKey = k.Key
				if k.Label != "" {
					resolvedKeyLabel = k.Label
				} else if k.ID != "" {
					resolvedKeyLabel = k.ID
				}
				break
			}
		}
		if apiKey == "" && !config.IsMaskedSecret(keyLabel) && len(keyLabel) > 5 {
			apiKey = keyLabel
		}
	} else {
		// P0-06: key_label == "" ("留空=全部启用Key") -> automatically pick first enabled non-empty key
		for _, k := range prov.APIKeys {
			if k != nil && k.Enabled && k.Key != "" && !config.IsMaskedSecret(k.Key) {
				apiKey = k.Key
				if k.Label != "" {
					resolvedKeyLabel = k.Label
				} else {
					resolvedKeyLabel = k.ID
				}
				break
			}
		}
		if apiKey == "" {
			for _, k := range prov.APIKeys {
				if k != nil && k.Key != "" && !config.IsMaskedSecret(k.Key) {
					apiKey = k.Key
					if k.Label != "" {
						resolvedKeyLabel = k.Label
					} else {
						resolvedKeyLabel = k.ID
					}
					break
				}
			}
		}
	}

	if apiKey == "" || config.IsMaskedSecret(apiKey) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": fmt.Sprintf("key '%s' not found or secret is masked", keyLabel),
		})
		return
	}

	// P0-06: If model is empty on a KB candidate, resolve from configured KBModels, provider aliases, or candType
	if model == "" {
		for _, kbCand := range snap.Config.KBModels[candType] {
			if kbCand != nil && kbCand.Provider == providerName && strings.TrimSpace(kbCand.Model) != "" {
				model = strings.TrimSpace(kbCand.Model)
				break
			}
		}
	}
	if model == "" && len(prov.ModelAliases) > 0 {
		aliasKeys := make([]string, 0, len(prov.ModelAliases))
		for k := range prov.ModelAliases {
			aliasKeys = append(aliasKeys, k)
		}
		sort.Strings(aliasKeys)
		for _, k := range aliasKeys {
			if v := strings.TrimSpace(prov.ModelAliases[k]); v != "" {
				model = v
				break
			}
		}
	}
	if model == "" {
		model = candType
	}

	baseURL, probeHeaders, isAnthropic := resolveProbeTargetAndHeaders("", "", apiKey, prov)
	if baseURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "provider base_url is empty",
		})
		return
	}

	var targetURL string
	var reqBodyBytes []byte

	switch candType {
	case "embedding":
		targetURL = upstream.JoinUpstream(baseURL, "embeddings")
		reqBodyBytes, _ = json.Marshal(map[string]any{
			"model": model,
			"input": "test",
		})
	case "reranker":
		targetURL = upstream.JoinUpstream(baseURL, "rerank")
		reqBodyBytes, _ = json.Marshal(map[string]any{
			"model":     model,
			"query":     "test",
			"documents": []string{"a"},
		})
	case "ocr":
		const png1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
		targetURL = upstream.JoinUpstream(baseURL, "chat/completions")
		reqBodyBytes, _ = json.Marshal(map[string]any{
			"model": model,
			"messages": []map[string]any{
				{
					"role": "user",
					"content": []map[string]any{
						{"type": "text", "text": "Extract text"},
						{"type": "image_url", "image_url": map[string]string{"url": png1x1}},
					},
				},
			},
			"max_tokens": 64,
			"stream":     false,
		})
	default: // chat
		if isAnthropic {
			targetURL = upstream.JoinUpstream(baseURL, "messages")
			reqBodyBytes, _ = json.Marshal(map[string]any{
				"model": model,
				"messages": []map[string]any{
					{"role": "user", "content": "你好"},
				},
				"max_tokens": 16,
			})
		} else {
			targetURL = upstream.JoinUpstream(baseURL, "chat/completions")
			reqBodyBytes, _ = json.Marshal(map[string]any{
				"model": model,
				"messages": []map[string]any{
					{"role": "user", "content": "你好"},
				},
				"max_tokens": 16,
				"stream":     false,
			})
		}
	}

	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, targetURL, bytes.NewReader(reqBodyBytes))
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": err.Error(),
		})
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	for hk, hv := range probeHeaders {
		upReq.Header.Set(hk, hv)
	}
	if strings.EqualFold(providerName, "vertex") && probeHeaders["x-goog-api-key"] == "" && prov.AdapterRules == nil {
		upReq.Header.Del("Authorization")
		upReq.Header.Set("x-goog-api-key", apiKey)
	}

	client := s.outboundClient(20 * time.Second)

	start := time.Now()
	resp, err := client.Do(upReq)
	ms := time.Since(start).Milliseconds()

	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         false,
			"success":    false,
			"status":     http.StatusBadGateway,
			"ms":         ms,
			"latency_ms": ms,
			"model":      model,
			"error":      err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	isOK := resp.StatusCode >= 200 && resp.StatusCode < 300

	if isOK && s.scheduler != nil && resolvedKeyLabel != "" {
		s.scheduler.Cooldowns().ClearKey(providerName, resolvedKeyLabel)
	}

	textSnippet := ""
	var parsedResp map[string]any
	if err := json.Unmarshal(respBody, &parsedResp); err == nil {
		if choices, ok := parsedResp["choices"].([]any); ok && len(choices) > 0 {
			if cMap, ok := choices[0].(map[string]any); ok {
				if msg, ok := cMap["message"].(map[string]any); ok {
					if c, ok := msg["content"].(string); ok {
						textSnippet = c
					}
				}
			}
		}
	}
	if textSnippet == "" && len(respBody) > 0 && isOK {
		textSnippet = string(respBody)
		if len(textSnippet) > 100 {
			textSnippet = textSnippet[:100]
		}
	}

	var errMsg string
	if !isOK {
		errMsg = string(respBody)
		if len(errMsg) > 200 {
			errMsg = errMsg[:200]
		}
		if errMsg == "" {
			errMsg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":         isOK,
		"success":    isOK,
		"status":     resp.StatusCode,
		"ms":         ms,
		"latency_ms": ms,
		"model":      model,
		"text":       textSnippet,
		"error":      errMsg,
	})
}

func (s *Server) handleTestAgentModel(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		Model string `json:"model"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "invalid JSON",
		})
		return
	}

	modelName := req.Model
	if modelName == "" {
		modelName = req.Name
	}
	if modelName == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "missing model name",
		})
		return
	}

	snap, _ := s.localSrc.Current(r.Context(), false)
	if snap == nil || snap.Config == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "config unavailable",
		})
		return
	}

	route, ok := snap.Config.AgentModels[modelName]
	if !ok || route == nil {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": fmt.Sprintf("agent model '%s' not found", modelName),
		})
		return
	}

	var candidates []*types.RouteCandidate
	for _, c := range route.Candidates {
		if c != nil && c.Enabled {
			candidates = append(candidates, c)
		}
	}
	if len(candidates) == 0 {
		for _, c := range route.Candidates {
			if c != nil {
				candidates = append(candidates, c)
			}
		}
	}

	type ProbeResult struct {
		Provider  string `json:"provider"`
		Key       string `json:"key"`
		Model     string `json:"model"`
		OK        bool   `json:"ok"`
		Status    int    `json:"status"`
		LatencyMS int64  `json:"latency_ms"`
		Error     string `json:"error,omitempty"`
	}

	results := make([]ProbeResult, len(candidates))
	sem := make(chan struct{}, 5)
	var wg sync.WaitGroup

	for i, c := range candidates {
		wg.Add(1)
		go func(idx int, cand *types.RouteCandidate) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			prov := snap.Config.Providers[cand.Provider]
			if prov == nil {
				results[idx] = ProbeResult{
					Provider: cand.Provider,
					Key:      cand.KeyLabel,
					Model:    modelName,
					OK:       false,
					Error:    "provider not found",
				}
				return
			}

			var apiKey string
			resolvedKey := cand.KeyLabel
			if cand.KeyLabel != "" {
				for _, k := range prov.APIKeys {
					if k != nil && (k.Label == cand.KeyLabel || k.ID == cand.KeyLabel) {
						apiKey = k.Key
						break
					}
				}
			} else {
				// P0-06: cand.KeyLabel == "" ("留空=全部启用Key") -> pick first enabled non-empty key
				for _, k := range prov.APIKeys {
					if k != nil && k.Enabled && k.Key != "" && !config.IsMaskedSecret(k.Key) {
						apiKey = k.Key
						if k.Label != "" {
							resolvedKey = k.Label
						} else {
							resolvedKey = k.ID
						}
						break
					}
				}
				if apiKey == "" {
					for _, k := range prov.APIKeys {
						if k != nil && k.Key != "" && !config.IsMaskedSecret(k.Key) {
							apiKey = k.Key
							if k.Label != "" {
								resolvedKey = k.Label
							} else {
								resolvedKey = k.ID
							}
							break
						}
					}
				}
			}
			if apiKey == "" || config.IsMaskedSecret(apiKey) {
				results[idx] = ProbeResult{
					Provider: cand.Provider,
					Key:      resolvedKey,
					Model:    modelName,
					OK:       false,
					Error:    "api key unresolvable or masked",
				}
				return
			}

			targetModel := cand.TargetModel
			if targetModel == "" {
				targetModel = modelName
			}
			pBaseURL, probeHeaders, isAnthropic := resolveProbeTargetAndHeaders("", "", apiKey, prov)
			var targetURL string
			var testBody []byte
			if isAnthropic {
				targetURL = upstream.JoinUpstream(pBaseURL, "messages")
				testBody, _ = json.Marshal(map[string]any{
					"model": targetModel,
					"messages": []map[string]any{
						{"role": "user", "content": "你好"},
					},
					"max_tokens": 16,
				})
			} else {
				targetURL = upstream.JoinUpstream(pBaseURL, "chat/completions")
				testBody, _ = json.Marshal(map[string]any{
					"model": targetModel,
					"messages": []map[string]any{
						{"role": "user", "content": "你好"},
					},
					"max_tokens": 16,
					"stream":     false,
				})
			}

			upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, targetURL, bytes.NewReader(testBody))
			if err != nil {
				results[idx] = ProbeResult{
					Provider: cand.Provider,
					Key:      resolvedKey,
					Model:    targetModel,
					OK:       false,
					Error:    err.Error(),
				}
				return
			}
			upReq.Header.Set("Content-Type", "application/json")
			for hk, hv := range probeHeaders {
				upReq.Header.Set(hk, hv)
			}
			if strings.EqualFold(cand.Provider, "vertex") && probeHeaders["x-goog-api-key"] == "" && prov.AdapterRules == nil {
				upReq.Header.Del("Authorization")
				upReq.Header.Set("x-goog-api-key", apiKey)
			}

			client := s.outboundClient(15 * time.Second)

			start := time.Now()
			resp, err := client.Do(upReq)
			lat := time.Since(start).Milliseconds()

			if err != nil {
				results[idx] = ProbeResult{
					Provider:  cand.Provider,
					Key:       resolvedKey,
					Model:     targetModel,
					OK:        false,
					LatencyMS: lat,
					Error:     err.Error(),
				}
				return
			}
			defer resp.Body.Close()

			isOK := resp.StatusCode >= 200 && resp.StatusCode < 300
			errStr := ""
			if !isOK {
				errBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				errStr = string(errBytes)
				if len(errStr) > 200 {
					errStr = errStr[:200]
				}
				if errStr == "" {
					errStr = fmt.Sprintf("HTTP %d", resp.StatusCode)
				}
			} else {
				if s.scheduler != nil && resolvedKey != "" {
					s.scheduler.Cooldowns().ClearKey(cand.Provider, resolvedKey)
				}
			}

			results[idx] = ProbeResult{
				Provider:  cand.Provider,
				Key:       resolvedKey,
				Model:     targetModel,
				OK:        isOK,
				Status:    resp.StatusCode,
				LatencyMS: lat,
				Error:     errStr,
			}
		}(i, c)
	}

	wg.Wait()

	okCount := 0
	for _, res := range results {
		if res.OK {
			okCount++
		}
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":         okCount > 0,
		"success":    okCount > 0,
		"model":      modelName,
		"total":      len(results),
		"passed":     okCount,
		"results":    results,
		"checked_at": time.Now().Format("2006-01-02 15:04:05"),
	})
}

func (s *Server) handleLanes(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	type LaneItem struct {
		Lane    string `json:"lane"`
		Name    string `json:"name,omitempty"`
		Busy    int    `json:"busy"`
		Waiting int    `json:"waiting"`
		Limit   int    `json:"limit"`
	}

	var snap map[string]scheduler.Lane
	if s.scheduler != nil {
		snap = s.scheduler.SnapshotLanes()
	} else {
		snap = make(map[string]scheduler.Lane)
	}

	lanes := make([]LaneItem, 0, len(snap))
	for k, v := range snap {
		lanes = append(lanes, LaneItem{
			Lane:    k,
			Name:    k,
			Busy:    v.Busy,
			Waiting: v.Waiting,
			Limit:   v.Limit,
		})
	}
	sort.Slice(lanes, func(i, j int) bool { return lanes[i].Lane < lanes[j].Lane })

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":       true,
		"lanes":    lanes,
		"lane_map": snap,
	})
}

func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	period := r.URL.Query().Get("period")
	if period == "" {
		period = "today"
	}
	tz := r.URL.Query().Get("tz")

	data, err := s.obsSink.QueryUsage(period, tz)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(data)
}

func (s *Server) handleTraces(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodDelete {
		type traceClearer interface {
			ClearTraces()
		}
		if tc, ok := s.obsSink.(traceClearer); ok {
			tc.ClearTraces()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"message": "traces cleared",
		})
		return
	}

	onlyFailed := r.URL.Query().Get("failed") == "1" || r.URL.Query().Get("failed") == "true"
	traces := s.obsSink.RecentTraces(onlyFailed)

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":     true,
		"traces": traces,
	})
}

func (s *Server) handleCooldowns(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodDelete {
		target := r.URL.Query().Get("target")
		if target != "" {
			s.scheduler.Cooldowns().Clear(target)
		} else {
			snap := s.scheduler.Cooldowns().Snapshot()
			if items, ok := snap["cooldowns"].([]scheduler.CooldownEntry); ok {
				for _, item := range items {
					s.scheduler.Cooldowns().Clear(item.Target)
				}
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		return
	}

	snapshot := s.scheduler.Cooldowns().Snapshot()
	_ = json.NewEncoder(w).Encode(snapshot)
}

func matchesStoredProviderBaseURL(reqURL string, p *types.ProviderConfig) bool {
	norm := func(u string) string { return strings.TrimRight(strings.TrimSpace(u), "/") }
	rNorm := norm(reqURL)
	if rNorm == "" {
		return true
	}
	if p == nil {
		return false
	}
	if b := norm(p.BaseURL); b != "" && strings.EqualFold(rNorm, b) {
		return true
	}
	if ab := norm(p.AnthropicBaseURL); ab != "" && strings.EqualFold(rNorm, ab) {
		return true
	}
	return false
}

func resolveProbeTargetAndHeaders(reqBaseURL, reqAPIType, rawKey string, prov *types.ProviderConfig) (string, map[string]string, bool) {
	apiType := strings.ToLower(strings.TrimSpace(reqAPIType))
	if apiType == "" && prov != nil {
		apiType = strings.ToLower(strings.TrimSpace(prov.APIType))
		if apiType == "" && len(prov.Protocols) > 0 {
			hasAnthropic := false
			hasOpenAI := false
			for _, proto := range prov.Protocols {
				pl := strings.ToLower(strings.TrimSpace(proto))
				if pl == "anthropic" || pl == "messages" || pl == "anthropic-messages" {
					hasAnthropic = true
				}
				if pl == "openai" || pl == "chat" || pl == "responses" {
					hasOpenAI = true
				}
			}
			if hasAnthropic && !hasOpenAI {
				apiType = "anthropic"
			}
		}
	}

	explicitAnthropic := apiType == "anthropic" || apiType == "anthropic-messages" || apiType == "messages"
	baseURL := strings.TrimSpace(reqBaseURL)
	if baseURL == "" && prov != nil {
		if (explicitAnthropic || strings.HasPrefix(rawKey, "sk-ant-")) && strings.TrimSpace(prov.AnthropicBaseURL) != "" {
			baseURL = strings.TrimSpace(prov.AnthropicBaseURL)
		} else if strings.TrimSpace(prov.BaseURL) != "" {
			baseURL = strings.TrimSpace(prov.BaseURL)
		} else if strings.TrimSpace(prov.AnthropicBaseURL) != "" {
			baseURL = strings.TrimSpace(prov.AnthropicBaseURL)
		}
	}

lowerURL := strings.ToLower(baseURL)
	// Same-URL vendors must not be mistaken for Anthropic. AMD's preset sets
	// base_url and anthropic_base_url to the identical string, so an equality
	// test alone made every AMD key probe run the /messages path with x-api-key
	// against an OpenAI endpoint (observed 2026-11-27: api_type=openai but the
	// probe reported anthropic-messages). Only treat the match as decisive when
	// the two URLs actually differ.
	anthBase := ""
	if prov != nil {
		anthBase = strings.TrimRight(strings.TrimSpace(prov.AnthropicBaseURL), "/")
	}
	provBase := ""
	if prov != nil {
		provBase = strings.TrimRight(strings.TrimSpace(prov.BaseURL), "/")
	}
	matchesAnthBase := anthBase != "" && !strings.EqualFold(anthBase, provBase) &&
		strings.EqualFold(strings.TrimRight(baseURL, "/"), anthBase)

	isAnthropic := explicitAnthropic || matchesAnthBase || strings.Contains(lowerURL, "anthropic") ||
		(apiType == "" && strings.HasPrefix(rawKey, "sk-ant-"))

	headers := make(map[string]string)
	if isAnthropic {
		headers["x-api-key"] = rawKey
		headers["anthropic-version"] = "2023-06-01"
	} else if prov != nil && prov.AdapterRules != nil && strings.TrimSpace(prov.AdapterRules.AuthHeader) != "" {
		headers[strings.TrimSpace(prov.AdapterRules.AuthHeader)] = prov.AdapterRules.AuthPrefix + rawKey
	} else if strings.Contains(lowerURL, "aiplatform.googleapis.com") {
		headers["x-goog-api-key"] = rawKey
	} else {
		headers["Authorization"] = "Bearer " + rawKey
	}
	return baseURL, headers, isAnthropic
}

func (s *Server) handleVerifyKey(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		Provider string `json:"provider"`
		BaseURL  string `json:"base_url"`
		APIKey   string `json:"api_key"`
		APIType  string `json:"api_type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json"})
		return
	}

	var storedProv *types.ProviderConfig
	snap, _ := s.localSrc.Current(r.Context(), false)
	if snap != nil && snap.Config != nil {
		if p, ok := snap.Config.Providers[req.Provider]; ok && p != nil {
			storedProv = p
			if req.APIKey == "" || config.IsMaskedSecret(req.APIKey) {
				for _, k := range p.APIKeys {
					if k != nil && k.Enabled && k.Key != "" && !config.IsMaskedSecret(k.Key) {
						if k.Origin == "vault" && !matchesStoredProviderBaseURL(req.BaseURL, p) {
							w.WriteHeader(http.StatusForbidden)
							_ = json.NewEncoder(w).Encode(map[string]any{
								"ok":     false,
								"valid":  false,
								"status": http.StatusForbidden,
								"error":  "cannot override base_url when using a vault-managed key",
							})
							return
						}
						req.APIKey = k.Key
						break
					}
				}
			}
		}
	}

	if req.APIKey == "" || config.IsMaskedSecret(req.APIKey) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"valid":  false,
			"status": http.StatusUnauthorized,
			"error":  "api key is empty or unresolvable",
		})
		return
	}

	resolvedBaseURL, probeHeaders, _ := resolveProbeTargetAndHeaders(req.BaseURL, req.APIType, req.APIKey, storedProv)
	if resolvedBaseURL == "" {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"valid":  false,
			"status": http.StatusBadRequest,
			"error":  "base_url is required",
		})
		return
	}

	targetURL := upstream.JoinUpstream(resolvedBaseURL, "models")
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"valid":  false,
			"status": http.StatusInternalServerError,
			"error":  err.Error(),
		})
		return
	}
	for hk, hv := range probeHeaders {
		upReq.Header.Set(hk, hv)
	}

	client := s.outboundClient(15 * time.Second)

	start := time.Now()
	resp, err := client.Do(upReq)
	latency := time.Since(start).Milliseconds()

	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         true,
			"valid":      false,
			"status":     http.StatusBadGateway,
			"latency_ms": latency,
			"error":      err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var body struct {
			Data   []any `json:"data"`
			Models []any `json:"models"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		count := len(body.Data)
		if count == 0 && len(body.Models) > 0 {
			count = len(body.Models)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":           true,
			"valid":        true,
			"status":       resp.StatusCode,
			"latency_ms":   latency,
			"models_count": count,
		})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":         true,
		"valid":      false,
		"status":     resp.StatusCode,
		"latency_ms": latency,
		"error":      fmt.Sprintf("upstream returned %d", resp.StatusCode),
	})
}

func (s *Server) handleProbeModels(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		Provider string `json:"provider"`
		BaseURL  string `json:"base_url"`
		APIKey   string `json:"api_key"`
		APIType  string `json:"api_type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json"})
		return
	}

	var storedProv *types.ProviderConfig
	snap, _ := s.localSrc.Current(r.Context(), false)
	if snap != nil && snap.Config != nil {
		if p, ok := snap.Config.Providers[req.Provider]; ok && p != nil {
			storedProv = p
			if req.APIKey == "" || config.IsMaskedSecret(req.APIKey) {
				for _, k := range p.APIKeys {
					if k != nil && k.Enabled && k.Key != "" && !config.IsMaskedSecret(k.Key) {
						if k.Origin == "vault" && !matchesStoredProviderBaseURL(req.BaseURL, p) {
							w.WriteHeader(http.StatusForbidden)
							_ = json.NewEncoder(w).Encode(map[string]any{
								"ok":    false,
								"error": "cannot override base_url when using a vault-managed key",
							})
							return
						}
						req.APIKey = k.Key
						break
					}
				}
			}
		}
	}

	if req.APIKey == "" || config.IsMaskedSecret(req.APIKey) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "api key is empty or unresolvable"})
		return
	}

	resolvedBaseURL, probeHeaders, _ := resolveProbeTargetAndHeaders(req.BaseURL, req.APIType, req.APIKey, storedProv)
	if resolvedBaseURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "base_url is required"})
		return
	}

	targetURL := upstream.JoinUpstream(resolvedBaseURL, "models")
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	for hk, hv := range probeHeaders {
		upReq.Header.Set(hk, hv)
	}

	client := s.outboundClient(15 * time.Second)

	resp, err := client.Do(upReq)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		w.WriteHeader(resp.StatusCode)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": fmt.Sprintf("upstream returned status %d", resp.StatusCode),
		})
		return
	}

	var raw map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "failed to decode upstream json"})
		return
	}

	models := make([]string, 0)
	if dataArr, ok := raw["data"].([]any); ok {
		for _, item := range dataArr {
			if mObj, ok := item.(map[string]any); ok {
				if id, ok := mObj["id"].(string); ok && id != "" {
					models = append(models, id)
				}
			}
		}
	}
	if len(models) == 0 {
		if modelsArr, ok := raw["models"].([]any); ok {
			for _, item := range modelsArr {
				if mObj, ok := item.(map[string]any); ok {
					if name, ok := mObj["name"].(string); ok && name != "" {
						models = append(models, strings.TrimPrefix(name, "models/"))
					}
				}
			}
		}
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":     true,
		"models": models,
	})
}

func (s *Server) handleVaultManifest(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	// Credentials may arrive as POST JSON body (preferred: keeps NODE_TOKEN out of the
	// query string, where access/CDN logs would retain it) or as GET query params
	// (legacy test-connection shape). This endpoint only proxies manifest METADATA —
	// it never imports anything, so the overrides here are safe.
	hubOverride, tokenOverride := r.URL.Query().Get("hub_url"), r.URL.Query().Get("node_token")
	if r.Method == http.MethodPost {
		var body struct {
			HubURL    string `json:"hub_url"`
			NodeToken string `json:"node_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
			hubOverride, tokenOverride = body.HubURL, body.NodeToken
		}
	}

	snap, _ := s.localSrc.Current(r.Context(), false)
	hubURL, nodeToken := s.resolveVaultCredentials(snap, hubOverride, tokenOverride)

	if hubURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "vault hub url not configured",
		})
		return
	}

	target := strings.TrimRight(hubURL, "/") + "/api/vault/manifest"
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if nodeToken != "" {
		upReq.Header.Set("Authorization", "Bearer "+nodeToken)
	}

	client := s.outboundClient(15 * time.Second)

	resp, err := client.Do(upReq)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()

	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// vaultProviderIDPattern gates hub-supplied provider IDs at the adoption boundary. The ID
// becomes map keys, scheduler identifiers, and DOM element ids in the console
// (ed_p_name_<id> ...), so anything outside this conservative slug charset is refused
// rather than adopted (a compromised/misbehaving hub must not inject markup or break
// selectors on the node).
var vaultProviderIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func decodeVaultProviderConfig(provID string, raw json.RawMessage) (*types.ProviderConfig, error) {
	if !vaultProviderIDPattern.MatchString(provID) {
		return nil, fmt.Errorf("admin: refusing vault provider with unsafe id %q", provID)
	}
	var pc types.ProviderConfig
	if err := json.Unmarshal(raw, &pc); err != nil {
		return nil, err
	}
	var extra struct {
		Enabled *bool             `json:"enabled"`
		Keys    map[string]string `json:"keys"`
	}
	_ = json.Unmarshal(raw, &extra)
	if pc.ID == "" {
		pc.ID = provID
	}
	// The hub fetch payload carries no "enabled" flag: a newly adopted provider starts
	// enabled. For existing providers MergeVaultConfig preserves the local toggle, so
	// this defaulting never re-enables anything already on the node.
	if extra.Enabled == nil {
		pc.Enabled = true
	}
	if len(extra.Keys) > 0 {
		labels := make([]string, 0, len(extra.Keys))
		for lbl := range extra.Keys {
			labels = append(labels, lbl)
		}
		sort.Strings(labels)
		for _, lbl := range labels {
			secret := strings.TrimSpace(extra.Keys[lbl])
			if secret == "" {
				continue
			}
			matched := false
			for _, k := range pc.APIKeys {
				if k != nil && (k.ID == lbl || k.Label == lbl) {
					if k.Key == "" || config.IsMaskedSecret(k.Key) {
						k.Key = secret
					}
					k.Origin = "vault"
					matched = true
					break
				}
			}
			if !matched {
				pc.APIKeys = append(pc.APIKeys, &types.KeyEntry{
					ID:      lbl,
					Label:   lbl,
					Key:     secret,
					Origin:  "vault",
					Enabled: true,
				})
			}
		}
	}
	return &pc, nil
}

// importedKeyLabels lists the labels of vault keys that landed with this fetch (for the UI toast).
func importedKeyLabels(provs map[string]*types.ProviderConfig) []string {
	labels := make([]string, 0, 8)
	for _, p := range provs {
		if p == nil {
			continue
		}
		for _, k := range p.APIKeys {
			if k == nil {
				continue
			}
			lbl := strings.TrimSpace(k.Label)
			if lbl == "" {
				lbl = strings.TrimSpace(k.ID)
			}
			if lbl == "" {
				continue
			}
			dup := false
			for _, e := range labels {
				if e == lbl {
					dup = true
					break
				}
			}
			if !dup {
				labels = append(labels, lbl)
			}
		}
	}
	sort.Strings(labels)
	return labels
}

// vaultFetchWantsSpecificKeys reports whether the request targets a key-label subset
// (按 Key 标签补拉) rather than a full provider fetch (规则+全部 Key).
func vaultFetchWantsSpecificKeys(reqBody map[string]any) bool {
	if lbl, _ := reqBody["key_label"].(string); strings.TrimSpace(lbl) != "" {
		return true
	}
	if keysRaw, ok := reqBody["keys"].([]any); ok && len(keysRaw) > 0 {
		return true
	}
	return false
}

// maskHubFetchSecrets masks plaintext vault key secrets in the Hub fetch response before
// echoing it to the admin client. The console only reads ok/provider and reloads the
// (masked) config afterwards, so plaintext secrets must not transit the admin response.
func maskHubFetchSecrets(respBody map[string]any) {
	maskProviderCfg := func(pc map[string]any) {
		if keys, ok := pc["keys"].(map[string]any); ok {
			for lbl, v := range keys {
				if s, isStr := v.(string); isStr && s != "" && !config.IsMaskedSecret(s) {
					keys[lbl] = maskSecret(s)
				}
			}
		}
		if apiKeys, ok := pc["api_keys"].([]any); ok {
			for _, item := range apiKeys {
				if km, ok := item.(map[string]any); ok {
					if s, isStr := km["key"].(string); isStr && s != "" && !config.IsMaskedSecret(s) {
						km["key"] = maskSecret(s)
					}
				}
			}
		}
	}
	if pc, ok := respBody["provider_config"].(map[string]any); ok {
		maskProviderCfg(pc)
	}
	if provs, ok := respBody["providers"].(map[string]any); ok {
		for _, v := range provs {
			if pc, ok := v.(map[string]any); ok {
				maskProviderCfg(pc)
			}
		}
	}
}

func (s *Server) handleVaultFetch(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var reqBody map[string]any
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json"})
		return
	}

	// The caller may only choose WHAT to fetch (provider / key_label / keys). WHERE to
	// fetch from is always the configured Vault (stored config URL + token, or CLI
	// defaults): an admin-password leak must not be able to point the fetch — and with
	// it the auto-import of hub-managed fields like base_url — at an attacker hub.
	snap, _ := s.localSrc.Current(r.Context(), false)
	reqProvider, _ := reqBody["provider"].(string)
	hubURL, nodeToken := s.resolveVaultCredentials(snap, "", "")

	if hubURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "vault hub url not configured"})
		return
	}

	// On-demand rule: a provider that already exists locally with a non-vault origin
	// ("local" or a legacy empty origin) is not re-fetchable; the operator must delete
	// it first (gen-1 semantic). MergeVaultConfig re-checks this under the config mutex,
	// so a same-ID provider flipped local during the hub round-trip still fails closed.
	if reqProvider != "" && snap != nil && snap.Config != nil {
		if p, ok := snap.Config.Providers[reqProvider]; ok && p != nil && p.Origin != "vault" {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":       false,
				"error":    "provider_exists_local",
				"provider": reqProvider,
			})
			return
		}
	}

	// Forward a minimal upstream body: caller-supplied hub_url/node_token/providers are
	// never relayed to the hub.
	upBody := map[string]any{"provider": reqProvider}
	if lbl, _ := reqBody["key_label"].(string); strings.TrimSpace(lbl) != "" {
		upBody["key_label"] = lbl
	}
	if keysRaw, ok := reqBody["keys"].([]any); ok && len(keysRaw) > 0 {
		upBody["keys"] = keysRaw
	}

	target := strings.TrimRight(hubURL, "/") + "/api/vault/fetch"
	reqData, _ := json.Marshal(upBody)
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(reqData))
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	if nodeToken != "" {
		upReq.Header.Set("Authorization", "Bearer "+nodeToken)
	}

	client := s.outboundClient(15 * time.Second)

	resp, err := client.Do(upReq)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}

	// Auto-import fetched providers into local configuration if Hub returned 200 OK.
	// A full provider fetch replaces the hub-managed fields and the vault key list
	// wholesale; a key-label subset fetch (按 Key 标签补拉) merges without dropping
	// the other vault keys.
	var hubResp struct {
		OK             bool                       `json:"ok"`
		Provider       string                     `json:"provider"`
		ProviderConfig json.RawMessage            `json:"provider_config"`
		Providers      map[string]json.RawMessage `json:"providers"`
	}
	importedKeys := []string{}
	if err := json.Unmarshal(respBytes, &hubResp); err == nil && hubResp.OK {
		toMerge := make(map[string]*types.ProviderConfig)
		if hubResp.Provider != "" && len(hubResp.ProviderConfig) > 0 && string(hubResp.ProviderConfig) != "null" {
			if pc, decErr := decodeVaultProviderConfig(hubResp.Provider, hubResp.ProviderConfig); decErr == nil && pc != nil {
				toMerge[hubResp.Provider] = pc
			}
		}
		for k, rawV := range hubResp.Providers {
			if len(rawV) > 0 && string(rawV) != "null" {
				if pc, decErr := decodeVaultProviderConfig(k, rawV); decErr == nil && pc != nil {
					toMerge[k] = pc
				}
			}
		}
		if len(toMerge) > 0 {
			_, mergeErr := s.localSrc.MergeVaultConfig(toMerge, !vaultFetchWantsSpecificKeys(reqBody))
			if mergeErr != nil {
				var lc *config.LocalProviderConflictError
				if errors.As(mergeErr, &lc) {
					w.WriteHeader(http.StatusConflict)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"ok":       false,
						"error":    "provider_exists_local",
						"provider": lc.Provider,
					})
					return
				}
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": mergeErr.Error()})
				return
			}
			importedKeys = importedKeyLabels(toMerge)
		}
	}

	if resp.StatusCode == http.StatusOK {
		var respBody map[string]any
		if err := json.Unmarshal(respBytes, &respBody); err == nil && respBody != nil {
			maskHubFetchSecrets(respBody)
			respBody["imported_keys"] = importedKeys
			out, _ := json.Marshal(respBody)
			w.WriteHeader(resp.StatusCode)
			_, _ = w.Write(out)
			return
		}
		// A 200 response that is not a JSON object cannot be masked — echoing it raw
		// would let plaintext secrets transit the admin response when the hub misbehaves.
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "vault_fetch_invalid_response"})
		return
	}

	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBytes)
}

func (s *Server) handleOAuthStart(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	if s.oauthMgr == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "oauth manager not configured"})
		return
	}

	var req struct {
		Endpoint string `json:"endpoint"`
		ClientID string `json:"client_id"`
		Scope    string `json:"scope"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json"})
		return
	}

	if req.Endpoint == "" {
		req.Endpoint = "https://api.minimax.chat/oauth/device/code"
	}

	session, err := s.oauthMgr.StartDeviceFlow(r.Context(), req.Endpoint, req.ClientID, req.Scope)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":               true,
		"device_code":      session.DeviceCode,
		"user_code":        session.UserCode,
		"verification_uri": session.VerificationURI,
		"expires_in":       session.ExpiresIn,
		"interval":         session.Interval,
	})
}

func (s *Server) handleOAuthPoll(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	if s.oauthMgr == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "oauth manager not configured"})
		return
	}

	var endpoint, clientID, deviceCode string
	if r.Method == http.MethodGet {
		endpoint = r.URL.Query().Get("endpoint")
		clientID = r.URL.Query().Get("client_id")
		deviceCode = r.URL.Query().Get("device_code")
	} else {
		var req struct {
			Endpoint   string `json:"endpoint"`
			ClientID   string `json:"client_id"`
			DeviceCode string `json:"device_code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		endpoint = req.Endpoint
		clientID = req.ClientID
		deviceCode = req.DeviceCode
	}

	if endpoint == "" {
		endpoint = "https://api.minimax.chat/oauth/token"
	}

	tok, err := s.oauthMgr.PollToken(r.Context(), endpoint, clientID, deviceCode)
	if err != nil {
		if errors.Is(err, oauth.ErrDevicePending) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":     false,
				"status": "pending",
				"error":  "authorization_pending",
			})
			return
		}
		if errors.Is(err, oauth.ErrDeviceExpired) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":     false,
				"status": "expired",
				"error":  "expired_token",
			})
			return
		}

		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": err.Error(),
		})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":    true,
		"token": tok,
	})
}

func maskConfigSecrets(cfg *types.ProxyConfig) *types.ProxyConfig {
	if cfg == nil {
		return nil
	}

	// Deep copy to prevent modifying in-memory active config
	data, _ := json.Marshal(cfg)
	var copyCfg types.ProxyConfig
	_ = json.Unmarshal(data, &copyCfg)

	// Visibility rules on a node:
	//  - keys added locally on this node  -> plaintext (the operator owns them)
	//  - keys synced from the hub vault   -> short mask only, and the UI locks editing
	//  - OAuth refresh tokens & Vault node token -> always masked on readback
	for _, p := range copyCfg.Providers {
		if p == nil {
			continue
		}
		for _, k := range p.APIKeys {
			if k == nil {
				continue
			}
			if k.OAuthMeta != nil && k.OAuthMeta.RefreshToken != "" {
				k.OAuthMeta.RefreshToken = maskSecret(k.OAuthMeta.RefreshToken)
			}
			if k.Origin == "vault" && k.Key != "" {
				k.Key = maskSecret(k.Key)
			}
		}
	}

	if copyCfg.Vault != nil && copyCfg.Vault.NodeToken != "" {
		copyCfg.Vault.NodeToken = maskSecret(copyCfg.Vault.NodeToken)
	}

	return &copyCfg
}

// maskSecret renders a short, readable hint instead of a dot run: keys synced from
// the hub vault cannot be read back or edited on the node, so "sk-...7Yjl" is enough
// to identify which credential is in use without exposing it.
func maskSecret(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if len(s) <= 8 {
		return "***"
	}
	head := strings.TrimRight(s[:3], "-_")
	if head == "" {
		head = s[:1]
	}
	tail := s[len(s)-4:]
	return head + "-..." + tail
}
