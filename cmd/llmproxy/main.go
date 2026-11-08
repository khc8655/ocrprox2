// main package for LLMProxy2 (Go Gateway Kernel).
package main

import (
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
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/khc8655/llmproxy2/internal/admin"
	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/hubsync"
	"github.com/khc8655/llmproxy2/internal/kb"
	"github.com/khc8655/llmproxy2/internal/modesched"
	"github.com/khc8655/llmproxy2/internal/oauth"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/router"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

var (
	version    = "v20261108-01"
	commit     = "dev"
	AppVersion = "2.0.0"
)

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
	hubURLFlag := flag.String("hub-url", envOr("LLMPROXY_HUB_URL", envOr("HUB_URL", envOr("EDGEONE_HUB_URL", ""))), "EdgeOne Hub URL (lite mode)")
	nodeTokenFlag := flag.String("node-token", envOr("LLMPROXY_NODE_TOKEN", envOr("NODE_TOKEN", "")), "Node authorization token (lite mode)")
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

	// Initialize Observability Sink
	obsMgr, err := obs.NewManager(role, logDir)
	if err != nil {
		log.Printf("warn: obs manager init: %v", err)
	}
	defer obsMgr.Close()

	// Initialize Authenticator
	authMgr := auth.NewAuthenticator(*clientKeyFlag, *adminPassFlag)

	// Initialize Config Source according to Role
	var configSrc types.ConfigSource
	var localSrc *config.LocalSource
	var hubSrc *hubsync.HubSource

	if role == types.RoleLite {
		hubSrc = hubsync.NewHubSource(*hubURLFlag, *nodeTokenFlag, *allowPrivateFlag)
		configSrc = hubSrc
	} else {
		passphrase := *encryptKeyFlag
		if passphrase == "" {
			passphrase = *adminPassFlag
		}
		localSrc, err = config.NewLocalSource(*configDirFlag, passphrase)
		if err != nil {
			log.Fatalf("local config source error: %v", err)
		}
		configSrc = localSrc
	}

	// Initialize Core Scheduler
	sched := scheduler.NewScheduler(configSrc, obsMgr, *allowPrivateFlag)

	// Initialize KB Pipeline, ModeScheduler, and OAuth for Full mode
	var kbPipeline *kb.Pipeline
	var modeSched *modesched.ModeScheduler
	var oauthMgr *oauth.Manager

	runCtx, runCancel := context.WithCancel(context.Background())
	defer runCancel()

	if role == types.RoleFull {
		oauthMgr = oauth.NewManager(*allowPrivateFlag)
		sched.SetOAuthRefresher(oauthMgr)

		kbPipeline = kb.NewPipeline(configSrc, kb.DefaultMaxOCR, kb.DefaultMaxGlobal, *allowPrivateFlag)
		if obsMgr != nil {
			kbPipeline.SetObservabilitySink(obsMgr)
		}

		initialMode := types.ModeAgent
		if localSrc != nil {
			if snap, _ := localSrc.Current(context.Background(), false); snap != nil && snap.Config != nil && snap.Config.Settings.RunMode != "" {
				initialMode = snap.Config.Settings.RunMode
			}
		}
		modeSched = modesched.NewModeScheduler(initialMode, *allowPrivateFlag)

		modeSched.Start(runCtx, func() (types.RuntimeSettings, error) {
			snap, err := configSrc.Current(context.Background(), false)
			if err != nil || snap == nil || snap.Config == nil {
				return types.RuntimeSettings{}, errors.New("no config")
			}
			return snap.Config.Settings, nil
		}, nil)
	}

	// Helper function to get current effective RunMode
	getEffectiveMode := func(ctx context.Context) types.RunMode {
		if role == types.RoleLite {
			return types.ModeAgent
		}
		snap, err := configSrc.Current(ctx, false)
		if err == nil && snap != nil && snap.Config != nil {
			if snap.Config.Settings.ModeScheduleEnabled && modeSched != nil {
				return modeSched.CurrentMode()
			}
			if snap.Config.Settings.RunMode != "" {
				return snap.Config.Settings.RunMode
			}
		}
		if modeSched != nil {
			return modeSched.CurrentMode()
		}
		return types.ModeAgent
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

	// 3. /v1/models (with X-Node-Refresh: 1 and Mode Gating)
	handleModels := wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		forceRefresh := r.Header.Get("X-Node-Refresh") == "1"
		snap, err := configSrc.Current(r.Context(), forceRefresh)
		if err != nil || snap == nil || snap.Config == nil {
			http.Error(w, "config unavailable", http.StatusServiceUnavailable)
			return
		}

		mode := getEffectiveMode(r.Context())
		if mode == types.ModeKB {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"object": "list",
				"data": []map[string]any{
					{"id": "chat", "object": "model", "created": snap.LoadedAt.Unix(), "owned_by": "llmproxy-kb"},
					{"id": "embedding", "object": "model", "created": snap.LoadedAt.Unix(), "owned_by": "llmproxy-kb"},
					{"id": "reranker", "object": "model", "created": snap.LoadedAt.Unix(), "owned_by": "llmproxy-kb"},
					{"id": "ocr", "object": "model", "created": snap.LoadedAt.Unix(), "owned_by": "llmproxy-kb"},
				},
			})
			return
		}

		type ModelItem struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			Created int64  `json:"created"`
			OwnedBy string `json:"owned_by"`
		}

		var list []ModelItem
		for mID, route := range snap.Config.AgentModels {
			if route != nil && route.Enabled {
				list = append(list, ModelItem{
					ID:      mID,
					Object:  "model",
					Created: snap.LoadedAt.Unix(),
					OwnedBy: "llmproxy",
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

		if modeSched != nil {
			modeSched.IncInflight()
			defer modeSched.DecInflight()
		}

		effectiveMode := getEffectiveMode(r.Context())

		// Mode gate: /v1/messages and /v1/responses are strictly disabled in kb mode
		isMessagesOrResponses := strings.HasSuffix(r.URL.Path, "/messages") || strings.HasSuffix(r.URL.Path, "/responses")
		if effectiveMode == types.ModeKB && isMessagesOrResponses {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"message": "endpoint disabled in kb mode",
					"type":    "invalid_request_error",
				},
			})
			return
		}

		var bodyBytes []byte
		isLarge := r.ContentLength > 1*1024*1024
		if isLarge {
			select {
			case largeBodySem <- struct{}{}:
				defer func() {
					bodyBytes = nil
					runtime.GC()
					<-largeBodySem
				}()
			case <-r.Context().Done():
				http.Error(w, "request cancelled", http.StatusRequestTimeout)
				return
			}
		}

		var err error
		bodyBytes, err = io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}

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

		// Mode gate: in kb mode for /v1/chat/completions, only model="chat" and stream=false are permitted
		if effectiveMode == types.ModeKB {
			if reqModel != "chat" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"message": "only model 'chat' is supported in kb mode",
						"type":    "invalid_request_error",
					},
				})
				return
			}
			if clientStream {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"message": "streaming is not supported in kb chat mode",
						"type":    "invalid_request_error",
					},
				})
				return
			}
			if kbPipeline != nil {
				kbPipeline.HandleChat(w, r, bodyBytes)
				return
			}
			http.Error(w, "kb pipeline unavailable", http.StatusServiceUnavailable)
			return
		}

		_ = sched.Dispatch(r.Context(), r.URL.Path, bodyBytes, reqModel, clientStream, w, r)
		if isLarge {
			bodyBytes = nil
		}
	})

	mux.HandleFunc("POST /v1/chat/completions", handleInference)
	mux.HandleFunc("POST /api/v1/chat/completions", handleInference)
	mux.HandleFunc("POST /v1/messages", handleInference)
	mux.HandleFunc("POST /api/v1/messages", handleInference)
	mux.HandleFunc("POST /v1/responses", handleInference)
	mux.HandleFunc("POST /api/v1/responses", handleInference)

	// 5. Full Mode: KB endpoints & Admin management
	if role == types.RoleFull {
		wrapKBMode := func(handler http.HandlerFunc) http.HandlerFunc {
			return wrapAuth(func(w http.ResponseWriter, r *http.Request) {
				mode := getEffectiveMode(r.Context())
				if mode == types.ModeAgent {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusNotFound)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"error": map[string]any{
							"message": "kb endpoint disabled in agent mode",
							"type":    "invalid_request_error",
						},
					})
					return
				}
				handler(w, r)
			})
		}

		mux.HandleFunc("POST /v1/ocr", wrapKBMode(kbPipeline.HandleOCR))
		mux.HandleFunc("POST /api/v1/ocr", wrapKBMode(kbPipeline.HandleOCR))
		mux.HandleFunc("POST /v1/embeddings", wrapKBMode(kbPipeline.HandleEmbeddings))
		mux.HandleFunc("POST /api/v1/embeddings", wrapKBMode(kbPipeline.HandleEmbeddings))
		mux.HandleFunc("POST /v1/rerank", wrapKBMode(kbPipeline.HandleRerank))
		mux.HandleFunc("POST /api/v1/rerank", wrapKBMode(kbPipeline.HandleRerank))

		adminSrv := admin.NewServer(authMgr, localSrc, obsMgr, sched)
		adminSrv.SetModeScheduler(modeSched)
		adminSrv.SetOAuthManager(oauthMgr)
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

	listener, err := listenDualStack(bindAddr)
	if err != nil {
		log.Printf("warn: dual-stack listen on %s failed (%v), falling back to standard tcp", bindAddr, err)
		listener, err = net.Listen("tcp", bindAddr)
		if err != nil {
			log.Fatalf("fatal: failed to listen on %s: %v", bindAddr, err)
		}
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
	runCancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if modeSched != nil {
		log.Println("draining active requests...")
		modeSched.Drain(5 * time.Second)
	}

	_ = server.Shutdown(shutdownCtx)
	log.Println("llmproxy exited cleanly")
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
