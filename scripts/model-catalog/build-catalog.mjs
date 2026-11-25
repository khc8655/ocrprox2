#!/usr/bin/env node
/**
 * scripts/model-catalog/build-catalog.mjs
 *
 * Compiles the upstream models.dev catalog (/tmp/modelsdev/api.json) into the
 * slim catalog that the gateway ships for per-model capability lookups
 * (context/output limits, reasoning support and effort levels).
 *
 *   input : models.dev api.json  (positional arg, default /tmp/modelsdev/api.json)
 *   output: shared/model-catalog/catalog.json      (compact JSON)
 *           shared/model-catalog/catalog.json.gz   (gzip -9, for //go:embed)
 *           shared/model-catalog/provider-map.json (derived, see below)
 *
 * Only five per-model fields survive; everything else (names, costs, modalities,
 * knowledge cutoffs, ...) is dropped because nothing downstream reads it and it
 * would triple the payload.
 *
 * Two deliberate formatting choices, both driven by the size budget:
 *   1. catalog.json is written compact (single line). With 2-space indentation
 *      the same data is 3,179,390 B, which blows the 1.8 MB ceiling; the
 *      compact form is 1,629,650 B.
 *   2. provider ids and model ids are sorted, so two runs over the same input
 *      produce byte-identical output (drift checks and diffs stay stable even
 *      if upstream reorders its JSON).
 *
 * Zero dependencies, Node built-ins only. This is a build-time script, not
 * edge runtime code: node:fs/node:zlib are allowed here (and nowhere else).
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

export const PRESETS_DIR = join(projectRoot, 'shared/presets');
export const CATALOG_DIR = join(projectRoot, 'shared/model-catalog');
export const CATALOG_JSON_PATH = join(CATALOG_DIR, 'catalog.json');
export const CATALOG_GZ_PATH = join(CATALOG_DIR, 'catalog.json.gz');
export const PROVIDER_MAP_PATH = join(CATALOG_DIR, 'provider-map.json');
export const FIXTURE_PATH = join(__dirname, 'fixtures/models-dev-sample.json');
export const OVERRIDES_PATH = join(CATALOG_DIR, 'overrides.json');

export const SCHEMA_VERSION = 1;
export const SOURCE = 'models.dev';

// Budgets from the phase brief. `1.8 MB` is read as 1,800,000 B and `140 KB`
// as 140 KiB = 143,360 B (the stricter of the two common readings for KB).
export const MAX_CATALOG_JSON_BYTES = 1800000;
export const MAX_CATALOG_GZ_BYTES = 140 * 1024;

// ---------------------------------------------------------------------------
// Preset id -> models.dev provider id(s)
//
// Exact same-name matches are discovered from the data (never typed by hand).
// The entries below are the aliases the main session already confirmed; they are
// inputs to the comparison, not a substitute for it. Order matters at runtime:
// the first provider that actually contains the model wins.
// ---------------------------------------------------------------------------
export const ALIASES = {
  moonshot: ['moonshotai'],
  'moonshot-cn': ['moonshotai-cn', 'moonshotai'],
  'kimi-code': ['kimi-code-plan-global', 'moonshotai'],
  'kimi-code-cn': ['kimi-code-plan-cn', 'moonshotai-cn', 'moonshotai'],
  zhipu: ['zhipuai'],
  qwen: ['alibaba'],
  'bailian-token-plan': ['alibaba'],
  bedrock: ['amazon-bedrock'],
  'tencent-cloud': ['tencent-tokenhub', 'tencent-token-plan'],
  'minimax-cn': ['minimax'],
  minimax: ['minimax'],
};

// Presets that genuinely have no models.dev provider. The reason strings are
// emitted into provider-map.json `_gaps` so the gap is documented next to the
// empty mapping instead of living in someone's head.
export const GAP_REASONS = {
  bai: 'models.dev 只有 bailing（蚂蚁百灵 Ling/Ring，api.tbox.cn），与 B.AI（api.b.ai）不是同一家，bai 自身不在 235 家 provider 之列。',
  'baidu-qianfan': 'models.dev 没有任何 baidu* provider，千帆 Token Plan 未被收录。',
  cline: 'models.dev 只有 cline-pass（ClinePass），其模型 ID 带 `cline-pass/` 前缀、与预设 upstream_model 的命名空间不一致，主会话判定为缺口；模型详情走 overrides.json。',
  ollama: 'models.dev 只有 ollama-cloud（ollama.com 远程服务），而本预设指向本机 127.0.0.1:11434，模型清单取决于用户本地 `ollama list`，云端目录不适用。',
  tokenrhythm: 'models.dev 无 tokenrhythm，该聚合网关未被收录。',
  vertex: 'models.dev 的 google-vertex / google-vertex-anthropic 使用 `claude-sonnet-4@20250514` 这类带 @ 日期且无 `google/` 前缀的 ID，与本预设强制 `google/` 前缀的 upstream_model 不一致，主会话判定为缺口；模型详情走 overrides.json。',
};

// Only these keys are kept inside a reasoning_options entry. Whitelisting (vs
// blind pass-through) keeps the contract stable if upstream grows new keys.
const REASONING_OPTION_KEYS = new Set(['type', 'values', 'min', 'max']);

// ---------------------------------------------------------------------------
// Preset discovery
// ---------------------------------------------------------------------------
export function listPresetIds() {
  return readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'catalog.json')
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

// ---------------------------------------------------------------------------
// Per-model transform
// ---------------------------------------------------------------------------
export function normalizeLimit(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  if (Number.isFinite(raw.context) && raw.context >= 0) out.context = Math.floor(raw.context);
  if (Number.isFinite(raw.output) && raw.output >= 0) out.output = Math.floor(raw.output);
  // `input` (present on 1,720 upstream models) is intentionally dropped.
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeReasoningOptions(raw, warn) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = [];
  for (const opt of raw) {
    if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
      warn(`reasoning_options: skipped non-object entry ${JSON.stringify(opt)}`);
      continue;
    }
    if (typeof opt.type !== 'string' || empty(opt.type)) {
      warn(`reasoning_options: skipped entry without type ${JSON.stringify(opt)}`);
      continue;
    }
    const clean = {};
    for (const [k, v] of Object.entries(opt)) {
      if (!REASONING_OPTION_KEYS.has(k)) {
        warn(`reasoning_options: dropped unknown key '${k}' on type=${opt.type}`);
        continue;
      }
      if (k === 'values') {
        if (!Array.isArray(v) || v.length === 0) {
          warn(`reasoning_options: dropped non-array/empty values on type=${opt.type}`);
          continue;
        }
        clean.values = v.slice();
      } else if (k === 'min' || k === 'max') {
        if (Number.isFinite(v)) clean[k] = Math.floor(v);
        else warn(`reasoning_options: dropped non-numeric ${k} on type=${opt.type}`);
      } else {
        clean[k] = v;
      }
    }
    out.push(clean);
  }
  return out.length > 0 ? out : undefined;
}

function empty(s) {
  return typeof s !== 'string' || s.trim() === '';
}

/**
 * Projects one models.dev model onto the catalog shape. Missing fields are
 * omitted rather than written as null (the ask's contract: 缺的就不写).
 */
