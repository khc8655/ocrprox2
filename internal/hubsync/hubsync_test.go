package hubsync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestHubSource_Lifecycle(t *testing.T) {
	var requestCount int32
	var lastIfNoneMatch string
	hubStatusCode := http.StatusOK

	testConfig := types.ProxyConfig{
		Version: 10,
		Providers: map[string]*types.ProviderConfig{
			"openai": {
				ID:      "openai",
				BaseURL: "https://api.openai.com",
				Enabled: true,
				APIKeys: []*types.KeyEntry{
					{ID: "k1", Label: "main", Key: "sk-test-secret-12345", Enabled: true},
				},
			},
		},
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		lastIfNoneMatch = r.Header.Get("If-None-Match")

		if r.Header.Get("Authorization") != "Bearer test-node-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		w.Header().Set("ETag", `"v10"`)
		w.Header().Set("X-Lease-Until", time.Now().Add(400*time.Millisecond).Format(time.RFC3339Nano))
		w.Header().Set("X-Grace-Until", time.Now().Add(1*time.Hour).Format(time.RFC3339Nano))

		w.WriteHeader(hubStatusCode)
		if hubStatusCode == http.StatusOK {
			_ = json.NewEncoder(w).Encode(testConfig)
		}
	}))
	defer ts.Close()

	source := NewHubSource(ts.URL, "test-node-token", true)

	// 1. Startup: 0 network requests, waiting_first_request
	status, state, valid, _ := source.HealthState()
	if status != "standby" || state != StateWaitingFirstRequest || valid {
		t.Fatalf("unexpected initial health: %s, %s, %v", status, state, valid)
	}
	if atomic.LoadInt32(&requestCount) != 0 {
		t.Fatalf("expected 0 requests on startup, got %d", atomic.LoadInt32(&requestCount))
	}

	// 2. First real request: fetches config via 200 OK
	ctx := context.Background()
	snap, err := source.Current(ctx, false)
	if err != nil {
		t.Fatalf("Current error: %v", err)
	}
	if snap.Config.Version != 10 {
		t.Errorf("expected version 10, got %d", snap.Config.Version)
	}
	if atomic.LoadInt32(&requestCount) != 1 {
		t.Errorf("expected 1 request after first call, got %d", atomic.LoadInt32(&requestCount))
	}

	// 3. Second call within lease: 0 new requests
	snap2, err := source.Current(ctx, false)
	if err != nil || snap2 != snap {
		t.Fatalf("expected same snapshot without request")
	}
	if atomic.LoadInt32(&requestCount) != 1 {
		t.Errorf("expected still 1 request within lease, got %d", atomic.LoadInt32(&requestCount))
	}

	// 4. Wait for lease to expire (400ms), then next call triggers 304 Not Modified
	time.Sleep(450 * time.Millisecond)
	hubStatusCode = http.StatusNotModified

	snap3, err := source.Current(ctx, false)
	if err != nil {
		t.Fatalf("Current after lease expiry error: %v", err)
	}
	if atomic.LoadInt32(&requestCount) != 2 {
		t.Errorf("expected 2 requests after lease expiry, got %d", atomic.LoadInt32(&requestCount))
	}
	if lastIfNoneMatch != `"v10"` {
		t.Errorf("expected If-None-Match: \"v10\", got %q", lastIfNoneMatch)
	}
	if snap3 == nil || snap3.Config.Version != 10 {
		t.Errorf("expected valid config preserved on 304")
	}

	// 5. Hub revokes node (401 Unauthorized)
	time.Sleep(450 * time.Millisecond)
	hubStatusCode = http.StatusUnauthorized

	_, err = source.Current(ctx, false)
	if err != ErrNodeUnauthorized {
		t.Fatalf("expected ErrNodeUnauthorized, got %v", err)
	}

	// Verify PurgeSecrets wiped keys in memory
	if snap3.Config.Providers["openai"].APIKeys[0].Key != "" {
		t.Errorf("expected key to be wiped to empty string, got %q", snap3.Config.Providers["openai"].APIKeys[0].Key)
	}

	// Health state must now be revoked
	status, state, _, _ = source.HealthState()
	if status != "unhealthy" || state != StateRevoked {
		t.Errorf("expected unhealthy/revoked, got %s/%s", status, state)
	}
}

