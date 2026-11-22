package config

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestLocalSource_SaveLoad_KernelGuard_CAS(t *testing.T) {
	tmpDir := t.TempDir()
	pass := "local-store-key-12345"

	src, err := NewLocalSource(tmpDir, pass)
	if err != nil {
		t.Fatalf("NewLocalSource error: %v", err)
	}

	initialCfg := &types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"minimax": {
				ID:      "minimax",
				Name:    "MiniMax",
				BaseURL: "https://api.minimaxi.com",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "k1",
						Label:   "hk-01",
						Key:     "sk-real-secret-key-1234567890",
						Enabled: true,
					},
				},
			},
		},
	}

	snap1, err := src.SaveConfig(initialCfg)
	if err != nil {
		t.Fatalf("SaveConfig error: %v", err)
	}
	if snap1.Config.Version != 1 {
		t.Errorf("expected version 1, got %d", snap1.Config.Version)
	}

	// 1. Verify Kernel Guard: user edits config with masked key "●●●●●●"
	updateCfg := &types.ProxyConfig{
		Version: 1, // matches current version
		Providers: map[string]*types.ProviderConfig{
			"minimax": {
				ID:      "minimax",
				Name:    "MiniMax",
				BaseURL: "https://api.minimaxi.com",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "k1",
						Label:   "hk-01",
						Key:     "sk-●●●●●●●●●●", // Masked!
						Enabled: true,
					},
				},
			},
		},
	}

	snap2, err := src.SaveConfig(updateCfg)
	if err != nil {
		t.Fatalf("SaveConfig with masked key error: %v", err)
	}
	if snap2.Config.Version != 2 {
		t.Errorf("expected version 2, got %d", snap2.Config.Version)
	}

	// Kernel Guard must have restored the real key
	restoredKey := snap2.Config.Providers["minimax"].APIKeys[0].Key
	if restoredKey != "sk-real-secret-key-1234567890" {
		t.Errorf("Kernel Guard failed: expected 'sk-real-secret-key-1234567890', got %q", restoredKey)
	}

	// 2. Verify CAS 409 conflict
	staleCfg := &types.ProxyConfig{
		Version: 1, // Stale! Current is 2
		Providers: map[string]*types.ProviderConfig{
			"minimax": {
				ID:      "minimax",
				BaseURL: "https://api.minimaxi.com",
			},
		},
	}

	_, err = src.SaveConfig(staleCfg)
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected errors.Is(err, ErrVersionConflict), got %v", err)
	}

	var vce *VersionConflictError
	if !errors.As(err, &vce) {
		t.Fatalf("expected errors.As to extract *VersionConflictError, got %v", err)
	}
	if vce.CurrentVersion != 2 || vce.SubmittedVersion != 1 {
		t.Fatalf("expected CurrentVersion=2, SubmittedVersion=1, got current=%d, submitted=%d", vce.CurrentVersion, vce.SubmittedVersion)
	}

	// 3. Verify reload from disk
	src2, err := NewLocalSource(tmpDir, pass)
	if err != nil {
		t.Fatalf("NewLocalSource reload error: %v", err)
	}
	snapLoaded, err := src2.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current error: %v", err)
	}
	if snapLoaded.Config.Version != 2 {
		t.Errorf("expected loaded version 2, got %d", snapLoaded.Config.Version)
	}
}

