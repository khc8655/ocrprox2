package admin

// Node-local model catalog endpoints (Full only):
//
//	GET  /api/admin/model-catalog        status of the catalog this node uses
//	POST /api/admin/model-catalog/sync   pull the Hub's catalog into the local cache
//	POST /api/admin/model-catalog/lookup capability of one (preset, model) pair
//
// The catalog itself is a CACHE, not configuration: it lives in its own file
// (modelcatalog.CacheFileName) beside proxy_config.enc and is deliberately
// absent from both export and import (see README section "导出配置" — export
// serializes only types.ProxyConfig, which has no catalog field at all, and
// import unmarshals into types.ProxyConfig, so a catalog blob in an import
// payload is an unknown field and is dropped).
//
// /sync resolves the Hub with the same credentials the vault endpoints use
// (stored Vault config or CLI/env defaults); the caller can never supply a Hub
// URL, and the node only ever sends its node token — never the Hub admin
// password, which the node must not hold (AGENT_DEPLOY_GUIDE §7).

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/khc8655/llmproxy2/internal/modelcatalog"
)

// maxCatalogPullBytes is one byte over the store ceiling: reading one excess
// byte is enough to reject an oversized response without buffering it all.
const maxCatalogPullBytes = modelcatalog.MaxCatalogBytes + 1

// SetModelCatalogStore attaches the node-local catalog store. Called on Full
// nodes only; leaving it unset makes the three endpoints report "unavailable"
// rather than panicking.
func (s *Server) SetModelCatalogStore(store *modelcatalog.Store) {
	s.catalogStore = store
}

// catalogHubURL is the Hub base URL for a catalog pull. It reuses the vault
// credential resolution verbatim: stored config, then CLI/env default, with the
// masked-token recovery in between.
func (s *Server) catalogHubURL(r *http.Request) (string, string, error) {
	snap, _ := s.localSrc.Current(r.Context(), false)
	hubURL, nodeToken := s.resolveVaultCredentials(snap, "", "")
	if hubURL == "" {
		return "", "", errors.New("vault hub url not configured")
	}
	return hubURL, nodeToken, nil
}

// handleModelCatalog serves GET /api/admin/model-catalog — the node's own view
// of the catalog (cache vs bundle), not the Hub's.
func (s *Server) handleModelCatalog(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if s.catalogStore == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "catalog_unavailable"})
		return
	}
	st := s.catalogStore.Status()
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":             true,
		"present":        st.Present,
		"source":         st.Source,
		"fetched_at":     st.FetchedAt,
		"model_count":    st.ModelCount,
		"bytes":          st.Bytes,
		"cache_filename": modelcatalog.CacheFileName,
	})
}

// handleModelCatalogSync serves POST /api/admin/model-catalog/sync.
//
// Failure mapping mirrors the Hub's answers so the console can tell an operator
// what to fix, and never clears the existing catalog (bundle or previous cache):
//
//	Hub 401 -> 502 hub_catalog_auth_required   (node token invalid or disabled)
//	Hub 403 -> 502 hub_catalog_lite_forbidden  (lite nodes cannot pull the catalog)
//	Hub 404 -> 404 catalog_not_found           (Hub has no catalog yet)
//	other   -> 502 hub_catalog_unreachable
//	local validation failure -> 502 catalog_invalid
func (s *Server) handleModelCatalogSync(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	if s.catalogStore == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "catalog_unavailable"})
		return
	}

	hubURL, nodeToken, err := s.catalogHubURL(r)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "vault_hub_not_configured"})
		return
	}

	target := strings.TrimRight(hubURL, "/") + "/api/admin/model-catalog/data"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "hub_catalog_unreachable", "detail": err.Error()})
		return
	}
	if nodeToken != "" {
		req.Header.Set("Authorization", "Bearer "+nodeToken)
	}

	client := s.outboundClient(30 * time.Second)

	resp, err := client.Do(req)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "hub_catalog_unreachable", "detail": err.Error()})
		return
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		// fall through to the body handling below
	case http.StatusUnauthorized:
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "hub_catalog_auth_required"})
		return
	case http.StatusForbidden:
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "hub_catalog_lite_forbidden"})
		return
	case http.StatusNotFound:
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "catalog_not_found"})
		return
	default:
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "hub_catalog_unreachable", "detail": "http_" + strconv.Itoa(resp.StatusCode)})
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxCatalogPullBytes))
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "hub_catalog_unreachable", "detail": "read_failed"})
		return
	}

	st, err := s.catalogStore.SaveFromHub(body)
	if err != nil {
		// Validation ran before the cache file was touched, so the previously
		// active catalog (bundle or older cache) is still serving.
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "catalog_invalid", "detail": err.Error()})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":          true,
		"source":      st.Source,
		"fetched_at":  st.FetchedAt,
		"model_count": st.ModelCount,
		"bytes":       st.Bytes,
	})
}

// handleModelCatalogLookup serves POST /api/admin/model-catalog/lookup with
// {"preset_id":"deepseek","model_id":"deepseek-v4-pro"}. It is the console's
// single-model capability probe: the route never ships the whole catalog.
func (s *Server) handleModelCatalogLookup(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	if s.catalogStore == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "catalog_unavailable"})
		return
	}

	var body struct {
		PresetID string `json:"preset_id"`
		ModelID  string `json:"model_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid json"})
		return
	}
	presetID := strings.TrimSpace(body.PresetID)
	modelID := strings.TrimSpace(body.ModelID)
	if presetID == "" || modelID == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "preset_id and model_id are required"})
		return
	}

	cat := s.catalogStore.Current()
	cap := cat.Capability(presetID, modelID)

	// Resellers expose vendor models under their own provider id (no preset
	// binding), so the exact (preset, model) lookup misses models the catalog
	// knows well. Fall back to a model-id match and say so in the response: the
	// console labels the line "按同名模型" rather than pretending it was exact.
	matchedBy := ""
	matchedProviders, listedByProviders := 0, 0
	if !cap.Found {
		if alt, modal, total := cat.CapabilityByModelID(modelID); alt.Found {
			cap = alt
			matchedBy = "model_id"
			matchedProviders, listedByProviders = modal, total
		}
	}

	// Field names are the console contract: found=false means "not in the
	// catalog", not "no capability" — the caller falls back to its preset rules.
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":              true,
		"found":           cap.Found,
		"preset_id":       presetID,
		"model_id":        modelID,
		"context_tokens":  cap.ContextTokens,
		"output_tokens":   cap.OutputTokens,
		"reasoning":       cap.Reasoning,
		"efforts":         cap.Efforts,
		"supports_toggle": cap.SupportsToggle,
		"has_budget":      cap.HasBudget,
		"budget_min":      cap.BudgetMin,
		"budget_max":      cap.BudgetMax,
		"family":          cap.Family,
		"release_date":    cap.ReleaseDate,
		"from_override":   cap.FromOverride,
		"matched_by":      matchedBy,
		"modal_providers": matchedProviders,
		"listed_by":       listedByProviders,
	})
}
