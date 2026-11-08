package obs

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
)

// UsageRecord represents one line in usage.jsonl.
type UsageRecord struct {
	Timestamp       int64  `json:"t"`
	Mode            string `json:"mode"`
	Endpoint        string `json:"ep"`
	ReqModel        string `json:"req"`
	ServedModel     string `json:"served"`
	Provider        string `json:"provider"`
	KeyID           string `json:"key_id"`
	InTokens        int    `json:"in"`
	OutTokens       int    `json:"out"`
	CacheReadTokens int    `json:"cache_read,omitempty"`
	ReasoningTokens int    `json:"reasoning,omitempty"`
	Millis          int64  `json:"ms"`
	TTFTMillis      int64  `json:"ttft_ms,omitempty"`
	RetriedMillis   int64  `json:"retried_ms,omitempty"`
	Status          int    `json:"status"`
	Tries           int    `json:"tries"`
}

// Manager coordinates trace buffer and usage ledger, implementing types.ObservabilitySink.
type Manager struct {
	role        types.Role
	traceBuffer *TraceBuffer
	mu          sync.Mutex
	ledgerPath  string
	ledgerFile  *os.File
	memRecords  []UsageRecord // For lite mode or fast queries
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
	}

	return m, nil
}

// RecordRequest records a request trace and appends to usage ledger.
func (m *Manager) RecordRequest(trace types.RequestTrace) {
	m.traceBuffer.Record(trace)

	rec := UsageRecord{
		Timestamp:       trace.Timestamp,
		Mode:            trace.Mode,
		Endpoint:        trace.Endpoint,
		ReqModel:        trace.ReqModel,
		ServedModel:     trace.ServedModel,
		Provider:        trace.WinnerProvider,
		KeyID:           trace.WinnerKey,
		InTokens:        trace.InTokens,
		OutTokens:       trace.OutTokens,
		CacheReadTokens: trace.CacheReadTokens,
		ReasoningTokens: trace.ReasoningTokens,
		Millis:          trace.TotalMillis,
		TTFTMillis:      trace.TTFTMillis,
		RetriedMillis:   trace.RetriedMillis,
		Status:          trace.Status,
		Tries:           len(trace.Tries),
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Keep last 1000 records in memory for quick queries
	if len(m.memRecords) >= 1000 {
		m.memRecords = append(m.memRecords[1:], rec)
	} else {
		m.memRecords = append(m.memRecords, rec)
	}

	// In Full mode, append to usage.jsonl
	if m.role == types.RoleFull && m.ledgerFile != nil {
		line, err := json.Marshal(rec)
		if err == nil {
			line = append(line, '\n')
			_, _ = m.ledgerFile.Write(line)
		}
	}
}

// RecentTraces returns recent traces.
func (m *Manager) RecentTraces(onlyFailedOrRetried bool) []types.RequestTrace {
	return m.traceBuffer.Recent(onlyFailedOrRetried)
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
		Model           string  `json:"model,omitempty"`
		Requests        int     `json:"requests"`
		Successes       int     `json:"successes"`
		SuccessRate     float64 `json:"success_rate,omitempty"`
		InTokens        int     `json:"in_tokens"`
		OutTokens       int     `json:"out_tokens"`
		CacheReadTokens int     `json:"cache_read_tokens"`
		ReasoningTokens int     `json:"reasoning_tokens"`
		TotalMillis     int64   `json:"total_ms"`
		AvgTTFTMillis   int64   `json:"avg_ttft_ms,omitempty"`
		ttftSum         int64
		ttftCount       int
	}

	type KeyStats struct {
		Provider      string `json:"provider"`
		KeyID         string `json:"key_id"`
		Requests      int    `json:"requests"`
		Failed        int    `json:"failed"`
		AvgTTFTMillis int64  `json:"avg_ttft_ms,omitempty"`
		ttftSum       int64
		ttftCount     int
	}

	type ProviderStats struct {
		Requests  int            `json:"requests"`
		Successes int            `json:"successes"`
		Keys      map[string]int `json:"keys"`
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
	totalReasoning := 0
	var sumTTFT int64
	var ttftCount int
	var sumTotal int64

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
		totalReasoning += r.ReasoningTokens
		if r.TTFTMillis > 0 {
			sumTTFT += r.TTFTMillis
			ttftCount++
		}
		sumTotal += r.Millis

		// Model aggregate
		ms, ok := modelMap[r.ServedModel]
		if !ok {
			ms = &ModelStats{Model: r.ServedModel}
			modelMap[r.ServedModel] = ms
		}
		ms.Requests++
		if isSuccess {
			ms.Successes++
		}
		ms.InTokens += r.InTokens
		ms.OutTokens += r.OutTokens
		ms.CacheReadTokens += r.CacheReadTokens
		ms.ReasoningTokens += r.ReasoningTokens
		ms.TotalMillis += r.Millis
		if r.TTFTMillis > 0 {
			ms.ttftSum += r.TTFTMillis
			ms.ttftCount++
		}

		// Provider aggregate
		if r.Provider != "" {
			ps, ok := provMap[r.Provider]
			if !ok {
				ps = &ProviderStats{Keys: make(map[string]int)}
				provMap[r.Provider] = ps
			}
			ps.Requests++
			if isSuccess {
				ps.Successes++
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
			if !isSuccess {
				ks.Failed++
			}
			if r.TTFTMillis > 0 {
				ks.ttftSum += r.TTFTMillis
				ks.ttftCount++
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

	var modelList []*ModelStats
	for _, ms := range modelMap {
		if ms.Requests > 0 {
			ms.SuccessRate = float64(ms.Successes) / float64(ms.Requests)
		}
		if ms.ttftCount > 0 {
			ms.AvgTTFTMillis = ms.ttftSum / int64(ms.ttftCount)
		}
		modelList = append(modelList, ms)
	}

	var keyList []*KeyStats
	for _, ks := range keyMap {
		if ks.ttftCount > 0 {
			ks.AvgTTFTMillis = ks.ttftSum / int64(ks.ttftCount)
		}
		keyList = append(keyList, ks)
	}

	return map[string]any{
		"ok":     true,
		"period": period,
		"tz":     loc.String(),
		"totals": map[string]any{
			"requests":          totalReqs,
			"success":           totalSuccess,
			"failed":            totalReqs - totalSuccess,
			"retried_requests":  totalRetried,
			"input_tokens":      totalIn,
			"output_tokens":     totalOut,
			"cache_read_tokens": totalCacheRead,
			"reasoning_tokens":  totalReasoning,
			"avg_ttft_ms":       avgTTFT,
			"avg_total_ms":      avgTotal,
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

func (m *Manager) loadRecordsSince(cutoff int64) []UsageRecord {
	m.mu.Lock()
	defer m.mu.Unlock()

	// If no ledger file, return in-memory records
	if m.ledgerPath == "" {
		out := make([]UsageRecord, len(m.memRecords))
		copy(out, m.memRecords)
		return out
	}

	// Read from usage.jsonl
	f, err := os.Open(m.ledgerPath)
	if err != nil {
		out := make([]UsageRecord, len(m.memRecords))
		copy(out, m.memRecords)
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

// Close closes the underlying ledger file.
func (m *Manager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ledgerFile != nil {
		err := m.ledgerFile.Close()
		m.ledgerFile = nil
		return err
	}
	return nil
}
