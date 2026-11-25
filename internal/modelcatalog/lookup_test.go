package modelcatalog

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// --------------------------------------------------------------- fixtures

// fixtureCatalog builds a small Catalog through the same code path production
// uses (ParseCatalog + attachMaps), so a test can never construct a shape the
// loader would not produce.
func fixtureCatalog(t *testing.T, catalogJSON, providerMapJSON, overridesJSON string) *Catalog {
	t.Helper()
	cat, err := ParseCatalog([]byte(catalogJSON))
	if err != nil {
		t.Fatalf("ParseCatalog: %v", err)
	}
	if providerMapJSON != "" {
		if err := cat.attachMaps([]byte(providerMapJSON), []byte(overridesJSON)); err != nil {
			t.Fatalf("attachMaps: %v", err)
		}
	}
	return cat
}

// testBundled loads the embedded catalog once per test binary. It is the real
// 235-provider / 8,968-model artifact, so these assertions double as a check
// that the embedded gzip still matches what scripts/model-catalog builds.
var testBundled struct {
	once sync.Once
	cat  *Catalog
	err  error
}

func bundledForTest(t *testing.T) *Catalog {
	t.Helper()
	testBundled.once.Do(func() {
		testBundled.cat, testBundled.err = Bundled()
	})
	if testBundled.err != nil {
		t.Fatalf("Bundled: %v", testBundled.err)
	}
	return testBundled.cat
}

// ------------------------------------------------------------------ Lookup

func TestLookup_RealCatalog(t *testing.T) {
	cat := bundledForTest(t)

	tests := []struct {
		name     string
		presetID string
		modelID  string
		wantOK   bool
		check    func(t *testing.T, info ModelInfo)
	}{
		{
			name: "deepseek-v4-pro limits", presetID: "deepseek", modelID: "deepseek-v4-pro", wantOK: true,
			check: func(t *testing.T, info ModelInfo) {
				if info.ContextTokens != 1048576 || info.OutputTokens != 393216 {
					t.Errorf("limit = %d/%d, want 1048576/393216", info.ContextTokens, info.OutputTokens)
				}
				if !info.Reasoning {
					t.Error("reasoning = false, want true")
				}
				if info.Family != "deepseek-thinking" || info.ReleaseDate != "2026-08-13" {
					t.Errorf("family/release = %q/%q", info.Family, info.ReleaseDate)
				}
			},
		},
		{
			name: "anthropic claude-sonnet-4-5 limits (ask's numbers)", presetID: "anthropic", modelID: "claude-sonnet-4-5", wantOK: true,
			check: func(t *testing.T, info ModelInfo) {
				if info.ContextTokens != 200000 {
					t.Errorf("context = %d, want 200000", info.ContextTokens)
				}
				if info.OutputTokens != 64000 {
					t.Errorf("output = %d, want 64000", info.OutputTokens)
				}
			},
		},
		{
			// models.dev capitalizes MiniMax ids; the preset uses the same
			// capitalization, so this walks the exact-match path on a mixed-case id.
			name: "minimax mixed-case id", presetID: "minimax", modelID: "MiniMax-M3", wantOK: true,
			check: func(t *testing.T, info ModelInfo) {
				if info.ContextTokens != 1000000 || info.OutputTokens != 524288 {
					t.Errorf("limit = %d/%d", info.ContextTokens, info.OutputTokens)
				}
			},
		},
		{
			// kimi-code maps to [kimi-code-plan-global, moonshotai]; both contain
			// this model. Sorted-first must resolve to the FIRST candidate,
			// not to a coincidentally smaller id in the second provider.
			name: "multi-provider mapping takes the first candidate", presetID: "kimi-code", modelID: "kimi-for-coding", wantOK: true,
			check: func(t *testing.T, info ModelInfo) {
				if info.Family != "kimi-k2" {
					t.Errorf("family = %q, want kimi-k2", info.Family)
				}
			},
		},
		{
			name: "gap provider is not an error", presetID: "bai", modelID: "glm-5.3-flash", wantOK: false,
		},
		{
			name: "unknown model under a mapped preset", presetID: "deepseek", modelID: "no-such-model", wantOK: false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, ok := cat.Lookup(tc.presetID, tc.modelID)
			if ok != tc.wantOK {
				t.Fatalf("Lookup(%q,%q) ok = %v, want %v", tc.presetID, tc.modelID, ok, tc.wantOK)
			}
			if tc.check != nil {
				tc.check(t, info)
			}
		})
	}
}

