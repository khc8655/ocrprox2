package scheduler

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
)

var (
	ErrEmptyStream    = errors.New("scheduler: upstream returned empty stream without payload")
	ErrBareJSONStream = errors.New("scheduler: upstream returned bare JSON error in 200 stream")
)

// PeekResult holds the inspected stream outcome before committing HTTP 200 to client.
type PeekResult struct {
	FirstChunk   []byte
	CombinedBody io.Reader
	IsError      bool
	ErrorSnippet string
}

// PeekUntilPayload reads from upstream until the first meaningful payload chunk is found.
// This allows clean failover if upstream sends an immediate error JSON or empty [DONE].
func PeekUntilPayload(r io.Reader, keepaliveInterval time.Duration, sendKeepalive func()) (*PeekResult, error) {
	reader := bufio.NewReaderSize(r, 64*1024)
	var buffered bytes.Buffer

	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()

	// Read lines until first non-empty data or error
	for {
		lineBytes, isPrefix, err := reader.ReadLine()
		if err != nil {
			if errors.Is(err, io.EOF) {
				if buffered.Len() == 0 {
					return &PeekResult{IsError: true, ErrorSnippet: "empty stream"}, ErrEmptyStream
				}
				// End of stream
				break
			}
			return nil, err
		}

		buffered.Write(lineBytes)
		if !isPrefix {
			buffered.WriteByte('\n')
		}

		line := strings.TrimSpace(string(lineBytes))
		if line == "" {
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

			// Validate if payload contains choices / delta / content / tool_calls
			var chunk map[string]any
			if json.Unmarshal([]byte(payload), &chunk) == nil {
				if choices, ok := chunk["choices"].([]any); ok && len(choices) > 0 {
					// We got a real payload choice!
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
	}

	allBytes := buffered.Bytes()
	return &PeekResult{
		FirstChunk:   allBytes,
		CombinedBody: bytes.NewReader(allBytes),
		IsError:      false,
	}, nil
}
