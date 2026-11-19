// main package for LLMProxy2 (Go Gateway Kernel).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/khc8655/llmproxy2/internal/admin"
	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/hubsync"
	"github.com/khc8655/llmproxy2/internal/kb"
	"github.com/khc8655/llmproxy2/internal/oauth"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/router"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/usagecount"
)

var (
	// Release metadata. scripts/build-release.mjs overrides these via -ldflags;
	// the literals below are the fallback for plain `go build` and must be kept
	// in sync with version.json (guarded by npm run verify:release).
	version    = "v20261119-03"
	commit     = "dev"
	AppVersion = "2.6.0"

	// Buffer pool for reusable request byte buffers (zero allocations on hot path)
	bufferPool = sync.Pool{
		New: func() any {
			return new(bytes.Buffer)
		},
	}
)

const (
	largeBodyThreshold = 1 << 20  // 1 MiB threshold for largeBodySem serialization (F-04)
	maxRequestBodySize = 20 << 20 // 20 MiB hard limit (P3)
)

func writePayloadTooLarge(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusRequestEntityTooLarge)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": "payload too large: request body exceeds 20MB limit",
			"type":    "invalid_request_error",
			"code":    "payload_too_large",
		},
	})
}

// readInferenceBody reads and bounds an inference request body up to maxRequestBodySize (20 MiB).
// For 64MB Lite node OOM safety (F-04), largeBodySem is acquired BEFORE buffering > 1 MiB:
//   - If Content-Length > 1 MiB, largeBodySem is acquired before allocating/reading any bytes.
//   - If Content-Length < 0 (chunked), at most 1 MiB + 1 bytes are read first; if > 1 MiB,
//     largeBodySem is acquired before reading the remainder.
//
// Callers MUST invoke cleanup() via defer once bodyBytes is no longer referenced; pooled buffers
// are returned only inside cleanup() (never while bodyBytes is still live, preventing UAF).
func readInferenceBody(w http.ResponseWriter, r *http.Request, largeBodySem chan struct{}) (bodyBytes []byte, cleanup func(), ok bool) {
	noop := func() {}
	if r.ContentLength > maxRequestBodySize {
		writePayloadTooLarge(w)
		return nil, noop, false
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)

	acquired := false
	acquireSem := func() bool {
		if acquired || largeBodySem == nil {
			return true
		}
		select {
		case largeBodySem <- struct{}{}:
			acquired = true
			return true
		case <-r.Context().Done():
			http.Error(w, "request cancelled", http.StatusRequestTimeout)
			return false
		}
	}
	releaseSem := func() {
		if acquired {
			acquired = false
			<-largeBodySem
		}
	}

	writeReadErr := func(err error) {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writePayloadTooLarge(w)
			return
		}
		http.Error(w, "failed to read body", http.StatusBadRequest)
	}

	// Known large body (> 1 MiB): acquire semaphore BEFORE allocating or reading bytes.
	if r.ContentLength > largeBodyThreshold {
		if !acquireSem() {
			return nil, noop, false
		}
		buf := bytes.NewBuffer(make([]byte, 0, int(r.ContentLength)))
		if _, err := buf.ReadFrom(r.Body); err != nil {
			releaseSem()
			writeReadErr(err)
			return nil, noop, false
		}
		return buf.Bytes(), releaseSem, true
	}

	// Small or unknown-length (chunked) body: read up to 1 MiB + 1 bytes first.
	buf := bufferPool.Get().(*bytes.Buffer)
	buf.Reset()
	returnBufIfSmall := func() {
		if buf.Cap() <= largeBodyThreshold {
			buf.Reset()
			bufferPool.Put(buf)
		}
	}

	if _, err := buf.ReadFrom(io.LimitReader(r.Body, largeBodyThreshold+1)); err != nil {
		returnBufIfSmall()
		writeReadErr(err)
		return nil, noop, false
	}

	// Exceeded 1 MiB on chunked/unknown stream: acquire semaphore BEFORE reading remainder.
	if buf.Len() > largeBodyThreshold {
		if !acquireSem() {
			// Do not return >1 MiB buffer to pool; allow GC to reclaim immediately.
			return nil, noop, false
		}
		if _, err := buf.ReadFrom(r.Body); err != nil {
			releaseSem()
			writeReadErr(err)
			return nil, noop, false
		}
		return buf.Bytes(), releaseSem, true
	}

	// Body <= 1 MiB: return pooled buffer ONLY after caller finishes using bodyBytes.
	return buf.Bytes(), returnBufIfSmall, true
}

