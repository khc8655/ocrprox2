package provider

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

// ============================================================================
// 1. M1: Multi-Protocol Auto-Detection Tests
// ============================================================================

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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := Detect(ctx, server.Client(), server.URL, "test-api-key")
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
	// Server only supports Chat and Anthropic
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

	ctx := context.Background()
	res, err := Detect(ctx, server.Client(), server.URL, "k")
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

// ============================================================================
// 2. M2: Live Balance & Quota Probing Tests
// ============================================================================

func TestQueryBalance_DeepSeek(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ds-secret-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"is_available": true,
			"balance_infos": [
				{"currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00"},
				{"currency": "USD", "total_balance": "0.00", "granted_balance": "0.00", "topped_up_balance": "0.00"}
			]
		}`))
	}))
	defer server.Close()

	prov := &types.ProviderConfig{
		ID:         "ds",
		PresetID:   "deepseek",
		BalanceURL: server.URL + "/user/balance",
	}

	res, err := QueryBalance(context.Background(), server.Client(), prov, "ds-secret-key")
	if err != nil {
		t.Fatalf("QueryBalance DeepSeek failed: %v", err)
	}
	if !strings.Contains(res.Amount, "110.00") {
		t.Errorf("expected amount to contain 110.00, got %s", res.Amount)
	}
}

func TestQueryBalance_OpenRouter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"total_credits": 50.00, "total_usage": 12.50}}`))
	}))
	defer server.Close()

	prov := &types.ProviderConfig{
		ID:         "openrouter",
		PresetID:   "openrouter",
		BalanceURL: server.URL + "/api/v1/credits",
	}

	res, err := QueryBalance(context.Background(), server.Client(), prov, "sk-or-test")
	if err != nil {
		t.Fatalf("QueryBalance OpenRouter failed: %v", err)
	}
	if res.Amount != "$37.50" {
		t.Errorf("expected $37.50, got %s", res.Amount)
	}
}

func TestQueryBalance_OneAPI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// 5,000,000 quota units / 500,000 = $10.00
		_, _ = w.Write([]byte(`{"success": true, "data": {"quota": 5000000}}`))
	}))
	defer server.Close()

	prov := &types.ProviderConfig{
		ID:         "oneapi",
		BalanceURL: server.URL + "/api/user/self",
	}

	res, err := QueryBalance(context.Background(), server.Client(), prov, "sk-oneapi")
	if err != nil {
		t.Fatalf("QueryBalance OneAPI failed: %v", err)
	}
	if res.Amount != "$10.00" {
		t.Errorf("expected $10.00, got %s", res.Amount)
	}
}

