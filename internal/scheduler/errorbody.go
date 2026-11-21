package scheduler

import (
	"bytes"
	"encoding/json"
	"strings"
)

// errInSuccessBody reports whether a 200 response body is really an error the
// request should fail over on, and the status the body names for itself.
//
// Some upstreams send their error under HTTP 200: a relay that ends an
// OpenAI-compatible stream with a frame, a plugin that answers
// {"error":{...}} after its headers are out, Gemini-style relays that put a
// numeric code and a message at the top level. Read as the 200 it came with,
// such a body would be counted as a success and handed to the caller — for a
// knowledge-base ingestion that means an error object stored as if it were the
// answer. Magpie's internal/gateway/routing.go `carriedStatus` and fallback.go
// `namedStatus` read the same shapes, so the body fails as the error it names and
// the next candidate is asked. That is behaviour alignment, not a port: see
// docs/MAGPIE_UPSTREAM_SYNC.md §3.4.
//
// Only JSON objects are inspected, and only top-level fields: a successful
// reply that mentions "error" inside its content is left alone.
func errInSuccessBody(body []byte) (status int, snippet string, isErr bool) {
	b := bytes.TrimSpace(body)
	if len(b) == 0 || b[0] != '{' {
		return 0, "", false
	}

	var v struct {
		Error   json.RawMessage `json:"error"`
		Type    json.RawMessage `json:"type"`
		Code    json.RawMessage `json:"code"`
		Message string          `json:"message"`
		Status  string          `json:"status"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return 0, "", false
	}

	msg := ""
	switch {
	case carriesError(v.Error):
		status = namedStatusOf(v.Error)
		msg = string(v.Error)
	case jsonString(v.Type) == "error":
		msg = v.Message
	case (v.Status == "error" || v.Status == "failed") && v.Message != "":
		msg = v.Message
	case len(v.Code) > 0 && v.Message != "" && topLevelStatus(v.Code) > 0:
		status = topLevelStatus(v.Code)
		msg = v.Message
	default:
		return 0, "", false
	}

	if status < 400 || status > 599 {
		status = 502
	}
	if msg == "" {
		msg = v.Message
	}
	if msg == "" {
		msg = string(b)
	}
	if len(msg) > 512 {
		msg = msg[:512]
	}
	return status, msg, true
}

// carriesError says an "error" member holds an error rather than the null a
// successful reply often carries.
func carriesError(raw json.RawMessage) bool {
	b := bytes.TrimSpace(raw)
	if len(b) == 0 {
		return false
	}
	switch string(b) {
	case "null", `""`, "{}", "[]", "false", "0":
		return false
	}
	return true
}

// namedStatusOf is the HTTP status an error object names for itself: a numeric
// 400–599 on its code or status, as Gemini's relays carry it. A string code is
// an identifier, not a status.
func namedStatusOf(raw json.RawMessage) int {
	b := bytes.TrimSpace(raw)
	if len(b) == 0 || b[0] != '{' {
		return 0
	}
	var e struct {
		Code   json.RawMessage `json:"code"`
		Status json.RawMessage `json:"status"`
	}
	if json.Unmarshal(b, &e) != nil {
		return 0
	}
	for _, cand := range []json.RawMessage{e.Code, e.Status} {
		n, ok := jsonInt(cand)
		if ok && n >= 400 && n <= 599 {
			return int(n)
		}
	}
	return 0
}

// topLevelStatus reads a numeric HTTP status sitting directly on the object, as
// Gemini's relays put it next to the message.
func topLevelStatus(raw json.RawMessage) int {
	if n, ok := jsonInt(raw); ok && n >= 400 && n <= 599 {
		return int(n)
	}
	return 0
}

// jsonString reads a JSON string, "" for anything else.
func jsonString(raw json.RawMessage) string {
	b := bytes.TrimSpace(raw)
	if len(b) < 2 || b[0] != '"' {
		return ""
	}
	var s string
	if json.Unmarshal(b, &s) != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

// jsonInt reads a JSON number, false for anything else.
func jsonInt(raw json.RawMessage) (int64, bool) {
	b := bytes.TrimSpace(raw)
	if len(b) == 0 || (b[0] != '-' && (b[0] < '0' || b[0] > '9')) {
		return 0, false
	}
	var n int64
	if json.Unmarshal(b, &n) != nil {
		return 0, false
	}
	return n, true
}
