#!/usr/bin/env node
/**
 * scripts/magpie-presets.mjs
 *
 * Converts yetone/magpie's provider preset table into this repository's preset
 * library, so upstream brand onboarding does not have to be retyped by hand.
 *
 *   node scripts/magpie-presets.mjs check                 # what is missing / drifted vs upstream
 *   node scripts/magpie-presets.mjs import --only=xai,longcat   # import chosen brands
 *   node scripts/magpie-presets.mjs import --all          # import everything importable
 *
 * Flags:
 *   --magpie <dir>   magpie checkout (default: $MAGPIE_DIR or ../magpie, then
 *                    ~/.cache/llmproxy2/magpie-presets)
 *   --only <ids>     comma-separated upstream ids to import
 *   --all            import every importable upstream preset
 *   --force          overwrite existing files and never bump versions, just
 *                    take upstream's values
 *   --dry-run        print what import would write without touching the repo
 *   --json           machine-readable output
 *
 * What maps 1:1 (magpie PresetDef → shared/presets/<id>.json):
 *   ID → id, Name → name, Chat → base_url, Anthropic → anthropic_base_url,
 *   Website → doc_url, Note → description, Models → recommended_models,
 *   Regions/KeyPlans/NoList → the same fields in the Go catalog.
 *
 * What cannot be converted: magpie adapts per vendor in Go code
 * (internal/provider/<vendor>.go). Nothing in its table describes those
 * rewrites, so imported presets start with `adapter_rules: {}` — they are
 * endpoint-correct but not behaviour-equivalent. Add rules here afterwards.
 *
 * Files written:
 *   shared/presets/<id>.json                    adapter file
 *   internal/provider/presets_imported_generated.go   catalog entries
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const presetsDir = join(projectRoot, 'shared', 'presets');
const goOutPath = join(projectRoot, 'internal', 'provider', 'presets_imported_generated.go');
const SOURCE_REPO = 'yetone/magpie';

// Upstream ids that differ from ours; the report matches through this table.
const ID_ALIASES = {
  'google-vertex': 'vertex',
  'opencode-zen': 'opencode',
};

// magpie's PresetDef.Kind → ours
const KIND_MAP = { vendor: 'vendor', relay: 'relay', local: 'local', remote: 'remote' };

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const say = (s = '') => console.log(s);
const header = (t) => say(`\n${colors.bold}${colors.cyan}▶ ${t}${colors.reset}`);

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = { command: 'check', magpie: process.env.MAGPIE_DIR || '', only: [], all: false, force: false, dryRun: false, json: false, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    // --only=xai / --magpie=/path are accepted alongside the space-separated form.
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const a = eq > 0 ? raw.slice(0, eq) : raw;
    if (eq > 0) argv[i] = a;
    if (eq > 0) argv.splice(i + 1, 0, raw.slice(eq + 1));
    if (a === '--magpie') args.magpie = argv[++i] || '';
    else if (a === '--only') args.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--all') args.all = true;
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') args.command = 'help';
    else args.command = a;
  }
  return args;
}

// magpie's preset table can come from a working tree or from the bare clone
// scripts/magpie-sync.mjs already keeps under ~/.cache/llmproxy2/magpie.git —
// that one needs no extra checkout, so `check` works out of the box.
function resolveSource(arg) {
  const dirs = [arg, process.env.MAGPIE_DIR, join(projectRoot, '..', 'magpie'), join(homedir(), '.cache', 'llmproxy2', 'magpie-presets')].filter(Boolean);
  for (const dir of dirs) {
    if (existsSync(join(dir, 'internal', 'provider', 'presets.go'))) return { kind: 'dir', dir };
  }
  const bare = join(homedir(), '.cache', 'llmproxy2', 'magpie.git');
  if (existsSync(bare)) {
    try {
      execFileSync('git', ['-C', bare, 'cat-file', '-e', 'HEAD:internal/provider/presets.go']);
      return { kind: 'git', dir: bare };
    } catch (_) {}
  }
  throw new Error(
    `找不到 magpie 源码。用 --magpie <dir> 指定，或先建缓存：\n  node scripts/magpie-sync.mjs check   # 会在 ~/.cache/llmproxy2/magpie.git 建 bare 克隆\n  或: git clone --depth 1 https://github.com/yetone/magpie.git ~/.cache/llmproxy2/magpie-presets`,
  );
}

// The sync cache is a --filter=blob:none clone: reading files one by one would
// fetch blobs individually over the network. `git archive` pulls the whole
// internal/provider tree in one go, cached per commit, and everything after
// that is local file IO.
function materializeGit(src) {
  const commit = execFileSync('git', ['-C', src.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const cacheDir = join(homedir(), '.cache', 'llmproxy2', `magpie-provider-${commit.slice(0, 12)}`);
  if (!existsSync(join(cacheDir, 'internal', 'provider', 'presets.go'))) {
    mkdirSync(cacheDir, { recursive: true });
    execFileSync('sh', ['-c', `git -C '${src.dir}' archive HEAD internal/provider | tar -x -C '${cacheDir}'`], { stdio: 'inherit' });
  }
  return { kind: 'dir', dir: cacheDir, commit };
}

function sourceCommit(src) {
  if (src.commit) return src.commit;
  try {
    return execFileSync('git', ['-C', src.dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

/* ------------------------------------------------- Go literal scanning */