func TestHubSource_ForceRefreshBeforeLeaseExpiry(t *testing.T) {
	var requestCount int32
	var lastIfNoneMatch string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		lastIfNoneMatch = r.Header.Get("If-None-Match")

		w.Header().Set("ETag", `"v10"`)
		// Generous 1-hour lease - will definitely NOT expire during test
		w.Header().Set("X-Lease-Until", time.Now().Add(1*time.Hour).Format(time.RFC3339Nano))
		w.Header().Set("X-Grace-Until", time.Now().Add(2*time.Hour).Format(time.RFC3339Nano))

		if r.Header.Get("If-None-Match") == `"v10"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(types.ProxyConfig{
			Version: 10,
			Providers: map[string]*types.ProviderConfig{
				"openai": {
					ID:      "openai",
					BaseURL: "https://api.openai.com",
					Enabled: true,
					APIKeys: []*types.KeyEntry{
						{ID: "k1", Label: "main", Key: "sk-test-secret-12345", Enabled: true},
					},
				},
			},
		})
	}))
	defer ts.Close()

	source := NewHubSource(ts.URL, "test-node-token", true)
	ctx := context.Background()

	// 1. Initial request -> 200 OK, requestCount = 1
	snap1, err := source.Current(ctx, false)
	if err != nil {
		t.Fatalf("first Current error: %v", err)
	}
	if snap1.Config.Version != 10 {
		t.Errorf("expected version 10, got %d", snap1.Config.Version)
	}
	if atomic.LoadInt32(&requestCount) != 1 {
		t.Fatalf("expected 1 request, got %d", atomic.LoadInt32(&requestCount))
	}

	// 2. Second request with forceRefresh=false within 1-hour lease -> 0 new requests
	snap2, err := source.Current(ctx, false)
	if err != nil {
		t.Fatalf("second Current error: %v", err)
	}
	if snap2 != snap1 {
		t.Errorf("expected same snapshot from cache")
	}
	if atomic.LoadInt32(&requestCount) != 1 {
		t.Fatalf("expected still 1 request, got %d", atomic.LoadInt32(&requestCount))
	}

	// 3. Third request with forceRefresh=true while lease is still valid (1 hour remaining)
	// Must force a conditional request to Hub!
	snap3, err := source.Current(ctx, true)
	if err != nil {
		t.Fatalf("forced Current error: %v", err)
	}
	if atomic.LoadInt32(&requestCount) != 2 {
		t.Fatalf("expected 2 requests after forceRefresh=true, got %d", atomic.LoadInt32(&requestCount))
	}
	if lastIfNoneMatch != `"v10"` {
		t.Errorf("expected conditional header If-None-Match: \"v10\", got %q", lastIfNoneMatch)
	}
	if snap3.Config.Version != 10 {
		t.Errorf("expected valid config version 10 preserved on 304, got %d", snap3.Config.Version)
	}
}

func TestHubSource_EnvelopeResponseParsing(t *testing.T) {
	// Case 1: Outer config_version = 5, payload has _version = 0 (omitted)
	ts1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Lease-Until", time.Now().Add(1*time.Hour).Format(time.RFC3339Nano))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"ok": true,
			"config_version": 5,
			"payload": {
				"providers": {
					"deepseek": {
						"id": "deepseek",
						"name": "DeepSeek",
						"base_url": "https://api.deepseek.com",
						"enabled": true,
						"api_keys": [
							{"id": "k1", "label": "main", "key": "sk-deepseek-12345", "enabled": true}
						]
					}
				},
				"settings": {
					"run_mode": "agent"
				}
			}
		}`))
	}))
	defer ts1.Close()

	source1 := NewHubSource(ts1.URL, "token1", true)
	snap1, err := source1.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current error on envelope response: %v", err)
	}
	if snap1.Config.Version != 5 {
		t.Errorf("expected Version=5 from outer config_version, got %d", snap1.Config.Version)
	}
	p := snap1.Config.Providers["deepseek"]
	if p == nil || p.BaseURL != "https://api.deepseek.com" || len(p.APIKeys) != 1 {
		t.Fatalf("unexpected provider parsed from payload: %+v", p)
	}
	if p.APIKeys[0].Key != "sk-deepseek-12345" {
		t.Errorf("unexpected API key parsed: %q", p.APIKeys[0].Key)
	}

	// Case 2: Inner payload has _version = 42, outer config_version = 5
	ts2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Lease-Until", time.Now().Add(1*time.Hour).Format(time.RFC3339Nano))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"ok": true,
			"config_version": 5,
			"payload": {
				"_version": 42,
				"providers": {
					"minimax": {
						"id": "minimax",
						"base_url": "https://api.minimaxi.com",
						"enabled": true
					}
				}
			}
		}`))
	}))
	defer ts2.Close()

	source2 := NewHubSource(ts2.URL, "token2", true)
	snap2, err := source2.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current error on inner _version response: %v", err)
	}
	if snap2.Config.Version != 42 {
		t.Errorf("expected inner _version 42 to take precedence, got %d", snap2.Config.Version)
	}
}

func TestHubSource_OnConfigChangeAndAdapterRules(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Lease-Until", time.Now().Add(1*time.Hour).Format(time.RFC3339Nano))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"ok": true,
			"config_version": 7,
			"payload": {
				"providers": {
					"custom": {
						"id": "custom",
						"base_url": "https://api.example.com/v1",
						"enabled": true,
						"adapter_rules": {"auth_header": "X-API-Key", "auth_prefix": ""},
						"api_keys": [{"id": "k1", "label": "k1", "key": "sk-123456", "enabled": true}]
					}
				},
				"settings": {
					"client_key": "sk-hub-client-01",
					"proxy_keys": ["sk-hub-extra-02"]
				}
			}
		}`))
	}))
	defer ts.Close()

	src := NewHubSource(ts.URL, "stk_node_test", true)
	var called int32
	var gotClientKey string
	var gotExtraLen int
	var gotAuthHeader string

	src.OnConfigChange(func(cfg *types.ProxyConfig) {
		atomic.AddInt32(&called, 1)
		gotClientKey = cfg.Settings.ClientKey
		gotExtraLen = len(cfg.Settings.ProxyKeys)
		if p := cfg.Providers["custom"]; p != nil && p.AdapterRules != nil {
			gotAuthHeader = p.AdapterRules.AuthHeader
		}
	})

	_, err := src.Current(context.Background(), false)
	if err != nil {
		t.Fatalf("Current err: %v", err)
	}
	if atomic.LoadInt32(&called) != 1 {
		t.Fatalf("expected callback once, got %d", called)
	}
	if gotClientKey != "sk-hub-client-01" || gotExtraLen != 1 {
		t.Errorf("unexpected synced client keys: primary=%q extras=%d", gotClientKey, gotExtraLen)
	}
	if gotAuthHeader != "X-API-Key" {
		t.Errorf("expected embedded provider adapter_rules auth_header=X-API-Key, got %q", gotAuthHeader)
	}
}
