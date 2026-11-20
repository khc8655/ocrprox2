package scheduler

import (
	"bytes"
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	defaultSessionStickyTTL     = 15 * time.Minute
	defaultSessionStickyMaxSize = 4096
	maxCompactSectionBytes      = 256 * 1024
)

var sessionHeaders = []string{
	"X-Session-Id",
	"Session-Id",
	"Session_id",
	"X-Conversation-Id",
	"Conversation-Id",
	"Conversation_id",
	"X-Thread-Id",
	"X-Session-Affinity",
}

// agentHeaders identify a subagent within a conversation. Claude Code sends its
// session id on subagent requests too, so without this dimension a subagent's
// answer would re-bind the lead conversation to another Key and throw away the
// cache it had been building there.
var agentHeaders = []string{
	"X-Claude-Code-Agent-Id",
	"X-Subagent-Id",
	"X-Agent-Id",
}

const agentKeySeparator = "|agent:"

type stickyEntry struct {
	compositeKey string
	keyTag       string
	lastUsed     time.Time
}

// stickySet is a bounded, TTL-evicted string -> KeyTag map with LRU eviction.
// Session bindings and prefix bindings keep separate instances so that a burst of
// new conversations cannot evict the conversations already being served.
type stickySet struct {
	mu         sync.Mutex
	ttl        time.Duration
	maxEntries int
	now        func() time.Time
	items      map[string]*list.Element
	lru        *list.List
}

func newStickySet(ttl time.Duration, maxEntries int, now func() time.Time) *stickySet {
	if ttl <= 0 {
		ttl = defaultSessionStickyTTL
	}
	if maxEntries <= 0 {
		maxEntries = defaultSessionStickyMaxSize
	}
	return &stickySet{
		ttl:        ttl,
		maxEntries: maxEntries,
		now:        now,
		items:      make(map[string]*list.Element),
		lru:        list.New(),
	}
}

func (c *stickySet) get(k string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[k]
	if !ok {
		return "", false
	}
	ent := elem.Value.(*stickyEntry)
	if c.ttl > 0 && c.now().Sub(ent.lastUsed) > c.ttl {
		c.lru.Remove(elem)
		delete(c.items, k)
		return "", false
	}
	c.lru.MoveToFront(elem)
	return ent.keyTag, true
}

func (c *stickySet) set(k, keyTag string) {
	now := c.now()

	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[k]; ok {
		ent := elem.Value.(*stickyEntry)
		ent.keyTag = keyTag
		ent.lastUsed = now
		c.lru.MoveToFront(elem)
		return
	}

	c.pruneExpiredLocked(now)
	for len(c.items) >= c.maxEntries {
		back := c.lru.Back()
		if back == nil {
			break
		}
		evicted := c.lru.Remove(back).(*stickyEntry)
		delete(c.items, evicted.compositeKey)
	}

	ent := &stickyEntry{compositeKey: k, keyTag: keyTag, lastUsed: now}
	c.items[k] = c.lru.PushFront(ent)
}

func (c *stickySet) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pruneExpiredLocked(c.now())
	return len(c.items)
}

func (c *stickySet) pruneExpiredLocked(now time.Time) {
	if c.ttl <= 0 {
		return
	}
	for back := c.lru.Back(); back != nil; {
		prev := back.Prev()
		ent := back.Value.(*stickyEntry)
		if now.Sub(ent.lastUsed) <= c.ttl {
			break
		}
		c.lru.Remove(back)
		delete(c.items, ent.compositeKey)
		back = prev
	}
}

// SessionStickyCache maintains thread-safe per-session sticky key bindings
// (with sliding TTL and bounded LRU eviction), the key already serving each
// cacheable prompt prefix, plus a model-level fallback key for requests that
// carry no session identity.
type SessionStickyCache struct {
	// nowFunc is read on every operation so a test can move the clock after
	// construction.
	nowFunc     func() time.Time
	sessions    *stickySet
	prefixes    *stickySet
	mu          sync.Mutex
	modelSticky map[string]string
}

// NewSessionStickyCache creates a bounded, TTL-aware sticky session cache.
func NewSessionStickyCache(ttl time.Duration, maxEntries int) *SessionStickyCache {
	c := &SessionStickyCache{
		nowFunc:     time.Now,
		modelSticky: make(map[string]string),
	}
	now := func() time.Time { return c.nowFunc() }
	c.sessions = newStickySet(ttl, maxEntries, now)
	c.prefixes = newStickySet(ttl, maxEntries, now)
	return c
}

func makeStickyCompositeKey(model, sessionKey, agentID string) string {
	k := model + "\x00" + sessionKey
	if agentID != "" {
		k += agentKeySeparator + agentID
	}
	return k
}

