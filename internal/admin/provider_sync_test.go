package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/provider"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

// newPresetTestServer builds a Full admin server over a temp LocalSource.
func newPresetTestServer(t *testing.T) (*Server, *config.LocalSource, *http.ServeMux) {
	t.Helper()
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("localSrc: %v", err)
	}
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)
	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)
	return srv, localSrc, mux
}

func doPresetReq(t *testing.T, mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *strings.Reader
	if body == "" {
		rdr = strings.NewReader("")
	} else {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Authorization", "Bearer admin-pass")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// contractPresetLibrary builds the matcher library in the shape of the contract's preset
// library (shared/presets/*.json: id / name / base_url / version). The Go built-in catalog
// is kept field-identical to those files (guarded by
// provider.TestCatalog_MatchesSharedPresetIdentity), so the same table is also run against
// builtinPresetLibrary in TestMatchPresetRuleA_BuiltinLibraryMatchesContract.
func contractPresetLibrary() presetLibrary {
	return newPresetLibrary([]presetEntry{
		{ID: "amd", Name: "AMD Radeon Cloud", BaseURL: "https://developer.amd.com.cn/radeon/api/v1", Version: "2026.10.19"},
		{ID: "nvidia", Name: "NVIDIA NIM", BaseURL: "https://integrate.api.nvidia.com/v1", Version: "2.0.0"},
		{ID: "minimax", Name: "MiniMax", BaseURL: "https://api.minimaxi.com/v1", Version: "1.4.0"},
		{ID: "minimax-cn", Name: "MiniMax (国内)", BaseURL: "https://api.minimaxi.com/v1", Version: "1.5.0"},
		{ID: "openai", Name: "OpenAI 官方", BaseURL: "https://api.openai.com/v1", Version: "1.2.1"},
		{ID: "deepseek", Name: "DeepSeek 官方开放平台", BaseURL: "https://api.deepseek.com/v1", Version: "1.3.0"},
		{ID: "vertex", Name: "Google Vertex AI", BaseURL: "https://aiplatform.googleapis.com/v1beta1/projects/{project_id}/locations/global/endpoints/openapi", Version: "1.1.0"},
	})
}

// 规则 A 表驱动：约定里的三个例子、preset_id="custom"、同主机多命中挑不出就不绑、
// 已有绑定保留、占位符预设跳过主机匹配。
func TestMatchPresetRuleA_Table(t *testing.T) {
	ruleACases := []struct {
		name string
		in   presetMatchInput
		want string
	}{
		{
			name: "AMD Radeon Cloud by hostname -> amd",
			in:   presetMatchInput{ID: "vendor-amd", Name: "AMD Radeon Cloud", BaseURL: "https://developer.amd.com.cn/radeon/api/v1"},
			want: "amd",
		},
		{
			name: "Nvidia by hostname -> nvidia",
			in:   presetMatchInput{ID: "nvidia", Name: "Nvidia", BaseURL: "https://integrate.api.nvidia.com/v1"},
			want: "nvidia",
		},
		{
			name: "MiniMax by id -> minimax-cn (shared host, rule 4)",
			in:   presetMatchInput{ID: "minimax-cn", Name: "MiniMax", BaseURL: "https://api.minimaxi.com/v1"},
			want: "minimax-cn",
		},
		{
			name: "MiniMax with unrelated id -> minimax (rule 5 name inside host candidates)",
			in:   presetMatchInput{ID: "some-vendor", Name: "MiniMax", BaseURL: "https://api.minimaxi.com/v1"},
			want: "minimax",
		},
		{
			name: "preset_id=custom stays unbound even on a matching host",
			in:   presetMatchInput{ID: "my-openai", Name: "My OpenAI", BaseURL: "https://api.openai.com/v1", PresetID: "custom"},
			want: "",
		},
		{
			name: "existing preset_id that exists in the library is kept",
			in:   presetMatchInput{ID: "whatever", Name: "Whatever", BaseURL: "https://example.org", PresetID: "openai"},
			want: "openai",
		},
		{
			name: "unresolvable same-host tie stays unbound",
			in:   presetMatchInput{ID: "zz-random", Name: "Some Vendor", BaseURL: "https://api.minimaxi.com/v1"},
			want: "",
		},
		{
			name: "provider id lowercased matches preset id",
			in:   presetMatchInput{ID: "DEEPSEEK", Name: "x", BaseURL: "https://nothing.example.org"},
			want: "deepseek",
		},
		{
			name: "provider name trimmed+lowercased matches preset name",
			in:   presetMatchInput{ID: "zz", Name: " nvidia ", BaseURL: "https://nothing.example.org"},
			want: "nvidia",
		},
		{
			name: "placeholder preset skipped in host step but bindable by id",
			in:   presetMatchInput{ID: "vertex", Name: "Google Vertex", BaseURL: "https://x.example.org"},
			want: "vertex",
		},
		{
			name: "nothing matches -> unbound",
			in:   presetMatchInput{ID: "zz", Name: "Nothing", BaseURL: "https://nothing.example.org"},
			want: "",
		},
	}
	for _, tc := range ruleACases {
		if got := matchPresetRuleA(tc.in, contractPresetLibrary()); got != tc.want {
			t.Errorf("%s: matchPresetRuleA = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// 三端同序同结果：同一张表对着**内置预设库**（Full 二进制真实使用的库，与
// shared/presets 逐字段一致）再跑一遍，结果必须与契约答案一致。这条钉住
// 「Hub 得 amd / Full 也得 amd」这类跨端一致性，防止预设数据再次漂移。
func TestMatchPresetRuleA_BuiltinLibraryMatchesContract(t *testing.T) {
	lib := builtinPresetLibrary()
	contract := contractPresetLibrary()

	cases := []struct {
		name string
		in   presetMatchInput
		want string
	}{
		{
			name: "「AMD Radeon Cloud」+ developer.amd.com.cn → amd",
			in:   presetMatchInput{ID: "vendor-amd", Name: "AMD Radeon Cloud", BaseURL: "https://developer.amd.com.cn/radeon/api/v1"},
			want: "amd",
		},
		{
			name: "「Nvidia」+ integrate.api.nvidia.com → nvidia",
			in:   presetMatchInput{ID: "nvidia", Name: "Nvidia", BaseURL: "https://integrate.api.nvidia.com/v1"},
			want: "nvidia",
		},
		{
			name: "「MiniMax」+ api.minimaxi.com（供应商 id 非预设 id）→ minimax",
			in:   presetMatchInput{ID: "zz_mm_local", Name: "MiniMax", BaseURL: "https://api.minimaxi.com/v1"},
			want: "minimax",
		},
		{
			name: "「MiniMax」+ api.minimaxi.com + id=minimax（规则 4）→ minimax",
			in:   presetMatchInput{ID: "minimax", Name: "MiniMax", BaseURL: "https://api.minimaxi.com/v1"},
			want: "minimax",
		},
		{
			name: "「MiniMax (国内)」+ api.minimaxi.com → minimax-cn（规则 5 名称）",
			in:   presetMatchInput{ID: "zz", Name: "MiniMax (国内)", BaseURL: "https://api.minimaxi.com/v1"},
			want: "minimax-cn",
		},
	}
	for _, tc := range cases {
		gotBuiltin := matchPresetRuleA(tc.in, lib)
		gotContract := matchPresetRuleA(tc.in, contract)
		if gotBuiltin != gotContract {
			t.Errorf("%s: builtin library says %q, contract library says %q", tc.name, gotBuiltin, gotContract)
		}
		if gotBuiltin != tc.want {
			t.Errorf("%s: matchPresetRuleA(builtin) = %q, want %q", tc.name, gotBuiltin, tc.want)
		}
	}
}

// preset-status：本地供应商的 latest_version 取内置预设库；中枢供应商取中枢 manifest
// 的 preset_version；连不上中枢时 note 写原因且 has_update=false。
func TestAdminServer_PresetStatus(t *testing.T) {
	hubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/vault/manifest" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"providers": map[string]any{
					"hub-p": map[string]any{"preset_id": "deepseek", "preset_version": "9.9.9"},
				},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer hubServer.Close()

	srv, localSrc, mux := newPresetTestServer(t)
	srv.SetHTTPClient(hubServer.Client())
	srv.SetDefaultVault(hubServer.URL, "tok1")

	// Hub provider adopted through the real merge path.
	if _, err := localSrc.MergeVaultConfig(map[string]*types.ProviderConfig{
		"hub-p": {
			ID: "hub-p", Name: "Hub P", BaseURL: "https://hub.example/v1", Origin: "vault", Enabled: true,
			PresetID: "deepseek", PresetVersion: "1.0.0",
			APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-hub", Enabled: true}},
		},
	}, true); err != nil {
		t.Fatalf("MergeVaultConfig: %v", err)
	}

	// Local provider bound to a preset, and one unbound.
	cur, err := localSrc.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	cfg := cur.Config
	cfg.Providers["loc-p"] = &types.ProviderConfig{
		ID: "loc-p", Name: "Local P", BaseURL: "https://local.example/v1", Origin: "local", Enabled: true,
		PresetID: "deepseek", PresetVersion: "1.0.0",
		APIKeys: []*types.KeyEntry{{ID: "lk", Label: "lk", Key: "sk-local", Origin: "local", Enabled: true}},
	}
	cfg.Providers["free-p"] = &types.ProviderConfig{
		ID: "free-p", Name: "Free P", BaseURL: "https://free.example/v1", Origin: "local", Enabled: true,
		APIKeys: []*types.KeyEntry{{ID: "fk", Label: "fk", Key: "sk-free", Origin: "local", Enabled: true}},
	}
	if _, err := localSrc.SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	rec := doPresetReq(t, mux, http.MethodGet, "/api/admin/providers/preset-status", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("preset-status: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK          bool              `json:"ok"`
		UpdateCount int               `json:"update_count"`
		Providers   []presetStatusRow `json:"providers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("preset-status decode: %v", err)
	}
	if !out.OK {
		t.Fatalf("preset-status: expected ok:true, got %s", rec.Body.String())
	}
	rows := make(map[string]presetStatusRow, len(out.Providers))
	for _, r := range out.Providers {
		rows[r.ID] = r
	}

	hubRow, ok := rows["hub-p"]
	if !ok || hubRow.Origin != "vault" || hubRow.LatestVersion != "9.9.9" || !hubRow.HasUpdate {
		t.Errorf("preset-status: hub-p row should report the manifest version 9.9.9 as an update, got %+v", hubRow)
	}
	locRow, ok := rows["loc-p"]
	if !ok || locRow.Origin != "local" || locRow.LatestVersion == "" || !locRow.HasUpdate {
		t.Errorf("preset-status: loc-p row should compare against the built-in preset version (1.0.0 -> newer), got %+v", locRow)
	}
	freeRow, ok := rows["free-p"]
	if !ok || freeRow.HasUpdate || freeRow.Note == "" {
		t.Errorf("preset-status: unbound provider must have has_update=false and a note, got %+v", freeRow)
	}
	if out.UpdateCount < 2 {
		t.Errorf("preset-status: update_count should include hub-p and loc-p, got %d (rows %+v)", out.UpdateCount, out.Providers)
	}

	// Hub unreachable: has_update=false + note carries the reason.
	srv.SetDefaultVault("http://127.0.0.1:1", "tok1")
	rec = doPresetReq(t, mux, http.MethodGet, "/api/admin/providers/preset-status", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("preset-status (hub down): expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	out = struct {
		OK          bool              `json:"ok"`
		UpdateCount int               `json:"update_count"`
		Providers   []presetStatusRow `json:"providers"`
	}{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("preset-status (hub down) decode: %v", err)
	}
	var hubDown *presetStatusRow
	for i := range out.Providers {
		if out.Providers[i].ID == "hub-p" {
			hubDown = &out.Providers[i]
		}
	}
	if hubDown == nil || hubDown.HasUpdate || hubDown.Note == "" {
		t.Errorf("preset-status: hub-down must yield has_update=false + note, got %+v", hubDown)
	}
}

// sync：中枢供应商整体重拉（Key 全量替换、本地 Key 保留），本地供应商按预设刷新，
// 手动改过规则的跳过并说明原因；返回结构含 updated/skipped/errors。
func TestAdminServer_SyncProviders(t *testing.T) {
	hubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/vault/fetch":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":       true,
				"provider": "hub-p",
				"provider_config": map[string]any{
					"id":             "hub-p",
					"name":           "Hub P (new)",
					"base_url":       "https://hub-new.example/v1",
					"preset_id":      "deepseek",
					"preset_version": "2.0.0",
					"rule_hash":      "hash-new",
					"api_type":       "openai",
					"adapter_rules":  map[string]any{"strip_reasoning_enabled": true},
					"api_keys": []map[string]any{
						{"id": "k2", "label": "k2", "key": "sk-hub-2", "enabled": true},
						{"id": "k3", "label": "k3", "key": "sk-hub-3", "enabled": true},
					},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer hubServer.Close()

	srv, localSrc, mux := newPresetTestServer(t)
	srv.SetHTTPClient(hubServer.Client())
	srv.SetDefaultVault(hubServer.URL, "tok1")

	if _, err := localSrc.MergeVaultConfig(map[string]*types.ProviderConfig{
		"hub-p": {
			ID: "hub-p", Name: "Hub P", BaseURL: "https://hub.example/v1", Origin: "vault", Enabled: true,
			PresetID: "deepseek", PresetVersion: "1.0.0",
			APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-hub-1", Enabled: true}},
		},
	}, true); err != nil {
		t.Fatalf("MergeVaultConfig: %v", err)
	}
	cur, err := localSrc.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	cfg := cur.Config
	// Local key on the hub provider (must survive the sync re-fetch).
	cfg.Providers["hub-p"].APIKeys = append(cfg.Providers["hub-p"].APIKeys, &types.KeyEntry{
		ID: "mine", Label: "mine", Key: "sk-mine", Origin: "local", Enabled: true,
	})
	// Preset-bound local provider still running the preset rules (the exact rules the
	// built-in amd preset carries — that is what "rules still equal the preset" means).
	amdRules := provider.DefaultPresetAdapterRules("amd")
	cfg.Providers["loc-preset"] = &types.ProviderConfig{
		ID: "loc-preset", Name: "Local Preset", BaseURL: "https://lp.example/v1", Origin: "local", Enabled: true,
		PresetID: "amd", PresetVersion: "0.9.0",
		AdapterRules: amdRules,
		APIKeys:      []*types.KeyEntry{{ID: "a1", Label: "a1", Key: "sk-a1", Origin: "local", Enabled: true}},
	}
	// Local provider whose rules were hand edited -> must be skipped.
	cfg.Providers["loc-edited"] = &types.ProviderConfig{
		ID: "loc-edited", Name: "Local Edited", BaseURL: "https://le.example/v1", Origin: "local", Enabled: true,
		PresetID: "amd", PresetVersion: "0.9.0",
		AdapterRules: &types.AdapterRules{StreamOnly: true, MaxTokensCeiling: 4096}, // not the preset's rules
		APIKeys:      []*types.KeyEntry{{ID: "e1", Label: "e1", Key: "sk-e1", Origin: "local", Enabled: true}},
	}
	// Unbound local provider that rule A can bind by hostname.
	cfg.Providers["loc-free"] = &types.ProviderConfig{
		ID: "loc-free", Name: "Nvidia", BaseURL: "https://integrate.api.nvidia.com/v1", Origin: "local", Enabled: true,
		APIKeys: []*types.KeyEntry{{ID: "n1", Label: "n1", Key: "sk-n1", Origin: "local", Enabled: true}},
	}
	if _, err := localSrc.SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	rec := doPresetReq(t, mux, http.MethodPost, "/api/admin/providers/sync", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("sync: expected 200 even with per-provider outcomes, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK      bool             `json:"ok"`
		Updated []syncUpdatedRow `json:"updated"`
		Skipped []syncSkippedRow `json:"skipped"`
		Errors  []syncErrorRow   `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("sync decode: %v", err)
	}
	if !out.OK {
		t.Fatalf("sync: expected ok:true, got %s", rec.Body.String())
	}
	upd := make(map[string]syncUpdatedRow, len(out.Updated))
	for _, u := range out.Updated {
		upd[u.ID] = u
	}
	skp := make(map[string]string, len(out.Skipped))
	for _, s := range out.Skipped {
		skp[s.ID] = s.Reason
	}

	if u, ok := upd["hub-p"]; !ok || u.ToVersion != "2.0.0" || u.KeysAdded != 2 || u.KeysRemoved != 1 {
		t.Errorf("sync: hub-p should be updated to 2.0.0 with +2/-1 keys (k2,k3 in, k1 out), got %+v", u)
	}
	if u, ok := upd["loc-preset"]; !ok || u.FromVersion != "0.9.0" || u.ToVersion == "" {
		t.Errorf("sync: loc-preset should be refreshed to the latest preset version, got %+v", u)
	}
	if u, ok := upd["loc-free"]; !ok || u.ToVersion == "" {
		t.Errorf("sync: loc-free should be bound by rule A and adopt the preset version, got %+v", u)
	}
	if reason, skipped := skp["loc-edited"]; !skipped || !strings.Contains(reason, "规则已手动修改") {
		t.Errorf("sync: loc-edited (hand-edited rules) must be skipped with the manual-edit reason, got %q", reason)
	}
	if len(out.Errors) != 0 {
		t.Errorf("sync: expected no errors, got %+v", out.Errors)
	}

	// Post-state assertions.
	snap, err := localSrc.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current after sync: %v", err)
	}
	hubP := snap.Config.Providers["hub-p"]
	if hubP == nil || hubP.BaseURL != "https://hub-new.example/v1" || hubP.PresetVersion != "2.0.0" || hubP.RuleHash != "hash-new" {
		t.Fatalf("sync: hub-p hub-managed fields not replaced, got %+v", hubP)
	}
	if len(hubP.APIKeys) != 3 {
		t.Fatalf("sync: expected hub keys k2+k3 + local key mine, got %+v", hubP.APIKeys)
	}
	var hasLocal bool
	hubKeyIDs := map[string]string{}
	for _, k := range hubP.APIKeys {
		if k.ID == "mine" && k.Origin == "local" && k.Key == "sk-mine" {
			hasLocal = true
		}
		if k.Origin == "vault" {
			hubKeyIDs[k.ID] = k.Key
		}
	}
	if !hasLocal {
		t.Errorf("sync: local key must survive the re-fetch: %+v", hubP.APIKeys)
	}
	if hubKeyIDs["k2"] != "sk-hub-2" || hubKeyIDs["k3"] != "sk-hub-3" {
		t.Errorf("sync: hub key list must be replaced wholesale (k1 out, k2+k3 in): %+v", hubKeyIDs)
	}
	if _, stillThere := hubKeyIDs["k1"]; stillThere {
		t.Errorf("sync: hub key k1 was removed on the hub and must disappear: %+v", hubKeyIDs)
	}

	if p := snap.Config.Providers["loc-edited"]; p.AdapterRules == nil || !p.AdapterRules.StreamOnly || p.PresetVersion != "0.9.0" {
		t.Errorf("sync: hand-edited local provider must stay untouched, got %+v", p)
	}
	if p := snap.Config.Providers["loc-free"]; p.PresetID != "nvidia" {
		t.Errorf("sync: unbound provider should pick up preset nvidia by rule A, got %+v", p)
	}
}

// 约定 C：把本地 Key 提交到中枢供应商下（标签与中枢 Key 不同）后保存成功并保留；同标签
// 则 400 {"ok":false,"error":"key_label_conflict","label":"…"}。
func TestAdminServer_SaveVaultProviderLocalKey(t *testing.T) {
	_, localSrc, mux := newPresetTestServer(t)

	if _, err := localSrc.MergeVaultConfig(map[string]*types.ProviderConfig{
		"hp": {
			ID: "hp", Name: "Hub Provider", BaseURL: "https://hp.example/v1", Origin: "vault", Enabled: true,
			APIKeys: []*types.KeyEntry{{ID: "hub-k", Label: "hub-k", Key: "sk-hub", Enabled: true}},
		},
	}, true); err != nil {
		t.Fatalf("MergeVaultConfig: %v", err)
	}

	rec := doPresetReq(t, mux, http.MethodGet, "/api/admin/config", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("config read: %d", rec.Code)
	}
	var readOut map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &readOut); err != nil {
		t.Fatalf("config decode: %v", err)
	}
	version := int64(readOut["_version"].(float64))

	submit := func(keys []map[string]any) *httptest.ResponseRecorder {
		payload := map[string]any{
			"_version": version,
			"providers": map[string]any{
				"hp": map[string]any{
					"id": "hp", "base_url": "https://hp.example/v1", "origin": "vault", "enabled": true,
					"api_keys": keys,
				},
			},
			"agent_models": map[string]any{},
			"settings":     map[string]any{},
		}
		raw, _ := json.Marshal(payload)
		return doPresetReq(t, mux, http.MethodPost, "/api/admin/config", string(raw))
	}

	// 1. Distinct label -> saved, both keys coexist.
	rec = submit([]map[string]any{
		{"id": "hub-k", "label": "hub-k", "key": "sk--...hub", "origin": "vault", "enabled": true},
		{"id": "mine", "label": "mine", "key": "sk-local-mine", "origin": "local", "enabled": true},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("save with distinct local label: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	snap, err := localSrc.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	hp := snap.Config.Providers["hp"]
	if len(hp.APIKeys) != 2 {
		t.Fatalf("expected hub key + local key to coexist, got %+v", hp.APIKeys)
	}
	var localKept bool
	for _, k := range hp.APIKeys {
		if k.ID == "mine" && k.Origin == "local" && k.Key == "sk-local-mine" {
			localKept = true
		}
		if k.ID == "hub-k" && k.Key != "sk-hub" {
			t.Errorf("hub key value must stay restored from storage, got %q", k.Key)
		}
	}
	if !localKept {
		t.Errorf("local key not preserved on the vault provider: %+v", hp.APIKeys)
	}

	// 2. Same label as the hub key -> 400 key_label_conflict with the label.
	ver2 := int64(0)
	rec = doPresetReq(t, mux, http.MethodGet, "/api/admin/config", "")
	_ = json.Unmarshal(rec.Body.Bytes(), &readOut)
	ver2 = int64(readOut["_version"].(float64))
	payload := map[string]any{
		"_version": ver2,
		"providers": map[string]any{
			"hp": map[string]any{
				"id": "hp", "base_url": "https://hp.example/v1", "origin": "vault", "enabled": true,
				"api_keys": []map[string]any{
					{"id": "hub-k", "label": "hub-k", "key": "sk--...hub", "origin": "vault", "enabled": true},
					{"id": "clash", "label": "hub-k", "key": "sk-clash", "origin": "local", "enabled": true},
				},
			},
		},
		"agent_models": map[string]any{},
		"settings":     map[string]any{},
	}
	raw, _ := json.Marshal(payload)
	rec = doPresetReq(t, mux, http.MethodPost, "/api/admin/config", string(raw))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("same-label local key: expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var errOut map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &errOut); err != nil {
		t.Fatalf("error body decode: %v", err)
	}
	if errOut["ok"] != false || errOut["error"] != "key_label_conflict" || errOut["label"] != "hub-k" {
		t.Errorf("unexpected conflict body: %s", rec.Body.String())
	}
}

// sync 的鉴权与结构：未授权 401，返回 ok/updated/skipped/errors 三个数组（空也返回 []）。
func TestAdminServer_SyncProviders_EmptyAndAuth(t *testing.T) {
	_, localSrc, mux := newPresetTestServer(t)

	unauth := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/admin/providers/sync", bytes.NewReader(nil))
	mux.ServeHTTP(unauth, req)
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("sync without auth: expected 401, got %d", unauth.Code)
	}

	// A purely local provider with no preset -> skipped, no update, top-level 200.
	if _, err := localSrc.SaveConfig(&types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"solo": {
				ID: "solo", Name: "Solo", BaseURL: "https://solo.example/v1", Origin: "local", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "s1", Label: "s1", Key: "sk-s1", Origin: "local", Enabled: true}},
			},
		},
		Settings: config.DefaultRuntimeSettings(),
	}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	rec := doPresetReq(t, mux, http.MethodPost, "/api/admin/providers/sync", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("sync: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{"updated", "skipped", "errors"} {
		arr, ok := out[key].([]any)
		if !ok {
			t.Errorf("sync response must always carry %q as an array, got %T", key, out[key])
		}
		if key == "skipped" && len(arr) != 1 {
			t.Errorf("sync: the unbound local provider should be reported as skipped, got %+v", arr)
		}
	}
}

// 接线：一键更新给未绑定本地供应商补绑时用的是内置预设库（二进制内唯一来源），
// builtinPresetLibrary() 必须能与 provider.Catalog() 一一对应，并且每条都带
// id / name / base_url / version 四要素（version 允许为空 = 该预设无适配文件）。
func TestBuiltinPresetLibrary_Wiring(t *testing.T) {
	catalog := provider.Catalog()
	if len(catalog) == 0 {
		t.Fatal("provider.Catalog() returned no presets")
	}
	lib := builtinPresetLibrary()
	if len(lib.list) != len(catalog) {
		t.Fatalf("builtinPresetLibrary has %d entries, provider.Catalog has %d", len(lib.list), len(catalog))
	}
	for _, e := range lib.list {
		if e.ID == "" || e.Name == "" || e.BaseURL == "" {
			t.Errorf("preset entry missing id/name/base_url: %+v", e)
		}
		if got := findPresetEntry(lib, e.ID); got == nil || got.ID != e.ID {
			t.Errorf("findPresetEntry(%q) failed: %+v", e.ID, got)
		}
	}
	// Rule A runs against this library without panicking and honours preset_id="custom".
	lib2 := builtinPresetLibrary()
	if got := matchPresetRuleA(presetMatchInput{ID: "x", Name: "y", BaseURL: "https://api.openai.com/v1", PresetID: "custom"}, lib2); got != "" {
		t.Errorf("custom binding must stay unbound, got %q", got)
	}
	if got := matchPresetRuleA(presetMatchInput{ID: "openai", Name: "whatever", BaseURL: ""}, lib2); got != "openai" {
		t.Errorf("id match over the built-in library failed, got %q", got)
	}
}

// sync 的中枢供应商逐个隔离：一个拉取失败只进 errors，另一个照常更新（部分失败仍 200）。
func TestAdminServer_SyncProviders_PartialFailure(t *testing.T) {
	hubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/vault/fetch" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		id, _ := body["provider"].(string)
		if id != "ok-p" {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"ok":false,"error":"hub boom"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"provider": "ok-p",
			"provider_config": map[string]any{
				"id": "ok-p", "name": "OK P", "base_url": "https://ok-new.example/v1",
				"preset_id": "deepseek", "preset_version": "3.0.0",
				"api_keys": []map[string]any{{"id": "k1", "label": "k1", "key": "sk-ok-1", "enabled": true}},
			},
		})
	}))
	defer hubServer.Close()

	srv, localSrc, mux := newPresetTestServer(t)
	srv.SetHTTPClient(hubServer.Client())
	srv.SetDefaultVault(hubServer.URL, "tok1")

	if _, err := localSrc.MergeVaultConfig(map[string]*types.ProviderConfig{
		"ok-p": {
			ID: "ok-p", Name: "OK P", BaseURL: "https://ok.example/v1", Origin: "vault", Enabled: true,
			PresetVersion: "1.0.0",
			APIKeys:       []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-ok-1", Enabled: true}},
		},
		"bad-p": {
			ID: "bad-p", Name: "Bad P", BaseURL: "https://bad.example/v1", Origin: "vault", Enabled: true,
			PresetVersion: "1.0.0",
			APIKeys:       []*types.KeyEntry{{ID: "b1", Label: "b1", Key: "sk-bad-1", Enabled: true}},
		},
	}, true); err != nil {
		t.Fatalf("MergeVaultConfig: %v", err)
	}

	rec := doPresetReq(t, mux, http.MethodPost, "/api/admin/providers/sync", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("sync with a partial failure must still be 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK      bool             `json:"ok"`
		Updated []syncUpdatedRow `json:"updated"`
		Errors  []syncErrorRow   `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.OK || len(out.Updated) != 1 || out.Updated[0].ID != "ok-p" || out.Updated[0].ToVersion != "3.0.0" {
		t.Errorf("sync: the healthy provider must be updated, got %+v", out.Updated)
	}
	if len(out.Errors) != 1 || out.Errors[0].ID != "bad-p" {
		t.Errorf("sync: the failing provider must land in errors, got %+v", out.Errors)
	}

	snap, err := localSrc.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	if p := snap.Config.Providers["ok-p"]; p.PresetVersion != "3.0.0" || p.BaseURL != "https://ok-new.example/v1" {
		t.Errorf("sync: ok-p should carry the new hub values, got %+v", p)
	}
	if p := snap.Config.Providers["bad-p"]; p.PresetVersion != "1.0.0" || p.BaseURL != "https://bad.example/v1" {
		t.Errorf("sync: bad-p must stay untouched when its fetch fails, got %+v", p)
	}
}
