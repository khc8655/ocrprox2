package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

type recentRequestsResponse struct {
	OK        bool              `json:"ok"`
	Requests  []obs.UsageRecord `json:"requests"`
	Source    string            `json:"source"`
	Truncated bool              `json:"truncated"`
}

func newRecentRequestsServer(t *testing.T, sink types.ObservabilitySink) (*Server, *http.ServeMux) {
	t.Helper()
	tmpDir := t.TempDir()
	authMgr := auth.NewAuthenticator("client-k", "admin-pass")
	localSrc, err := config.NewLocalSource(tmpDir, "pass")
	if err != nil {
		t.Fatalf("localSrc: %v", err)
	}
	sched := scheduler.NewScheduler(localSrc, sink, true)
	srv := NewServer(authMgr, localSrc, sink, sched)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)
	return srv, mux
}

func getRecentRequests(t *testing.T, mux *http.ServeMux, query string, authorized bool) (int, []byte, recentRequestsResponse) {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/admin/recent-requests"+query, nil)
	if authorized {
		req.Header.Set("Authorization", "Bearer admin-pass")
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var parsed recentRequestsResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	return rec.Code, rec.Body.Bytes(), parsed
}

func requestTrace(ordinal int, ts int64) types.RequestTrace {
	return types.RequestTrace{
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

func TestRecentRequestsEndpoint_RequiresAuth(t *testing.T) {
	obsMgr, err := obs.NewManager(types.RoleFull, t.TempDir())
	if err != nil {
		t.Fatalf("obs.NewManager: %v", err)
	}
	defer obsMgr.Close()
	obsMgr.RecordRequest(requestTrace(1, time.Now().Unix()))

	_, mux := newRecentRequestsServer(t, obsMgr)

	code, _, _ := getRecentRequests(t, mux, "", false)
	if code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET status = %d, want 401", code)
	}
}

func TestRecentRequestsEndpoint_ReturnsLast50FromLedger(t *testing.T) {
	obsMgr, err := obs.NewManager(types.RoleFull, t.TempDir())
	if err != nil {
		t.Fatalf("obs.NewManager: %v", err)
	}
	defer obsMgr.Close()

	now := time.Now().Unix()
	for i := 0; i < 120; i++ {
		obsMgr.RecordRequest(requestTrace(i, now+int64(i)))
	}
	if err := obsMgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	_, mux := newRecentRequestsServer(t, obsMgr)

	code, body, resp := getRecentRequests(t, mux, "", true)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", code, body)
	}
	if !resp.OK {
		t.Errorf("ok = false, body=%s", body)
	}
	if resp.Source != "ledger" {
		t.Errorf("source = %q, want ledger", resp.Source)
	}
	if resp.Truncated {
		t.Errorf("truncated = true, want false (120 records on disk)")
	}
	if len(resp.Requests) != 50 {
		t.Fatalf("len(requests) = %d, want 50", len(resp.Requests))
	}
	if resp.Requests[0].InTokens != 70 || resp.Requests[49].InTokens != 119 {
		t.Errorf("window = %d..%d, want 70..119 (oldest first)",
			resp.Requests[0].InTokens, resp.Requests[49].InTokens)
	}
	for i := 1; i < len(resp.Requests); i++ {
		if resp.Requests[i].Timestamp <= resp.Requests[i-1].Timestamp {
			t.Fatalf("records are not oldest-first at %d", i)
		}
	}
	// Compact sample of the wire format (the default 50-record body is huge).
	sampleCode, sampleBody, _ := getRecentRequests(t, mux, "?limit=2", true)
	t.Logf("GET /api/admin/recent-requests?limit=2 -> %d %s", sampleCode, sampleBody)

	// limit=200 asks for more than exists: everything comes back, truncated.
	code, body, resp = getRecentRequests(t, mux, "?limit=200", true)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", code, body)
	}
	if len(resp.Requests) != 120 || !resp.Truncated {
		t.Errorf("limit=200: %d records truncated=%v, want 120/true", len(resp.Requests), resp.Truncated)
	}

	// Invalid and out-of-range values fall back to the default 50.
	for _, q := range []string{"?limit=abc", "?limit=0", "?limit=-3", "?limit=201", "?limit=100000"} {
		code, body, resp = getRecentRequests(t, mux, q, true)
		if code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200; body=%s", q, code, body)
		}
		if len(resp.Requests) != 50 {
			t.Errorf("%s: %d records, want default 50", q, len(resp.Requests))
		}
	}
}

