// Package config provides configuration storage for Full mode (LocalSource)
// and handles encryption, Kernel Guard secret recovery, and CAS 409 concurrency protection.
package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/khc8655/llmproxy2/internal/crypto"
	"github.com/khc8655/llmproxy2/internal/lastgood"
	"github.com/khc8655/llmproxy2/internal/steady"
	"github.com/khc8655/llmproxy2/internal/types"
)

var (
	ErrVersionConflict = errors.New("config: version conflict (CAS 409)")
	ErrEmptyConfig     = errors.New("config: configuration is empty")
)

// VersionConflictError reports a CAS 409 version mismatch during config updates.
type VersionConflictError struct {
	CurrentVersion   int64
	SubmittedVersion int64
}

func (e *VersionConflictError) Error() string {
	return fmt.Sprintf("config: version conflict (CAS 409): current %d, submitted %d", e.CurrentVersion, e.SubmittedVersion)
}

func (e *VersionConflictError) Unwrap() error {
	return ErrVersionConflict
}

func (e *VersionConflictError) Is(target error) bool {
	return target == ErrVersionConflict
}

const ConfigFileName = "proxy_config.enc"

// ErrConfigNotInitialized is returned when no configuration file exists yet.
// Callers must map it to a generic user-facing message instead of echoing the
// underlying filesystem path.
var ErrConfigNotInitialized = errors.New("config: not initialized")

// LocalSource implements types.ConfigSource for Full mode.
type LocalSource struct {
	mu         sync.Mutex
	configDir  string
	configPath string
	passphrase string
	snapshot   atomic.Pointer[types.RuntimeSnapshot]
	listeners  []ConfigChangeFunc
}

// ConfigChangeFunc is called when a configuration is loaded or updated.
type ConfigChangeFunc func(cfg *types.ProxyConfig)

// OnConfigChange registers a callback to be invoked whenever configuration changes or is reloaded.
func (s *LocalSource) OnConfigChange(fn ConfigChangeFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listeners = append(s.listeners, fn)
}

func (s *LocalSource) notifyListeners(cfg *types.ProxyConfig) {
	for _, l := range s.listeners {
		if l != nil {
			l(cfg)
		}
	}
}

// NewLocalSource initializes a LocalSource.
func NewLocalSource(configDir, passphrase string) (*LocalSource, error) {
	if configDir == "" {
		configDir = "/opt/ocrproxy/config"
	}
	s := &LocalSource{
		configDir:  configDir,
		configPath: filepath.Join(configDir, ConfigFileName),
		passphrase: passphrase,
	}

	// Try loading existing config if present
	if _, err := os.Stat(s.configPath); err == nil {
		if _, err := s.loadFromDisk(); err != nil {
			return nil, fmt.Errorf("config: load failed: %w", err)
		}
	}

	return s, nil
}

// Current returns current runtime snapshot.
func (s *LocalSource) Current(ctx context.Context, forceRefresh bool) (*types.RuntimeSnapshot, error) {
	if forceRefresh {
		return s.loadFromDisk()
	}
	snap := s.snapshot.Load()
	if snap != nil {
		return snap, nil
	}
	return s.loadFromDisk()
}

// HealthState returns status for /healthz.
func (s *LocalSource) HealthState() (status string, state string, leaseValid bool, configVer int64) {
	snap := s.snapshot.Load()
	if snap == nil || snap.Config == nil {
		return "standby", "no_config", false, 0
	}
	return "healthy", "ready", true, snap.Config.Version
}

// IsMaskedSecret checks if a string is a masked credential placeholder.
func IsMaskedSecret(val string) bool {
	s := strings.TrimSpace(val)
	if s == "" {
		return false
	}
	if strings.Contains(s, "●") || strings.Contains(s, "•") || s == "********" || strings.HasPrefix(s, "***") || strings.Contains(s, "…") {
		return true
	}
	// Short hint format emitted by maskSecret: "sk--...7Yjl" (prefix-...-suffix).
	if strings.Contains(s, "-...") {
		return true
	}
	return false
}

