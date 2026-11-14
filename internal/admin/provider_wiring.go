package admin

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/provider"
	"github.com/khc8655/llmproxy2/internal/types"
)

type detectProviderRequest struct {
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
	Provider string `json:"provider"`
}

func (s *Server) handleDetectProvider(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req detectProviderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json: " + err.Error()})
		return
	}

	// Resolve stored provider and unmasked key if provider ID is given
	if req.Provider != "" && s.localSrc != nil {
		if snap, _ := s.localSrc.Current(r.Context(), false); snap != nil && snap.Config != nil {
			if p, ok := snap.Config.Providers[req.Provider]; ok && p != nil {
				if req.BaseURL == "" {
					req.BaseURL = p.BaseURL
				}
				if req.APIKey == "" || config.IsMaskedSecret(req.APIKey) {
					if len(p.APIKeys) > 0 && p.APIKeys[0] != nil {
						req.APIKey = p.APIKeys[0].Key
					}
				}
			}
		}
	}

	if strings.TrimSpace(req.BaseURL) == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "type the base URL first"})
		return
	}

	res, err := provider.Detect(r.Context(), s.httpClient, req.BaseURL, req.APIKey)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":                  true,
		"base_url":            req.BaseURL,
		"normalized_base_url": res.BaseURL,
		"protocols":           res.Protocols,
		"results":             res.Results,
	})
}

type balanceRequest struct {
	Provider    string `json:"provider"`
	KeyLabel    string `json:"key_label"`
	APIKey      string `json:"api_key"`
	BaseURL     string `json:"base_url"`
	BalanceURL  string `json:"balance_url"`
	BalancePath string `json:"balance_path"`
	PresetID    string `json:"preset_id"`
}

func (s *Server) handleBalance(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req balanceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json: " + err.Error()})
		return
	}

	var provCfg *types.ProviderConfig
	var resolvedKey string

	if req.Provider != "" && s.localSrc != nil {
		if snap, _ := s.localSrc.Current(r.Context(), false); snap != nil && snap.Config != nil {
			if p, ok := snap.Config.Providers[req.Provider]; ok && p != nil {
				cp := *p
				provCfg = &cp
				if req.KeyLabel != "" {
					for _, k := range p.APIKeys {
						if k != nil && (k.Label == req.KeyLabel || k.ID == req.KeyLabel) {
							resolvedKey = k.Key
							break
						}
					}
				}
				if resolvedKey == "" && len(p.APIKeys) > 0 && p.APIKeys[0] != nil {
					resolvedKey = p.APIKeys[0].Key
				}
			}
		}
	}

	if provCfg == nil {
		provCfg = &types.ProviderConfig{
			ID: req.Provider,
		}
	}

	if req.BaseURL != "" {
		provCfg.BaseURL = req.BaseURL
	}
	if req.BalanceURL != "" {
		provCfg.BalanceURL = req.BalanceURL
	}
	if req.BalancePath != "" {
		provCfg.BalancePath = req.BalancePath
	}
	if req.PresetID != "" {
		provCfg.PresetID = req.PresetID
	}
	if req.APIKey != "" && !config.IsMaskedSecret(req.APIKey) {
		resolvedKey = req.APIKey
	}

	bal, err := provider.QueryBalance(r.Context(), s.httpClient, provCfg, resolvedKey)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"balance": bal,
	})
}

type testProviderRequest struct {
	Provider string `json:"provider"`
	KeyLabel string `json:"key_label"`
	APIKey   string `json:"api_key"`
	Model    string `json:"model"`
	Protocol string `json:"protocol"`
	Batch    bool   `json:"batch"`
}

