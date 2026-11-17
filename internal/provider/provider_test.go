package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestDetectBase(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1"},
		{"https://api.openai.com/v1/responses", "https://api.openai.com/v1"},
		{"https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1"},
		{"https://api.anthropic.com/messages", "https://api.anthropic.com/v1"},
		{"http://localhost:8000", "http://localhost:8000/v1"},
		{"http://localhost:8000/", "http://localhost:8000/v1"},
		{"https://generativelanguage.googleapis.com/v1beta/openai", "https://generativelanguage.googleapis.com/v1beta/openai"},
		{"https://generativelanguage.googleapis.com/models/gemini-2.5-flash:generateContent", "https://generativelanguage.googleapis.com/models/gemini-2.5-flash"},
		{"", ""},
	}

	for _, tc := range tests {
		actual := DetectBase(tc.input)
		if actual != tc.expected {
			t.Errorf("DetectBase(%q) = %q; want %q", tc.input, actual, tc.expected)
		}
	}
}

func TestDetect_AllProtocols(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(path, "/chat/completions"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
		case strings.HasSuffix(path, "/responses"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"output":[{"type":"message","content":"ok"}]}`))
		case strings.HasSuffix(path, "/messages"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}]}`))
		case strings.Contains(path, ":generateContent"):
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not found"}`))
		}
	}))
	defer server.Close()

	res, err := Detect(context.Background(), server.Client(), server.URL, "test-api-key")
	if err != nil {
		t.Fatalf("Detect failed: %v", err)
	}

	if len(res.Protocols) != 4 {
		t.Fatalf("expected 4 detected protocols, got %d: %v", len(res.Protocols), res.Protocols)
	}

	expectedProtos := []string{ProtoChat, ProtoResponses, ProtoAnthropic, ProtoGemini}
	for _, p := range expectedProtos {
		det, ok := res.Results[p]
		if !ok {
			t.Errorf("missing protocol detection for %s", p)
			continue
		}
		if !det.OK || det.Status != http.StatusOK {
			t.Errorf("protocol %s expected OK=true Status=200, got OK=%v Status=%d", p, det.OK, det.Status)
		}
	}
}

func TestDetect_PartialProtocols(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")

		if strings.HasSuffix(path, "/chat/completions") || strings.HasSuffix(path, "/messages") {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		} else {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"unsupported"}`))
		}
	}))
	defer server.Close()

	res, err := Detect(context.Background(), server.Client(), server.URL, "k")
	if err != nil {
		t.Fatalf("Detect failed: %v", err)
	}

	if len(res.Protocols) != 2 {
		t.Fatalf("expected 2 detected protocols, got %d: %v", len(res.Protocols), res.Protocols)
	}
	if res.Protocols[0] != ProtoChat || res.Protocols[1] != ProtoAnthropic {
		t.Errorf("unexpected protocols: %v", res.Protocols)
	}
}

func TestDetect_EmptyURL(t *testing.T) {
	_, err := Detect(context.Background(), nil, "", "")
	if !errors.Is(err, ErrNoURL) {
		t.Fatalf("expected ErrNoURL, got %v", err)
	}
}

func TestTestEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-key" && r.Header.Get("x-api-key") != "test-key" && r.Header.Get("x-goog-api-key") != "test-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"result":"ok"}`))
	}))
	defer server.Close()

	prov := &types.ProviderConfig{
		ID:        "p1",
		BaseURL:   server.URL,
		Protocols: []string{ProtoChat, ProtoResponses},
	}

	results := TestEndpoint(context.Background(), server.Client(), TestRequest{
		Provider: prov,
		APIKey:   "test-key",
	})
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	for _, r := range results {
		if !r.OK || r.Status != http.StatusOK {
			t.Errorf("result for %s expected OK=true, got OK=%v Status=%d", r.Protocol, r.OK, r.Status)
		}
	}
}