// normalizeProviderIDs backfills ProviderConfig.ID from its map key. The admin UI
// used to create providers without writing `id` into the object, which left
// provider.ID empty in the scheduler and silently disabled per-provider/per-key
// usage statistics.
func normalizeProviderIDs(cfg *types.ProxyConfig) {
	if cfg == nil {
		return
	}
	for id, p := range cfg.Providers {
		if p != nil && p.ID == "" {
			p.ID = id
		}
	}
}

// SaveConfig saves updated config to disk with Kernel Guard and CAS checks.
func (s *LocalSource) SaveConfig(newCfg *types.ProxyConfig) (*types.RuntimeSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.saveConfigLocked(newCfg)
}

// PersistKeyEntry atomically updates the given KeyEntry (matching by ID, Label, or OAuthMeta) in the current config and saves to proxy_config.enc.
func (s *LocalSource) PersistKeyEntry(ctx context.Context, updatedKey *types.KeyEntry) error {
	if updatedKey == nil {
		return errors.New("config: nil key entry")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	currentSnap := s.snapshot.Load()
	if currentSnap == nil || currentSnap.Config == nil {
		return errors.New("config: no config loaded")
	}

	// Deep clone current config
	raw, err := json.Marshal(currentSnap.Config)
	if err != nil {
		return err
	}
	var clonedCfg types.ProxyConfig
	if err := json.Unmarshal(raw, &clonedCfg); err != nil {
		return err
	}

	found := false
	for _, prov := range clonedCfg.Providers {
		if prov == nil {
			continue
		}
		for i, k := range prov.APIKeys {
			if k == nil {
				continue
			}
			matched := false
			if updatedKey.ID != "" && k.ID == updatedKey.ID {
				matched = true
			} else if updatedKey.Label != "" && k.Label == updatedKey.Label {
				matched = true
			} else if updatedKey.OAuthMeta != nil && k.OAuthMeta != nil &&
				updatedKey.OAuthMeta.Provider != "" && updatedKey.OAuthMeta.Provider == k.OAuthMeta.Provider &&
				updatedKey.OAuthMeta.ClientID != "" && updatedKey.OAuthMeta.ClientID == k.OAuthMeta.ClientID {
				matched = true
			}

			if matched {
				k.Key = updatedKey.Key
				if updatedKey.OAuthMeta != nil {
					if k.OAuthMeta == nil {
						k.OAuthMeta = &types.OAuthMeta{}
					}
					*k.OAuthMeta = *updatedKey.OAuthMeta
				}
				prov.APIKeys[i] = k
				found = true
				break
			}
		}
		if found {
			break
		}
	}

	if !found {
		return errors.New("config: key entry to persist not found in config")
	}

	_, err = s.saveConfigLocked(&clonedCfg)
	return err
}

// MergeVaultConfig merges vault-provided providers and keys into local configuration.
// Origin isolation rules:
// - Existing local providers (Origin == "local") are never overwritten or deleted.
// - Existing local keys (Origin == "local") within any provider are strictly preserved.
// - Only vault keys (Origin == "vault") are updated or appended.
func (s *LocalSource) MergeVaultConfig(vaultProviders map[string]*types.ProviderConfig) (*types.RuntimeSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	currentSnap := s.snapshot.Load()
	var currentCfg *types.ProxyConfig
	if currentSnap != nil {
		currentCfg = currentSnap.Config
	}

	var clonedCfg types.ProxyConfig
	if currentCfg != nil {
		raw, err := json.Marshal(currentCfg)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &clonedCfg); err != nil {
			return nil, err
		}
	} else {
		clonedCfg = types.ProxyConfig{
			Providers:   make(map[string]*types.ProviderConfig),
			AgentModels: make(map[string]*types.AgentModelRoute),
		}
	}

	if clonedCfg.Providers == nil {
		clonedCfg.Providers = make(map[string]*types.ProviderConfig)
	}

	for vpID, vp := range vaultProviders {
		if vp == nil {
			continue
		}

		// Normalize incoming vault keys: copy them and force Origin = "vault"
		incomingKeys := make([]*types.KeyEntry, 0, len(vp.APIKeys))
		for _, vk := range vp.APIKeys {
			if vk == nil {
				continue
			}
			kCopy := *vk
			if vk.OAuthMeta != nil {
				metaCopy := *vk.OAuthMeta
				kCopy.OAuthMeta = &metaCopy
			}
			kCopy.Origin = "vault"
			incomingKeys = append(incomingKeys, &kCopy)
		}

		existingP, exists := clonedCfg.Providers[vpID]
		if !exists {
			// New provider from vault
			newP := *vp
			newP.Origin = "vault"
			newP.APIKeys = incomingKeys
			if vp.ModelAliases != nil {
				newP.ModelAliases = make(map[string]string)
				for k, v := range vp.ModelAliases {
					newP.ModelAliases[k] = v
				}
			}
			if vp.AdapterRules != nil {
				rulesCopy := *vp.AdapterRules
				newP.AdapterRules = &rulesCopy
			}
			clonedCfg.Providers[vpID] = &newP
			continue
		}

		// Existing provider
		if existingP.Origin == "local" {
			// Iron Rule: Local provider is never overwritten or deleted!
			// BaseURL, Name, PresetID, etc., remain unchanged.
			// Only merge keys: local keys preserved, vault keys updated or appended.
			existingP.APIKeys = mergeProviderKeys(existingP.APIKeys, incomingKeys)
		} else {
			// Origin is vault (or not local)
			// Update provider attributes from vp
			existingP.Name = vp.Name
			existingP.PresetID = vp.PresetID
			existingP.BaseURL = vp.BaseURL
			existingP.AnthropicBaseURL = vp.AnthropicBaseURL
			existingP.Enabled = vp.Enabled
			existingP.Origin = "vault"
			existingP.RuleHash = vp.RuleHash
			existingP.HideClientName = vp.HideClientName
			if vp.RPMPerKey > 0 {
				existingP.RPMPerKey = vp.RPMPerKey
			}
			if vp.QuotaResetAt != "" {
				existingP.QuotaResetAt = vp.QuotaResetAt
			}
			if vp.ModelAliases != nil {
				existingP.ModelAliases = make(map[string]string)
				for k, v := range vp.ModelAliases {
					existingP.ModelAliases[k] = v
				}
			}
			if vp.AdapterRules != nil {
				rulesCopy := *vp.AdapterRules
				existingP.AdapterRules = &rulesCopy
			}
			existingP.APIKeys = mergeProviderKeys(existingP.APIKeys, incomingKeys)
		}
	}

	return s.saveConfigLocked(&clonedCfg)
}

