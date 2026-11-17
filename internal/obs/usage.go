package obs

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

// UsageRecord represents one line in usage.jsonl (enhanced with Magpie fields).
type UsageRecord struct {
	Timestamp          int64        `json:"t"`
	Mode               string       `json:"mode"`
	Endpoint           string       `json:"ep"`
	ReqModel           string       `json:"req"`
	ServedModel        string       `json:"served"`
	Provider           string       `json:"provider"`
	KeyID              string       `json:"key_id"`
	Stream             bool         `json:"stream,omitempty"`
	InTokens           int          `json:"in"`
	OutTokens          int          `json:"out"`
	CacheReadTokens    int          `json:"cache_read,omitempty"`
	CacheWriteTokens   int          `json:"cache_write,omitempty"`
	CacheWrite1hTokens int          `json:"cache_write_1h,omitempty"`
	ReasoningTokens    int          `json:"reasoning,omitempty"`
	Millis             int64        `json:"ms"`
	TTFTMillis         int64        `json:"ttft_ms,omitempty"`
	FlowMillis         int64        `json:"flow_ms,omitempty"`
	OwnMillis          int64        `json:"own_ms,omitempty"`
	QueuedMillis       int64        `json:"queued_ms,omitempty"`
	SentMillis         int64        `json:"sent_ms,omitempty"`
	RetriedMillis      int64        `json:"retried_ms,omitempty"`
	UpBytes            int          `json:"up_bytes,omitempty"`
	DownBytes          int          `json:"down_bytes,omitempty"`
	StopReason         string       `json:"stop,omitempty"`
	Status             int          `json:"status"`
	Tries              int          `json:"tries"`
	FailedTries        []TryFailure `json:"try_failed,omitempty"`
}

// TryFailure attributes one failed upstream attempt to the key that produced it,
// so failover failures are visible in per-key health statistics.
type TryFailure struct {
	Provider string `json:"provider"`
	KeyID    string `json:"key_id"`
	Status   int    `json:"status"`
}

// SeriesPoint is a single bucket point in the interactive timeline series.
type SeriesPoint struct {
	Label            string  `json:"label"` // e.g. "14:00" or "2026-11-14"
	Timestamp        int64   `json:"ts"`
	Requests         int     `json:"requests"`
	Calls            int     `json:"calls"` // alias for requests
	Successes        int     `json:"successes"`
	Failed           int     `json:"failed"`
	InputTokens      int     `json:"input_tokens"`
	OutputTokens     int     `json:"output_tokens"`
	CacheReadTokens  int     `json:"cache_read_tokens"`
	CacheWriteTokens int     `json:"cache_write_tokens"`
	TPS              float64 `json:"tps"`
	AvgTTFTMillis    int64   `json:"avg_ttft_ms"`
}

// HeatmapDay represents one day's call activity in the 53-week heatmap.
type HeatmapDay struct {
	Date   string `json:"date"` // YYYY-MM-DD
	Calls  int    `json:"calls"`
	Tokens int    `json:"tokens"` // in + out + cache_read + cache_write
}

// Heatmap represents the 53-week contribution calendar view.
type Heatmap struct {
	From string       `json:"from"`
	To   string       `json:"to"`
	Days []HeatmapDay `json:"days"`
}

const (
	UsageLedgerLimit  = 10 << 20 // 10 MiB rotation threshold for usage.jsonl -> usage.jsonl.1
	MinValidUsageUnix = int64(1_700_000_000)
	MaxAllSeriesDays  = 3660
)

// Manager coordinates trace buffer and usage ledger, implementing types.ObservabilitySink.
type Manager struct {
	role        types.Role
	traceBuffer *TraceBuffer
	mu          sync.Mutex
	ledgerPath  string
	ledgerFile  *os.File
	ledgerSize  int64
	ledgerLimit atomic.Int64
	memRecords  []UsageRecord // For lite mode or fast queries

	// Async non-blocking ledger writer
	recordChan chan UsageRecord
	flushChan  chan chan struct{}
	doneChan   chan struct{}
	closed     atomic.Bool
	closeOnce  sync.Once
}

// NewManager creates an ObservabilitySink for the given role.
func NewManager(role types.Role, dataDir string) (*Manager, error) {
	m := &Manager{
		role:        role,
		traceBuffer: NewTraceBuffer(),
	}
	m.ledgerLimit.Store(UsageLedgerLimit)

	if role == types.RoleFull && dataDir != "" {
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return nil, err
		}
		p := filepath.Join(dataDir, "usage.jsonl")
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return nil, err
		}
		if fi, stErr := f.Stat(); stErr == nil {
			m.ledgerSize = fi.Size()
		}
		m.ledgerPath = p
		m.ledgerFile = f

		m.recordChan = make(chan UsageRecord, 2048)
		m.flushChan = make(chan chan struct{}, 16)
		m.doneChan = make(chan struct{})

		go m.backgroundWriter()
	} else {
		m.memRecords = make([]UsageRecord, 0, 128)
	}

	return m, nil
}

