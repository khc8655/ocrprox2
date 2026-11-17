package admin

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const defaultGitHubRepo = "khc8655/ocrprox2"

func (s *Server) systemRepo() string {
	if r := strings.TrimSpace(os.Getenv("LLMPROXY_GITHUB_REPO")); r != "" {
		return r
	}
	if r := strings.TrimSpace(os.Getenv("GITHUB_REPO")); r != "" {
		return r
	}
	return defaultGitHubRepo
}

func (s *Server) systemBuildInfo() (ver, semver, commit string) {
	ver = strings.TrimSpace(s.buildVersion)
	semver = strings.TrimSpace(s.buildSemver)
	commit = strings.TrimSpace(s.buildCommit)
	if ver == "" {
		ver = "dev"
	}
	if semver == "" {
		semver = ver
	}
	if commit == "" {
		commit = "unknown"
	}
	return ver, semver, commit
}

func (s *Server) handleSystemVersion(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	ver, semver, commit := s.systemBuildInfo()
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":              true,
		"current_version": ver,
		"semver":          semver,
		"commit":          commit,
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"repo":            s.systemRepo(),
	})
}

type ghReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type ghLatestRelease struct {
	TagName     string           `json:"tag_name"`
	Name        string           `json:"name"`
	Body        string           `json:"body"`
	PublishedAt string           `json:"published_at"`
	HTMLURL     string           `json:"html_url"`
	Assets      []ghReleaseAsset `json:"assets"`
}

func (s *Server) fetchLatestRelease(r *http.Request) (*ghLatestRelease, error) {
	base := strings.TrimRight(s.updateAPIBase, "/")
	if base == "" {
		base = "https://api.github.com"
	}
	url := fmt.Sprintf("%s/repos/%s/releases/latest", base, s.systemRepo())
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "llmproxy2-updater")

	client := s.httpClient
	if client == nil {
		client = &http.Client{Timeout: 12 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("release server HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var rel ghLatestRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, err
	}
	return &rel, nil
}

func (s *Server) handleSystemCheckUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	ver, semver, commit := s.systemBuildInfo()
	checkedAt := time.Now().Format("2006-01-02 15:04:05")

	rel, err := s.fetchLatestRelease(r)
	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":              true,
			"network_error":   true,
			"current_version": ver,
			"semver":          semver,
			"commit":          commit,
			"error":           err.Error(),
			"checked_at":      checkedAt,
		})
		return
	}

	latest := strings.TrimSpace(rel.TagName)
	normLatest := strings.TrimPrefix(latest, "v")
	normVer := strings.TrimPrefix(ver, "v")
	normSemver := strings.TrimPrefix(semver, "v")
	hasUpdate := latest != "" && normLatest != normVer && normLatest != normSemver

	binName := fmt.Sprintf("llmproxy-%s-%s", runtime.GOOS, runtime.GOARCH)
	var downloadURL, checksumURL string
	for _, a := range rel.Assets {
		if a.Name == binName {
			downloadURL = a.BrowserDownloadURL
		} else if a.Name == "SHA256SUMS" {
			checksumURL = a.BrowserDownloadURL
		}
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":              true,
		"current_version": ver,
		"semver":          semver,
		"commit":          commit,
		"latest_version":  latest,
		"has_update":      hasUpdate,
		"title":           rel.Name,
		"release_date":    rel.PublishedAt,
		"notes":           rel.Body,
		"html_url":        rel.HTMLURL,
		"download_url":    downloadURL,
		"checksum_url":    checksumURL,
		"binary_name":     binName,
		"checked_at":      checkedAt,
	})
}

func (s *Server) handleSystemUpgrade(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	rel, err := s.fetchLatestRelease(r)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "failed to fetch latest release: " + err.Error()})
		return
	}

	binName := fmt.Sprintf("llmproxy-%s-%s", runtime.GOOS, runtime.GOARCH)
	var downloadURL, checksumURL string
	for _, a := range rel.Assets {
		if a.Name == binName {
			downloadURL = a.BrowserDownloadURL
		} else if a.Name == "SHA256SUMS" {
			checksumURL = a.BrowserDownloadURL
		}
	}
	if downloadURL == "" {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("release asset %s not found", binName)})
		return
	}

	exePath, err := os.Executable()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "resolve executable path: " + err.Error()})
		return
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}

	client := s.httpClient
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}

	// Fetch expected SHA256 if SHA256SUMS is provided
	expectedSHA := ""
	if checksumURL != "" {
		if sumReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, checksumURL, nil); err == nil {
			if sumResp, err := client.Do(sumReq); err == nil {
				sumBytes, _ := io.ReadAll(io.LimitReader(sumResp.Body, 1<<20))
				sumResp.Body.Close()
				for _, line := range strings.Split(string(sumBytes), "\n") {
					fields := strings.Fields(line)
					if len(fields) >= 2 && strings.TrimPrefix(fields[1], "*") == binName {
						expectedSHA = strings.ToLower(fields[0])
						break
					}
				}
			}
		}
	}

	binReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, downloadURL, nil)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	binResp, err := client.Do(binReq)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "download binary failed: " + err.Error()})
		return
	}
	defer binResp.Body.Close()
	if binResp.StatusCode != http.StatusOK {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("download HTTP %d", binResp.StatusCode)})
		return
	}

	tmpPath := exePath + ".upgrade.tmp"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "cannot write executable staging file: " + err.Error()})
		return
	}

	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(f, hasher), io.LimitReader(binResp.Body, 128<<20))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil || written < 1024 {
		_ = os.Remove(tmpPath)
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "failed writing downloaded binary"})
		return
	}

	actualSHA := hex.EncodeToString(hasher.Sum(nil))
	if expectedSHA != "" && actualSHA != expectedSHA {
		_ = os.Remove(tmpPath)
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": fmt.Sprintf("sha256 mismatch: expected %s, got %s", expectedSHA, actualSHA)})
		return
	}

	if err := os.Rename(tmpPath, exePath); err != nil {
		_ = os.Remove(tmpPath)
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "atomic replace failed: " + err.Error()})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":             true,
		"upgrading":      true,
		"target_version": rel.TagName,
		"sha256":         actualSHA,
		"message":        fmt.Sprintf("已替换二进制至 %s，服务正在平滑重启生效...", rel.TagName),
	})

	go func() {
		time.Sleep(500 * time.Millisecond)
		if p, err := os.FindProcess(os.Getpid()); err == nil {
			_ = p.Signal(syscall.SIGTERM)
		}
	}()
}

func (s *Server) handleSystemRestart(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"message": "服务正在发送平滑重启信号 (SIGTERM)...",
	})

	go func() {
		time.Sleep(400 * time.Millisecond)
		if p, err := os.FindProcess(os.Getpid()); err == nil {
			_ = p.Signal(syscall.SIGTERM)
		}
	}()
}
