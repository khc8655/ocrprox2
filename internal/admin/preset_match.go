package admin

import (
	"net/url"
	"strings"

	"github.com/khc8655/llmproxy2/internal/provider"
	"github.com/khc8655/llmproxy2/internal/types"
)

// Preset auto-match (rule A of the cross-runtime preset-binding contract).
//
// The SAME order and the SAME inputs are implemented in three places and must stay in
// lockstep: edgeone-hub/lib/presetbind.js (the hub), shared/admin/js/app.js (the console,
// matchPresetRules) and this file (the Full node). This Go copy feeds the one-click
// providers sync (POST /api/admin/providers/sync), which binds local providers that never
// got a preset_id.
//
// Inputs: a provider's id, name, base_url and preset library entries (id / name /
// base_url / version).
//
// Order:
//  1. preset_id === "custom"            -> the operator explicitly chose not to bind.
//  2. existing preset_id found in the
//     library                          -> keep it.
//  3. lowercase hostname of base_url equals a preset's base_url hostname (presets whose
//     base_url contains a "{" placeholder are skipped). A single hit wins; several hits
//     are resolved by 4)/5) among those candidates ONLY — an unresolved tie stays
//     unbound.
//  4. provider id (lowercase) equals a preset id (whole library).
//  5. provider name (lowercase, trimmed) equals a preset name (lowercase) or a preset id.
//  6. nothing matched                   -> unbound (the UI shows「自定义」).

// presetEntry is the projection of one preset the matcher needs.
type presetEntry struct {
	ID           string
	Name         string
	BaseURL      string
	Version      string
	AdapterRules *types.AdapterRules
}

// presetLibrary is the matcher's preset source: ordered list plus an id index.
type presetLibrary struct {
	list []*presetEntry
	byID map[string]*presetEntry
}

func newPresetLibrary(entries []presetEntry) presetLibrary {
	lib := presetLibrary{byID: make(map[string]*presetEntry, len(entries))}
	for i := range entries {
		e := &entries[i]
		lib.list = append(lib.list, e)
		lib.byID[strings.ToLower(strings.TrimSpace(e.ID))] = e
	}
	return lib
}

// builtinPresetLibrary builds the matcher library from the node's built-in preset catalog
// (internal/provider/presets.go) — the only preset source a released Full binary ships.
func builtinPresetLibrary() presetLibrary {
	catalog := provider.Catalog()
	entries := make([]presetEntry, 0, len(catalog))
	for _, p := range catalog {
		entries = append(entries, presetEntry{
			ID:           p.ID,
			Name:         p.Name,
			BaseURL:      p.BaseURL,
			Version:      p.Version,
			AdapterRules: p.AdapterRules,
		})
	}
	return newPresetLibrary(entries)
}

// presetMatchInput is the provider side of rule A.
type presetMatchInput struct {
	ID       string
	Name     string
	BaseURL  string
	PresetID string
}

// baseURLHost returns the lowercase hostname of a base URL, or "" when it cannot be
// parsed. Mirrors the hub/console presetHostname(): a URL without a scheme fails there,
// so it is treated as "no host" here too (url.Parse would put it in Path).
func baseURLHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

func pickPresetByID(cands []*presetEntry, key string) *presetEntry {
	if key == "" {
		return nil
	}
	for _, e := range cands {
		if strings.ToLower(strings.TrimSpace(e.ID)) == key {
			return e
		}
	}
	return nil
}

// pickPresetByName implements step 5 over a candidate set: provider name equals the
// preset name OR the preset id.
func pickPresetByName(cands []*presetEntry, key string) *presetEntry {
	if key == "" {
		return nil
	}
	for _, e := range cands {
		if n := strings.ToLower(strings.TrimSpace(e.Name)); n != "" && n == key {
			return e
		}
		if strings.ToLower(strings.TrimSpace(e.ID)) == key {
			return e
		}
	}
	return nil
}

// matchPresetRuleA returns the preset id to bind ("" = stay unbound).
func matchPresetRuleA(in presetMatchInput, lib presetLibrary) string {
	// 1) Explicit "custom" — the operator said no binding.
	if strings.EqualFold(strings.TrimSpace(in.PresetID), "custom") {
		return ""
	}
	// 2) An existing preset_id that still exists in the library wins.
	if cur := strings.TrimSpace(in.PresetID); cur != "" {
		if e, ok := lib.byID[strings.ToLower(cur)]; ok {
			return e.ID
		}
	}

	idKey := strings.ToLower(strings.TrimSpace(in.ID))
	nameKey := strings.ToLower(strings.TrimSpace(in.Name))

	// 3) Hostname match; placeholder presets never win a host match.
	var hostCandidates []*presetEntry
	if host := baseURLHost(in.BaseURL); host != "" {
		for _, e := range lib.list {
			if strings.Contains(e.BaseURL, "{") {
				continue
			}
			if baseURLHost(e.BaseURL) == host {
				hostCandidates = append(hostCandidates, e)
			}
		}
	}
	switch len(hostCandidates) {
	case 1:
		return hostCandidates[0].ID
	case 0:
		// fall through to 4)/5) over the whole library
	default:
		// 4)/5) pick among the same-host candidates ONLY; an unresolved tie stays unbound.
		if e := pickPresetByID(hostCandidates, idKey); e != nil {
			return e.ID
		}
		if e := pickPresetByName(hostCandidates, nameKey); e != nil {
			return e.ID
		}
		return ""
	}

	// 4) provider id === preset id.
	if e := pickPresetByID(lib.list, idKey); e != nil {
		return e.ID
	}
	// 5) provider name === preset name or preset id.
	if e := pickPresetByName(lib.list, nameKey); e != nil {
		return e.ID
	}
	return ""
}
