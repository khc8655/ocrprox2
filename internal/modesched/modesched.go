// Package modesched handles automated time-window switching between Agent and KB modes,
// in-flight request graceful draining, and HMAC-signed webhook notifications.
package modesched

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

// ModeScheduler manages time-window evaluation, mode transition, and request draining.
type ModeScheduler struct {
	mu           sync.Mutex
	currentMode  types.RunMode
	inflight     atomic.Int64
	drainCond    *sync.Cond
	client       *http.Client
	lastCheck    time.Time
}

// NewModeScheduler creates a ModeScheduler.
func NewModeScheduler(initialMode types.RunMode, allowPrivate bool) *ModeScheduler {
	s := &ModeScheduler{
		currentMode: initialMode,
		client:      upstream.DefaultClient(10*time.Second, allowPrivate),
	}
	s.drainCond = sync.NewCond(&s.mu)
	return s
}

// IncInflight increments in-flight request counter.
func (s *ModeScheduler) IncInflight() {
	s.inflight.Add(1)
}

// DecInflight decrements in-flight request counter and signals waiting drain callers.
func (s *ModeScheduler) DecInflight() {
	if s.inflight.Add(-1) == 0 {
		s.mu.Lock()
		s.drainCond.Broadcast()
		s.mu.Unlock()
	}
}

// Inflight returns currently active requests.
func (s *ModeScheduler) Inflight() int64 {
	return s.inflight.Load()
}

// Drain blocks until in-flight requests drop to 0 or timeout expires.
func (s *ModeScheduler) Drain(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for s.inflight.Load() > 0 {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
	return true
}

// DetermineMode evaluates whether the current timestamp is inside the configured Agent window.
func DetermineMode(now time.Time, window, tzName string) types.RunMode {
	if window == "" {
		return types.ModeAgent
	}

	loc := time.UTC
	if tzName != "" {
		if l, err := time.LoadLocation(tzName); err == nil {
			loc = l
		}
	}

	parts := strings.Split(window, "-")
	if len(parts) != 2 {
		return types.ModeAgent
	}

	startMinutes := parseMinutes(parts[0])
	endMinutes := parseMinutes(parts[1])
	if startMinutes < 0 || endMinutes < 0 {
		return types.ModeAgent
	}

	tInLoc := now.In(loc)
	currMinutes := tInLoc.Hour()*60 + tInLoc.Minute()

	if startMinutes <= endMinutes {
		// Normal window: e.g. 08:30-22:30
		if currMinutes >= startMinutes && currMinutes < endMinutes {
			return types.ModeAgent
		}
		return types.ModeKB
	}

	// Overnight window: e.g. 22:30-08:30
	if currMinutes >= startMinutes || currMinutes < endMinutes {
		return types.ModeAgent
	}
	return types.ModeKB
}

func parseMinutes(timeStr string) int {
	parts := strings.Split(strings.TrimSpace(timeStr), ":")
	if len(parts) != 2 {
		return -1
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return -1
	}
	return h*60 + m
}

// CheckAndTransition checks if the mode should transition, drains requests, and sends webhook.
func (s *ModeScheduler) CheckAndTransition(settings types.RuntimeSettings) (types.RunMode, bool) {
	if !settings.ModeScheduleEnabled {
		return s.CurrentMode(), false
	}

	now := time.Now()
	newMode := DetermineMode(now, settings.ModeScheduleAgentWindow, settings.ModeScheduleTimezone)

	s.mu.Lock()
	oldMode := s.currentMode
	if newMode == oldMode {
		s.mu.Unlock()
		return oldMode, false
	}
	s.currentMode = newMode
	s.mu.Unlock()

	// Mode edge switched! Trigger webhook in background
	if settings.ModeScheduleWebhookURL != "" {
		go s.sendWebhook(settings.ModeScheduleWebhookURL, settings.ModeScheduleWebhookSecret, oldMode, newMode, now)
	}

	return newMode, true
}

// CurrentMode returns current operating mode.
func (s *ModeScheduler) CurrentMode() types.RunMode {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentMode
}

// SetManualMode explicitly overrides the operating mode and updates internal state.
func (s *ModeScheduler) SetManualMode(mode types.RunMode) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.currentMode = mode
}

// Start initiates a background ticker loop for periodic time window evaluation.
func (s *ModeScheduler) Start(ctx context.Context, getSettings func() (types.RuntimeSettings, error), onTransition func(from, to types.RunMode)) {
	ticker := time.NewTicker(15 * time.Second)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if getSettings == nil {
					continue
				}
				settings, err := getSettings()
				if err != nil || !settings.ModeScheduleEnabled {
					continue
				}
				oldMode := s.CurrentMode()
				newMode, changed := s.CheckAndTransition(settings)
				if changed {
					s.Drain(5 * time.Second)
					if onTransition != nil {
						onTransition(oldMode, newMode)
					}
				}
			}
		}
	}()
}

func (s *ModeScheduler) sendWebhook(url, secret string, fromMode, toMode types.RunMode, ts time.Time) {
	payload := map[string]any{
		"event":     "mode_switched",
		"from_mode": fromMode,
		"to_mode":   toMode,
		"timestamp": ts.Unix(),
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}

	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		sig := hex.EncodeToString(mac.Sum(nil))
		req.Header.Set("X-LLMProxy-Signature", fmt.Sprintf("sha256=%s", sig))
	}

	resp, err := s.client.Do(req)
	if err == nil {
		_ = resp.Body.Close()
	}
}
