// Package scheduler provides routing strategies, multi-level cooldowns,
// the Magpie forbiddenAlike algorithm, and streaming first-byte peeking.
package scheduler

import (
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/obs"
)

// CooldownManager tracks temporary and permanent cooldowns.
type CooldownManager struct {
	mu        sync.RWMutex
	cooldowns map[string]time.Time // key: "p:{provider}:k:{keyID}" or "p:{provider}:m:{model}" -> expiresAt
	permanent map[string]bool      // for 410 Gone
}

// NewCooldownManager creates a CooldownManager.
func NewCooldownManager() *CooldownManager {
	return &CooldownManager{
		cooldowns: make(map[string]time.Time),
		permanent: make(map[string]bool),
	}
}

// KeyTarget returns key-level target identifier.
func KeyTarget(provider, keyID string) string {
	return "p:" + provider + ":k:" + keyID
}

// KeyModelTarget returns key-and-model-level target identifier.
func KeyModelTarget(provider, keyID, model string) string {
	return "p:" + provider + ":k:" + keyID + ":m:" + model
}

// ModelTarget returns model-level target identifier.
func ModelTarget(provider, model string) string {
	return "p:" + provider + ":m:" + model
}

// IsCooledDown checks if either the key, key-model, or the model is currently cooled down.
func (m *CooldownManager) IsCooledDown(provider, model, keyID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	kt := KeyTarget(provider, keyID)
	if m.permanent[kt] {
		return true
	}
	if until, ok := m.cooldowns[kt]; ok && time.Now().Before(until) {
		return true
	}

	kmt := KeyModelTarget(provider, keyID, model)
	if until, ok := m.cooldowns[kmt]; ok && time.Now().Before(until) {
		return true
	}

	mt := ModelTarget(provider, model)
	if until, ok := m.cooldowns[mt]; ok && time.Now().Before(until) {
		return true
	}

	return false
}

// ApplyCooldown applies cooldown according to status code and error type.
func (m *CooldownManager) ApplyCooldown(
	provider, model, keyID string,
	status int,
	durRateLimit, durServerError, durNetwork, durAuth time.Duration,
) (appliedSec int, target string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()

	switch {
	case status == 410: // Permanent Gone
		target = KeyTarget(provider, keyID)
		m.permanent[target] = true
		return 86400 * 365, target

	case status == 401 || status == 402 || status == 403: // Key-level auth/billing
		target = KeyTarget(provider, keyID)
		sec := int(durAuth.Seconds())
		m.cooldowns[target] = now.Add(durAuth)
		return sec, target

	case status == 400 || status == 422: // Suspected client payload error: key-level only, do NOT cool down model!
		target = KeyTarget(provider, keyID)
		sec := int(durRateLimit.Seconds())
		m.cooldowns[target] = now.Add(durRateLimit)
		return sec, target

	case status == 429: // Rate limit is per Key/Model quota (RPM/TPM), NOT entire provider model!
		target = KeyModelTarget(provider, keyID, model)
		sec := int(durRateLimit.Seconds())
		m.cooldowns[target] = now.Add(durRateLimit)
		return sec, target

	case status >= 500 && status != 504: // Model-level server error
		target = ModelTarget(provider, model)
		sec := int(durServerError.Seconds())
		m.cooldowns[target] = now.Add(durServerError)
		return sec, target

	default: // Network timeout / connection error (e.g. 504)
		target = ModelTarget(provider, model)
		sec := int(durNetwork.Seconds())
		m.cooldowns[target] = now.Add(durNetwork)
		return sec, target
	}
}

// Clear removes cooldown for a specific target.
func (m *CooldownManager) Clear(target string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.cooldowns, target)
	delete(m.permanent, target)
}

// ClearKey removes cooldown for a specific key (including all model variants).
func (m *CooldownManager) ClearKey(provider, keyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	kt := KeyTarget(provider, keyID)
	delete(m.cooldowns, kt)
	delete(m.permanent, kt)
	prefix := kt + ":"
	for k := range m.cooldowns {
		if strings.HasPrefix(k, prefix) {
			delete(m.cooldowns, k)
		}
	}
}

