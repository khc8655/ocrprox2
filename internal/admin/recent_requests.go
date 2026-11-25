package admin

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/khc8655/llmproxy2/internal/obs"
)

const (
	recentRequestsDefaultLimit = 50
	recentRequestsMaxLimit     = 200
)

// recentRequestsProvider is implemented by *obs.Manager, the only sink with a
// replayable per-request store (usage.jsonl on disk, or the in-memory window
// when there is no ledger). It is a type assertion instead of part of
// types.ObservabilitySink so other sinks (e.g. the lite usage counter) stay
// untouched; those have no per-request history and get an empty replay.
type recentRequestsProvider interface {
	RecentRequestsReplay(limit int, onlyFailedOrRetried bool) ([]obs.UsageRecord, string, bool)
}

// handleRecentRequests serves GET /api/admin/recent-requests?limit=50&failed=1.
//
// It returns the newest requests from the on-disk ledger so the console still
// has data after a restart (the in-memory trace ring does not survive one), with
// the raw UsageRecord fields untouched. Response:
//
//	{"ok":true,"requests":[UsageRecord...],"source":"ledger"|"memory","truncated":bool}
//
// truncated is true when fewer than limit matching records were available
// (with failed=1: fewer than limit failures/retries exist).
func (s *Server) handleRecentRequests(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	// limit defaults to 50; anything non-numeric or outside 1..200 falls back to
	// the default rather than being clamped, so a caller asking for 100000 does
	// not silently get the maximum window.
	limit := recentRequestsDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= recentRequestsMaxLimit {
			limit = n
		}
	}

	onlyFailed := r.URL.Query().Get("failed") == "1" || r.URL.Query().Get("failed") == "true"

	var requests []obs.UsageRecord
	source := "memory"
	truncated := true
	if p, ok := s.obsSink.(recentRequestsProvider); ok {
		requests, source, truncated = p.RecentRequestsReplay(limit, onlyFailed)
	}
	if requests == nil {
		requests = []obs.UsageRecord{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":        true,
		"requests":  requests,
		"source":    source,
		"truncated": truncated,
	})
}
