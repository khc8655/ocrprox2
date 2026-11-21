// Package obs provides observability: log scrubbing with 5MB rotation, request tracing, and usage accounting.
//
// applog.go adapts magpie's internal/applog (scrub rules and rotation kept, GUI lifecycle dropped):
// see docs/MAGPIE_UPSTREAM_SYNC.md §3.3.
package obs

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/khc8655/llmproxy2/internal/types"
)

const (
	LogName    = "app.log"
	OldLogName = "app.old.log"
	Limit      = 5 << 20 // 5 MiB
)

var (
	current atomic.Pointer[string]
	active  atomic.Pointer[logFile]
)

type logFile struct {
	mu    sync.Mutex
	path  string
	old   string
	limit int64
	f     *os.File
	size  int64
}

// ScrubWriter wraps an io.Writer and masks credentials before writing.
type ScrubWriter struct {
	Writer io.Writer
}

func (s ScrubWriter) Write(p []byte) (int, error) {
	scrubbed := Scrub(p)
	_, err := s.Writer.Write(scrubbed)
	return len(p), err
}

var secrets = []struct {
	re   *regexp.Regexp
	keep string
}{
	{regexp.MustCompile(`(?i)\b((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}`), "${1}…"},
	{regexp.MustCompile(`(?i)([?&](?:key|api[_-]?key|apikey|access_token|refresh_token|id_token|token|auth|sig|signature|code)=)[^&\s"'<>]+`), "${1}…"},
	{regexp.MustCompile(`(?i)((?:x-api-key|x-goog-api-key|api-key)["']?\s*[:=]\s*["']?)[^\s"',;&<>}{]+`), "${1}…"},
	{regexp.MustCompile(`\b(stk_node_)[a-fA-F0-9]{16,}`), "${1}…"},
	{regexp.MustCompile(`\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}`), "${1}…"},
	{regexp.MustCompile(`\b(nvapi-)[A-Za-z0-9_-]{12,}`), "${1}…"},
	{regexp.MustCompile(`\b(gsk_)[A-Za-z0-9_-]{12,}`), "${1}…"},
	{regexp.MustCompile(`\b(xai-)[A-Za-z0-9_-]{12,}`), "${1}…"},
	{regexp.MustCompile(`\b(pplx-)[A-Za-z0-9_-]{12,}`), "${1}…"},
	{regexp.MustCompile(`\b(AIza)[0-9A-Za-z_-]{20,}`), "${1}…"},
	{regexp.MustCompile(`\b(gh[opsur]_)[A-Za-z0-9]{20,}`), "${1}…"},
	{regexp.MustCompile(`\b(eyJ)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), "${1}…"},
}

// Scrub removes sensitive API keys and tokens from byte slices.
func Scrub(p []byte) []byte {
	for _, s := range secrets {
		p = s.re.ReplaceAll(p, []byte(s.keep))
	}
	return p
}

// ScrubString scrubs sensitive substrings in a string.
func ScrubString(s string) string {
	return string(Scrub([]byte(s)))
}

// ScrubWithSecrets scrubs both exact runtime secret literals (>= 8 chars) and standard token patterns.
func ScrubWithSecrets(p []byte, extraSecrets ...string) []byte {
	out := p
	for _, sec := range extraSecrets {
		s := strings.TrimSpace(sec)
		if len(s) < 8 {
			continue
		}
		if needle := []byte(s); bytes.Contains(out, needle) {
			out = bytes.ReplaceAll(out, needle, []byte("…"))
		}
	}
	return Scrub(out)
}

// ScrubStringWithSecrets scrubs both exact runtime secret literals (>= 8 chars) and standard token patterns in a string.
func ScrubStringWithSecrets(s string, extraSecrets ...string) string {
	return string(ScrubWithSecrets([]byte(s), extraSecrets...))
}

// InitAppLog initializes logging for lite or full mode.
// In lite mode, only writes to stderr with scrubbing (zero disk files).
// In full mode, tees output to stderr and 5MB rotating app.log.
func InitAppLog(role types.Role, logDir, version string) (string, error) {
	if role == types.RoleLite || logDir == "" {
		log.SetOutput(ScrubWriter{Writer: os.Stderr})
		log.Printf("llmproxy %s started (role=%s, pid=%d, %s/%s) [lite: zero disk logs]",
			version, role, os.Getpid(), runtime.GOOS, runtime.GOARCH)
		return "", nil
	}

	if err := os.MkdirAll(logDir, 0o700); err != nil {
		log.SetOutput(ScrubWriter{Writer: os.Stderr})
		return "", err
	}

	path := filepath.Join(logDir, LogName)
	w := &logFile{
		path:  path,
		old:   filepath.Join(logDir, OldLogName),
		limit: Limit,
	}

	if err := w.reopen(false); err != nil {
		log.SetOutput(ScrubWriter{Writer: os.Stderr})
		return "", err
	}

	log.SetOutput(io.MultiWriter(ScrubWriter{Writer: os.Stderr}, w))
	if was := active.Swap(w); was != nil {
		was.Close()
	}
	current.Store(&path)

	log.Printf("llmproxy %s started (role=%s, pid=%d, %s/%s); log=%s",
		version, role, os.Getpid(), runtime.GOOS, runtime.GOARCH, path)
	return path, nil
}

func (w *logFile) reopen(truncate bool) error {
	flag := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if truncate {
		flag |= os.O_TRUNC
	}
	f, err := os.OpenFile(w.path, flag, 0o600)
	if err != nil {
		return err
	}
	w.f, w.size = f, 0
	if fi, err := f.Stat(); err == nil {
		w.size = fi.Size()
	}
	_ = debug.SetCrashOutput(f, debug.CrashOptions{})
	return nil
}

func (w *logFile) Write(p []byte) (int, error) {
	n := len(p)
	p = Scrub(p)
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return 0, errors.New("applog: log closed")
	}
	if w.size > 0 && w.size+int64(len(p)) > w.limit {
		w.rotate()
	}
	m, err := w.f.Write(p)
	w.size += int64(m)
	if err != nil {
		return 0, err
	}
	return n, nil
}

func (w *logFile) rotate() {
	_ = debug.SetCrashOutput(nil, debug.CrashOptions{})
	_ = w.f.Close()
	moved := os.Rename(w.path, w.old)
	if err := w.reopen(moved != nil); err != nil {
		w.f = nil
		return
	}
	if moved != nil {
		n, _ := fmt.Fprintf(w.f, "applog: %s couldn't rename to %s: %v\n", LogName, OldLogName, moved)
		w.size += int64(n)
	}
}

func (w *logFile) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return nil
	}
	err := w.f.Close()
	w.f = nil
	return err
}