export function transformModel(model, warn = () => {}) {
  const src = model && typeof model === 'object' ? model : {};
  const out = {};

  const limit = normalizeLimit(src.limit);
  if (limit) out.limit = limit;

  if (typeof src.reasoning === 'boolean') out.reasoning = src.reasoning;

  const options = normalizeReasoningOptions(src.reasoning_options, warn);
  if (options) out.reasoning_options = options;

  if (!empty(src.family)) out.family = src.family;
  if (!empty(src.release_date)) out.release_date = src.release_date;

  return out;
}

/**
 * Builds the catalog object. `fetched_at` is supplied by the caller so the
 * function stays pure and testable.
 */
export function buildCatalog(modelsDev, fetchedAt) {
  if (!modelsDev || typeof modelsDev !== 'object' || Array.isArray(modelsDev)) {
    throw new Error('models.dev input must be a JSON object keyed by provider id');
  }

  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  const providers = {};
  const droppedProviders = [];
  const optionTypeCounts = {};
  let modelCount = 0;

  for (const providerId of Object.keys(modelsDev).sort()) {
    const provider = modelsDev[providerId] || {};
    const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
    const modelIds = Object.keys(models).sort();

    // Providers with no models are dropped: they carry nothing to look up.
    if (modelIds.length === 0) {
      droppedProviders.push(providerId);
      continue;
    }

    const outModels = {};
    for (const modelId of modelIds) {
      const projected = transformModel(models[modelId], warn);
      for (const opt of projected.reasoning_options || []) {
        optionTypeCounts[opt.type] = (optionTypeCounts[opt.type] || 0) + 1;
      }
      outModels[modelId] = projected;
      modelCount += 1;
    }
    if (Object.keys(outModels).length > 0) providers[providerId] = outModels;
  }

  if (modelCount === 0) {
    throw new Error('models.dev input contains no models; refusing to emit an empty catalog');
  }

  return {
    catalog: {
      schema: SCHEMA_VERSION,
      source: SOURCE,
      fetched_at: fetchedAt,
      model_count: modelCount,
      providers,
    },
    stats: {
      modelCount,
      providerCount: Object.keys(providers).length,
      droppedProviders,
      optionTypeCounts,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider map derivation (the table is a comparison result, not a memory dump)
// ---------------------------------------------------------------------------
// `strictTable` (default true) also asserts that ALIASES / GAP_REASONS describe
// real presets. Partial runs (a preset subset, e.g. the 5-provider fixture) set
// it to false, because an unrelated alias covering a preset outside the subset
// is not an error there.
export function deriveProviderMap(presetIds, providerIds, { strictTable = true } = {}) {
  const ids = providerIds instanceof Set ? providerIds : new Set(providerIds);
  const map = {};
  const gaps = {};
  const exact = [];
  const alias = [];
  const gap = [];
  const shadowed = [];

  for (const presetId of presetIds) {
    const aliasTargets = ALIASES[presetId];

    if (aliasTargets) {
      const missing = aliasTargets.filter((t) => !ids.has(t));
      if (missing.length > 0) {
        throw new Error(
          `provider-map: preset '${presetId}' maps to ${missing.join(', ')}, which does not exist in models.dev`
        );
      }
      // A confirmed alias wins over an incidental same-name provider. Surface
      // that situation so it is a visible decision instead of a silent shadow.
      if (ids.has(presetId) && !aliasTargets.includes(presetId)) {
        shadowed.push({ presetId, exactMatch: presetId, targets: aliasTargets.slice() });
      }
      map[presetId] = aliasTargets.slice();
      continue;
    }

    if (ids.has(presetId)) {
      map[presetId] = [presetId];
      continue;
    }

    const reason = GAP_REASONS[presetId];
    if (!reason) {
      throw new Error(
        `provider-map: preset '${presetId}' has no models.dev provider, no confirmed alias and no gap reason. ` +
          'Add it to ALIASES or GAP_REASONS in scripts/model-catalog/build-catalog.mjs.'
      );
    }
    map[presetId] = [];
    gaps[presetId] = reason;
  }

  // Classify by what the mapping actually resolves to, not by which table it was
  // declared in: minimax -> ["minimax"] is a same-name match even though the
  // main session wrote it out explicitly (an alias target may be the same id).
  for (const presetId of presetIds) {
    const targets = map[presetId];
    if (targets.length === 0) gap.push(presetId);
    else if (targets.length === 1 && targets[0] === presetId) exact.push(presetId);
    else alias.push(presetId);
  }

  // Table integrity: every declared alias / gap reason must describe a real
  // preset, and a "gap" must not quietly become available upstream.
  if (strictTable) {
    for (const presetId of Object.keys(ALIASES)) {
      if (!presetIds.includes(presetId)) {
        throw new Error(`provider-map: ALIASES has an entry for unknown preset '${presetId}'`);
      }
    }
    for (const presetId of Object.keys(GAP_REASONS)) {
      if (!presetIds.includes(presetId)) {
        throw new Error(`provider-map: GAP_REASONS has an entry for unknown preset '${presetId}'`);
      }
      if (ids.has(presetId)) {
        throw new Error(
          `provider-map: preset '${presetId}' is listed as a gap but models.dev now carries an exact provider with that id; ` +
            'decide whether to map it and remove it from GAP_REASONS'
        );
      }
    }
  }

  return { map, gaps, exact, alias, gap, shadowed };
}

export function providerMapDocument(derived) {
  return {
    _comment:
      '我们的预设 ID → models.dev provider id 的完整映射。由 scripts/model-catalog/build-catalog.mjs 依据 shared/presets/*.json 文件名与 models.dev provider id 的比对生成，勿手改；确需例外请改脚本里的 ALIASES / GAP_REASONS。数组按运行时查找顺序排列（取第一个含该模型的 provider）。空数组表示 models.dev 无对应 provider，原因见 _gaps，模型详情请写进 overrides.json。',
    schema: SCHEMA_VERSION,
    source: SOURCE,
    generated_by: 'scripts/model-catalog/build-catalog.mjs',
    providers: derived.map,
    _gaps: derived.gaps,
  };
}

// ---------------------------------------------------------------------------
// Overrides validation
//
// overrides.json is the top-priority manual layer. The build cannot apply it
// (catalog.json stays a pure models.dev projection), but it can refuse to ship
// a malformed one: unknown preset ids, unknown fields or a bad shape would
// otherwise only surface as a silent miss at runtime.
// ---------------------------------------------------------------------------
const OVERRIDE_FIELDS = new Set(['limit', 'reasoning', 'reasoning_options', 'family', 'release_date', 'note']);

export function validateOverrides(overrides, presetIds = listPresetIds()) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('overrides.json must be a JSON object');
  }
  if (overrides.schema !== SCHEMA_VERSION) {
    throw new Error(`overrides.json schema must be ${SCHEMA_VERSION}, got ${JSON.stringify(overrides.schema)}`);
  }
  if (!overrides.models || typeof overrides.models !== 'object' || Array.isArray(overrides.models)) {
    throw new Error('overrides.json models must be an object');
  }

  const known = new Set(presetIds);
  const problems = [];
  for (const [key, patch] of Object.entries(overrides.models)) {
    const slash = key.indexOf('/');
    if (slash <= 0 || slash === key.length - 1) {
      problems.push(`'${key}': key must be "<preset id>/<model id>"`);
      continue;
    }
    const presetId = key.slice(0, slash);
    if (!known.has(presetId)) {
      problems.push(`'${key}': preset id '${presetId}' has no shared/presets/${presetId}.json`);
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      problems.push(`'${key}': patch must be an object`);
      continue;
    }
    for (const [field, value] of Object.entries(patch)) {
      if (!OVERRIDE_FIELDS.has(field)) {
        problems.push(`'${key}': unknown field '${field}' (allowed: ${[...OVERRIDE_FIELDS].join(', ')})`);
        continue;
      }
      if (field === 'limit' && normalizeLimit(value) === undefined) {
        problems.push(`'${key}': limit needs at least one finite context/output`);
      }
      if (field === 'reasoning' && typeof value !== 'boolean') {
        problems.push(`'${key}': reasoning must be a boolean`);
      }
      if (field === 'reasoning_options' && !Array.isArray(value)) {
        problems.push(`'${key}': reasoning_options must be an array`);
      }
      if ((field === 'family' || field === 'release_date') && (typeof value !== 'string' || empty(value))) {
        problems.push(`'${key}': ${field} must be a non-empty string`);
      }
      if (field === 'note' && (typeof value !== 'string' || empty(value))) {
        problems.push(`'${key}': note must be a non-empty string`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`overrides.json is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return { count: Object.keys(overrides.models).length };
}

// ---------------------------------------------------------------------------
// Full conversion (pure: no writes)
// ---------------------------------------------------------------------------
export function convertModelsDev(modelsDev, fetchedAt, presetIds = listPresetIds()) {
  const { catalog, stats } = buildCatalog(modelsDev, fetchedAt);
  const json = JSON.stringify(catalog);
  const gz = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  // Partial inputs (the test fixture, a per-vendor scrape) cannot resolve every
  // preset alias, so map derivation is skippable. The CLI never skips it.
  const derived = presetIds ? deriveProviderMap(presetIds, Object.keys(catalog.providers)) : null;
  return { catalog, stats, json, gz, derived, presetIds: presetIds || [] };
}

/**
 * Reads `inputPath`, converts, and optionally writes the artifacts into
 * `outDir`. Returns everything the caller needs to assert on, including the
 * exact byte strings that were (or would be) written.
 *
 * `mapPresets: false` skips provider-map derivation (see convertModelsDev).
 */
export function generate(
  inputPath,
  { outDir = CATALOG_DIR, write = true, overridesPath = OVERRIDES_PATH, mapPresets = true } = {}
) {
  const inputStat = statSync(inputPath);
  // mtime, not "now", so re-running over the same download is byte-identical.
  const fetchedAt = new Date(inputStat.mtimeMs).toISOString();
  const modelsDev = JSON.parse(readFileSync(inputPath, 'utf8'));

  const result = convertModelsDev(modelsDev, fetchedAt, mapPresets ? listPresetIds() : null);

  // Fail before touching any artifact output.
  let overrides = { count: 0 };
  if (overridesPath) {
    overrides = validateOverrides(JSON.parse(readFileSync(overridesPath, 'utf8')));
  }

  const { json, gz, derived } = result;
  const jsonBytes = Buffer.byteLength(json, 'utf8');

  if (jsonBytes > MAX_CATALOG_JSON_BYTES) {
    throw new Error(
      `catalog.json is ${jsonBytes} B, over the ${MAX_CATALOG_JSON_BYTES} B budget; trim the projection or renegotiate the budget`
    );
  }
  if (gz.length > MAX_CATALOG_GZ_BYTES) {
    throw new Error(
      `catalog.json.gz is ${gz.length} B, over the ${MAX_CATALOG_GZ_BYTES} B (140 KiB) budget; trim the projection or renegotiate the budget`
    );
  }

  if (write) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'catalog.json'), json, 'utf8');
    writeFileSync(join(outDir, 'catalog.json.gz'), gz);
    if (derived) {
      writeFileSync(join(outDir, 'provider-map.json'), JSON.stringify(providerMapDocument(derived), null, 2) + '\n', 'utf8');
    }
  }

  return { ...result, jsonBytes, gzBytes: gz.length, inputStat, fetchedAt, overrides };
}

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function printComparison(result) {
  const { derived, presetIds, catalog } = result;
  console.log(
    `Preset ↔ models.dev comparison: ${presetIds.length} presets vs ${Object.keys(catalog.providers).length} catalog providers ` +
      `(${derived.exact.length} exact / ${derived.alias.length} alias / ${derived.gap.length} gap)`
  );
  if (derived.exact.length > 0) {
    console.log(`  exact (same id): ${derived.exact.join(', ')}`);
  }
  for (const id of derived.alias) {
    console.log(`  alias: ${id} -> ${JSON.stringify(derived.map[id])}`);
  }
  for (const id of derived.gap) {
    console.log(`  gap:   ${id} -> [] (${derived.gaps[id]})`);
  }
  for (const s of derived.shadowed) {
    console.log(`  note:  ${s.presetId} also exists upstream, but the confirmed alias ${JSON.stringify(s.targets)} takes precedence`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const flags = new Map();
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) flags.set(arg.slice(2), true);
      else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      positional.push(arg);
    }
  }

  const inputPath = positional[0] || '/tmp/modelsdev/api.json';

  // --fixture=<id,id,...>: cut a small, committable sample out of the input so
  // the test suite never depends on the network or on /tmp.
  if (flags.has('fixture')) {
    const ids = String(flags.get('fixture'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const modelsDev = JSON.parse(readFileSync(inputPath, 'utf8'));
    const sample = {};
    for (const id of ids.sort()) {
      if (!modelsDev[id]) throw new Error(`--fixture: provider '${id}' not found in ${inputPath}`);
      sample[id] = modelsDev[id];
    }
    writeFileSync(FIXTURE_PATH, JSON.stringify(sample, null, 1) + '\n', 'utf8');
    const count = Object.values(sample).reduce((n, p) => n + Object.keys(p.models || {}).length, 0);
    console.log(`Generated fixture at: ${FIXTURE_PATH} (${ids.length} providers, ${count} models, ${statSync(FIXTURE_PATH).size} bytes)`);
    return;
  }

  if (flags.has('check')) {
    // No writes: re-derive and compare against what is on disk. Intended for a
    // human run after pulling a fresh api.json, and for the drift review.
    const result = generate(inputPath, { write: false });
    printComparison(result);
    validateOverrides(JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')), result.presetIds);
    const onDiskMap = JSON.parse(readFileSync(PROVIDER_MAP_PATH, 'utf8'));
    const expected = providerMapDocument(result.derived);
    if (JSON.stringify(onDiskMap) !== JSON.stringify(expected)) {
      console.error('provider-map.json is stale: re-run `npm run catalog:build`');
      process.exit(1);
    }
    const onDiskJson = readFileSync(CATALOG_JSON_PATH, 'utf8');
    const onDiskGz = readFileSync(CATALOG_GZ_PATH);
    if (onDiskJson !== result.json || !onDiskGz.equals(result.gz)) {
      console.error('catalog.json / catalog.json.gz are stale relative to the input: re-run `npm run catalog:build`');
      process.exit(1);
    }
    console.log('catalog.json, catalog.json.gz and provider-map.json are up to date with the input');
    return;
  }

  const result = generate(inputPath, { write: true });
  console.log(
    `Input: ${inputPath} (${fmt(result.inputStat.size)} bytes, mtime ${result.fetchedAt})`
  );
  console.log(
    `Generated catalog at: ${CATALOG_JSON_PATH} (${fmt(result.stats.modelCount)} models / ` +
      `${result.stats.providerCount} providers, ${fmt(result.jsonBytes)} bytes, limit ${fmt(MAX_CATALOG_JSON_BYTES)})`
  );
  console.log(
    `Generated gzip    at: ${CATALOG_GZ_PATH} (${fmt(result.gzBytes)} bytes, limit ${fmt(MAX_CATALOG_GZ_BYTES)} = 140 KiB)`
  );
  if (result.stats.droppedProviders.length > 0) {
    console.log(`Dropped providers without models: ${result.stats.droppedProviders.join(', ')}`);
  }
  console.log(
    `reasoning_options types: ${Object.entries(result.stats.optionTypeCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`
  );
  if (result.stats.warnings.length > 0) {
    console.log(`Warnings (${result.stats.warnings.length}):`);
    for (const w of result.stats.warnings.slice(0, 20)) console.log(`  - ${w}`);
  }
  printComparison(result);
  console.log(
    `Generated provider map at: ${PROVIDER_MAP_PATH} (${result.presetIds.length} presets: ` +
      `${result.derived.exact.length} exact / ${result.derived.alias.length} alias / ${result.derived.gap.length} gap)`
  );
  console.log(`Validated overrides at: ${OVERRIDES_PATH} (${result.overrides.count} manual entries)`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}