package scheduler

// Failure taxonomy for one upstream attempt. The coarse buckets this replaces
// (auth_error / rate_limit / server_error / client_error / network_error) could
// not answer "why did it fail": a 429 for exhausted balance and a 429 for RPM
// throttling are both cooldowns but different operator actions. The normalized
// reason below is what traces, the usage ledger, and app.log all carry.
//
// Design notes live in docs/ADMIN_UI_BACKEND_CONTRACT.md §5.2. Independent
// implementation; no magpie gateway code is ported (see CLAUDE.md red lines).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"unicode"

	"github.com/khc8655/llmproxy2/internal/obs"
)

// Normalized failure reasons. This is a closed set: every Try.Reason,
// TryFailure.reason and app.log reason= value must be one of these strings.
const (
	ReasonAuthInvalid        = "auth_invalid"        // 401/403: key rejected or not allowed to use the model
	ReasonQuotaExhausted     = "quota_exhausted"     // 402, or 429 whose body names a balance/credit/quota exhaustion
	ReasonRateLimited        = "rate_limited"        // 429 caused by RPM/burst throttling
	ReasonModelNotFound      = "model_not_found"     // 404 whose body mentions the model
	ReasonContextTooLong     = "context_too_long"    // 400 whose body names context_length / max_tokens overflow
	ReasonUpstreamError      = "upstream_error"      // 5xx
	ReasonTimeout            = "timeout"             // first-byte timeout or total-budget deadline
	ReasonNetwork            = "network"             // dial / DNS / TLS / SSRF refusal
	ReasonClientDisconnected = "client_disconnected" // the caller went away mid-request
	ReasonBadResponse        = "bad_response"        // upstream 200 whose body is an unusable stream/JSON
	ReasonProtocolMismatch   = "protocol_mismatch"   // client dialect no candidate speaks (rejected before dialing)
	ReasonNoCandidate        = "no_candidate"        // every candidate skipped locally: cooling down, RPM-capped, disabled
	ReasonConfigUnavailable  = "config_unavailable"  // no usable configuration yet (not initialized / lease expired)
	ReasonUnknown            = "unknown"             // any other 4xx, or a failure we cannot name
)

// Failure kinds accepted by ClassifyFailure.
const (
	FailureKindHTTP        = "http"
	FailureKindNetwork     = "network"
	FailureKindTimeout     = "timeout"
	FailureKindClientAbort = "client_abort"
	FailureKindBadResponse = "bad_response"
)

const (
	// DefaultErrorTextMax is the character budget (runes) for Try.Error after
	// CompressError collapses whitespace: enough for an upstream sentence, small
	// enough that a 60-trace ring buffer and one app.log line stay readable.
	DefaultErrorTextMax = 280
	maxErrTypeLen       = 64
	maxRequestIDLen     = 128
)

// ClassifyFailure maps one failed attempt onto the normalized reason enum plus
// the upstream's own machine-readable error code (errType).
//
// status is the HTTP status the attempt failed as (0 when no response existed).
// errBody is the upstream body (or the transport error text for non-HTTP kinds);
// only the first bytes matter. kind is one of FailureKind*; "http" means a real
// response with a status code.
func ClassifyFailure(status int, errBody []byte, kind string) (reason, errType string) {
	errType = normalizeToken(extractErrType(errBody), maxErrTypeLen)

	switch kind {
	case FailureKindNetwork:
		return ReasonNetwork, errType
	case FailureKindTimeout:
		return ReasonTimeout, errType
	case FailureKindClientAbort:
		return ReasonClientDisconnected, errType
	case FailureKindBadResponse:
		return ReasonBadResponse, errType
	}

	// "http" and any unrecognized kind: fall back to status-based rules so a
	// caller that forgets the kind still gets a useful bucket.
	return classifyHTTPStatus(status, errBody), errType
}

