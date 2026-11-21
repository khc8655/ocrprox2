package upstream

// This transport deliberately replaces magpie's internal/netproxy (rejected) with the standard
// library dialer plus netguard pinning: see docs/MAGPIE_UPSTREAM_SYNC.md §3.5.

import (
	"crypto/tls"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/khc8655/llmproxy2/internal/netguard"
)

var (
	ErrCrossHostRedirect = errors.New("upstream: cross-host redirect disallowed")
	ErrTooManyRedirects  = errors.New("upstream: too many redirects")
)

func isSameOrigin(target, origin *url.URL) bool {
	if target == nil || origin == nil {
		return false
	}
	if !strings.EqualFold(target.Host, origin.Host) {
		return false
	}
	if strings.EqualFold(origin.Scheme, "https") && !strings.EqualFold(target.Scheme, "https") {
		return false
	}
	return true
}

func stripSensitiveAuthHeaders(h http.Header) {
	if h == nil {
		return
	}
	for k := range h {
		if strings.EqualFold(k, "Authorization") ||
			strings.EqualFold(k, "Proxy-Authorization") ||
			strings.EqualFold(k, "X-Api-Key") ||
			strings.EqualFold(k, "x-goog-api-key") ||
			strings.EqualFold(k, "Api-Key") {
			delete(h, k)
		}
	}
}

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
// Disallows cross-host (and HTTPS->HTTP downgrade) redirects and caps same-host redirects at 3 hops.
func UpstreamClient(responseHeaderTimeout time.Duration, allowPrivate bool) *http.Client {
	return &http.Client{
		Transport: NewTransport(responseHeaderTimeout, allowPrivate),
		Timeout:   0,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) == 0 {
				return nil
			}
			if len(via) > 3 {
				return ErrTooManyRedirects
			}
			if !isSameOrigin(req.URL, via[0].URL) {
				stripSensitiveAuthHeaders(req.Header)
				return ErrCrossHostRedirect
			}
			return nil
		},
	}
}

// DefaultClient returns an http.Client using DefaultTransport.
// Caps redirects at 5 hops and strips Authorization / X-Api-Key / x-goog-api-key on cross-host redirects.
func DefaultClient(timeout time.Duration, allowPrivate bool) *http.Client {
	return &http.Client{
		Transport: DefaultTransport(allowPrivate),
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 {
				return ErrTooManyRedirects
			}
			if len(via) > 0 && !isSameOrigin(req.URL, via[0].URL) {
				stripSensitiveAuthHeaders(req.Header)
			}
			return nil
		},
	}
}
