package upstream

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
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

func TestUpstreamClient_BlocksCrossHostRedirectAndCapsSameHostHops(t *testing.T) {
	var evilHit atomic.Bool
	evilSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		evilHit.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	defer evilSrv.Close()

	originSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cross":
			http.Redirect(w, r, evilSrv.URL+"/steal", http.StatusFound)
		case "/hop0":
			http.Redirect(w, r, "/hop1", http.StatusFound)
		case "/hop1":
			http.Redirect(w, r, "/hop2", http.StatusFound)
		case "/hop2":
			http.Redirect(w, r, "/ok", http.StatusFound)
		case "/loop":
			step, _ := strconv.Atoi(r.URL.Query().Get("n"))
			http.Redirect(w, r, "/loop?n="+strconv.Itoa(step+1), http.StatusFound)
		case "/ok":
			if r.Header.Get("Authorization") != "Bearer sk-vendor" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer originSrv.Close()

	client := UpstreamClient(5*time.Second, true)

	// 1. Cross-host redirect must be rejected before hitting evilSrv
	reqCross, _ := http.NewRequest("GET", originSrv.URL+"/cross", nil)
	reqCross.Header.Set("Authorization", "Bearer sk-vendor")
	resp, err := client.Do(reqCross)
	if resp != nil {
		resp.Body.Close()
	}
	if !errors.Is(err, ErrCrossHostRedirect) {
		t.Fatalf("expected ErrCrossHostRedirect, got %v", err)
	}
	if evilHit.Load() {
		t.Fatalf("cross-host redirect must not contact target server")
	}

	// 2. 3 same-host hops succeed and preserve auth header
	reqSame, _ := http.NewRequest("GET", originSrv.URL+"/hop0", nil)
	reqSame.Header.Set("Authorization", "Bearer sk-vendor")
	resp2, err := client.Do(reqSame)
	if err != nil {
		t.Fatalf("expected 3 same-host hops to succeed, got %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK after same-host hops, got %d", resp2.StatusCode)
	}

	// 3. >3 same-host hops fail with ErrTooManyRedirects
	reqLoop, _ := http.NewRequest("GET", originSrv.URL+"/loop?n=0", nil)
	resp3, err := client.Do(reqLoop)
	if resp3 != nil {
		resp3.Body.Close()
	}
	if !errors.Is(err, ErrTooManyRedirects) {
		t.Fatalf("expected ErrTooManyRedirects after >3 hops, got %v", err)
	}
}

func TestDefaultClient_StripsAuthHeadersOnCrossHostRedirectAndCaps5Hops(t *testing.T) {
	var leakedAuth, leakedXAPI, leakedGoog string
	targetSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leakedAuth = r.Header.Get("Authorization")
		leakedXAPI = r.Header.Get("X-Api-Key")
		leakedGoog = r.Header.Get("x-goog-api-key")
		w.WriteHeader(http.StatusOK)
	}))
	defer targetSrv.Close()

	originSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/loop" {
			step, _ := strconv.Atoi(r.URL.Query().Get("n"))
			http.Redirect(w, r, "/loop?n="+strconv.Itoa(step+1), http.StatusFound)
			return
		}
		http.Redirect(w, r, targetSrv.URL+"/landing", http.StatusFound)
	}))
	defer originSrv.Close()

	client := DefaultClient(5*time.Second, true)
	req, _ := http.NewRequest("GET", originSrv.URL+"/start", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("X-Api-Key", "secret-x-api-key")
	req.Header.Set("x-goog-api-key", "secret-goog-key")

	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("expected cross-host redirect to succeed on DefaultClient, got %v", err)
	}
	resp.Body.Close()

	if leakedAuth != "" || leakedXAPI != "" || leakedGoog != "" {
		t.Fatalf("expected auth headers stripped on cross-host redirect, got auth=%q x-api-key=%q x-goog-api-key=%q",
			leakedAuth, leakedXAPI, leakedGoog)
	}

	reqLoop, _ := http.NewRequest("GET", originSrv.URL+"/loop?n=0", nil)
	respLoop, err := client.Do(reqLoop)
	if respLoop != nil {
		respLoop.Body.Close()
	}
	if !errors.Is(err, ErrTooManyRedirects) {
		t.Fatalf("expected ErrTooManyRedirects after >5 hops, got %v", err)
	}
}
