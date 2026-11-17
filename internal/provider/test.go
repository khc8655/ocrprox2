package provider

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

// TestRequest specifies the parameters for an endpoint test.
type TestRequest struct {
	Provider *types.ProviderConfig `json:"provider,omitempty"`
	BaseURL  string                `json:"base_url,omitempty"`
	APIKey   string                `json:"api_key,omitempty"`
	Protocol string                `json:"protocol,omitempty"` // "chat", "responses", "anthropic", "gemini", or "all"/""
	Model    string                `json:"model,omitempty"`
	Timeout  time.Duration         `json:"timeout,omitempty"`
}

// ProtocolTestResult reports the outcome of a tiny test request for one protocol.
type ProtocolTestResult struct {
	Protocol string `json:"protocol"`
	OK       bool   `json:"ok"`
	Status   int    `json:"status"`
	Millis   int64  `json:"ms"`
	Model    string `json:"model"`
	Error    string `json:"error,omitempty"`
}

// KeyTestResult reports the test status and latency for a single API key.
type KeyTestResult struct {
	KeyID    string `json:"key_id"`
	KeyLabel string `json:"key_label"`
	Masked   string `json:"masked"`
	OK       bool   `json:"ok"`
	Status   int    `json:"status"`
	Millis   int64  `json:"ms"`
	Model    string `json:"model"`
	Error    string `json:"error,omitempty"`
}

// TestEndpoint sends minimal "tiny" inference requests across Chat / Responses / Anthropic / Gemini
// and returns per-protocol test results.
func TestEndpoint(ctx context.Context, client *http.Client, req TestRequest) []ProtocolTestResult {
	baseURL := strings.TrimSpace(req.BaseURL)
	anthropicBaseURL := ""
	if req.Provider != nil {
		if baseURL == "" {
			baseURL = req.Provider.BaseURL
		}
		anthropicBaseURL = req.Provider.AnthropicBaseURL
	}
	normBase := DetectBase(baseURL)

	apiKey := strings.TrimSpace(req.APIKey)
	if apiKey == "" && req.Provider != nil && len(req.Provider.APIKeys) > 0 && req.Provider.APIKeys[0] != nil {
		apiKey = req.Provider.APIKeys[0].Key
	}

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}

	if client == nil {
		client = upstream.DefaultClient(timeout, false)
	}

	var protos []string
	if req.Protocol != "" && req.Protocol != "all" {
		protos = []string{req.Protocol}
	} else if req.Provider != nil && len(req.Provider.Protocols) > 0 {
		protos = req.Provider.Protocols
	} else {
		protos = []string{ProtoChat, ProtoResponses, ProtoAnthropic, ProtoGemini}
	}

	results := make([]ProtocolTestResult, len(protos))
	var wg sync.WaitGroup

	for i, pr := range protos {
		wg.Add(1)
		go func(idx int, proto string) {
			defer wg.Done()
			results[idx] = runTinyTest(ctx, client, normBase, anthropicBaseURL, apiKey, proto, req.Model, timeout)
		}(i, pr)
	}

	wg.Wait()
	return results
}