func TestQueryBalance_CustomURLAndJSONPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		if token != "my-custom-key" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"bad token"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"wallet": {
				"balance": 120.50,
				"allocations": [
					{"id": "a1", "cost": 20},
					{"id": "a2", "cost": 30}
				]
			}
		}`))
	}))
	defer server.Close()

	prov := &types.ProviderConfig{
		ID:          "custom",
		BalanceURL:  server.URL + "/billing/status?token={key}",
		BalancePath: "$wallet.balance",
	}

	res, err := QueryBalance(context.Background(), server.Client(), prov, "my-custom-key")
	if err != nil {
		t.Fatalf("QueryBalance custom failed: %v", err)
	}
	if res.Amount != "$120.50" {
		t.Errorf("expected $120.50, got %s", res.Amount)
	}

	// Test arithmetic expression path
	prov.BalancePath = "$sum(wallet.allocations.*.cost) * 2"
	res2, err := QueryBalance(context.Background(), server.Client(), prov, "my-custom-key")
	if err != nil {
		t.Fatalf("QueryBalance custom sum failed: %v", err)
	}
	if res2.Amount != "$100.00" {
		t.Errorf("expected $100.00, got %s", res2.Amount)
	}
}

// ============================================================================
// 3. M5: Tiny Live Inference Ping & Batch Key Check Tests
// ============================================================================

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

	req := TestRequest{
		Provider: prov,
		APIKey:   "test-key",
	}

	results := TestEndpoint(context.Background(), server.Client(), req)
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
			{ID: "k4", Label: "key-4", Key: "sk-good-key-4"},
		},
	}

	results := BatchTestKeys(context.Background(), server.Client(), prov, "gpt-4o-mini")
	if len(results) != 4 {
		t.Fatalf("expected 4 results, got %d", len(results))
	}

	if !results[0].OK || results[0].Status != 200 {
		t.Errorf("k1 expected OK, got %+v", results[0])
	}
	if !results[1].OK || results[1].Status != 200 {
		t.Errorf("k2 expected OK, got %+v", results[1])
	}
	if results[2].OK || results[2].Status != 401 {
		t.Errorf("k3 expected failed 401, got %+v", results[2])
	}
	if !results[3].OK || results[3].Status != 200 {
		t.Errorf("k4 expected OK, got %+v", results[3])
	}
}

// ============================================================================
// 4. M6: Automated Model Refresh & AutoInclude Tests
// ============================================================================

func TestFilterAutoInclude(t *testing.T) {
	models := []string{
		"gpt-4o",
		"gpt-4o-mini",
		"claude-3-5-sonnet",
		"claude-3-haiku",
		"deepseek-chat",
		"deepseek-reasoner",
		"o1-preview",
	}

	// 1. Wildcard glob test
	filtered, err := FilterAutoInclude(models, "gpt-*, *claude*")
	if err != nil {
		t.Fatalf("FilterAutoInclude failed: %v", err)
	}
	expected := []string{"gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", "claude-3-haiku"}
	if len(filtered) != len(expected) {
		t.Fatalf("expected %d models, got %d: %v", len(expected), len(filtered), filtered)
	}

	// 2. Regex test
	filteredRe, err := FilterAutoInclude(models, `re:^deepseek-.*`)
	if err != nil {
		t.Fatalf("FilterAutoInclude regex failed: %v", err)
	}
	if len(filteredRe) != 2 || filteredRe[0] != "deepseek-chat" || filteredRe[1] != "deepseek-reasoner" {
		t.Fatalf("unexpected regex results: %v", filteredRe)
	}
}

func TestFetchModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"object": "list",
			"data": [
				{"id": "gpt-4o"},
				{"id": "gpt-4o-mini"},
				{"id": "o1"}
			]
		}`))
	}))
	defer server.Close()

	prov := &types.ProviderConfig{
		ID:      "fetch-p",
		BaseURL: server.URL,
	}

	models, err := FetchModels(context.Background(), server.Client(), prov, "test-key")
	if err != nil {
		t.Fatalf("FetchModels failed: %v", err)
	}
	if len(models) != 3 {
		t.Fatalf("expected 3 models, got %d: %v", len(models), models)
	}
}

