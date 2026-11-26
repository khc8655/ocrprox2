package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

// provider_sync.go implements the two Full-only preset maintenance endpoints of
// contract C (2026-11):
//
//   - GET  /api/admin/providers/preset-status — per-provider preset freshness.
//   - POST /api/admin/providers/sync          — operator-clicked one-click update.
//
// Neither endpoint runs on a timer, a startup hook, or any automatic trigger: the sync
// only happens inside an explicit POST from the console.

// presetStatusRow is one provider row of GET /api/admin/providers/preset-status.
type presetStatusRow struct {
	ID             string `json:"id"`
	Origin         string `json:"origin"`
	PresetID       string `json:"preset_id"`
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	HasUpdate      bool   `json:"has_update"`
	Note           string `json:"note"`
}

// syncUpdatedRow reports one provider the one-click update actually changed.
type syncUpdatedRow struct {
	ID          string `json:"id"`
	FromVersion string `json:"from_version"`
	ToVersion   string `json:"to_version"`
	KeysAdded   int    `json:"keys_added"`
	KeysRemoved int    `json:"keys_removed"`
}

// syncSkippedRow reports one provider deliberately left untouched (with the reason).
type syncSkippedRow struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// syncErrorRow reports one provider that failed; other providers still ran.
type syncErrorRow struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

// providerOrigin returns the effective origin of a provider: legacy empty origin means
// local (same predicate MergeVaultConfig and the vault lock use).
func providerOrigin(p *types.ProviderConfig) string {
	if p == nil {
		return "local"
	}
	if p.Origin == "vault" {
		return "vault"
	}
	return "local"
}

// findPresetEntry looks a preset up in the library by id (trimmed, case-insensitive).
func findPresetEntry(lib presetLibrary, presetID string) *presetEntry {
	id := strings.ToLower(strings.TrimSpace(presetID))
	if id == "" {
		return nil
	}
	return lib.byID[id]
}

// adapterRulesEmpty reports whether rules carry no directives at all (nil or {}).
func adapterRulesEmpty(rules *types.AdapterRules) bool {
	if rules == nil {
		return true
	}
	raw, err := json.Marshal(rules)
	if err != nil {
		return false
	}
	return string(raw) == "{}"
}

// adapterRulesEqual compares two rule sets by their canonical JSON encoding.
func adapterRulesEqual(a, b *types.AdapterRules) bool {
	if adapterRulesEmpty(a) && adapterRulesEmpty(b) {
		return true
	}
	rawA, errA := json.Marshal(a)
	rawB, errB := json.Marshal(b)
	if errA != nil || errB != nil {
		return false
	}
	return bytes.Equal(rawA, rawB)
}

// presetVersionOf returns a provider's recorded preset version, "" for nil.
func presetVersionOf(p *types.ProviderConfig) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(p.PresetVersion)
}

// vaultKeyLabels lists a provider's hub (origin=vault) key labels, using Label with an
// ID fallback — the same identity the manifest and the fetch payload publish.
func vaultKeyLabels(p *types.ProviderConfig) []string {
	if p == nil {
		return nil
	}
	labels := make([]string, 0, len(p.APIKeys))
	for _, k := range p.APIKeys {
		if k == nil || k.Origin != "vault" {
			continue
		}
		lbl := strings.TrimSpace(k.Label)
		if lbl == "" {
			lbl = strings.TrimSpace(k.ID)
		}
		if lbl == "" {
			continue
		}
		labels = append(labels, lbl)
	}
	sort.Strings(labels)
	return labels
}

// labelSetDiff returns how many labels appear in next but not prev (added) and in prev
// but not next (removed).
func labelSetDiff(prev, next []string) (added, removed int) {
	prevSet := make(map[string]bool, len(prev))
	for _, l := range prev {
		prevSet[l] = true
	}
	nextSet := make(map[string]bool, len(next))
	for _, l := range next {
		nextSet[l] = true
	}
	for _, l := range next {
		if !prevSet[l] {
			added++
		}
	}
	for _, l := range prev {
		if !nextSet[l] {
			removed++
		}
	}
	return added, removed
}

