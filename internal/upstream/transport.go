package upstream

import (
	"crypto/tls"
	"net/http"
	"time"

	"github.com/khc8655/llmproxy2/internal/netguard"
)

// NewTransport creates an http.Transport configured with Happy Eyeballs + DNS Pinning (SSRF protection)
// via netguard, with connection pooling and ResponseHeaderTimeout.
func NewTransport(responseHeaderTimeout time.Duration, allowPrivate bool) *http.Transport {
	if responseHeaderTimeout <= 0 {
		responseHeaderTimeout = 120 * time.Second
	}
	return &http.Transport{
		DialContext:           netguard.NewPinnedDialContext(15*time.Second, allowPrivate),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: responseHeaderTimeout,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}
}

// DefaultTransport creates an http.Transport configured with Happy Eyeballs + DNS Pinning
// using netguard to prevent SSRF and handle NAT VM IPv6 blackhole fallback, with 120s response header timeout.
func DefaultTransport(allowPrivate bool) *http.Transport {
	return NewTransport(120*time.Second, allowPrivate)
}

// UpstreamClient returns an http.Client configured for upstream streaming/LLM requests.
// Timeout is explicitly 0 so long-running streaming responses (>120s) are never killed prematurely.
// First-byte response timeouts are enforced via http.Transport.ResponseHeaderTimeout cleanly.
func UpstreamClient(responseHeaderTimeout time.Duration, allowPrivate bool) *http.Client {
	return &http.Client{
		Transport: NewTransport(responseHeaderTimeout, allowPrivate),
		Timeout:   0,
	}
}

// DefaultClient returns an http.Client using DefaultTransport.
func DefaultClient(timeout time.Duration, allowPrivate bool) *http.Client {
	return &http.Client{
		Transport: DefaultTransport(allowPrivate),
		Timeout:   timeout,
	}
}
