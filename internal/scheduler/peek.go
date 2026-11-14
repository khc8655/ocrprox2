package scheduler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"
)

var (
	ErrEmptyStream      = errors.New("scheduler: upstream returned empty stream without payload")
	ErrBareJSONStream   = errors.New("scheduler: upstream returned bare JSON error in 200 stream")
	ErrFirstByteTimeout = errors.New("scheduler: upstream first-byte timeout exceeded")
)

// PeekResult holds the inspected stream outcome before committing HTTP 200 to client.
type PeekResult struct {
	FirstChunk   []byte
	CombinedBody io.Reader
	IsError      bool
	ErrorSnippet string
}

type readMsg struct {
	line     []byte
	isPrefix bool
	err      error
}

// PeekFirstChunk reads from upstream r until the first meaningful payload chunk is found,
// using an asynchronous reader goroutine so keepaliveTicker actually triggers `: keep-alive\n\n`
// comments while upstream is slowly thinking / generating its first token.
//
// Goroutines are cleanly terminated on context cancellation, timeout, error, or completion.
func PeekFirstChunk(
	ctx context.Context,
	r io.Reader,
	keepaliveInterval time.Duration,
	firstByteTimeout time.Duration,
	sendKeepalive func(),
) (*PeekResult, error) {
	if keepaliveInterval <= 0 {
		keepaliveInterval = KeepaliveInterval
	}

	reader := bufio.NewReaderSize(r, 64*1024)
	var buffered bytes.Buffer

	lineCh := make(chan readMsg, 1)
	nextCh := make(chan struct{}, 1)
	stopCh := make(chan struct{})
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			close(stopCh)
		})
	}
	defer stop()

	// Initial trigger to read the first line
	nextCh <- struct{}{}

	// Spawn asynchronous reader goroutine
	go func() {
		defer close(lineCh)
		for {
			select {
			case <-nextCh:
			case <-stopCh:
				return
			}

			lineBytes, isPrefix, err := reader.ReadLine()
			var copied []byte
			if lineBytes != nil {
				copied = make([]byte, len(lineBytes))
				copy(copied, lineBytes)
			}

			select {
			case lineCh <- readMsg{line: copied, isPrefix: isPrefix, err: err}:
			case <-stopCh:
				return
			}

			if err != nil {
				return
			}
		}
	}()

	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()

	var timeoutCh <-chan time.Time
	if firstByteTimeout > 0 {
		timer := time.NewTimer(firstByteTimeout)
		defer timer.Stop()
		timeoutCh = timer.C
	}

	var currentLine bytes.Buffer

	for {
		select {
		case <-ctx.Done():
			stop()
			if closer, ok := r.(io.Closer); ok {
				_ = closer.Close()
			}
			return nil, ctx.Err()

		case <-timeoutCh:
			stop()
			if closer, ok := r.(io.Closer); ok {
				_ = closer.Close()
			}
			return nil, ErrFirstByteTimeout

		case <-ticker.C:
			if sendKeepalive != nil {
				sendKeepalive()
			}

		case msg, ok := <-lineCh:
			if !ok {
				// Reader goroutine finished
				if buffered.Len() == 0 {
					return &PeekResult{IsError: true, ErrorSnippet: "empty stream"}, ErrEmptyStream
				}
				allBytes := buffered.Bytes()
				return &PeekResult{
					FirstChunk:   allBytes,
					CombinedBody: bytes.NewReader(allBytes),
					IsError:      false,
				}, nil
			}

			if msg.err != nil {
				if errors.Is(msg.err, io.EOF) {
					if buffered.Len() == 0 {
						return &PeekResult{IsError: true, ErrorSnippet: "empty stream"}, ErrEmptyStream
					}
					allBytes := buffered.Bytes()
					return &PeekResult{
						FirstChunk:   allBytes,
						CombinedBody: bytes.NewReader(allBytes),
						IsError:      false,
					}, nil
				}
				return nil, msg.err
			}

			buffered.Write(msg.line)
			currentLine.Write(msg.line)

			if msg.isPrefix {
				// Line was too long for one ReadLine buffer, request continuation
				select {
				case nextCh <- struct{}{}:
				case <-stopCh:
					return nil, io.ErrClosedPipe
				}
				continue
			}

			buffered.WriteByte('\n')
			line := strings.TrimSpace(currentLine.String())
			currentLine.Reset()

			if line == "" {
				// Empty separator line in SSE; request next line
				select {
				case nextCh <- struct{}{}:
				case <-stopCh:
					return nil, io.ErrClosedPipe
				}
				continue
			}

			// 1. Check for Bare JSON Error in stream
			if strings.HasPrefix(line, `{"error"`) || strings.HasPrefix(line, `{"code"`) {
				snippet := line
				if len(snippet) > 240 {
					snippet = snippet[:240]
				}
				return &PeekResult{
					IsError:      true,
					ErrorSnippet: snippet,
				}, ErrBareJSONStream
			}

			// 2. Check for SSE data line
			if strings.HasPrefix(line, "data:") {
				payload := strings.TrimSpace(line[5:])
				if payload == "[DONE]" {
					// Immediate [DONE] with no previous content -> empty stream!
					return &PeekResult{
						IsError:      true,
						ErrorSnippet: "immediate [DONE] empty stream",
					}, ErrEmptyStream
				}

				// Validate if payload contains choices / delta / content / tool_calls / Anthropic type
				var chunk map[string]any
				if json.Unmarshal([]byte(payload), &chunk) == nil {
					isPayload := false
					if choices, ok := chunk["choices"].([]any); ok && len(choices) > 0 {
						isPayload = true
					} else if typ, ok := chunk["type"].(string); ok && (typ == "message_start" || typ == "content_block_start" || typ == "content_block_delta" || typ == "message_delta" || typ == "message_stop") {
						isPayload = true
					}

					if isPayload {
						// Payload found!
						stop() // clean up reader goroutine
						firstData := buffered.Bytes()
						combined := io.MultiReader(bytes.NewReader(firstData), reader)
						return &PeekResult{
							FirstChunk:   firstData,
							CombinedBody: combined,
							IsError:      false,
						}, nil
					}
				}
			}

			// Need more lines to find payload
			select {
			case nextCh <- struct{}{}:
			case <-stopCh:
				return nil, io.ErrClosedPipe
			}
		}
	}
}

// PeekUntilPayload reads from upstream until the first meaningful payload chunk is found.
// Backwards compatible wrapper for PeekFirstChunk with background context and no first-byte timeout.
func PeekUntilPayload(r io.Reader, keepaliveInterval time.Duration, sendKeepalive func()) (*PeekResult, error) {
	return PeekFirstChunk(context.Background(), r, keepaliveInterval, 0, sendKeepalive)
}
