// Package kb provides KB (Knowledge Base) pipeline processing:
// pre-read concurrency semaphore for OCR, 20MB body buffering, failover routing, and embedding/rerank/chat dispatch.
package kb

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

const (
	MaxBodyBytes     = 20 << 20 // 20 MiB
	DefaultMaxOCR    = 4
	DefaultMaxGlobal = 16
)

var (
	ErrOCRLimitExceeded = errors.New("kb: ocr concurrency limit exceeded (429)")
	ErrBodyTooLarge     = errors.New("kb: request body exceeds 20MB limit")
	ErrNoCandidate      = errors.New("kb: no enabled candidate found for kb category")
)

// Pipeline manages KB mode traffic and resource semaphores.
type Pipeline struct {
	mu          sync.Mutex
	configSrc   types.ConfigSource
	ocrSem      chan struct{}
	globalSem   chan struct{}
	httpClient  *http.Client
	ocrMaxLimit int
	obsSink     types.ObservabilitySink
}

// NewPipeline creates a new KB Pipeline.
func NewPipeline(cfgSrc types.ConfigSource, maxOCR, maxGlobal int, allowPrivate bool) *Pipeline {
	if maxOCR <= 0 {
		maxOCR = DefaultMaxOCR
	}
	if maxGlobal <= 0 {
		maxGlobal = DefaultMaxGlobal
	}

	return &Pipeline{
		configSrc:   cfgSrc,
		ocrSem:      make(chan struct{}, maxOCR),
		globalSem:   make(chan struct{}, maxGlobal),
		httpClient:  upstream.DefaultClient(120*time.Second, allowPrivate),
		ocrMaxLimit: maxOCR,
	}
}

// SetObservabilitySink sets the observability sink for recording request traces.
func (p *Pipeline) SetObservabilitySink(sink types.ObservabilitySink) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.obsSink = sink
}

// SetHTTPClient overrides the default HTTP client (useful for unit testing).
func (p *Pipeline) SetHTTPClient(client *http.Client) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.httpClient = client
}

// HandleOCR handles /v1/ocr with pre-read semaphore guard to prevent 20MB OOM.
func (p *Pipeline) HandleOCR(w http.ResponseWriter, r *http.Request) {
	// Pre-read semaphore acquisition: REJECT WITH 429 BEFORE READING BODY!
	select {
	case p.ocrSem <- struct{}{}:
		defer func() { <-p.ocrSem }()
	default:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "ocr concurrency limit reached, please retry later",
				"type":    "rate_limit_error",
				"code":    "ocr_max_inflight_exceeded",
			},
		})
		return
	}

	p.dispatchKBRequest("ocr", "/v1/ocr", w, r, nil)
}

// HandleEmbeddings handles /v1/embeddings.
func (p *Pipeline) HandleEmbeddings(w http.ResponseWriter, r *http.Request) {
	p.dispatchKBRequest("embedding", "/v1/embeddings", w, r, nil)
}

// HandleRerank handles /v1/rerank.
func (p *Pipeline) HandleRerank(w http.ResponseWriter, r *http.Request) {
	p.dispatchKBRequest("reranker", "/v1/rerank", w, r, nil)
}

// HandleChat handles /v1/chat/completions for KB mode (category="chat", stream=false).
func (p *Pipeline) HandleChat(w http.ResponseWriter, r *http.Request, bodyBytes []byte) {
	p.dispatchKBRequest("chat", "/v1/chat/completions", w, r, bodyBytes)
}

