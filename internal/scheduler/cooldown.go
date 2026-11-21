// Package scheduler provides routing strategies, multi-level cooldowns,
// the Magpie forbiddenAlike algorithm, persistent long bans, and streaming first-byte peeking.
// Upstream anchors: magpie internal/gateway/routing.go `forbiddenAlike`. Everything here is our
// own implementation; the full table is docs/MAGPIE_UPSTREAM_SYNC.md §3.4.
package scheduler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/filelock"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/steady"
)

// CooldownManager tracks temporary, persistent, and permanent cooldowns.
type CooldownManager struct {
	mu        sync.RWMutex
	cooldowns map[string]time.Time // key: "p:{provider}:k:{keyID}" or "p:{provider}:m:{model}" -> expiresAt
	permanent map[string]bool      // for 410 Gone
	banFile   string               // path to key_bans.json (empty for RoleLite, non-empty for RoleFull)
}

// PersistedBan represents a single persistent ban entry written to key_bans.json.
type PersistedBan struct {
	Target    string `json:"target"`
	ExpiresAt string `json:"expires_at,omitempty"` // RFC3339
	Permanent bool   `json:"permanent,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Provider  string `json:"provider,omitempty"`
	KeyID     string `json:"key_id,omitempty"`
	Model     string `json:"model,omitempty"`
}

// PersistedBansData represents the JSON envelope for key_bans.json.
type PersistedBansData struct {
	Version int                     `json:"_version"`
	Bans    map[string]PersistedBan `json:"bans"`
}

// NewCooldownManager creates a CooldownManager.
// If banFile is non-empty (RoleFull), it loads valid unexpired bans from disk.
// If banFile is omitted or empty (RoleLite), zero disk I/O occurs.
func NewCooldownManager(banFile ...string) *CooldownManager {
	filePath := ""
	if len(banFile) > 0 {
		filePath = banFile[0]
	}
	cm := &CooldownManager{
		cooldowns: make(map[string]time.Time),
		permanent: make(map[string]bool),
		banFile:   filePath,
	}
	if filePath != "" {
		_ = cm.loadBansLocked()
	}
	return cm
}

// SetBanFile configures the persistent ban file path and reloads valid bans.
// If path is empty, persistent disk I/O is disabled.
func (m *CooldownManager) SetBanFile(path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.banFile = path
	if path != "" {
		return m.loadBansLocked()
	}
	return nil
}

// BanFile returns the active ban file path.
func (m *CooldownManager) BanFile() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.banFile
}

// LoadBans reloads unexpired bans from the configured ban file.
func (m *CooldownManager) LoadBans() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.loadBansLocked()
}

func (m *CooldownManager) loadBansLocked() error {
	if m.banFile == "" {
		return nil
	}
	unlock, _ := filelock.Lock(m.banFile+".lock", filelock.Wait)
	defer unlock()

	data, err := steady.ReadFile(m.banFile)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}

	var envelope PersistedBansData
	if err := json.Unmarshal(data, &envelope); err != nil {
		return err
	}

	now := time.Now()
	for target, ban := range envelope.Bans {
		if ban.Permanent {
			m.permanent[target] = true
			continue
		}
		if ban.ExpiresAt != "" {
			exp, err := time.Parse(time.RFC3339, ban.ExpiresAt)
			if err == nil && now.Before(exp) {
				m.cooldowns[target] = exp
			}
		}
	}
	return nil
}

// SaveBans persists active bans (>= 300s or permanent) to key_bans.json.
func (m *CooldownManager) SaveBans() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.saveBansLocked()
}

func (m *CooldownManager) saveBansLocked() error {
	if m.banFile == "" {
		return nil
	}
	dir := filepath.Dir(m.banFile)
	if dir != "" && dir != "." {
		_ = os.MkdirAll(dir, 0o700)
	}

	unlock, _ := filelock.Lock(m.banFile+".lock", filelock.Wait)
	defer unlock()

	now := time.Now()
	bans := make(map[string]PersistedBan)

	// Persist active cooldowns >= 300s
	for target, exp := range m.cooldowns {
		if now.Before(exp) {
			dur := exp.Sub(now)
			if dur >= 300*time.Second {
				entry := parseCooldownTarget(target)
				bans[target] = PersistedBan{
					Target:    target,
					ExpiresAt: exp.Format(time.RFC3339),
					Permanent: false,
					Provider:  entry.Provider,
					KeyID:     entry.KeyID,
					Model:     entry.Model,
				}
			}
		}
	}

	// Persist permanent bans (410 Gone)
	for target := range m.permanent {
		entry := parseCooldownTarget(target)
		bans[target] = PersistedBan{
			Target:    target,
			Permanent: true,
			Provider:  entry.Provider,
			KeyID:     entry.KeyID,
			Model:     entry.Model,
		}
	}

	envelope := PersistedBansData{
		Version: 1,
		Bans:    bans,
	}

	b, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return err
	}
	return steady.WriteFile(m.banFile, b, 0o600)
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

// RemainingFor returns how long the key/model stays cooled down (0 when not cooled).
// Used to explain why a request skipped a candidate instead of dialing it.
func (m *CooldownManager) RemainingFor(provider, model, keyID string) time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()

	now := time.Now()
	longest := time.Duration(0)
	for _, target := range []string{
		KeyTarget(provider, keyID),
		KeyModelTarget(provider, keyID, model),
		ModelTarget(provider, model),
	} {
		if until, ok := m.cooldowns[target]; ok {
			if d := until.Sub(now); d > longest {
				longest = d
			}
		}
	}
	if longest > 0 {
		return longest.Round(time.Second)
	}
	return 0
}

// ParseNextQuotaReset parses a daily reset time string (e.g. "00:00+08:00", "08:00", "08:00:00", "12:00-05:00")
// and returns the next upcoming time.Time for that daily reset.
func ParseNextQuotaReset(resetAt string, now time.Time) (time.Time, error) {
	resetAt = strings.TrimSpace(resetAt)
	if resetAt == "" {
		return time.Time{}, errors.New("scheduler: empty quota_reset_at")
	}

	var hour, min, sec int
	var loc *time.Location

	if t, err := time.Parse("15:04:05-07:00", resetAt); err == nil {
		hour, min, sec = t.Hour(), t.Minute(), t.Second()
		loc = t.Location()
	} else if t, err := time.Parse("15:04-07:00", resetAt); err == nil {
		hour, min, sec = t.Hour(), t.Minute(), t.Second()
		loc = t.Location()
	} else if t, err := time.Parse("15:04:05", resetAt); err == nil {
		hour, min, sec = t.Hour(), t.Minute(), t.Second()
		loc = now.Location()
	} else if t, err := time.Parse("15:04", resetAt); err == nil {
		hour, min, sec = t.Hour(), t.Minute(), t.Second()
		loc = now.Location()
	} else {
		return time.Time{}, fmt.Errorf("scheduler: unrecognized quota_reset_at format: %q", resetAt)
	}

	nowInLoc := now.In(loc)
	target := time.Date(nowInLoc.Year(), nowInLoc.Month(), nowInLoc.Day(), hour, min, sec, 0, loc)
	if !target.After(now) {
		target = target.AddDate(0, 0, 1)
	}
	return target, nil
}

// ApplyQuotaCooldown applies a cooldown until the next daily quota reset specified by resetAt (e.g. "00:00+08:00").
func (m *CooldownManager) ApplyQuotaCooldown(provider, model, keyID, resetAt string) (appliedSec int, target string, err error) {
	now := time.Now()
	nextReset, err := ParseNextQuotaReset(resetAt, now)
	if err != nil {
		return 0, "", err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	target = KeyModelTarget(provider, keyID, model)
	m.cooldowns[target] = nextReset
	appliedSec = int(nextReset.Sub(now).Seconds())
	if m.banFile != "" && appliedSec >= 300 {
		_ = m.saveBansLocked()
	}
	return appliedSec, target, nil
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
		if m.banFile != "" {
			_ = m.saveBansLocked()
		}
		return 86400 * 365, target

	case status == 401 || status == 402 || status == 403: // Key-level auth/billing
		target = KeyTarget(provider, keyID)
		if durAuth <= 0 {
			// Explicitly disabled (cooldown_auth_error_sec = 0): no ban, no entry.
			return 0, target
		}
		sec := int(durAuth.Seconds())
		m.cooldowns[target] = now.Add(durAuth)
		if m.banFile != "" && sec >= 300 {
			_ = m.saveBansLocked()
		}
		return sec, target

	case status == 400 || status == 422: // Suspected client payload error: key-level only, do NOT cool down model!
		target = KeyTarget(provider, keyID)
		sec := int(durRateLimit.Seconds())
		m.cooldowns[target] = now.Add(durRateLimit)
		if m.banFile != "" && sec >= 300 {
			_ = m.saveBansLocked()
		}
		return sec, target

	case status == 429: // Rate limit is per Key/Model quota (RPM/TPM), NOT entire provider model!
		target = KeyModelTarget(provider, keyID, model)
		sec := int(durRateLimit.Seconds())
		m.cooldowns[target] = now.Add(durRateLimit)
		if m.banFile != "" && sec >= 300 {
			_ = m.saveBansLocked()
		}
		return sec, target

	case status >= 500 && status != 504: // Model-level server error
		target = ModelTarget(provider, model)
		sec := int(durServerError.Seconds())
		m.cooldowns[target] = now.Add(durServerError)
		if m.banFile != "" && sec >= 300 {
			_ = m.saveBansLocked()
		}
		return sec, target

	default: // Network timeout / connection error (e.g. 504)
		target = ModelTarget(provider, model)
		sec := int(durNetwork.Seconds())
		m.cooldowns[target] = now.Add(durNetwork)
		if m.banFile != "" && sec >= 300 {
			_ = m.saveBansLocked()
		}
		return sec, target
	}
}

// Clear removes cooldown for a specific target.
func (m *CooldownManager) Clear(target string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	hadPerm := m.permanent[target]
	exp, hadExp := m.cooldowns[target]
	delete(m.cooldowns, target)
	delete(m.permanent, target)

	if m.banFile != "" && (hadPerm || (hadExp && time.Until(exp) >= 300*time.Second)) {
		_ = m.saveBansLocked()
	}
}

// ClearKey removes cooldown for a specific key (including all model variants).
func (m *CooldownManager) ClearKey(provider, keyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	kt := KeyTarget(provider, keyID)
	hadChanges := false
	if m.permanent[kt] {
		delete(m.permanent, kt)
		hadChanges = true
	}
	if exp, ok := m.cooldowns[kt]; ok {
		delete(m.cooldowns, kt)
		if time.Until(exp) >= 300*time.Second {
			hadChanges = true
		}
	}
	prefix := kt + ":"
	for k, exp := range m.cooldowns {
		if strings.HasPrefix(k, prefix) {
			delete(m.cooldowns, k)
			if time.Until(exp) >= 300*time.Second {
				hadChanges = true
			}
		}
	}
	if m.banFile != "" && hadChanges {
		_ = m.saveBansLocked()
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
