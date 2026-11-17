#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sharedPresetsDir = __dirname;
const projectRoot = join(__dirname, '../..');

let releaseDate = '2026-11-08';
try {
  const versionJson = JSON.parse(readFileSync(join(projectRoot, 'version.json'), 'utf8'));
  releaseDate = String(versionJson.release_date || versionJson.version || '2026-11-08');
} catch (_) {}

const catalogVersion = releaseDate.replace(/-/g, '.');

const presetFiles = readdirSync(sharedPresetsDir)
  .filter((f) => f.endsWith('.json') && f !== 'catalog.json')
  .sort();

const presets = presetFiles.map((file) => JSON.parse(readFileSync(join(sharedPresetsDir, file), 'utf8')));

const catalog = {
  version: catalogVersion,
  updated_at: `${releaseDate}T00:00:00.000Z`,
  providers: presets.map((p) => {
    const rulesStr = JSON.stringify(p.adapter_rules || {});
    const ruleHash = createHash('sha256').update(rulesStr).digest('hex').slice(0, 12);
    return {
      id: p.id,
      name: p.name,
      version: p.version || '1.0.0',
      updated_at: p.updated_at || releaseDate,
      update_notes: p.update_notes || p.description || '',
      rule_hash: ruleHash,
      protocol: p.protocol || 'openai',
      base_url: p.base_url || '',
      anthropic_base_url: p.anthropic_base_url || null,
      doc_url: p.doc_url || null,
      description: p.description || '',
      features: p.features || {},
      recommended_models_count: (p.recommended_models || []).length,
    };
  }),
};

const catalogPath = join(sharedPresetsDir, 'catalog.json');
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
console.log(`Generated catalog at: ${catalogPath} (${presets.length} presets, version ${catalogVersion})`);

/**
 * Normalizes nested v1 preset adapter_rules into flat v2 Go AdapterRules keys.
 */
