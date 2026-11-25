package scheduler

// Regressions for "the console cannot explain a failure":
//   - a model that is not configured (404) used to exist only in app.log,
//     never in the trace ring or the usage ledger;
//   - a route with no enabled candidate (503) and the all-keys-cooling-down
//     case (502) used to record tries=0 with no reason at all;
//   - the app.log line for a successful failover described the LAST attempt
//     (the one that succeeded) and therefore printed reason=-.

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestDispatch_ModelNotFoundIsRecorded(t *testing.T) {
	cfg := &types.ProxyConfig{
		Providers:   map[string]*types.ProviderConfig{},
		AgentModels: map[string]*types.AgentModelRoute{},
	}
	sink := &mockObsSink{}
	s := NewScheduler(&mockConfigSource{config: cfg}, sink, true)

	body := []byte(`{"model":"nope","messages":[{"role":"user","content":"hi"}]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	if err := s.Dispatch(context.Background(), "/v1/chat/completions", body, "nope", false, rec, req); err == nil {
		t.Fatal("expected an error for an unconfigured model")
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}

	traces := sink.RecentTraces(false)
	if len(traces) != 1 {
		t.Fatalf("expected exactly 1 recorded trace, got %d", len(traces))
	}
	tr := traces[0]
	if tr.Status != http.StatusNotFound {
		t.Fatalf("trace status = %d, want 404", tr.Status)
	}
	if len(tr.Tries) != 1 || tr.Tries[0].Reason != ReasonModelNotFound {
		t.Fatalf("trace should carry one synthetic try with reason %q, got %+v", ReasonModelNotFound, tr.Tries)
	}
	if tr.ReqModel != "nope" {
		t.Fatalf("trace req model = %q, want nope", tr.ReqModel)
	}
}

func TestDispatch_NoCandidateIsRecorded(t *testing.T) {
	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID: "p1", BaseURL: "http://127.0.0.1:1", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-1", Enabled: false}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"m": {Enabled: true, Candidates: []*types.RouteCandidate{
				{Provider: "p1", KeyLabel: "k1", TargetModel: "x", Enabled: false},
			}},
		},
	}
	sink := &mockObsSink{}
	s := NewScheduler(&mockConfigSource{config: cfg}, sink, true)

	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	if err := s.Dispatch(context.Background(), "/v1/chat/completions", body, "m", false, rec, req); err == nil {
		t.Fatal("expected an error when every candidate is disabled")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", rec.Code, rec.Body.String())
	}

	traces := sink.RecentTraces(false)
	if len(traces) != 1 {
		t.Fatalf("expected exactly 1 recorded trace, got %d", len(traces))
	}
	tries := traces[0].Tries
	if len(tries) == 0 || tries[0].Reason == "" {
		t.Fatalf("a locally rejected request must still name a reason, got %+v", tries)
	}
}

func TestDispatch_AllKeysCoolingDownCarriesNoCandidate(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom","type":"server_error"}}`))
	}))
	defer upstream.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID: "p1", BaseURL: upstream.URL, Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "sk-1", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"m": {Enabled: true, Candidates: []*types.RouteCandidate{
				{Provider: "p1", KeyLabel: "k1", TargetModel: "x", Enabled: true},
			}},
		},
	}
	sink := &mockObsSink{}
	s := NewScheduler(&mockConfigSource{config: cfg}, sink, true)

	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
	send := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		_ = s.Dispatch(context.Background(), "/v1/chat/completions", body, "m", false, rec, req)
		return rec
	}

	if rec := send(); rec.Code < 400 {
		t.Fatalf("first attempt should surface the upstream failure, got %d", rec.Code)
	}
	// The key is now cooling down, so the second request is rejected locally
	// with 502 (the all-candidates-failed status).
	if rec := send(); rec.Code != http.StatusBadGateway {
		t.Fatalf("second attempt should be 502 (cooling down), got %d: %s", rec.Code, rec.Body.String())
	}

	traces := sink.RecentTraces(false)
	if len(traces) != 2 {
		t.Fatalf("expected 2 traces, got %d", len(traces))
	}
	second := traces[1]
	if len(second.Tries) == 0 {
		t.Fatal("the cooling-down rejection must carry a synthetic try so the console can explain it")
	}
	if got := second.Tries[len(second.Tries)-1].Reason; got != ReasonNoCandidate {
		t.Fatalf("reason = %q, want %q", got, ReasonNoCandidate)
	}
}

func TestLogDispatchOutcome_DescribesLastFailureNotLastAttempt(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	s := &Scheduler{}
	s.logDispatchOutcome(
		"req-1", "flaky", "/v1/chat/completions",
		http.StatusOK,
		[]types.Try{
			{Attempt: 1, Provider: "mockfail", KeyID: "k-fail", Status: http.StatusInternalServerError, Reason: ReasonUpstreamError, ErrType: "server_error", Error: "boom"},
			{Attempt: 2, Provider: "mocka", KeyID: "k-ok", Status: http.StatusOK},
		},
		3, nil, "", nil,
	)

	line := buf.String()
	if !strings.Contains(line, "reason=upstream_error") {
		t.Fatalf("failover log line must name the failure reason, got %q", line)
	}
	if !strings.Contains(line, "err_type=server_error") {
		t.Fatalf("failover log line must name the upstream err_type, got %q", line)
	}
	if !strings.Contains(line, "recovered_by=mocka/k-ok") {
		t.Fatalf("failover log line must say who rescued the request, got %q", line)
	}
}
