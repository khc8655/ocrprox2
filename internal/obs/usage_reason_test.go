package obs

// A locally rejected request (model not configured / protocol mismatch / every
// key cooling down) never reaches a key, so its try has no provider. The ledger
// used to drop such tries entirely, leaving the console's "原因" column empty for
// exactly the failures an operator most wants to explain. The reason is now
// hoisted onto the record itself.

import (
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestUsageRecord_LocalRejectionKeepsReason(t *testing.T) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager error: %v", err)
	}
	defer mgr.Close()

	mgr.RecordRequest(types.RequestTrace{
		ID:        "req-local",
		Timestamp: time.Now().Unix(),
		Mode:      "agent",
		Endpoint:  "/v1/chat/completions",
		ReqModel:  "ghost-model",
		Status:    404,
		Tries: []types.Try{{
			Status: 404,
			Reason: "model_not_found",
			Error:  `model "ghost-model" not configured or disabled`,
		}},
	})
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	records := mgr.RecentRequestsFromLedger(10)
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(records))
	}
	rec := records[0]
	if rec.Reason != "model_not_found" {
		t.Fatalf("record reason = %q, want model_not_found", rec.Reason)
	}
	if rec.Err == "" {
		t.Fatal("record must keep the explanation text")
	}
	// The keyless try is a local decision, not a per-key failure.
	if len(rec.FailedTries) != 0 {
		t.Fatalf("keyless try must not appear in try_failed, got %+v", rec.FailedTries)
	}
}

func TestUsageRecord_KeyFailureStaysPerKeyAndHoistsReason(t *testing.T) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager error: %v", err)
	}
	defer mgr.Close()

	mgr.RecordRequest(types.RequestTrace{
		ID:             "req-key",
		Timestamp:      time.Now().Unix(),
		Mode:           "agent",
		Endpoint:       "/v1/chat/completions",
		ReqModel:       "m",
		WinnerProvider: "p2",
		WinnerKey:      "k2",
		Status:         200,
		Tries: []types.Try{
			{Attempt: 1, Provider: "p1", KeyID: "k1", Status: 500, Reason: "upstream_error", ErrType: "server_error"},
			{Attempt: 2, Provider: "p2", KeyID: "k2", Status: 200},
		},
	})
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	records := mgr.RecentRequestsFromLedger(10)
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(records))
	}
	rec := records[0]
	if len(rec.FailedTries) != 1 || rec.FailedTries[0].KeyID != "k1" {
		t.Fatalf("expected the failed key in try_failed, got %+v", rec.FailedTries)
	}
	if rec.Reason != "upstream_error" || rec.ErrType != "server_error" {
		t.Fatalf("record-level reason = %q/%q, want upstream_error/server_error", rec.Reason, rec.ErrType)
	}
}