// CooldownEntry represents an active or permanent cooldown status.
type CooldownEntry struct {
	Target       string `json:"target"`
	Provider     string `json:"provider,omitempty"`
	Model        string `json:"model,omitempty"`
	KeyID        string `json:"key_id,omitempty"`
	ExpiresAt    string `json:"expires_at,omitempty"`
	RemainingSec int    `json:"remaining_sec"`
	Permanent    bool   `json:"permanent,omitempty"`
}

func parseCooldownTarget(target string) CooldownEntry {
	entry := CooldownEntry{Target: target}
	// e.g. "p:minimax:k:hk-01:m:m2" or "p:minimax:k:hk-01" or "p:minimax:m:m2"
	parts := strings.Split(target, ":")
	for i := 0; i < len(parts)-1; i++ {
		switch parts[i] {
		case "p":
			entry.Provider = parts[i+1]
		case "k":
			entry.KeyID = parts[i+1]
		case "m":
			entry.Model = parts[i+1]
		}
	}
	return entry
}

// Snapshot returns a snapshot of active cooldowns for models and keys.
func (m *CooldownManager) Snapshot() map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()

	now := time.Now()
	var allItems []CooldownEntry
	var modelList []CooldownEntry
	var keyList []CooldownEntry

	for target, until := range m.cooldowns {
		if now.Before(until) {
			rem := int(until.Sub(now).Seconds())
			entry := parseCooldownTarget(target)
			entry.ExpiresAt = until.Format(time.RFC3339)
			entry.RemainingSec = rem
			entry.Permanent = false
			allItems = append(allItems, entry)
			if entry.KeyID != "" {
				keyList = append(keyList, entry)
			} else if entry.Model != "" {
				modelList = append(modelList, entry)
			}
		}
	}

	for target := range m.permanent {
		entry := parseCooldownTarget(target)
		entry.RemainingSec = -1
		entry.Permanent = true
		allItems = append(allItems, entry)
		if entry.KeyID != "" {
			keyList = append(keyList, entry)
		} else if entry.Model != "" {
			modelList = append(modelList, entry)
		}
	}

	return map[string]any{
		"ok":        true,
		"total":     len(allItems),
		"cooldowns": allItems,
		"models":    modelList,
		"keys":      keyList,
	}
}

// TryAttempt records an attempted key call during a single request.
type TryAttempt struct {
	Provider     string
	KeyID        string
	Model        string
	Status       int
	ErrorSnippet string
}

// CheckForbiddenAlike inspects failed attempts within a single request.
// If two different keys from the same provider fail with the exact same 400/403/422 status
// and similar error snippets, it indicates the client's request payload itself is invalid.
// It clears cooldown on BOTH the previous key AND current key, and signals the scheduler to stop retrying.
func CheckForbiddenAlike(attempts []TryAttempt, curr TryAttempt, cm *CooldownManager) bool {
	if curr.Status != 400 && curr.Status != 403 && curr.Status != 422 {
		return false
	}

	for _, prev := range attempts {
		if prev.Provider == curr.Provider && prev.KeyID != curr.KeyID && prev.Status == curr.Status {
			// Compare error snippet fingerprints (similarity)
			prevWords := cleanWords(prev.ErrorSnippet)
			currWords := cleanWords(curr.ErrorSnippet)
			isAlike := false
			if prevWords == currWords {
				isAlike = true
			} else if prevWords != "" && currWords != "" && (strings.Contains(currWords, prevWords) || strings.Contains(prevWords, currWords)) {
				isAlike = true
			} else if prev.ErrorSnippet == curr.ErrorSnippet {
				isAlike = true
			}

			if isAlike {
				// Matched alike! Remove cooldown on both keys
				cm.ClearKey(prev.Provider, prev.KeyID)
				cm.ClearKey(curr.Provider, curr.KeyID)
				return true
			}
		}
	}
	return false
}

func cleanWords(s string) string {
	s = strings.ToLower(obs.ScrubString(s))
	// Keep alphanumeric words only
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}