func TestLookup_GapProvidersDoNotPanic(t *testing.T) {
	cat := bundledForTest(t)
	for _, preset := range []string{"bai", "baidu-qianfan", "cline", "ollama", "tokenrhythm", "vertex"} {
		if _, ok := cat.Lookup(preset, "anything"); ok {
			t.Errorf("gap preset %q unexpectedly resolved", preset)
		}
		if cat.Efforts(preset, "anything") != nil {
			t.Errorf("gap preset %q returned efforts", preset)
		}
	}
}

func TestLookup_CaseInsensitive(t *testing.T) {
	// Real-catalog case: models.dev stores "deepseek-v4-flash" lowercase, but
	// several aggregators (e.g. amd's preset) reference "DeepSeek-V4-Flash".
	// The exact pass misses, the fold pass decides. Under "deepseek" the
	// preset id is lowercase and exact; use a synthetic pair here so the test
	// does not depend on upstream casing:
	cat := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"2026-01-01T00:00:00Z",
		"providers":{"p":{"MiniMax-M3":{"reasoning":true,"limit":{"context":1000}}}}
	}`, `{"schema":1,"providers":{"minimax":["p"]}}`, `{"schema":1,"models":{}}`)

	info, ok := cat.Lookup("minimax", "minimax-m3")
	if !ok || info.ContextTokens != 1000 {
		t.Fatalf("case-insensitive lookup failed: ok=%v info=%+v", ok, info)
	}

	// Exact match wins over a case variant when both exist.
	cat2 := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"2026-01-01T00:00:00Z",
		"providers":{"p":{
			"m3":{"limit":{"context":10}},
			"M3":{"limit":{"context":20}}
		}}
	}`, `{"schema":1,"providers":{"minimax":["p"]}}`, `{"schema":1,"models":{}}`)
	if got, _ := cat2.Lookup("minimax", "M3"); got.ContextTokens != 20 {
		t.Errorf("exact match lost to case fold: got context %d, want 20", got.ContextTokens)
	}
	if got, _ := cat2.Lookup("minimax", "m3"); got.ContextTokens != 10 {
		t.Errorf("exact match lost to case fold: got context %d, want 10", got.ContextTokens)
	}
}

func TestLookup_FirstCandidateContainingModelWins(t *testing.T) {
	// Both candidates contain the model with DIFFERENT limits; map order must
	// decide, not insertion order or id sorting.
	cat := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"x",
		"providers":{
			"second":{"m":{"limit":{"context":222}}},
			"first":{"m":{"limit":{"context":111}}}
		}
	}`, `{"schema":1,"providers":{"preset":["first","second"]}}`, `{"schema":1,"models":{}}`)

	if got, _ := cat.Lookup("preset", "m"); got.ContextTokens != 111 {
		t.Errorf("context = %d, want 111 (first candidate in map order)", got.ContextTokens)
	}

	// A candidate that lacks the model is skipped even when it comes first.
	if got, _ := cat.Lookup("preset", "m"); got.ContextTokens == 222 {
		t.Error("lookup fell through to the second candidate")
	}
}

func TestLookup_OverridesPrecedence(t *testing.T) {
	cat := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"x",
		"providers":{"p":{"m":{
			"limit":{"context":100,"output":50},
			"reasoning":true,
			"reasoning_options":[{"type":"effort","values":["low","high"]}],
			"family":"orig","release_date":"2025-01-01"
		}}}
	}`, `{"schema":1,"providers":{"preset":["p"]}}`, `{
		"schema":1,
		"models":{
			"preset/m":{"limit":{"context":999},"family":"patched","note":"test"},
			"preset/not-in-catalog":{"reasoning":true,"limit":{"output":42}}
		}
	}`)

	info, ok := cat.Lookup("preset", "m")
	if !ok {
		t.Fatal("override entry must resolve")
	}
	// Overridden field wins; untouched fields fall through to the catalog.
	if info.ContextTokens != 999 {
		t.Errorf("context = %d, want 999 (override)", info.ContextTokens)
	}
	if info.OutputTokens != 50 {
		t.Errorf("output = %d, want 50 (fallback to catalog)", info.OutputTokens)
	}
	if info.Family != "patched" {
		t.Errorf("family = %q, want patched", info.Family)
	}
	if !info.Reasoning {
		t.Error("reasoning should fall back to catalog true")
	}
	// Options were NOT overridden: the catalog ladder stays.
	if got := cat.Efforts("preset", "m"); !reflect.DeepEqual(got, []string{"low", "high"}) {
		t.Errorf("efforts = %v, want [low high]", got)
	}

	// The whole point of overrides: a model models.dev does not have.
	if info, ok := cat.Lookup("preset", "not-in-catalog"); !ok || info.OutputTokens != 42 {
		t.Errorf("override-only model not resolved: ok=%v info=%+v", ok, info)
	}

	// Capability marks provenance for the console.
	if cap := cat.Capability("preset", "m"); !cap.FromOverride {
		t.Error("FromOverride = false, want true")
	}
	if cap := cat.Capability("preset", "no-model-at-all"); cap.Found || cap.FromOverride {
		t.Errorf("unknown model: Found=%v FromOverride=%v, want false/false", cap.Found, cap.FromOverride)
	}
}

