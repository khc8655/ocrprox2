package modelcatalog

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/khc8655/llmproxy2/internal/steady"
)

// The three build artifacts are embedded so a node behind an unreachable
// models.dev and without a Hub connection still answers capability questions
// on its very first run. Only the gzip is embedded for the catalog (1.6 MB of
// JSON would bloat the binary); provider-map and overrides are a few KB.
//
//go:embed catalog.json.gz
var bundledCatalogGz []byte

//go:embed provider-map.json
var bundledProviderMap []byte

//go:embed overrides.json
var bundledOverrides []byte

// MaxCatalogBytes mirrors the Hub's write ceiling (edgeone-hub/lib/model-catalog.js
// MAX_CATALOG_BYTES). It is applied on the node side too: a compromised or
// misconfigured Hub must not make a node buffer an unbounded payload.
const MaxCatalogBytes = 4 * 1024 * 1024

// CacheFileName is the on-disk cache a Full node fills from the Hub. It lives
// beside proxy_config.enc but is NOT configuration: it is never exported or
// imported (see docs/ADMIN_UI_BACKEND_CONTRACT.md).
const CacheFileName = "model-catalog.json"

// ErrCatalogInvalid wraps every validation failure so admin handlers can map it
// to one response code without string matching.
var ErrCatalogInvalid = errors.New("modelcatalog: catalog invalid")

// Logf receives one-line warnings. Tests swap it; production keeps the default
// so a broken cache file is visible without failing a request.
var Logf = func(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[model-catalog] "+format+"\n", args...)
}

// ---------------------------------------------------------------- wire shapes

type rawLimit struct {
	Context *int `json:"context"`
	Output  *int `json:"output"`
}

type rawOption struct {
	Type   string   `json:"type"`
	Values []string `json:"values"`
	Min    *int     `json:"min"`
	Max    *int     `json:"max"`
}

type rawModel struct {
	Limit            *rawLimit   `json:"limit"`
	Reasoning        *bool       `json:"reasoning"`
	ReasoningOptions []rawOption `json:"reasoning_options"`
	Family           string      `json:"family"`
	ReleaseDate      string      `json:"release_date"`
}

type rawCatalog struct {
	Schema     int                            `json:"schema"`
	Source     string                         `json:"source"`
	FetchedAt  string                         `json:"fetched_at"`
	ModelCount int                            `json:"model_count"`
	Providers  map[string]map[string]rawModel `json:"providers"`
}

type rawProviderMap struct {
	Schema    int                 `json:"schema"`
	Providers map[string][]string `json:"providers"`
}

type rawOverrides struct {
	Schema int                 `json:"schema"`
	Models map[string]rawModel `json:"models"`
}

// ------------------------------------------------------------------- interning

// interner collapses the thousands of repeated family names, release dates and
// option ladders onto one backing allocation each. Without it the parsed
// catalog duplicates every string once per model and the resident set drifts
// toward the raw JSON footprint.
type interner struct {
	strs    map[string]string
	options map[string][]ReasoningOption
}

func newInterner() *interner {
	return &interner{strs: map[string]string{}, options: map[string][]ReasoningOption{}}
}

func (in *interner) str(s string) string {
	if s == "" {
		return ""
	}
	if v, ok := in.strs[s]; ok {
		return v
	}
	in.strs[s] = s
	return s
}

// options interns a whole ladder keyed by its canonical form, so models that
// share an option set share one slice (and one Values backing array).
func (in *interner) opts(raw []rawOption) []ReasoningOption {
	if len(raw) == 0 {
		return nil
	}
	var key strings.Builder
	for _, o := range raw {
		key.WriteString(o.Type)
		key.WriteByte('|')
		key.WriteString(strings.Join(o.Values, ","))
		key.WriteByte('|')
		if o.Min != nil {
			key.WriteString(strconv.Itoa(*o.Min))
		}
		key.WriteByte('|')
		if o.Max != nil {
			key.WriteString(strconv.Itoa(*o.Max))
		}
		key.WriteByte(';')
	}
	k := key.String()
	if v, ok := in.options[k]; ok {
		return v
	}
	built := make([]ReasoningOption, 0, len(raw))
	for _, o := range raw {
		opt := ReasoningOption{Type: o.Type}
		if len(o.Values) > 0 {
			opt.Values = append([]string(nil), o.Values...)
		}
		if o.Min != nil {
			opt.Min = *o.Min
		}
		if o.Max != nil {
			opt.Max = *o.Max
		}
		built = append(built, opt)
	}
	in.options[k] = built
	return built
}