func TestLocalSource_MergeVaultConfig(t *testing.T) {
	tmpDir := t.TempDir()
	pass := "vault-merge-test-pass"

	src, err := NewLocalSource(tmpDir, pass)
	if err != nil {
		t.Fatalf("NewLocalSource error: %v", err)
	}

	initialCfg := &types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"local_p": {
				ID:      "local_p",
				Name:    "Local Provider",
				BaseURL: "https://local-url.com",
				Origin:  "local",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "k_loc_1",
						Label:   "my-local-key",
						Key:     "sk-local-secret",
						Origin:  "local",
						Enabled: true,
					},
					{
						ID:      "k_vault_old",
						Label:   "shared-v1",
						Key:     "sk-vault-old-secret",
						Origin:  "vault",
						Enabled: true,
					},
				},
			},
			"vault_p": {
				ID:      "vault_p",
				Name:    "Existing Vault Provider",
				BaseURL: "https://old-vault-url.com",
				Origin:  "vault",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "k_vault-k1",
						Label:   "vault-k1",
						Key:     "sk-p2-v1-old",
						Origin:  "vault",
						Enabled: true,
					},
				},
			},
			// Legacy provider stored before the origin field existed: treated as local.
			"legacy_p": {
				ID:      "legacy_p",
				Name:    "Legacy No-Origin Provider",
				BaseURL: "https://legacy-url.com",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "k_legacy",
						Label:   "legacy-key",
						Key:     "sk-legacy-local-secret",
						Enabled: true,
					},
				},
			},
		},
	}

	_, err = src.SaveConfig(initialCfg)
	if err != nil {
		t.Fatalf("SaveConfig error: %v", err)
	}

	// Incoming Vault configuration (note: vault_p sends ID "vault-k1" vs stored "k_vault-k1" — must match without duplicating!)
	vaultProviders := map[string]*types.ProviderConfig{
		"local_p": {
			ID:      "local_p",
			Name:    "Attempted Vault Overwrite",
			BaseURL: "https://malicious-overwrite-url.com",
			Origin:  "vault",
			Enabled: false,
			APIKeys: []*types.KeyEntry{
				{
					ID:      "k_loc_1", // Same ID as local key! Must NOT overwrite local key
					Label:   "my-local-key",
					Key:     "sk-attack-overwrite",
					Origin:  "vault",
					Enabled: false,
				},
				{
					ID:      "k_vault_old", // Matching vault key: would update on a vault provider
					Label:   "shared-v1",
					Key:     "sk-vault-new-secret",
					Origin:  "vault",
					Enabled: true,
				},
				{
					ID:      "k_vault_new", // Brand new vault key: would append on a vault provider
					Label:   "shared-v2",
					Key:     "sk-vault-appended",
					Origin:  "vault",
					Enabled: true,
				},
			},
		},
		"vault_p": {
			ID:      "vault_p",
			Name:    "Updated Vault Provider",
			BaseURL: "https://new-vault-url.com", // Vault provider: BaseURL CAN be updated
			Origin:  "vault",
			Enabled: true,
			APIKeys: []*types.KeyEntry{
				{
					ID:      "vault-k1",
					Label:   "vault-k1",
					Key:     "sk-p2-v1-new",
					Origin:  "vault",
					Enabled: true,
				},
			},
		},
		"new_vault_p": {
			ID:      "new_vault_p",
			Name:    "Brand New Vault Provider",
			BaseURL: "https://new-p.com",
			Origin:  "vault",
			Enabled: true,
			APIKeys: []*types.KeyEntry{
				{
					ID:      "k_new_1",
					Label:   "new-key",
					Key:     "sk-new-key-secret",
					Enabled: true,
				},
			},
		},
	}

	// A vault fetch targeting an existing provider with a non-vault origin is rejected
	// with a conflict (gen-1 semantic): the operator must delete or rename it first.
	// This covers explicit origin=local AND legacy providers stored without an origin.
	_, err = src.MergeVaultConfig(map[string]*types.ProviderConfig{"local_p": vaultProviders["local_p"]}, false)
	var lpcErr *LocalProviderConflictError
	if !errors.As(err, &lpcErr) || lpcErr.Provider != "local_p" {
		t.Fatalf("expected LocalProviderConflictError for local_p, got %v", err)
	}
	_, err = src.MergeVaultConfig(map[string]*types.ProviderConfig{"legacy_p": {
		ID: "legacy_p", Name: "Legacy", BaseURL: "https://legacy.example/v1", Origin: "",
		APIKeys: []*types.KeyEntry{{ID: "lk", Label: "lk", Key: "sk-legacy-attack", Origin: "vault", Enabled: true}},
	}}, true)
	if !errors.As(err, &lpcErr) || lpcErr.Provider != "legacy_p" {
		t.Fatalf("expected LocalProviderConflictError for legacy empty-origin provider, got %v", err)
	}

	mergedSnap, err := src.MergeVaultConfig(map[string]*types.ProviderConfig{
		"vault_p":     vaultProviders["vault_p"],
		"new_vault_p": vaultProviders["new_vault_p"],
	}, false)
	if err != nil {
		t.Fatalf("MergeVaultConfig error: %v", err)
	}

	// 1. Check local_p: untouched by the rejected merge — metadata, keys, nothing moved.
	pLocal := mergedSnap.Config.Providers["local_p"]
	if pLocal == nil {
		t.Fatalf("local_p was deleted!")
	}
	if pLocal.Origin != "local" {
		t.Errorf("expected local_p Origin to remain 'local', got %q", pLocal.Origin)
	}
	if pLocal.BaseURL != "https://local-url.com" {
		t.Errorf("expected local_p BaseURL to be protected, got %q", pLocal.BaseURL)
	}
	if pLocal.Name != "Local Provider" {
		t.Errorf("expected local_p Name to be protected, got %q", pLocal.Name)
	}

	// Keys in local_p must be exactly the two stored ones: no vault key was merged in.
	keyMap := make(map[string]*types.KeyEntry)
	for _, k := range pLocal.APIKeys {
		keyMap[k.ID] = k
	}
	if len(pLocal.APIKeys) != 2 {
		t.Fatalf("expected local_p keys untouched (2), got %+v", pLocal.APIKeys)
	}

	locKey := keyMap["k_loc_1"]
	if locKey == nil || locKey.Key != "sk-local-secret" || locKey.Origin != "local" {
		t.Errorf("local key k_loc_1 was corrupted: %+v", locKey)
	}

	vOldKey := keyMap["k_vault_old"]
	if vOldKey == nil || vOldKey.Key != "sk-vault-old-secret" || vOldKey.Origin != "vault" {
		t.Errorf("stored vault key k_vault_old must stay untouched on a local provider: %+v", vOldKey)
	}
	if keyMap["k_vault_new"] != nil {
		t.Errorf("no vault key may be appended to a local provider: %+v", pLocal.APIKeys)
	}

	// 2. Check vault_p: BaseURL updated, vault-k1 updated in-place without k_<label> vs <label> duplication!
	pVault := mergedSnap.Config.Providers["vault_p"]
	if pVault == nil {
		t.Fatalf("vault_p was deleted!")
	}
	if pVault.BaseURL != "https://new-vault-url.com" {
		t.Errorf("expected vault_p BaseURL updated, got %q", pVault.BaseURL)
	}
	if len(pVault.APIKeys) != 1 || pVault.APIKeys[0].Key != "sk-p2-v1-new" || pVault.APIKeys[0].Origin != "vault" {
		t.Errorf("expected 1 deduplicated vault key on vault_p, got %+v", pVault.APIKeys)
	}

	// 3. Check new_vault_p: added
	pNew := mergedSnap.Config.Providers["new_vault_p"]
	if pNew == nil || pNew.Origin != "vault" {
		t.Errorf("new_vault_p not added properly: %+v", pNew)
	}
	if len(pNew.APIKeys) != 1 || pNew.APIKeys[0].Origin != "vault" {
		t.Errorf("new_vault_p keys not marked vault: %+v", pNew.APIKeys)
	}

	// 4. Reload from disk to verify persistence
	srcReload, err := NewLocalSource(tmpDir, pass)
	if err != nil {
		t.Fatalf("NewLocalSource reload error: %v", err)
	}
	snapDisk, err := srcReload.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current error: %v", err)
	}
	if snapDisk.Config.Providers["local_p"].BaseURL != "https://local-url.com" {
		t.Errorf("persisted local_p BaseURL mismatch")
	}
	if snapDisk.Config.Providers["local_p"].APIKeys[0].Key != "sk-local-secret" {
		t.Errorf("persisted local key mismatch")
	}
}

