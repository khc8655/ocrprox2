import { constantTimeCompare } from './crypto.js';

export const CONFIG_KV_KEY = 'llmproxy_config';

export class CASConflictError extends Error {
  constructor(currentVersion, submittedVersion) {
    super(`Config version conflict: current is ${currentVersion}, submitted is ${submittedVersion}`);
    this.name = 'CASConflictError';
    this.status = 409;
    this.currentVersion = currentVersion;
    this.submittedVersion = submittedVersion;
  }
}

export class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigValidationError';
    this.status = 400;
  }
}

/**
 * Returns whether a secret string contains mask characters (e.g. ● or ***)
 */
export function isMaskedSecret(val) {
  if (!val) return false;
  if (typeof val !== 'string') return false;
  return val.includes('●') || val.includes('***') || val.startsWith('sk-●') || val.includes('...');
}

/**
 * Masks a secret string for safe display in UI.
 */
export function maskSecret(val) {
  if (!val || typeof val !== 'string') return '';
  if (val.length <= 8) return '●●●●●●●●';
  return `${val.slice(0, 3)}●●●●●●${val.slice(-4)}`;
}

function maskKeysInProviderMap(providerMap) {
  if (!providerMap || typeof providerMap !== 'object') return;
  for (const prov of Object.values(providerMap)) {
    if (prov && Array.isArray(prov.api_keys)) {
      for (const k of prov.api_keys) {
        if (k && k.key) {
          k.key = maskSecret(k.key);
        }
      }
    }
  }
}

/**
 * Returns a cloned config with all API keys masked for public/UI consumption.
 */
export function toMaskedConfig(config) {
  const cloned = JSON.parse(JSON.stringify(config || {}));
  maskKeysInProviderMap(cloned.providers);
  maskKeysInProviderMap(cloned.search_providers);
  return cloned;
}

function restoreMaskedKeysInMap(incomingMap, storedMap, scopeName) {
  if (!incomingMap || typeof incomingMap !== 'object') return;
  const stored = storedMap && typeof storedMap === 'object' ? storedMap : {};

  for (const [pId, pData] of Object.entries(incomingMap)) {
    if (!pData || !Array.isArray(pData.api_keys)) continue;
    const storedPData = stored[pId] || {};
    const storedKeys = Array.isArray(storedPData.api_keys) ? storedPData.api_keys : [];

    const restoredKeys = [];
    for (const k of pData.api_keys) {
      if (!k) continue;
      if (isMaskedSecret(k.key)) {
        const match = storedKeys.find(
          (sk) => (k.id && sk.id === k.id) || (k.label && sk.label === k.label)
        );
        if (match && match.key && !isMaskedSecret(match.key)) {
          k.key = match.key;
          restoredKeys.push(k);
        } else {
          console.warn(`Kernel Guard (${scopeName}): Dropping masked key without stored counterpart: ${pId}/${k.label || k.id}`);
        }
      } else {
        restoredKeys.push(k);
      }
    }
    pData.api_keys = restoredKeys;
  }
}

/**
 * Kernel Guard: Inspects incoming config against storedConfig.
 * If any API key is masked (● or ***), restores the original secret from storedConfig.
 */
export function applyKernelGuard(incomingConfig, storedConfig) {
  if (!incomingConfig || typeof incomingConfig !== 'object') return incomingConfig;
  restoreMaskedKeysInMap(incomingConfig.providers, storedConfig?.providers, 'providers');
  restoreMaskedKeysInMap(incomingConfig.search_providers, storedConfig?.search_providers, 'search_providers');
  return incomingConfig;
}

const VALID_SEARCH_CAPABILITIES = new Set(['search', 'fetch']);
const VALID_ORIGINS = new Set(['vault', 'local']);
const VALID_DOT_PATH_RE = /^[a-zA-Z0-9_.-]+$/;
const VALID_ID_RE = /^[a-z0-9-]+$/;