// SessionIdentity is a request's conversation identity: the session key every
// turn of the conversation shares, the subagent id when the request comes from
// one, and the fingerprint of the prompt prefix any conversation on the same
// project can reuse from cache.
type SessionIdentity struct {
	Key       string
	AgentID   string
	PrefixKey string
}

// ExtractAgentID returns the subagent id a request names, or "" for a lead
// conversation. Only explicit headers are trusted.
func ExtractAgentID(r *http.Request) string {
	if r == nil {
		return ""
	}
	for _, h := range agentHeaders {
		if v := strings.TrimSpace(r.Header.Get(h)); v != "" && len(v) <= 256 {
			return v
		}
	}
	return ""
}

// Get returns the active sticky KeyTag for (model, sessionKey, agentID) if
// present and unexpired. A lead conversation uses agentID "".
func (c *SessionStickyCache) Get(model, sessionKey, agentID string) (string, bool) {
	if c == nil || sessionKey == "" || model == "" {
		return "", false
	}
	return c.sessions.get(makeStickyCompositeKey(model, sessionKey, agentID))
}

// GetWithLead returns the binding for the request's own identity, and for a
// subagent that has none, its lead conversation's: a subagent shares the lead's
// prefix, so starting where the lead already warms the cache costs nothing and
// saves the first cache write. Callers must write back only the subagent slot
// (Set with its own agentID), never the lead's.
func (c *SessionStickyCache) GetWithLead(model, sessionKey, agentID string) (string, bool) {
	if tag, ok := c.Get(model, sessionKey, agentID); ok {
		return tag, true
	}
	if agentID == "" {
		return "", false
	}
	return c.Get(model, sessionKey, "")
}

// Set binds (model, sessionKey, agentID) to keyTag and refreshes its sliding
// expiration timestamp.
func (c *SessionStickyCache) Set(model, sessionKey, agentID, keyTag string) {
	if c == nil || sessionKey == "" || model == "" || keyTag == "" {
		return
	}
	c.sessions.set(makeStickyCompositeKey(model, sessionKey, agentID), keyTag)
}

func makePrefixKey(model, prefixKey string) string {
	return model + "\x00" + prefixKey
}

// GetPrefix returns the KeyTag already serving conversations that share the given
// cacheable prompt prefix, or "" when none is known.
func (c *SessionStickyCache) GetPrefix(model, prefixKey string) string {
	if c == nil || model == "" || prefixKey == "" {
		return ""
	}
	tag, _ := c.prefixes.get(makePrefixKey(model, prefixKey))
	return tag
}

// SetPrefix records the key a conversation with this cacheable prefix was served
// by, so the next conversation sharing the prefix starts where the cache is warm.
func (c *SessionStickyCache) SetPrefix(model, prefixKey, keyTag string) {
	if c == nil || model == "" || prefixKey == "" || keyTag == "" {
		return
	}
	c.prefixes.set(makePrefixKey(model, prefixKey), keyTag)
}

// GetModelFallback returns the last successful KeyTag recorded for a model without session identity.
func (c *SessionStickyCache) GetModelFallback(model string) string {
	if c == nil || model == "" {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.modelSticky[model]
}

// SetModelFallback records a model-level fallback sticky KeyTag in a thread-safe map.
func (c *SessionStickyCache) SetModelFallback(model, keyTag string) {
	if c == nil || model == "" || keyTag == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.modelSticky[model] = keyTag
}

// Len returns the number of active session sticky entries (used in diagnostics/tests).
func (c *SessionStickyCache) Len() int {
	if c == nil {
		return 0
	}
	return c.sessions.len()
}

// ExtractSessionIdentity derives a request's full sticky identity: the session
// key shared by every turn of the conversation, the subagent id when the request
// is one of a conversation's subagents, and the fingerprint of the prompt prefix
// other conversations on the same project can reuse from cache.
func ExtractSessionIdentity(r *http.Request, reqBody []byte) SessionIdentity {
	return SessionIdentity{
		Key:       ExtractSessionKey(r, reqBody),
		AgentID:   ExtractAgentID(r),
		PrefixKey: ExtractCachePrefix(reqBody),
	}
}

// ExtractCachePrefix fingerprints the part of a request an upstream can serve to
// any conversation from cache: the system/instructions block and the tool
// catalog. Agents working on one project share those and differ only in their
// task, so binding them to one key lets the second agent read the first agent's
// cached tokens instead of paying for the same prefix twice.
//
// Returns "" when the request carries no reusable prefix.
func ExtractCachePrefix(reqBody []byte) string {
	if len(reqBody) == 0 {
		return ""
	}
	fields := scanTopLevelJSONFields(reqBody)
	if len(fields) == 0 {
		return ""
	}

	h := sha256.New()
	hasSignal := false
	for _, key := range []string{"instructions", "system", "tools"} {
		if raw := fields[key]; len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
			writeHashedSection(h, key, raw)
			hasSignal = true
		}
	}

	// OpenAI-style requests put the system prompt in the message list. Only a
	// leading system/developer turn is shared by every conversation; a leading
	// user turn is the task itself and must not join the shared prefix.
	if !hasSignal {
		if msgsRaw := fields["messages"]; len(msgsRaw) > 0 && msgsRaw[0] == '[' {
			items := extractFirstArrayItems(msgsRaw, 2)
			if len(items) > 0 && isSystemOrDevMessage(items[0]) {
				writeHashedSection(h, "m0", items[0])
				hasSignal = true
				if len(items) > 1 && isSystemOrDevMessage(items[1]) {
					writeHashedSection(h, "m1", items[1])
				}
			}
		}
	}

	if !hasSignal {
		return ""
	}
	sum := h.Sum(nil)
	return "cpy:" + hex.EncodeToString(sum[:12])
}