// --------------------------------------------------------------- parsing

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// ParseCatalog decodes one catalog document. It accepts exactly what the Hub
// stores and scripts/model-catalog/build-catalog.mjs emits: schema 1, a
// non-empty providers object. Unknown fields are ignored (the build script
// already whitelists them), malformed ones fail here.
func ParseCatalog(data []byte) (*Catalog, error) {
	return parseCatalogReader(bytes.NewReader(data), false)
}

func parseCatalogReader(r io.Reader, gz bool) (*Catalog, error) {
	var src io.Reader = r
	if gz {
		zr, err := gzip.NewReader(r)
		if err != nil {
			return nil, fmt.Errorf("%w: gzip header: %v", ErrCatalogInvalid, err)
		}
		defer zr.Close()
		src = zr
	}
	cr := &countingReader{r: src}
	var raw rawCatalog
	dec := json.NewDecoder(cr)
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCatalogInvalid, err)
	}
	// Decode stops at the end of the first value; trailing bytes (a second JSON
	// document, a stray log line) must not be silently ignored — the bytes are
	// cached verbatim and a later reader would choke on them.
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("%w: trailing data after the JSON object", ErrCatalogInvalid)
	}
	if raw.Schema != 1 {
		return nil, fmt.Errorf("%w: schema must be 1 (got %d)", ErrCatalogInvalid, raw.Schema)
	}
	if len(raw.Providers) == 0 {
		return nil, fmt.Errorf("%w: providers is empty", ErrCatalogInvalid)
	}

	in := newInterner()
	c := &Catalog{
		FetchedAt:   raw.FetchedAt,
		Source:      in.str(raw.Source),
		providers:   make(map[string]*providerModels, len(raw.Providers)),
		overrides:   map[string]overrideEntry{},
		providerMap: map[string][]string{},
	}
	for provID, models := range raw.Providers {
		if len(models) == 0 {
			continue
		}
		ids := make([]string, 0, len(models))
		for modelID := range models {
			ids = append(ids, in.str(modelID))
		}
		sort.Strings(ids)
		infos := make([]ModelInfo, len(ids))
		for i, modelID := range ids {
			m := models[modelID]
			info := ModelInfo{
				Reasoning:   m.Reasoning != nil && *m.Reasoning,
				Options:     in.opts(m.ReasoningOptions),
				Family:      in.str(m.Family),
				ReleaseDate: in.str(m.ReleaseDate),
			}
			if m.Limit != nil {
				if m.Limit.Context != nil {
					info.ContextTokens = *m.Limit.Context
				}
				if m.Limit.Output != nil {
					info.OutputTokens = *m.Limit.Output
				}
			}
			infos[i] = info
			c.ModelCount++
		}
		c.providers[in.str(provID)] = &providerModels{ids: ids, infos: infos}
	}
	c.rawBytes = cr.n
	return c, nil
}

// loadBundledOnce guards the one-time decompress+parse of the embedded gzip.
var loadBundledOnce struct {
	once sync.Once
	cat  *Catalog
	err  error
}

// initBundled decompresses and parses the embedded catalog on first use only.
// After it returns, the uncompressed bytes are garbage: the caller keeps just
// the compact Catalog (the 114 KB gzip stays in read-only data as part of the
// embed, which is not heap memory).
func initBundled() (*Catalog, error) {
	return Bundled()
}

// Bundled returns the embedded catalog, loading it at most once per process.
func Bundled() (*Catalog, error) {
	loadBundledOnce.once.Do(func() {
		cat, err := parseCatalogReader(bytes.NewReader(bundledCatalogGz), true)
		if err != nil {
			loadBundledOnce.err = err
			return
		}
		if err := cat.attachMaps(bundledProviderMap, bundledOverrides); err != nil {
			loadBundledOnce.err = err
			return
		}
		loadBundledOnce.cat = cat
	})
	return loadBundledOnce.cat, loadBundledOnce.err
}

