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

// LocalProviderConflictError reports that an on-demand vault fetch targeted a provider
// that already exists locally with a non-vault origin ("local" or a legacy empty origin).
// Such a provider is never re-fetchable — the operator must delete or rename it first.
type LocalProviderConflictError struct {
	Provider string
}

func (e *LocalProviderConflictError) Error() string {
	return fmt.Sprintf("config: provider %q already exists locally and is not vault-managed (delete it first)", e.Provider)
}

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

// DefaultRuntimeSettings returns the canonical schema defaults for cold-start configuration.
func DefaultRuntimeSettings() types.RuntimeSettings {
	return types.RuntimeSettings{
		AgentRoutingStrategy:     "sticky_failover",
		AgentFirstByteTimeoutSec: 120,
		CooldownRateLimitSec:     15,
		CooldownServerErrorSec:   30,
		CooldownNetworkErrorSec:  15,
		CooldownAuthErrorSec:     86400,
		OCRMaxInflight:           4,
		KBGlobalMaxConcurrency:   16,
	}
}

// ApplyColdStartSettingsDefaults fills unset fields on s with schema defaults.
func ApplyColdStartSettingsDefaults(s *types.RuntimeSettings) {
	if s == nil {
		return
	}
	def := DefaultRuntimeSettings()
	if s.AgentRoutingStrategy == "" {
		s.AgentRoutingStrategy = def.AgentRoutingStrategy
	}
	if s.AgentFirstByteTimeoutSec <= 0 {
		s.AgentFirstByteTimeoutSec = def.AgentFirstByteTimeoutSec
	}
	if s.CooldownRateLimitSec <= 0 {
		s.CooldownRateLimitSec = def.CooldownRateLimitSec
	}
	if s.CooldownServerErrorSec <= 0 {
		s.CooldownServerErrorSec = def.CooldownServerErrorSec
	}
	if s.CooldownNetworkErrorSec <= 0 {
		s.CooldownNetworkErrorSec = def.CooldownNetworkErrorSec
	}
	if s.CooldownAuthErrorSec <= 0 {
		s.CooldownAuthErrorSec = def.CooldownAuthErrorSec
	}
	if s.OCRMaxInflight <= 0 {
		s.OCRMaxInflight = def.OCRMaxInflight
	}
	if s.KBGlobalMaxConcurrency <= 0 {
		s.KBGlobalMaxConcurrency = def.KBGlobalMaxConcurrency
	}
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

func keyEntriesMatch(a, b *types.KeyEntry) bool {
	if a == nil || b == nil {
		return false
	}
	if a.Label != "" && b.Label != "" && a.Label == b.Label {
		return true
	}
	if a.ID != "" && b.ID != "" && a.ID == b.ID {
		return true
	}
	if a.ID != "" && b.Label != "" && (a.ID == b.Label || a.ID == "k_"+b.Label) {
		return true
	}
	if b.ID != "" && a.Label != "" && (b.ID == a.Label || b.ID == "k_"+a.Label) {
		return true
	}
	return a.Key != "" && b.Key != "" && !IsMaskedSecret(a.Key) && !IsMaskedSecret(b.Key) && a.Key == b.Key
}

func stabilizeVaultKey(vk *types.KeyEntry) *types.KeyEntry {
	if vk == nil {
		return nil
	}
	kCopy := *vk
	if vk.OAuthMeta != nil {
		metaCopy := *vk.OAuthMeta
		kCopy.OAuthMeta = &metaCopy
	}
	if kCopy.ID == "" {
		kCopy.ID = kCopy.Label
	}
	if kCopy.Label == "" {
		kCopy.Label = kCopy.ID
	}
	kCopy.Origin = "vault"
	return &kCopy
}

// SaveConfig saves updated config to disk with Kernel Guard and CAS checks.
func (s *LocalSource) SaveConfig(newCfg *types.ProxyConfig) (*types.RuntimeSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.saveConfigLocked(newCfg, false)
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
				// Only overwrite the secret when the caller actually supplied one:
				// console metadata writes (last_test) carry no Key, and blindly
				// assigning it would erase the credential from disk.
				if updatedKey.Key != "" && !IsMaskedSecret(updatedKey.Key) {
					k.Key = updatedKey.Key
				}
				if updatedKey.OAuthMeta != nil {
					if k.OAuthMeta == nil {
						k.OAuthMeta = &types.OAuthMeta{}
					}
					*k.OAuthMeta = *updatedKey.OAuthMeta
				}
				// Console test verdicts ride along: POST /api/admin/test-key persists
				// the fresh last_test through this path so a page refresh (or a
				// restart) still shows the pill without an explicit provider save.
				if updatedKey.LastTest != nil {
					lt := *updatedKey.LastTest
					k.LastTest = &lt
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

	_, err = s.saveConfigLocked(&clonedCfg, true)
	return err
}

// PersistKeyTestState stores one console test verdict on the key that produced it.
//
// Kept separate from PersistKeyEntry on purpose: this path touches nothing but
// LastTest, and it resolves the key inside a named provider so equal labels on
// different providers can never cross-contaminate. Failures are returned to the
// caller (which logs them) — a probe answer is still an answer even if the
// verdict could not be written to disk.
func (s *LocalSource) PersistKeyTestState(providerID, keyID, keyLabel string, lastTest *types.KeyLastTest) error {
	if lastTest == nil {
		return errors.New("config: nil last_test")
	}
	if providerID == "" || (keyID == "" && keyLabel == "") {
		return errors.New("config: provider and key are required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	currentSnap := s.snapshot.Load()
	if currentSnap == nil || currentSnap.Config == nil {
		return errors.New("config: no config loaded")
	}

	raw, err := json.Marshal(currentSnap.Config)
	if err != nil {
		return err
	}
	var clonedCfg types.ProxyConfig
	if err := json.Unmarshal(raw, &clonedCfg); err != nil {
		return err
	}

	prov := clonedCfg.Providers[providerID]
	if prov == nil {
		return fmt.Errorf("config: provider %q not found", providerID)
	}

	for _, k := range prov.APIKeys {
		if k == nil {
			continue
		}
		if keyID != "" && k.ID != keyID {
			continue
		}
		if keyID == "" && k.Label != keyLabel {
			continue
		}
		lt := *lastTest
		k.LastTest = &lt
		_, err = s.saveConfigLocked(&clonedCfg, true)
		return err
	}
	return errors.New("config: key entry to persist not found in provider")
}

// MergeVaultConfig merges (or replaces) vault-provided providers and keys into local
// configuration. It is the only hub-merge path since full sync was removed.
// Origin isolation rules:
//   - An incoming provider whose ID already exists locally with a non-vault origin
//     ("local" or legacy empty) is rejected with LocalProviderConflictError — it must be
//     deleted or renamed first, never silently merged or overwritten.
//   - Existing local keys (Origin == "local") within any provider are strictly preserved.
//   - Only vault keys (Origin == "vault") are updated or appended; their local Enabled
//     toggle survives both merge and replace.
//
// With replace=true (on-demand re-fetch of an existing vault provider), the hub-managed
// fields (name/base_url/anthropic_base_url/adapter_rules/preset_id/api_type/hide_client_name)
// and the vault key list are replaced wholesale with the fetched payload: keys deleted
// locally reappear and keys removed on the Hub disappear, while locally refreshed OAuth
// token state (newer ExpiresAt / real secret) is never clobbered by an older Hub copy.
// Provider Enabled is local operational state and is never taken from the payload;
// api_type/rule_hash move only when the payload actually carries them (older hubs omit
// both, so a re-fetch must not wipe them to "").
func (s *LocalSource) MergeVaultConfig(vaultProviders map[string]*types.ProviderConfig, replace bool) (*types.RuntimeSnapshot, error) {
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
			Settings:    DefaultRuntimeSettings(),
		}
	}

	if clonedCfg.Providers == nil {
		clonedCfg.Providers = make(map[string]*types.ProviderConfig)
	}

	for vpID, vp := range vaultProviders {
		if vp == nil {
			continue
		}

		// Normalize incoming vault keys: copy them, stabilize ID/Label, and force Origin = "vault"
		incomingKeys := make([]*types.KeyEntry, 0, len(vp.APIKeys))
		for _, vk := range vp.APIKeys {
			sk := stabilizeVaultKey(vk)
			if sk != nil {
				incomingKeys = append(incomingKeys, sk)
			}
		}

		existingP, exists := clonedCfg.Providers[vpID]
		if !exists {
			// New provider from vault
			newP := *vp
			if newP.ID == "" {
				newP.ID = vpID
			}
			newP.Origin = "vault"
			newP.APIKeys = mergeProviderKeys(nil, incomingKeys, false)
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

		// Existing provider with a non-vault origin ("local" or a legacy empty origin):
		// never merged or overwritten — the fetch must fail with a conflict (gen-1 semantic).
		// The check lives here (inside the config mutex), not only at the admin layer,
		// so a same-ID provider flipped to local during the hub round-trip still trips 409
		// instead of silently merging vault keys into a local provider.
		if existingP.Origin != "vault" {
			return nil, &LocalProviderConflictError{Provider: vpID}
		}
		if replace {
			// Origin is vault + on-demand re-fetch: hub-managed fields and the vault key
			// list are replaced wholesale with the fetched payload. Enabled is a local
			// operational toggle (enforceVaultLock passes it through for the same reason):
			// the hub fetch payload carries no enabled flag, so a re-fetch must never
			// re-enable a locally disabled provider. api_type/rule_hash are hub-managed
			// but only adopted when actually present in the payload (older hubs omit them).
			existingP.Name = vp.Name
			existingP.PresetID = vp.PresetID
			existingP.BaseURL = vp.BaseURL
			existingP.AnthropicBaseURL = vp.AnthropicBaseURL
			if vp.APIType != "" {
				existingP.APIType = vp.APIType
			}
			existingP.Origin = "vault"
			if vp.RuleHash != "" {
				existingP.RuleHash = vp.RuleHash
			}
			existingP.HideClientName = vp.HideClientName
			// rpm_per_key is hub-managed wholesale like the fields above: 0 (the hub
			// cleared the limit) must reach the node on re-fetch, never a one-way
			// ratchet that keeps a stale positive value forever.
			existingP.RPMPerKey = vp.RPMPerKey
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
			} else {
				existingP.AdapterRules = nil
			}
			existingP.APIKeys = replaceVaultKeyList(existingP.APIKeys, incomingKeys)
		} else {
			// Origin is vault: update provider attributes & enforce vault-only keys (no mixed keys).
			// Same Enabled/api_type/rule_hash rules as the replace branch above: Enabled stays a
			// local toggle, api_type/rule_hash only move when the payload actually carries them.
			existingP.Name = vp.Name
			existingP.PresetID = vp.PresetID
			existingP.BaseURL = vp.BaseURL
			existingP.AnthropicBaseURL = vp.AnthropicBaseURL
			if vp.APIType != "" {
				existingP.APIType = vp.APIType
			}
			existingP.Origin = "vault"
			if vp.RuleHash != "" {
				existingP.RuleHash = vp.RuleHash
			}
			existingP.HideClientName = vp.HideClientName
			// rpm_per_key is hub-managed wholesale like the fields above: 0 (the hub
			// cleared the limit) must reach the node on re-fetch, never a one-way
			// ratchet that keeps a stale positive value forever.
			existingP.RPMPerKey = vp.RPMPerKey
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
			existingP.APIKeys = mergeProviderKeys(existingP.APIKeys, incomingKeys, false)
		}
	}

	return s.saveConfigLocked(&clonedCfg, true)
}

// replaceVaultKeyList rebuilds the vault key list from the fetched keys: keys deleted
// locally reappear and keys no longer on the Hub disappear, while a locally refreshed
// OAuth token state (newer ExpiresAt / real secret) is never clobbered by an older Hub
// copy (same stabilization rules as the removed MergeHubSync). A key that still exists
// locally keeps its local Enabled toggle; only keys that were locally deleted come back
// enabled with the Hub payload.
func replaceVaultKeyList(oldKeys, incomingKeys []*types.KeyEntry) []*types.KeyEntry {
	replaced := make([]*types.KeyEntry, 0, len(incomingKeys))
	for _, sk := range incomingKeys {
		if sk == nil {
			continue
		}
		for _, ok := range oldKeys {
			if ok == nil || ok.Origin != "vault" || !keyEntriesMatch(ok, sk) {
				continue
			}
			if IsMaskedSecret(sk.Key) && !IsMaskedSecret(ok.Key) {
				sk.Key = ok.Key
			}
			sk.Enabled = ok.Enabled
			if ok.OAuthMeta != nil && sk.OAuthMeta != nil && ok.OAuthMeta.ExpiresAt > sk.OAuthMeta.ExpiresAt {
				sk.Key = ok.Key
				m := *ok.OAuthMeta
				sk.OAuthMeta = &m
			} else if ok.OAuthMeta != nil && sk.OAuthMeta == nil {
				// Adopt the locally refreshed OAuth state as a whole: metadata AND the
				// matching access-token string, so the key never ends up half-fresh
				// (new ExpiresAt on a stale token string).
				sk.Key = ok.Key
				m := *ok.OAuthMeta
				sk.OAuthMeta = &m
			}
			break
		}
		dup := false
		for idx, existing := range replaced {
			if keyEntriesMatch(existing, sk) {
				replaced[idx] = sk
				dup = true
				break
			}
		}
		if !dup {
			replaced = append(replaced, sk)
		}
	}
	return replaced
}

func mergeProviderKeys(existingKeys []*types.KeyEntry, incomingVaultKeys []*types.KeyEntry, allowLocalKeys bool) []*types.KeyEntry {
	var localKeys []*types.KeyEntry
	var existingVaultKeys []*types.KeyEntry

	for _, k := range existingKeys {
		if k == nil {
			continue
		}
		if k.Origin == "vault" {
			existingVaultKeys = append(existingVaultKeys, stabilizeVaultKey(k))
		} else if allowLocalKeys {
			// Origin == "local" or unspecified local on a local provider
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

	updatedVaultKeys := make([]*types.KeyEntry, len(existingVaultKeys))
	copy(updatedVaultKeys, existingVaultKeys)

	for _, vk := range incomingVaultKeys {
		if vk == nil {
			continue
		}
		// Check if it conflicts with an existing local key
		conflictsLocal := false
		for _, lk := range localKeys {
			if keyEntriesMatch(lk, vk) {
				conflictsLocal = true
				break
			}
		}
		if conflictsLocal {
			continue
		}

		foundIndex := -1
		for i, evk := range updatedVaultKeys {
			if keyEntriesMatch(evk, vk) {
				foundIndex = i
				break
			}
		}

		vkCopy := stabilizeVaultKey(vk)

		if foundIndex >= 0 {
			if updatedVaultKeys[foundIndex].ID != "" {
				vkCopy.ID = updatedVaultKeys[foundIndex].ID
			}
			if IsMaskedSecret(vkCopy.Key) && !IsMaskedSecret(updatedVaultKeys[foundIndex].Key) {
				vkCopy.Key = updatedVaultKeys[foundIndex].Key
			}
			// The local Enabled toggle on an existing vault key survives a merge
			// (a key-label refetch must not re-enable a locally disabled key).
			vkCopy.Enabled = updatedVaultKeys[foundIndex].Enabled
			if updatedVaultKeys[foundIndex].OAuthMeta != nil && vkCopy.OAuthMeta != nil {
				if updatedVaultKeys[foundIndex].OAuthMeta.ExpiresAt > vkCopy.OAuthMeta.ExpiresAt {
					vkCopy.Key = updatedVaultKeys[foundIndex].Key
					*vkCopy.OAuthMeta = *updatedVaultKeys[foundIndex].OAuthMeta
				}
			} else if updatedVaultKeys[foundIndex].OAuthMeta != nil && vkCopy.OAuthMeta == nil {
				// Adopt the locally refreshed OAuth state as a whole (metadata AND token string).
				vkCopy.Key = updatedVaultKeys[foundIndex].Key
				m := *updatedVaultKeys[foundIndex].OAuthMeta
				vkCopy.OAuthMeta = &m
			}
			updatedVaultKeys[foundIndex] = vkCopy
		} else {
			updatedVaultKeys = append(updatedVaultKeys, vkCopy)
		}
	}

	result := make([]*types.KeyEntry, 0, len(localKeys)+len(updatedVaultKeys))
	result = append(result, localKeys...)
	result = append(result, updatedVaultKeys...)
	return result
}

func (s *LocalSource) saveConfigLocked(newCfg *types.ProxyConfig, fromVaultSync bool) (*types.RuntimeSnapshot, error) {
	normalizeProviderIDs(newCfg)

	currentSnap := s.snapshot.Load()
	var currentCfg *types.ProxyConfig
	if currentSnap != nil {
		currentCfg = currentSnap.Config
	}

	// Cold-start defaults (P1-3): when initializing brand-new config at version 0, populate schema defaults.
	if currentCfg == nil && newCfg.Version == 0 {
		ApplyColdStartSettingsDefaults(&newCfg.Settings)
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

	// 2b. Hub-Managed Lock (Strict No-Mixed-Keys Rule (User Decision #3) + provider field lock):
	// Vault providers are strictly read-only for keys during external SaveConfig submissions;
	// never allow Origin=="local" or unstored keys to be added onto an Origin=="vault" provider,
	// and force-restore hub-managed provider fields (base_url/anthropic_base_url/adapter_rules/
	// preset_id/api_type/hide_client_name) so a leaked admin password cannot repoint a vault
	// provider at an attacker-controlled endpoint to exfiltrate the vault keys. The
	// fromVaultSync bypass keeps the on-demand fetch landing path unaffected — that path is
	// hub-originated (the server itself talked to the hub at the stored URL with the stored
	// token) and never accepts caller-supplied credentials or caller-supplied providers.
	if !fromVaultSync {
		enforceVaultLock(newCfg, currentCfg)
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

// enforceVaultLock enforces hub ownership on Origin=="vault" providers during external
// SaveConfig submissions:
//   - Provider field lock: base_url/anthropic_base_url/adapter_rules/preset_id/api_type/
//     hide_client_name are force-restored to the stored values (hub-hosted content is not
//     locally editable).
//   - Key value lock: vault keys are matched by Label/ID; a tampered value or label is
//     restored from storage; a key missing from the submission counts as a local deletion
//     (allowed, the Hub copy is unaffected).
//   - No mixing: local keys are rejected inside a vault provider (Strict No-Mixed-Keys).
func enforceVaultLock(target, source *types.ProxyConfig) {
	if target == nil {
		return
	}
	for pID, p := range target.Providers {
		if p == nil {
			continue
		}
		var srcP *types.ProviderConfig
		if source != nil {
			srcP = source.Providers[pID]
		}
		if (srcP == nil || srcP.Origin != "vault") && p.Origin != "vault" {
			continue
		}
		p.Origin = "vault"

		if srcP != nil && srcP.Origin == "vault" {
			// Provider field lock: restore hub-managed fields from storage.
			p.BaseURL = srcP.BaseURL
			p.AnthropicBaseURL = srcP.AnthropicBaseURL
			p.PresetID = srcP.PresetID
			p.APIType = srcP.APIType
			p.HideClientName = srcP.HideClientName
			if srcP.AdapterRules != nil {
				rulesCopy := *srcP.AdapterRules
				p.AdapterRules = &rulesCopy
			} else {
				p.AdapterRules = nil
			}

			// Key lock: vault keys are matched by Label/ID; a tampered value or label is
			// restored from storage, and the Enabled toggle from the submission passes
			// through. A stored key missing from the submission counts as a local deletion
			// (allowed — the Hub copy is unaffected and a re-fetch restores it).
			var storedVaultKeys []*types.KeyEntry
			for _, sk := range srcP.APIKeys {
				if sk != nil && sk.Origin == "vault" {
					storedVaultKeys = append(storedVaultKeys, stabilizeVaultKey(sk))
				}
			}
			kept := make([]*types.KeyEntry, 0, len(storedVaultKeys))
			for _, sk := range storedVaultKeys {
				var submitted *types.KeyEntry
				for _, tk := range p.APIKeys {
					if tk != nil && tk.Origin != "local" && keyEntriesMatch(tk, sk) {
						submitted = tk
						break
					}
				}
				if submitted == nil {
					continue // locally deleted by this submission
				}
				cp := *sk
				if sk.OAuthMeta != nil {
					m := *sk.OAuthMeta
					cp.OAuthMeta = &m
				}
				cp.Enabled = submitted.Enabled
				// LastTest is console metadata, not a credential: the submitted
				// verdict (POST /api/admin/test-key) is newer than storage, so it
				// rides through the vault lock and survives the next config save.
				// An older stored verdict stays when the submission carries none.
				if submitted.LastTest != nil {
					lt := *submitted.LastTest
					cp.LastTest = &lt
				}
				kept = append(kept, &cp)
			}
			p.APIKeys = kept
		} else {
			// Initial creation of a vault provider (e.g., test seed): strip any local keys
			kept := make([]*types.KeyEntry, 0, len(p.APIKeys))
			for _, tk := range p.APIKeys {
				if tk == nil || tk.Origin == "local" {
					continue
				}
				kept = append(kept, stabilizeVaultKey(tk))
			}
			p.APIKeys = kept
		}
	}
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
	// One-time migration for the removed one-click full sync: AgentModelRoutes materialized
	// from the Hub (Origin == "vault") become local routes, so they are no longer treated as
	// hub-owned state. kb_models stay untouched.
	for _, route := range cfg.AgentModels {
		if route != nil && route.Origin == "vault" {
			route.Origin = "local"
		}
	}
	if cfg.Version == 0 {
		ApplyColdStartSettingsDefaults(&cfg.Settings)
	}

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