func (m *Manager) rotateLedger() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ledgerFile == nil {
		return
	}
	_ = m.ledgerFile.Sync()
	_ = m.ledgerFile.Close()
	oldPath := m.ledgerPath + ".1"
	moved := os.Rename(m.ledgerPath, oldPath)
	flag := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if moved != nil {
		flag |= os.O_TRUNC
	}
	f, err := os.OpenFile(m.ledgerPath, flag, 0o600)
	if err != nil {
		m.ledgerFile = nil
		m.ledgerSize = 0
		return
	}
	m.ledgerFile = f
	m.ledgerSize = 0
	if fi, stErr := f.Stat(); stErr == nil {
		m.ledgerSize = fi.Size()
	}
}

func (m *Manager) backgroundWriter() {
	defer close(m.doneChan)
	if m.ledgerFile == nil {
		return
	}

	bw := bufio.NewWriterSize(m.ledgerFile, 64*1024)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	flushWriter := func() {
		if m.ledgerFile != nil {
			_ = bw.Flush()
			_ = m.ledgerFile.Sync()
		}
	}

	writeRecord := func(rec UsageRecord) {
		if m.ledgerFile == nil {
			return
		}
		line, err := json.Marshal(rec)
		if err != nil {
			return
		}
		recLen := int64(len(line) + 1)
		limit := m.ledgerLimit.Load()
		if limit <= 0 {
			limit = UsageLedgerLimit
		}
		if m.ledgerSize > 0 && m.ledgerSize+recLen > limit {
			_ = bw.Flush()
			m.rotateLedger()
			if m.ledgerFile == nil {
				return
			}
			bw.Reset(m.ledgerFile)
		}
		if n, wErr := bw.Write(line); wErr == nil {
			m.ledgerSize += int64(n)
			if bw.WriteByte('\n') == nil {
				m.ledgerSize++
			}
		}
	}

	for {
		select {
		case rec, ok := <-m.recordChan:
			if !ok {
				flushWriter()
				return
			}
			writeRecord(rec)

		case respCh := <-m.flushChan:
			// Drain buffered records
			draining := true
			for draining {
				select {
				case rec, ok := <-m.recordChan:
					if !ok {
						draining = false
						break
					}
					writeRecord(rec)
				default:
					draining = false
				}
			}
			flushWriter()
			close(respCh)

		case <-ticker.C:
			if m.ledgerFile != nil {
				_ = bw.Flush()
			}
		}
	}
}

// Flush flushes all pending records to disk and syncs the ledger file.
func (m *Manager) Flush() error {
	if m.recordChan == nil || m.closed.Load() {
		return nil
	}
	respCh := make(chan struct{})
	select {
	case m.flushChan <- respCh:
		select {
		case <-respCh:
			return nil
		case <-time.After(3 * time.Second):
			return errors.New("obs: flush wait timeout")
		}
	case <-time.After(3 * time.Second):
		return errors.New("obs: flush dispatch timeout")
	}
}

// RecordRequest records a request trace and appends to usage ledger.
// Operates with zero blocking disk I/O on the hot request path.
func (m *Manager) RecordRequest(trace types.RequestTrace) {
	if m == nil {
		return
	}
	if m.traceBuffer != nil {
		m.traceBuffer.Record(trace)
	}

	rec := UsageRecord{
		Timestamp:          trace.Timestamp,
		Mode:               trace.Mode,
		Endpoint:           trace.Endpoint,
		ReqModel:           trace.ReqModel,
		ServedModel:        trace.ServedModel,
		Provider:           trace.WinnerProvider,
		KeyID:              trace.WinnerKey,
		Stream:             trace.Stream,
		InTokens:           trace.InTokens,
		OutTokens:          trace.OutTokens,
		CacheReadTokens:    trace.CacheReadTokens,
		CacheWriteTokens:   trace.CacheWriteTokens,
		CacheWrite1hTokens: trace.CacheWrite1hTokens,
		ReasoningTokens:    trace.ReasoningTokens,
		Millis:             trace.TotalMillis,
		TTFTMillis:         trace.TTFTMillis,
		FlowMillis:         trace.FlowMillis,
		OwnMillis:          trace.OwnMillis,
		QueuedMillis:       trace.QueuedMillis,
		SentMillis:         trace.SentMillis,
		RetriedMillis:      trace.RetriedMillis,
		UpBytes:            trace.UpBytes,
		DownBytes:          trace.DownBytes,
		StopReason:         trace.StopReason,
		Status:             trace.Status,
		Tries:              len(trace.Tries),
	}

	for _, tr := range trace.Tries {
		if tr.Status >= 200 && tr.Status < 300 {
			continue
		}
		if tr.Provider == "" || tr.KeyID == "" {
			continue
		}
		rec.FailedTries = append(rec.FailedTries, TryFailure{
			Provider: tr.Provider,
			KeyID:    tr.KeyID,
			Status:   tr.Status,
		})
	}

	if m.recordChan != nil && !m.closed.Load() {
		select {
		case m.recordChan <- rec:
		default:
			// Buffer full: drop rather than block hot path
		}
		return
	}

	// Only retain in-memory slice when running without a disk ledger (e.g. unit tests)
	if m.ledgerPath == "" {
		m.mu.Lock()
		if len(m.memRecords) >= 1000 {
			m.memRecords = append(m.memRecords[1:], rec)
		} else {
			m.memRecords = append(m.memRecords, rec)
		}
		m.mu.Unlock()
	}
}

// DigestModelStat holds exact per-model call/status/token counts for Hub sync reporting.
type DigestModelStat struct {
	Calls     int `json:"calls"`
	Successes int `json:"successes"`
	Failed    int `json:"failed"`
	InTokens  int `json:"in_tokens"`
	OutTokens int `json:"out_tokens"`
}