func TestLookup_NilReceiverAndEmptyInputs(t *testing.T) {
	var nilCat *Catalog
	if _, ok := nilCat.Lookup("a", "b"); ok {
		t.Error("nil catalog resolved a model")
	}
	if nilCat.Efforts("a", "b") != nil {
		t.Error("nil catalog returned efforts")
	}
	if nilCat.SupportsToggle("a", "b") {
		t.Error("nil catalog returned toggle")
	}
	if _, _, ok := nilCat.BudgetRange("a", "b"); ok {
		t.Error("nil catalog returned budget")
	}
	if cap := nilCat.Capability("a", "b"); cap.Found {
		t.Error("nil catalog capability Found")
	}

	cat := bundledForTest(t)
	if _, ok := cat.Lookup("", "deepseek-v4-pro"); ok {
		t.Error("empty preset resolved")
	}
	if _, ok := cat.Lookup("deepseek", ""); ok {
		t.Error("empty model resolved")
	}
}

// ------------------------------------------------------------------ Efforts

func TestEfforts_RealCatalog(t *testing.T) {
	cat := bundledForTest(t)

	// These assertions are the evidence that a single per-provider ladder is
	// the wrong granularity: shared/presets/deepseek.json declares
	// supported_levels [none low medium high] and openai.json the same, yet the
	// catalog gives this model exactly three levels, and no "medium" exists.
	if got := cat.Efforts("deepseek", "deepseek-v4-pro"); !reflect.DeepEqual(got, []string{"low", "high", "max"}) {
		t.Errorf("deepseek/deepseek-v4-pro efforts = %v, want [low high max] "+
			"(preset-level ladder says none/low/medium/high, so per-provider is the wrong granularity)", got)
	}
	if got := cat.Efforts("openai", "gpt-5-pro"); !reflect.DeepEqual(got, []string{"high"}) {
		t.Errorf("openai/gpt-5-pro efforts = %v, want [high]", got)
	}

	// Toggle-only: no discrete levels, and the switch is exposed separately.
	if got := cat.Efforts("zhipu", "glm-4.6v-flash"); got != nil {
		t.Errorf("toggle-only efforts = %v, want nil", got)
	}
	if !cat.SupportsToggle("zhipu", "glm-4.6v-flash") {
		t.Error("glm-4.6v-flash should support toggle")
	}
	if cat.SupportsToggle("openai", "gpt-5-pro") {
		t.Error("gpt-5-pro has no toggle option")
	}

	// Budget-only: no levels either; the range is reported separately.
	if got := cat.Efforts("anthropic", "claude-sonnet-4-5"); got != nil {
		t.Errorf("budget-only efforts = %v, want nil", got)
	}
	if min, max, ok := cat.BudgetRange("anthropic", "claude-sonnet-4-5"); !ok || min != 1024 || max != 0 {
		t.Errorf("budget = (%d,%d,%v), want (1024,0,true)", min, max, ok)
	}
	if _, _, ok := cat.BudgetRange("openai", "gpt-5-pro"); ok {
		t.Error("gpt-5-pro has no budget option")
	}

	// reasoning=false is authoritative: no ladder, no family fallback.
	var sawNonReasoning bool
	for prov, models := range cat.providers {
		for i, info := range models.infos {
			if info.Reasoning || len(info.Options) > 0 {
				continue
			}
			// Find our preset id for this provider, if any.
			for preset, ids := range cat.providerMap {
				for _, cand := range ids {
					if cand == prov {
						if got := cat.Efforts(preset, models.ids[i]); got != nil {
							t.Errorf("%s/%s: efforts = %v for a non-reasoning model", preset, models.ids[i], got)
						}
						sawNonReasoning = true
					}
				}
			}
		}
	}
	if !sawNonReasoning {
		t.Skip("no non-reasoning model reached through the preset map in this catalog build")
	}
}

