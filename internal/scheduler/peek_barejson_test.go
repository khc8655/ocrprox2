package scheduler

import (
	"context"
	"io"
	"strings"
	"testing"
)

// An upstream that ignores stream=true answers with one JSON object and closes the
// body. Peek must flag it so the scheduler can synthesize SSE for the client.
func TestPeekFirstChunk_DetectsBareJSON(t *testing.T) {
	body := `{"id":"x","object":"chat.completion","choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}`
	res, err := PeekFirstChunk(context.Background(), strings.NewReader(body), 0, 0, nil)
	if err != nil {
		t.Fatalf("peek returned error: %v", err)
	}
	if !res.BareJSONPayload {
		t.Fatalf("expected BareJSONPayload=true for a plain completion body")
	}
	if res.IsError {
		t.Fatalf("bare JSON payload is not a stream error")
	}
	rest, _ := io.ReadAll(res.CombinedBody)
	if len(rest) == 0 {
		t.Fatalf("combined body must still deliver the payload")
	}
}

// A genuine SSE stream must NOT be treated as bare JSON.
func TestPeekFirstChunk_RealSSENotBareJSON(t *testing.T) {
	stream := "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"
	res, err := PeekFirstChunk(context.Background(), strings.NewReader(stream), 0, 0, nil)
	if err != nil {
		t.Fatalf("peek returned error: %v", err)
	}
	if res.BareJSONPayload {
		t.Fatalf("real SSE must not be flagged as bare JSON")
	}
}

func TestLooksLikeBareJSON(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"object", `{"id":"a"}`, true},
		{"sse frame", "data: {\"id\":\"a\"}\n\n", false},
		{"array", `[1,2]`, false},
		{"empty", ``, false},
		{"multi line sse", "event: x\ndata: {}\n\n", false},
	}
	for _, tc := range cases {
		if got := looksLikeBareJSON([]byte(tc.in)); got != tc.want {
			t.Fatalf("%s: looksLikeBareJSON=%v want %v", tc.name, got, tc.want)
		}
	}
}
