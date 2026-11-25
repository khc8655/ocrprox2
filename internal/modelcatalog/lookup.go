// Package modelcatalog answers "what can this model do?" for a (preset, model)
// pair, using the slim models.dev catalog produced by
// scripts/model-catalog/build-catalog.mjs plus the hand-maintained overrides.
//
// Lookup order (see docs/ADMIN_UI_BACKEND_CONTRACT.md and the phase brief):
//  1. overrides.json, key "<presetID>/<modelID>" — field-by-field, missing
//     fields fall through to the next level;
//  2. provider-map.json providers[presetID], an ordered list of models.dev
//     provider ids; the first provider that actually contains the model wins
//     (an exact id match is preferred across ALL candidates before a
//     case-insensitive match is attempted);
//  3. otherwise not found — callers fall back to their own defaults. There is
//     no implicit "same name" rule: the map is the only routing table.
//
// The catalog is immutable after construction, so every method is safe for
// concurrent use. Methods tolerate a nil receiver and return "unknown" instead
// of panicking: a broken cache file must never take down the admin plane.
package modelcatalog

import (
	"sort"
	"strings"
)

// ModelInfo is one model's capability, compact enough to keep ~9k models well
// under 2 MB of resident heap. Zero values mean "unknown":
//   - ContextTokens/OutputTokens 0 = upstream did not publish a limit;
//   - Reasoning false = upstream says the model is not a reasoning model (or
//     the model is not in the catalog at all — callers must consult Lookup's
//     ok before treating false as authoritative).
//
// The json tags define the wire shape a future capability endpoint returns;
// see contractNotes in the phase report.
type ModelInfo struct {
	ContextTokens int               `json:"context_tokens,omitempty"`
	OutputTokens  int               `json:"output_tokens,omitempty"`
	Reasoning     bool              `json:"reasoning"`
	Options       []ReasoningOption `json:"reasoning_options,omitempty"`
	Family        string            `json:"family,omitempty"`
	ReleaseDate   string            `json:"release_date,omitempty"`
}

// ReasoningOption is one entry of a model's reasoning_options, reduced to the
// four whitelisted keys the build script keeps. Type is one of "effort",
// "toggle" or "budget_tokens". Values is shared between models with the same
// option set and must be treated as read-only. The json tags match the source
// artifact, so re-encoding an option round-trips to the catalog.json shape.
type ReasoningOption struct {
	Type   string   `json:"type"`
	Values []string `json:"values,omitempty"`
	Min    int      `json:"min,omitempty"`
	Max    int      `json:"max,omitempty"`
}

// Catalog is the compact in-memory projection of catalog.json + provider-map.json
// + overrides.json. Providers/models are stored by value; strings and option
// slices are interned so 8,968 models stay far below the raw JSON footprint.
type Catalog struct {
	FetchedAt  string // ISO8601 UTC from the source catalog (or local cache)
	ModelCount int    // models actually loaded
	Source     string // "models.dev" or empty

	providers   map[string]*providerModels // models.dev provider id -> its models
	overrides   map[string]overrideEntry
	providerMap map[string][]string // preset id -> ordered models.dev provider ids

	rawBytes int64 // uncompressed size of the parsed document (Status.Bytes)
}

// providerModels holds one provider's models as sorted parallel slices. A
// map[string]ModelInfo would cost ~430 KB of hash/bucket overhead across 8,968
// entries and push the resident catalog toward the raw JSON size; a sorted
// slice binary-searches in O(log n) with none of it.
type providerModels struct {
	ids   []string // sorted ascending
	infos []ModelInfo
}

func (p *providerModels) find(id string) (ModelInfo, bool) {
	i := sort.SearchStrings(p.ids, id)
	if i < len(p.ids) && p.ids[i] == id {
		return p.infos[i], true
	}
	return ModelInfo{}, false
}

// findFold returns the case-insensitive match with the smallest id, so the
// answer never depends on map iteration order.
func (p *providerModels) findFold(id string) (ModelInfo, bool) {
	for i, cand := range p.ids {
		if strings.EqualFold(cand, id) {
			return p.infos[i], true
		}
	}
	return ModelInfo{}, false
}

// overrideEntry keeps which fields an override actually wrote: a missing
// reasoning=false must not clobber a catalog reasoning=true.
type overrideEntry struct {
	info ModelInfo

	hasContext  bool
	hasOutput   bool
	hasReason   bool
	hasOptions  bool
	hasFamily   bool
	hasReleased bool
}

func (o overrideEntry) any() bool {
	return o.hasContext || o.hasOutput || o.hasReason || o.hasOptions || o.hasFamily || o.hasReleased
}

