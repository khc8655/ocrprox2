package modesched

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestDetermineMode(t *testing.T) {
	// Normal window: 08:30 - 22:30 UTC
	t1 := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC) // 10:00 -> Agent
	if got := DetermineMode(t1, "08:30-22:30", "UTC"); got != types.ModeAgent {
		t.Errorf("expected ModeAgent at 10:00, got %s", got)
	}

	t2 := time.Date(2026, 11, 8, 23, 0, 0, 0, time.UTC) // 23:00 -> KB
	if got := DetermineMode(t2, "08:30-22:30", "UTC"); got != types.ModeKB {
		t.Errorf("expected ModeKB at 23:00, got %s", got)
	}

	// Overnight window: 22:00 - 06:00 UTC
	t3 := time.Date(2026, 11, 8, 23, 30, 0, 0, time.UTC) // 23:30 -> Agent
	if got := DetermineMode(t3, "22:00-06:00", "UTC"); got != types.ModeAgent {
		t.Errorf("expected ModeAgent at 23:30 for overnight window, got %s", got)
	}

	t4 := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC) // 12:00 -> KB
	if got := DetermineMode(t4, "22:00-06:00", "UTC"); got != types.ModeKB {
		t.Errorf("expected ModeKB at 12:00 for overnight window, got %s", got)
	}
}

func TestModeScheduler_Drain(t *testing.T) {
	sched := NewModeScheduler(types.ModeAgent, true)

	sched.IncInflight()
	sched.IncInflight()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(100 * time.Millisecond)
		sched.DecInflight()
		time.Sleep(50 * time.Millisecond)
		sched.DecInflight()
	}()

	drained := sched.Drain(500 * time.Millisecond)
	if !drained {
		t.Fatalf("expected Drain to succeed within 500ms")
	}

	wg.Wait()
	if sched.Inflight() != 0 {
		t.Errorf("expected 0 inflight requests, got %d", sched.Inflight())
	}
}

func TestModeScheduler_HMACWebhook(t *testing.T) {
	secret := "webhook-secret-xyz"
	var mu sync.Mutex
	var receivedPayload map[string]any
	var receivedSig string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sig := r.Header.Get("X-LLMProxy-Signature")

		var payload map[string]any
		_ = json.Unmarshal(body, &payload)

		mu.Lock()
		receivedSig = sig
		receivedPayload = payload
		mu.Unlock()

		// Verify HMAC
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		expectedSig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

		if sig != expectedSig {
			t.Errorf("signature mismatch: got %s, want %s", sig, expectedSig)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	sched := NewModeScheduler(types.ModeAgent, true)
	settings := types.RuntimeSettings{
		ModeScheduleEnabled:       true,
		ModeScheduleAgentWindow:   "00:00-00:01", // forces KB
		ModeScheduleTimezone:      "UTC",
		ModeScheduleWebhookURL:    ts.URL,
		ModeScheduleWebhookSecret: secret,
	}

	newMode, switched := sched.CheckAndTransition(settings)
	if !switched || newMode != types.ModeKB {
		t.Fatalf("expected transition to KB, got %s, switched=%v", newMode, switched)
	}

	// Wait for async webhook delivery
	time.Sleep(150 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if receivedPayload == nil || receivedPayload["event"] != "mode_switched" {
		t.Errorf("expected webhook payload with event=mode_switched")
	}
	if !strings.HasPrefix(receivedSig, "sha256=") {
		t.Errorf("expected sha256= prefix in signature, got %s", receivedSig)
	}
}

func TestModeScheduler_SetManualModeAndStart(t *testing.T) {
	sched := NewModeScheduler(types.ModeAgent, true)
	if sched.CurrentMode() != types.ModeAgent {
		t.Fatalf("expected ModeAgent, got %s", sched.CurrentMode())
	}

	sched.SetManualMode(types.ModeKB)
	if sched.CurrentMode() != types.ModeKB {
		t.Fatalf("expected ModeKB after SetManualMode, got %s", sched.CurrentMode())
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sched.Start(ctx, func() (types.RuntimeSettings, error) {
		return types.RuntimeSettings{ModeScheduleEnabled: false}, nil
	}, nil)

	time.Sleep(50 * time.Millisecond)
	if sched.CurrentMode() != types.ModeKB {
		t.Fatalf("expected ModeKB maintained, got %s", sched.CurrentMode())
	}
}
