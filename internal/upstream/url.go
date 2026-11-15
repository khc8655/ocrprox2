// Package upstream provides URL resolution, HTTP transport with netguard Happy Eyeballs,
// and SSE scanning utilities.
package upstream

import (
	"regexp"
	"strings"
)

var apiVersionRegex = regexp.MustCompile(`/v\d+[^/]*/|/v\d+(\.[^/]+)?(/.*)?$`)

// JoinUpstream builds upstream URL, handling version paths and custom base URLs automatically.
// Ported 1:1 from Gen 1 upstream.py.
func JoinUpstream(baseURL, path string) string {
	base := strings.TrimRight(baseURL, "/")
	cleanPath := strings.TrimLeft(path, "/")
	cleanPath = strings.TrimPrefix(cleanPath, "v1/")

	if strings.HasSuffix(base, "/"+cleanPath) {
		return base
	}

	// If base already contains /v1, /v1beta/openai, /endpoints/openapi, or any API version segment
	if strings.HasSuffix(base, "/v1") ||
		strings.Contains(base, "/v1/") ||
		strings.HasSuffix(base, "/v1beta/openai") ||
		strings.Contains(base, "/endpoints/openapi") ||
		apiVersionRegex.MatchString(base) {
		return base + "/" + cleanPath
	}

	// Default to injecting /v1/
	return base + "/v1/" + cleanPath
}

// BuildMessagesUpstream builds upstream URL for Anthropic Messages API (/v1/messages).
// Ported 1:1 from Gen 1 upstream.py.
func BuildMessagesUpstream(baseURL, anthropicBaseURL, provider string) string {
	if anthropicBaseURL != "" {
		return JoinUpstream(anthropicBaseURL, "messages")
	}

	p := strings.ToLower(strings.TrimSpace(provider))
	if p == "minimax" {
		b := strings.ToLower(baseURL)
		if strings.Contains(b, "minimax.io") {
			return "https://api.minimax.io/anthropic/v1/messages"
		}
		return "https://api.minimaxi.com/anthropic/v1/messages"
	}

	return JoinUpstream(baseURL, "messages")
}