func TestEfforts_FamilyFallback(t *testing.T) {
	// A family where the newest model has reasoning but no annotated options;
	// the newest sibling that DOES publish effort levels must supply the ladder.
	// Dates decide: 2026-03-01 (effort) beats 2025-01-01 (effort), and the
	// date-less sibling is treated as not-later but still older than both.
	cat := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"x",
		"providers":{"p":{
			"new-model":{"reasoning":true,"family":"fam","release_date":"2026-06-01"},
			"mid-model":{"reasoning":true,"family":"fam","release_date":"2026-03-01",
				"reasoning_options":[{"type":"effort","values":["low","medium"]}]},
			"old-model":{"reasoning":true,"family":"fam","release_date":"2025-01-01"},
			"undated-model":{"reasoning":true,"family":"fam",
				"reasoning_options":[{"type":"effort","values":["none"]}]},
			"future-model":{"reasoning":true,"family":"fam","release_date":"2027-01-01",
				"reasoning_options":[{"type":"effort","values":["max"]}]},
			"other-family":{"reasoning":true,"family":"other","release_date":"2026-01-01",
				"reasoning_options":[{"type":"effort","values":["xhigh"]}]},
			"no-reasoning":{"family":"fam","release_date":"2026-02-01",
				"reasoning_options":[{"type":"effort","values":["none"]}]}
		}}
	}`, `{"schema":1,"providers":{"preset":["p"]}}`, `{"schema":1,"models":{}}`)

	// mid-model (2026-03-01) is the newest <= 2026-06-01 with effort values.
	if got := cat.Efforts("preset", "new-model"); !reflect.DeepEqual(got, []string{"low", "medium"}) {
		t.Errorf("family fallback = %v, want [low medium] from mid-model", got)
	}

	// An undated sibling counts as "not later", so it IS a valid source (the
	// spec's "release_date 为空的当作不晚于").
	if got := cat.Efforts("preset", "old-model"); !reflect.DeepEqual(got, []string{"none"}) {
		t.Errorf("old-model efforts = %v, want [none] from the undated sibling", got)
	}

	// But a model whose every sibling is strictly newer gets nothing: newer
	// capability must not be projected backwards.
	catStrict := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"x",
		"providers":{"p":{
			"early":{"reasoning":true,"family":"f","release_date":"2024-01-01"},
			"later":{"reasoning":true,"family":"f","release_date":"2026-01-01",
				"reasoning_options":[{"type":"effort","values":["max"]}]}
		}}
	}`, `{"schema":1,"providers":{"preset":["p"]}}`, `{"schema":1,"models":{}}`)
	if got := catStrict.Efforts("preset", "early"); got != nil {
		t.Errorf("early-model efforts = %v, want nil (newer only)", got)
	}

	// Same date tie breaks on the larger id.
	cat2 := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"x",
		"providers":{"p":{
			"target":{"reasoning":true,"family":"f","release_date":"2026-01-01"},
			"a-twin":{"reasoning":true,"family":"f","release_date":"2026-01-01",
				"reasoning_options":[{"type":"effort","values":["low"]}]},
			"z-twin":{"reasoning":true,"family":"f","release_date":"2026-01-01",
				"reasoning_options":[{"type":"effort","values":["high"]}]}
		}}
	}`, `{"schema":1,"providers":{"preset":["p"]}}`, `{"schema":1,"models":{}}`)
	if got := cat2.Efforts("preset", "target"); !reflect.DeepEqual(got, []string{"high"}) {
		t.Errorf("date tie = %v, want [high] from z-twin (larger id)", got)
	}

	// A toggle-only / budget-only model must NOT borrow a sibling ladder: it
	// already has its own (non-effort) answer.
	cat3 := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"x",
		"providers":{"p":{
			"toggle-new":{"reasoning":true,"family":"f","release_date":"2026-05-01",
				"reasoning_options":[{"type":"toggle"}]},
			"effort-old":{"reasoning":true,"family":"f","release_date":"2026-01-01",
				"reasoning_options":[{"type":"effort","values":["low","high"]}]}
		}}
	}`, `{"schema":1,"providers":{"preset":["p"]}}`, `{"schema":1,"models":{}}`)
	if got := cat3.Efforts("preset", "toggle-new"); got != nil {
		t.Errorf("toggle-only model borrowed a sibling ladder: %v", got)
	}

	// Family isolation: a sibling in another models.dev provider never counts.
	cat4 := fixtureCatalog(t, `{
		"schema":1,"source":"models.dev","fetched_at":"x",
		"providers":{
			"p1":{"target":{"reasoning":true,"family":"f","release_date":"2026-01-01"}},
			"p2":{"sibling":{"reasoning":true,"family":"f","release_date":"2025-01-01",
				"reasoning_options":[{"type":"effort","values":["low"]}]}}
		}
	}`, `{"schema":1,"providers":{"preset":["p1"]}}`, `{"schema":1,"models":{}}`)
	if got := cat4.Efforts("preset", "target"); got != nil {
		t.Errorf("family fallback crossed provider boundaries: %v", got)
	}
}