func TestRefreshManager_Lifecycle(t *testing.T) {
	var callCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&callCount, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4o"},{"id":"gpt-3.5-turbo"}]}`))
	}))
	defer server.Close()

	callbackCh := make(chan []string, 5)
	mgr := NewRefreshManager(server.Client(), func(providerID string, models []string, err error) {
		if err == nil {
			callbackCh <- models
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mgr.Start(ctx)

	prov := &types.ProviderConfig{
		ID:           "test-refresher",
		BaseURL:      server.URL,
		RefreshEvery: "30ms",
		AutoInclude:  "gpt-4*",
	}

	if err := mgr.Register(prov, "key"); err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	select {
	case models := <-callbackCh:
		if len(models) != 1 || models[0] != "gpt-4o" {
			t.Errorf("expected filtered ['gpt-4o'], got %v", models)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for background refresh callback")
	}

	// Trigger manual RefreshNow
	nowModels, err := mgr.RefreshNow(context.Background(), prov, "key")
	if err != nil {
		t.Fatalf("RefreshNow failed: %v", err)
	}
	if len(nowModels) != 1 || nowModels[0] != "gpt-4o" {
		t.Errorf("expected manual refresh ['gpt-4o'], got %v", nowModels)
	}

	mgr.Unregister(prov.ID)
	mgr.Stop()

	// Verify no goroutine leak and safe double stop
	mgr.Stop()
}

// ============================================================================
// 5. M4: Rich Regional Presets & Capabilities Tests
// ============================================================================

func TestCatalog(t *testing.T) {
	presets := Catalog()
	if len(presets) < 15 {
		t.Fatalf("expected at least 15 presets, got %d", len(presets))
	}

	// Verify crucial presets exist
	expectedIDs := []string{
		"openai", "anthropic", "google", "vertex", "deepseek",
		"minimax", "minimax-cn", "moonshot", "moonshot-cn", "zhipu",
		"volcengine", "bailian-token-plan", "qwen", "openrouter",
		"siliconflow", "stepfun", "groq", "nvidia",
	}

	for _, id := range expectedIDs {
		p := FindPreset(id)
		if p == nil {
			t.Errorf("preset %q not found in Catalog", id)
			continue
		}
		if p.ID != id {
			t.Errorf("FindPreset(%q).ID = %q", id, p.ID)
		}
	}

	// Test Volcengine Ark & Vertex fallback models and NoList flag
	ark := FindPreset("volcengine")
	if !ark.NoList || len(ark.Models) == 0 {
		t.Errorf("volcengine must have NoList=true and non-empty fallback models")
	}
	if len(ark.Regions) < 2 {
		t.Errorf("volcengine expected multiple regions/plans, got %d", len(ark.Regions))
	}

	vertex := FindPreset("vertex")
	if !vertex.NoList || len(vertex.Models) == 0 {
		t.Errorf("vertex must have NoList=true and non-empty fallback models")
	}

	// Test capability helpers
	if !IsVisionModel("openai", "gpt-4o") {
		t.Errorf("expected gpt-4o to be a vision model")
	}
	if !IsVisionModel("anthropic", "claude-3-5-sonnet-20241022") {
		t.Errorf("expected claude-3-5-sonnet-20241022 to be a vision model")
	}
	if !IsReasoningModel("deepseek", "deepseek-r1") {
		t.Errorf("expected deepseek-r1 to be a reasoning model")
	}
	if !IsReasoningModel("openai", "o1") {
		t.Errorf("expected o1 to be a reasoning model")
	}
	if IsReasoningModel("openai", "gpt-4o-mini") {
		t.Errorf("gpt-4o-mini should not be a reasoning model")
	}
}

func TestQueryBalance_MoonshotAndStepFun(t *testing.T) {
	// Moonshot CN (¥)
	serverMSCN := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"available_balance":88.50},"status":true}`))
	}))
	defer serverMSCN.Close()

	provMSCN := &types.ProviderConfig{
		ID:         "ms-cn",
		PresetID:   "moonshot-cn",
		BalanceURL: serverMSCN.URL,
	}
	resMSCN, err := QueryBalance(context.Background(), serverMSCN.Client(), provMSCN, "key")
	if err != nil || resMSCN.Amount != "¥88.50" {
		t.Fatalf("Moonshot CN failed: %v, got %s", err, resMSCN.Amount)
	}

	// StepFun ($)
	serverStep := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"balance": 26.00}`))
	}))
	defer serverStep.Close()

	provStep := &types.ProviderConfig{
		ID:         "step",
		PresetID:   "stepfun",
		BalanceURL: serverStep.URL,
	}
	resStep, err := QueryBalance(context.Background(), serverStep.Client(), provStep, "key")
	if err != nil || resStep.Amount != "$26.00" {
		t.Fatalf("StepFun failed: %v, got %s", err, resStep.Amount)
	}
}

func TestQueryBalance_RefusalAndErrors(t *testing.T) {
	// OneAPI refusal
	serverRefusal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success": false, "message": "user quota exhausted"}`))
	}))
	defer serverRefusal.Close()

	prov := &types.ProviderConfig{
		ID:         "oneapi-refused",
		BalanceURL: serverRefusal.URL + "/api/user/self",
	}
	_, err := QueryBalance(context.Background(), serverRefusal.Client(), prov, "key")
	if err == nil || !strings.Contains(err.Error(), "user quota exhausted") {
		t.Fatalf("expected refusal error, got %v", err)
	}

	// Missing API key error
	provNoKey := &types.ProviderConfig{
		ID:         "nokey",
		BalanceURL: serverRefusal.URL + "/balance?key={key}",
	}
	_, err = QueryBalance(context.Background(), serverRefusal.Client(), provNoKey, "")
	if !errors.Is(err, errNoAPIKey) {
		t.Fatalf("expected errNoAPIKey, got %v", err)
	}

	// Nil provider error
	_, err = QueryBalance(context.Background(), nil, nil, "")
	if err == nil {
		t.Fatal("expected error for nil provider")
	}
}

