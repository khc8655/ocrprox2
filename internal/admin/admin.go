// Package admin provides administrative HTTP API handlers for Full mode:
// configuration management with CAS 409, embedded web console, usage queries, traces,
// cooldown diagnostics, key verification, model probing, and vault sync.
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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/modesched"
	"github.com/khc8655/llmproxy2/internal/oauth"
	"github.com/khc8655/llmproxy2/internal/provider"
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
	authMgr       *auth.Authenticator
	localSrc      *config.LocalSource
	obsSink       types.ObservabilitySink
	scheduler     *scheduler.Scheduler
	modeSched     *modesched.ModeScheduler
	oauthMgr      *oauth.Manager
	httpClient    *http.Client
	adminPassword string
	refreshMgr    *provider.RefreshManager
	buildVersion  string
	buildSemver   string
	buildCommit   string
	updateAPIBase string
	defaultVault  *types.VaultClientConfig
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
		httpClient:    upstream.DefaultClient(15*time.Second, true),
		adminPassword: os.Getenv("ADMIN_PASSWORD"),
	}
}

// SetAdminPassword sets the admin password explicitly for session cookie verification.
func (s *Server) SetAdminPassword(pass string) {
	s.adminPassword = pass
}

// SetRefreshManager connects the provider RefreshManager to the admin server.
func (s *Server) SetRefreshManager(rm *provider.RefreshManager) {
	s.refreshMgr = rm
}