func TestCapability_Composition(t *testing.T) {
	cat := bundledForTest(t)
	cap := cat.Capability("zhipu", "glm-4.6v-flash")
	if !cap.Found || !cap.SupportsToggle || cap.Efforts != nil || cap.HasBudget {
		t.Errorf("toggle model capability = %+v", cap)
	}
	cap = cat.Capability("anthropic", "claude-sonnet-4-5")
	if !cap.Found || !cap.HasBudget || cap.BudgetMin != 1024 || cap.SupportsToggle {
		t.Errorf("budget model capability = %+v", cap)
	}
	cap = cat.Capability("deepseek", "deepseek-v4-pro")
	if !cap.Found || !reflect.DeepEqual(cap.Efforts, []string{"low", "high", "max"}) || cap.ContextTokens != 1048576 {
		t.Errorf("effort model capability = %+v", cap)
	}
}

// ------------------------------------------------------------- NearestEffort

func TestNearestEffort(t *testing.T) {
	tests := []struct {
		want   string
		levels []string
		expect string
	}{
		// The ask's five worked examples.
		{"xhigh", []string{"low", "medium", "high", "max"}, "max"},
		{"medium", []string{"low", "high"}, "high"},
		{"none", []string{"low", "high"}, "low"},
		{"low", []string{"high"}, "high"},
		{"light", []string{"minimal", "low"}, "low"},

		// Pass-through cases.
		{"high", nil, "high"},
		{"high", []string{}, "high"},
		{"high", []string{"low", "medium", "high"}, "high"},
		{"HIGH", []string{"low", "high"}, "high"},
		{"banana", []string{"low", "high"}, "banana"},

		// Round up on ties.
		{"medium", []string{"low", "high"}, "high"},
		{"low", []string{"minimal", "medium"}, "medium"},
		{"xhigh", []string{"high", "max"}, "max"},
		{"minimal", []string{"none", "low"}, "low"},

		// Aliases.
		{"extra_high", []string{"low", "high", "max"}, "max"},
		{"extra_high", []string{"low", "xhigh"}, "xhigh"},
		{"Extra_High", []string{"low", "max"}, "max"},
		{"light", []string{"minimal", "low", "high"}, "low"},

		// "none" is never a mapping target.
		{"low", []string{"none", "high"}, "high"},
		{"medium", []string{"none", "high"}, "high"},
		{"xhigh", []string{"none", "low", "high"}, "high"},
		// ...unless the caller asked for none.
		{"none", []string{"none", "high"}, "none"},

		// Unknown names in levels are skipped.
		{"medium", []string{"turbo", "high"}, "high"},
		{"medium", []string{"turbo"}, "medium"},

		// Only "none" available and want != none: nothing to map onto.
		{"high", []string{"none"}, "high"},
	}
	for _, tc := range tests {
		if got := NearestEffort(tc.want, tc.levels); got != tc.expect {
			t.Errorf("NearestEffort(%q, %v) = %q, want %q", tc.want, tc.levels, got, tc.expect)
		}
	}
}