func runTinyTest(ctx context.Context, client *http.Client, baseURL, anthropicBaseURL, apiKey, proto, model string, timeout time.Duration) ProtocolTestResult {
	res := ProtocolTestResult{
		Protocol: proto,
	}

	if baseURL == "" {
		res.Error = "empty base URL"
		return res
	}

	// Pick default model if unspecified
	if model == "" {
		switch proto {
		case ProtoChat, ProtoResponses:
			model = "gpt-4o-mini"
		case ProtoAnthropic:
			model = "claude-3-haiku-20240307"
		case ProtoGemini:
			model = "gemini-2.5-flash"
		default:
			model = "default"
		}
	}
	res.Model = model

	var (
		targetURL string
		body      []byte
		headers   = map[string]string{"Content-Type": "application/json"}
	)

	switch proto {
	case ProtoChat:
		targetURL = upstream.JoinUpstream(baseURL, "chat/completions")
		body = []byte(fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"hi"}],"max_tokens":16}`, model))
		if apiKey != "" {
			headers["Authorization"] = "Bearer " + apiKey
		}

	case ProtoResponses:
		targetURL = upstream.JoinUpstream(baseURL, "responses")
		body = []byte(fmt.Sprintf(`{"model":%q,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"max_output_tokens":16}`, model))
		if apiKey != "" {
			headers["Authorization"] = "Bearer " + apiKey
		}

	case ProtoAnthropic:
		targetURL = upstream.BuildMessagesUpstream(baseURL, anthropicBaseURL, "")
		body = []byte(fmt.Sprintf(`{"model":%q,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`, model))
		headers["anthropic-version"] = "2023-06-01"
		if apiKey != "" {
			headers["x-api-key"] = apiKey
			headers["Authorization"] = "Bearer " + apiKey
		}

	case ProtoGemini:
		geminiBase := strings.TrimRight(baseURL, "/")
		if strings.HasSuffix(geminiBase, "/openai") {
			geminiBase = strings.TrimSuffix(geminiBase, "/openai")
		}
		if strings.Contains(geminiBase, "v1beta") || strings.Contains(geminiBase, "v1") {
			targetURL = fmt.Sprintf("%s/models/%s:generateContent", geminiBase, model)
		} else {
			targetURL = fmt.Sprintf("%s/v1beta/models/%s:generateContent", geminiBase, model)
		}
		body = []byte(`{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":16}}`)
		if apiKey != "" {
			headers["x-goog-api-key"] = apiKey
			headers["Authorization"] = "Bearer " + apiKey
		}

	default:
		res.Error = "unsupported test protocol: " + proto
		return res
	}

	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(tctx, http.MethodPost, targetURL, bytes.NewReader(body))
	if err != nil {
		res.Error = err.Error()
		return res
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	t0 := time.Now()
	resp, err := client.Do(httpReq)
	res.Millis = time.Since(t0).Milliseconds()

	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer resp.Body.Close()

	res.Status = resp.StatusCode
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		res.OK = true
		return res
	}

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	res.Error = parseErrorSnippet(respBody, resp.Status)
	return res
}

// BatchTestKeys executes parallel key tests against the provider using a bounded semaphore.
func BatchTestKeys(ctx context.Context, client *http.Client, provider *types.ProviderConfig, model string) []KeyTestResult {
	if provider == nil || len(provider.APIKeys) == 0 {
		return nil
	}

	if client == nil {
		client = upstream.DefaultClient(15*time.Second, false)
	}

	proto := ProtoChat
	if len(provider.Protocols) > 0 {
		proto = provider.Protocols[0]
	}

	results := make([]KeyTestResult, len(provider.APIKeys))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup

	for i, k := range provider.APIKeys {
		if k == nil {
			continue
		}
		wg.Add(1)
		go func(idx int, keyEntry *types.KeyEntry) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				results[idx] = KeyTestResult{
					KeyID:    keyEntry.ID,
					KeyLabel: keyEntry.Label,
					Masked:   MaskKey(keyEntry.Key),
					Error:    "test canceled: " + ctx.Err().Error(),
				}
				return
			}
			defer func() { <-sem }()

			keyID := keyEntry.ID
			if keyID == "" {
				keyID = keyEntry.Label
			}

			req := TestRequest{
				Provider: provider,
				BaseURL:  provider.BaseURL,
				APIKey:   keyEntry.Key,
				Protocol: proto,
				Model:    model,
				Timeout:  15 * time.Second,
			}
			out := TestEndpoint(ctx, client, req)

			if len(out) > 0 {
				r0 := out[0]
				results[idx] = KeyTestResult{
					KeyID:    keyID,
					KeyLabel: keyEntry.Label,
					Masked:   MaskKey(keyEntry.Key),
					OK:       r0.OK,
					Status:   r0.Status,
					Millis:   r0.Millis,
					Model:    r0.Model,
					Error:    r0.Error,
				}
			} else {
				results[idx] = KeyTestResult{
					KeyID:    keyID,
					KeyLabel: keyEntry.Label,
					Masked:   MaskKey(keyEntry.Key),
					Error:    "no test result returned",
				}
			}
		}(i, k)
	}

	wg.Wait()
	return results
}