func TestLocalSource_PersistKeyEntry_Restart(t *testing.T) {
	tmpDir := t.TempDir()
	pass := "persist-test-pass"

	src, err := NewLocalSource(tmpDir, pass)
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	initialCfg := &types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"minimax": {
				ID:      "minimax",
				Name:    "MiniMax",
				BaseURL: "https://api.minimaxi.com",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:       "key-oauth-1",
						Label:    "mm-code",
						Key:      "initial-access-token",
						Enabled:  true,
						AuthType: "oauth_device",
						OAuthMeta: &types.OAuthMeta{
							Provider:     "minimax",
							ClientID:     "client-xyz",
							RefreshToken: "initial-refresh-token",
							ExpiresAt:    1000,
						},
					},
				},
			},
		},
	}

	_, err = src.SaveConfig(initialCfg)
	if err != nil {
		t.Fatalf("SaveConfig err: %v", err)
	}

	// Update OAuth token via PersistKeyEntry
	updatedKey := &types.KeyEntry{
		ID:       "key-oauth-1",
		Label:    "mm-code",
		Key:      "rotated-access-token-999",
		Enabled:  true,
		AuthType: "oauth_device",
		OAuthMeta: &types.OAuthMeta{
			Provider:     "minimax",
			ClientID:     "client-xyz",
			RefreshToken: "rotated-refresh-token-999",
			ExpiresAt:    8000,
		},
	}

	err = src.PersistKeyEntry(context.Background(), updatedKey)
	if err != nil {
		t.Fatalf("PersistKeyEntry err: %v", err)
	}

	// Simulate complete process restart with fresh LocalSource
	restartedSrc, err := NewLocalSource(tmpDir, pass)
	if err != nil {
		t.Fatalf("restart NewLocalSource err: %v", err)
	}

	snap, err := restartedSrc.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("restarted Current err: %v", err)
	}

	loadedKey := snap.Config.Providers["minimax"].APIKeys[0]
	if loadedKey.Key != "rotated-access-token-999" {
		t.Errorf("expected rotated key on restart, got %q", loadedKey.Key)
	}
	if loadedKey.OAuthMeta.RefreshToken != "rotated-refresh-token-999" {
		t.Errorf("expected rotated refresh token on restart, got %q", loadedKey.OAuthMeta.RefreshToken)
	}
	if loadedKey.OAuthMeta.ExpiresAt != 8000 {
		t.Errorf("expected ExpiresAt 8000, got %d", loadedKey.OAuthMeta.ExpiresAt)
	}
}

func TestLocalSource_OnConfigChange_Listener(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	calledCount := 0
	var lastCfg *types.ProxyConfig
	src.OnConfigChange(func(cfg *types.ProxyConfig) {
		calledCount++
		lastCfg = cfg
	})

	_, err = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p1": {ID: "p1", BaseURL: "https://p1.api", Enabled: true},
		},
		Settings: types.RuntimeSettings{
			ClientKey: "new-client-key",
			ProxyKeys: []string{"extra-1", "extra-2"},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig err: %v", err)
	}

	if calledCount != 1 {
		t.Errorf("expected listener called once, got %d", calledCount)
	}
	if lastCfg == nil || lastCfg.Settings.ClientKey != "new-client-key" {
		t.Errorf("listener did not receive updated settings: %+v", lastCfg)
	}
}