func init() {
	// Step 1: Disable core dumps immediately on startup
	disableCoreDumps()
}

func disableCoreDumps() {
	var rlim syscall.Rlimit
	rlim.Cur = 0
	rlim.Max = 0
	_ = syscall.Setrlimit(syscall.RLIMIT_CORE, &rlim)
}

func main() {
	// Parse CLI Flags with environment variable fallbacks
	roleFlag := flag.String("role", envOr("LLMPROXY_ROLE", "full"), "Gateway role: lite or full")
	addrFlag := flag.String("addr", envOr("LLMPROXY_ADDR", ""), "Bind address (e.g. [::]:8000)")
	portFlag := flag.Int("port", envIntOr("PORT", 8080), "Server port")
	hostFlag := flag.String("host", envOr("HOST", ""), "Bind host (default dual-stack ::)")
	configDirFlag := flag.String("config-dir", envOr("CONFIG_DIR", "/opt/ocrproxy/config"), "Config directory")
	clientKeyFlag := flag.String("client-key", envOr("LLMPROXY_CLIENT_KEY", envOr("CLIENT_KEY", envOr("PROXY_API_KEY", ""))), "Client authentication key")
	adminPassFlag := flag.String("admin-pass", envOr("ADMIN_PASSWORD", ""), "Admin management password")
	encryptKeyFlag := flag.String("encrypt-key", envOr("ENCRYPT_KEY", ""), "Encryption passphrase for local config (defaults to admin-pass)")
	hubURLFlag := flag.String("hub-url", envOr("LLMPROXY_HUB_URL", envOr("HUB_URL", envOr("EDGEONE_HUB_URL", ""))), "EdgeOne Hub URL (lite sync / full default vault)")
	nodeTokenFlag := flag.String("node-token", envOr("LLMPROXY_NODE_TOKEN", envOr("NODE_TOKEN", "")), "Node authorization token (lite sync / full default vault)")
	allowPrivateFlag := flag.Bool("allow-private", envBoolOr("ALLOW_PRIVATE_IPS", false), "Allow private upstream IPs")
	versionFlag := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Printf("llmproxy %s (semver %s, commit %s)\n", version, AppVersion, commit)
		os.Exit(0)
	}

	role := types.Role(strings.ToLower(*roleFlag))
	if role != types.RoleLite && role != types.RoleFull {
		log.Fatalf("invalid role %q, must be lite or full", role)
	}

	// Initialize Logging & Scrubbing
	logDir := ""
	if role == types.RoleFull {
		logDir = *configDirFlag
	}
	_, _ = obs.InitAppLog(role, logDir, AppVersion)

	// Initialize Observability Sink (zero allocation & zero trace/usage RAM in Lite mode)
	var obsMgr *obs.Manager
	var obsSink types.ObservabilitySink
	if role == types.RoleFull {
		var err error
		obsMgr, err = obs.NewManager(role, logDir)
		if err != nil {
			log.Printf("warn: obs manager init: %v", err)
		} else {
			obsSink = obsMgr
			defer obsMgr.Close()
		}
	}

	// Initialize Authenticator (D6: supports hot-reload & multi-keys)
	cliClientKey := strings.TrimSpace(*clientKeyFlag)
	authMgr := auth.NewAuthenticator(cliClientKey, *adminPassFlag)

	updateAuthFromSettings := func(cfg *types.ProxyConfig) {
		syncAuthKeysForRole(role, cliClientKey, cfg, authMgr)
	}

	// Initialize Config Source according to Role
	var configSrc types.ConfigSource
	var localSrc *config.LocalSource
	var hubSrc *hubsync.HubSource

	if role == types.RoleLite {
		hubSrc = hubsync.NewHubSource(*hubURLFlag, *nodeTokenFlag, *allowPrivateFlag)
		hubSrc.SetNodeVersion(version)
		// Lite keeps zero-disk / near-zero-RAM semantics, so it cannot use obs.Manager
		// (trace ring + usage.jsonl). A tiny counter is enough to report which models
		// this node actually serves back to the hub.
		liteUsage := usagecount.New()
		hubSrc.SetUsageProvider(func() any { return liteUsage.Digest() })
		obsSink = liteUsage
		hubSrc.OnConfigChange(updateAuthFromSettings)
		configSrc = hubSrc
	} else {
		passphrase := *encryptKeyFlag
		if passphrase == "" {
			passphrase = *adminPassFlag
		}
		var err error
		localSrc, err = config.NewLocalSource(*configDirFlag, passphrase)
		if err != nil {
			log.Fatalf("local config source error: %v", err)
		}
		configSrc = localSrc

		// Register hot-reload callback and sync settings
		localSrc.OnConfigChange(updateAuthFromSettings)
		if snap, _ := localSrc.Current(context.Background(), false); snap != nil && snap.Config != nil {
			updateAuthFromSettings(snap.Config)
		}
	}

	// Initialize Core Scheduler
	sched := scheduler.NewScheduler(configSrc, obsSink, *allowPrivateFlag)
	if role == types.RoleFull {
		if err := sched.InitBans(role, *configDirFlag); err != nil {
			log.Printf("warn: failed to initialize persistent key bans: %v", err)
		}
	}

	// Initialize KB Pipeline and OAuth for Full mode
	var kbPipeline *kb.Pipeline
	var oauthMgr *oauth.Manager

	if role == types.RoleFull {
		oauthMgr = oauth.NewManager(*allowPrivateFlag)
		// Wire OAuth token refresh persistence to localSrc (D4)
		if localSrc != nil {
			oauthMgr.SetPersistFunc(func(ctx context.Context, entry *types.KeyEntry) error {
				return localSrc.PersistKeyEntry(ctx, entry)
			})
		}
		sched.SetOAuthRefresher(oauthMgr)

		kbPipeline = kb.NewPipeline(configSrc, kb.DefaultMaxOCR, kb.DefaultMaxGlobal, *allowPrivateFlag)
		kbPipeline.SetScheduler(sched)
	}

	// Build HTTP Route Mux
	mux := router.NewRouteMux()

	// 1. Healthz / Health
	handleHealth := func(w http.ResponseWriter, r *http.Request) {
		status, state, valid, ver := configSrc.HealthState()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":         status,
			"state":          state,
			"lease_valid":    valid,
			"version":        ver,
			"config_version": ver,
			"role":           role,
			"app_version":    version,
			"semver":         AppVersion,
			"commit":         commit,
		})
	}
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("GET /health", handleHealth)

	// 2. Client Key Enforcement Wrapper for Data Plane
	wrapAuth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !authMgr.VerifyClientKey(r) {
				// In Lite mode, client_key/proxy_keys can be projected from EdgeOne Hub.
				// If a request carries a client token before the first lazy Hub sync (or after
				// X-Node-Refresh: 1), pull/refresh the snapshot once and re-verify.
				if role == types.RoleLite && hubSrc != nil && auth.ExtractToken(r) != "" {
					_, _ = configSrc.Current(r.Context(), r.Header.Get("X-Node-Refresh") == "1")
				}
			}
			if !authMgr.VerifyClientKey(r) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"message": "Invalid client proxy API key",
						"type":    "invalid_request_error",
						"code":    "invalid_api_key",
					},
				})
				return
			}
			next(w, r)
		}
	}

	// 3. /v1/models (with X-Node-Refresh: 1; unified Agent + built-in KB 4 slots)
	handleModels := wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		forceRefresh := r.Header.Get("X-Node-Refresh") == "1"
		snap, err := configSrc.Current(r.Context(), forceRefresh)
		if err != nil || snap == nil || snap.Config == nil {
			http.Error(w, "config unavailable", http.StatusServiceUnavailable)
			return
		}

		type ModelItem struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			Created int64  `json:"created"`
			OwnedBy string `json:"owned_by"`
		}

		seen := make(map[string]bool)
		list := make([]ModelItem, 0)
		for mID, route := range snap.Config.AgentModels {
			if route != nil && route.Enabled {
				seen[mID] = true
				list = append(list, ModelItem{
					ID:      mID,
					Object:  "model",
					Created: snap.LoadedAt.Unix(),
					OwnedBy: "llmproxy",
				})
			}
		}

		// Surface legacy KBModels slots (chat/embedding/reranker/ocr) if configured and not yet in AgentModels
		fixedCategories := []string{"chat", "embedding", "reranker", "ocr"}
		for _, cat := range fixedCategories {
			if seen[cat] {
				continue
			}
			cands := snap.Config.KBModels[cat]
			hasEnabled := false
			for _, c := range cands {
				if c != nil && c.Enabled {
					hasEnabled = true
					break
				}
			}
			if hasEnabled && (cat == "chat" || role == types.RoleFull) {
				seen[cat] = true
				list = append(list, ModelItem{
					ID:      cat,
					Object:  "model",
					Created: snap.LoadedAt.Unix(),
					OwnedBy: "llmproxy-kb",
				})
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data":   list,
		})
	})
	mux.HandleFunc("GET /v1/models", handleModels)
	mux.HandleFunc("GET /api/v1/models", handleModels)

	// 4. Inference Dispatcher (/v1/chat/completions, /v1/messages, /v1/responses)
	largeBodySem := make(chan struct{}, 1)

	handleInference := wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		forceRefresh := r.Header.Get("X-Node-Refresh") == "1"
		if forceRefresh {
			_, _ = configSrc.Current(r.Context(), true)
		}

		bodyBytes, cleanupBody, ok := readInferenceBody(w, r, largeBodySem)
		if !ok {
			return
		}
		defer cleanupBody()

		type quickRequest struct {
			Model  string `json:"model"`
			Stream bool   `json:"stream"`
		}
		var q quickRequest
		if err := json.Unmarshal(bodyBytes, &q); err != nil {
			http.Error(w, "invalid json body", http.StatusBadRequest)
			return
		}

		reqModel := q.Model
		clientStream := q.Stream

		_ = sched.Dispatch(r.Context(), r.URL.Path, bodyBytes, reqModel, clientStream, w, r)
	})

	mux.HandleFunc("POST /v1/chat/completions", handleInference)
	mux.HandleFunc("POST /api/v1/chat/completions", handleInference)
	mux.HandleFunc("POST /v1/messages", handleInference)
	mux.HandleFunc("POST /api/v1/messages", handleInference)
	mux.HandleFunc("POST /v1/responses", handleInference)
	mux.HandleFunc("POST /api/v1/responses", handleInference)

	// 5. Full Mode: Specialized KB/RAG endpoints (/v1/ocr, /v1/embeddings, /v1/rerank) always active & Admin management
	if role == types.RoleFull {
		wrapKBRoute := func(handler http.HandlerFunc) http.HandlerFunc {
			return wrapAuth(func(w http.ResponseWriter, r *http.Request) {
				if r.ContentLength > maxRequestBodySize {
					writePayloadTooLarge(w)
					return
				}
				r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)
				handler(w, r)
			})
		}

		mux.HandleFunc("POST /v1/ocr", wrapKBRoute(kbPipeline.HandleOCR))
		mux.HandleFunc("POST /api/v1/ocr", wrapKBRoute(kbPipeline.HandleOCR))
		mux.HandleFunc("POST /v1/embeddings", wrapKBRoute(kbPipeline.HandleEmbeddings))
		mux.HandleFunc("POST /api/v1/embeddings", wrapKBRoute(kbPipeline.HandleEmbeddings))
		mux.HandleFunc("POST /v1/rerank", wrapKBRoute(kbPipeline.HandleRerank))
		mux.HandleFunc("POST /api/v1/rerank", wrapKBRoute(kbPipeline.HandleRerank))

		adminSrv := admin.NewServer(authMgr, localSrc, obsMgr, sched)
		adminSrv.SetAllowPrivate(*allowPrivateFlag)
		adminSrv.SetOAuthManager(oauthMgr)
		adminSrv.SetBuildInfo(version, AppVersion, commit)
		adminSrv.SetAdminPassword(*adminPassFlag)
		if cliClientKey != "" {
			adminSrv.SetDefaultClientKey(cliClientKey)
		}
		if *hubURLFlag != "" || *nodeTokenFlag != "" {
			adminSrv.SetDefaultVault(*hubURLFlag, *nodeTokenFlag)
		}
		adminSrv.RegisterRoutes(mux)
	}

	// Validate registered routes strictly against AllowedLiteRoutes and FullOnlyRoutes
	if err := mux.Validate(); err != nil {
		log.Fatalf("fatal: route validation failed: %v", err)
	}

	// Middleware Pipeline: Security Headers -> CORS -> ReadOnlyGuard
	handler := router.SecurityHeadersMiddleware(
		router.CORSMiddleware(
			router.ReadOnlyGuard(role, mux),
		),
	)

	// Listen on dual-stack socket
	bindAddr := ""
	if *addrFlag != "" {
		bindAddr = *addrFlag
	} else if *hostFlag != "" {
		bindAddr = fmt.Sprintf("%s:%d", *hostFlag, *portFlag)
	} else {
		bindAddr = fmt.Sprintf(":%d", *portFlag)
	}

	// Listen on the requested socket. Only a wildcard/an IPv6 bind benefits from
	// clearing IPV6_V6ONLY: an explicit IPv4 address cannot be a dual-stack
	// socket, and trying would emit a misleading "dual-stack failed" warning.
	listener, err := listenFor(bindAddr)
	if err != nil {
		log.Fatalf("fatal: failed to listen on %s: %v", bindAddr, err)
	}
	defer listener.Close()

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Graceful shutdown handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("llmproxy %s running on %s (role=%s)", version, listener.Addr().String(), role)
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-sigChan
	log.Println("shutting down llmproxy...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	_ = server.Shutdown(shutdownCtx)
	log.Println("llmproxy exited cleanly")
}

