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
		Settings: types.RuntimeSettings{
			RunMode: types.ModeAgent,
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
		Settings: types.RuntimeSettings{
			RunMode: types.ModeAgent,
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
						ID:      "k_p2_loc",
						Label:   "admin-added-local-key",
						Key:     "sk-p2-local-secret",
						Origin:  "local",
						Enabled: true,
					},
					{
						ID:      "k_p2_v1",
						Label:   "vault-k1",
						Key:     "sk-p2-v1-old",
						Origin:  "vault",
						Enabled: true,
					},
				},
			},
		},
		Settings: types.RuntimeSettings{
			RunMode: types.ModeAgent,
		},
	}

	_, err = src.SaveConfig(initialCfg)
	if err != nil {
		t.Fatalf("SaveConfig error: %v", err)
	}

	// Incoming Vault configuration
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
					ID:      "k_p2_v1",
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

	// 2. Check vault_p: BaseURL updated, local key preserved
	pVault := mergedSnap.Config.Providers["vault_p"]
	if pVault == nil {
		t.Fatalf("vault_p was deleted!")
	}
	if pVault.BaseURL != "https://new-vault-url.com" {
		t.Errorf("expected vault_p BaseURL updated, got %q", pVault.BaseURL)
	}
	p2KeyMap := make(map[string]*types.KeyEntry)
	for _, k := range pVault.APIKeys {
		p2KeyMap[k.ID] = k
	}
	if p2KeyMap["k_p2_loc"] == nil || p2KeyMap["k_p2_loc"].Key != "sk-p2-local-secret" || p2KeyMap["k_p2_loc"].Origin != "local" {
		t.Errorf("local key on vault provider was not preserved: %+v", p2KeyMap["k_p2_loc"])
	}
	if p2KeyMap["k_p2_v1"] == nil || p2KeyMap["k_p2_v1"].Key != "sk-p2-v1-new" || p2KeyMap["k_p2_v1"].Origin != "vault" {
		t.Errorf("vault key on vault provider was not updated: %+v", p2KeyMap["k_p2_v1"])
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

func TestLocalSource_UpdateRunMode(t *testing.T) {
	tmpDir := t.TempDir()
	pass := "runmode-test-pass"

	src, err := NewLocalSource(tmpDir, pass)
	if err != nil {
		t.Fatalf("NewLocalSource error: %v", err)
	}

	initialCfg := &types.ProxyConfig{
		Version:   1,
		Providers: map[string]*types.ProviderConfig{},
		Settings: types.RuntimeSettings{
			RunMode: types.ModeAgent,
		},
	}

	snap1, err := src.SaveConfig(initialCfg)
	if err != nil {
		t.Fatalf("SaveConfig error: %v", err)
	}
	if snap1.Config.Settings.RunMode != types.ModeAgent {
		t.Errorf("expected initial ModeAgent, got %s", snap1.Config.Settings.RunMode)
	}

	// Update to ModeKB
	snap2, err := src.UpdateRunMode(types.ModeKB)
	if err != nil {
		t.Fatalf("UpdateRunMode error: %v", err)
	}
	if snap2.Config.Settings.RunMode != types.ModeKB {
		t.Errorf("expected ModeKB, got %s", snap2.Config.Settings.RunMode)
	}
	if snap2.Config.Version != 2 {
		t.Errorf("expected version 2, got %d", snap2.Config.Version)
	}

	// Verify persistence on disk
	src2, err := NewLocalSource(tmpDir, pass)
	if err != nil {
		t.Fatalf("NewLocalSource reload error: %v", err)
	}
	snapLoaded, err := src2.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current error: %v", err)
	}
	if snapLoaded.Config.Settings.RunMode != types.ModeKB {
		t.Errorf("expected loaded ModeKB, got %s", snapLoaded.Config.Settings.RunMode)
	}
	if snapLoaded.Config.Version != 2 {
		t.Errorf("expected loaded version 2, got %d", snapLoaded.Config.Version)
	}
}
