// Package hubheartbeat implements the low-cost full-node heartbeat to EdgeOne Hub.
//
// It performs exactly two things, both off the data plane:
//   - POST /api/node/heartbeat so the hub can refresh last_seen / last_ip /
//     last_binary_version;
//   - read the config_version the hub answers with, and tell the caller when it
//     differs from the version the node holds, so the caller can pull a fresh
//     template. Without this a node only refreshed on lease expiry (24h by
//     default), which made an operator's edit look like it did nothing.
//
// All failures are silent (debug log only) — no retry storm, no service exit,
// no ticker stop.
//
// Cost budget: default 10-minute interval (144 requests/node/day). The hub
// additionally debounces writes (<60s) using last_seen, so KV writes stay low.
package hubheartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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
//   - lite: enabled only when the user explicitly configured a non-off interval.
//     Lite has no local UI, so the hub is its only visibility surface and a
//     periodic beat is what keeps "online" meaningful there.
//   - full: NOT polled by default. Full has its own admin console and local
//     encrypted config; a beat every 10 minutes buys almost nothing while
//     spending the same free-tier invocations. It still reports once at startup
//     (ShouldSendStartup) so a freshly upgraded binary's version reaches the hub
//     immediately — that was the actual reason heartbeats were introduced.
//   - full with an *explicit* interval: the operator asked for periodic beats
//     (e.g. they want live status in the hub node list), so honour it.
//
// Unknown roles fall back to Lite semantics (opt-in) to preserve zero-polling.
func ShouldEnable(role types.Role, enabled, explicitlySet bool) bool {
	if !enabled {
		return false
	}
	// Both roles need an explicit opt-in for *periodic* beats; the difference is
	// only in what the default means for each.
	return explicitlySet
}

// ShouldSendStartup reports whether the one-shot startup heartbeat should be sent.
// It costs one invocation per process start and is what makes a node upgrade
// visible in the hub immediately, regardless of role.
func ShouldSendStartup(enabled bool) bool {
	return enabled
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
	// onBeat receives the hub's answer to every beat: whether the node is still
	// authorized, and the hub's current config_version. The heartbeat package
	// never fetches config itself: it reports what the hub said and lets the
	// caller decide. Nil is safe (nothing is reported).
	onBeat func(Beat)
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

// Beat is what one heartbeat learned from the hub.
type Beat struct {
	// Revoked is true when the hub answered 401/403 — the node was disabled or
	// deleted. A node holding a still-valid lease would otherwise keep serving
	// cached keys for up to 24h after the operator revoked it, so this is the
	// signal that makes revocation take effect promptly.
	Revoked bool
	// ConfigVersion is the hub's current template version; 0 when unknown
	// (legacy hub, revoked, or an unreachable hub).
	ConfigVersion int64
}

// SetBeatHandler registers the callback invoked after each beat attempt.
func (c *Client) SetBeatHandler(fn func(Beat)) {
	if c == nil {
		return
	}
	c.onBeat = fn
}

// StartOnce sends exactly one heartbeat after InitialDelay and returns. Intended
// to be launched in its own goroutine at startup. Unlike RunBlock it ignores the
// interval, so a Full node with periodic beats disabled still reports its version
// once per process start.
func (c *Client) StartOnce(ctx context.Context) {
	if c == nil || c.url == "" || c.nodeToken == "" {
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

	if c.onBeat == nil {
		return
	}

	// 401/403: the node is disabled or deleted on the hub. Report it so the
	// caller can stop serving immediately — a node with a live lease would
	// otherwise keep using cached keys for up to 24h after revocation.
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		c.onBeat(Beat{Revoked: true})
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return
	}

	var body struct {
		ConfigVersion *int64 `json:"config_version"`
	}
	// Cap the read: this response is one small object, and a heartbeat must never
	// block on a chatty hub.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body); err != nil {
		return
	}
	beat := Beat{}
	if body.ConfigVersion != nil {
		beat.ConfigVersion = *body.ConfigVersion
	}
	c.onBeat(beat)
}