func TestRecentRequestsEndpoint_FailedFilter(t *testing.T) {
	obsMgr, err := obs.NewManager(types.RoleFull, t.TempDir())
	if err != nil {
		t.Fatalf("obs.NewManager: %v", err)
	}
	defer obsMgr.Close()

	now := time.Now().Unix()
	// Failures first, then a long run of successes: the filter must walk past
	// the successes to find the older failures.
	failures := []types.RequestTrace{
		{Status: 500, Tries: []types.Try{{Attempt: 1, Status: 500}}},
		{Status: 429, Tries: []types.Try{{Attempt: 1, Status: 429}}},
		{Status: 0, Tries: []types.Try{{Attempt: 1, Status: 0}}},                   // client disconnect
		{Status: 502, Tries: []types.Try{{Attempt: 1, Status: 502}}},               // gateway error
		{Status: 200, Tries: []types.Try{{Attempt: 1, Status: 500}, {Attempt: 2}}}, // succeeded after failover
	}
	for i, tr := range failures {
		tr.Timestamp = now - 1000 + int64(i)
		tr.Mode = "agent"
		tr.Endpoint = "/v1/chat/completions"
		tr.ReqModel = "gpt-4o"
		tr.TotalMillis = 10
		obsMgr.RecordRequest(tr)
	}
	for i := 0; i < 120; i++ {
		obsMgr.RecordRequest(requestTrace(1000+i, now+int64(i)))
	}
	if err := obsMgr.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	_, mux := newRecentRequestsServer(t, obsMgr)

	code, body, resp := getRecentRequests(t, mux, "?failed=1", true)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", code, body)
	}
	if len(resp.Requests) != len(failures) {
		t.Fatalf("failed=1 returned %d records, want %d; body=%s", len(resp.Requests), len(failures), body)
	}
	if !resp.Truncated {
		t.Errorf("truncated = false, want true (only %d failures exist)", len(failures))
	}
	for i, r := range resp.Requests {
		if !(r.Status >= 400 || r.Status == 0 || r.Tries > 1) {
			t.Errorf("record %d does not match the failed filter: %+v", i, r)
		}
	}
	// Oldest first: the client disconnect (status 0) is our third failure.
	if resp.Requests[2].Status != 0 {
		t.Errorf("oldest-first order broken: requests[2].status = %d, want 0", resp.Requests[2].Status)
	}

	// Without the filter the newest 50 are all successes.
	_, _, resp = getRecentRequests(t, mux, "", true)
	if len(resp.Requests) != 50 || resp.Truncated {
		t.Errorf("unfiltered: %d records truncated=%v, want 50/false", len(resp.Requests), resp.Truncated)
	}
}

// A sink without a replay store (e.g. the lite usage counter) still answers
// with a well-formed, empty payload rather than a 404/null.
type bareSink struct{}

func (bareSink) RecordRequest(types.RequestTrace)                  {}
func (bareSink) RecentTraces(bool) []types.RequestTrace            { return nil }
func (bareSink) QueryUsage(string, string) (map[string]any, error) { return nil, nil }

func TestRecentRequestsEndpoint_NoReplayStore(t *testing.T) {
	_, mux := newRecentRequestsServer(t, bareSink{})
	code, body, resp := getRecentRequests(t, mux, "", true)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", code, body)
	}
	if resp.Requests == nil {
		t.Errorf("requests must be [] not null; body=%s", body)
	}
	if len(resp.Requests) != 0 || resp.Source != "memory" || !resp.Truncated {
		t.Errorf("got %d records source=%q truncated=%v; want 0/memory/true", len(resp.Requests), resp.Source, resp.Truncated)
	}
}

// Lite managers keep records in memory only; the endpoint reports that source.
func TestRecentRequestsEndpoint_LiteMemorySource(t *testing.T) {
	obsMgr, err := obs.NewManager(types.RoleLite, "")
	if err != nil {
		t.Fatalf("obs.NewManager: %v", err)
	}
	defer obsMgr.Close()
	now := time.Now().Unix()
	for i := 0; i < 3; i++ {
		obsMgr.RecordRequest(requestTrace(i, now+int64(i)))
	}

	_, mux := newRecentRequestsServer(t, obsMgr)
	code, body, resp := getRecentRequests(t, mux, "?limit=2", true)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", code, body)
	}
	if resp.Source != "memory" {
		t.Errorf("source = %q, want memory", resp.Source)
	}
	if len(resp.Requests) != 2 || resp.Requests[1].InTokens != 2 {
		t.Errorf("lite replay = %v, want last 2 (ordinals 1,2)", inTokensOfAdmin(resp.Requests))
	}
}

func inTokensOfAdmin(recs []obs.UsageRecord) []int {
	out := make([]int, len(recs))
	for i, r := range recs {
		out[i] = r.InTokens
	}
	return out
}