// UsageDigest summarizes the in-memory record window for hub reporting: which
// models were actually served and how much traffic they carried. Kept intentionally
// compact so it fits in a single request header.
type UsageDigest struct {
	Models     map[string]int             `json:"models"`
	ModelStats map[string]DigestModelStat `json:"model_stats,omitempty"`
	Requests   int                        `json:"requests"`
	Successes  int                        `json:"successes"`
	Failed     int                        `json:"failed"`
	InTokens   int                        `json:"in_tokens"`
	OutTokens  int                        `json:"out_tokens"`
}

// UsageDigest builds the digest from the in-memory ledger window.
func (m *Manager) UsageDigest() UsageDigest {
	m.mu.Lock()
	records := make([]UsageRecord, len(m.memRecords))
	copy(records, m.memRecords)
	m.mu.Unlock()

	digest := UsageDigest{Models: make(map[string]int, 16)}
	if len(records) > 0 {
		digest.ModelStats = make(map[string]DigestModelStat, 16)
	}
	for _, r := range records {
		digest.Requests++
		ok := r.Status >= 200 && r.Status < 400
		if ok {
			digest.Successes++
		} else {
			digest.Failed++
		}
		digest.InTokens += r.InTokens
		digest.OutTokens += r.OutTokens

		model := r.ServedModel
		if model == "" {
			model = r.ReqModel
		}
		if model != "" {
			digest.Models[model]++
			st := digest.ModelStats[model]
			st.Calls++
			if ok {
				st.Successes++
			} else {
				st.Failed++
			}
			st.InTokens += r.InTokens
			st.OutTokens += r.OutTokens
			digest.ModelStats[model] = st
		}
	}
	return digest
}

// RecentTraces returns recent traces.
func (m *Manager) RecentTraces(onlyFailedOrRetried bool) []types.RequestTrace {
	if m == nil || m.traceBuffer == nil {
		return nil
	}
	return m.traceBuffer.Recent(onlyFailedOrRetried)
}

// ClearTraces clears all in-memory traces.
func (m *Manager) ClearTraces() {
	if m.traceBuffer != nil {
		m.traceBuffer.Clear()
	}
}