func classifyHTTPStatus(status int, errBody []byte) string {
	body := strings.ToLower(string(errBody))
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return ReasonAuthInvalid
	case status == http.StatusPaymentRequired:
		return ReasonQuotaExhausted
	case status == http.StatusTooManyRequests:
		// 429 is overloaded: providers use it for both throttling and an empty
		// account. The body is the only signal that separates them, and the
		// distinction decides whether an operator raises RPM limits or tops up.
		//
		// Throttling markers win over quota markers: providers name the error
		// type "quota_exceeded_error" while the message says "rps exhausted"
		// (SenseNova, observed 2026-11-27). Reading that as an exhausted balance
		// would park every key until the daily reset on a plain rate limit.
		if containsAny(body, "rps", "rpm", "tpm", "rate limit", "ratelimit", "too many requests",
			"concurrency", "throttl", "capacity", "retry in", "retry after", "限流", "请稍后重试") {
			return ReasonRateLimited
		}
		if containsAny(body, "insufficient_quota", "quota", "balance", "credit", "billing", "余额", "欠费") {
			return ReasonQuotaExhausted
		}
		return ReasonRateLimited
	case status == http.StatusNotFound && strings.Contains(body, "model"):
		return ReasonModelNotFound
	case status == http.StatusBadRequest && containsAny(body,
		"context_length", "context length", "too long", "max_tokens", "maximum context"):
		return ReasonContextTooLong
	case status >= 500 && status <= 599:
		return ReasonUpstreamError
	case status >= 400 && status < 500:
		return ReasonUnknown
	default:
		return ReasonUnknown
	}
}

func containsAny(haystack string, needles ...string) bool {
	for _, n := range needles {
		if strings.Contains(haystack, n) {
			return true
		}
	}
	return false
}

// extractErrType pulls the upstream's machine-readable code out of an error
// body, trying the common shapes in order: error.type, error.code, type, code,
// then a machine-code token at the head of error.message. Numeric codes are
// stringified. Anything that is not a JSON object yields "".
func extractErrType(body []byte) string {
	b := bytes.TrimSpace(body)
	if len(b) == 0 || b[0] != '{' {
		return ""
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(b, &root) != nil {
		return ""
	}

	if rawErr, ok := root["error"]; ok {
		var obj map[string]json.RawMessage
		if json.Unmarshal(rawErr, &obj) == nil {
			for _, key := range []string{"type", "code"} {
				if v := jsonScalar(obj[key]); v != "" {
					return v
				}
			}
			var msg string
			if json.Unmarshal(obj["message"], &msg) == nil {
				if v := leadingMachineCode(msg); v != "" {
					return v
				}
			}
		} else {
			var s string
			if json.Unmarshal(rawErr, &s) == nil {
				if v := leadingMachineCode(s); v != "" {
					return v
				}
			}
		}
	}

	for _, key := range []string{"type", "code"} {
		if v := jsonScalar(root[key]); v != "" {
			return v
		}
	}
	return ""
}

// jsonScalar renders a JSON string or number as a code; null/bool/objects are "".
func jsonScalar(raw json.RawMessage) string {
	b := bytes.TrimSpace(raw)
	if len(b) == 0 {
		return ""
	}
	switch b[0] {
	case '"':
		var s string
		if json.Unmarshal(b, &s) == nil {
			return strings.TrimSpace(s)
		}
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return string(b)
	}
	return ""
}

// leadingMachineCode returns the first token of a message when it looks like a
// machine code rather than prose: "insufficient_quota: ..." -> "insufficient_quota".
// Requiring an underscore keeps "Rate limit exceeded" from becoming "Rate".
func leadingMachineCode(msg string) string {
	msg = strings.TrimSpace(msg)
	if msg == "" {
		return ""
	}
	i := 0
	for i < len(msg) && (isASCIIAlnum(msg[i]) || msg[i] == '_') {
		i++
	}
	if i == 0 {
		return ""
	}
	tok := msg[:i]
	if !strings.Contains(tok, "_") {
		return ""
	}
	rest := strings.TrimSpace(msg[i:])
	if rest != "" && rest[0] != ':' && rest[0] != '-' && rest[0] != '(' {
		return ""
	}
	return tok
}

func isASCIIAlnum(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

// normalizeToken lowercases a token and keeps only [a-z0-9_], so a value taken
// from an upstream cannot smuggle log delimiters or quotes into app.log. The
// result is capped at max bytes (the alphabet is ASCII, so bytes == runes).
func normalizeToken(s string, max int) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if max > 0 && len(out) > max {
		out = out[:max]
	}
	return out
}

// requestIDHeaders is the lookup order for the upstream correlation id.
var requestIDHeaders = []string{
	"x-request-id",
	"request-id",
	"x-amzn-requestid",
	"x-ms-request-id",
	"cf-ray",
}

// ExtractRequestID returns the first present upstream request id, normalized
// like errType (lowercase [a-z0-9_], max 128). Empty when the upstream sent none.
func ExtractRequestID(header http.Header) string {
	if header == nil {
		return ""
	}
	for _, name := range requestIDHeaders {
		if v := strings.TrimSpace(header.Get(name)); v != "" {
			return normalizeToken(v, maxRequestIDLen)
		}
	}
	return ""
}

// CompressError turns an upstream body (or error string) into one short line:
// surrounding whitespace trimmed, every run of whitespace collapsed to a single
// space, then cut to max characters (runes; <=0 means DefaultErrorTextMax).
// Callers must still pass the result through obs.ScrubStringWithSecrets.
func CompressError(b []byte, max int) string {
	if max <= 0 {
		max = DefaultErrorTextMax
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return ""
	}

	var sb strings.Builder
	sb.Grow(len(s))
	pendingSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			pendingSpace = sb.Len() > 0
			continue
		}
		if pendingSpace {
			sb.WriteByte(' ')
			pendingSpace = false
		}
		sb.WriteRune(r)
	}

	runes := []rune(sb.String())
	if len(runes) > max {
		runes = runes[:max]
	}
	return strings.TrimSpace(string(runes))
}