function validateHttpBaseUrl(rawUrl, ctx) {
  if (rawUrl === undefined || rawUrl === null || rawUrl === '') return;
  if (typeof rawUrl !== 'string') {
    throw new ConfigValidationError(`${ctx}: base_url must be a string`);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new ConfigValidationError(`${ctx}: invalid base_url`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigValidationError(`${ctx}: base_url must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new ConfigValidationError(`${ctx}: base_url must not contain credentials`);
  }
}

function validateDeclarativeSpec(spec, responseObj, ctx) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ConfigValidationError(`${ctx}: declarative request spec must be an object`);
  }
  const method = String(spec.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new ConfigValidationError(`${ctx}: method must be GET or POST`);
  }
  if (typeof spec.path !== 'string' || !spec.path.startsWith('/') || spec.path.includes('..')) {
    throw new ConfigValidationError(`${ctx}: path must start with '/' and must not contain '..'`);
  }
  if (spec.headers !== undefined) {
    if (!spec.headers || typeof spec.headers !== 'object' || Array.isArray(spec.headers)) {
      throw new ConfigValidationError(`${ctx}: headers must be an object`);
    }
    for (const [hk, hv] of Object.entries(spec.headers)) {
      if (/[\r\n]/.test(String(hk)) || /[\r\n]/.test(String(hv))) {
        throw new ConfigValidationError(`${ctx}: headers must not contain CR/LF`);
      }
    }
  }
  const resp = responseObj || spec.response;
  if (resp !== undefined) {
    if (!resp || typeof resp !== 'object' || Array.isArray(resp)) {
      throw new ConfigValidationError(`${ctx}: response mapping must be an object`);
    }
    for (const pathKey of ['results_path', 'content_path', 'title_path']) {
      if (resp[pathKey] !== undefined && resp[pathKey] !== '') {
        if (typeof resp[pathKey] !== 'string' || !VALID_DOT_PATH_RE.test(resp[pathKey])) {
          throw new ConfigValidationError(`${ctx}: response.${pathKey} must be a valid dot-path`);
        }
      }
    }
    if (resp.fields !== undefined) {
      if (!resp.fields || typeof resp.fields !== 'object' || Array.isArray(resp.fields)) {
        throw new ConfigValidationError(`${ctx}: response.fields must be an object`);
      }
      for (const [fk, fv] of Object.entries(resp.fields)) {
        if (fv !== undefined && fv !== '' && (typeof fv !== 'string' || !VALID_DOT_PATH_RE.test(fv))) {
          throw new ConfigValidationError(`${ctx}: response.fields.${fk} must be a valid dot-path`);
        }
      }
    }
  }
}

/**
 * Validates search_providers and search_selection fields. Throws ConfigValidationError (400).
 */
export function validateSearchConfig(config) {
  if (!config || typeof config !== 'object') return;
  const spMap = config.search_providers;
  if (spMap !== undefined) {
    if (!spMap || typeof spMap !== 'object' || Array.isArray(spMap)) {
      throw new ConfigValidationError('search_providers must be an object map');
    }
    for (const [keyId, sp] of Object.entries(spMap)) {
      if (!sp || typeof sp !== 'object' || Array.isArray(sp)) {
        throw new ConfigValidationError(`search_providers.${keyId}: entry must be an object`);
      }
      const pId = sp.id || keyId;
      if (!VALID_ID_RE.test(String(pId)) || (sp.id && sp.id !== keyId)) {
        throw new ConfigValidationError(`search_providers.${keyId}: id must match [a-z0-9-]+ and equal its key`);
      }
      if (!sp.name || typeof sp.name !== 'string' || !sp.name.trim()) {
        throw new ConfigValidationError(`search_providers.${keyId}: name is required`);
      }
      const origin = sp.origin || 'vault';
      if (!VALID_ORIGINS.has(origin)) {
        throw new ConfigValidationError(`search_providers.${keyId}: origin must be 'vault' or 'local'`);
      }
      if (!Array.isArray(sp.capabilities) || sp.capabilities.length === 0) {
        throw new ConfigValidationError(`search_providers.${keyId}: capabilities must have at least one item ('search' or 'fetch')`);
      }
      for (const cap of sp.capabilities) {
        if (!VALID_SEARCH_CAPABILITIES.has(cap)) {
          throw new ConfigValidationError(`search_providers.${keyId}: unsupported capability '${cap}'`);
        }
      }
      validateHttpBaseUrl(sp.base_url, `search_providers.${keyId}`);
      if (sp.timeout_ms !== undefined && (!Number.isFinite(Number(sp.timeout_ms)) || Number(sp.timeout_ms) <= 0)) {
        throw new ConfigValidationError(`search_providers.${keyId}: timeout_ms must be a positive number`);
      }

      const hasAdapter = typeof sp.adapter === 'string' && sp.adapter.trim().length > 0;
      if (hasAdapter && !VALID_ID_RE.test(sp.adapter.trim())) {
        throw new ConfigValidationError(`search_providers.${keyId}: adapter must match [a-z0-9-]+`);
      }
      const hasSearchSpec = Boolean(sp.request);
      const hasFetchSpec = Boolean(sp.fetch);
      if (!hasAdapter && !hasSearchSpec && !hasFetchSpec) {
        throw new ConfigValidationError(`search_providers.${keyId}: either adapter or declarative request/fetch spec is required`);
      }
      if (hasSearchSpec) {
        if (!hasAdapter && !sp.response) {
          throw new ConfigValidationError(`search_providers.${keyId}: response mapping is required when using declarative request without adapter`);
        }
        validateDeclarativeSpec(sp.request, sp.response, `search_providers.${keyId}.request`);
      }
      if (hasFetchSpec) {
        validateDeclarativeSpec(sp.fetch, sp.fetch.response, `search_providers.${keyId}.fetch`);
      }

      if (!Array.isArray(sp.api_keys)) {
        throw new ConfigValidationError(`search_providers.${keyId}: api_keys must be an array`);
      }
      for (const k of sp.api_keys) {
        if (!k || typeof k !== 'object') {
          throw new ConfigValidationError(`search_providers.${keyId}: invalid api_keys entry`);
        }
        if (k.enabled !== false && (!k.key || !String(k.key).trim())) {
          throw new ConfigValidationError(`search_providers.${keyId}: enabled api_key cannot be empty`);
        }
        if (k.origin !== undefined && !VALID_ORIGINS.has(k.origin)) {
          throw new ConfigValidationError(`search_providers.${keyId}: key origin must be 'vault' or 'local'`);
        }
      }
    }
  }

  const sel = config.search_selection;
  if (sel !== undefined) {
    if (!sel || typeof sel !== 'object' || Array.isArray(sel)) {
      throw new ConfigValidationError('search_selection must be an object');
    }
    const providers = spMap || {};
    if (sel.search !== undefined) {
      if (!Array.isArray(sel.search)) {
        throw new ConfigValidationError('search_selection.search must be an array');
      }
      for (const id of sel.search) {
        if (!providers[id]) {
          throw new ConfigValidationError(`search_selection.search references unknown provider '${id}'`);
        }
        if (!(providers[id].capabilities || []).includes('search')) {
          throw new ConfigValidationError(`search_selection.search provider '${id}' does not support 'search' capability`);
        }
      }
    }
    if (sel.fetch !== undefined && sel.fetch !== null && sel.fetch !== '') {
      if (typeof sel.fetch !== 'string' || !providers[sel.fetch]) {
        throw new ConfigValidationError(`search_selection.fetch references unknown provider '${sel.fetch}'`);
      }
      if (!(providers[sel.fetch].capabilities || []).includes('fetch')) {
        throw new ConfigValidationError(`search_selection.fetch provider '${sel.fetch}' does not support 'fetch' capability`);
      }
    }
  }
}

/**
 * Load config from KV or return default.
 */
export async function loadConfig(kv) {
  let raw = null;
  if (kv) {
    if (typeof kv.get === 'function') {
      raw = await kv.get(CONFIG_KV_KEY);
    } else if (typeof kv.getItem === 'function') {
      raw = await kv.getItem(CONFIG_KV_KEY);
    }
  }

  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed._version === 'number') {
        if (!parsed.search_providers || typeof parsed.search_providers !== 'object') {
          parsed.search_providers = {};
        }
        if (!parsed.search_selection || typeof parsed.search_selection !== 'object') {
          parsed.search_selection = { search: [], fetch: '' };
        }
        return parsed;
      }
    } catch (_) {}
  }

  // Default empty configuration
  return {
    _version: 1,
    providers: {},
    agent_models: {},
    search_providers: {},
    search_selection: { search: [], fetch: '' },
    settings: {
      run_mode: 'agent',
      agent_routing_strategy: 'sticky_failover',
      agent_first_byte_timeout_sec: 120,
      cooldown_rate_limit_sec: 15,
      cooldown_server_error_sec: 30,
      cooldown_network_error_sec: 15,
      cooldown_auth_error_sec: 86400,
      ocr_max_inflight: 4,
      kb_global_max_concurrency: 16,
      mode_schedule_enabled: false,
      mode_schedule_agent_window: '08:30-22:30',
      mode_schedule_timezone: 'Asia/Shanghai',
    },
  };
}

/**
 * Save config to KV with CAS check and Kernel Guard.
 */
export async function saveConfigWithCAS(incomingConfig, kv) {
  const stored = await loadConfig(kv);

  const incomingVer = incomingConfig._version !== undefined ? Number(incomingConfig._version) : null;
  const currentVer = Number(stored._version || 1);

  if (incomingVer === null || incomingVer !== currentVer) {
    throw new CASConflictError(currentVer, incomingVer);
  }

  // Apply Kernel Guard to restore masked secrets
  const sanitized = applyKernelGuard(incomingConfig, stored);

  // Preserve search configuration if client did not submit it (backward compatibility)
  if (sanitized.search_providers === undefined && stored.search_providers !== undefined) {
    sanitized.search_providers = stored.search_providers;
  }
  if (sanitized.search_selection === undefined && stored.search_selection !== undefined) {
    sanitized.search_selection = stored.search_selection;
  }

  // Validate search providers & selection before persisting
  validateSearchConfig(sanitized);

  // Bump version
  sanitized._version = currentVer + 1;

  const serialized = JSON.stringify(sanitized);
  if (kv) {
    if (typeof kv.put === 'function') {
      await kv.put(CONFIG_KV_KEY, serialized);
    } else if (typeof kv.setItem === 'function') {
      await kv.setItem(CONFIG_KV_KEY, serialized);
    }
  }

  return sanitized;
}

/**
 * Candidate KV binding names supported across EdgeOne Pages / Functions / Makers.
 */
export const KV_BINDING_CANDIDATES = [
  'agent_kv',
  'KV',
  'EDGE_KV',
  'ocrproxy_kv',
  'my_kv',
  'kv',
  'KV_NAMESPACE',
  '__MOCK_KV__',
];

function looksLikeKv(obj) {
  return Boolean(obj && typeof obj === 'object' && typeof obj.get === 'function');
}

function isKvDuck(obj) {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    typeof obj.get === 'function' &&
    typeof obj.put === 'function'
  );
}

/**
 * Resolves KV binding from EdgeOne context, env, globals, or explicit argument.
 * Fully compatible with Tencent Cloud EdgeOne Pages, Makers, and Edge Functions.
 */
export function resolveKvBinding(contextOrEnv, explicitKv) {
  // 1. Explicit KV instance
  if (explicitKv && typeof explicitKv.get === 'function') {
    return explicitKv;
  }

  // 1b. If contextOrEnv itself is already a KV store
  if (isKvDuck(contextOrEnv)) {
    return contextOrEnv;
  }

  // 2. Candidate names across candidate scopes
  const scopes = [];
  if (contextOrEnv && typeof contextOrEnv === 'object') {
    scopes.push(contextOrEnv);
    if (contextOrEnv.env && typeof contextOrEnv.env === 'object') scopes.push(contextOrEnv.env);
    if (contextOrEnv.bindings && typeof contextOrEnv.bindings === 'object') scopes.push(contextOrEnv.bindings);
  }
  if (typeof globalThis !== 'undefined') {
    scopes.push(globalThis);
  }

  for (const scope of scopes) {
    for (const name of KV_BINDING_CANDIDATES) {
      const candidate = scope?.[name];
      if (looksLikeKv(candidate)) {
        return candidate;
      }
    }
  }

  // 3. V8 top-level global variables
  try { if (typeof agent_kv !== 'undefined' && looksLikeKv(agent_kv)) return agent_kv; } catch (_) {}
  try { if (typeof my_kv !== 'undefined' && looksLikeKv(my_kv)) return my_kv; } catch (_) {}
  try { if (typeof KV !== 'undefined' && looksLikeKv(KV)) return KV; } catch (_) {}
  try { if (typeof EDGE_KV !== 'undefined' && looksLikeKv(EDGE_KV)) return EDGE_KV; } catch (_) {}
  try { if (typeof ocrproxy_kv !== 'undefined' && looksLikeKv(ocrproxy_kv)) return ocrproxy_kv; } catch (_) {}
  try { if (typeof kv !== 'undefined' && looksLikeKv(kv)) return kv; } catch (_) {}
  try { if (typeof KV_NAMESPACE !== 'undefined' && looksLikeKv(KV_NAMESPACE)) return KV_NAMESPACE; } catch (_) {}
  try { if (typeof __MOCK_KV__ !== 'undefined' && looksLikeKv(__MOCK_KV__)) return __MOCK_KV__; } catch (_) {}

  // 4. Duck-typing scan across scopes (both 1 level and 2 levels)
  for (const scope of scopes) {
    if (!scope || typeof scope !== 'object') continue;
    for (const key of Object.keys(scope)) {
      const sub = scope[key];
      if (isKvDuck(sub)) {
        return sub;
      }
      if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
        for (const innerKey of Object.keys(sub)) {
          const innerSub = sub[innerKey];
          if (isKvDuck(innerSub)) {
            return innerSub;
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Resolves environment variables from context, env, globalThis, or process.env.
 * Priority: contextOrEnv.env -> contextOrEnv -> globalThis -> process.env
 */
export function resolveEnv(contextOrEnv) {
  const merged = {};
  if (typeof process !== 'undefined' && process?.env) {
    Object.assign(merged, process.env);
  }
  if (typeof globalThis !== 'undefined') {
    for (const key of ['ADMIN_PASSWORD', 'NODE_ENV', 'HUB_URL', 'HUB_ENCRYPT_KEY']) {
      if (typeof globalThis[key] === 'string') {
        merged[key] = globalThis[key];
      }
    }
  }
  try {
    if (typeof ADMIN_PASSWORD !== 'undefined' && typeof ADMIN_PASSWORD === 'string') {
      merged.ADMIN_PASSWORD = ADMIN_PASSWORD;
    }
  } catch (_) {}

  if (contextOrEnv && typeof contextOrEnv === 'object') {
    for (const [k, v] of Object.entries(contextOrEnv)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        merged[k] = v;
      }
    }
    if (contextOrEnv.env && typeof contextOrEnv.env === 'object') {
      for (const [k, v] of Object.entries(contextOrEnv.env)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          merged[k] = v;
        }
      }
    }
  }

  return new Proxy(merged, {
    get(target, prop) {
      if (typeof prop !== 'string') return target[prop];
      if (contextOrEnv && typeof contextOrEnv === 'object') {
        if (contextOrEnv.env && contextOrEnv.env[prop] !== undefined) {
          return contextOrEnv.env[prop];
        }
        if (contextOrEnv[prop] !== undefined) {
          return contextOrEnv[prop];
        }
      }
      if (typeof globalThis !== 'undefined' && globalThis[prop] !== undefined) {
        return globalThis[prop];
      }
      if (prop === 'ADMIN_PASSWORD') {
        try {
          if (typeof ADMIN_PASSWORD !== 'undefined') return ADMIN_PASSWORD;
        } catch (_) {}
      }
      if (typeof process !== 'undefined' && process?.env && process.env[prop] !== undefined) {
        return process.env[prop];
      }
      return target[prop];
    },
  });
}

/**
 * Check admin password authentication.
 */
export function checkAdminAuth(request, envOrContext) {
  const env = resolveEnv(envOrContext);
  const adminPassword = (env && env.ADMIN_PASSWORD) || 'admin';
  const authHeader = request.headers.get('authorization') || '';
  const expectedBearer = `Bearer ${adminPassword}`;
  
  // Also support custom header or cookie if present
  if (constantTimeCompare(authHeader, expectedBearer)) {
    return null;
  }
  
  const customHeader = request.headers.get('x-admin-key') || '';
  if (constantTimeCompare(customHeader, adminPassword)) {
    return null;
  }

  return new Response(
    JSON.stringify({ ok: false, error: 'Unauthorized: Invalid admin credentials' }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
}