// resolution is the merged answer for one (preset, model) pair plus the
// provenance the derived helpers need (which models.dev provider matched).
type resolution struct {
	info       ModelInfo
	ok         bool
	providerID string // models.dev provider that supplied the base record
	override   bool   // an override contributed at least one field
}

func (r resolution) hasOptions() bool { return len(r.info.Options) > 0 }

// resolve applies the override -> provider-map -> case-insensitive order.
func (c *Catalog) resolve(presetID, modelID string) resolution {
	if c == nil {
		return resolution{}
	}
	presetID = strings.TrimSpace(presetID)
	modelID = strings.TrimSpace(modelID)
	if presetID == "" || modelID == "" {
		return resolution{}
	}

	var out resolution
	if info, prov, ok := c.lookupModelsDev(presetID, modelID); ok {
		out.info, out.providerID, out.ok = info, prov, true
	}

	ov, hasOv := c.overrides[presetID+"/"+modelID]
	if !hasOv || !ov.any() {
		return out
	}
	out.override = true
	out.ok = true
	if ov.hasContext {
		out.info.ContextTokens = ov.info.ContextTokens
	}
	if ov.hasOutput {
		out.info.OutputTokens = ov.info.OutputTokens
	}
	if ov.hasReason {
		out.info.Reasoning = ov.info.Reasoning
	}
	if ov.hasOptions {
		out.info.Options = ov.info.Options
	}
	if ov.hasFamily {
		out.info.Family = ov.info.Family
	}
	if ov.hasReleased {
		out.info.ReleaseDate = ov.info.ReleaseDate
	}
	return out
}

// lookupModelsDev walks the mapped provider candidates in order. Exact ids are
// tried across every candidate first, then a single case-insensitive pass;
// "first hit wins" therefore always means "first candidate in map order".
func (c *Catalog) lookupModelsDev(presetID, modelID string) (ModelInfo, string, bool) {
	candidates := c.providerMap[presetID]
	if len(candidates) == 0 {
		// Empty array = documented gap (provider-map.json _gaps), not an error
		// worth surfacing: the caller just gets the default capability.
		return ModelInfo{}, "", false
	}
	for _, prov := range candidates {
		if models := c.providers[prov]; models != nil {
			if info, ok := models.find(modelID); ok {
				return info, prov, true
			}
		}
	}
	for _, prov := range candidates {
		if models := c.providers[prov]; models != nil {
			if info, ok := models.findFold(modelID); ok {
				return info, prov, true
			}
		}
	}
	return ModelInfo{}, "", false
}

// Lookup returns the merged capability for (presetID, modelID) and whether the
// catalog knows the model at all. A known model may still carry zero values.
func (c *Catalog) Lookup(presetID, modelID string) (ModelInfo, bool) {
	r := c.resolve(presetID, modelID)
	return r.info, r.ok
}

// Efforts returns the discrete reasoning effort levels the model accepts, in
// the source catalog's order. nil means "no discrete levels" — the caller must
// not invent an enum. In particular:
//   - a toggle-only model returns nil; use SupportsToggle to render the switch;
//   - a budget_tokens model returns nil; use BudgetRange;
//   - reasoning=true with no options at all falls back to the newest sibling in
//     the same models.dev provider + family that does publish effort levels
//     (models.dev often adds a model before it annotates the new one);
//   - reasoning=false returns nil.
func (c *Catalog) Efforts(presetID, modelID string) []string {
	r := c.resolve(presetID, modelID)
	if !r.ok {
		return nil
	}
	if vals, ok := effortValues(r.info.Options); ok {
		return append([]string(nil), vals...)
	}
	if !r.info.Reasoning {
		return nil
	}
	if r.hasOptions() {
		// Toggle-only and budget-only models have no effort ladder; do not
		// disguise them as one.
		return nil
	}
	if vals, ok := c.familyEfforts(r); ok {
		return append([]string(nil), vals...)
	}
	return nil
}

// SupportsToggle reports whether the model exposes a plain on/off reasoning switch.
func (c *Catalog) SupportsToggle(presetID, modelID string) bool {
	r := c.resolve(presetID, modelID)
	for _, o := range r.info.Options {
		if o.Type == "toggle" {
			return true
		}
	}
	return false
}

// BudgetRange reports the token budget window for budget_tokens models. A zero
// bound means the source did not publish that bound (either side may be zero).
func (c *Catalog) BudgetRange(presetID, modelID string) (min, max int, ok bool) {
	r := c.resolve(presetID, modelID)
	for _, o := range r.info.Options {
		if o.Type == "budget_tokens" {
			return o.Min, o.Max, true
		}
	}
	return 0, 0, false
}

