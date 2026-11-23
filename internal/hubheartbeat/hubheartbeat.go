// Package hubheartbeat implements the low-cost full-node heartbeat to EdgeOne Hub.
//
// It performs exactly one thing: POST /api/node/heartbeat so the hub can refresh
// last_seen / last_ip / last_binary_version. It never pulls configuration, never
// projects payloads, and never blocks the data plane. All failures are silent
// (debug log only) — no retry storm, no service exit, no ticker stop.
//
// Cost budget: default 10-minute interval (144 requests/node/day). The hub
// additionally debounces writes (<60s) using last_seen, so KV writes stay low.
package hubheartbeat

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

const (
	// DefaultInterval is the cost-friendly default: 10 minutes -> 144/day/node.
	DefaultInterval = 10 * time.Minute
	// MinInterval is the floor; anything below this is clamped up. The hub-side
	// debounce window is 60s, so sending faster than this would waste invocations.
	MinInterval = 60 * time.Second
	// RequestTimeout bounds a single heartbeat attempt.
	RequestTimeout = 10 * time.Second
	// InitialDelay keeps the heartbeat off the critical startup path, while still
	// reporting a newly upgraded binary's version promptly after restart.
	InitialDelay = 5 * time.Second
	// heartbeatPath is appended to a trimmed hub base URL.
	heartbeatPath = "/api/node/heartbeat"
)

// Config describes a parsed heartbeat configuration.
type Config struct {
	Interval      time.Duration
	Enabled       bool
	ExplicitlySet bool // user supplied the flag/env (non-empty raw value)
}

// ParseInterval interprets a raw flag/env value.
//
//   - "" (unset)          -> default interval, enabled
//   - "0" / "off" / "false" / "no" / "disabled" -> disabled
//   - positive integer (seconds) -> that many seconds, clamped up to MinInterval
//   - anything invalid  -> default interval, enabled (with err reported)
//
// The returned bool reports whether the value was explicitly configured by the
// user (non-empty raw), which drives Lite-role gating.
func ParseInterval(raw string) (interval time.Duration, enabled bool, explicitlySet bool, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DefaultInterval, true, false, nil
	}

	switch strings.ToLower(raw) {
	case "0", "off", "false", "no", "disabled":
		return 0, false, true, nil
	}

	secs, atoiErr := strconv.Atoi(raw)
	if atoiErr != nil || secs <= 0 {
		return DefaultInterval, true, true, errors.New("invalid heartbeat interval " + strconv.Quote(raw))
	}
	interval = time.Duration(secs) * time.Second
	if interval < MinInterval {
		interval = MinInterval
	}
	return interval, true, true, nil
}

// ShouldEnable applies role gating on top of ParseInterval:
//   - full: enabled unless explicitly turned off
//   - lite: only enabled when the user explicitly configured a non-off interval
//
// Unknown roles fall back to Lite semantics (opt-in) to preserve zero-polling.
func ShouldEnable(role types.Role, enabled, explicitlySet bool) bool {
	if !enabled {
		return false
	}
	if role == types.RoleFull {
		return true
	}
	return explicitlySet
}

// Client sends heartbeats to the hub. All state is immutable after construction,
// so a Client is safe for concurrent use and by the race detector.
type Client struct {
	url         string
	nodeToken   string
	nodeVersion string
	interval    time.Duration
	client      *http.Client
	logf        func(format string, args ...any)
	// initialDelay defaults to InitialDelay; tests may shorten it.
	initialDelay time.Duration
}

// NewClient builds a heartbeat client. It performs no network I/O. When debugf
// is nil, diagnostic logging uses the standard log package at a "debug:" prefix.
func NewClient(hubURL, nodeToken, nodeVersion string, interval time.Duration, debugf func(format string, args ...any)) *Client {
	if debugf == nil {
		debugf = func(format string, args ...any) { log.Printf("debug: "+format, args...) }
	}
	return &Client{
		url:          strings.TrimRight(strings.TrimSpace(hubURL), "/"),
		nodeToken:    strings.TrimSpace(nodeToken),
		nodeVersion:  strings.TrimSpace(nodeVersion),
		interval:     interval,
		client:       &http.Client{Timeout: RequestTimeout},
		logf:         debugf,
		initialDelay: InitialDelay,
	}
}

// RunBlock sends a first heartbeat after InitialDelay, then every interval until
// ctx is cancelled. Intended to be launched in its own goroutine.
func (c *Client) RunBlock(ctx context.Context) {
	if c == nil || c.url == "" || c.nodeToken == "" || c.interval <= 0 {
		return
	}

	initial := time.NewTimer(c.initialDelay)
	defer initial.Stop()
	select {
	case <-ctx.Done():
		return
	case <-initial.C:
	}
	c.send(ctx)

	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.send(ctx)
		}
	}
}

// send performs one best-effort heartbeat. It never returns an error to callers:
// failures are recorded at debug level only, and never affect the ticker.
func (c *Client) send(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+heartbeatPath, nil)
	if err != nil {
		c.logf("hubheartbeat: build request failed: %v", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+c.nodeToken)
	if c.nodeVersion != "" {
		req.Header.Set("X-Node-Version", c.nodeVersion)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		c.logf("hubheartbeat: POST %s failed: %v", c.url+heartbeatPath, err)
		return
	}
	defer resp.Body.Close()

	// Never log the token or any response body; only URL and status at debug level.
	c.logf("hubheartbeat: POST %s -> %d", c.url+heartbeatPath, resp.StatusCode)
}
