package admin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/khc8655/llmproxy2/internal/auth"
	"github.com/khc8655/llmproxy2/internal/config"
	"github.com/khc8655/llmproxy2/internal/obs"
	"github.com/khc8655/llmproxy2/internal/router"
	"github.com/khc8655/llmproxy2/internal/scheduler"
	"github.com/khc8655/llmproxy2/internal/types"
)

func TestSystemVersionCheckUpdateAndMultiAccessKeys(t *testing.T) {
	tmpDir := t.TempDir()
	localSrc, err := config.NewLocalSource(tmpDir, "testpass")
	if err != nil {
		t.Fatalf("NewLocalSource: %v", err)
	}
	obsMgr, _ := obs.NewManager(types.RoleFull, tmpDir)
	defer obsMgr.Close()
	authMgr := auth.NewAuthenticator("sk-init", "adminpass")
	sched := scheduler.NewScheduler(localSrc, obsMgr, true)

	srv := NewServer(authMgr, localSrc, obsMgr, sched)
	srv.SetAllowPrivate(true)
	srv.SetBuildInfo("v20261115-06", "2.2.1", "abc1234")

	// Mock GitHub Releases API
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name":     "v20261117-01",
			"name":         "LLMProxy2 2.3.0",
			"body":         "- Added Hub Lite config\n- Upgraded Magpie stats UI",
			"published_at": "2026-11-17T08:00:00Z",
			"assets": []map[string]any{
				{"name": "llmproxy-linux-amd64", "browser_download_url": "https://example.com/bin"},
				{"name": "SHA256SUMS", "browser_download_url": "https://example.com/SHA256SUMS"},
			},
		})
	}))
	defer mockGH.Close()
	srv.updateAPIBase = mockGH.URL

	mux := router.NewRouteMux()
	srv.RegisterRoutes(mux)
	if err := mux.Validate(); err != nil {
		t.Fatalf("RouteMux validation failed: %v", err)
	}

	// 1. /api/admin/system/version
	reqVer := httptest.NewRequest("GET", "/api/admin/system/version", nil)
	reqVer.Header.Set("Authorization", "Bearer adminpass")
	recVer := httptest.NewRecorder()
	mux.ServeHTTP(recVer, reqVer)
	if recVer.Code != http.StatusOK {
		t.Fatalf("version status=%d body=%s", recVer.Code, recVer.Body.String())
	}
	var verResp map[string]any
	_ = json.Unmarshal(recVer.Body.Bytes(), &verResp)
	if verResp["current_version"] != "v20261115-06" || verResp["semver"] != "2.2.1" {
		t.Fatalf("unexpected version resp: %+v", verResp)
	}

	// 2. /api/admin/system/check-update -> detects newer release
	reqUpd := httptest.NewRequest("GET", "/api/admin/system/check-update", nil)
	reqUpd.Header.Set("Authorization", "Bearer adminpass")
	recUpd := httptest.NewRecorder()
	mux.ServeHTTP(recUpd, reqUpd)
	if recUpd.Code != http.StatusOK {
		t.Fatalf("check-update status=%d", recUpd.Code)
	}
	var updResp map[string]any
	_ = json.Unmarshal(recUpd.Body.Bytes(), &updResp)
	if updResp["has_update"] != true || updResp["latest_version"] != "v20261117-01" {
		t.Fatalf("expected has_update=true & v20261117-01, got %+v", updResp)
	}

	// 3. /api/admin/access-key with proxy_keys array updates authMgr
	bodyBytes, _ := json.Marshal(map[string]any{
		"client_key": "sk-new-main",
		"proxy_keys": []string{"sk-extra-1", "sk-extra-2"},
	})
	reqKey := httptest.NewRequest("POST", "/api/admin/access-key", bytes.NewReader(bodyBytes))
	reqKey.Header.Set("Authorization", "Bearer adminpass")
	recKey := httptest.NewRecorder()
	mux.ServeHTTP(recKey, reqKey)
	if recKey.Code != http.StatusOK {
		t.Fatalf("access-key status=%d body=%s", recKey.Code, recKey.Body.String())
	}
	primary, extras := authMgr.GetClientKeys()
	if primary != "sk-new-main" || len(extras) != 2 {
		t.Fatalf("unexpected updated keys: primary=%q extras=%v", primary, extras)
	}
}

func TestSystemUpgrade_MandatorySHA256FailsClosed(t *testing.T) {
	binName := fmt.Sprintf("llmproxy-%s-%s", runtime.GOOS, runtime.GOARCH)

	cases := []struct {
		name           string
		omitChecksum   bool
		checksumStatus int
		checksumBody   string
	}{
		{
			name:         "missing SHA256SUMS asset in release",
			omitChecksum: true,
		},
		{
			name:           "SHA256SUMS returns 404",
			checksumStatus: http.StatusNotFound,
			checksumBody:   "not found",
		},
		{
			name:           "SHA256SUMS missing entry for binary",
			checksumStatus: http.StatusOK,
			checksumBody:   "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  other-binary\n",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var binDownloads atomic.Int32
			var baseURL string
			mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/releases/latest"):
					assets := []map[string]any{
						{"name": binName, "browser_download_url": baseURL + "/download/" + binName},
					}
					if !tc.omitChecksum {
						assets = append(assets, map[string]any{
							"name":                 "SHA256SUMS",
							"browser_download_url": baseURL + "/download/SHA256SUMS",
						})
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]any{
						"tag_name": "v20261199-01",
						"assets":   assets,
					})
				case r.URL.Path == "/download/SHA256SUMS":
					w.WriteHeader(tc.checksumStatus)
					_, _ = w.Write([]byte(tc.checksumBody))
				case strings.HasPrefix(r.URL.Path, "/download/"):
					binDownloads.Add(1)
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write(bytes.Repeat([]byte("X"), 2048))
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer mockGH.Close()
			baseURL = mockGH.URL

			tmpDir := t.TempDir()
			localSrc, _ := config.NewLocalSource(tmpDir, "pass")
			authMgr := auth.NewAuthenticator("sk-init", "adminpass")
			srv := NewServer(authMgr, localSrc, nil, nil)
			srv.SetAllowPrivate(true)
			srv.updateAPIBase = mockGH.URL

			mux := http.NewServeMux()
			srv.RegisterRoutes(mux)

			req := httptest.NewRequest(http.MethodPost, "/api/admin/system/upgrade", nil)
			req.Header.Set("Authorization", "Bearer adminpass")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadGateway {
				t.Fatalf("expected 502 Bad Gateway when SHA256SUMS invalid/missing, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "missing or unverifiable SHA256SUMS for release asset") {
				t.Fatalf("unexpected error body: %s", rec.Body.String())
			}
			if binDownloads.Load() != 0 {
				t.Fatalf("SEC-05 violation: binary download URL was requested %d times before SHA256SUMS verification!", binDownloads.Load())
			}
		})
	}
}
