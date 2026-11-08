package upstream

import (
	"crypto/tls"
	"net/http"
	"time"

	"github.com/khc8655/llmproxy2/internal/netguard"
)

// DefaultTransport creates an http.Transport configured with Happy Eyeballs + DNS Pinning
// using netguard to prevent SSRF and handle NAT VM IPv6 blackhole fallback.
func DefaultTransport(allowPrivate bool) *http.Transport {
	return &http.Transport{
		DialContext:           netguard.NewPinnedDialContext(15*time.Second, allowPrivate),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}
}

// DefaultClient returns an http.Client using DefaultTransport.
func DefaultClient(timeout time.Duration, allowPrivate bool) *http.Client {
	return &http.Client{
		Transport: DefaultTransport(allowPrivate),
		Timeout:   timeout,
	}
}