// ProviderMap/Overrides loading ---------------------------------------------------

// attachMaps adds the routing table and manual overrides to a parsed catalog.
// provider-map and overrides are build-time artifacts of OUR preset list, so a
// Hub-pulled catalog update never replaces them.
func (c *Catalog) attachMaps(providerMapJSON, overridesJSON []byte) error {
	var pm rawProviderMap
	if err := json.Unmarshal(providerMapJSON, &pm); err != nil {
		return fmt.Errorf("modelcatalog: provider-map.json: %w", err)
	}
	if pm.Schema != 1 {
		return fmt.Errorf("modelcatalog: provider-map.json schema must be 1 (got %d)", pm.Schema)
	}
	for presetID, ids := range pm.Providers {
		c.providerMap[presetID] = append([]string(nil), ids...)
	}

	var ov rawOverrides
	if err := json.Unmarshal(overridesJSON, &ov); err != nil {
		return fmt.Errorf("modelcatalog: overrides.json: %w", err)
	}
	if ov.Schema != 1 {
		return fmt.Errorf("modelcatalog: overrides.json schema must be 1 (got %d)", ov.Schema)
	}
	for key, m := range ov.Models {
		// Keys are "<presetID>/<modelID>" by contract. A malformed one is
		// dropped with a warning rather than failing the whole catalog: the
		// build script already validates this file at commit time.
		if strings.Count(key, "/") != 1 {
			Logf("overrides: skipping malformed key %q (want <preset>/<model>)", key)
			continue
		}
		c.overrides[key] = newOverrideEntry(m)
	}
	return nil
}

func newOverrideEntry(m rawModel) overrideEntry {
	e := overrideEntry{}
	if m.Limit != nil {
		if m.Limit.Context != nil {
			e.hasContext, e.info.ContextTokens = true, *m.Limit.Context
		}
		if m.Limit.Output != nil {
			e.hasOutput, e.info.OutputTokens = true, *m.Limit.Output
		}
	}
	if m.Reasoning != nil {
		e.hasReason, e.info.Reasoning = true, *m.Reasoning
	}
	if m.ReasoningOptions != nil {
		e.hasOptions = true
		for _, o := range m.ReasoningOptions {
			opt := ReasoningOption{Type: o.Type}
			if len(o.Values) > 0 {
				opt.Values = append([]string(nil), o.Values...)
			}
			if o.Min != nil {
				opt.Min = *o.Min
			}
			if o.Max != nil {
				opt.Max = *o.Max
			}
			e.info.Options = append(e.info.Options, opt)
		}
	}
	if m.Family != "" {
		e.hasFamily, e.info.Family = true, m.Family
	}
	if m.ReleaseDate != "" {
		e.hasReleased, e.info.ReleaseDate = true, m.ReleaseDate
	}
	return e
}

// ---------------------------------------------------------------- node store

// Source values reported by Status.
const (
	SourceBundled = "bundled"
	SourceCache   = "cache"
)

// Status is what the admin console shows for the node-local catalog.
type Status struct {
	Present    bool   `json:"present"`
	Source     string `json:"source"` // "bundled" | "cache"
	FetchedAt  string `json:"fetched_at"`
	ModelCount int    `json:"model_count"`
	Bytes      int    `json:"bytes"` // uncompressed catalog size
}

// Store owns the node-local catalog: a lazily loaded active Catalog (cache file
// first, embedded bundle second) that a Hub sync can replace at runtime.
type Store struct {
	dir    string
	load   sync.Once
	active atomic.Pointer[Catalog]
	status atomic.Pointer[Status]
}

// NewStore creates a store rooted at the node's config directory. Nothing is
// read or decompressed here: the first Current/Status/Lookup pays the load, so
// a node that never asks about model capabilities keeps the catalog out of
// memory (and startup stays off the 1.6 MB JSON path).
func NewStore(dir string) *Store { return &Store{dir: dir} }

// Current returns the active catalog, loading the cache-or-bundle on first use.
// A load failure returns nil — every method tolerates a nil receiver, so the
// admin plane degrades to "unknown capability" instead of returning 500s.
func (s *Store) Current() *Catalog {
	if s == nil {
		return nil
	}
	s.load.Do(s.boot)
	return s.active.Load()
}

