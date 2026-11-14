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
	Timestamp          int64  `json:"t"`
	Mode               string `json:"mode"`
	Endpoint           string `json:"ep"`
	ReqModel           string `json:"req"`
	ServedModel        string `json:"served"`
	Provider           string `json:"provider"`
	KeyID              string `json:"key_id"`
	InTokens           int    `json:"in"`
	OutTokens          int    `json:"out"`
	CacheReadTokens    int    `json:"cache_read,omitempty"`
	CacheWriteTokens   int    `json:"cache_write,omitempty"`
	CacheWrite1hTokens int    `json:"cache_write_1h,omitempty"`
	ReasoningTokens    int    `json:"reasoning,omitempty"`
	Millis             int64  `json:"ms"`
	TTFTMillis         int64  `json:"ttft_ms,omitempty"`
	FlowMillis         int64  `json:"flow_ms,omitempty"`
	OwnMillis          int64  `json:"own_ms,omitempty"`
	QueuedMillis       int64  `json:"queued_ms,omitempty"`
	SentMillis         int64  `json:"sent_ms,omitempty"`
	RetriedMillis      int64  `json:"retried_ms,omitempty"`
	UpBytes            int    `json:"up_bytes,omitempty"`
	DownBytes          int    `json:"down_bytes,omitempty"`
	StopReason         string `json:"stop,omitempty"`
	Status             int    `json:"status"`
	Tries              int    `json:"tries"`
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

// Manager coordinates trace buffer and usage ledger, implementing types.ObservabilitySink.
type Manager struct {
	role        types.Role
	traceBuffer *TraceBuffer
	mu          sync.Mutex
	ledgerPath  string
	ledgerFile  *os.File
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
		memRecords:  make([]UsageRecord, 0, 500),
	}

	if role == types.RoleFull && dataDir != "" {
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			return nil, err
		}
		p := filepath.Join(dataDir, "usage.jsonl")
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return nil, err
		}
		m.ledgerPath = p
		m.ledgerFile = f

		m.recordChan = make(chan UsageRecord, 2048)
		m.flushChan = make(chan chan struct{}, 16)
		m.doneChan = make(chan struct{})

		go m.backgroundWriter()
	}

	return m, nil
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
		_ = bw.Flush()
		_ = m.ledgerFile.Sync()
	}

	for {
		select {
		case rec, ok := <-m.recordChan:
			if !ok {
				flushWriter()
				return
			}
			line, err := json.Marshal(rec)
			if err == nil {
				_, _ = bw.Write(line)
				_ = bw.WriteByte('\n')
			}

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
					line, err := json.Marshal(rec)
					if err == nil {
						_, _ = bw.Write(line)
						_ = bw.WriteByte('\n')
					}
				default:
					draining = false
				}
			}
			flushWriter()
			close(respCh)

		case <-ticker.C:
			_ = bw.Flush()
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
	m.traceBuffer.Record(trace)

	rec := UsageRecord{
		Timestamp:          trace.Timestamp,
		Mode:               trace.Mode,
		Endpoint:           trace.Endpoint,
		ReqModel:           trace.ReqModel,
		ServedModel:        trace.ServedModel,
		Provider:           trace.WinnerProvider,
		KeyID:              trace.WinnerKey,
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

	m.mu.Lock()
	if len(m.memRecords) >= 1000 {
		m.memRecords = append(m.memRecords[1:], rec)
	} else {
		m.memRecords = append(m.memRecords, rec)
	}
	m.mu.Unlock()

	// Non-blocking async channel dispatch
	if m.recordChan != nil && !m.closed.Load() {
		select {
		case m.recordChan <- rec:
		default:
			// Buffer full: drop rather than block hot path
		}
	}
}

