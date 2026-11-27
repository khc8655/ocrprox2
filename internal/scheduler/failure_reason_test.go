package scheduler

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/types"
)

func TestClassifyFailure_Table(t *testing.T) {
	longCode := `{"error":{"type":"` + strings.Repeat("a", 100) + `"}}`

	tests := []struct {
		name     string
		status   int
		body     string
		kind     string
		wantRea  string
		wantType string
	}{
		// --- HTTP rules -----------------------------------------------------
		{"401 auth", 401, `{"error":{"type":"authentication_error","message":"Invalid API key"}}`, FailureKindHTTP, ReasonAuthInvalid, "authentication_error"},
		{"403 auth", 403, `{"error":{"code":"permission_denied"}}`, FailureKindHTTP, ReasonAuthInvalid, "permission_denied"},
		{"402 quota", 402, `{"error":{"message":"payment required"}}`, FailureKindHTTP, ReasonQuotaExhausted, ""},
		{"429 quota by type", 429, `{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}`, FailureKindHTTP, ReasonQuotaExhausted, "insufficient_quota"},
		{"429 quota by balance word", 429, `{"error":{"message":"Account balance is too low"}}`, FailureKindHTTP, ReasonQuotaExhausted, ""},
		{"429 quota by CJK", 429, `{"error":{"message":"账户余额不足，请充值"}}`, FailureKindHTTP, ReasonQuotaExhausted, ""},
		{"429 rate limit", 429, `{"error":{"message":"Rate limit reached for requests"}}`, FailureKindHTTP, ReasonRateLimited, ""},
		{"429 plain text", 429, `Too Many Requests`, FailureKindHTTP, ReasonRateLimited, ""},
		{"404 model", 404, `{"error":{"message":"The model gpt-5 does not exist"}}`, FailureKindHTTP, ReasonModelNotFound, ""},
		{"404 other", 404, `{"error":{"message":"route not found"}}`, FailureKindHTTP, ReasonUnknown, ""},
		{"400 context_length", 400, `{"error":{"code":"context_length_exceeded","message":"reduce the length"}}`, FailureKindHTTP, ReasonContextTooLong, "context_length_exceeded"},
		{"400 maximum context", 400, `{"error":{"message":"This model's maximum context length is 128000 tokens"}}`, FailureKindHTTP, ReasonContextTooLong, ""},
		{"400 other", 400, `{"error":{"message":"bad tool schema"}}`, FailureKindHTTP, ReasonUnknown, ""},
		{"500 upstream", 500, `{"error":{"type":"server_error","message":"boom"}}`, FailureKindHTTP, ReasonUpstreamError, "server_error"},
		{"503 plain text", 503, `service temporarily unavailable`, FailureKindHTTP, ReasonUpstreamError, ""},

		// --- non-HTTP kinds -------------------------------------------------
		{"network kind", 0, `dial tcp 10.0.0.1:443: connect: connection refused`, FailureKindNetwork, ReasonNetwork, ""},
		{"timeout kind", 0, `context deadline exceeded`, FailureKindTimeout, ReasonTimeout, ""},
		{"client abort kind", 0, `context canceled`, FailureKindClientAbort, ReasonClientDisconnected, ""},
		{"bad response kind", 200, `data: {"broken`, FailureKindBadResponse, ReasonBadResponse, ""},

		// --- errType extraction / normalization ------------------------------
		{"non-JSON body leaves errType empty", 500, `<html>502 Bad Gateway</html>`, FailureKindHTTP, ReasonUpstreamError, ""},
		{"truncated JSON leaves errType empty", 500, `{"error":{"type":"ser`, FailureKindHTTP, ReasonUpstreamError, ""},
		{"illegal chars sanitized", 500, `{"error":{"type":"Bad Type! <script>"}}`, FailureKindHTTP, ReasonUpstreamError, "badtypescript"},
		{"long errType truncated at 64", 500, longCode, FailureKindHTTP, ReasonUpstreamError, strings.Repeat("a", 64)},
		{"numeric code stringified", 400, `{"code":429,"message":"nope"}`, FailureKindHTTP, ReasonUnknown, "429"},
		{"top-level type fallback", 500, `{"type":"overloaded_error"}`, FailureKindHTTP, ReasonUpstreamError, "overloaded_error"},
		{"string error message code", 429, `{"error":"insufficient_quota: check your plan"}`, FailureKindHTTP, ReasonQuotaExhausted, "insufficient_quota"},
		{"unknown kind falls back to status", 401, `{"error":{"type":"x"}}`, "", ReasonAuthInvalid, "x"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reason, errType := ClassifyFailure(tc.status, []byte(tc.body), tc.kind)
			if reason != tc.wantRea {
				t.Errorf("reason = %q, want %q", reason, tc.wantRea)
			}
			if errType != tc.wantType {
				t.Errorf("errType = %q, want %q", errType, tc.wantType)
			}
		})
	}
}