// QueryUsage aggregates usage statistics over a given period (today, 7d, 30d, all).
func (m *Manager) QueryUsage(period string, tzName string) (map[string]any, error) {
	loc := time.UTC
	if tzName != "" {
		if l, err := time.LoadLocation(tzName); err == nil {
			loc = l
		}
	}

	now := time.Now().In(loc)
	var cutoff int64

	switch period {
	case "today":
		midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
		cutoff = midnight.Unix()
	case "7d":
		cutoff = now.AddDate(0, 0, -7).Unix()
	case "30d":
		cutoff = now.AddDate(0, 0, -30).Unix()
	default: // "all"
		cutoff = 0
	}

	type ModelStats struct {
		Model              string  `json:"model,omitempty"`
		Requests           int     `json:"requests"`
		Successes          int     `json:"successes"`
		Failed             int     `json:"failed"`
		Retried            int     `json:"retried"`
		SuccessRate        float64 `json:"success_rate,omitempty"`
		InTokens           int     `json:"in_tokens"`
		OutTokens          int     `json:"out_tokens"`
		CacheReadTokens    int     `json:"cache_read_tokens"`
		CacheWriteTokens   int     `json:"cache_write_tokens"`
		CacheWrite1hTokens int     `json:"cache_write_1h_tokens,omitempty"`
		CacheHitRate       float64 `json:"cache_hit_rate"`
		ReasoningTokens    int     `json:"reasoning_tokens"`
		UpBytes            int     `json:"up_bytes,omitempty"`
		DownBytes          int     `json:"down_bytes,omitempty"`
		TotalMillis        int64   `json:"total_ms"`
		AvgTTFTMillis      int64   `json:"avg_ttft_ms,omitempty"`
		AvgTotalMillis     int64   `json:"avg_total_ms,omitempty"`
		TPS                float64 `json:"tps"`
		ttftSum            int64
		ttftCount          int
		flowSum            int64
		flowOutSum         int
	}

	type KeyStats struct {
		Provider         string  `json:"provider"`
		KeyID            string  `json:"key_id"`
		Requests         int     `json:"requests"`
		Successes        int     `json:"successes"`
		Failed           int     `json:"failed"`
		Retried          int     `json:"retried"`
		SuccessRate      float64 `json:"success_rate,omitempty"`
		InTokens         int     `json:"in_tokens"`
		OutTokens        int     `json:"out_tokens"`
		CacheReadTokens  int     `json:"cache_read_tokens"`
		CacheWriteTokens int     `json:"cache_write_tokens"`
		CacheHitRate     float64 `json:"cache_hit_rate"`
		ReasoningTokens  int     `json:"reasoning_tokens"`
		UpBytes          int     `json:"up_bytes,omitempty"`
		DownBytes        int     `json:"down_bytes,omitempty"`
		AvgTTFTMillis    int64   `json:"avg_ttft_ms,omitempty"`
		AvgTotalMillis   int64   `json:"avg_total_ms,omitempty"`
		TPS              float64 `json:"tps"`
		ttftSum          int64
		ttftCount        int
		totalMsSum       int64
		flowSum          int64
		flowOutSum       int
	}

	type ProviderStats struct {
		Provider         string         `json:"provider,omitempty"`
		Requests         int            `json:"requests"`
		Successes        int            `json:"successes"`
		Failed           int            `json:"failed"`
		Retried          int            `json:"retried"`
		SuccessRate      float64        `json:"success_rate,omitempty"`
		InTokens         int            `json:"in_tokens"`
		OutTokens        int            `json:"out_tokens"`
		CacheReadTokens  int            `json:"cache_read_tokens"`
		CacheWriteTokens int            `json:"cache_write_tokens"`
		CacheHitRate     float64        `json:"cache_hit_rate"`
		ReasoningTokens  int            `json:"reasoning_tokens"`
		UpBytes          int            `json:"up_bytes,omitempty"`
		DownBytes        int            `json:"down_bytes,omitempty"`
		TPS              float64        `json:"tps"`
		AvgTTFTMillis    int64          `json:"avg_ttft_ms,omitempty"`
		AvgTotalMillis   int64          `json:"avg_total_ms,omitempty"`
		Keys             map[string]int `json:"keys"`
		ttftSum          int64
		ttftCount        int
		totalMsSum       int64
		flowSum          int64
		flowOutSum       int
	}

	type EndpointStats struct {
		Endpoint         string  `json:"endpoint"`
		Mode             string  `json:"mode,omitempty"`
		Requests         int     `json:"requests"`
		Successes        int     `json:"successes"`
		Failed           int     `json:"failed"`
		Retried          int     `json:"retried"`
		SuccessRate      float64 `json:"success_rate,omitempty"`
		InTokens         int     `json:"in_tokens"`
		OutTokens        int     `json:"out_tokens"`
		CacheReadTokens  int     `json:"cache_read_tokens"`
		CacheWriteTokens int     `json:"cache_write_tokens"`
		CacheHitRate     float64 `json:"cache_hit_rate"`
		ReasoningTokens  int     `json:"reasoning_tokens"`
		UpBytes          int     `json:"up_bytes,omitempty"`
		DownBytes        int     `json:"down_bytes,omitempty"`
		TPS              float64 `json:"tps"`
		AvgTTFTMillis    int64   `json:"avg_ttft_ms,omitempty"`
		AvgTotalMillis   int64   `json:"avg_total_ms,omitempty"`
		ttftSum          int64
		ttftCount        int
		totalMsSum       int64
		flowSum          int64
		flowOutSum       int
	}

	modelMap := make(map[string]*ModelStats)
	provMap := make(map[string]*ProviderStats)
	keyMap := make(map[string]*KeyStats)
	epMap := make(map[string]*EndpointStats)
	statusCounts := map[string]int{"2xx": 0, "429": 0, "4xx": 0, "5xx": 0, "err": 0}
	stopReasons := make(map[string]int)
	channelCounts := map[string]int{"agent": 0, "kb": 0}

	totalReqs := 0
	totalSuccess := 0
	totalRetried := 0
	totalIn := 0
	totalOut := 0
	totalCacheRead := 0
	totalCacheWrite := 0
	totalCacheWrite1h := 0
	totalReasoning := 0
	totalUpBytes := 0
	totalDownBytes := 0
	var sumTTFT int64
	var ttftCount int
	var sumTotal int64
	var sumFlow int64
	var flowOutSum int
	var sumOwn int64
	var ownCount int
	var sumQueued int64
	var queuedCount int
	var sumSent int64
	var sentCount int

	type bucketAccum struct {
		requests   int
		successes  int
		failed     int
		inTok      int
		outTok     int
		cRead      int
		cWrite     int
		ttftSum    int64
		ttftCount  int
		flowSum    int64
		flowOutSum int
	}
	hourBuckets := make([]bucketAccum, 24)
	dayBuckets := make(map[string]*bucketAccum)

	todayMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	weekdayOffset := (int(todayMidnight.Weekday()) + 6) % 7 // Monday = 0
	mondayThisWeek := todayMidnight.AddDate(0, 0, -weekdayOffset)
	startMonday := mondayThisWeek.AddDate(0, 0, -7*(53-1))
	heatmapCutoff := startMonday.Unix()
	heatDayMap := make(map[string]*HeatmapDay)
	var earliestTs int64

	m.forEachRecordSince(cutoff, func(r UsageRecord) {
		if r.Timestamp > MinValidUsageUnix && r.Timestamp <= now.Unix()+86400 && (earliestTs == 0 || r.Timestamp < earliestTs) {
			earliestTs = r.Timestamp
		}
		totalReqs++
		isSuccess := r.Status >= 200 && r.Status < 300
		if isSuccess {
			totalSuccess++
			statusCounts["2xx"]++
		} else if r.Status == 429 {
			statusCounts["429"]++
		} else if r.Status >= 400 && r.Status < 500 {
			statusCounts["4xx"]++
		} else if r.Status >= 500 {
			statusCounts["5xx"]++
		} else {
			statusCounts["err"]++
		}
		isRetried := r.Tries > 1 || r.RetriedMillis > 0
		if isRetried {
			totalRetried++
		}
		if r.Mode == "kb" {
			channelCounts["kb"]++
		} else {
			channelCounts["agent"]++
		}
		if r.StopReason != "" {
			stopReasons[r.StopReason]++
		}
		totalIn += r.InTokens
		totalOut += r.OutTokens
		totalCacheRead += r.CacheReadTokens
		totalCacheWrite += r.CacheWriteTokens
		totalCacheWrite1h += r.CacheWrite1hTokens
		totalReasoning += r.ReasoningTokens
		totalUpBytes += r.UpBytes
		totalDownBytes += r.DownBytes

		if r.TTFTMillis > 0 {
			sumTTFT += r.TTFTMillis
			ttftCount++
		}
		sumTotal += r.Millis

		var effFlow int64
		if r.Stream && r.TTFTMillis > 0 && r.Millis-r.TTFTMillis >= 20 {
			effFlow = r.Millis - r.TTFTMillis
		} else if r.FlowMillis >= 20 {
			effFlow = r.FlowMillis
		} else if r.Millis > 0 {
			effFlow = r.Millis
		}
		if effFlow > 0 && r.OutTokens > 0 {
			sumFlow += effFlow
			flowOutSum += r.OutTokens
		}

		if r.OwnMillis > 0 {
			sumOwn += r.OwnMillis
			ownCount++
		}
		if r.QueuedMillis > 0 {
			sumQueued += r.QueuedMillis
			queuedCount++
		}
		if r.SentMillis > 0 {
			sumSent += r.SentMillis
			sentCount++
		}

		// Model aggregate. Failed requests never reach an upstream model, so
		// ServedModel is empty: fall back to the requested model (then "unknown")
		// instead of emitting an entry with no model name at all.
		modelKey := r.ServedModel
		if modelKey == "" {
			modelKey = r.ReqModel
		}
		if modelKey == "" {
			modelKey = "unknown"
		}
		ms, ok := modelMap[modelKey]
		if !ok {
			ms = &ModelStats{Model: modelKey}
			modelMap[modelKey] = ms
		}
		ms.Requests++
		if isSuccess {
			ms.Successes++
		} else {
			ms.Failed++
		}
		if isRetried {
			ms.Retried++
		}
		ms.InTokens += r.InTokens
		ms.OutTokens += r.OutTokens
		ms.CacheReadTokens += r.CacheReadTokens
		ms.CacheWriteTokens += r.CacheWriteTokens
		ms.CacheWrite1hTokens += r.CacheWrite1hTokens
		ms.ReasoningTokens += r.ReasoningTokens
		ms.UpBytes += r.UpBytes
		ms.DownBytes += r.DownBytes
		ms.TotalMillis += r.Millis
		if r.TTFTMillis > 0 {
			ms.ttftSum += r.TTFTMillis
			ms.ttftCount++
		}
		if effFlow > 0 && r.OutTokens > 0 {
			ms.flowSum += effFlow
			ms.flowOutSum += r.OutTokens
		}

		// Endpoint / Channel aggregate
		epKey := r.Endpoint
		if epKey == "" {
			epKey = "/v1/chat/completions"
		}
		eps, ok := epMap[epKey]
		if !ok {
			eps = &EndpointStats{Endpoint: epKey, Mode: r.Mode}
			epMap[epKey] = eps
		}
		eps.Requests++
		if isSuccess {
			eps.Successes++
		} else {
			eps.Failed++
		}
		if isRetried {
			eps.Retried++
		}
		eps.InTokens += r.InTokens
		eps.OutTokens += r.OutTokens
		eps.CacheReadTokens += r.CacheReadTokens
		eps.CacheWriteTokens += r.CacheWriteTokens
		eps.ReasoningTokens += r.ReasoningTokens
		eps.UpBytes += r.UpBytes
		eps.DownBytes += r.DownBytes
		eps.totalMsSum += r.Millis
		if r.TTFTMillis > 0 {
			eps.ttftSum += r.TTFTMillis
			eps.ttftCount++
		}
		if effFlow > 0 && r.OutTokens > 0 {
			eps.flowSum += effFlow
			eps.flowOutSum += r.OutTokens
		}

		// Provider aggregate
		if r.Provider != "" {
			ps, ok := provMap[r.Provider]
			if !ok {
				ps = &ProviderStats{
					Provider: r.Provider,
					Keys:     make(map[string]int),
				}
				provMap[r.Provider] = ps
			}
			ps.Requests++
			if isSuccess {
				ps.Successes++
			} else {
				ps.Failed++
			}
			if isRetried {
				ps.Retried++
			}
			ps.InTokens += r.InTokens
			ps.OutTokens += r.OutTokens
			ps.CacheReadTokens += r.CacheReadTokens
			ps.CacheWriteTokens += r.CacheWriteTokens
			ps.ReasoningTokens += r.ReasoningTokens
			ps.UpBytes += r.UpBytes
			ps.DownBytes += r.DownBytes
			ps.totalMsSum += r.Millis
			if r.TTFTMillis > 0 {
				ps.ttftSum += r.TTFTMillis
				ps.ttftCount++
			}
			if effFlow > 0 && r.OutTokens > 0 {
				ps.flowSum += effFlow
				ps.flowOutSum += r.OutTokens
			}
			if r.KeyID != "" {
				ps.Keys[r.KeyID]++
			}
		}

		// Key aggregate
		if r.Provider != "" && r.KeyID != "" {
			kKey := r.Provider + ":" + r.KeyID
			ks, ok := keyMap[kKey]
			if !ok {
				ks = &KeyStats{Provider: r.Provider, KeyID: r.KeyID}
				keyMap[kKey] = ks
			}
			ks.Requests++
			if isSuccess {
				ks.Successes++
			} else {
				ks.Failed++
			}
			if isRetried {
				ks.Retried++
			}
			ks.InTokens += r.InTokens
			ks.OutTokens += r.OutTokens
			ks.CacheReadTokens += r.CacheReadTokens
			ks.CacheWriteTokens += r.CacheWriteTokens
			ks.ReasoningTokens += r.ReasoningTokens
			ks.UpBytes += r.UpBytes
			ks.DownBytes += r.DownBytes
			ks.totalMsSum += r.Millis
			if r.TTFTMillis > 0 {
				ks.ttftSum += r.TTFTMillis
				ks.ttftCount++
			}
			if effFlow > 0 && r.OutTokens > 0 {
				ks.flowSum += effFlow
				ks.flowOutSum += r.OutTokens
			}
		}

		// Failed failover attempts are attributed to the key that actually failed,
		// so key health/failure rate reflects every attempt instead of only the
		// winning key's final status.
		for _, ft := range r.FailedTries {
			if ft.Provider == "" || ft.KeyID == "" {
				continue
			}
			fKey := ft.Provider + ":" + ft.KeyID
			fks, ok := keyMap[fKey]
			if !ok {
				fks = &KeyStats{Provider: ft.Provider, KeyID: ft.KeyID}
				keyMap[fKey] = fks
			}
			fks.Requests++
			fks.Failed++
		}

		// Single-pass series + heatmap accumulation (zero O(days * records) loop)
		t := time.Unix(r.Timestamp, 0).In(loc)
		if period == "today" {
			if t.Year() == now.Year() && t.YearDay() == now.YearDay() {
				h := t.Hour()
				if h >= 0 && h < 24 {
					b := &hourBuckets[h]
					b.requests++
					if isSuccess {
						b.successes++
					} else {
						b.failed++
					}
					b.inTok += r.InTokens
					b.outTok += r.OutTokens
					b.cRead += r.CacheReadTokens
					b.cWrite += r.CacheWriteTokens
					if r.TTFTMillis > 0 {
						b.ttftSum += r.TTFTMillis
						b.ttftCount++
					}
					if effFlow > 0 && r.OutTokens > 0 {
						b.flowSum += effFlow
						b.flowOutSum += r.OutTokens
					}
				}
			}
		} else if r.Timestamp > MinValidUsageUnix {
			dayKey := t.Format("2006-01-02")
			b, ok := dayBuckets[dayKey]
			if !ok {
				b = &bucketAccum{}
				dayBuckets[dayKey] = b
			}
			b.requests++
			if isSuccess {
				b.successes++
			} else {
				b.failed++
			}
			b.inTok += r.InTokens
			b.outTok += r.OutTokens
			b.cRead += r.CacheReadTokens
			b.cWrite += r.CacheWriteTokens
			if r.TTFTMillis > 0 {
				b.ttftSum += r.TTFTMillis
				b.ttftCount++
			}
			if effFlow > 0 && r.OutTokens > 0 {
				b.flowSum += effFlow
				b.flowOutSum += r.OutTokens
			}
		}

		if r.Timestamp >= heatmapCutoff {
			dayKey := t.Format("2006-01-02")
			d, ok := heatDayMap[dayKey]
			if !ok {
				d = &HeatmapDay{Date: dayKey}
				heatDayMap[dayKey] = d
			}
			d.Calls++
			d.Tokens += r.InTokens + r.OutTokens + r.CacheReadTokens + r.CacheWriteTokens
		}
	})

	var avgTTFT int64
	if ttftCount > 0 {
		avgTTFT = sumTTFT / int64(ttftCount)
	}
	var avgTotal int64
	if totalReqs > 0 {
		avgTotal = sumTotal / int64(totalReqs)
	}
	var avgOwn int64
	if ownCount > 0 {
		avgOwn = sumOwn / int64(ownCount)
	}
	var avgQueued int64
	if queuedCount > 0 {
		avgQueued = sumQueued / int64(queuedCount)
	}
	var avgSent int64
	if sentCount > 0 {
		avgSent = sumSent / int64(sentCount)
	}

	var overallTPS float64
	if sumFlow > 0 && flowOutSum > 0 {
		overallTPS = math.Round((float64(flowOutSum)/(float64(sumFlow)/1000.0))*100) / 100
	}

	var cacheHitRate float64
	if totalIn+totalCacheRead > 0 {
		cacheHitRate = math.Round((float64(totalCacheRead)/float64(totalIn+totalCacheRead))*10000) / 10000
	}

	var modelList []*ModelStats
	for _, ms := range modelMap {
		if ms.Requests > 0 {
			ms.SuccessRate = float64(ms.Successes) / float64(ms.Requests)
			ms.AvgTotalMillis = ms.TotalMillis / int64(ms.Requests)
		}
		if ms.ttftCount > 0 {
			ms.AvgTTFTMillis = ms.ttftSum / int64(ms.ttftCount)
		}
		if ms.flowSum > 0 && ms.flowOutSum > 0 {
			ms.TPS = math.Round((float64(ms.flowOutSum)/(float64(ms.flowSum)/1000.0))*100) / 100
		}
		if ms.InTokens+ms.CacheReadTokens > 0 {
			ms.CacheHitRate = math.Round((float64(ms.CacheReadTokens)/float64(ms.InTokens+ms.CacheReadTokens))*10000) / 10000
		}
		modelList = append(modelList, ms)
	}

	for _, ps := range provMap {
		if ps.Requests > 0 {
			ps.SuccessRate = float64(ps.Successes) / float64(ps.Requests)
			ps.AvgTotalMillis = ps.totalMsSum / int64(ps.Requests)
		}
		if ps.ttftCount > 0 {
			ps.AvgTTFTMillis = ps.ttftSum / int64(ps.ttftCount)
		}
		if ps.flowSum > 0 && ps.flowOutSum > 0 {
			ps.TPS = math.Round((float64(ps.flowOutSum)/(float64(ps.flowSum)/1000.0))*100) / 100
		}
		if ps.InTokens+ps.CacheReadTokens > 0 {
			ps.CacheHitRate = math.Round((float64(ps.CacheReadTokens)/float64(ps.InTokens+ps.CacheReadTokens))*10000) / 10000
		}
	}

	var keyList []*KeyStats
	for _, ks := range keyMap {
		if ks.Requests > 0 {
			ks.SuccessRate = float64(ks.Successes) / float64(ks.Requests)
			ks.AvgTotalMillis = ks.totalMsSum / int64(ks.Requests)
		}
		if ks.ttftCount > 0 {
			ks.AvgTTFTMillis = ks.ttftSum / int64(ks.ttftCount)
		}
		if ks.flowSum > 0 && ks.flowOutSum > 0 {
			ks.TPS = math.Round((float64(ks.flowOutSum)/(float64(ks.flowSum)/1000.0))*100) / 100
		}
		if ks.InTokens+ks.CacheReadTokens > 0 {
			ks.CacheHitRate = math.Round((float64(ks.CacheReadTokens)/float64(ks.InTokens+ks.CacheReadTokens))*10000) / 10000
		}
		keyList = append(keyList, ks)
	}

	var endpointList []*EndpointStats
	for _, eps := range epMap {
		if eps.Requests > 0 {
			eps.SuccessRate = float64(eps.Successes) / float64(eps.Requests)
			eps.AvgTotalMillis = eps.totalMsSum / int64(eps.Requests)
		}
		if eps.ttftCount > 0 {
			eps.AvgTTFTMillis = eps.ttftSum / int64(eps.ttftCount)
		}
		if eps.flowSum > 0 && eps.flowOutSum > 0 {
			eps.TPS = math.Round((float64(eps.flowOutSum)/(float64(eps.flowSum)/1000.0))*100) / 100
		}
		if eps.InTokens+eps.CacheReadTokens > 0 {
			eps.CacheHitRate = math.Round((float64(eps.CacheReadTokens)/float64(eps.InTokens+eps.CacheReadTokens))*10000) / 10000
		}
		endpointList = append(endpointList, eps)
	}
	sort.Slice(endpointList, func(i, j int) bool {
		if endpointList[i].Requests != endpointList[j].Requests {
			return endpointList[i].Requests > endpointList[j].Requests
		}
		return endpointList[i].Endpoint < endpointList[j].Endpoint
	})

	// 1. Time-series interactive buckets built directly in O(days) from single-pass accumulators
	var bucketName string
	var seriesPoints []SeriesPoint
	if period == "today" {
		bucketName = "hour"
		seriesPoints = make([]SeriesPoint, 24)
		for h := 0; h < 24; h++ {
			b := &hourBuckets[h]
			var avgTTFT int64
			if b.ttftCount > 0 {
				avgTTFT = b.ttftSum / int64(b.ttftCount)
			}
			var tps float64
			if b.flowSum > 0 && b.flowOutSum > 0 {
				tps = math.Round((float64(b.flowOutSum)/(float64(b.flowSum)/1000.0))*100) / 100
			}
			seriesPoints[h] = SeriesPoint{
				Label:            fmt.Sprintf("%02d:00", h),
				Timestamp:        todayMidnight.Add(time.Duration(h) * time.Hour).Unix(),
				Requests:         b.requests,
				Calls:            b.requests,
				Successes:        b.successes,
				Failed:           b.failed,
				InputTokens:      b.inTok,
				OutputTokens:     b.outTok,
				CacheReadTokens:  b.cRead,
				CacheWriteTokens: b.cWrite,
				TPS:              tps,
				AvgTTFTMillis:    avgTTFT,
			}
		}
	} else {
		bucketName = "day"
		dayCount := 7
		if period == "30d" {
			dayCount = 30
		} else if period == "all" {
			dayCount = 30
			if earliestTs > MinValidUsageUnix {
				earliest := time.Unix(earliestTs, 0).In(loc)
				earliestMidnight := time.Date(earliest.Year(), earliest.Month(), earliest.Day(), 0, 0, 0, 0, loc)
				diffDays := int(todayMidnight.Sub(earliestMidnight).Hours()/24) + 1
				if diffDays > dayCount {
					dayCount = diffDays
				}
				if dayCount > MaxAllSeriesDays {
					dayCount = MaxAllSeriesDays
				}
			}
		}
		seriesPoints = make([]SeriesPoint, dayCount)
		for i := 0; i < dayCount; i++ {
			dayOffset := (dayCount - 1) - i
			targetDate := todayMidnight.AddDate(0, 0, -dayOffset)
			label := targetDate.Format("2006-01-02")
			var pt SeriesPoint
			pt.Label = label
			pt.Timestamp = targetDate.Unix()
			if b, ok := dayBuckets[label]; ok {
				var avgTTFT int64
				if b.ttftCount > 0 {
					avgTTFT = b.ttftSum / int64(b.ttftCount)
				}
				var tps float64
				if b.flowSum > 0 && b.flowOutSum > 0 {
					tps = math.Round((float64(b.flowOutSum)/(float64(b.flowSum)/1000.0))*100) / 100
				}
				pt.Requests = b.requests
				pt.Calls = b.requests
				pt.Successes = b.successes
				pt.Failed = b.failed
				pt.InputTokens = b.inTok
				pt.OutputTokens = b.outTok
				pt.CacheReadTokens = b.cRead
				pt.CacheWriteTokens = b.cWrite
				pt.TPS = tps
				pt.AvgTTFTMillis = avgTTFT
			}
			seriesPoints[i] = pt
		}
	}

	// 2. 53-week Heatmap summary built directly from heatDayMap
	heatDays := make([]HeatmapDay, 0, len(heatDayMap))
	yearCalls := 0
	yearTokens := 0
	for _, d := range heatDayMap {
		heatDays = append(heatDays, *d)
		yearCalls += d.Calls
		yearTokens += d.Tokens
	}
	sort.Slice(heatDays, func(i, j int) bool {
		return heatDays[i].Date < heatDays[j].Date
	})
	heatmap := Heatmap{
		From: startMonday.Format("2006-01-02"),
		To:   now.Format("2006-01-02"),
		Days: heatDays,
	}
	var successRate, retryRate float64
	if totalReqs > 0 {
		successRate = math.Round((float64(totalSuccess)/float64(totalReqs))*10000) / 10000
		retryRate = math.Round((float64(totalRetried)/float64(totalReqs))*10000) / 10000
	}

	return map[string]any{
		"ok":      true,
		"period":  period,
		"tz":      loc.String(),
		"bucket":  bucketName,
		"series":  seriesPoints,
		"heatmap": heatmap,
		"totals": map[string]any{
			"requests":              totalReqs,
			"success":               totalSuccess,
			"failed":                totalReqs - totalSuccess,
			"success_rate":          successRate,
			"retried_requests":      totalRetried,
			"retry_rate":            retryRate,
			"input_tokens":          totalIn,
			"output_tokens":         totalOut,
			"cache_read_tokens":     totalCacheRead,
			"cache_write_tokens":    totalCacheWrite,
			"cache_write_1h_tokens": totalCacheWrite1h,
			"reasoning_tokens":      totalReasoning,
			"cache_hit_rate":        cacheHitRate,
			"tps":                   overallTPS,
			"tok_per_sec":           overallTPS,
			"up_bytes":              totalUpBytes,
			"down_bytes":            totalDownBytes,
			"avg_ttft_ms":           avgTTFT,
			"avg_total_ms":          avgTotal,
			"avg_own_ms":            avgOwn,
			"avg_queued_ms":         avgQueued,
			"avg_sent_ms":           avgSent,
			"status_counts":         statusCounts,
			"stop_reasons":          stopReasons,
			"channels":              channelCounts,
			"active_days":           len(heatmap.Days),
			"year_calls":            yearCalls,
			"year_tokens":           yearTokens,
		},
		"summary": map[string]any{
			"total_requests":   totalReqs,
			"success_requests": totalSuccess,
			"total_in_tokens":  totalIn,
			"total_out_tokens": totalOut,
		},
		"models":     modelMap,
		"model_list": modelList,
		"providers":  provMap,
		"keys":       keyList,
		"endpoints":  endpointList,
	}, nil
}

