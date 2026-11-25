package obs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

// replayTrace builds a request whose InTokens doubles as an ordinal, so the
// replayed records can be checked for exact order.
func replayTrace(ordinal int, ts int64) types.RequestTrace {
	return types.RequestTrace{
		ID:             fmt.Sprintf("req-%04d", ordinal),
		Timestamp:      ts,
		Mode:           "agent",
		Endpoint:       "/v1/chat/completions",
		ReqModel:       "gpt-4o",
		ServedModel:    "gpt-4o",
		WinnerProvider: "openai",
		WinnerKey:      "k1",
		Status:         200,
		InTokens:       ordinal,
		OutTokens:      1,
		TotalMillis:    42,
		Tries:          []types.Try{{Attempt: 1, Status: 200}},
	}
}

func ledgerRecords(t *testing.T, path string) []UsageRecord {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []UsageRecord
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var r UsageRecord
		if err := json.Unmarshal(line, &r); err != nil {
			t.Fatalf("%s: corrupt ledger line %q: %v", path, line, err)
		}
		out = append(out, r)
	}
	return out
}

func assertLedgerPairBound(t *testing.T, dir string, bound int64) {
	t.Helper()
	total := ledgerPairSize(t, dir)
	// The bound also means no third generation may ever appear on disk.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "usage.jsonl") && e.Name() != "usage.jsonl" && e.Name() != "usage.jsonl.1" {
			t.Fatalf("unexpected ledger generation %q on disk", e.Name())
		}
	}
	if total > bound {
		t.Fatalf("usage.jsonl + usage.jsonl.1 = %d bytes, want <= %d", total, bound)
	}
}

func ledgerPairSize(t *testing.T, dir string) int64 {
	t.Helper()
	var total int64
	for _, name := range []string{"usage.jsonl", "usage.jsonl.1"} {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatalf("stat %s: %v", name, err)
		}
		total += fi.Size()
	}
	return total
}

// 120 records on disk, ask for 50: the result must be exactly the last 50,
// oldest first, with the original fields intact.
func TestRecentRequestsFromLedger_Last50InOrder(t *testing.T) {
	mgr, err := NewManager(types.RoleFull, t.TempDir())
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer mgr.Close()

	base := time.Now().Unix() - 500
	for i := 0; i < 120; i++ {
		mgr.RecordRequest(replayTrace(i, base+int64(i)))
	}
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	got := mgr.RecentRequestsFromLedger(50)
	if len(got) != 50 {
		t.Fatalf("len(recent) = %d, want 50", len(got))
	}
	if got[0].InTokens != 70 {
		t.Errorf("oldest replayed record = %d, want 70", got[0].InTokens)
	}
	if got[len(got)-1].InTokens != 119 {
		t.Errorf("newest replayed record = %d, want 119", got[len(got)-1].InTokens)
	}
	for i := 1; i < len(got); i++ {
		if got[i].Timestamp <= got[i-1].Timestamp {
			t.Fatalf("records are not oldest-first at %d: %d then %d", i, got[i-1].Timestamp, got[i].Timestamp)
		}
	}
	// Fields must be passed through untouched.
	last := got[len(got)-1]
	if last.Status != 200 || last.Millis != 42 || last.Tries != 1 || last.Provider != "openai" || last.KeyID != "k1" {
		t.Errorf("replayed record lost fields: %+v", last)
	}

	// A larger window still returns everything available, oldest first.
	all := mgr.RecentRequestsFromLedger(200)
	if len(all) != 120 || all[0].InTokens != 0 || all[119].InTokens != 119 {
		t.Fatalf("full replay = %d records (first %d, last %d), want 120 (0..119)",
			len(all), all[0].InTokens, all[len(all)-1].InTokens)
	}
	t.Logf("120 records on disk -> replayed 50: first in=%d, last in=%d, oldest-first=%v",
		got[0].InTokens, got[len(got)-1].InTokens, got[0].Timestamp < got[len(got)-1].Timestamp)
}

