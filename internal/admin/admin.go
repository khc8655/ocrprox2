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
	"strings"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/modesched"
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
	modeSched  *modesched.ModeScheduler
	oauthMgr   *oauth.Manager
	httpClient *http.Client
}

// NewServer creates a new admin Server.
func NewServer(
	authMgr *auth.Authenticator,
	localSrc *config.LocalSource,
	obsSink types.ObservabilitySink,
	sched *scheduler.Scheduler,
) *Server {
	return &Server{
		authMgr:    authMgr,
		localSrc:   localSrc,
		obsSink:    obsSink,
		scheduler:  sched,
		httpClient: upstream.DefaultClient(15*time.Second, true),
	}
}

// SetModeScheduler connects the mode scheduler to the admin server.
func (s *Server) SetModeScheduler(ms *modesched.ModeScheduler) {
	s.modeSched = ms
}

// SetOAuthManager connects the OAuth manager to the admin server.
func (s *Server) SetOAuthManager(om *oauth.Manager) {
	s.oauthMgr = om
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
	register("GET /api/admin/usage", s.handleUsage)
	register("GET /api/admin/traces", s.handleTraces)
	register("GET /api/admin/cooldowns", s.handleCooldowns)
	register("DELETE /api/admin/cooldowns", s.handleCooldowns)
	register("GET /api/admin/mode", s.handleMode)
	register("POST /api/admin/mode", s.handleMode)
	register("POST /api/admin/verify-key", s.handleVerifyKey)
	register("POST /api/admin/probe-models", s.handleProbeModels)
	register("GET /api/vault/manifest", s.handleVaultManifest)
	register("POST /api/vault/fetch", s.handleVaultFetch)
	register("POST /api/admin/oauth/start", s.handleOAuthStart)
	register("GET /api/admin/oauth/poll", s.handleOAuthPoll)
	register("POST /api/admin/oauth/poll", s.handleOAuthPoll)
}

func (s *Server) checkAuth(w http.ResponseWriter, r *http.Request) bool {
	if !s.authMgr.VerifyAdminAuth(r) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": false,
			"error": map[string]any{
				"message": "unauthorized admin credentials",
				"type":    "auth_error",
			},
		})
		return false
	}
	return true
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
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":           true,
				"_version":     0,
				"providers":    map[string]any{},
				"agent_models": map[string]any{},
				"kb_models":    map[string]any{},
				"settings":     map[string]any{},
				"vault":        map[string]any{},
			})
			return
		}

		masked := maskConfigSecrets(snap.Config)
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

	onlyFailed := r.URL.Query().Get("failed") == "1" || r.URL.Query().Get("failed") == "true"
	traces := s.obsSink.RecentTraces(onlyFailed)

	w.Header().Set("Content-Type", "application/json")
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
	hubURL := r.URL.Query().Get("hub_url")
	nodeToken := r.URL.Query().Get("node_token")

	if hubURL == "" && snap != nil && snap.Config != nil && snap.Config.Vault != nil {
		hubURL = snap.Config.Vault.URL
	}
	if nodeToken == "" && snap != nil && snap.Config != nil && snap.Config.Vault != nil {
		nodeToken = snap.Config.Vault.NodeToken
	}

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
	hubURL, _ := reqBody["hub_url"].(string)
	nodeToken, _ := reqBody["node_token"].(string)

	if hubURL == "" && snap != nil && snap.Config != nil && snap.Config.Vault != nil {
		hubURL = snap.Config.Vault.URL
	}
	if nodeToken == "" && snap != nil && snap.Config != nil && snap.Config.Vault != nil {
		nodeToken = snap.Config.Vault.NodeToken
	}

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
