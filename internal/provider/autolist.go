package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

// ParseRefreshEvery parses a string duration such as "30m", "6h", "1d", "10s", or "off".
func ParseRefreshEvery(s string) (time.Duration, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "", "off", "never", "no", "none", "0", "-":
		return 0, nil
	}

	if n, ok := strings.CutSuffix(s, "d"); ok {
		days, err := strconv.ParseFloat(n, 64)
		if err != nil {
			return 0, fmt.Errorf("%q is not a valid duration (e.g. 30m, 6h, 1d)", s)
		}
		return time.Duration(days * float64(24*time.Hour)), nil
	}

	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a valid duration (e.g. 30m, 6h, 1d): %w", s, err)
	}
	return d, nil
}

// FetchModels queries the provider's /models endpoint and returns a deduplicated slice of model IDs.
func FetchModels(ctx context.Context, client *http.Client, provider *types.ProviderConfig, apiKey string) ([]string, error) {
	if provider == nil {
		return nil, errors.New("provider config is required")
	}

	normBase := DetectBase(provider.BaseURL)
	if normBase == "" {
		return nil, ErrNoURL
	}

	if apiKey == "" && len(provider.APIKeys) > 0 && provider.APIKeys[0] != nil {
		apiKey = provider.APIKeys[0].Key
	}

	if client == nil {
		client = upstream.DefaultClient(15*time.Second, true)
	}

	// 1. Google Gemini native /models endpoint
	isGemini := provider.PresetID == "google" || strings.Contains(strings.ToLower(normBase), "googleapis.com")
	var targetURL string
	headers := map[string]string{"Accept": "application/json"}

	if isGemini {
		geminiBase := strings.TrimRight(normBase, "/")
		if strings.HasSuffix(geminiBase, "/openai") {
			geminiBase = strings.TrimSuffix(geminiBase, "/openai")
		}
		if strings.Contains(geminiBase, "v1beta") || strings.Contains(geminiBase, "v1") {
			targetURL = geminiBase + "/models"
		} else {
			targetURL = geminiBase + "/v1beta/models"
		}
		if apiKey != "" {
			headers["x-goog-api-key"] = apiKey
			headers["Authorization"] = "Bearer " + apiKey
		}
	} else {
		// Standard OpenAI /models
		targetURL = upstream.JoinUpstream(normBase, "models")
		if apiKey != "" {
			headers["Authorization"] = "Bearer " + apiKey
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20)) // read up to 4MB
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("models endpoint returned HTTP %d: %s", resp.StatusCode, parseErrorSnippet(body, resp.Status))
	}

	return parseModelsResponse(body)
}

func parseModelsResponse(body []byte) ([]string, error) {
	// Flexible container to support OpenAI, Gemini, Ollama, and string list payloads
	var raw struct {
		Data   []any `json:"data"`
		Models []any `json:"models"`
	}

	// Try unmarshaling standard container
	if err := json.Unmarshal(body, &raw); err == nil && (len(raw.Data) > 0 || len(raw.Models) > 0) {
		items := raw.Data
		if len(items) == 0 {
			items = raw.Models
		}
		var ids []string
		for _, it := range items {
			switch x := it.(type) {
			case string:
				if x != "" {
					ids = append(ids, strings.TrimPrefix(x, "models/"))
				}
			case map[string]any:
				if id, ok := x["id"].(string); ok && id != "" {
					ids = append(ids, id)
				} else if name, ok := x["name"].(string); ok && name != "" {
					ids = append(ids, strings.TrimPrefix(name, "models/"))
				} else if model, ok := x["model"].(string); ok && model != "" {
					ids = append(ids, model)
				}
			}
		}
		return dedupeModels(ids), nil
	}

	// Try bare array of items
	var list []any
	if err := json.Unmarshal(body, &list); err == nil && len(list) > 0 {
		var ids []string
		for _, it := range list {
			switch x := it.(type) {
			case string:
				if x != "" {
					ids = append(ids, strings.TrimPrefix(x, "models/"))
				}
			case map[string]any:
				if id, ok := x["id"].(string); ok && id != "" {
					ids = append(ids, id)
				} else if name, ok := x["name"].(string); ok && name != "" {
					ids = append(ids, strings.TrimPrefix(name, "models/"))
				}
			}
		}
		return dedupeModels(ids), nil
	}

	return nil, errors.New("unable to parse models list from upstream response")
}

func dedupeModels(in []string) []string {
	var out []string
	seen := make(map[string]struct{}, len(in))
	for _, m := range in {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		if _, ok := seen[m]; !ok {
			seen[m] = struct{}{}
			out = append(out, m)
		}
	}
	return out
}

// FilterAutoInclude filters models using regular expressions or comma-separated wildcard globs.
func FilterAutoInclude(models []string, pattern string) ([]string, error) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return models, nil
	}

	regexes, err := compilePatternRules(pattern)
	if err != nil {
		return nil, err
	}

	var matched []string
	seen := make(map[string]struct{})
	for _, m := range models {
		for _, rx := range regexes {
			if rx.MatchString(m) {
				if _, ok := seen[m]; !ok {
					seen[m] = struct{}{}
					matched = append(matched, m)
				}
				break
			}
		}
	}
	return matched, nil
}

