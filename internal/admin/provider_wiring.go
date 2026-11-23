package admin

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

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
				if req.APIKey == "" || config.IsMaskedSecret(req.APIKey) {
					for _, k := range p.APIKeys {
						if k != nil && k.Key != "" && !config.IsMaskedSecret(k.Key) {
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
				if req.BaseURL == "" {
					req.BaseURL = p.BaseURL
				}
			}
		}
	}

	if strings.TrimSpace(req.BaseURL) == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "type the base URL first"})
		return
	}

	res, err := provider.Detect(r.Context(), s.outboundClient(15*time.Second), req.BaseURL, req.APIKey)
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

type testProviderRequest struct {
	Provider string `json:"provider"`
	BaseURL  string `json:"base_url"`
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

	var storedProv *types.ProviderConfig
	var provCfg *types.ProviderConfig
	if req.Provider != "" && s.localSrc != nil {
		if snap, _ := s.localSrc.Current(r.Context(), false); snap != nil && snap.Config != nil {
			if p, ok := snap.Config.Providers[req.Provider]; ok && p != nil {
				storedProv = p
				cp := *p
				provCfg = &cp
			}
		}
	}

	if provCfg == nil {
		baseURL := strings.TrimSpace(req.BaseURL)
		if baseURL == "" {
			baseURL = req.Provider
		}
		provCfg = &types.ProviderConfig{
			ID:      req.Provider,
			BaseURL: baseURL,
		}
		if req.APIKey != "" && !config.IsMaskedSecret(req.APIKey) {
			provCfg.APIKeys = []*types.KeyEntry{{Key: req.APIKey, Label: req.KeyLabel}}
		}
	}

	client := s.outboundClient(15 * time.Second)

	if req.Batch {
		if strings.TrimSpace(req.BaseURL) != "" {
			if storedProv != nil && !matchesStoredProviderBaseURL(req.BaseURL, storedProv) {
				for _, k := range provCfg.APIKeys {
					if k != nil && k.Origin == "vault" {
						w.WriteHeader(http.StatusForbidden)
						_ = json.NewEncoder(w).Encode(map[string]any{
							"ok":    false,
							"error": "cannot override base_url when using a vault-managed key",
						})
						return
					}
				}
			}
			provCfg.BaseURL = strings.TrimSpace(req.BaseURL)
		}

		results := provider.BatchTestKeys(r.Context(), client, provCfg, req.Model)
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
	var resolvedVaultKey bool
	if (apiKey == "" || config.IsMaskedSecret(apiKey)) && provCfg != nil {
		if req.KeyLabel != "" {
			for _, k := range provCfg.APIKeys {
				if k != nil && (k.Label == req.KeyLabel || k.ID == req.KeyLabel) {
					apiKey = k.Key
					resolvedVaultKey = k.Origin == "vault"
					break
				}
			}
		}
		if apiKey == "" || config.IsMaskedSecret(apiKey) {
			if len(provCfg.APIKeys) > 0 && provCfg.APIKeys[0] != nil {
				apiKey = provCfg.APIKeys[0].Key
				resolvedVaultKey = provCfg.APIKeys[0].Origin == "vault"
			}
		}
	}

	if strings.TrimSpace(req.BaseURL) != "" {
		if resolvedVaultKey && storedProv != nil && !matchesStoredProviderBaseURL(req.BaseURL, storedProv) {
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":    false,
				"error": "cannot override base_url when using a vault-managed key",
			})
			return
		}
		provCfg.BaseURL = strings.TrimSpace(req.BaseURL)
	}

	testReq := provider.TestRequest{
		Provider: provCfg,
		BaseURL:  provCfg.BaseURL,
		APIKey:   apiKey,
		Protocol: req.Protocol,
		Model:    req.Model,
	}

	results := provider.TestEndpoint(r.Context(), client, testReq)
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

	primaryKey := s.authMgr.GetClientKey()

	masked := ""
	if primaryKey != "" {
		masked = provider.MaskKey(primaryKey)
	}

	endpoints := []string{
		"/v1/chat/completions",
		"/v1/messages",
		"/v1/responses",
		"/v1/models",
		"/v1/ocr",
		"/v1/embeddings",
		"/v1/rerank",
	}

	modelSet := make(map[string]bool)
	if s.localSrc != nil {
		if snap, _ := s.localSrc.Current(r.Context(), false); snap != nil && snap.Config != nil {
			for m := range snap.Config.AgentModels {
				modelSet[m] = true
			}
			for cat, list := range snap.Config.KBModels {
				if len(list) > 0 {
					modelSet[cat] = true
				}
			}
		}
	}
	var models []string
	for m := range modelSet {
		models = append(models, m)
	}
	sort.Strings(models)
	if models == nil {
		models = []string{}
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":                    true,
		"mode":                  "unified",
		"client_key_configured": primaryKey != "",
		"client_key_masked":     masked,
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
	if req.Generate {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		newKey = "sk-llmproxy-" + hex.EncodeToString(b)
	}

	var savedVersion int64
	if s.localSrc != nil {
		snap, _ := s.localSrc.Current(r.Context(), false)
		var clonedCfg types.ProxyConfig
		if snap != nil && snap.Config != nil {
			raw, _ := json.Marshal(snap.Config)
			_ = json.Unmarshal(raw, &clonedCfg)
		}
		clonedCfg.Settings.ClientKey = newKey
		clonedCfg.Settings.ProxyAPIKey = newKey
		savedSnap, err := s.localSrc.SaveConfig(&clonedCfg)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}
		if savedSnap != nil && savedSnap.Config != nil {
			savedVersion = savedSnap.Config.Version
		}
	}

	s.authMgr.SetClientKey(newKey)

	masked := ""
	if newKey != "" {
		masked = provider.MaskKey(newKey)
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":         true,
		"_version":   savedVersion,
		"client_key": newKey,
		"masked":     masked,
	})
}