func TestEvalBalanceExpressions(t *testing.T) {
	jsonDoc := []byte(`{
		"stats": {
			"ratio": 0.85,
			"items": [
				{"status": "active", "amount": 10},
				{"status": "inactive", "amount": 99},
				{"status": "active", "amount": 25}
			]
		},
		"limits": {
			"fiveHour": 12.5,
			"week": 45.0
		}
	}`)

	// 1. Percentage
	v, _, err := evalBalanceParts(jsonDoc, "stats.ratio%")
	if err != nil || v != "85%" {
		t.Fatalf("eval percentage failed: %v, got %s", err, v)
	}

	// 2. Count
	v, _, err = evalBalanceParts(jsonDoc, "count(stats.items.*.amount)")
	if err != nil || v != "3.00" {
		t.Fatalf("eval count failed: %v, got %s", err, v)
	}

	// 3. Filter condition
	v, _, err = evalBalanceParts(jsonDoc, "$sum(stats.items[status=active].amount)")
	if err != nil || v != "$35.00" {
		t.Fatalf("eval filter failed: %v, got %s", err, v)
	}

	// 4. Max / Min
	v, _, err = evalBalanceParts(jsonDoc, "max(limits.fiveHour, limits.week)")
	// In balance expression, max accepts a list; let's test max on items:
	vMax, _, err := evalBalanceParts(jsonDoc, "max(stats.items.*.amount)")
	if err != nil || vMax != "99.00" {
		t.Fatalf("eval max failed: %v, got %s", err, vMax)
	}

	vMin, _, err := evalBalanceParts(jsonDoc, "min(stats.items.*.amount)")
	if err != nil || vMin != "10.00" {
		t.Fatalf("eval min failed: %v, got %s", err, vMin)
	}

	// 5. Multi-part expression
	vMulti, parts, err := evalBalanceParts(jsonDoc, "5h: limits.fiveHour; week: limits.week")
	if err != nil || len(parts) != 2 {
		t.Fatalf("eval multi-part failed: %v, parts: %+v", err, parts)
	}
	if !strings.Contains(vMulti, "5h 12.50") || !strings.Contains(vMulti, "week 45.00") {
		t.Fatalf("unexpected multi-part text: %s", vMulti)
	}
}

func TestParseRefreshEvery(t *testing.T) {
	d, err := ParseRefreshEvery("6h")
	if err != nil || d != 6*time.Hour {
		t.Errorf("expected 6h, got %v (%v)", d, err)
	}

	d, err = ParseRefreshEvery("2d")
	if err != nil || d != 48*time.Hour {
		t.Errorf("expected 48h, got %v (%v)", d, err)
	}

	d, err = ParseRefreshEvery("off")
	if err != nil || d != 0 {
		t.Errorf("expected 0 for off, got %v (%v)", d, err)
	}

	d, err = ParseRefreshEvery("0")
	if err != nil || d != 0 {
		t.Errorf("expected 0 for 0, got %v (%v)", d, err)
	}

	_, err = ParseRefreshEvery("invalid-duration")
	if err == nil {
		t.Error("expected error for invalid duration")
	}
}

func TestFetchModels_Gemini(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"models": [
				{"name": "models/gemini-2.5-flash"},
				{"name": "models/gemini-2.5-pro"}
			]
		}`))
	}))
	defer server.Close()

	prov := &types.ProviderConfig{
		ID:       "gemini-p",
		PresetID: "google",
		BaseURL:  server.URL,
	}

	models, err := FetchModels(context.Background(), server.Client(), prov, "test-key")
	if err != nil {
		t.Fatalf("FetchModels Gemini failed: %v", err)
	}
	if len(models) != 2 || models[0] != "gemini-2.5-flash" || models[1] != "gemini-2.5-pro" {
		t.Fatalf("unexpected gemini models: %v", models)
	}
}