// Removes // line comments and /* */ blocks, leaving string literals intact so
// a "//" inside a URL is never mistaken for a comment.
function stripGoComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === '`') {
      const quote = c;
      out += c;
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === '\\' && quote === '"') { out += src[++i] ?? ''; continue; }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}

// Returns the body of `var presets = []PresetDef{ ... }` (brace-balanced).
function extractPresetTable(src) {
  const start = src.indexOf('var presets = []PresetDef{');
  if (start < 0) throw new Error('magpie presets.go: `var presets = []PresetDef{` not found');
  const open = src.indexOf('{', start + 'var presets = []PresetDef'.length);
  let depth = 0;
  let inStr = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\' && inStr === '"') { i++; continue; }
      if (c === inStr) inStr = '';
      continue;
    }
    if (c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('magpie presets.go: unbalanced preset table');
}

// Splits `{...}, {...}` into element bodies at depth 0.
function splitElements(body) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (c === '\\' && inStr === '"') { i++; continue; }
      if (c === inStr) inStr = '';
      continue;
    }
    if (c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') { if (depth === 0) start = i + 1; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) { out.push(body.slice(start, i)); start = -1; }
    }
  }
  return out;
}

function parseGoStrings(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1].replace(/\\(.)/g, '$1'));
  return out;
}