export function normalizeAdapterRules(rawRules) {
  if (!rawRules || typeof rawRules !== 'object') return {};
  const out = {};

  // 1. Headers: inject_headers -> extra_headers
  const headersSrc = {
    ...(rawRules.inject_headers && typeof rawRules.inject_headers === 'object' ? rawRules.inject_headers : {}),
    ...(rawRules.extra_headers && typeof rawRules.extra_headers === 'object' ? rawRules.extra_headers : {}),
  };
  if (Object.keys(headersSrc).length > 0) {
    out.extra_headers = headersSrc;
  }

  // 2. Sanitization: strip_params, strip_reasoning_enabled, max_tokens_ceiling
  const san = rawRules.sanitization && typeof rawRules.sanitization === 'object' ? rawRules.sanitization : {};
  const stripSet = new Set([
    ...(Array.isArray(san.unsupported_params) ? san.unsupported_params : []),
    ...(Array.isArray(san.strip_params) ? san.strip_params : []),
    ...(Array.isArray(rawRules.strip_params) ? rawRules.strip_params : []),
  ].filter((x) => typeof x === 'string' && x.trim()));
  if (stripSet.size > 0) {
    out.strip_params = Array.from(stripSet);
  }
  if (rawRules.strip_reasoning_enabled === true || san.strip_reasoning_enabled === true) {
    out.strip_reasoning_enabled = true;
  }
  const ceiling = Number(rawRules.max_tokens_ceiling ?? san.max_tokens_ceiling ?? 0);
  if (Number.isFinite(ceiling) && ceiling > 0) {
    out.max_tokens_ceiling = Math.floor(ceiling);
  }

  // 3. Messages: deny_developer_role, system_first_only, merge_system, strip_empty
  const msg = rawRules.messages && typeof rawRules.messages === 'object' ? rawRules.messages : {};
  if (rawRules.deny_developer_role === true || msg.deny_developer_role === true) out.deny_developer_role = true;
  if (rawRules.system_first_only === true || msg.system_first_only === true) out.system_first_only = true;
  if (rawRules.merge_system === true || msg.merge_system === true) out.merge_system = true;
  if (rawRules.strip_empty === true || msg.strip_empty === true) out.strip_empty = true;

  // 4. Tools & Gemini compatibility
  const tools = rawRules.tools && typeof rawRules.tools === 'object' ? rawRules.tools : {};
  if (rawRules.rescue_from_text === true || tools.rescue_from_text === true) out.rescue_from_text = true;
  if (rawRules.normalize_choice_to_string === true || tools.normalize_choice_to_string === true) {
    out.normalize_choice_to_string = true;
  }

  const reas = rawRules.reasoning && typeof rawRules.reasoning === 'object' ? rawRules.reasoning : {};
  if (
    rawRules.gemini_compat === true ||
    reas.strategy === 'gemini_thinking_matrix' ||
    tools.deep_schema_sanitization === true ||
    tools.strip_json_schema === true
  ) {
    out.gemini_compat = true;
  }

  // 5. Reasoning: thought_tag_marker & thinking_policy
  const rawMarker = rawRules.thought_tag_marker ?? reas.thought_tag_marker;
  if (rawMarker === true) {
    out.thought_tag_marker = '<thought>';
  } else if (typeof rawMarker === 'string' && rawMarker.trim()) {
    out.thought_tag_marker = rawMarker;
  }

  if (typeof rawRules.thinking_policy === 'string' && rawRules.thinking_policy.trim()) {
    out.thinking_policy = rawRules.thinking_policy.trim();
  } else if (reas.force_adaptive_thinking === true) {
    out.thinking_policy = 'force';
  }

  // 6. Response: unwrap_root, reasoning_fields
  const resp = rawRules.response && typeof rawRules.response === 'object' ? rawRules.response : {};
  const unwrapRoot = rawRules.unwrap_root ?? resp.unwrap_root;
  if (typeof unwrapRoot === 'string' && unwrapRoot.trim()) {
    out.unwrap_root = unwrapRoot.trim();
  }
  const reasFields = Array.isArray(rawRules.reasoning_fields)
    ? rawRules.reasoning_fields
    : (Array.isArray(resp.reasoning_fields) ? resp.reasoning_fields : []);
  const cleanReasFields = reasFields.filter((f) => typeof f === 'string' && f.trim());
  if (cleanReasFields.length > 0) {
    out.reasoning_fields = cleanReasFields;
  }

  // 7. Model prefix & aliases
  if (rawRules.ensure_google_prefix === true) {
    out.ensure_google_prefix = true;
  }
  const aliases = {
    ...(rawRules.case_sensitive_models && typeof rawRules.case_sensitive_models === 'object' ? rawRules.case_sensitive_models : {}),
    ...(rawRules.model_alias && typeof rawRules.model_alias === 'object' ? rawRules.model_alias : {}),
    ...(rawRules.model_aliases && typeof rawRules.model_aliases === 'object' ? rawRules.model_aliases : {}),
  };
  if (Object.keys(aliases).length > 0) {
    out.model_aliases = aliases;
  }

  // Preserve optional flat overrides if present
  if (rawRules.stream_only === true) out.stream_only = true;
  if (typeof rawRules.auth_header === 'string' && rawRules.auth_header.trim()) out.auth_header = rawRules.auth_header.trim();
  if (typeof rawRules.auth_prefix === 'string' && rawRules.auth_prefix) out.auth_prefix = rawRules.auth_prefix;

  return out;
}

const presetMap = {};
for (const p of presets) {
  if (p && p.id) {
    presetMap[p.id] = {
      ...p,
      adapter_rules: normalizeAdapterRules(p.adapter_rules),
    };
  }
}

const generatedPresetsPath = join(projectRoot, 'edgeone-hub/lib/generated-presets.js');
const generatedContent = `/**
 * Pre-compiled preset map for EdgeOne Hub (pure Web Standard, zero node:fs).
 * Generated by shared/presets/build-catalog.mjs; do not edit directly.
 */
export const PRESET_MAP = ${JSON.stringify(presetMap)};
`;
writeFileSync(generatedPresetsPath, generatedContent, 'utf8');
console.log(`Generated presets map at: ${generatedPresetsPath} (${Object.keys(presetMap).length} presets)`);

// Also emit the release version as a hub-importable module so /healthz can report
// which build is actually deployed (deployment-lag detection).
const versionJson = JSON.parse(readFileSync(join(projectRoot, 'version.json'), 'utf8'));
const generatedVersionPath = join(projectRoot, 'edgeone-hub/lib/generated-version.js');
writeFileSync(
  generatedVersionPath,
  `/**
 * Release version for EdgeOne Hub functions (pure Web Standard).
 * Generated by shared/presets/build-catalog.mjs from version.json; do not edit directly.
 */
export const VERSION = ${JSON.stringify(versionJson.version)};
export const SEMVER = ${JSON.stringify(versionJson.semver)};
export const RELEASE_DATE = ${JSON.stringify(versionJson.release_date)};
`,
  'utf8'
);
console.log(`Generated version module at: ${generatedVersionPath} (${versionJson.version} / ${versionJson.semver})`);
