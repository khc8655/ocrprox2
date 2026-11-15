package upstream

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestJoinUpstream(t *testing.T) {
	tests := []struct {
		baseURL  string
		path     string
		expected string
	}{
		{"https://api.openai.com", "chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1", "chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1/", "/chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://custom.endpoint.com/endpoints/openapi", "models", "https://custom.endpoint.com/endpoints/openapi/models"},
		{"https://generativelanguage.googleapis.com/v1beta/openai", "chat/completions", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"},
		{"https://api.openai.com/v1", "/v1/chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.stepfun.com/step_plan/v1", "/v1/chat/completions", "https://api.stepfun.com/step_plan/v1/chat/completions"},
		{"https://generativelanguage.googleapis.com/v1beta/openai", "/v1/chat/completions", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"},
		{"https://api.openai.com", "/v1/responses", "https://api.openai.com/v1/responses"},
	}

	for _, tc := range tests {
		got := JoinUpstream(tc.baseURL, tc.path)
		if got != tc.expected {
			t.Errorf("JoinUpstream(%q, %q) = %q, want %q", tc.baseURL, tc.path, got, tc.expected)
		}
	}
}

func TestBuildMessagesUpstream(t *testing.T) {
	if got := BuildMessagesUpstream("https://api.minimaxi.com", "", "minimax"); got != "https://api.minimaxi.com/anthropic/v1/messages" {
		t.Errorf("got %q, want minimax default messages upstream", got)
	}
	if got := BuildMessagesUpstream("https://api.anthropic.com", "", "anthropic"); got != "https://api.anthropic.com/v1/messages" {
		t.Errorf("got %q, want anthropic default messages upstream", got)
	}
	if got := BuildMessagesUpstream("https://other.com", "https://anthropic.override.com/v1", "custom"); got != "https://anthropic.override.com/v1/messages" {
		t.Errorf("got %q, want explicit anthropic_base_url messages upstream", got)
	}
}

func TestReadSSE(t *testing.T) {
	input := "event: message\ndata: hello\n\n: keepalive\n\ndata: world\n\n"
	var events []string
	var dataItems []string

	err := ReadSSE(strings.NewReader(input), func(event, data string) error {
		events = append(events, event)
		dataItems = append(dataItems, data)
		return nil
	}, nil)

	if err != nil {
		t.Fatalf("ReadSSE error: %v", err)
	}

	if len(events) != 2 || events[0] != "message" || dataItems[0] != "hello" || dataItems[1] != "world" {
		t.Fatalf("unexpected SSE parsed: %v, %v", events, dataItems)
	}
}

func TestReadSSE_BareJSONError(t *testing.T) {
	input := `{"error": {"message": "upstream model overloaded", "code": 503}}` + "\n"
	var errFound string

	_ = ReadSSE(strings.NewReader(input), func(event, data string) error {
		if event == "error" {
			errFound = data
		}
		return nil
	}, nil)

	if !strings.Contains(errFound, "upstream model overloaded") {
		t.Fatalf("expected bare error to be captured, got %q", errFound)
	}
}

func TestUpstreamClient_StreamingTimeoutZero(t *testing.T) {
	client := UpstreamClient(60*time.Second, true)
	if client.Timeout != 0 {
		t.Errorf("UpstreamClient must have Timeout == 0 for streaming responses, got %v", client.Timeout)
	}
	tr, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", client.Transport)
	}
	if tr.ResponseHeaderTimeout != 60*time.Second {
		t.Errorf("expected ResponseHeaderTimeout 60s, got %v", tr.ResponseHeaderTimeout)
	}
	if tr.MaxIdleConns != 100 {
		t.Errorf("expected MaxIdleConns 100, got %d", tr.MaxIdleConns)
	}
	if tr.MaxIdleConnsPerHost != 10 {
		t.Errorf("expected MaxIdleConnsPerHost 10, got %d", tr.MaxIdleConnsPerHost)
	}
	if tr.IdleConnTimeout != 90*time.Second {
		t.Errorf("expected IdleConnTimeout 90s, got %v", tr.IdleConnTimeout)
	}
}