func (m *Manager) forEachRecordSince(cutoff int64, fn func(UsageRecord)) {
	if m == nil {
		return
	}
	// Flush any in-flight buffered writes so usage.jsonl is 100% current
	_ = m.Flush()

	if m.ledgerPath == "" {
		m.mu.Lock()
		snapshot := make([]UsageRecord, len(m.memRecords))
		copy(snapshot, m.memRecords)
		m.mu.Unlock()
		for _, r := range snapshot {
			if r.Timestamp >= cutoff {
				fn(r)
			}
		}
		return
	}

	// Scan rotated archive (usage.jsonl.1) followed by active ledger (usage.jsonl)
	// without holding m.mu so concurrent writes/rotations never stall on disk I/O.
	scanLedgerFile(m.ledgerPath+".1", cutoff, fn)
	scanLedgerFile(m.ledgerPath, cutoff, fn)
}

func scanLedgerFile(path string, cutoff int64, fn func(UsageRecord)) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	buf := make([]byte, 0, 64*1024)
	sc.Buffer(buf, 1024*1024)
	for sc.Scan() {
		var r UsageRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err == nil {
			if r.Timestamp >= cutoff {
				fn(r)
			}
		}
	}
}

// Close gracefully flushes pending records and closes the underlying ledger file.
func (m *Manager) Close() error {
	var err error
	m.closeOnce.Do(func() {
		m.closed.Store(true)
		if m.recordChan != nil {
			close(m.recordChan)
			<-m.doneChan
		}
		m.mu.Lock()
		if m.ledgerFile != nil {
			err = m.ledgerFile.Close()
			m.ledgerFile = nil
		}
		m.mu.Unlock()
	})
	return err
}