func mergeProviderKeys(existingKeys []*types.KeyEntry, incomingVaultKeys []*types.KeyEntry) []*types.KeyEntry {
	var localKeys []*types.KeyEntry
	var existingVaultKeys []*types.KeyEntry

	for _, k := range existingKeys {
		if k == nil {
			continue
		}
		if k.Origin == "vault" {
			kCopy := *k
			if k.OAuthMeta != nil {
				m := *k.OAuthMeta
				kCopy.OAuthMeta = &m
			}
			existingVaultKeys = append(existingVaultKeys, &kCopy)
		} else {
			// Origin == "local" or unspecified local
			kCopy := *k
			if k.OAuthMeta != nil {
				m := *k.OAuthMeta
				kCopy.OAuthMeta = &m
			}
			if kCopy.Origin == "" {
				kCopy.Origin = "local"
			}
			localKeys = append(localKeys, &kCopy)
		}
	}

	matchesKey := func(a, b *types.KeyEntry) bool {
		if a == nil || b == nil {
			return false
		}
		if a.ID != "" && b.ID != "" {
			return a.ID == b.ID
		}
		if a.Label != "" && b.Label != "" {
			return a.Label == b.Label
		}
		return a.Key != "" && a.Key == b.Key
	}

	updatedVaultKeys := make([]*types.KeyEntry, len(existingVaultKeys))
	copy(updatedVaultKeys, existingVaultKeys)

	for _, vk := range incomingVaultKeys {
		if vk == nil {
			continue
		}
		// Check if it conflicts with an existing local key
		conflictsLocal := false
		for _, lk := range localKeys {
			if matchesKey(lk, vk) {
				conflictsLocal = true
				break
			}
		}
		if conflictsLocal {
			// Do not overwrite local key!
			continue
		}

		foundIndex := -1
		for i, evk := range updatedVaultKeys {
			if matchesKey(evk, vk) {
				foundIndex = i
				break
			}
		}

		vkCopy := *vk
		if vk.OAuthMeta != nil {
			m := *vk.OAuthMeta
			vkCopy.OAuthMeta = &m
		}
		vkCopy.Origin = "vault"

		if foundIndex >= 0 {
			if vkCopy.ID == "" && updatedVaultKeys[foundIndex].ID != "" {
				vkCopy.ID = updatedVaultKeys[foundIndex].ID
			}
			// If incoming key has masked secret, keep existing real key
			if IsMaskedSecret(vkCopy.Key) && !IsMaskedSecret(updatedVaultKeys[foundIndex].Key) {
				vkCopy.Key = updatedVaultKeys[foundIndex].Key
			}
			// If existing key had a refreshed token with newer expiry, preserve it
			if updatedVaultKeys[foundIndex].OAuthMeta != nil && vkCopy.OAuthMeta != nil {
				if updatedVaultKeys[foundIndex].OAuthMeta.ExpiresAt > vkCopy.OAuthMeta.ExpiresAt {
					vkCopy.Key = updatedVaultKeys[foundIndex].Key
					*vkCopy.OAuthMeta = *updatedVaultKeys[foundIndex].OAuthMeta
				}
			} else if updatedVaultKeys[foundIndex].OAuthMeta != nil && vkCopy.OAuthMeta == nil {
				m := *updatedVaultKeys[foundIndex].OAuthMeta
				vkCopy.OAuthMeta = &m
			}
			updatedVaultKeys[foundIndex] = &vkCopy
		} else {
			updatedVaultKeys = append(updatedVaultKeys, &vkCopy)
		}
	}

	result := make([]*types.KeyEntry, 0, len(localKeys)+len(updatedVaultKeys))
	result = append(result, localKeys...)
	result = append(result, updatedVaultKeys...)
	return result
}

