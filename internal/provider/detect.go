// Package provider implements provider management, multi-protocol auto-detection,
// live balance & quota probing, tiny ping & batch key checks, automated model refresh,
// and curated presets.
package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/upstream"
)

var (
	// ErrNoURL is returned when Detect is called with an empty base URL.
	ErrNoURL = errors.New("type the base URL first")

	// geminiMethodRegex strips trailing Gemini API method suffixes.
	geminiMethodRegex = regexp.MustCompile(`:(?:generateContent|streamGenerateContent).*$`)
)

// Supported protocol identifiers.
const (
	ProtoChat      = "chat"
	ProtoResponses = "responses"
	ProtoAnthropic = "anthropic"
	ProtoGemini    = "gemini"
)

// ProtocolDetection records the outcome of probing a single protocol endpoint.
type ProtocolDetection struct {
	Protocol string `json:"protocol"`
	Endpoint string `json:"endpoint"`
	OK       bool   `json:"ok"`
	Status   int    `json:"status"`
	Millis   int64  `json:"ms"`
	Error    string `json:"error,omitempty"`
}

// DetectionResult lists detected supported protocols and per-protocol status details.
type DetectionResult struct {
	BaseURL   string                       `json:"base_url"`
	Protocols []string                     `json:"protocols"` // e.g. ["chat", "responses"]
	Results   map[string]ProtocolDetection `json:"results"`
}

// DetectBase normalizes an input URL by removing protocol endpoint suffixes,
// trailing slashes, and ensuring standard base formatting.
func DetectBase(rawURL string) string {
	u := strings.TrimRight(strings.TrimSpace(rawURL), "/")
	if u == "" {
		return ""
	}

	for _, end := range []string{"/chat/completions", "/responses", "/v1/messages", "/messages"} {
		u = strings.TrimSuffix(u, end)
	}
	u = strings.TrimRight(geminiMethodRegex.ReplaceAllString(u, ""), "/")
	if u == "" {
		return ""
	}

	// If the URL is just scheme + host (e.g. "https://api.openai.com"), append "/v1" as default.
	if pu, err := url.Parse(u); err == nil && (pu.Path == "" || pu.Path == "/") {
		return u + "/v1"
	}
	return u
}

// MaskKey formats a secret key safely for logging or display (e.g. "sk-...1234").
func MaskKey(key string) string {
	key = strings.TrimSpace(key)
	if len(key) <= 8 {
		return "***"
	}
	return key[:3] + "..." + key[len(key)-4:]
}