func (p *Pipeline) dispatchKBRequest(category, endpoint string, w http.ResponseWriter, r *http.Request, preReadBody []byte) {
	// Global concurrency semaphore
	select {
	case p.globalSem <- struct{}{}:
		defer func() { <-p.globalSem }()
	case <-r.Context().Done():
		return
	}

	var bodyBytes []byte
	if preReadBody != nil {
		bodyBytes = preReadBody
	} else {
		var err error
		bodyBytes, err = io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}
	}

	if len(bodyBytes) > MaxBodyBytes {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": "payload exceeds 20MB limit",
				"type":    "invalid_request_error",
			},
		})
		return
	}

	snap, err := p.configSrc.Current(r.Context(), false)
	if err != nil || snap == nil || snap.Config == nil {
		http.Error(w, "configuration unavailable", http.StatusServiceUnavailable)
		return
	}

	candidates := snap.Config.KBModels[category]
	var enabledCandidates []*types.KBCandidate
	for _, c := range candidates {
		if c != nil && c.Enabled {
			enabledCandidates = append(enabledCandidates, c)
		}
	}

	if len(enabledCandidates) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message": fmt.Sprintf("no enabled candidate configured for kb %s", category),
				"type":    "invalid_request_error",
			},
		})
		return
	}

	startTime := time.Now()
	trace := types.RequestTrace{
		ID:        fmt.Sprintf("kb_%x", time.Now().UnixNano()),
		Timestamp: startTime.Unix(),
		Mode:      "kb",
		Endpoint:  endpoint,
		ReqModel:  category,
		Tries:     make([]types.Try, 0, len(enabledCandidates)),
	}

	p.mu.Lock()
	sink := p.obsSink
	client := p.httpClient
	p.mu.Unlock()

	var lastStatus int = http.StatusBadGateway
	var lastErrSnippet string = "all candidates failed"

	for _, cand := range enabledCandidates {
		prov, ok := snap.Config.Providers[cand.Provider]
		if !ok || !prov.Enabled {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				Model:        cand.Model,
				Status:       http.StatusServiceUnavailable,
				Millis:       0,
				Reason:       "provider_disabled",
				ErrorSnippet: "provider not found or disabled",
			})
			continue
		}

		var apiKey string
		var keyLabel string
		for _, k := range prov.APIKeys {
			if k.Enabled && (cand.KeyLabel == "" || k.Label == cand.KeyLabel || k.ID == cand.KeyLabel) {
				apiKey = k.Key
				keyLabel = k.Label
				if keyLabel == "" {
					keyLabel = k.ID
				}
				break
			}
		}

		if apiKey == "" {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				Model:        cand.Model,
				Status:       http.StatusUnauthorized,
				Millis:       0,
				Reason:       "auth_error",
				ErrorSnippet: "no matching enabled api key for candidate",
			})
			continue
		}

		targetModel := cand.Model
		if targetModel == "" {
			targetModel = category
		}

		reqBytes := bodyBytes
		if cand.Model != "" && cand.Model != category {
			var parsed map[string]any
			if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
				parsed["model"] = cand.Model
				if mutated, err := json.Marshal(parsed); err == nil {
					reqBytes = mutated
				}
			}
		}

		targetURL := upstream.JoinUpstream(prov.BaseURL, endpoint)
		upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, targetURL, bytes.NewReader(reqBytes))
		if err != nil {
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       http.StatusInternalServerError,
				Millis:       0,
				Reason:       "internal_error",
				ErrorSnippet: obs.ScrubString(err.Error()),
			})
			continue
		}

		upReq.Header.Set("Authorization", "Bearer "+apiKey)
		upReq.Header.Set("Content-Type", "application/json")

		startTry := time.Now()
		resp, err := client.Do(upReq)
		elapsed := time.Since(startTry).Milliseconds()

		if err != nil {
			lastStatus = http.StatusBadGateway
			lastErrSnippet = err.Error()
			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       http.StatusBadGateway,
				Millis:       elapsed,
				Reason:       "network_error",
				ErrorSnippet: obs.ScrubString(err.Error()),
			})
			continue
		}

		// Check for retryable upstream errors (429 or 5xx)
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			snipBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 240))
			_ = resp.Body.Close()

			lastStatus = resp.StatusCode
			lastErrSnippet = string(snipBytes)
			reason := "server_error"
			if resp.StatusCode == http.StatusTooManyRequests {
				reason = "rate_limit"
			}

			trace.Tries = append(trace.Tries, types.Try{
				Attempt:      len(trace.Tries) + 1,
				Provider:     cand.Provider,
				KeyID:        keyLabel,
				Model:        targetModel,
				Status:       resp.StatusCode,
				Millis:       elapsed,
				Reason:       reason,
				ErrorSnippet: obs.ScrubString(string(snipBytes)),
			})
			continue
		}

		// Success or non-retryable response (e.g. 200 OK or 400 Client Error)
		defer resp.Body.Close()

		trace.Tries = append(trace.Tries, types.Try{
			Attempt:  len(trace.Tries) + 1,
			Provider: cand.Provider,
			KeyID:    keyLabel,
			Model:    targetModel,
			Status:   resp.StatusCode,
			Millis:   elapsed,
		})
		trace.WinnerProvider = cand.Provider
		trace.WinnerKey = keyLabel
		trace.ServedModel = targetModel
		trace.Status = resp.StatusCode
		trace.TotalMillis = time.Since(startTime).Milliseconds()

		if sink != nil {
			sink.RecordRequest(trace)
		}

		for k, vv := range resp.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
		return
	}

	// All candidates failed
	trace.Status = lastStatus
	trace.TotalMillis = time.Since(startTime).Milliseconds()
	if sink != nil {
		sink.RecordRequest(trace)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(lastStatus)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": "all kb upstream candidates failed: " + obs.ScrubString(lastErrSnippet),
			"type":    "upstream_error",
		},
	})
}