func TestLocalSource_MergeVaultConfig_PreservesMagpieFields(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	// Initial config with vault provider
	_, err = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"deepseek": {
				ID:      "deepseek",
				BaseURL: "https://api.deepseek.com",
				Origin:  "vault",
				APIKeys: []*types.KeyEntry{{ID: "k1", Key: "sk-1", Origin: "vault"}},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig err: %v", err)
	}

	// Merge incoming vault update with Magpie fields
	vaultProviders := map[string]*types.ProviderConfig{
		"deepseek": {
			ID:           "deepseek",
			BaseURL:      "https://api.deepseek.com",
			Enabled:      true,
			RPMPerKey:    60,
			QuotaResetAt: "00:00+08:00",
			APIKeys: []*types.KeyEntry{
				{ID: "k1", Key: "sk-1-updated", Enabled: true},
			},
		},
	}

	snap, err := src.MergeVaultConfig(vaultProviders, false)
	if err != nil {
		t.Fatalf("MergeVaultConfig err: %v", err)
	}

	p := snap.Config.Providers["deepseek"]
	if p.RPMPerKey != 60 {
		t.Errorf("expected RPMPerKey 60, got %d", p.RPMPerKey)
	}
	if p.QuotaResetAt != "00:00+08:00" {
		t.Errorf("expected QuotaResetAt '00:00+08:00', got %q", p.QuotaResetAt)
	}
}