func TestClassifyFailure_ReasonEnumIsClosedSet(t *testing.T) {
	// Guard the documented contract: every emitted reason must be one of the
	// twelve listed values (docs/ADMIN_UI_BACKEND_CONTRACT.md §5.2).
	allowed := map[string]bool{
		ReasonAuthInvalid: true, ReasonQuotaExhausted: true, ReasonRateLimited: true,
		ReasonModelNotFound: true, ReasonContextTooLong: true, ReasonUpstreamError: true,
		ReasonTimeout: true, ReasonNetwork: true, ReasonClientDisconnected: true,
		ReasonBadResponse: true, ReasonProtocolMismatch: true, ReasonUnknown: true,
	}
	if len(allowed) != 12 {
		t.Fatalf("reason enum must have exactly 12 values, got %d", len(allowed))
	}
	for _, status := range []int{0, 400, 401, 402, 403, 404, 409, 422, 429, 500, 502, 599, 200} {
		for _, kind := range []string{"", FailureKindHTTP, FailureKindNetwork, FailureKindTimeout, FailureKindClientAbort, FailureKindBadResponse} {
			if r, _ := ClassifyFailure(status, []byte(`{"error":{"type":"x"}}`), kind); !allowed[r] {
				t.Errorf("ClassifyFailure(%d, kind=%q) returned undocumented reason %q", status, kind, r)
			}
		}
	}
}