// RecentTraces returns recent traces.
func (m *Manager) RecentTraces(onlyFailedOrRetried bool) []types.RequestTrace {
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

	records := m.loadRecordsSince(cutoff)

	type ModelStats struct {
		Model            string  `json:"model,omitempty"`
		Requests         int     `json:"requests"`
		Successes        int     `json:"successes"`
		Failed           int     `json:"failed"`
		SuccessRate      float64 `json:"success_rate,omitempty"`
		InTokens         int     `json:"in_tokens"`
		OutTokens        int     `json:"out_tokens"`
		CacheReadTokens  int     `json:"cache_read_tokens"`
		CacheWriteTokens int     `json:"cache_write_tokens"`
		CacheHitRate     float64 `json:"cache_hit_rate"`
		ReasoningTokens  int     `json:"reasoning_tokens"`
		TotalMillis      int64   `json:"total_ms"`
		AvgTTFTMillis    int64   `json:"avg_ttft_ms,omitempty"`
		AvgTotalMillis   int64   `json:"avg_total_ms,omitempty"`
		TPS              float64 `json:"tps"`
		ttftSum          int64
		ttftCount        int
		flowSum          int64
		flowOutSum       int
	}

	type KeyStats struct {
		Provider         string  `json:"provider"`
		KeyID            string  `json:"key_id"`
		Requests         int     `json:"requests"`
		Successes        int     `json:"successes"`
		Failed           int     `json:"failed"`
		InTokens         int     `json:"in_tokens"`
		OutTokens        int     `json:"out_tokens"`
		CacheReadTokens  int     `json:"cache_read_tokens"`
		CacheWriteTokens int     `json:"cache_write_tokens"`
		CacheHitRate     float64 `json:"cache_hit_rate"`
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
		InTokens         int            `json:"in_tokens"`
		OutTokens        int            `json:"out_tokens"`
		CacheReadTokens  int            `json:"cache_read_tokens"`
		CacheWriteTokens int            `json:"cache_write_tokens"`
		CacheHitRate     float64        `json:"cache_hit_rate"`
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

	modelMap := make(map[string]*ModelStats)
	provMap := make(map[string]*ProviderStats)
	keyMap := make(map[string]*KeyStats)

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

	for _, r := range records {
		if r.Timestamp < cutoff {
			continue
		}
		totalReqs++
		isSuccess := r.Status >= 200 && r.Status < 300
		if isSuccess {
			totalSuccess++
		}
		if r.Tries > 1 || r.RetriedMillis > 0 {
			totalRetried++
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

		effFlow := r.FlowMillis
		if effFlow <= 0 && r.Millis > r.TTFTMillis && r.TTFTMillis > 0 {
			effFlow = r.Millis - r.TTFTMillis
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

		// Model aggregate
		ms, ok := modelMap[r.ServedModel]
		if !ok {
			ms = &ModelStats{Model: r.ServedModel}
			modelMap[r.ServedModel] = ms
		}
		ms.Requests++
		if isSuccess {
			ms.Successes++
		} else {
			ms.Failed++
		}
		ms.InTokens += r.InTokens
		ms.OutTokens += r.OutTokens
		ms.CacheReadTokens += r.CacheReadTokens
		ms.CacheWriteTokens += r.CacheWriteTokens
		ms.ReasoningTokens += r.ReasoningTokens
		ms.TotalMillis += r.Millis
		if r.TTFTMillis > 0 {
			ms.ttftSum += r.TTFTMillis
			ms.ttftCount++
		}
		if effFlow > 0 && r.OutTokens > 0 {
			ms.flowSum += effFlow
			ms.flowOutSum += r.OutTokens
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
			ps.InTokens += r.InTokens
			ps.OutTokens += r.OutTokens
			ps.CacheReadTokens += r.CacheReadTokens
			ps.CacheWriteTokens += r.CacheWriteTokens
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
			ks.InTokens += r.InTokens
			ks.OutTokens += r.OutTokens
			ks.CacheReadTokens += r.CacheReadTokens
			ks.CacheWriteTokens += r.CacheWriteTokens
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
	}

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

	// 1. Time-series interactive buckets ("today" hourly vs "7d"/"30d" daily)
	bucketName, seriesPoints := buildSeries(records, period, loc, now)

	// 2. 53-week Heatmap data
	heatmap := buildHeatmap(records, loc, now)

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
			"retried_requests":      totalRetried,
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
	}, nil
}

func buildSeries(records []UsageRecord, period string, loc *time.Location, now time.Time) (string, []SeriesPoint) {
	if period == "today" {
		// 24 hourly buckets
		bucket := "hour"
		midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
		points := make([]SeriesPoint, 24)

		type hourAccum struct {
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
		hours := make([]hourAccum, 24)

		for _, r := range records {
			t := time.Unix(r.Timestamp, 0).In(loc)
			if t.Year() == now.Year() && t.YearDay() == now.YearDay() {
				h := t.Hour()
				if h >= 0 && h < 24 {
					hours[h].requests++
					if r.Status >= 200 && r.Status < 300 {
						hours[h].successes++
					} else {
						hours[h].failed++
					}
					hours[h].inTok += r.InTokens
					hours[h].outTok += r.OutTokens
					hours[h].cRead += r.CacheReadTokens
					hours[h].cWrite += r.CacheWriteTokens
					if r.TTFTMillis > 0 {
						hours[h].ttftSum += r.TTFTMillis
						hours[h].ttftCount++
					}
					effFlow := r.FlowMillis
					if effFlow <= 0 && r.Millis > r.TTFTMillis && r.TTFTMillis > 0 {
						effFlow = r.Millis - r.TTFTMillis
					}
					if effFlow > 0 && r.OutTokens > 0 {
						hours[h].flowSum += effFlow
						hours[h].flowOutSum += r.OutTokens
					}
				}
			}
		}

		for h := 0; h < 24; h++ {
			ptTime := midnight.Add(time.Duration(h) * time.Hour)
			var avgTTFT int64
			if hours[h].ttftCount > 0 {
				avgTTFT = hours[h].ttftSum / int64(hours[h].ttftCount)
			}
			var tps float64
			if hours[h].flowSum > 0 && hours[h].flowOutSum > 0 {
				tps = math.Round((float64(hours[h].flowOutSum)/(float64(hours[h].flowSum)/1000.0))*100) / 100
			}

			points[h] = SeriesPoint{
				Label:            fmt.Sprintf("%02d:00", h),
				Timestamp:        ptTime.Unix(),
				Requests:         hours[h].requests,
				Calls:            hours[h].requests,
				Successes:        hours[h].successes,
				Failed:           hours[h].failed,
				InputTokens:      hours[h].inTok,
				OutputTokens:     hours[h].outTok,
				CacheReadTokens:  hours[h].cRead,
				CacheWriteTokens: hours[h].cWrite,
				TPS:              tps,
				AvgTTFTMillis:    avgTTFT,
			}
		}
		return bucket, points
	}

	// Daily buckets for "7d", "30d", or "all"
	bucket := "day"
	dayCount := 7
	if period == "30d" {
		dayCount = 30
	} else if period == "all" {
		dayCount = 30
		if len(records) > 0 {
			earliest := time.Unix(records[0].Timestamp, 0).In(loc)
			diffDays := int(now.Sub(earliest).Hours()/24) + 1
			if diffDays > dayCount {
				dayCount = diffDays
			}
		}
	}

	points := make([]SeriesPoint, dayCount)
	todayMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)

	for i := 0; i < dayCount; i++ {
		dayOffset := (dayCount - 1) - i
		targetDate := todayMidnight.AddDate(0, 0, -dayOffset)
		startSec := targetDate.Unix()
		endSec := targetDate.AddDate(0, 0, 1).Unix()

		var reqs, succ, fail, inT, outT, cR, cW int
		var ttftSum, flowSum, flowOutSum int64
		var ttftCount int

		for _, r := range records {
			if r.Timestamp >= startSec && r.Timestamp < endSec {
				reqs++
				if r.Status >= 200 && r.Status < 300 {
					succ++
				} else {
					fail++
				}
				inT += r.InTokens
				outT += r.OutTokens
				cR += r.CacheReadTokens
				cW += r.CacheWriteTokens
				if r.TTFTMillis > 0 {
					ttftSum += r.TTFTMillis
					ttftCount++
				}
				effFlow := r.FlowMillis
				if effFlow <= 0 && r.Millis > r.TTFTMillis && r.TTFTMillis > 0 {
					effFlow = r.Millis - r.TTFTMillis
				}
				if effFlow > 0 && r.OutTokens > 0 {
					flowSum += effFlow
					flowOutSum += int64(r.OutTokens)
				}
			}
		}

		var avgTTFT int64
		if ttftCount > 0 {
			avgTTFT = ttftSum / int64(ttftCount)
		}
		var tps float64
		if flowSum > 0 && flowOutSum > 0 {
			tps = math.Round((float64(flowOutSum)/(float64(flowSum)/1000.0))*100) / 100
		}

		points[i] = SeriesPoint{
			Label:            targetDate.Format("2006-01-02"),
			Timestamp:        startSec,
			Requests:         reqs,
			Calls:            reqs,
			Successes:        succ,
			Failed:           fail,
			InputTokens:      inT,
			OutputTokens:     outT,
			CacheReadTokens:  cR,
			CacheWriteTokens: cW,
			TPS:              tps,
			AvgTTFTMillis:    avgTTFT,
		}
	}

	return bucket, points
}

func buildHeatmap(records []UsageRecord, loc *time.Location, now time.Time) Heatmap {
	todayMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	weekdayOffset := (int(todayMidnight.Weekday()) + 6) % 7 // Monday = 0
	mondayThisWeek := todayMidnight.AddDate(0, 0, -weekdayOffset)
	startMonday := mondayThisWeek.AddDate(0, 0, -7*(53-1))

	startCutoff := startMonday.Unix()
	dayMap := make(map[string]*HeatmapDay)

	for _, r := range records {
		if r.Timestamp < startCutoff {
			continue
		}
		dayKey := time.Unix(r.Timestamp, 0).In(loc).Format("2006-01-02")
		d, ok := dayMap[dayKey]
		if !ok {
			d = &HeatmapDay{Date: dayKey}
			dayMap[dayKey] = d
		}
		d.Calls++
		d.Tokens += (r.InTokens + r.OutTokens + r.CacheReadTokens + r.CacheWriteTokens)
	}

	days := make([]HeatmapDay, 0, len(dayMap))
	for _, d := range dayMap {
		days = append(days, *d)
	}
	sort.Slice(days, func(i, j int) bool {
		return days[i].Date < days[j].Date
	})

	return Heatmap{
		From: startMonday.Format("2006-01-02"),
		To:   now.Format("2006-01-02"),
		Days: days,
	}
}

func (m *Manager) loadRecordsSince(cutoff int64) []UsageRecord {
	// Flush any in-flight buffered writes so usage.jsonl is 100% current
	_ = m.Flush()

	m.mu.Lock()
	defer m.mu.Unlock()

	// If no ledger file (e.g. lite mode or no dataDir), return in-memory records
	if m.ledgerPath == "" {
		out := make([]UsageRecord, 0, len(m.memRecords))
		for _, r := range m.memRecords {
			if r.Timestamp >= cutoff {
				out = append(out, r)
			}
		}
		return out
	}

	// Read from usage.jsonl
	f, err := os.Open(m.ledgerPath)
	if err != nil {
		out := make([]UsageRecord, 0, len(m.memRecords))
		for _, r := range m.memRecords {
			if r.Timestamp >= cutoff {
				out = append(out, r)
			}
		}
		return out
	}
	defer f.Close()

	var records []UsageRecord
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var r UsageRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err == nil {
			if r.Timestamp >= cutoff {
				records = append(records, r)
			}
		}
	}
	return records
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