func (s *LocalSource) saveConfigLocked(newCfg *types.ProxyConfig) (*types.RuntimeSnapshot, error) {
	normalizeProviderIDs(newCfg)

	currentSnap := s.snapshot.Load()
	var currentCfg *types.ProxyConfig
	if currentSnap != nil {
		currentCfg = currentSnap.Config
	}

	// 1. CAS Check: if newCfg has version > 0, it must match current version
	if currentCfg != nil && newCfg.Version > 0 && newCfg.Version != currentCfg.Version {
		return nil, &VersionConflictError{
			CurrentVersion:   currentCfg.Version,
			SubmittedVersion: newCfg.Version,
		}
	}

	// 2. Kernel Guard: Prevent masked placeholders from overwriting real keys
	if currentCfg != nil {
		recoverMaskedKeys(newCfg, currentCfg)
	}

	// 3. Vault URL-Change Guard (SECURITY_SPEC §4.4 / SEC-07):
	// Only recover a masked Vault.NodeToken when Vault.URL is unchanged; otherwise clear it.
	if newCfg.Vault != nil && IsMaskedSecret(newCfg.Vault.NodeToken) {
		if currentCfg != nil && currentCfg.Vault != nil &&
			!IsMaskedSecret(currentCfg.Vault.NodeToken) &&
			strings.TrimRight(strings.TrimSpace(newCfg.Vault.URL), "/") == strings.TrimRight(strings.TrimSpace(currentCfg.Vault.URL), "/") {
			newCfg.Vault.NodeToken = currentCfg.Vault.NodeToken
		} else {
			newCfg.Vault.NodeToken = ""
		}
	}

	// Increment version
	if currentCfg != nil {
		newCfg.Version = currentCfg.Version + 1
	} else if newCfg.Version <= 0 {
		newCfg.Version = 1
	}

	// Serialize and encrypt
	rawJSON, err := json.Marshal(newCfg)
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(s.configDir, 0o700); err != nil {
		return nil, err
	}

	var sealed []byte
	if s.passphrase != "" {
		sealed, err = crypto.Encrypt(rawJSON, s.passphrase)
		if err != nil {
			return nil, fmt.Errorf("config: encrypt error: %w", err)
		}
	} else {
		sealed = rawJSON
	}

	// Keep previous valid copy as .bak with lastgood, then write atomically with steady
	_ = lastgood.Keep(s.configPath, func(b []byte) bool { return len(b) > 0 }, 0o600)
	if err := steady.WriteFile(s.configPath, sealed, 0o600); err != nil {
		return nil, fmt.Errorf("config: write failed: %w", err)
	}

	newSnap := &types.RuntimeSnapshot{
		Config:     newCfg,
		ETag:       fmt.Sprintf(`"%d"`, newCfg.Version),
		LeaseUntil: time.Now().Add(24 * time.Hour),
		LoadedAt:   time.Now(),
	}

	s.snapshot.Store(newSnap)
	s.notifyListeners(newCfg)
	return newSnap, nil
}