// ExtractSessionKey derives a stable conversation/session key for sticky routing:
//  1. Explicit session headers (X-Session-Id, Session-Id, Conversation-Id, etc.)
//  2. Explicit JSON payload identifiers (prompt_cache_key, conversation, metadata.session_id/user_id, user)
//  3. Structural prompt prefix fingerprint (system/instructions + tools + initial turn anchor)
func ExtractSessionKey(r *http.Request, reqBody []byte) string {
	if r != nil {
		for _, h := range sessionHeaders {
			if v := strings.TrimSpace(r.Header.Get(h)); v != "" && len(v) <= 256 {
				return "hdr:" + v
			}
		}
	}
	if len(reqBody) == 0 {
		return ""
	}

	fields := scanTopLevelJSONFields(reqBody)
	if len(fields) == 0 {
		return ""
	}

	// Tier 2: explicit payload session identifiers
	if s := unmarshalJSONString(fields["prompt_cache_key"]); s != "" && len(s) <= 256 {
		return "pck:" + s
	}
	if convRaw := fields["conversation"]; len(convRaw) > 0 {
		if s := unmarshalJSONString(convRaw); s != "" && len(s) <= 256 {
			return "conv:" + s
		}
		var obj struct {
			ID string `json:"id"`
		}
		if len(convRaw) <= 1024 && json.Unmarshal(convRaw, &obj) == nil && strings.TrimSpace(obj.ID) != "" {
			return "conv:" + strings.TrimSpace(obj.ID)
		}
	}
	if metaRaw := fields["metadata"]; len(metaRaw) > 0 && len(metaRaw) <= 8192 {
		var meta struct {
			SessionID string `json:"session_id"`
			UserID    string `json:"user_id"`
		}
		if json.Unmarshal(metaRaw, &meta) == nil {
			if s := strings.TrimSpace(meta.SessionID); s != "" && len(s) <= 256 {
				return "meta:" + s
			}
			if s := strings.TrimSpace(meta.UserID); s != "" && len(s) <= 256 {
				return "meta:" + s
			}
		}
	}
	if s := unmarshalJSONString(fields["user"]); s != "" && len(s) <= 256 {
		return "usr:" + s
	}

	// Tier 3: structural prompt prefix fingerprint (zero full-body AST allocation)
	h := sha256.New()
	hasSignal := false

	for _, key := range []string{"instructions", "system", "tools"} {
		if raw := fields[key]; len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
			writeHashedSection(h, key, raw)
			hasSignal = true
		}
	}

	if msgsRaw := fields["messages"]; len(msgsRaw) > 0 && msgsRaw[0] == '[' {
		items := extractFirstArrayItems(msgsRaw, 2)
		if len(items) > 0 {
			writeHashedSection(h, "m0", items[0])
			hasSignal = true
			if len(items) > 1 && isSystemOrDevMessage(items[0]) {
				writeHashedSection(h, "m1", items[1])
			}
		}
	} else if inputRaw := fields["input"]; len(inputRaw) > 0 && !bytes.Equal(inputRaw, []byte("null")) {
		if inputRaw[0] == '[' {
			items := extractFirstArrayItems(inputRaw, 2)
			if len(items) > 0 {
				writeHashedSection(h, "i0", items[0])
				hasSignal = true
				if len(items) > 1 && isSystemOrDevMessage(items[0]) {
					writeHashedSection(h, "i1", items[1])
				}
			}
		} else {
			writeHashedSection(h, "input", inputRaw)
			hasSignal = true
		}
	}

	if !hasSignal {
		return ""
	}
	sum := h.Sum(nil)
	return "pfx:" + hex.EncodeToString(sum[:12])
}