// hubPresetVersions fetches the hub manifest and returns provider -> preset_version.
// A connectivity/HTTP failure is returned so callers can put the reason into `note`.
func (s *Server) hubPresetVersions(ctx context.Context, hubURL, nodeToken string) (map[string]string, error) {
	target := strings.TrimRight(hubURL, "/") + "/api/vault/manifest"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	if nodeToken != "" {
		req.Header.Set("Authorization", "Bearer "+nodeToken)
	}
	resp, err := s.outboundClient(15 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hub manifest returned HTTP %d", resp.StatusCode)
	}
	var parsed struct {
		OK        bool `json:"ok"`
		Providers map[string]struct {
			PresetID      string `json:"preset_id"`
			PresetVersion string `json:"preset_version"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("hub manifest is not valid JSON: %w", err)
	}
	versions := make(map[string]string, len(parsed.Providers))
	for id, p := range parsed.Providers {
		versions[id] = strings.TrimSpace(p.PresetVersion)
	}
	return versions, nil
}

// handleProvidersPresetStatus serves GET /api/admin/providers/preset-status.
func (s *Server) handleProvidersPresetStatus(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	snap, err := s.localSrc.Current(r.Context(), false)
	if err != nil || snap == nil || snap.Config == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "config unavailable"})
		return
	}

	lib := builtinPresetLibrary()
	rows := make([]presetStatusRow, 0, len(snap.Config.Providers))

	// Hub preset versions are only needed when at least one vault provider exists.
	var (
		hubVersions   map[string]string
		hubErr        error
		hubFetched    bool
		hubConfigured bool
	)
	for _, p := range snap.Config.Providers {
		if providerOrigin(p) == "vault" {
			hubConfigured = true
			break
		}
	}
	if hubConfigured {
		hubURL, nodeToken := s.resolveVaultCredentials(snap, "", "")
		if hubURL == "" {
			hubErr = errors.New("vault hub url not configured")
		} else {
			hubVersions, hubErr = s.hubPresetVersions(r.Context(), hubURL, nodeToken)
			hubFetched = hubErr == nil
		}
	}

	ids := make([]string, 0, len(snap.Config.Providers))
	for id := range snap.Config.Providers {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		p := snap.Config.Providers[id]
		if p == nil {
			continue
		}
		row := presetStatusRow{
			ID:       id,
			Origin:   providerOrigin(p),
			PresetID: strings.TrimSpace(p.PresetID),
			// CurrentVersion records which preset version the rules on this node came
			// from — for hub providers it is the version stamped at the last fetch.
			CurrentVersion: presetVersionOf(p),
		}
		if row.Origin == "vault" {
			switch {
			case hubErr != nil:
				row.Note = hubErr.Error()
			case hubFetched:
				latest, ok := hubVersions[id]
				if !ok {
					row.Note = "中枢清单未返回此供应商"
					break
				}
				row.LatestVersion = latest
				if latest == "" {
					row.Note = "中枢未返回预设版本"
					break
				}
				row.HasUpdate = latest != row.CurrentVersion
			}
			rows = append(rows, row)
			continue
		}

		entry := findPresetEntry(lib, p.PresetID)
		if row.PresetID == "" || strings.EqualFold(row.PresetID, "custom") {
			row.Note = "未绑定预设"
			rows = append(rows, row)
			continue
		}
		if entry == nil {
			row.Note = "内置预设库无此预设"
			rows = append(rows, row)
			continue
		}
		row.LatestVersion = strings.TrimSpace(entry.Version)
		if row.LatestVersion == "" {
			row.Note = "预设无版本信息"
			rows = append(rows, row)
			continue
		}
		row.HasUpdate = row.LatestVersion != row.CurrentVersion
		rows = append(rows, row)
	}

	updateCount := 0
	for _, row := range rows {
		if row.HasUpdate {
			updateCount++
		}
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":           true,
		"update_count": updateCount,
		"providers":    rows,
	})
}

// fetchHubProviderForSync asks the hub for one provider's full payload (rules + hub
// keys). Mirrors handleVaultFetch's request shape but keeps failures per provider.
func (s *Server) fetchHubProviderForSync(ctx context.Context, hubURL, nodeToken, providerID string) (*types.ProviderConfig, error) {
	target := strings.TrimRight(hubURL, "/") + "/api/vault/fetch"
	payload, _ := json.Marshal(map[string]any{"provider": providerID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if nodeToken != "" {
		req.Header.Set("Authorization", "Bearer "+nodeToken)
	}
	resp, err := s.outboundClient(15 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hub fetch returned HTTP %d", resp.StatusCode)
	}
	var parsed struct {
		OK             bool            `json:"ok"`
		Provider       string          `json:"provider"`
		ProviderConfig json.RawMessage `json:"provider_config"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("hub fetch response is not valid JSON: %w", err)
	}
	if !parsed.OK || len(parsed.ProviderConfig) == 0 || string(parsed.ProviderConfig) == "null" {
		return nil, errors.New("hub fetch did not return a provider_config")
	}
	pc, err := decodeVaultProviderConfig(providerID, parsed.ProviderConfig)
	if err != nil {
		return nil, err
	}
	// Hub payload keys are hub keys by definition: decodeVaultProviderConfig only marks
	// the "keys" map branch, so an api_keys[] array arrives with an empty origin.
	// Normalize before the key add/remove diff reads it (MergeVaultConfig stabilizes
	// them to origin=vault on landing either way).
	for _, k := range pc.APIKeys {
		if k != nil {
			k.Origin = "vault"
		}
	}
	return pc, nil
}

// applyLocalPresetUpdates rewrites adapter_rules / preset_id / preset_version for the
// node's local providers on a cloned config. Pure in-memory: the caller saves once.
//
// Contract C semantics for a local provider:
//   - bound preset, rules empty                  -> adopt the current preset rules
//   - bound preset, rules equal the current preset rules -> only refresh preset_version
//   - bound preset, rules anything else          -> SKIP ("规则已手动修改，未覆盖")
//   - unbound provider                           -> bind by rule A (then adopt rules if empty)
//
// The library keeps only the CURRENT rules per preset (no version history on the node),
// so "still equals the rules of the recorded preset_version" can only be proven against
// the current rules; anything else is treated as a hand edit and left alone.
func applyLocalPresetUpdates(cfg *types.ProxyConfig, lib presetLibrary) (updated []syncUpdatedRow, skipped []syncSkippedRow, changed bool) {
	updated = make([]syncUpdatedRow, 0, 4)
	skipped = make([]syncSkippedRow, 0, 4)

	ids := make([]string, 0, len(cfg.Providers))
	for id := range cfg.Providers {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		p := cfg.Providers[id]
		if p == nil || providerOrigin(p) != "local" {
			continue
		}
		presetID := strings.TrimSpace(p.PresetID)

		// 1) Operator explicitly asked for no preset binding.
		if strings.EqualFold(presetID, "custom") {
			skipped = append(skipped, syncSkippedRow{ID: id, Reason: "已选择自定义（不绑定预设）"})
			continue
		}

		// 2) Unbound provider: try to bind by rule A.
		if presetID == "" {
			matched := matchPresetRuleA(presetMatchInput{
				ID:       id,
				Name:     p.Name,
				BaseURL:  p.BaseURL,
				PresetID: p.PresetID,
			}, lib)
			if matched == "" {
				skipped = append(skipped, syncSkippedRow{ID: id, Reason: "未匹配到预设"})
				continue
			}
			entry := findPresetEntry(lib, matched)
			if entry == nil {
				skipped = append(skipped, syncSkippedRow{ID: id, Reason: "未匹配到预设"})
				continue
			}
			toVersion := strings.TrimSpace(entry.Version)
			fromVersion := presetVersionOf(p)
			p.PresetID = entry.ID
			if adapterRulesEmpty(p.AdapterRules) && entry.AdapterRules != nil {
				rulesCopy := *entry.AdapterRules
				p.AdapterRules = &rulesCopy
			}
			p.PresetVersion = toVersion
			changed = true
			updated = append(updated, syncUpdatedRow{
				ID:          id,
				FromVersion: fromVersion,
				ToVersion:   toVersion,
			})
			continue
		}

		// 3) Bound preset must exist in the library.
		entry := findPresetEntry(lib, presetID)
		if entry == nil {
			skipped = append(skipped, syncSkippedRow{ID: id, Reason: "预设不存在于内置库"})
			continue
		}
		latest := strings.TrimSpace(entry.Version)
		current := presetVersionOf(p)

		// Rules that are neither empty nor the current preset rules were hand-edited:
		// never overwrite them.
		presetOwned := adapterRulesEmpty(p.AdapterRules) || adapterRulesEqual(p.AdapterRules, entry.AdapterRules)
		if !presetOwned {
			skipped = append(skipped, syncSkippedRow{ID: id, Reason: "规则已手动修改，未覆盖"})
			continue
		}
		if latest == "" {
			// The preset ships no adapter file (no version): there is no version to
			// record or compare, so the provider is left as-is rather than reported as
			// an empty "" -> "" update.
			skipped = append(skipped, syncSkippedRow{ID: id, Reason: "预设无版本信息"})
			continue
		}
		if latest == current {
			skipped = append(skipped, syncSkippedRow{ID: id, Reason: "已是最新版本"})
			continue
		}
		if adapterRulesEmpty(p.AdapterRules) && entry.AdapterRules != nil {
			rulesCopy := *entry.AdapterRules
			p.AdapterRules = &rulesCopy
		} else if !adapterRulesEmpty(p.AdapterRules) && !adapterRulesEqual(p.AdapterRules, entry.AdapterRules) {
			// Rules were the preset's, and a new preset version changed them.
			if entry.AdapterRules != nil {
				rulesCopy := *entry.AdapterRules
				p.AdapterRules = &rulesCopy
			} else {
				p.AdapterRules = nil
			}
		}
		p.PresetVersion = latest
		changed = true
		updated = append(updated, syncUpdatedRow{
			ID:          id,
			FromVersion: current,
			ToVersion:   latest,
		})
	}
	return updated, skipped, changed
}

// handleProvidersSync serves POST /api/admin/providers/sync.
func (s *Server) handleProvidersSync(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	snap, err := s.localSrc.Current(r.Context(), false)
	if err != nil || snap == nil || snap.Config == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "config unavailable"})
		return
	}

	lib := builtinPresetLibrary()
	updated := make([]syncUpdatedRow, 0, 8)
	skipped := make([]syncSkippedRow, 0, 8)
	failed := make([]syncErrorRow, 0, 4)

	// --- Local providers: preset rule / binding maintenance, one atomic save ---------
	cloneRaw, err := json.Marshal(snap.Config)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	var clone types.ProxyConfig
	if err := json.Unmarshal(cloneRaw, &clone); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}

	localUpdated, localSkipped, localChanged := applyLocalPresetUpdates(&clone, lib)
	skipped = append(skipped, localSkipped...)
	if localChanged {
		if _, saveErr := s.localSrc.SaveConfig(&clone); saveErr != nil {
			for _, row := range localUpdated {
				failed = append(failed, syncErrorRow{ID: row.ID, Error: saveErr.Error()})
			}
		} else {
			updated = append(updated, localUpdated...)
		}
	}

	// --- Hub-managed providers: wholesale re-fetch, local keys preserved --------------
	var vaultIDs []string
	for id, p := range snap.Config.Providers {
		if p != nil && providerOrigin(p) == "vault" {
			vaultIDs = append(vaultIDs, id)
		}
	}
	sort.Strings(vaultIDs)

	if len(vaultIDs) > 0 {
		snap, err = s.localSrc.Current(r.Context(), false)
		if err != nil || snap == nil || snap.Config == nil {
			for _, id := range vaultIDs {
				failed = append(failed, syncErrorRow{ID: id, Error: "config unavailable"})
			}
			vaultIDs = nil
		}
	}
	if len(vaultIDs) > 0 {
		hubURL, nodeToken := s.resolveVaultCredentials(snap, "", "")
		if hubURL == "" {
			for _, id := range vaultIDs {
				failed = append(failed, syncErrorRow{ID: id, Error: "vault hub url not configured"})
			}
		} else {
			// One provider per merge call: MergeVaultConfig is all-or-nothing for the
			// batch it receives, so batching would let one provider's failure fail the
			// others. Contract C requires per-provider isolation ("供应商之间互不影响").
			for _, id := range vaultIDs {
				pc, fetchErr := s.fetchHubProviderForSync(r.Context(), hubURL, nodeToken, id)
				if fetchErr != nil {
					failed = append(failed, syncErrorRow{ID: id, Error: fetchErr.Error()})
					continue
				}
				// The pre-merge snapshot supplies the "before" side of the report; a
				// prior provider's merge has already moved the live config forward, so
				// re-read it to keep from_version/keys_removed honest.
				cur, curErr := s.localSrc.Current(r.Context(), false)
				if curErr != nil || cur == nil || cur.Config == nil {
					failed = append(failed, syncErrorRow{ID: id, Error: "config unavailable"})
					continue
				}
				oldP := cur.Config.Providers[id]
				added, removed := labelSetDiff(vaultKeyLabels(oldP), vaultKeyLabels(pc))
				if _, mergeErr := s.localSrc.MergeVaultConfig(map[string]*types.ProviderConfig{id: pc}, true); mergeErr != nil {
					failed = append(failed, syncErrorRow{ID: id, Error: mergeErr.Error()})
					continue
				}
				updated = append(updated, syncUpdatedRow{
					ID:          id,
					FromVersion: presetVersionOf(oldP),
					ToVersion:   strings.TrimSpace(pc.PresetVersion),
					KeysAdded:   added,
					KeysRemoved: removed,
				})
			}
		}
	}

	sort.Slice(skipped, func(i, j int) bool { return skipped[i].ID < skipped[j].ID })
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"updated": updated,
		"skipped": skipped,
		"errors":  failed,
	})
}
