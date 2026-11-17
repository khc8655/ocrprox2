package config

import (
	"context"
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
					ID:      "k_vault_old", // Matching vault key: should update
					Label:   "shared-v1",
					Key:     "sk-vault-new-secret",
					Origin:  "vault",
					Enabled: true,
				},
				{
					ID:      "k_vault_new", // Brand new vault key: should append
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

	mergedSnap, err := src.MergeVaultConfig(vaultProviders)
	if err != nil {
		t.Fatalf("MergeVaultConfig error: %v", err)
	}

	// 1. Check local_p: Provider metadata MUST NOT be overwritten
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

	// Keys in local_p:
	// - k_loc_1 must keep original secret (sk-local-secret) and Origin: local
	// - k_vault_old must be updated to sk-vault-new-secret
	// - k_vault_new must be appended
	keyMap := make(map[string]*types.KeyEntry)
	for _, k := range pLocal.APIKeys {
		keyMap[k.ID] = k
	}

	locKey := keyMap["k_loc_1"]
	if locKey == nil || locKey.Key != "sk-local-secret" || locKey.Origin != "local" {
		t.Errorf("local key k_loc_1 was corrupted: %+v", locKey)
	}

	vOldKey := keyMap["k_vault_old"]
	if vOldKey == nil || vOldKey.Key != "sk-vault-new-secret" || vOldKey.Origin != "vault" {
		t.Errorf("vault key k_vault_old was not updated properly: %+v", vOldKey)
	}

	vNewKey := keyMap["k_vault_new"]
	if vNewKey == nil || vNewKey.Key != "sk-vault-appended" || vNewKey.Origin != "vault" {
		t.Errorf("new vault key k_vault_new was not appended properly: %+v", vNewKey)
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

	snap, err := src.MergeVaultConfig(vaultProviders)
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

func TestLocalSource_StrictNoMixedKeys_And_MergeHubSync_And_DefaultSettings(t *testing.T) {
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

	// 3. MergeHubSync (P0-01 & P0-02): replaces vault providers/models/kb_models while preserving local ones!
	merged, err := src.MergeHubSync(&types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"deepseek": {
				ID:      "deepseek",
				Name:    "DeepSeek Hub",
				BaseURL: "https://api.deepseek.com/v1",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{Label: "hk-01", Key: "sk-ds-hub-1", Enabled: true},
					{ID: "k_hk-01", Label: "hk-01", Key: "sk-ds-hub-1-dedup", Enabled: true}, // duplicate label must deduplicate!
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"shared-gpt4o": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "deepseek", KeyLabel: "hk-01", TargetModel: "deepseek-chat", Enabled: true},
				},
			},
			"deepseek-r1": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "deepseek", KeyLabel: "hk-01", TargetModel: "deepseek-reasoner", Enabled: true},
				},
			},
		},
		KBModels: map[string][]*types.KBCandidate{
			"ocr": {
				{Provider: "deepseek", Model: "deepseek-vl", KeyLabel: "hk-01", Enabled: true},
			},
		},
		Settings: types.RuntimeSettings{
			ClientKey: "sk-llmproxy-from-hub",
		},
	})
	if err != nil {
		t.Fatalf("MergeHubSync err: %v", err)
	}

	// Stale vault provider removed; local-ollama preserved; deepseek inserted with 1 deduplicated vault key
	if _, exists := merged.Providers["stale-vault-prov"]; exists {
		t.Fatalf("expected stale-vault-prov to be removed by MergeHubSync")
	}
	if merged.Providers["local-ollama"] == nil || merged.Providers["local-ollama"].APIKeys[0].Key != "sk-local-ollama" {
		t.Fatalf("expected local-ollama provider preserved untouched")
	}
	ds := merged.Providers["deepseek"]
	if ds == nil || ds.Origin != "vault" || len(ds.APIKeys) != 1 || ds.APIKeys[0].Key != "sk-ds-hub-1-dedup" || ds.APIKeys[0].ID == "" {
		t.Fatalf("expected deepseek with 1 deduplicated vault key, got %+v", ds)
	}

	// Stale vault model removed; local-llama3 preserved; shared-gpt4o updated as vault + local candidate preserved; deepseek-r1 inserted
	if _, exists := merged.AgentModels["stale-vault-model"]; exists {
		t.Fatalf("expected stale-vault-model to be removed by MergeHubSync")
	}
	if merged.AgentModels["local-llama3"] == nil {
		t.Fatalf("expected local-llama3 to be preserved")
	}
	sharedRoute := merged.AgentModels["shared-gpt4o"]
	if sharedRoute == nil || sharedRoute.Origin != "vault" || len(sharedRoute.Candidates) != 2 {
		t.Fatalf("expected shared-gpt4o with 1 hub candidate + 1 preserved local candidate, got %+v", sharedRoute)
	}
	if merged.AgentModels["deepseek-r1"] == nil || merged.AgentModels["deepseek-r1"].Origin != "vault" {
		t.Fatalf("expected deepseek-r1 inserted with Origin='vault'")
	}

	// KBModels: stale vault ocr candidate replaced by deepseek-vl, local-ollama llava preserved!
	if len(merged.KBModels["ocr"]) != 2 || merged.KBModels["ocr"][0].Provider != "deepseek" || merged.KBModels["ocr"][1].Provider != "local-ollama" {
		t.Fatalf("unexpected merged KBModels['ocr']: %+v", merged.KBModels["ocr"])
	}

	// ClientKey adopted since local Settings.ClientKey was empty
	if merged.Settings.ClientKey != "sk-llmproxy-from-hub" {
		t.Fatalf("expected ClientKey adopted from Hub, got %q", merged.Settings.ClientKey)
	}
}