func recoverMaskedKeys(target, source *types.ProxyConfig) {
	if target == nil || source == nil {
		return
	}

	type keyInfo struct {
		Key       string
		Origin    string
		OAuthMeta *types.OAuthMeta
	}
	realKeys := make(map[string]keyInfo)
	for pID, p := range source.Providers {
		if p == nil {
			continue
		}
		for _, k := range p.APIKeys {
			if k == nil || k.Key == "" || IsMaskedSecret(k.Key) {
				continue
			}
			ki := keyInfo{
				Key:    k.Key,
				Origin: k.Origin,
			}
			if k.OAuthMeta != nil {
				m := *k.OAuthMeta
				ki.OAuthMeta = &m
			}
			if k.ID != "" {
				realKeys[pID+":id:"+k.ID] = ki
			}
			if k.Label != "" {
				realKeys[pID+":lbl:"+k.Label] = ki
			}
		}
	}

	// Recover in target
	for pID, p := range target.Providers {
		if p == nil {
			continue
		}
		for _, k := range p.APIKeys {
			if k == nil {
				continue
			}
			var ki keyInfo
			var found bool
			if k.ID != "" {
				if rk, ok := realKeys[pID+":id:"+k.ID]; ok {
					ki = rk
					found = true
				}
			}
			if !found && k.Label != "" {
				if rk, ok := realKeys[pID+":lbl:"+k.Label]; ok {
					ki = rk
					found = true
				}
			}

			if found {
				if ki.Origin == "vault" {
					k.Origin = "vault"
				}
				if IsMaskedSecret(k.Key) {
					k.Key = ki.Key
				}
				if ki.OAuthMeta != nil {
					if k.OAuthMeta == nil {
						m := *ki.OAuthMeta
						k.OAuthMeta = &m
					} else if (k.OAuthMeta.RefreshToken == "" || IsMaskedSecret(k.OAuthMeta.RefreshToken)) &&
						ki.OAuthMeta.RefreshToken != "" && !IsMaskedSecret(ki.OAuthMeta.RefreshToken) {
						k.OAuthMeta.RefreshToken = ki.OAuthMeta.RefreshToken
					}
				}
			}
		}
	}
}

func (s *LocalSource) loadFromDisk() (*types.RuntimeSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := lastgood.Read(s.configPath, func(b []byte) bool {
		return len(b) > 0
	})
	if err != nil {
		raw, err = steady.ReadFile(s.configPath)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || os.IsNotExist(err) {
				return nil, ErrConfigNotInitialized
			}
			return nil, err
		}
	}

	plain := raw
	if s.passphrase != "" {
		dec, decErr := crypto.Decrypt(raw, s.passphrase)
		if decErr != nil {
			return nil, fmt.Errorf("config: decrypt error: %w", decErr)
		}
		plain = dec
	}

	var cfg types.ProxyConfig
	if err := json.Unmarshal(plain, &cfg); err != nil {
		return nil, fmt.Errorf("config: json unmarshal: %w", err)
	}
	normalizeProviderIDs(&cfg)

	snap := &types.RuntimeSnapshot{
		Config:     &cfg,
		ETag:       fmt.Sprintf(`"%d"`, cfg.Version),
		LeaseUntil: time.Now().Add(24 * time.Hour),
		LoadedAt:   time.Now(),
	}

	s.snapshot.Store(snap)
	s.notifyListeners(&cfg)
	return snap, nil
}