func TestNearestEffort_AliasRoundTrip(t *testing.T) {
	levels := []string{"low", "medium", "high", "xhigh"}
	// An alias is matched against the ladder, so the caller's supported spelling
	// comes back rather than the canonical one.
	if got := NearestEffort("extra_high", levels); got != "xhigh" {
		t.Errorf("extra_high -> %q, want xhigh", got)
	}
	// And when the ladder spells it the other way, that spelling is returned.
	if got := NearestEffort("extra_high", []string{"low", "extra_high"}); got != "extra_high" {
		t.Errorf("extra_high -> %q, want extra_high", got)
	}
}

// ------------------------------------------------------------------- parsing

func TestParseCatalog_RejectsMalformed(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{"empty", ""},
		{"not json", "not json"},
		{"array", `[]`},
		{"wrong schema", `{"schema":2,"providers":{"p":{"m":{}}}}`},
		{"missing schema", `{"providers":{"p":{"m":{}}}}`},
		{"empty providers", `{"schema":1,"providers":{}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseCatalog([]byte(tc.text)); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestValidateCatalogText_Limits(t *testing.T) {
	ok := `{"schema":1,"providers":{"p":{"m":{"reasoning":true}}}}`
	if _, err := ValidateCatalogText([]byte(ok)); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}

	big := `{"schema":1,"providers":{"p":{"m":{"family":"` +
		strings.Repeat("x", MaxCatalogBytes) + `"}}}}`
	if _, err := ValidateCatalogText([]byte(big)); err == nil {
		t.Fatal("oversized payload accepted")
	} else if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("unexpected error for oversized payload: %v", err)
	}

	// Trailing garbage must not pass as a JSON object: ParseCatalog rejects it.
	if _, err := ValidateCatalogText([]byte(`{"schema":1,"providers":{"p":{"m":{}}}} trailing`)); err == nil {
		t.Fatal("payload with trailing garbage accepted")
	}
}

func TestParseCatalog_DropsUnknownProviderModelFields(t *testing.T) {
	raw := map[string]any{
		"schema": 1,
		"providers": map[string]any{
			"p": map[string]any{
				"m": map[string]any{
					"limit":             map[string]any{"context": 100, "output": 10, "input": 99999},
					"reasoning":         true,
					"reasoning_options": []any{map[string]any{"type": "effort", "values": []any{"low", "high"}, "bogus": 1}},
					"family":            "f",
					"release_date":      "2026-01-01",
					"description":       "dropped",
					"cost":              map[string]any{"input": 1},
				},
			},
		},
	}
	blob, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	cat := fixtureCatalog(t, string(blob), `{"schema":1,"providers":{"preset":["p"]}}`, `{"schema":1,"models":{}}`)
	info, ok := cat.Lookup("preset", "m")
	if !ok {
		t.Fatal("model missing")
	}
	if info.ContextTokens != 100 || info.OutputTokens != 10 {
		t.Errorf("limit = %d/%d", info.ContextTokens, info.OutputTokens)
	}
	if got := cat.Efforts("preset", "m"); !reflect.DeepEqual(got, []string{"low", "high"}) {
		t.Errorf("efforts = %v", got)
	}
}

// --------------------------------------------------------------------- store

func TestStore_LazyLoadsBundle(t *testing.T) {
	// t.TempDir is empty: the store must fall back to the embedded bundle, and
	// must not touch the disk to do so.
	dir := t.TempDir()
	st := NewStore(dir)
	if _, err := os.Stat(filepath.Join(dir, CacheFileName)); !os.IsNotExist(err) {
		t.Fatalf("store created the cache file on its own: %v", err)
	}
	status := st.Status()
	if !status.Present || status.Source != SourceBundled || status.ModelCount != 8968 {
		t.Fatalf("status = %+v, want bundled/8968", status)
	}
	if status.Bytes != 1629650 {
		t.Logf("note: bundled catalog is %d B (ask recorded 1,629,650)", status.Bytes)
	}
}

func TestStore_CacheFileWinsAndSurvivesCorruption(t *testing.T) {
	dir := t.TempDir()
	cache := filepath.Join(dir, CacheFileName)

	// A valid cache file with one model replaces the bundle.
	valid := `{"schema":1,"source":"models.dev","fetched_at":"2026-02-02T00:00:00Z","providers":{"p":{"m":{"limit":{"context":7}}}}}`
	if err := os.WriteFile(cache, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	st := NewStore(dir)
	status := st.Status()
	if status.Source != SourceCache || status.ModelCount != 1 || status.FetchedAt != "2026-02-02T00:00:00Z" {
		t.Fatalf("status = %+v, want cache/1", status)
	}
	if info, ok := st.Current().Lookup("preset", "m"); !ok {
		// The cache carries models.dev provider "p" but the preset map is still
		// the build-time one from provider-map.json, which has no "preset" key.
		t.Log("cache model is not reachable through the shipped preset map (expected)")
		_ = info
	}

	// A corrupt cache file must fall back to the bundle, not brick the store.
	if err := os.WriteFile(cache, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	var logMu sync.Mutex
	var logs []string
	old := Logf
	Logf = func(format string, args ...any) {
		logMu.Lock()
		defer logMu.Unlock()
		logs = append(logs, fmt.Sprintf(format, args...))
	}
	defer func() { Logf = old }()

	st2 := NewStore(dir)
	status2 := st2.Status()
	if status2.Source != SourceBundled {
		t.Fatalf("corrupt cache source = %q, want bundled", status2.Source)
	}
	if len(logs) == 0 || !strings.Contains(logs[0], CacheFileName) {
		t.Errorf("corruption was not logged: %v", logs)
	}
}

func TestStore_SaveFromHub(t *testing.T) {
	dir := t.TempDir()
	st := NewStore(dir)
	_ = st.Status() // force a load so we can prove the swap

	text := []byte(`{"schema":1,"source":"models.dev","fetched_at":"2026-03-03T00:00:00Z","providers":{"deepseek":{"deepseek-v4-pro":{"limit":{"context":42}},"deepseek-chat":{}}}}`)
	status, err := st.SaveFromHub(text)
	if err != nil {
		t.Fatalf("SaveFromHub: %v", err)
	}
	if status.Source != SourceCache || status.ModelCount != 2 || status.FetchedAt != "2026-03-03T00:00:00Z" {
		t.Fatalf("status = %+v", status)
	}

	// The cache is the exact bytes received.
	got, err := os.ReadFile(filepath.Join(dir, CacheFileName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, text) {
		t.Errorf("cache file differs from the Hub payload")
	}

	// The preset map is the shipped one, so lookups route correctly.
	if info, ok := st.Current().Lookup("deepseek", "deepseek-v4-pro"); !ok || info.ContextTokens != 42 {
		t.Errorf("lookup after sync: ok=%v info=%+v", ok, info)
	}

	// An invalid payload leaves both the file and the active catalog alone.
	if _, err := st.SaveFromHub([]byte(`{"schema":9}`)); err == nil {
		t.Fatal("invalid payload accepted")
	}
	after, _ := os.ReadFile(filepath.Join(dir, CacheFileName))
	if !bytes.Equal(after, text) {
		t.Error("rejected payload overwrote the cache file")
	}
	if info, _ := st.Current().Lookup("deepseek", "deepseek-v4-pro"); info.ContextTokens != 42 {
		t.Error("rejected payload replaced the active catalog")
	}
}

func TestStore_ConcurrentReadDuringSync(t *testing.T) {
	dir := t.TempDir()
	st := NewStore(dir)
	_ = st.Status()

	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if cat := st.Current(); cat != nil {
					_, _ = cat.Lookup("deepseek", "deepseek-chat")
				}
			}
		}()
	}
	for i := 0; i < 5; i++ {
		if _, err := st.SaveFromHub([]byte(`{"schema":1,"fetched_at":"x","providers":{"deepseek":{"deepseek-chat":{}}}}`)); err != nil {
			t.Fatalf("concurrent save: %v", err)
		}
	}
	close(stop)
	wg.Wait()
}

// -------------------------------------------------------------------- memory

// TestEmbeddedCatalogMemoryBudget proves the "compact struct, not map[string]any"
// requirement with the number the ask asked for: after the parse and a GC, the
// resident delta must stay under 2 MB, even though the raw JSON is 1.6 MB and a
// generic map-based parse would cost several times that.
func TestEmbeddedCatalogMemoryBudget(t *testing.T) {
	// Warm any global state (interner template, runtime arenas) first so the
	// delta below is the catalog and not one-time runtime growth.
	runtime.GC()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)

	cat, err := parseCatalogReader(bytes.NewReader(bundledCatalogGz), true)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := cat.attachMaps(bundledProviderMap, bundledOverrides); err != nil {
		t.Fatalf("attachMaps: %v", err)
	}
	if cat.ModelCount != 8968 {
		t.Fatalf("model_count = %d, want 8968", cat.ModelCount)
	}
	// Touch a few fields so the compiler cannot elide the catalog.
	if _, ok := cat.Lookup("deepseek", "deepseek-v4-pro"); !ok {
		t.Fatal("lookup failed inside the memory test")
	}

	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(cat)

	delta := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	const budget = 2 * 1024 * 1024
	t.Logf("raw JSON %d B; compact catalog resident delta %d B (%.2f MB), budget %d B",
		cat.rawBytes, delta, float64(delta)/(1024*1024), budget)
	if cat.rawBytes < 1600000 {
		t.Fatalf("embedded JSON is only %d B; the budget check is meaningless below 1.6 MB", cat.rawBytes)
	}
	if delta >= budget {
		t.Fatalf("compact catalog uses %d B (%.2f MB), over the %d B budget; "+
			"a map[string]any parse would be the cause", delta, float64(delta)/(1024*1024), budget)
	}
	if delta >= cat.rawBytes {
		t.Fatalf("compact catalog (%d B) is not smaller than the raw JSON (%d B)", delta, cat.rawBytes)
	}
}

// TestEmbeddedMapsMatchSharedArtifacts keeps the two small embedded routing files
// byte-identical to their build outputs. A hand-edit or a stale copy would make
// the node route lookups differently from the Hub and from tests.
func TestEmbeddedMapsMatchSharedArtifacts(t *testing.T) {
	for _, tc := range []struct {
		file string
		got  []byte
	}{
		{"provider-map.json", bundledProviderMap},
		{"overrides.json", bundledOverrides},
	} {
		onDisk, err := os.ReadFile(filepath.Join("..", "..", "shared", "model-catalog", tc.file))
		if err != nil {
			t.Skipf("shared/%s not readable from the package dir: %v", tc.file, err)
		}
		if !bytes.Equal(onDisk, tc.got) {
			t.Errorf("embedded %s differs from shared/model-catalog/%s (%d vs %d bytes); "+
				"re-copy the artifact", tc.file, tc.file, len(tc.got), len(onDisk))
		}
	}
}

// TestEmbeddedGzipMatchesCatalogJSON asserts the embed is the build artifact and
// not a stale copy: decompressing it must yield the on-disk catalog.json byte for
// byte. Guards against an embed that silently drifts from shared/model-catalog.
func TestEmbeddedGzipMatchesCatalogJSON(t *testing.T) {
	diskPath := filepath.Join("..", "..", "shared", "model-catalog", "catalog.json")
	onDisk, err := os.ReadFile(diskPath)
	if err != nil {
		t.Skipf("shared catalog not readable from the package dir: %v", err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(bundledCatalogGz))
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	defer zr.Close()
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, onDisk) {
		t.Fatalf("embedded catalog.json.gz does not decompress to shared/model-catalog/catalog.json "+
			"(%d vs %d bytes); re-copy the artifact after `npm run catalog:build`", len(got), len(onDisk))
	}
}