// SetModeScheduler connects the mode scheduler to the admin server.
func (s *Server) SetModeScheduler(ms *modesched.ModeScheduler) {
	s.modeSched = ms
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

func (s *Server) effectiveVault(cfgVault *types.VaultClientConfig) *types.VaultClientConfig {
	var url, tok string
	if cfgVault != nil {
		url = strings.TrimSpace(cfgVault.URL)
		tok = strings.TrimSpace(cfgVault.NodeToken)
	}
	if s.defaultVault != nil {
		if url == "" {
			url = s.defaultVault.URL
		}
		if tok == "" {
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
	var cfgVault *types.VaultClientConfig
	if snap != nil && snap.Config != nil {
		cfgVault = snap.Config.Vault
	}
	eff := s.effectiveVault(cfgVault)
	if eff != nil {
		if hubURL == "" {
			hubURL = eff.URL
		}
		if nodeToken == "" {
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
	register("GET /api/admin/cooldowns", s.handleCooldowns)
	register("DELETE /api/admin/cooldowns", s.handleCooldowns)
	register("GET /api/lanes", s.handleLanes)
	register("GET /api/admin/lanes", s.handleLanes)
	register("GET /api/admin/mode", s.handleMode)
	register("POST /api/admin/mode", s.handleMode)
	register("POST /api/admin/verify-key", s.handleVerifyKey)
	register("POST /api/admin/probe-models", s.handleProbeModels)
	register("GET /api/vault/manifest", s.handleVaultManifest)
	register("POST /api/vault/fetch", s.handleVaultFetch)
	register("POST /api/admin/oauth/start", s.handleOAuthStart)
	register("GET /api/admin/oauth/poll", s.handleOAuthPoll)
	register("POST /api/admin/oauth/poll", s.handleOAuthPoll)
	register("POST /api/admin/detect-provider", s.handleDetectProvider)
	register("POST /api/admin/balance", s.handleBalance)
	register("POST /api/admin/test-provider", s.handleTestProvider)
	register("POST /api/admin/autolist-sync", s.handleAutolistSync)
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
	// Sample the lockout state BEFORE authenticating: the request that trips the
	// 5th failure still deserves a 401 ("bad credentials"); only requests made
	// while already locked get 429.
	blockedBefore := s.adminIPBlocked(r)
	if !s.isAdminAuthorized(r) {
		s.writeAuthFailure(w, r, blockedBefore)
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
			if dv := s.effectiveVault(nil); dv != nil {
				vaultVal = dv
			}
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":           true,
				"_version":     0,
				"providers":    map[string]any{},
				"agent_models": map[string]any{},
				"kb_models":    map[string]any{},
				"settings":     map[string]any{},
				"vault":        vaultVal,
			})
			return
		}

		masked := maskConfigSecrets(snap.Config)
		if dv := s.effectiveVault(masked.Vault); dv != nil {
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

	exportData := map[string]any{
		"ok":           true,
		"_version":     snap.Config.Version,
		"_exported_at": time.Now().Format("2006-01-02 15:04:05"),
		"providers":    snap.Config.Providers,
		"agent_models": snap.Config.AgentModels,
		"kb_models":    snap.Config.KBModels,
		"settings":     snap.Config.Settings,
	}
	if snap.Config.Vault != nil {
		exportData["vault"] = snap.Config.Vault
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
			if targetCfg.Settings.RunMode == "" {
				targetCfg.Settings.RunMode = currentCfg.Settings.RunMode
			}
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

		curMode := targetCfg.Settings.RunMode
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
		if len(incoming.Settings.ProxyKeys) > 0 {
			targetCfg.Settings.ProxyKeys = incoming.Settings.ProxyKeys
		}
		targetCfg.Settings.RunMode = curMode
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

	providerName := req.Provider
	keyLabel := req.Key
	if keyLabel == "" {
		keyLabel = req.KeyLabel
	}
	model := req.Model
	if model == "" {
		model = req.ModelName
	}
	candType := strings.ToLower(req.Type)
	if candType == "" {
		candType = "chat"
	}

	if providerName == "" || keyLabel == "" || model == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "missing provider, key, or model",
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
	for _, k := range prov.APIKeys {
		if k != nil && (k.Label == keyLabel || k.ID == keyLabel || k.Key == keyLabel) {
			apiKey = k.Key
			break
		}
	}
	if apiKey == "" {
		if !config.IsMaskedSecret(keyLabel) && len(keyLabel) > 5 {
			apiKey = keyLabel
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

	baseURL := prov.BaseURL
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
		targetURL = upstream.JoinUpstream(baseURL, "chat/completions")
		reqBodyBytes, _ = json.Marshal(map[string]any{
			"model": model,
			"messages": []map[string]any{
				{"role": "user", "content": "Hi"},
			},
			"max_tokens": 16,
			"stream":     false,
		})
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

	if prov.AdapterRules != nil && prov.AdapterRules.AuthHeader != "" && prov.AdapterRules.AuthPrefix != "" {
		upReq.Header.Set(prov.AdapterRules.AuthHeader, prov.AdapterRules.AuthPrefix+apiKey)
	} else if strings.EqualFold(providerName, "vertex") || strings.Contains(strings.ToLower(baseURL), "aiplatform.googleapis.com") {
		upReq.Header.Set("x-goog-api-key", apiKey)
	} else {
		upReq.Header.Set("Authorization", "Bearer "+apiKey)
	}

	client := s.httpClient
	if client == nil {
		client = upstream.DefaultClient(20*time.Second, true)
	}

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

	if isOK {
		if s.scheduler != nil {
			s.scheduler.Cooldowns().ClearKey(providerName, keyLabel)
		}
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
			for _, k := range prov.APIKeys {
				if k != nil && (k.Label == cand.KeyLabel || k.ID == cand.KeyLabel) {
					apiKey = k.Key
					break
				}
			}
			if apiKey == "" || config.IsMaskedSecret(apiKey) {
				results[idx] = ProbeResult{
					Provider: cand.Provider,
					Key:      cand.KeyLabel,
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
			targetURL := upstream.JoinUpstream(prov.BaseURL, "chat/completions")

			testBody, _ := json.Marshal(map[string]any{
				"model": targetModel,
				"messages": []map[string]any{
					{"role": "user", "content": "Hi"},
				},
				"max_tokens": 16,
				"stream":     false,
			})

			upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, targetURL, bytes.NewReader(testBody))
			if err != nil {
				results[idx] = ProbeResult{
					Provider: cand.Provider,
					Key:      cand.KeyLabel,
					Model:    targetModel,
					OK:       false,
					Error:    err.Error(),
				}
				return
			}
			upReq.Header.Set("Content-Type", "application/json")
			if prov.AdapterRules != nil && prov.AdapterRules.AuthHeader != "" && prov.AdapterRules.AuthPrefix != "" {
				upReq.Header.Set(prov.AdapterRules.AuthHeader, prov.AdapterRules.AuthPrefix+apiKey)
			} else if strings.EqualFold(cand.Provider, "vertex") || strings.Contains(strings.ToLower(prov.BaseURL), "aiplatform.googleapis.com") {
				upReq.Header.Set("x-goog-api-key", apiKey)
			} else {
				upReq.Header.Set("Authorization", "Bearer "+apiKey)
			}

			client := s.httpClient
			if client == nil {
				client = upstream.DefaultClient(15*time.Second, true)
			}

			start := time.Now()
			resp, err := client.Do(upReq)
			lat := time.Since(start).Milliseconds()

			if err != nil {
				results[idx] = ProbeResult{
					Provider:  cand.Provider,
					Key:       cand.KeyLabel,
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
				if s.scheduler != nil {
					s.scheduler.Cooldowns().ClearKey(cand.Provider, cand.KeyLabel)
				}
			}

			results[idx] = ProbeResult{
				Provider:  cand.Provider,
				Key:       cand.KeyLabel,
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

func (s *Server) handleMode(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		currentMode := types.ModeAgent
		if snap, err := s.localSrc.Current(r.Context(), false); err == nil && snap != nil && snap.Config != nil {
			if snap.Config.Settings.RunMode != "" {
				currentMode = snap.Config.Settings.RunMode
			}
		}
		if s.modeSched != nil {
			currentMode = s.modeSched.CurrentMode()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"mode":     currentMode,
			"run_mode": currentMode,
		})

	case http.MethodPost:
		var req struct {
			Mode    string `json:"mode"`
			RunMode string `json:"run_mode"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json"})
			return
		}
		targetMode := req.Mode
		if targetMode == "" {
			targetMode = req.RunMode
		}
		if targetMode != "agent" && targetMode != "kb" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "mode must be agent or kb"})
			return
		}

		rm := types.RunMode(targetMode)
		savedSnap, err := s.localSrc.UpdateRunMode(rm)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if s.modeSched != nil {
			s.modeSched.SetManualMode(rm)
		}
		var ver int64 = 0
		if savedSnap != nil && savedSnap.Config != nil {
			ver = savedSnap.Config.Version
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"mode":     rm,
			"run_mode": rm,
			"_version": ver,
		})

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
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
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json"})
		return
	}

	snap, _ := s.localSrc.Current(r.Context(), false)
	if snap != nil && snap.Config != nil {
		if p, ok := snap.Config.Providers[req.Provider]; ok {
			if req.BaseURL == "" {
				req.BaseURL = p.BaseURL
			}
			if req.APIKey == "" || config.IsMaskedSecret(req.APIKey) {
				for _, k := range p.APIKeys {
					if k.Enabled && k.Key != "" && !config.IsMaskedSecret(k.Key) {
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
	if req.BaseURL == "" {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"valid":  false,
			"status": http.StatusBadRequest,
			"error":  "base_url is required",
		})
		return
	}

	targetURL := upstream.JoinUpstream(req.BaseURL, "models")
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
	upReq.Header.Set("Authorization", "Bearer "+req.APIKey)

	client := s.httpClient
	if client == nil {
		client = upstream.DefaultClient(15*time.Second, true)
	}

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
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json"})
		return
	}

	snap, _ := s.localSrc.Current(r.Context(), false)
	if snap != nil && snap.Config != nil {
		if p, ok := snap.Config.Providers[req.Provider]; ok {
			if req.BaseURL == "" {
				req.BaseURL = p.BaseURL
			}
			if req.APIKey == "" || config.IsMaskedSecret(req.APIKey) {
				for _, k := range p.APIKeys {
					if k.Enabled && k.Key != "" && !config.IsMaskedSecret(k.Key) {
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
	if req.BaseURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "base_url is required"})
		return
	}

	targetURL := upstream.JoinUpstream(req.BaseURL, "models")
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	upReq.Header.Set("Authorization", "Bearer "+req.APIKey)

	client := s.httpClient
	if client == nil {
		client = upstream.DefaultClient(15*time.Second, true)
	}

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

	snap, _ := s.localSrc.Current(r.Context(), false)
	hubURL, nodeToken := s.resolveVaultCredentials(snap, r.URL.Query().Get("hub_url"), r.URL.Query().Get("node_token"))

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

	client := s.httpClient
	if client == nil {
		client = upstream.DefaultClient(15*time.Second, true)
	}

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

	// 1. If payload directly provides "providers", merge into local source
	if provsRaw, ok := reqBody["providers"]; ok {
		provsData, _ := json.Marshal(provsRaw)
		var provs map[string]*types.ProviderConfig
		if err := json.Unmarshal(provsData, &provs); err == nil && len(provs) > 0 {
			savedSnap, err := s.localSrc.MergeVaultConfig(provs)
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":       true,
				"_version": savedSnap.Config.Version,
				"merged":   len(provs),
			})
			return
		}
	}

	// 2. Otherwise forward fetch to Hub
	snap, _ := s.localSrc.Current(r.Context(), false)
	reqHubURL, _ := reqBody["hub_url"].(string)
	reqNodeToken, _ := reqBody["node_token"].(string)
	hubURL, nodeToken := s.resolveVaultCredentials(snap, reqHubURL, reqNodeToken)

	if hubURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "vault hub url not configured"})
		return
	}

	target := strings.TrimRight(hubURL, "/") + "/api/vault/fetch"
	reqData, _ := json.Marshal(reqBody)
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

	client := s.httpClient
	if client == nil {
		client = upstream.DefaultClient(15*time.Second, true)
	}

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

	// Auto-merge fetched providers into local configuration if Hub returned 200 OK
	var hubResp struct {
		OK             bool                             `json:"ok"`
		Provider       string                           `json:"provider"`
		ProviderConfig *types.ProviderConfig            `json:"provider_config"`
		Providers      map[string]*types.ProviderConfig `json:"providers"`
	}
	if err := json.Unmarshal(respBytes, &hubResp); err == nil && hubResp.OK {
		toMerge := make(map[string]*types.ProviderConfig)
		if hubResp.Provider != "" && hubResp.ProviderConfig != nil {
			toMerge[hubResp.Provider] = hubResp.ProviderConfig
		}
		for k, v := range hubResp.Providers {
			toMerge[k] = v
		}
		if len(toMerge) > 0 {
			_, _ = s.localSrc.MergeVaultConfig(toMerge)
		}
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

	for _, p := range copyCfg.Providers {
		if p == nil {
			continue
		}
		for _, k := range p.APIKeys {
			if k != nil && k.Key != "" {
				k.Key = maskSecret(k.Key)
			}
		}
	}

	return &copyCfg
}

func maskSecret(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= 8 {
		return "●●●●●●●●"
	}
	return s[:3] + "●●●●●●" + s[len(s)-4:]
}