func compilePatternRules(pattern string) ([]*regexp.Regexp, error) {
	if strings.HasPrefix(pattern, "re:") {
		rxStr := "(?i)" + strings.TrimPrefix(pattern, "re:")
		rx, err := regexp.Compile(rxStr)
		if err != nil {
			return nil, fmt.Errorf("invalid regex pattern %q: %w", pattern, err)
		}
		return []*regexp.Regexp{rx}, nil
	}

	// Comma or semicolon separated globs
	tokens := strings.FieldsFunc(pattern, func(r rune) bool {
		return r == ',' || r == ';'
	})

	var regexes []*regexp.Regexp
	for _, tok := range tokens {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		if strings.HasPrefix(tok, "re:") {
			rx, err := regexp.Compile("(?i)" + strings.TrimPrefix(tok, "re:"))
			if err != nil {
				return nil, fmt.Errorf("invalid regex token %q: %w", tok, err)
			}
			regexes = append(regexes, rx)
			continue
		}

		// Convert glob (e.g. "gpt-*", "*claude*") to regex
		escaped := regexp.QuoteMeta(tok)
		escaped = strings.ReplaceAll(escaped, `\*`, `.*`)
		rx, err := regexp.Compile("^(?i)" + escaped + "$")
		if err != nil {
			return nil, fmt.Errorf("invalid glob token %q: %w", tok, err)
		}
		regexes = append(regexes, rx)
	}

	if len(regexes) == 0 {
		return nil, errors.New("empty pattern rules")
	}
	return regexes, nil
}

// RefreshCallback is invoked when models are refreshed for a provider.
type RefreshCallback func(providerID string, models []string, err error)

type refreshTask struct {
	provider *types.ProviderConfig
	apiKey   string
	interval time.Duration
	cancel   context.CancelFunc
}

// RefreshManager coordinates background periodic model syncing based on provider.RefreshEvery.
type RefreshManager struct {
	mu       sync.Mutex
	client   *http.Client
	ctx      context.Context
	cancel   context.CancelFunc
	tasks    map[string]*refreshTask
	callback RefreshCallback
	wg       sync.WaitGroup
}

// NewRefreshManager instantiates a clean RefreshManager.
func NewRefreshManager(client *http.Client, callback RefreshCallback) *RefreshManager {
	if client == nil {
		client = upstream.DefaultClient(15*time.Second, true)
	}
	return &RefreshManager{
		client:   client,
		tasks:    make(map[string]*refreshTask),
		callback: callback,
	}
}

// Start activates the RefreshManager with the given root context.
func (m *RefreshManager) Start(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ctx, m.cancel = context.WithCancel(ctx)
}

// Register registers or updates a provider's periodic refresh schedule.
func (m *RefreshManager) Register(provider *types.ProviderConfig, apiKey string) error {
	if provider == nil || provider.ID == "" {
		return errors.New("provider config with valid ID is required")
	}

	d, err := ParseRefreshEvery(provider.RefreshEvery)
	if err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Cancel existing task if any
	if old, ok := m.tasks[provider.ID]; ok {
		if old.cancel != nil {
			old.cancel()
		}
		delete(m.tasks, provider.ID)
	}

	if d <= 0 || m.ctx == nil {
		return nil
	}

	taskCtx, taskCancel := context.WithCancel(m.ctx)
	task := &refreshTask{
		provider: provider,
		apiKey:   apiKey,
		interval: d,
		cancel:   taskCancel,
	}
	m.tasks[provider.ID] = task

	m.wg.Add(1)
	go func(t *refreshTask, tctx context.Context) {
		defer m.wg.Done()
		ticker := time.NewTicker(t.interval)
		defer ticker.Stop()

		for {
			select {
			case <-tctx.Done():
				return
			case <-ticker.C:
				models, err := m.fetchAndFilter(tctx, t.provider, t.apiKey)
				if m.callback != nil {
					m.callback(t.provider.ID, models, err)
				}
			}
		}
	}(task, taskCtx)

	return nil
}

// Unregister halts periodic refresh for a specific provider.
func (m *RefreshManager) Unregister(providerID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t, ok := m.tasks[providerID]; ok {
		if t.cancel != nil {
			t.cancel()
		}
		delete(m.tasks, providerID)
	}
}

// RefreshNow triggers an immediate fetch and filter for a provider.
func (m *RefreshManager) RefreshNow(ctx context.Context, provider *types.ProviderConfig, apiKey string) ([]string, error) {
	models, err := m.fetchAndFilter(ctx, provider, apiKey)
	if m.callback != nil {
		m.callback(provider.ID, models, err)
	}
	return models, err
}

func (m *RefreshManager) fetchAndFilter(ctx context.Context, provider *types.ProviderConfig, apiKey string) ([]string, error) {
	models, err := FetchModels(ctx, m.client, provider, apiKey)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(provider.AutoInclude) != "" {
		return FilterAutoInclude(models, provider.AutoInclude)
	}
	return models, nil
}

// Stop terminates all scheduled refresh tasks and ensures zero goroutine leaks.
func (m *RefreshManager) Stop() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	for _, t := range m.tasks {
		if t.cancel != nil {
			t.cancel()
		}
	}
	m.tasks = make(map[string]*refreshTask)
	m.mu.Unlock()

	m.wg.Wait()
}