func (s *Store) boot() {
	if cat, st, err := s.loadCache(); err == nil && cat != nil {
		s.active.Store(cat)
		s.status.Store(st)
		return
	} else if err != nil {
		// A corrupt cache must not lock the node out of a working catalog.
		Logf("cache file %s is unusable, falling back to the embedded catalog: %v", filepath.Join(s.dir, CacheFileName), err)
	}
	cat, err := initBundled()
	if err != nil {
		Logf("embedded catalog unusable: %v", err)
		return
	}
	s.active.Store(cat)
	s.status.Store(&Status{
		Present:    true,
		Source:     SourceBundled,
		FetchedAt:  cat.FetchedAt,
		ModelCount: cat.ModelCount,
		Bytes:      int(cat.rawBytes),
	})
}

// loadCache reads and parses the Hub-pulled cache file. A missing file is not
// an error (the caller falls back to the bundle); a too-large or malformed file
// is, and is reported so the console can tell the operator the cache is stale.
func (s *Store) loadCache() (*Catalog, *Status, error) {
	path := filepath.Join(s.dir, CacheFileName)
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if fi.Size() > MaxCatalogBytes {
		return nil, nil, fmt.Errorf("%w: %d B exceeds %d B", ErrCatalogInvalid, fi.Size(), MaxCatalogBytes)
	}
	cat, err := parseCatalogReader(f, false)
	if err != nil {
		return nil, nil, err
	}
	if err := cat.attachMaps(bundledProviderMap, bundledOverrides); err != nil {
		return nil, nil, err
	}
	return cat, &Status{
		Present:    true,
		Source:     SourceCache,
		FetchedAt:  cat.FetchedAt,
		ModelCount: cat.ModelCount,
		Bytes:      int(cat.rawBytes),
	}, nil
}

// Status reports which catalog is active, loading it on first use.
func (s *Store) Status() Status {
	s.Current()
	if st := s.status.Load(); st != nil {
		return *st
	}
	return Status{}
}

// ValidateCatalogText applies the same checks the Hub applies before writing
// KV, from the node's side: non-empty, JSON object, schema 1, providers object,
// byte ceiling. Returns the parsed catalog so callers do not parse twice.
func ValidateCatalogText(text []byte) (*Catalog, error) {
	if len(text) == 0 {
		return nil, fmt.Errorf("%w: payload is empty", ErrCatalogInvalid)
	}
	if len(text) > MaxCatalogBytes {
		return nil, fmt.Errorf("%w: %d B exceeds %d B", ErrCatalogInvalid, len(text), MaxCatalogBytes)
	}
	trimmed := bytes.TrimSpace(text)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, fmt.Errorf("%w: payload is not a JSON object", ErrCatalogInvalid)
	}
	return ParseCatalog(text)
}

// SaveFromHub validates a Hub-supplied catalog text, writes it atomically to
// the node's cache file and swaps it in as the active catalog. Validation runs
// before the file is touched, so a rejected payload leaves both the previous
// file and the active catalog exactly as they were.
func (s *Store) SaveFromHub(text []byte) (Status, error) {
	if s == nil || s.dir == "" {
		return Status{}, fmt.Errorf("%w: no config directory", ErrCatalogInvalid)
	}
	cat, err := ValidateCatalogText(text)
	if err != nil {
		return Status{}, err
	}
	if err := cat.attachMaps(bundledProviderMap, bundledOverrides); err != nil {
		return Status{}, fmt.Errorf("%w: %v", ErrCatalogInvalid, err)
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return Status{}, err
	}
	if err := steady.WriteFile(filepath.Join(s.dir, CacheFileName), text, 0o600); err != nil {
		return Status{}, fmt.Errorf("modelcatalog: cache write failed: %w", err)
	}
	st := Status{
		Present:    true,
		Source:     SourceCache,
		FetchedAt:  cat.FetchedAt,
		ModelCount: cat.ModelCount,
		Bytes:      int(cat.rawBytes),
	}
	s.active.Store(cat)
	s.status.Store(&st)
	return st, nil
}