// Field accessors over one element body.
function fieldStr(el, name, consts) {
  const m = new RegExp(`\\b${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(el);
  if (m) return m[1].replace(/\\(.)/g, '$1');
  // Chat: OpenCodeGoChat — the value is a package-level const string.
  const c = new RegExp(`\\b${name}:\\s*([A-Z][A-Za-z0-9_]*)`).exec(el);
  return c && consts ? consts[c[1]] || '' : '';
}
function fieldRaw(el, name) {
  const m = new RegExp(`\\b${name}:\\s*([^,\\n]+)`).exec(el);
  return m ? m[1].trim() : '';
}
function fieldBool(el, name) {
  return new RegExp(`\\b${name}:\\s*true\\b`).test(el);
}
function fieldStrings(el, name) {
  const m = new RegExp(`\\b${name}:\\s*\\[\\]string\\{([\\s\\S]*?)\\}`).exec(el);
  return m ? parseGoStrings(m[1]) : [];
}
function fieldRegions(el) {
  const m = /\bRegions:\s*\[\]Region\{([\s\S]*?)\},\s*(?:\n\s*[A-Za-z]|$)/.exec(el);
  if (!m) return [];
  return splitElements(m[1]).map((r) => ({
    id: fieldStr(r, 'ID'),
    name: fieldStr(r, 'Name'),
    chat: fieldStr(r, 'Chat'),
    anthropic: fieldStr(r, 'Anthropic'),
    lists: fieldBool(r, 'Lists'),
  }));
}

// const identifiers used as ID (magpie: VertexPreset, AzurePreset, ...).
const CONST_DEF = /^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gm;

function collectConsts(dir) {
  const consts = {};
  const pkgDir = join(dir.dir, 'internal', 'provider');
  for (const f of readdirSync(pkgDir)) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
    const text = stripGoComments(readFileSync(join(pkgDir, f), 'utf8'));
    CONST_DEF.lastIndex = 0;
    let m;
    while ((m = CONST_DEF.exec(text))) consts[m[1]] = m[2];
  }
  return consts;
}

/* ------------------------------------------------ magpie → our schema */

function stripSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

function toOurPreset(el, consts) {
  const rawId = fieldRaw(el, 'ID');
  const id = rawId.startsWith('"') ? fieldStr(el, 'ID') : consts[rawId] || '';
  if (!id) return { skip: 'id 无法静态解析' };

  const name = fieldStr(el, 'Name') || id;
  const chat = stripSlash(fieldStr(el, 'Chat', consts));
  const anthropic = stripSlash(fieldStr(el, 'Anthropic', consts));
  const note = fieldStr(el, 'Note');
  const endpoint = fieldStr(el, 'Endpoint');
  const decide = fieldStr(el, 'Decide', consts);
  const regions = fieldRegions(el);
  const dynamicRegions = /\bRegions:\s*(?!\[\]Region\{)/.test(el);

  // `Decide` is an extra routing endpoint magpie adds beside Chat/Anthropic
  // (OpenRouter has all three); it only disqualifies a preset when it is the
  // sole endpoint, i.e. a decision-API-only provider.
  const regionHasModelEndpoint = regions.some((r) => r.chat || r.anthropic);
  if (!chat && !anthropic && !regionHasModelEndpoint) {
    if (decide) return { id, name, skip: '只有 Decide 端点（magpie 内部路由 API，无模型端点）' };
    if (dynamicRegions) return { id, name, skip: 'region 由函数动态生成（bedrock/qwencloud 等），需手工建' };
    return { id, name, skip: endpoint ? 'endpoint 由用户自填（Azure 类），无固定 base_url' : '没有固定端点' };
  }
  if (dynamicRegions && !chat && !anthropic) {
    return { id, name, skip: 'region 由函数动态生成（bedrock/qwencloud 等），需手工建' };
  }

  const base = chat || (regions[0] && stripSlash(regions[0].chat)) || anthropic;
  const protocol = chat ? 'openai' : 'anthropic';
  const models = fieldStrings(el, 'Models');

  return {
    id,
    name,
    skip: '',
    kind: KIND_MAP[fieldStr(el, 'Kind').replace('Kind', '').toLowerCase()] || 'vendor',
    icon: fieldStr(el, 'Icon'),
    chat,
    responses: stripSlash(fieldStr(el, 'Responses')),
    anthropic: anthropic || (regions[0] && stripSlash(regions[0].anthropic)) || '',
    website: fieldStr(el, 'Website', consts),
    keysURL: fieldStr(el, 'KeysURL', consts),
    note,
    noList: fieldBool(el, 'NoList'),
    keyPlans: fieldBool(el, 'KeyPlans'),
    regions,
    base_url: base,
    adapterFile: {
      id,
      name,
      version: '1.0.0',
      updated_at: new Date().toISOString().slice(0, 10),
      update_notes: note || `${name} 预设导入自 ${SOURCE_REPO}，端点与模型清单对齐上游；协议改写仍需在本仓 adapter_rules 里补齐`,
      protocol,
      base_url: base,
      anthropic_base_url: anthropic || undefined,
      doc_url: fieldStr(el, 'Website', consts) || null,
      description: note || `${name}（${SOURCE_REPO} 预设）`,
      features: { native_thinking: false, multimodal: false, tools: true, anthropic_messages: Boolean(anthropic) },
      recommended_models: models.map((m) => ({ name: m, upstream_model: m, description: '' })),
      adapter_rules: {},
      source: { repo: SOURCE_REPO, preset_id: id },
    },
  };
}

function fingerprint(p) {
  return [p.chat, p.responses, p.anthropic, p.base_url].join('|');
}

/* ------------------------------------------------------------- reading */

function readUpstream(source) {
  const src = source.kind === 'git' ? materializeGit(source) : source;
  const presetsGo = stripGoComments(readFileSync(join(src.dir, 'internal', 'provider', 'presets.go'), 'utf8'));
  const consts = collectConsts(src);
  const body = extractPresetTable(presetsGo);
  const commit = sourceCommit(src);
  return splitElements(body).map((el) => toOurPreset(el, consts)).filter((p) => p.id).map((p) => ({ ...p, commit }));
}

function readOurs() {
  const out = new Map();
  for (const f of readdirSync(presetsDir)) {
    if (!f.endsWith('.json') || f === 'catalog.json') continue;
    const doc = JSON.parse(readFileSync(join(presetsDir, f), 'utf8'));
    out.set(doc.id, doc);
  }
  return out;
}

const ourIdFor = (upId) => ID_ALIASES[upId] || upId;

/* -------------------------------------------------------------- check */

function cmdCheck(args) {
  const source = resolveSource(args.magpie);
  const upstream = readUpstream(source);
  const ours = readOurs();
  const importable = upstream.filter((p) => !p.skip);

  const missing = importable.filter((p) => !ours.has(ourIdFor(p.id)));
  const matched = importable.filter((p) => ours.has(ourIdFor(p.id)));
  const mismatched = [];
  const missingEndpoints = [];
  const aligned = [];
  for (const p of matched) {
    const mine = ours.get(ourIdFor(p.id));
    const pairs = [
      ['chat', stripSlash(p.chat), stripSlash(mine.base_url)],
      ['anthropic', stripSlash(p.anthropic), stripSlash(mine.anthropic_base_url)],
    ];
    // A multi-plan preset (zhipu/zai/volcengine/...) keeps each plan's
    // Anthropic endpoint in Regions; the default plan's counts as present.
    if (!mine.anthropic_base_url && p.anthropic) {
      const r0 = (p.regions || [])[0];
      if (r0 && r0.anthropic) pairs[1][2] = stripSlash(r0.anthropic);
    }
    const both = pairs.filter(([, up, mi]) => up && mi && up !== mi);
    const absent = pairs.filter(([, up, mi]) => up && !mi);
    if (both.length) mismatched.push(p.id);
    else if (absent.length) missingEndpoints.push(p.id);
    else aligned.push(p.id);
  }
  const skipped = upstream.filter((p) => p.skip);

  if (args.json) {
    say(JSON.stringify({
      upstream: upstream.length,
      importable: importable.length,
      aligned,
      mismatched,
      missingEndpoints,
      missing: missing.map((p) => p.id),
      skipped: skipped.map((p) => ({ id: p.id, reason: p.skip })),
    }, null, 2));
    return 0;
  }

  header(`上游 ${SOURCE_REPO} @ ${upstream[0]?.commit || '?'} — ${upstream.length} 个预设（可导入 ${importable.length}）`);
  say(`  已对齐      ${colors.green}${aligned.length}${colors.reset}`);
  say(`  端点不一致  ${mismatched.length ? colors.yellow : colors.dim}${mismatched.length}${colors.reset}${mismatched.length ? `  ${mismatched.join(', ')}` : ''}`);
  say(`  缺上游端点  ${missingEndpoints.length ? colors.yellow : colors.dim}${missingEndpoints.length}${colors.reset}${missingEndpoints.length ? `  ${missingEndpoints.join(', ')}` : ''}`);
  say(`  本仓缺失    ${missing.length ? colors.yellow : colors.dim}${missing.length}${colors.reset}`);
  if (missing.length) say(`    ${missing.map((p) => p.id).join(', ')}`);
  if (skipped.length) {
    say(`  无法导入    ${colors.dim}${skipped.length}${colors.reset}`);
    for (const p of skipped) say(`    ${colors.dim}${p.id}: ${p.skip}${colors.reset}`);
  }
  say(`\n${colors.dim}导入任意一个: node scripts/magpie-presets.mjs import --only=${missing[0]?.id || 'xai'}`);
  say(`导入全部:     node scripts/magpie-presets.mjs import --all${colors.reset}`);
  return 0;
}

/* ------------------------------------------------------------- import */

// Our Go catalog entry for an imported preset.
function goEntry(p) {
  const q = (s) => JSON.stringify(s || '');
  const lines = [];
  lines.push(`\t{`);
  lines.push(`\t\tID:        ${q(p.id)},`);
  lines.push(`\t\tName:      ${q(p.name)},`);
  if (p.icon) lines.push(`\t\tIcon:      ${q(p.icon)},`);
  lines.push(`\t\tKind:      ${q(p.kind)},`);
  lines.push(`\t\tVersion:   ${q(p.adapterFile.version)},`);
  lines.push(`\t\tUpdatedAt: ${q(p.adapterFile.updated_at)},`);
  lines.push(`\t\tBaseURL:   ${q(p.base_url)},`);
  if (p.chat) lines.push(`\t\tChatURL:   ${q(p.chat)},`);
  if (p.responses) lines.push(`\t\tResponsesURL: ${q(p.responses)},`);
  if (p.anthropic) lines.push(`\t\tAnthropicBaseURL: ${q(p.anthropic)},`);
  if (p.website) lines.push(`\t\tWebsite:   ${q(p.website)},`);
  if (p.keysURL) lines.push(`\t\tKeysURL:   ${q(p.keysURL)},`);
  if (p.noList) lines.push(`\t\tNoList:    true,`);
  if (p.keyPlans) lines.push(`\t\tKeyPlans:  true,`);
  if (p.adapterFile.recommended_models.length) {
    lines.push(`\t\tModels:    []string{${p.adapterFile.recommended_models.map((m) => q(m.name)).join(', ')}},`);
  }
  if (p.regions && p.regions.length) {
    lines.push(`\t\tRegions: []Region{`);
    for (const r of p.regions) {
      const parts = [`ID: ${q(r.id || r.name)}`, `Name: ${q(r.name || r.id)}`];
      if (r.chat) parts.push(`ChatURL: ${q(r.chat)}`);
      if (r.anthropic) parts.push(`AnthropicBaseURL: ${q(r.anthropic)}`);
      if (r.lists) parts.push(`Lists: true`);
      lines.push(`\t\t\t{${parts.join(', ')}},`);
    }
    lines.push(`\t\t},`);
  }
  lines.push(`\t},`);
  return lines.join('\n');
}

function writeGoFile(imported) {
  const body = imported.length ? imported.map(goEntry).join('\n') : '';
  const src = `// Code generated by scripts/magpie-presets.mjs; DO NOT EDIT.
//
// Presets converted from ${SOURCE_REPO}'s provider table. They are appended to
// catalogPresets in presets.go's init(), so the picker, /api/admin/presets-extra
// and the adapter-version invariant see them exactly like hand-written entries.
// Re-run \`node scripts/magpie-presets.mjs import --all\` to refresh.

package provider

var importedPresets = []PresetDef{
${body}
}
`;
  writeFileSync(goOutPath, src);
}

function cmdImport(args) {
  const source = resolveSource(args.magpie);
  const outDir = args.out || presetsDir;
  const upstream = readUpstream(source);
  const ours = readOurs();

  let picked;
  if (args.all) picked = upstream.filter((p) => !p.skip);
  else if (args.only.length) {
    picked = upstream.filter((p) => args.only.includes(p.id));
    const unknown = args.only.filter((id) => !upstream.some((p) => p.id === id));
    if (unknown.length) throw new Error(`上游没有这些预设: ${unknown.join(', ')}`);
  } else {
    throw new Error('指定 --only=<ids> 或 --all');
  }

  const written = [];
  const skippedExisting = [];
  for (const p of picked) {
    if (p.skip) { skippedExisting.push(`${p.id}（${p.skip}）`); continue; }
    const id = ourIdFor(p.id);
    p.id = id;
    p.adapterFile.id = id;
    p.adapterFile.source.preset_id = p.id;
    p.adapterFile.source.commit = p.commit || '';

    const target = join(outDir, `${id}.json`);
    const exists = existsSync(target);
    if (exists && !args.force) {
      // Re-import keeps our adapter_rules and bumps only when endpoints moved.
      const mine = JSON.parse(readFileSync(target, 'utf8'));
      const mineFp = [stripSlash(mine.base_url), stripSlash(mine.anthropic_base_url)].join('|');
      if (mineFp === [p.base_url, p.anthropic].join('|')) { skippedExisting.push(`${id}（端点未变）`); continue; }
      const [maj, min, pat] = String(mine.version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
      const next = { ...mine, ...p.adapterFile, version: `${maj}.${min}.${pat + 1}`, adapter_rules: mine.adapter_rules || {} };
      if (!args.dryRun) writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
      written.push({ id, action: `updated → v${next.version}` });
      continue;
    }
    if (!args.dryRun) writeFileSync(target, JSON.stringify(p.adapterFile, null, 2) + '\n');
    written.push({ id, action: exists ? 'overwritten' : 'created' });
  }

  // Go catalog is regenerated from every preset that carries our source marker.
  const importedNow = new Map();
  for (const f of readdirSync(presetsDir)) {
    if (!f.endsWith('.json') || f === 'catalog.json') continue;
    const doc = JSON.parse(readFileSync(join(presetsDir, f), 'utf8'));
    if (doc.source && doc.source.repo === SOURCE_REPO) importedNow.set(doc.id, doc);
  }
  const goImported = [...importedNow.keys()].map((id) => {
    const up = upstream.find((p) => ourIdFor(p.id) === id);
    const doc = importedNow.get(id);
    const chat = (up && up.chat) || (/^openai$/.test(doc.protocol) ? stripSlash(doc.base_url) : '');
    return {
      id,
      name: doc.name,
      icon: (up && up.icon) || '',
      kind: (up && up.kind) || 'vendor',
      chat,
      responses: (up && up.responses) || '',
      anthropic: (up && up.anthropic) || stripSlash(doc.anthropic_base_url || ''),
      website: (up && up.website) || doc.doc_url || '',
      keysURL: (up && up.keysURL) || '',
      noList: Boolean(up && up.noList),
      keyPlans: Boolean(up && up.keyPlans),
      regions: (up && up.regions) || [],
      base_url: doc.base_url,
      adapterFile: { ...doc, version: doc.version, updated_at: doc.updated_at, recommended_models: doc.recommended_models || [] },
    };
  });
  if (!args.dryRun) writeGoFile(goImported);

  if (args.json) { say(JSON.stringify({ written, skipped: skippedExisting, goEntries: goImported.length }, null, 2)); return 0; }

  header(args.dryRun ? '导入预演（未写入）' : '导入完成');
  if (args.dryRun && written.length) {
    const sample = picked.find((p) => written.some((w) => w.id === ourIdFor(p.id)));
    if (sample) {
      say(`${colors.dim}样例 ${sample.adapterFile.id}.json:${colors.reset}`);
      say(JSON.stringify(sample.adapterFile, null, 2).split('\n').map((l) => `  ${colors.dim}${l}${colors.reset}`).join('\n'));
      say('');
    }
  }
  for (const w of written) say(`  ${colors.green}+${colors.reset} ${w.id} — ${w.action}`);
  for (const s of skippedExisting) say(`  ${colors.dim}= ${s}${colors.reset}`);
  if (!written.length) say(`  ${colors.dim}没有需要写入的预设${colors.reset}`);
  say(`\n  Go 目录条目: ${goImported.length} 条 → ${colors.dim}internal/provider/presets_imported_generated.go${colors.reset}`);
  say(`  ${colors.dim}下一步: node shared/presets/build-catalog.mjs && npm run build && go test ./internal/provider/${colors.reset}`);
  return 0;
}

/* --------------------------------------------------------------- main */

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    say(`用法:
  node scripts/magpie-presets.mjs check [--magpie <dir>] [--json]
  node scripts/magpie-presets.mjs import --only=<ids> [--dry-run] [--force]
  node scripts/magpie-presets.mjs import --all [--dry-run] [--force]

magpie 预设表 → 本仓 shared/presets/*.json + internal/provider/presets_imported_generated.go
导入只搬端点/模型/官网等静态信息；协议改写（magpie 写在 Go 代码里）不会跟着过来，需要在本仓 adapter_rules 里补。`);
    return 0;
  }
  if (args.command === 'check') return cmdCheck(args);
  if (args.command === 'import') return cmdImport(args);
  throw new Error(`未知命令: ${args.command}`);
}

try {
  process.exitCode = main() ?? 0;
} catch (e) {
  console.error(`${colors.red}✖ ${e.message}${colors.reset}`);
  process.exitCode = 2;
}