func TestCompressError(t *testing.T) {
	tests := []struct {
		name string
		in   string
		max  int
		want string
	}{
		{"trims surrounding whitespace", "  \n\t hello \r\n ", 0, "hello"},
		{"collapses whitespace runs", "a   b\n\n c\t\td", 0, "a b c d"},
		{"truncates to max characters", "abcdef", 3, "abc"},
		{"zero max uses default", strings.Repeat("x", 300), 0, strings.Repeat("x", DefaultErrorTextMax)},
		{"empty body is empty", "   \n ", 0, ""},
		{"CJK counted as characters", strings.Repeat("错", 300), 0, strings.Repeat("错", DefaultErrorTextMax)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := CompressError([]byte(tc.in), tc.max)
			if got != tc.want {
				t.Errorf("CompressError = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExtractRequestID(t *testing.T) {
	headerOf := func(kv ...string) http.Header {
		h := http.Header{}
		for i := 0; i+1 < len(kv); i += 2 {
			h.Set(kv[i], kv[i+1])
		}
		return h
	}

	tests := []struct {
		name   string
		header http.Header
		want   string
	}{
		{"nil header", nil, ""},
		{"empty header", http.Header{}, ""},
		{"x-request-id wins", headerOf(
			"x-request-id", "req-abc123",
			"request-id", "rid-2",
			"x-amzn-requestid", "amz-3",
			"x-ms-request-id", "ms-4",
			"cf-ray", "ray-5",
		), "reqabc123"},
		{"request-id second", headerOf("request-id", "rid-2", "x-amzn-requestid", "amz-3"), "rid2"},
		{"x-amzn-requestid third", headerOf("X-Amzn-RequestId", "amz-3", "cf-ray", "ray-5"), "amz3"},
		{"x-ms-request-id fourth", headerOf("x-ms-request-id", "ms-4", "cf-ray", "ray-5"), "ms4"},
		{"cf-ray last", headerOf("cf-ray", "8f2a-SJC"), "8f2asjc"},
		{"illegal chars removed", headerOf("x-request-id", `ab"c d/e!f`), "abcdef"},
		{"overlong truncated at 128", headerOf("x-request-id", strings.Repeat("z", 200)), strings.Repeat("z", 128)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ExtractRequestID(tc.header); got != tc.want {
				t.Errorf("ExtractRequestID = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestDispatch_LogsOneLineOnAuthFailure is the executable sample of the
// app.log failure line: one upstream 401 must produce exactly one line naming
// the reason, the machine code, the key, and the scrubbed upstream text.
func TestDispatch_LogsOneLineOnAuthFailure(t *testing.T) {
	const secret = "sk-test-1234567890"
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Authorization"), secret) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("X-Request-Id", "req_ABC-123")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"type":"authentication_error","message":"Incorrect API key provided: ` + secret + `"}}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "k1", Key: secret, Enabled: true},
				},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
				},
			},
		},
	}

	obsMgr, err := obs.NewManager(types.RoleLite, "")
	if err != nil {
		t.Fatalf("obs.NewManager: %v", err)
	}
	sched := NewScheduler(&mockConfigSource{config: cfg}, obsMgr, true)

	var logBuf bytes.Buffer
	prevWriter := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prevWriter)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o"}`))
	body := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	_ = sched.Dispatch(context.Background(), "/v1/chat/completions", body, "gpt-4o", false, rec, req)

	lines := strings.Split(strings.TrimSpace(logBuf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected exactly one app.log line, got %d:\n%s", len(lines), logBuf.String())
	}
	line := lines[0]

	for _, want := range []string{
		" model=gpt-4o ",
		" endpoint=/v1/chat/completions ",
		" status=401 ",
		" reason=auth_invalid ",
		" err_type=authentication_error ",
		" provider=p1 ",
		" key=k1 ",
		" tries=1 ",
		" ms=",
		"Incorrect API key provided: …",
	} {
		if !strings.Contains(line, want) {
			t.Errorf("log line missing %q: %s", want, line)
		}
	}
	if strings.Contains(line, "rid=") {
		t.Errorf("app.log line must use the fixed field list (no rid=): %s", line)
	}
	if strings.Contains(line, secret) {
		t.Fatalf("app.log line leaked the API key: %s", line)
	}
	// The trace (not the log line) carries the normalized upstream id.
	traces := obsMgr.RecentTraces(true)
	if len(traces) != 1 || len(traces[0].Tries) != 1 {
		t.Fatalf("expected one trace with one try, got %+v", traces)
	}
	try := traces[0].Tries[0]
	if try.Reason != ReasonAuthInvalid || try.ErrType != "authentication_error" {
		t.Errorf("trace try reason/errType = %q/%q", try.Reason, try.ErrType)
	}
	if try.RequestID != "req_abc123" {
		t.Errorf("trace try request id = %q, want req_abc123", try.RequestID)
	}
	if strings.Contains(try.Error, secret) {
		t.Errorf("trace try err leaked the key: %q", try.Error)
	}
	if try.ErrorSnippet == "" {
		t.Errorf("legacy ErrorSnippet must stay populated")
	}

	// Print the real line so `go test -v` shows the actual app.log sample.
	t.Logf("app.log sample: %s", line)
}

func TestDispatch_DoesNotLogCleanSuccess(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer ts.Close()

	cfg := &types.ProxyConfig{
		Providers: map[string]*types.ProviderConfig{
			"p1": {
				ID:      "p1",
				BaseURL: ts.URL,
				Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "k1", Label: "k1", Key: "key-1-abcdefgh", Enabled: true}},
			},
		},
		AgentModels: map[string]*types.AgentModelRoute{
			"gpt-4o": {
				Enabled: true,
				Candidates: []*types.RouteCandidate{
					{Provider: "p1", KeyLabel: "k1", Enabled: true},
				},
			},
		},
	}

	obsMgr, _ := obs.NewManager(types.RoleLite, "")
	sched := NewScheduler(&mockConfigSource{config: cfg}, obsMgr, true)

	var logBuf bytes.Buffer
	prevWriter := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prevWriter)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o"}`))
	body := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	if err := sched.Dispatch(context.Background(), "/v1/chat/completions", body, "gpt-4o", false, rec, req); err != nil {
		t.Fatalf("Dispatch error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := strings.TrimSpace(logBuf.String()); got != "" {
		t.Fatalf("clean single-attempt success must not write app.log, got: %s", got)
	}
}

// A key that times out is a timeout, not a network error: the operator action
// differs (raise the first-byte budget vs. check connectivity).
func TestClassifyTransportError(t *testing.T) {
	deadline, cancelDeadline := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelDeadline()
	canceled, cancel := context.WithCancel(context.Background())
	cancel()

	if got := classifyTransportError(deadline.Err(), deadline); got != FailureKindTimeout {
		t.Errorf("deadline = %q, want %q", got, FailureKindTimeout)
	}
	if got := classifyTransportError(canceled.Err(), canceled); got != FailureKindClientAbort {
		t.Errorf("canceled = %q, want %q", got, FailureKindClientAbort)
	}
	if got := classifyTransportError(&fakeTimeoutErr{}, context.Background()); got != FailureKindTimeout {
		t.Errorf("net timeout = %q, want %q", got, FailureKindTimeout)
	}
	if got := classifyTransportError(context.DeadlineExceeded, context.Background()); got != FailureKindTimeout {
		t.Errorf("wrapped deadline = %q, want %q", got, FailureKindTimeout)
	}

	if got := classifyPeekError(ErrFirstByteTimeout, context.Background()); got != FailureKindTimeout {
		t.Errorf("first-byte timeout = %q, want %q", got, FailureKindTimeout)
	}
	if got := classifyPeekError(ErrEmptyStream, context.Background()); got != FailureKindBadResponse {
		t.Errorf("empty stream = %q, want %q", got, FailureKindBadResponse)
	}
}

type fakeTimeoutErr struct{}

func (e *fakeTimeoutErr) Error() string   { return "i/o timeout" }
func (e *fakeTimeoutErr) Timeout() bool   { return true }
func (e *fakeTimeoutErr) Temporary() bool { return true }

// A 429 whose body names RPS/RPM/TPM throttling must classify as rate_limited
// even when the provider labels the error type quota-ish. SenseNova does exactly
// that ("quota_exceeded_error" + "rps exhausted"); reading it as an exhausted
// balance used to cool every key down until the next daily reset, taking the
// whole provider off-line after one busy minute (2026-11-27).
func TestClassifyFailure_ThrottleBeatsQuotaMarker(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"sensenova rps exhausted", `{"error":{"message":"rps exhausted","type":"quota_exceeded_error","code":"8"}}`},
		{"sensenova tpm/rpm limit", `{"error":{"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"8"}}`},
		{"amd model concurrency", `{"detail":{"error":{"message":"Model 'GLM-5.3-Flash' is at capacity; you can also use another model. Please retry in 7 seconds.","type":"rate_limit_error"}}}`},
	}
	for _, tc := range cases {
		reason, _ := ClassifyFailure(429, []byte(tc.body), FailureKindHTTP)
		if reason != ReasonRateLimited {
			t.Errorf("%s: want %s, got %s (body %s)", tc.name, ReasonRateLimited, reason, tc.body)
		}
	}

	// A genuine balance/quota exhaustion still classifies as quota_exhausted.
	reason, _ := ClassifyFailure(429, []byte(`{"error":{"type":"insufficient_quota","message":"You exceeded your current quota, please check your plan"}}`), FailureKindHTTP)
	if reason != ReasonQuotaExhausted {
		t.Errorf("insufficient_quota: want %s, got %s", ReasonQuotaExhausted, reason)
	}
}
