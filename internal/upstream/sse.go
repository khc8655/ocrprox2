package upstream

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// ReadSSE walks a server-sent event stream, calling fn with each event's name and data.
// It detects bare JSON error responses that some upstreams send inside a 200 SSE stream.
func ReadSSE(r io.Reader, fn func(event, data string) error, alive func()) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 32<<20)

	var event string
	var data []string

	flush := func() error {
		if len(data) == 0 {
			event = ""
			return nil
		}
		err := fn(event, strings.Join(data, "\n"))
		event, data = "", nil
		if err == nil && alive != nil {
			alive()
		}
		return err
	}

	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)

		// Check if upstream returned a bare JSON error object instead of data:
		if strings.HasPrefix(trimmed, `{"error"`) || strings.HasPrefix(trimmed, `{"code"`) {
			if err := fn("error", trimmed); err != nil {
				return err
			}
			continue
		}

		switch {
		case line == "":
			if err := flush(); err != nil {
				return err
			}
		case strings.HasPrefix(line, ":"):
			if alive != nil {
				alive()
			}
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(line[5:], " "))
		}
	}

	if err := flush(); err != nil {
		return err
	}
	return sc.Err()
}

// SSEWriter writes server-sent events to an HTTP response writer.
type SSEWriter struct {
	w     http.ResponseWriter
	f     http.Flusher
	begun bool
	wrote time.Time
}

// NewSSEWriter creates a new SSEWriter.
func NewSSEWriter(w http.ResponseWriter) *SSEWriter {
	f, _ := w.(http.Flusher)
	return &SSEWriter{w: w, f: f}
}

// Begin initializes SSE response headers and status code.
func (s *SSEWriter) Begin() {
	if s.begun {
		return
	}
	s.begun = true
	h := s.w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	s.w.WriteHeader(http.StatusOK)
	s.Flush()
	s.wrote = time.Now()
}

// Flush flushes buffered data to client.
func (s *SSEWriter) Flush() {
	if s.f != nil {
		s.f.Flush()
	}
}

// Quiet returns duration since last write.
func (s *SSEWriter) Quiet() time.Duration {
	if !s.begun {
		return 1<<63 - 1
	}
	return time.Since(s.wrote)
}

// Comment writes an SSE comment line (: comment\n).
func (s *SSEWriter) Comment(text string) {
	s.Begin()
	_, _ = io.WriteString(s.w, ": "+text+"\n")
	s.Flush()
	s.wrote = time.Now()
}

// Event writes a single SSE event.
func (s *SSEWriter) Event(name string, v any) error {
	s.Begin()
	var b bytes.Buffer
	if name != "" {
		b.WriteString("event: ")
		b.WriteString(name)
		b.WriteByte('\n')
	}
	b.WriteString("data: ")
	switch x := v.(type) {
	case string:
		b.WriteString(x)
	case []byte:
		b.Write(x)
	case json.RawMessage:
		b.Write(x)
	default:
		j, err := json.Marshal(x)
		if err != nil {
			return err
		}
		b.Write(j)
	}
	b.WriteString("\n\n")

	_, err := s.w.Write(b.Bytes())
	s.Flush()
	s.wrote = time.Now()
	return err
}