// Capability is the single-shot answer used by the admin API: the merged
// ModelInfo plus the derived presentation fields, resolved in one pass.
type Capability struct {
	ModelInfo
	Found          bool
	Efforts        []string // nil = no discrete levels
	SupportsToggle bool
	BudgetMin      int
	BudgetMax      int
	HasBudget      bool
	FromOverride   bool
}

// Capability resolves everything an admin UI needs for one (preset, model).
func (c *Catalog) Capability(presetID, modelID string) Capability {
	r := c.resolve(presetID, modelID)
	cap := Capability{ModelInfo: r.info, Found: r.ok, FromOverride: r.override}
	if !r.ok {
		return cap
	}
	if vals, ok := effortValues(r.info.Options); ok {
		cap.Efforts = append([]string(nil), vals...)
	} else if r.info.Reasoning && !r.hasOptions() {
		if vals, ok := c.familyEfforts(r); ok {
			cap.Efforts = append([]string(nil), vals...)
		}
	}
	for _, o := range r.info.Options {
		switch o.Type {
		case "toggle":
			cap.SupportsToggle = true
		case "budget_tokens":
			cap.HasBudget = true
			cap.BudgetMin, cap.BudgetMax = o.Min, o.Max
		}
	}
	return cap
}

func effortValues(opts []ReasoningOption) ([]string, bool) {
	for _, o := range opts {
		if o.Type == "effort" && len(o.Values) > 0 {
			return o.Values, true
		}
	}
	return nil, false
}

// familyEfforts finds the nearest relative: same models.dev provider, same
// family, release_date not later than the target (an empty candidate date
// counts as not later), and the candidate publishes effort values. Among those,
// the newest release_date wins; an identical date breaks the tie on the larger
// model id (lexicographic).
func (c *Catalog) familyEfforts(r resolution) ([]string, bool) {
	if r.providerID == "" || r.info.Family == "" {
		return nil, false
	}
	models := c.providers[r.providerID]
	if models == nil {
		return nil, false
	}
	bestID, bestDate := "", ""
	var best []string
	for i, info := range models.infos {
		id := models.ids[i]
		if info.Family != r.info.Family || info.ReleaseDate > r.info.ReleaseDate {
			continue
		}
		vals, ok := effortValues(info.Options)
		if !ok {
			continue
		}
		if best == nil || info.ReleaseDate > bestDate || (info.ReleaseDate == bestDate && id > bestID) {
			bestID, bestDate, best = id, info.ReleaseDate, vals
		}
	}
	if best == nil {
		return nil, false
	}
	return best, true
}

// effortRank is the single ladder every provider's levels are mapped onto.
// Anything outside it is treated as unknown and skipped.
var effortRank = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

func rankOf(level string) int {
	l := strings.ToLower(strings.TrimSpace(level))
	switch l {
	case "light":
		l = "low"
	case "extra_high":
		l = "xhigh"
	}
	for i, r := range effortRank {
		if r == l {
			return i
		}
	}
	return -1
}

// NearestEffort maps a requested effort onto a model's supported ladder.
//
// The returned value is always one of levels when a mapping happened (so the
// caller's spelling of that level is preserved), and want itself when no
// mapping is possible:
//   - levels empty, want not on the ladder, or levels already contains want
//     (alias- and case-insensitively) -> want;
//   - otherwise the level with the smallest rank distance; a tie picks the
//     higher rank (round up);
//   - "none" is never a mapping target unless want itself is "none";
//   - unrecognized level names in levels are skipped.
//
// Examples: xhigh over [low medium high max] -> max; medium over [low high] ->
// high; none over [low high] -> low; low over [high] -> high; light over
// [minimal low] -> low.
func NearestEffort(want string, levels []string) string {
	raw := strings.TrimSpace(want)
	if len(levels) == 0 {
		return want
	}
	wantRank := rankOf(raw)
	if wantRank < 0 {
		return want
	}
	for _, l := range levels {
		if rankOf(l) == wantRank {
			return l
		}
	}

	bestRank, bestDist := -1, 0
	for _, l := range levels {
		rank := rankOf(l)
		if rank < 0 {
			continue
		}
		if rank == 0 && wantRank != 0 {
			// "none" is a switch-off, not a quality level: never map onto it.
			continue
		}
		dist := rank - wantRank
		if dist < 0 {
			dist = -dist
		}
		if bestRank < 0 || dist < bestDist || (dist == bestDist && rank > bestRank) {
			bestRank, bestDist = rank, dist
		}
	}
	if bestRank < 0 {
		return want
	}
	for _, l := range levels {
		if rankOf(l) == bestRank {
			return l
		}
	}
	return want
}