// A process killed mid-append leaves a final line without '\n'. That line is
// incomplete and must be dropped; once the newline arrives it becomes valid.
func TestRecentRequestsFromLedger_DropsUnterminatedTail(t *testing.T) {
	dir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, dir)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer mgr.Close()

	now := time.Now().Unix()
	for i := 0; i < 10; i++ {
		mgr.RecordRequest(replayTrace(i, now+int64(i)))
	}
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	ledger := filepath.Join(dir, "usage.jsonl")
	f, err := os.OpenFile(ledger, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	// Valid JSON, but no terminating newline: the writer did not finish the line.
	if _, err := f.WriteString(`{"t":9999999999,"in":777}`); err != nil {
		t.Fatalf("append partial: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}

	got := mgr.RecentRequestsFromLedger(50)
	if len(got) != 10 {
		t.Fatalf("len(recent) = %d, want 10 (partial tail dropped)", len(got))
	}
	for _, r := range got {
		if r.InTokens == 777 {
			t.Fatalf("replay included the unterminated tail record: %+v", r)
		}
	}
	if got[len(got)-1].InTokens != 9 {
		t.Errorf("newest complete record = %d, want 9", got[len(got)-1].InTokens)
	}

	// Completing the line makes the record visible.
	f, err = os.OpenFile(ledger, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("reopen ledger: %v", err)
	}
	if _, err := f.WriteString("\n"); err != nil {
		t.Fatalf("finish line: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}
	got = mgr.RecentRequestsFromLedger(50)
	if len(got) != 11 || got[10].InTokens != 777 {
		t.Fatalf("after newline: len=%d, want 11 with 777 last", len(got))
	}
}

// Force rotations until both usage.jsonl and usage.jsonl.1 hold data, then ask
// for 50: the replay must stitch the two files in chronological order.
func TestRecentRequestsFromLedger_SpansRotation(t *testing.T) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer mgr.Close()

	now := time.Now().Unix()
	// Measure one record's on-disk size, then size the rotation limit so each
	// generation holds ~60 records: one full generation alone covers the 50
	// asked for below, while the short tail generation forces the cross-file read.
	mgr.RecordRequest(replayTrace(0, now))
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	fi, err := os.Stat(filepath.Join(tmpDir, "usage.jsonl"))
	if err != nil {
		t.Fatalf("stat ledger: %v", err)
	}
	recordBytes := fi.Size()
	if recordBytes <= 0 {
		t.Fatal("empty ledger after first record")
	}
	mgr.ledgerLimit.Store(60 * recordBytes)

	const written = 140
	for i := 1; i < written; i++ {
		mgr.RecordRequest(replayTrace(i, now+int64(i)))
	}
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	older := ledgerRecords(t, filepath.Join(tmpDir, "usage.jsonl.1"))
	active := ledgerRecords(t, filepath.Join(tmpDir, "usage.jsonl"))
	if len(older) == 0 {
		t.Fatal("usage.jsonl.1 is empty: rotation did not happen")
	}
	if len(active) == 0 || len(active) >= 50 {
		t.Fatalf("test setup: active has %d records, want 1..49 (so the replay must cross files)", len(active))
	}
	available := len(older) + len(active)
	if available >= written {
		t.Fatalf("test setup: rotation dropped nothing (%d records available)", available)
	}
	if available < 50 {
		t.Fatalf("test setup: only %d records survive, need at least 50", available)
	}

	want := append(append([]UsageRecord{}, older...), active...)
	want = want[len(want)-50:]

	got := mgr.RecentRequestsFromLedger(50)
	if len(got) != 50 {
		t.Fatalf("len(recent) = %d, want 50 (older=%d active=%d)", len(got), len(older), len(active))
	}
	for i := range want {
		if got[i].InTokens != want[i].InTokens || got[i].Timestamp != want[i].Timestamp {
			t.Fatalf("record %d = (in=%d ts=%d), want (in=%d ts=%d)",
				i, got[i].InTokens, got[i].Timestamp, want[i].InTokens, want[i].Timestamp)
		}
	}
	if got[len(got)-1].InTokens != written-1 {
		t.Errorf("newest replayed record = %d, want %d", got[len(got)-1].InTokens, written-1)
	}
	t.Logf("rotation: usage.jsonl.1=%d records, usage.jsonl=%d records, replayed=%d, window=%d..%d",
		len(older), len(active), len(got), got[0].InTokens, got[len(got)-1].InTokens)
}

// A ledger larger than one 64 KiB read chunk must still replay correctly: lines
// straddling chunk boundaries are reassembled, not dropped or duplicated.
func TestRecentRequestsFromLedger_MultiChunk(t *testing.T) {
	dir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, dir)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer mgr.Close()

	const total = 600 // ~200 B each => ~120 KiB, i.e. two chunks
	now := time.Now().Unix()
	for i := 0; i < total; i++ {
		mgr.RecordRequest(replayTrace(i, now+int64(i)))
	}
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	fi, err := os.Stat(filepath.Join(dir, "usage.jsonl"))
	if err != nil || fi.Size() <= 64<<10 {
		t.Fatalf("test setup: ledger size = %v (err %v), want > 64 KiB", fi, err)
	}

	got := mgr.RecentRequestsFromLedger(50)
	if len(got) != 50 {
		t.Fatalf("len(recent) = %d, want 50", len(got))
	}
	if got[0].InTokens != total-50 || got[49].InTokens != total-1 {
		t.Fatalf("window = %d..%d, want %d..%d",
			got[0].InTokens, got[49].InTokens, total-50, total-1)
	}
	for i := 1; i < len(got); i++ {
		if got[i].InTokens != got[i-1].InTokens+1 {
			t.Fatalf("gap or duplicate at %d: %d then %d", i, got[i-1].InTokens, got[i].InTokens)
		}
	}

	all := mgr.RecentRequestsFromLedger(total)
	if len(all) != total || all[0].InTokens != 0 || all[total-1].InTokens != total-1 {
		t.Fatalf("full replay = %d records (first %d, last %d), want %d (0..%d)",
			len(all), all[0].InTokens, all[len(all)-1].InTokens, total, total-1)
	}
}

// When the rename to .1 fails, rotateLedger must fall back to truncating the
// active file — never create a third generation and never leave an unbounded
// file behind. A directory squatting on the .1 name forces os.Rename to fail
// deterministically on POSIX.
func TestRotateLedger_RenameFailureStaysBounded(t *testing.T) {
	dir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, dir)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer mgr.Close()

	const limit = 2048
	mgr.ledgerLimit.Store(limit)
	rotated := filepath.Join(dir, "usage.jsonl.1")
	if err := os.Mkdir(rotated, 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", rotated, err)
	}

	now := time.Now().Unix()
	for i := 0; i < 80; i++ {
		mgr.RecordRequest(replayTrace(i, now+int64(i)))
		if i%5 == 0 {
			if err := mgr.Flush(); err != nil {
				t.Fatalf("Flush: %v", err)
			}
			if fi, err := os.Stat(filepath.Join(dir, "usage.jsonl")); err != nil || fi.Size() > limit {
				t.Fatalf("usage.jsonl size = %v (err %v), want <= %d after a failed rotation", fi, err, limit)
			}
		}
	}
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	// The .1 name must still be the directory we created: rename did not clobber
	// it, and no other generation appeared.
	if st, err := os.Stat(rotated); err != nil || !st.IsDir() {
		t.Fatalf("usage.jsonl.1 was replaced (err %v, isDir %v)", err, err == nil && st.IsDir())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var files int
	var total int64
	for _, e := range entries {
		if !e.Type().IsRegular() || !strings.HasPrefix(e.Name(), "usage.jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			t.Fatalf("info %s: %v", e.Name(), err)
		}
		files++
		total += info.Size()
	}
	if files != 1 || total > limit {
		t.Fatalf("after rename failures: %d usage.jsonl files totalling %d bytes, want 1 file <= %d", files, total, limit)
	}
	// The ledger still replays what survived the truncation fallback.
	if recs := mgr.RecentRequestsFromLedger(10); len(recs) == 0 {
		t.Fatal("replay returned nothing after the rename-failure fallback")
	}
}

// Whenever data is on disk, usage.jsonl + usage.jsonl.1 <= 2 * limit. A
// runaway client-controlled model name must not break that.
func TestUsageLedger_DiskBound(t *testing.T) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(types.RoleFull, tmpDir)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer mgr.Close()

	const limit = 2048
	mgr.ledgerLimit.Store(limit)
	now := time.Now().Unix()

	for i := 0; i < 120; i++ {
		mgr.RecordRequest(replayTrace(i, now+int64(i)))
		if i%5 == 0 {
			if err := mgr.Flush(); err != nil {
				t.Fatalf("Flush: %v", err)
			}
			assertLedgerPairBound(t, tmpDir, 2*limit)
		}
	}

	// A single record carrying a 200 KB model name: without the per-record cap
	// this one line alone would equal ~100x the rotation limit.
	mgr.RecordRequest(types.RequestTrace{
		ID:          "runaway",
		Timestamp:   now + 1000,
		Mode:        "agent",
		ReqModel:    strings.Repeat("m", 200_000),
		Status:      200,
		TotalMillis: 1,
		Tries:       []types.Try{{Attempt: 1, Status: 200}},
	})
	if err := mgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	assertLedgerPairBound(t, tmpDir, 2*limit)

	// Every line must also respect the per-record cap (half the rotation limit).
	maxLine := int64(limit/2) - 1
	for _, name := range []string{"usage.jsonl", "usage.jsonl.1"} {
		raw, err := os.ReadFile(filepath.Join(tmpDir, name))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatalf("read %s: %v", name, err)
		}
		for _, line := range bytes.Split(raw, []byte{'\n'}) {
			if int64(len(line)) > maxLine {
				t.Fatalf("%s has a %d-byte line, cap is %d", name, len(line), maxLine)
			}
		}
	}

	// The trimmed record is still replayable by its summary fields.
	got := mgr.RecentRequestsFromLedger(1)
	if len(got) != 1 || !strings.HasPrefix(got[0].ReqModel, "mmmm") {
		t.Fatalf("newest record should be the trimmed runaway record, got %+v", got)
	}
	t.Logf("limit=%d: usage.jsonl + usage.jsonl.1 = %d bytes (cap %d), runaway ReqModel kept %d bytes",
		limit, ledgerPairSize(t, tmpDir), 2*limit, len(got[0].ReqModel))
}

// Lite has no ledger: the replay falls back to the in-memory window, still
// oldest-first and still bounded by the requested limit.
func TestRecentRequestsFromLedger_LiteMemory(t *testing.T) {
	mgr, err := NewManager(types.RoleLite, "")
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer mgr.Close()

	now := time.Now().Unix()
	for i := 0; i < 8; i++ {
		mgr.RecordRequest(replayTrace(i, now+int64(i)))
	}

	got := mgr.RecentRequestsFromLedger(3)
	if len(got) != 3 || got[0].InTokens != 5 || got[2].InTokens != 7 {
		t.Fatalf("lite replay = %v, want ordinals 5,6,7", inTokensOf(got))
	}

	recs, source, truncated := mgr.RecentRequestsReplay(10, false)
	if source != "memory" || !truncated {
		t.Errorf("source=%q truncated=%v, want memory/true", source, truncated)
	}
	if len(recs) != 8 {
		t.Errorf("lite replay(10) = %d records, want 8", len(recs))
	}
}

func inTokensOf(recs []UsageRecord) []int {
	out := make([]int, len(recs))
	for i, r := range recs {
		out[i] = r.InTokens
	}
	return out
}
