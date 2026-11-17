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

	_, err = s.saveConfigLocked(&clonedCfg, true)
	return err
}

// MergeHubSync performs a unified one-click Hub sync into LocalSource:
//  1. Removes stale Origin=="vault" providers absent from payload.Providers, inserts/replaces
//     payload.Providers as Origin=="vault" with stable deduplicated keys, and preserves 100%
//     of Origin!="vault" ("local") providers and their keys.
//  2. Removes stale Origin=="vault" AgentModels absent from payload.AgentModels (preserving
//     Origin!="vault" local models and any local-provider candidates), and inserts/updates
//     payload.AgentModels as Origin=="vault".
//  3. Replaces vault-provider KBCandidates with payload.KBModels while preserving local-provider KBCandidates.
//  4. Adopts payload.Settings.ClientKey if local Settings.ClientKey is empty.
func (s *LocalSource) MergeHubSync(payload *types.ProxyConfig) (*types.ProxyConfig, error) {
	if payload == nil {
		return nil, errors.New("config: nil hub sync payload")
	}

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
			KBModels:    make(map[string][]*types.KBCandidate),
			Settings:    DefaultRuntimeSettings(),
		}
	}

	// 1. Providers: preserve 100% of Origin != "vault" providers, replace all vault providers from payload.
	newProviders := make(map[string]*types.ProviderConfig)
	localProvIDs := make(map[string]bool)
	oldVaultProviders := make(map[string]*types.ProviderConfig)

	for pID, existingP := range clonedCfg.Providers {
		if existingP == nil {
			continue
		}
		if existingP.Origin == "vault" {
			oldVaultProviders[pID] = existingP
			continue
		}
		if existingP.Origin == "" {
			existingP.Origin = "local"
		}
		if existingP.ID == "" {
			existingP.ID = pID
		}
		newProviders[pID] = existingP
		localProvIDs[pID] = true
	}

	for pID, vp := range payload.Providers {
		if vp == nil || localProvIDs[pID] {
			continue
		}
		rawP, err := json.Marshal(vp)
		if err != nil {
			continue
		}
		var newP types.ProviderConfig
		if err := json.Unmarshal(rawP, &newP); err != nil {
			continue
		}
		if newP.ID == "" {
			newP.ID = pID
		}
		newP.Origin = "vault"

		oldVP := oldVaultProviders[pID]
		dedupKeys := make([]*types.KeyEntry, 0, len(vp.APIKeys))
		for _, vk := range vp.APIKeys {
			sk := stabilizeVaultKey(vk)
			if sk == nil {
				continue
			}
			// Preserve newer locally refreshed OAuth token if matching key existed
			if oldVP != nil {
				for _, ok := range oldVP.APIKeys {
					if keyEntriesMatch(ok, sk) {
						if IsMaskedSecret(sk.Key) && !IsMaskedSecret(ok.Key) {
							sk.Key = ok.Key
						}
						if ok.OAuthMeta != nil && sk.OAuthMeta != nil && ok.OAuthMeta.ExpiresAt > sk.OAuthMeta.ExpiresAt {
							sk.Key = ok.Key
							m := *ok.OAuthMeta
							sk.OAuthMeta = &m
						} else if ok.OAuthMeta != nil && sk.OAuthMeta == nil {
							m := *ok.OAuthMeta
							sk.OAuthMeta = &m
						}
						break
					}
				}
			}

			replaced := false
			for idx, existing := range dedupKeys {
				if keyEntriesMatch(existing, sk) {
					dedupKeys[idx] = sk
					replaced = true
					break
				}
			}
			if !replaced {
				dedupKeys = append(dedupKeys, sk)
			}
		}
		newP.APIKeys = dedupKeys
		newProviders[pID] = &newP
	}
	clonedCfg.Providers = newProviders

	// 2. AgentModels: replace vault models with payload.AgentModels while preserving local models & local candidates.
	newAgentModels := make(map[string]*types.AgentModelRoute)
	extractLocalAgentCands := func(route *types.AgentModelRoute) []*types.RouteCandidate {
		if route == nil {
			return nil
		}
		var out []*types.RouteCandidate
		for _, c := range route.Candidates {
			if c != nil && localProvIDs[c.Provider] {
				cp := *c
				out = append(out, &cp)
			}
		}
		return out
	}

	for mName, oldRoute := range clonedCfg.AgentModels {
		if oldRoute == nil {
			continue
		}
		if _, inHub := payload.AgentModels[mName]; inHub && payload.AgentModels[mName] != nil {
			// Will be merged in the payload.AgentModels loop below
			continue
		}
		localCands := extractLocalAgentCands(oldRoute)
		if oldRoute.Origin != "vault" {
			// Local-only model: preserve intact, dropping only dead references to deleted vault providers
			keptCands := make([]*types.RouteCandidate, 0, len(oldRoute.Candidates))
			for _, c := range oldRoute.Candidates {
				if c != nil && clonedCfg.Providers[c.Provider] != nil {
					cp := *c
					keptCands = append(keptCands, &cp)
				}
			}
			// If local model referenced an uncreated/custom provider name, keep localCands or original if none were vault
			if len(keptCands) == 0 && len(oldRoute.Candidates) > 0 {
				for _, c := range oldRoute.Candidates {
					if c != nil && oldVaultProviders[c.Provider] == nil {
						cp := *c
						keptCands = append(keptCands, &cp)
					}
				}
			}
			cpRoute := *oldRoute
			if cpRoute.Origin == "" {
				cpRoute.Origin = "local"
			}
			cpRoute.Candidates = keptCands
			newAgentModels[mName] = &cpRoute
		} else if len(localCands) > 0 {
			// Vault model removed on Hub, but operator had attached local-provider candidates: retain local candidates
			cpRoute := *oldRoute
			cpRoute.Origin = "local"
			cpRoute.Candidates = localCands
			newAgentModels[mName] = &cpRoute
		}
	}

	for mName, hubRoute := range payload.AgentModels {
		if hubRoute == nil {
			continue
		}
		rawR, err := json.Marshal(hubRoute)
		if err != nil {
			continue
		}
		var mergedRoute types.AgentModelRoute
		if err := json.Unmarshal(rawR, &mergedRoute); err != nil {
			continue
		}
		mergedRoute.Origin = "vault"

		if oldRoute := clonedCfg.AgentModels[mName]; oldRoute != nil {
			for _, lc := range extractLocalAgentCands(oldRoute) {
				dup := false
				for _, mc := range mergedRoute.Candidates {
					if mc != nil && mc.Provider == lc.Provider && mc.KeyLabel == lc.KeyLabel && mc.TargetModel == lc.TargetModel {
						dup = true
						break
					}
				}
				if !dup {
					mergedRoute.Candidates = append(mergedRoute.Candidates, lc)
				}
			}
		}
		newAgentModels[mName] = &mergedRoute
	}
	clonedCfg.AgentModels = newAgentModels

	// 3. KBModels: replace vault candidates with payload.KBModels[ch], preserving local-provider candidates.
	newKBModels := make(map[string][]*types.KBCandidate)
	kbChannels := map[string]bool{
		"chat":      true,
		"ocr":       true,
		"embedding": true,
		"reranker":  true,
	}
	for ch := range clonedCfg.KBModels {
		kbChannels[ch] = true
	}
	for ch := range payload.KBModels {
		kbChannels[ch] = true
	}
	for ch := range kbChannels {
		var combined []*types.KBCandidate
		for _, hc := range payload.KBModels[ch] {
			if hc == nil {
				continue
			}
			cp := *hc
			combined = append(combined, &cp)
		}
		for _, lc := range clonedCfg.KBModels[ch] {
			if lc == nil || !localProvIDs[lc.Provider] {
				continue
			}
			dup := false
			for _, ex := range combined {
				if ex.Provider == lc.Provider && ex.Model == lc.Model && ex.KeyLabel == lc.KeyLabel {
					dup = true
					break
				}
			}
			if !dup {
				cp := *lc
				combined = append(combined, &cp)
			}
		}
		if len(combined) > 0 {
			newKBModels[ch] = combined
		}
	}
	clonedCfg.KBModels = newKBModels

	// 4. Adopt ClientKey if local Settings.ClientKey is empty.
	if strings.TrimSpace(clonedCfg.Settings.ClientKey) == "" && strings.TrimSpace(payload.Settings.ClientKey) != "" {
		clonedCfg.Settings.ClientKey = strings.TrimSpace(payload.Settings.ClientKey)
		if strings.TrimSpace(clonedCfg.Settings.ProxyAPIKey) == "" {
			clonedCfg.Settings.ProxyAPIKey = clonedCfg.Settings.ClientKey
		}
	}

	snap, err := s.saveConfigLocked(&clonedCfg, true)
	if err != nil {
		return nil, err
	}
	return snap.Config, nil
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

		// Existing provider
		if existingP.Origin == "local" {
			// Iron Rule: Local provider is never overwritten or deleted!
			existingP.APIKeys = mergeProviderKeys(existingP.APIKeys, incomingKeys, true)
		} else {
			// Origin is vault: update provider attributes & enforce vault-only keys (no mixed keys)
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
			existingP.APIKeys = mergeProviderKeys(existingP.APIKeys, incomingKeys, false)
		}
	}

	return s.saveConfigLocked(&clonedCfg, true)
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
			if updatedVaultKeys[foundIndex].OAuthMeta != nil && vkCopy.OAuthMeta != nil {
				if updatedVaultKeys[foundIndex].OAuthMeta.ExpiresAt > vkCopy.OAuthMeta.ExpiresAt {
					vkCopy.Key = updatedVaultKeys[foundIndex].Key
					*vkCopy.OAuthMeta = *updatedVaultKeys[foundIndex].OAuthMeta
				}
			} else if updatedVaultKeys[foundIndex].OAuthMeta != nil && vkCopy.OAuthMeta == nil {
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

	// 2b. Strict No-Mixed-Keys Rule (User Decision #3):
	// Vault providers are strictly read-only for keys during external SaveConfig submissions;
	// never allow Origin=="local" or unstored keys to be added onto an Origin=="vault" provider.
	if !fromVaultSync {
		enforceVaultProviderKeyLock(newCfg, currentCfg)
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

func enforceVaultProviderKeyLock(target, source *types.ProxyConfig) {
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
			var storedVaultKeys []*types.KeyEntry
			for _, sk := range srcP.APIKeys {
				if sk != nil && sk.Origin == "vault" {
					storedVaultKeys = append(storedVaultKeys, stabilizeVaultKey(sk))
				}
			}
			kept := make([]*types.KeyEntry, 0, len(storedVaultKeys))
			for _, sk := range storedVaultKeys {
				cp := *sk
				if sk.OAuthMeta != nil {
					m := *sk.OAuthMeta
					cp.OAuthMeta = &m
				}
				// Allow Enabled toggle from target if matching vault key was submitted
				for _, tk := range p.APIKeys {
					if tk != nil && tk.Origin != "local" && keyEntriesMatch(tk, sk) {
						cp.Enabled = tk.Enabled
						break
					}
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