func TestLocalSource_KernelGuard_VaultOriginLock_And_RefreshToken(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	if !IsMaskedSecret("sk-••••••") {
		t.Fatalf("expected U+2022 bullet string to be recognized as masked")
	}

	_, err = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"shared": {
				ID:      "shared",
				BaseURL: "https://api.shared.example",
				Origin:  "vault",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "vk-1",
						Label:   "vault-oauth",
						Key:     "sk-real-vault-access-token",
						Origin:  "vault",
						Enabled: true,
						OAuthMeta: &types.OAuthMeta{
							Provider:     "minimax",
							ClientID:     "cid-1",
							RefreshToken: "rt-real-vault-refresh-token",
						},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig initial err: %v", err)
	}

	// Attempt to flip Origin from "vault" to "local" (and "") while submitting masked secrets
	snap, err := src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"shared": {
				ID:      "shared",
				BaseURL: "https://api.shared.example",
				Origin:  "local",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{
						ID:      "vk-1",
						Label:   "vault-oauth",
						Key:     "sk--...oken",
						Origin:  "local", // Attack: try flipping origin to local to unmask on next GET!
						Enabled: true,
						OAuthMeta: &types.OAuthMeta{
							Provider:     "minimax",
							ClientID:     "cid-1",
							RefreshToken: "rt--...oken",
						},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig update err: %v", err)
	}

	got := snap.Config.Providers["shared"].APIKeys[0]
	if got.Origin != "vault" {
		t.Fatalf("SEC-06 violation: expected Origin to remain 'vault', got %q", got.Origin)
	}
	if got.Key != "sk-real-vault-access-token" {
		t.Fatalf("expected real vault key to be recovered, got %q", got.Key)
	}
	if got.OAuthMeta == nil || got.OAuthMeta.RefreshToken != "rt-real-vault-refresh-token" {
		t.Fatalf("expected real RefreshToken to be recovered, got %+v", got.OAuthMeta)
	}
}

func TestLocalSource_VaultURLChangeGuard(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	// 1. Save initial config with real Vault NodeToken
	_, err = src.SaveConfig(&types.ProxyConfig{
		Version:   1,
		Providers: map[string]*types.ProviderConfig{},
		Vault: &types.VaultClientConfig{
			URL:       "https://hub.trusted.example/",
			NodeToken: "stk_node_super_secret_token",
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig initial err: %v", err)
	}

	// 2. Save with SAME URL (without trailing slash) and masked NodeToken -> recovers real NodeToken
	snapSame, err := src.SaveConfig(&types.ProxyConfig{
		Version:   1,
		Providers: map[string]*types.ProviderConfig{},
		Vault: &types.VaultClientConfig{
			URL:       "https://hub.trusted.example",
			NodeToken: "stk-...oken",
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig same URL err: %v", err)
	}
	if snapSame.Config.Vault.NodeToken != "stk_node_super_secret_token" {
		t.Fatalf("expected NodeToken recovered when Vault.URL unchanged, got %q", snapSame.Config.Vault.NodeToken)
	}

	// 3. Save with CHANGED URL and masked NodeToken -> MUST clear NodeToken!
	snapChanged, err := src.SaveConfig(&types.ProxyConfig{
		Version:   2,
		Providers: map[string]*types.ProviderConfig{},
		Vault: &types.VaultClientConfig{
			URL:       "https://evil.attacker.example",
			NodeToken: "stk-...oken",
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig changed URL err: %v", err)
	}
	if snapChanged.Config.Vault.NodeToken != "" {
		t.Fatalf("SEC-07 violation: expected NodeToken to be cleared when Vault.URL changed with masked token, got %q", snapChanged.Config.Vault.NodeToken)
	}
}

func TestLocalSource_StrictNoMixedKeys_And_DefaultSettings(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	// 1. Cold-start save with Version: 0 populates DefaultRuntimeSettings (P1-3)
	snapInit, err := src.SaveConfig(&types.ProxyConfig{
		Version: 0,
		Providers: map[string]*types.ProviderConfig{
			"local-ollama": {
				ID:      "local-ollama",
				Name:    "Local Ollama",
				BaseURL: "http://127.0.0.1:11434/v1",
				Origin:  "local",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "loc-k1", Label: "loc-k1", Key: "sk-local-ollama", Origin: "local", Enabled: true},
				},
			},
			"stale-vault-prov": {
				ID:      "stale-vault-prov",
				BaseURL: "https://stale.vault/v1",
				Origin:  "vault",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "svk1", Label: "svk1", Key: "sk-stale-vault", Origin: "vault", Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"local-llama3": {
				Enabled:    true,
				Origin:     "local",
				Candidates: []*types.RouteCandidate{{Provider: "local-ollama", KeyLabel: "loc-k1", Enabled: true}},
			},
			"stale-vault-model": {
				Enabled:    true,
				Origin:     "vault",
				Candidates: []*types.RouteCandidate{{Provider: "stale-vault-prov", KeyLabel: "svk1", Enabled: true}},
			},
			"shared-gpt4o": {
				Enabled: true,
				Origin:  "vault",
				Candidates: []*types.RouteCandidate{
					{Provider: "stale-vault-prov", KeyLabel: "svk1", Enabled: true},
					{Provider: "local-ollama", KeyLabel: "loc-k1", TargetModel: "llama3", Enabled: true},
				},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {
				{Provider: "stale-vault-prov", Model: "old-ocr", KeyLabel: "svk1", Enabled: true},
				{Provider: "local-ollama", Model: "llava", KeyLabel: "loc-k1", Enabled: true},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig initial err: %v", err)
	}
	if snapInit.Config.Settings.AgentRoutingStrategy != "sticky_failover" ||
		snapInit.Config.Settings.AgentFirstByteTimeoutSec != 120 ||
		snapInit.Config.Settings.CooldownRateLimitSec != 15 ||
		snapInit.Config.Settings.CooldownServerErrorSec != 30 ||
		snapInit.Config.Settings.CooldownNetworkErrorSec != 15 ||
		snapInit.Config.Settings.CooldownAuthErrorSec != 86400 ||
		snapInit.Config.Settings.OCRMaxInflight != 4 ||
		snapInit.Config.Settings.KBGlobalMaxConcurrency != 16 {
		t.Fatalf("P1-3: expected cold-start schema defaults, got %+v", snapInit.Config.Settings)
	}

	// 2. Strict No-Mixed-Keys Rule (User Decision #3): attempting to add a local key onto a vault provider via SaveConfig is ignored!
	snapAttemptMix, err := src.SaveConfig(&types.ProxyConfig{
		Version: snapInit.Config.Version,
		Providers: map[string]*types.ProviderConfig{
			"local-ollama": snapInit.Config.Providers["local-ollama"],
			"stale-vault-prov": {
				ID:      "stale-vault-prov",
				BaseURL: "https://stale.vault/v1",
				Origin:  "vault",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "svk1", Label: "svk1", Key: "sk--...ault", Origin: "vault", Enabled: true},
					{ID: "injected-local", Label: "injected-local", Key: "sk-user-local-on-vault", Origin: "local", Enabled: true},
				},
			},
		},
		AgentModels: snapInit.Config.AgentModels,
		KBModels:    snapInit.Config.KBModels,
		Settings:    snapInit.Config.Settings,
	})
	if err != nil {
		t.Fatalf("SaveConfig mix attempt err: %v", err)
	}
	vpKeys := snapAttemptMix.Config.Providers["stale-vault-prov"].APIKeys
	if len(vpKeys) != 1 || vpKeys[0].ID != "svk1" || vpKeys[0].Key != "sk-stale-vault" {
		t.Fatalf("User Decision #3 violation: expected only stored vault key svk1 on vault provider, got %+v", vpKeys)
	}
}

// enforceVaultLock: hub-managed provider fields and vault key values/labels are
// force-restored to storage during SaveConfig submissions, a stored key missing from the
// submission counts as a local deletion (allowed), and local keys are rejected (no mixing).
func TestLocalSource_EnforceVaultLock(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	_, err = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"vp": {
				ID:               "vp",
				Name:             "Vault Provider",
				BaseURL:          "https://vault.example/v1",
				AnthropicBaseURL: "https://vault.example/anthropic",
				PresetID:         "preset-x",
				APIType:          "anthropic",
				Origin:           "vault",
				Enabled:          true,
				AdapterRules:     &types.AdapterRules{AuthPrefix: "Bearer ", StripParams: []string{"foo"}},
				APIKeys: []*types.KeyEntry{
					{ID: "vk-1", Label: "vk-1", Key: "sk-test-vault-real-1", Origin: "vault", Enabled: true},
					{ID: "vk-2", Label: "vk-2", Key: "sk-test-vault-real-2", Origin: "vault", Enabled: true},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig seed err: %v", err)
	}

	cur, err := src.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current err: %v", err)
	}

	// Submit tampered hub-managed fields, a tampered value + renamed label on vk-1, an
	// injected local key, and omit vk-2 (= local deletion, allowed).
	snap, err := src.SaveConfig(&types.ProxyConfig{
		Version: cur.Config.Version,
		Providers: map[string]*types.ProviderConfig{
			"vp": {
				ID:               "vp",
				Name:             "Vault Provider",
				BaseURL:          "https://evil.example/v1",
				AnthropicBaseURL: "https://evil.example/anthropic",
				PresetID:         "evil-preset",
				APIType:          "openai",
				HideClientName:   true,
				Origin:           "vault",
				Enabled:          true,
				AdapterRules:     &types.AdapterRules{AuthPrefix: "X-Key ", StripParams: []string{"bar"}},
				APIKeys: []*types.KeyEntry{
					{ID: "vk-1", Label: "renamed-1", Key: "sk-test-tampered-1", Origin: "vault", Enabled: false},
					{ID: "inj-1", Label: "inj-1", Key: "sk-test-local-inject", Origin: "local", Enabled: true},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig tampered err: %v", err)
	}

	p := snap.Config.Providers["vp"]
	if p.BaseURL != "https://vault.example/v1" {
		t.Errorf("field lock: expected base_url restored, got %q", p.BaseURL)
	}
	if p.AnthropicBaseURL != "https://vault.example/anthropic" {
		t.Errorf("field lock: expected anthropic_base_url restored, got %q", p.AnthropicBaseURL)
	}
	if p.PresetID != "preset-x" {
		t.Errorf("field lock: expected preset_id restored, got %q", p.PresetID)
	}
	if p.APIType != "anthropic" {
		t.Errorf("field lock: expected api_type restored, got %q", p.APIType)
	}
	if p.HideClientName {
		t.Errorf("field lock: expected hide_client_name restored, got %v", p.HideClientName)
	}
	if p.AdapterRules == nil || p.AdapterRules.AuthPrefix != "Bearer " || len(p.AdapterRules.StripParams) != 1 || p.AdapterRules.StripParams[0] != "foo" {
		t.Errorf("field lock: expected adapter_rules restored, got %+v", p.AdapterRules)
	}

	if len(p.APIKeys) != 1 {
		t.Fatalf("key lock: expected only vk-1 to remain (vk-2 deleted locally, inject rejected), got %+v", p.APIKeys)
	}
	got := p.APIKeys[0]
	if got.ID != "vk-1" || got.Label != "vk-1" || got.Key != "sk-test-vault-real-1" {
		t.Errorf("key lock: expected vk-1 value/label restored, got %+v", got)
	}
	if got.Enabled != false {
		t.Errorf("key lock: expected Enabled toggle from submission to pass through, got %v", got.Enabled)
	}
}

// MergeVaultConfig replace branch: a re-fetch of an existing vault provider replaces the
// hub-managed fields and the vault key list wholesale (keys deleted locally reappear,
// new hub keys are appended), while locally refreshed OAuth token state survives; new
// providers are added and local providers stay untouched.
func TestLocalSource_MergeVaultConfig_ReplaceBranch(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	_, err = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"ds": {
				ID:               "ds",
				Name:             "DeepSeek",
				BaseURL:          "https://api.deepseek.com/v1",
				AnthropicBaseURL: "https://api.deepseek.com/anthropic",
				PresetID:         "deepseek",
				APIType:          "openai",
				HideClientName:   true,
				Origin:           "vault",
				Enabled:          true,
				AdapterRules:     &types.AdapterRules{AuthPrefix: "Bearer ", StripParams: []string{"foo"}},
				APIKeys: []*types.KeyEntry{
					{ID: "vk-1", Label: "vk-1", Key: "sk-test-ds-1", Origin: "vault", Enabled: true},
					{ID: "vk-2", Label: "vk-2", Key: "sk-test-ds-2", Origin: "vault", Enabled: true,
						OAuthMeta: &types.OAuthMeta{Provider: "ds", ClientID: "cid-1", RefreshToken: "rt-old", ExpiresAt: 1000}},
				},
			},
			"localp": {
				ID: "localp", Name: "Local", BaseURL: "https://local.example/v1", Origin: "local", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "lk-1", Label: "lk-1", Key: "sk-test-local-1", Origin: "local", Enabled: true}},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig seed err: %v", err)
	}

	// Operator refreshes the OAuth token on vk-2 locally, then deletes vk-1 locally.
	err = src.PersistKeyEntry(context.Background(), &types.KeyEntry{
		ID: "vk-2", Label: "vk-2", Key: "sk-test-ds-2-local", Enabled: true,
		OAuthMeta: &types.OAuthMeta{Provider: "ds", ClientID: "cid-1", RefreshToken: "rt-new", ExpiresAt: 9000},
	})
	if err != nil {
		t.Fatalf("PersistKeyEntry err: %v", err)
	}
	cur, err := src.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current err: %v", err)
	}
	rawCfg, _ := json.Marshal(cur.Config)
	var edited types.ProxyConfig
	_ = json.Unmarshal(rawCfg, &edited)
	keptKeys := make([]*types.KeyEntry, 0, len(edited.Providers["ds"].APIKeys))
	for _, k := range edited.Providers["ds"].APIKeys {
		if k != nil && k.ID != "vk-1" {
			keptKeys = append(keptKeys, k)
		}
	}
	edited.Providers["ds"].APIKeys = keptKeys
	if _, err := src.SaveConfig(&edited); err != nil {
		t.Fatalf("SaveConfig delete vk-1 err: %v", err)
	}

	// Re-fetch from the Hub with replace=true: vk-1 comes back, vk-2 keeps local OAuth state.
	snap, err := src.MergeVaultConfig(map[string]*types.ProviderConfig{
		"ds": {
			ID:               "ds",
			Name:             "DeepSeek Hub",
			BaseURL:          "https://hub.example/v1",
			AnthropicBaseURL: "https://hub.example/anthropic",
			PresetID:         "hub-preset",
			APIType:          "anthropic",
			Origin:           "vault",
			Enabled:          true,
			RuleHash:         "hash-2",
			AdapterRules:     &types.AdapterRules{AuthPrefix: "X-Key ", StripParams: []string{"bar"}},
			APIKeys: []*types.KeyEntry{
				{ID: "vk-1", Label: "vk-1", Key: "sk-test-ds-1-new", Enabled: true},
				{ID: "vk-2", Label: "vk-2", Key: "sk-test-ds-2-hub", Enabled: true,
					OAuthMeta: &types.OAuthMeta{Provider: "ds", ClientID: "cid-1", RefreshToken: "rt-old", ExpiresAt: 1000}},
				{ID: "vk-3", Label: "vk-3", Key: "sk-test-ds-3", Enabled: true},
			},
		},
		"newp": {
			ID: "newp", Name: "New From Hub", BaseURL: "https://new.example/v1", Enabled: true,
			APIKeys: []*types.KeyEntry{{ID: "vk-9", Label: "vk-9", Key: "sk-test-newp-1", Enabled: true}},
		},
	}, true)
	if err != nil {
		t.Fatalf("MergeVaultConfig replace err: %v", err)
	}

	p := snap.Config.Providers["ds"]
	if p.BaseURL != "https://hub.example/v1" || p.AnthropicBaseURL != "https://hub.example/anthropic" ||
		p.PresetID != "hub-preset" || p.APIType != "anthropic" || p.HideClientName || p.RuleHash != "hash-2" {
		t.Errorf("replace: hub-managed fields not replaced wholesale: %+v", p)
	}
	if p.AdapterRules == nil || p.AdapterRules.AuthPrefix != "X-Key " || len(p.AdapterRules.StripParams) != 1 || p.AdapterRules.StripParams[0] != "bar" {
		t.Errorf("replace: adapter_rules not replaced: %+v", p.AdapterRules)
	}

	keyByID := make(map[string]*types.KeyEntry)
	for _, k := range p.APIKeys {
		keyByID[k.ID] = k
	}
	if len(p.APIKeys) != 3 {
		t.Fatalf("replace: expected 3 vault keys (vk-1 restored, vk-3 appended), got %+v", p.APIKeys)
	}
	if k1 := keyByID["vk-1"]; k1 == nil || k1.Key != "sk-test-ds-1-new" || k1.Origin != "vault" {
		t.Errorf("replace: locally deleted vk-1 not restored: %+v", k1)
	}
	if k2 := keyByID["vk-2"]; k2 == nil || k2.Key != "sk-test-ds-2-local" || k2.OAuthMeta == nil ||
		k2.OAuthMeta.ExpiresAt != 9000 || k2.OAuthMeta.RefreshToken != "rt-new" {
		t.Errorf("replace: locally refreshed OAuth state on vk-2 was clobbered: %+v", k2)
	}
	if k3 := keyByID["vk-3"]; k3 == nil || k3.Key != "sk-test-ds-3" || k3.Origin != "vault" {
		t.Errorf("replace: new hub key vk-3 not appended: %+v", k3)
	}

	np := snap.Config.Providers["newp"]
	if np == nil || np.Origin != "vault" || len(np.APIKeys) != 1 || np.APIKeys[0].Key != "sk-test-newp-1" {
		t.Errorf("replace: new provider newp not added properly: %+v", np)
	}

	lp := snap.Config.Providers["localp"]
	if lp == nil || lp.BaseURL != "https://local.example/v1" || lp.Origin != "local" ||
		len(lp.APIKeys) != 1 || lp.APIKeys[0].Key != "sk-test-local-1" {
		t.Errorf("replace: local provider was touched: %+v", lp)
	}
}

// The hub fetch payload carries no "enabled" flag, and older hubs omit api_type/rule_hash
// as well: a merge or replace must never wipe locally stored api_type/rule_hash (kb native
// OCR detection and rule-drift detection depend on them) or re-enable locally disabled
// providers/keys.
func TestLocalSource_MergeVaultConfig_PreservesLocalState(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	_, err = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"ds": {
				ID:       "ds",
				Name:     "DeepSeek",
				BaseURL:  "https://api.deepseek.com/v1",
				APIType:  "native_ocr",
				RuleHash: "hash-1",
				Origin:   "vault",
				Enabled:  false, // locally disabled
				APIKeys: []*types.KeyEntry{
					{ID: "vk-1", Label: "vk-1", Key: "sk-test-ds-1", Origin: "vault", Enabled: false}, // locally disabled
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig seed err: %v", err)
	}

	// Replace-shaped refetch whose payload omits api_type/rule_hash/enabled entirely —
	// exactly what a hub fetch response looks like for these fields.
	snap, err := src.MergeVaultConfig(map[string]*types.ProviderConfig{
		"ds": {
			ID:           "ds",
			Name:         "DeepSeek Hub",
			BaseURL:      "https://hub.example/v1",
			Origin:       "vault",
			AdapterRules: &types.AdapterRules{AuthPrefix: "X-Key ", StripParams: []string{"bar"}},
			APIKeys: []*types.KeyEntry{
				{ID: "vk-1", Label: "vk-1", Key: "sk-test-ds-1-new", Enabled: true},
			},
		},
	}, true)
	if err != nil {
		t.Fatalf("MergeVaultConfig replace err: %v", err)
	}

	p := snap.Config.Providers["ds"]
	if p.APIType != "native_ocr" {
		t.Errorf("api_type wiped by refetch: got %q", p.APIType)
	}
	if p.RuleHash != "hash-1" {
		t.Errorf("rule_hash wiped by refetch: got %q", p.RuleHash)
	}
	if p.Enabled {
		t.Errorf("locally disabled provider was re-enabled by refetch")
	}
	if len(p.APIKeys) != 1 || p.APIKeys[0].Key != "sk-test-ds-1-new" {
		t.Fatalf("expected the refetched key material to land, got %+v", p.APIKeys)
	}
	if p.APIKeys[0].Enabled {
		t.Errorf("locally disabled vault key was re-enabled by refetch: %+v", p.APIKeys[0])
	}

	// A non-empty payload api_type/rule_hash (current hubs always send them) does move.
	snap, err = src.MergeVaultConfig(map[string]*types.ProviderConfig{
		"ds": {
			ID:       "ds",
			Name:     "DeepSeek Hub",
			BaseURL:  "https://hub.example/v1",
			APIType:  "anthropic",
			RuleHash: "hash-2",
			Origin:   "vault",
			APIKeys: []*types.KeyEntry{
				{ID: "vk-1", Label: "vk-1", Key: "sk-test-ds-1-new", Enabled: true},
			},
		},
	}, true)
	if err != nil {
		t.Fatalf("MergeVaultConfig replace with fields err: %v", err)
	}
	p = snap.Config.Providers["ds"]
	if p.APIType != "anthropic" || p.RuleHash != "hash-2" {
		t.Errorf("hub-sent api_type/rule_hash not adopted: %q / %q", p.APIType, p.RuleHash)
	}
	if p.Enabled {
		t.Errorf("locally disabled provider was re-enabled by refetch")
	}
}

// Migration: AgentModelRoutes materialized by the removed one-click full sync
// (Origin == "vault") become local routes on load; kb_models stay untouched.
func TestLocalSource_LoadFromDisk_MigratesVaultRoutesToLocal(t *testing.T) {
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("NewLocalSource err: %v", err)
	}

	_, err = src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID: "p1", BaseURL: "https://p1.example/v1", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-test-p1", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"vault-route": {
				Enabled:    true,
				Origin:     "vault",
				Candidates: []*types.RouteCandidate{{Provider: "p1", KeyLabel: "k1", Enabled: true}},
			},
			"local-route": {
				Enabled:    true,
				Origin:     "local",
				Candidates: []*types.RouteCandidate{{Provider: "p1", KeyLabel: "k1", Enabled: true}},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {{Provider: "p1", Model: "ocr-x", KeyLabel: "k1", Enabled: true}},
		},
	})
	if err != nil {
		t.Fatalf("SaveConfig seed err: %v", err)
	}

	reloaded, err := NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("reload NewLocalSource err: %v", err)
	}
	snap, err := reloaded.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current err: %v", err)
	}
	if r := snap.Config.AgentModels["vault-route"]; r == nil || r.Origin != "local" {
		t.Errorf("migration: expected vault-route Origin 'local' after load, got %+v", r)
	}
	if r := snap.Config.AgentModels["local-route"]; r == nil || r.Origin != "local" {
		t.Errorf("migration: local-route Origin changed: %+v", r)
	}
	if len(snap.Config.KBModels["ocr"]) != 1 {
		t.Errorf("migration: kb_models must stay untouched, got %+v", snap.Config.KBModels)
	}
}