// Detect concurrently probes OpenAI /chat/completions, OpenAI /responses,
// Anthropic /v1/messages, and Google Gemini /models/gemini-2.5-flash:generateContent,
// measures per-protocol latency in milliseconds, and returns a DetectionResult.
func Detect(ctx context.Context, client *http.Client, baseURL, apiKey string) (*DetectionResult, error) {
	normBase := DetectBase(baseURL)
	if normBase == "" {
		return nil, ErrNoURL
	}

	if client == nil {
		client = upstream.DefaultClient(15*time.Second, true)
	}

	type probeTarget struct {
		protocol string
		url      string
		body     []byte
		headers  map[string]string
	}

	// 1. OpenAI Chat Completions
	chatURL := upstream.JoinUpstream(normBase, "chat/completions")
	chatBody := []byte(`{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`)
	chatHeaders := map[string]string{"Content-Type": "application/json"}
	if apiKey != "" {
		chatHeaders["Authorization"] = "Bearer " + apiKey
	}

	// 2. OpenAI Responses API
	responsesURL := upstream.JoinUpstream(normBase, "responses")
	responsesBody := []byte(`{"model":"gpt-4o-mini","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"max_output_tokens":16}`)
	responsesHeaders := map[string]string{"Content-Type": "application/json"}
	if apiKey != "" {
		responsesHeaders["Authorization"] = "Bearer " + apiKey
	}

	// 3. Anthropic Messages API
	anthropicURL := upstream.BuildMessagesUpstream(normBase, "", "")
	anthropicBody := []byte(`{"model":"claude-3-haiku-20240307","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`)
	anthropicHeaders := map[string]string{
		"Content-Type":      "application/json",
		"anthropic-version": "2023-06-01",
	}
	if apiKey != "" {
		anthropicHeaders["x-api-key"] = apiKey
		anthropicHeaders["Authorization"] = "Bearer " + apiKey
	}

	// 4. Google Gemini API
	geminiBase := strings.TrimRight(normBase, "/")
	if strings.HasSuffix(geminiBase, "/openai") {
		geminiBase = strings.TrimSuffix(geminiBase, "/openai")
	}
	var geminiURL string
	if strings.Contains(geminiBase, "v1beta") || strings.Contains(geminiBase, "v1") {
		geminiURL = geminiBase + "/models/gemini-2.5-flash:generateContent"
	} else {
		geminiURL = geminiBase + "/v1beta/models/gemini-2.5-flash:generateContent"
	}
	geminiBody := []byte(`{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":16}}`)
	geminiHeaders := map[string]string{"Content-Type": "application/json"}
	if apiKey != "" {
		geminiHeaders["x-goog-api-key"] = apiKey
		geminiHeaders["Authorization"] = "Bearer " + apiKey
	}

	targets := []probeTarget{
		{protocol: ProtoChat, url: chatURL, body: chatBody, headers: chatHeaders},
		{protocol: ProtoResponses, url: responsesURL, body: responsesBody, headers: responsesHeaders},
		{protocol: ProtoAnthropic, url: anthropicURL, body: anthropicBody, headers: anthropicHeaders},
		{protocol: ProtoGemini, url: geminiURL, body: geminiBody, headers: geminiHeaders},
	}

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		results = make(map[string]ProtocolDetection, len(targets))
	)

	for _, tgt := range targets {
		wg.Add(1)
		go func(t probeTarget) {
			defer wg.Done()
			det := probeProtocol(ctx, client, t.protocol, t.url, t.body, t.headers)
			mu.Lock()
			results[t.protocol] = det
			mu.Unlock()
		}(tgt)
	}

	wg.Wait()

	// Build ordered supported protocols list
	var supported []string
	protoOrder := []string{ProtoChat, ProtoResponses, ProtoAnthropic, ProtoGemini}
	for _, p := range protoOrder {
		if res, ok := results[p]; ok && res.OK {
			supported = append(supported, p)
		}
	}

	return &DetectionResult{
		BaseURL:   normBase,
		Protocols: supported,
		Results:   results,
	}, nil
}

func probeProtocol(ctx context.Context, client *http.Client, proto, targetURL string, body []byte, headers map[string]string) ProtocolDetection {
	det := ProtocolDetection{
		Protocol: proto,
		Endpoint: targetURL,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(body))
	if err != nil {
		det.Error = err.Error()
		return det
	}

	for k, v := range headers {
		req.Header.Set(k, v)
	}

	t0 := time.Now()
	resp, err := client.Do(req)
	det.Millis = time.Since(t0).Milliseconds()

	if err != nil {
		det.Error = err.Error()
		return det
	}
	defer resp.Body.Close()

	det.Status = resp.StatusCode

	// 2xx response is a confirmed success.
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		det.OK = true
		return det
	}

	// Read error summary
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	det.Error = parseErrorSnippet(respBody, resp.Status)
	return det
}

func parseErrorSnippet(body []byte, status string) string {
	if len(body) == 0 {
		return status
	}
	var errObj struct {
		Error any    `json:"error"`
		Msg   string `json:"message"`
	}
	if json.Unmarshal(body, &errObj) == nil {
		switch e := errObj.Error.(type) {
		case string:
			if e != "" {
				return e
			}
		case map[string]any:
			if m, ok := e["message"].(string); ok && m != "" {
				return m
			}
		}
		if errObj.Msg != "" {
			return errObj.Msg
		}
	}

	snippet := strings.TrimSpace(string(body))
	if len(snippet) > 240 {
		snippet = snippet[:240] + "..."
	}
	return snippet
}