func unmarshalJSONString(raw []byte) string {
	if len(raw) < 2 || len(raw) > 2048 || raw[0] != '"' {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

func writeHashedSection(h interface{ Write([]byte) (int, error) }, label string, raw []byte) {
	_, _ = h.Write([]byte(label))
	_, _ = h.Write([]byte{0})
	if len(raw) <= maxCompactSectionBytes {
		var buf bytes.Buffer
		if json.Compact(&buf, raw) == nil {
			_, _ = h.Write(buf.Bytes())
			_, _ = h.Write([]byte{0})
			return
		}
	}
	limit := len(raw)
	if limit > maxCompactSectionBytes {
		limit = maxCompactSectionBytes
	}
	_, _ = h.Write(raw[:limit])
	_, _ = h.Write([]byte{0})
}

func isSystemOrDevMessage(item []byte) bool {
	fields := scanTopLevelJSONFields(item)
	role := strings.ToLower(unmarshalJSONString(fields["role"]))
	return role == "system" || role == "developer"
}

// scanTopLevelJSONFields returns raw JSON value slices for top-level keys of a JSON object
// without deserializing nested values, making it O(N) CPU and ~0 heap allocation even on 20MB payloads.
func scanTopLevelJSONFields(data []byte) map[string][]byte {
	n := len(data)
	i := skipWS(data, 0)
	if i >= n || data[i] != '{' {
		return nil
	}
	i++

	out := make(map[string][]byte, 8)
	for i < n {
		i = skipWS(data, i)
		if i >= n || data[i] == '}' {
			break
		}
		if data[i] == ',' {
			i++
			continue
		}
		if data[i] != '"' {
			return out
		}
		keyStart := i
		keyEnd := skipJSONString(data, i)
		if keyEnd < 0 {
			return out
		}
		var key string
		if json.Unmarshal(data[keyStart:keyEnd], &key) != nil {
			key = string(data[keyStart+1 : keyEnd-1])
		}

		i = skipWS(data, keyEnd)
		if i >= n || data[i] != ':' {
			return out
		}
		i = skipWS(data, i+1)
		if i >= n {
			return out
		}

		valStart := i
		valEnd := skipJSONValue(data, valStart)
		if valEnd < 0 {
			return out
		}
		out[key] = data[valStart:valEnd]
		i = valEnd
	}
	return out
}

// extractFirstArrayItems extracts up to maxItems raw element slices from a JSON array without
// scanning or retaining trailing history elements.
func extractFirstArrayItems(arr []byte, maxItems int) [][]byte {
	n := len(arr)
	i := skipWS(arr, 0)
	if i >= n || arr[i] != '[' {
		return nil
	}
	i++

	var items [][]byte
	for i < n && len(items) < maxItems {
		i = skipWS(arr, i)
		if i >= n || arr[i] == ']' {
			break
		}
		if arr[i] == ',' {
			i++
			continue
		}
		valStart := i
		valEnd := skipJSONValue(arr, valStart)
		if valEnd < 0 {
			break
		}
		items = append(items, arr[valStart:valEnd])
		i = valEnd
	}
	return items
}

func skipWS(data []byte, i int) int {
	for i < len(data) {
		switch data[i] {
		case ' ', '\t', '\r', '\n':
			i++
		default:
			return i
		}
	}
	return i
}

func skipJSONString(data []byte, i int) int {
	if i >= len(data) || data[i] != '"' {
		return -1
	}
	i++
	for i < len(data) {
		b := data[i]
		if b == '\\' {
			i += 2
			continue
		}
		if b == '"' {
			return i + 1
		}
		i++
	}
	return -1
}

func skipJSONValue(data []byte, i int) int {
	if i >= len(data) {
		return -1
	}
	switch data[i] {
	case '"':
		return skipJSONString(data, i)
	case '{', '[':
		depth := 0
		for i < len(data) {
			switch data[i] {
			case '"':
				end := skipJSONString(data, i)
				if end < 0 {
					return -1
				}
				i = end
			case '{', '[':
				depth++
				i++
			case '}', ']':
				depth--
				i++
				if depth == 0 {
					return i
				}
			default:
				i++
			}
		}
		return -1
	default:
		for i < len(data) {
			switch data[i] {
			case ',', '}', ']', ' ', '\t', '\r', '\n':
				return i
			default:
				i++
			}
		}
		return len(data)
	}
}