func TestBatchTestKeys(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(auth, "bad-key") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"invalid api key"}}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer server.Close()

	prov := &types.ProviderConfig{
		ID:        "batch-prov",
		BaseURL:   server.URL,
		Protocols: []string{ProtoChat},
		APIKeys: []*types.KeyEntry{
			{ID: "k1", Label: "key-1", Key: "sk-good-key-1"},
			{ID: "k2", Label: "key-2", Key: "sk-good-key-2"},
			{ID: "k3", Label: "key-3", Key: "sk-bad-key-3"},
		},
	}

	results := BatchTestKeys(context.Background(), server.Client(), prov, "gpt-4o-mini")
	if len(results) != 3 || !results[0].OK || !results[1].OK || results[2].OK {
		t.Fatalf("unexpected batch results: %+v", results)
	}
}

func TestCatalog_AndPresetAdapterRules(t *testing.T) {
	presets := Catalog()
	if len(presets) < 15 {
		t.Fatalf("expected at least 15 presets, got %d", len(presets))
	}

	expectedIDs := []string{
		"openai", "anthropic", "google", "vertex", "deepseek",
		"minimax", "minimax-cn", "moonshot", "moonshot-cn", "zhipu",
		"volcengine", "bailian-token-plan", "qwen", "openrouter",
		"siliconflow", "stepfun", "groq", "nvidia",
	}
	for _, id := range expectedIDs {
		if p := FindPreset(id); p == nil || p.ID != id {
			t.Errorf("FindPreset(%q) failed: %+v", id, p)
		}
	}

	// Verify DefaultPresetAdapterRules covers critical presets
	if vr := DefaultPresetAdapterRules("vertex"); vr == nil || !vr.GeminiCompat || !vr.EnsureGooglePrefix || vr.ThoughtTagMarker != "<thought>" || !vr.RescueFromText {
		t.Fatalf("unexpected vertex preset rules: %+v", vr)
	}
	if ar := DefaultPresetAdapterRules("amd"); ar == nil || !ar.DenyDeveloperRole || !ar.SystemFirstOnly || !ar.MergeSystem || !ar.StripEmpty || !ar.StripReasoningEnabled {
		t.Fatalf("unexpected amd preset rules: %+v", ar)
	}
	if or := DefaultPresetAdapterRules("openrouter"); or == nil || or.ExtraHeaders["X-Title"] == "" {
		t.Fatalf("unexpected openrouter preset rules: %+v", or)
	}

	// Verify nested v1 adapter_rules JSON unmarshals into AdapterRules losslessly
	rawNested := []byte(`{
		"ensure_google_prefix": true,
		"inject_headers": {"HTTP-Referer": "https://example.com"},
		"messages": {"deny_developer_role": true, "system_first_only": true, "merge_system": true, "strip_empty": true},
		"sanitization": {"strip_params": ["thinking"], "strip_reasoning_enabled": true, "max_tokens_ceiling": 65536},
		"tools": {"rescue_from_text": true, "normalize_choice_to_string": true},
		"reasoning": {"strategy": "gemini_thinking_matrix", "thought_tag_marker": true},
		"response": {"unwrap_root": "data", "reasoning_fields": ["reasoning"]}
	}`)
	var rules types.AdapterRules
	if err := json.Unmarshal(rawNested, &rules); err != nil {
		t.Fatalf("nested AdapterRules unmarshal failed: %v", err)
	}
	if !rules.GeminiCompat || rules.ThoughtTagMarker != "<thought>" || !rules.EnsureGooglePrefix ||
		!rules.DenyDeveloperRole || !rules.SystemFirstOnly || !rules.MergeSystem || !rules.StripEmpty ||
		!rules.RescueFromText || !rules.NormalizeChoiceToString || rules.UnwrapRoot != "data" ||
		rules.MaxTokensCeiling != 65536 || rules.ExtraHeaders["HTTP-Referer"] != "https://example.com" {
		t.Fatalf("nested AdapterRules fields missing after unmarshal: %+v", rules)
	}
}