// listenFor binds addr, using a dual-stack (IPv4+IPv6) socket only when the bind
// host is wildcard or IPv6. For an explicit IPv4 host the plain tcp listener is
// used directly, so no spurious dual-stack failure is reported.
func listenFor(addr string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(addr)
	if err == nil && host != "" && host != "::" {
		if ip := net.ParseIP(host); ip == nil || ip.To4() != nil {
			return net.Listen("tcp", addr)
		}
	}
	l, dualErr := listenDualStack(addr)
	if dualErr == nil {
		return l, nil
	}
	l, err = net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	return l, nil
}

func listenDualStack(addr string) (net.Listener, error) {
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var opErr error
			err := c.Control(func(fd uintptr) {
				opErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IPV6, syscall.IPV6_V6ONLY, 0)
			})
			if err != nil {
				return err
			}
			return opErr
		},
	}
	return lc.Listen(context.Background(), "tcp", addr)
}

// syncAuthKeysForRole updates Authenticator client keys according to node role:
//   - RoleFull: once Settings has any client_key / proxy_api_key / proxy_keys configured,
//     authenticate strictly against Settings so rotating keys in Full Web UI revokes the old CLI/.env key;
//     fall back to cliClientKey only if Settings has zero client keys configured.
//   - RoleLite: keep cliClientKey alongside Hub-projected Settings keys.
func syncAuthKeysForRole(role types.Role, cliClientKey string, cfg *types.ProxyConfig, authMgr *auth.Authenticator) {
	if cfg == nil || authMgr == nil {
		return
	}
	cliClientKey = strings.TrimSpace(cliClientKey)
	settingsPrimary := strings.TrimSpace(cfg.Settings.ClientKey)
	if settingsPrimary == "" {
		settingsPrimary = strings.TrimSpace(cfg.Settings.ProxyAPIKey)
	}

	if role == types.RoleFull {
		var cleanedExtras []string
		if cfg.Settings.ProxyAPIKey != "" && strings.TrimSpace(cfg.Settings.ProxyAPIKey) != settingsPrimary {
			cleanedExtras = append(cleanedExtras, strings.TrimSpace(cfg.Settings.ProxyAPIKey))
		}
		for _, pk := range cfg.Settings.ProxyKeys {
			if t := strings.TrimSpace(pk); t != "" && t != settingsPrimary {
				cleanedExtras = append(cleanedExtras, t)
			}
		}
		if settingsPrimary != "" || len(cleanedExtras) > 0 {
			if settingsPrimary == "" && len(cleanedExtras) > 0 {
				settingsPrimary = cleanedExtras[0]
				cleanedExtras = cleanedExtras[1:]
			}
			authMgr.UpdateClientKeys(settingsPrimary, cleanedExtras)
			return
		}
		authMgr.UpdateClientKeys(cliClientKey, nil)
		return
	}

	// RoleLite: preserve cliClientKey + Hub-projected Settings keys
	primary := cliClientKey
	var extras []string
	if primary == "" {
		primary = settingsPrimary
		extras = cfg.Settings.ProxyKeys
	} else {
		if cfg.Settings.ClientKey != "" && cfg.Settings.ClientKey != primary {
			extras = append(extras, cfg.Settings.ClientKey)
		}
		if cfg.Settings.ProxyAPIKey != "" && cfg.Settings.ProxyAPIKey != primary {
			extras = append(extras, cfg.Settings.ProxyAPIKey)
		}
		extras = append(extras, cfg.Settings.ProxyKeys...)
	}
	authMgr.UpdateClientKeys(primary, extras)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}

func envBoolOr(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		v = strings.ToLower(v)
		return v == "1" || v == "true" || v == "yes" || v == "on"
	}
	return fallback
}