// classifyTransportError buckets a client.Do / stream-read error: a canceled
// client context is the caller leaving, a deadline is a timeout, everything else
// is a network fault.
func classifyTransportError(err error, clientCtx context.Context) string {
	if errors.Is(err, context.Canceled) || (clientCtx != nil && errors.Is(clientCtx.Err(), context.Canceled)) {
		return FailureKindClientAbort
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return FailureKindTimeout
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return FailureKindTimeout
	}
	return FailureKindNetwork
}

// classifyPeekError buckets a stream-peek failure. A broken/empty SSE frame is
// bad_response; the first-byte deadline (or the total budget) is timeout; the
// caller leaving is client_disconnected.
func classifyPeekError(peekErr error, clientCtx context.Context) string {
	switch {
	case errors.Is(peekErr, context.Canceled),
		clientCtx != nil && errors.Is(clientCtx.Err(), context.Canceled):
		return FailureKindClientAbort
	case errors.Is(peekErr, ErrFirstByteTimeout), errors.Is(peekErr, context.DeadlineExceeded):
		return FailureKindTimeout
	default:
		return FailureKindBadResponse
	}
}

// compressErrorText is CompressError + the mandatory secret scrub, the two
// steps every persisted error string must pass.
func compressErrorText(raw string, usedSecrets []string) string {
	return obs.ScrubStringWithSecrets(CompressError([]byte(raw), DefaultErrorTextMax), usedSecrets...)
}

// logField renders one structured field of the app.log failure line: empty
// values become "-", whitespace/control characters become "_" so a model name
// or endpoint supplied by the caller can never forge an extra log line, and
// the value is capped at max runes.
func logField(s string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "-"
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			b.WriteByte('_')
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	if max > 0 {
		runes := []rune(out)
		if len(runes) > max {
			out = string(runes[:max])
		}
	}
	if out == "" {
		return "-"
	}
	return out
}