func (s *Server) handleTestProvider(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req testProviderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json: " + err.Error()})
		return
	}

	var provCfg *types.ProviderConfig
	if req.Provider != "" && s.localSrc != nil {
		if snap, _ := s.localSrc.Current(r.Context(), false); snap != nil && snap.Config != nil {
			if p, ok := snap.Config.Providers[req.Provider]; ok && p != nil {
				cp := *p
				provCfg = &cp
			}
		}
	}

	if provCfg == nil {
		provCfg = &types.ProviderConfig{
			ID:      req.Provider,
			BaseURL: req.Provider,
		}
		if req.APIKey != "" && !config.IsMaskedSecret(req.APIKey) {
			provCfg.APIKeys = []*types.KeyEntry{{Key: req.APIKey, Label: req.KeyLabel}}
		}
	}

	if req.Batch {
		results := provider.BatchTestKeys(r.Context(), s.httpClient, provCfg, req.Model)
		if s.scheduler != nil && s.scheduler.Cooldowns() != nil {
			for _, res := range results {
				if res.OK {
					if res.KeyID != "" {
						s.scheduler.Cooldowns().ClearKey(provCfg.ID, res.KeyID)
					}
					if res.KeyLabel != "" {
						s.scheduler.Cooldowns().ClearKey(provCfg.ID, res.KeyLabel)
					}
				}
			}
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"results": results,
		})
		return
	}

	// Single endpoint/protocol test
	apiKey := req.APIKey
	if (apiKey == "" || config.IsMaskedSecret(apiKey)) && provCfg != nil {
		if req.KeyLabel != "" {
			for _, k := range provCfg.APIKeys {
				if k != nil && (k.Label == req.KeyLabel || k.ID == req.KeyLabel) {
					apiKey = k.Key
					break
				}
			}
		}
		if apiKey == "" || config.IsMaskedSecret(apiKey) {
			if len(provCfg.APIKeys) > 0 && provCfg.APIKeys[0] != nil {
				apiKey = provCfg.APIKeys[0].Key
			}
		}
	}

	testReq := provider.TestRequest{
		Provider: provCfg,
		BaseURL:  provCfg.BaseURL,
		APIKey:   apiKey,
		Protocol: req.Protocol,
		Model:    req.Model,
	}

	results := provider.TestEndpoint(r.Context(), s.httpClient, testReq)
	hasOK := false
	for _, res := range results {
		if res.OK {
			hasOK = true
			break
		}
	}

	if hasOK && s.scheduler != nil && s.scheduler.Cooldowns() != nil {
		if req.KeyLabel != "" {
			s.scheduler.Cooldowns().ClearKey(provCfg.ID, req.KeyLabel)
		} else if len(provCfg.APIKeys) > 0 && provCfg.APIKeys[0] != nil {
			if provCfg.APIKeys[0].ID != "" {
				s.scheduler.Cooldowns().ClearKey(provCfg.ID, provCfg.APIKeys[0].ID)
			}
			if provCfg.APIKeys[0].Label != "" {
				s.scheduler.Cooldowns().ClearKey(provCfg.ID, provCfg.APIKeys[0].Label)
			}
		}
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"results": results,
	})
}

type autolistSyncRequest struct {
	Provider    string `json:"provider"`
	AutoInclude string `json:"auto_include"`
	Apply       bool   `json:"apply"`
}

func (s *Server) handleAutolistSync(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req autolistSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json: " + err.Error()})
		return
	}

	if strings.TrimSpace(req.Provider) == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "provider is required"})
		return
	}

	if s.localSrc == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "local config source not available"})
		return
	}

	snap, err := s.localSrc.Current(r.Context(), false)
	if err != nil || snap == nil || snap.Config == nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "failed to load config"})
		return
	}

	provCfg, ok := snap.Config.Providers[req.Provider]
	if !ok || provCfg == nil {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("provider %q not found", req.Provider)})
		return
	}

	apiKey := ""
	if len(provCfg.APIKeys) > 0 && provCfg.APIKeys[0] != nil {
		apiKey = provCfg.APIKeys[0].Key
	}

	allModels, err := provider.FetchModels(r.Context(), s.httpClient, provCfg, apiKey)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}

	pattern := strings.TrimSpace(req.AutoInclude)
	if pattern == "" {
		pattern = provCfg.AutoInclude
	}

	matched, err := provider.FilterAutoInclude(allModels, pattern)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}

	var added []string
	if req.Apply {
		rawJSON, err := json.Marshal(snap.Config)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}
		var clonedCfg types.ProxyConfig
		if err := json.Unmarshal(rawJSON, &clonedCfg); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}

		if clonedCfg.AgentModels == nil {
			clonedCfg.AgentModels = make(map[string]*types.AgentModelRoute)
		}

		firstKeyLabel := ""
		if len(provCfg.APIKeys) > 0 && provCfg.APIKeys[0] != nil {
			firstKeyLabel = provCfg.APIKeys[0].Label
		}

		for _, m := range matched {
			route, exists := clonedCfg.AgentModels[m]
			if !exists {
				clonedCfg.AgentModels[m] = &types.AgentModelRoute{
					Enabled:         true,
					RoutingStrategy: "priority",
					Candidates: []*types.RouteCandidate{
						{
							Provider:    provCfg.ID,
							TargetModel: m,
							KeyLabel:    firstKeyLabel,
							Enabled:     true,
						},
					},
				}
				added = append(added, m)
			} else {
				candExists := false
				for _, c := range route.Candidates {
					if c != nil && c.Provider == provCfg.ID && (c.TargetModel == m || c.TargetModel == "") {
						candExists = true
						break
					}
				}
				if !candExists {
					route.Candidates = append(route.Candidates, &types.RouteCandidate{
						Provider:    provCfg.ID,
						TargetModel: m,
						KeyLabel:    firstKeyLabel,
						Enabled:     true,
					})
					added = append(added, m)
				}
			}
		}

		if _, err := s.localSrc.SaveConfig(&clonedCfg); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}
	}

	if added == nil {
		added = []string{}
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"models":  allModels,
		"matched": matched,
		"added":   added,
	})
}

func (s *Server) handlePresetsExtra(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"presets": provider.Catalog(),
	})
}

func (s *Server) handleAccessInfo(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	primaryKey, extraKeys := s.authMgr.GetClientKeys()
	mode := types.ModeAgent
	if s.modeSched != nil {
		mode = s.modeSched.CurrentMode()
	}

	masked := ""
	if primaryKey != "" {
		masked = provider.MaskKey(primaryKey)
	}

	endpoints := []string{
		"/v1/chat/completions",
		"/v1/messages",
		"/v1/responses",
		"/v1/models",
	}
	if mode == types.ModeKB {
		endpoints = append(endpoints, "/v1/ocr", "/v1/embeddings", "/v1/rerank")
	}

	var models []string
	if s.localSrc != nil {
		if snap, _ := s.localSrc.Current(r.Context(), false); snap != nil && snap.Config != nil {
			if mode == types.ModeAgent {
				for m := range snap.Config.AgentModels {
					models = append(models, m)
				}
			} else {
				for cat := range snap.Config.KBModels {
					models = append(models, cat)
				}
			}
		}
	}
	sort.Strings(models)
	if models == nil {
		models = []string{}
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":                    true,
		"mode":                  mode,
		"client_key_configured": primaryKey != "",
		"client_key_masked":     masked,
		"proxy_keys_count":      len(extraKeys),
		"endpoints":             endpoints,
		"models":                models,
	})
}

func (s *Server) handleAccessKey(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		ClientKey string `json:"client_key"`
		Generate  bool   `json:"generate"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	newKey := strings.TrimSpace(req.ClientKey)
	if req.Generate || newKey == "" {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		newKey = "sk-llmproxy-" + hex.EncodeToString(b)
	}

	var extraKeys []string
	if s.localSrc != nil {
		snap, _ := s.localSrc.Current(r.Context(), false)
		var clonedCfg types.ProxyConfig
		if snap != nil && snap.Config != nil {
			raw, _ := json.Marshal(snap.Config)
			_ = json.Unmarshal(raw, &clonedCfg)
		}
		clonedCfg.Settings.ClientKey = newKey
		extraKeys = clonedCfg.Settings.ProxyKeys
		if _, err := s.localSrc.SaveConfig(&clonedCfg); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}
	}

	s.authMgr.UpdateClientKeys(newKey, extraKeys)

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":         true,
		"client_key": newKey,
		"masked":     provider.MaskKey(newKey),
	})
}
