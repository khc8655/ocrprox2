import { constantTimeCompare, hashToken } from './crypto.js';
import { matchPresetForProvider } from './presetbind.js';
import { getPresetMap } from './presets.js';

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
  return incomingConfig;
}

/**
 * Drop settings fields that were removed from the config contract. A KV written by
 * an older Hub can still carry them; handing them back verbatim keeps them alive
 * through every console save (the console POSTs back what GET returned) and through
 * every node projection. Go ignores the fields, so this is hygiene, not auth.
 */
export function sanitizeStoredConfig(config) {
  if (!config || typeof config !== 'object') return config;
  if (config.settings && typeof config.settings === 'object') {
    const settings = { ...config.settings };
    delete settings.proxy_keys;
    config.settings = settings;
  }
  // model_catalog_meta is a read-only projection of the catalog KV entry, served on
  // GET /api/config. The console POSTs back what it got, so drop it here: a stored
  // copy would go stale the moment the catalog is updated and nobody would notice.
  delete config.model_catalog_meta;
  return config;
}

/**
 * Fills in preset_id for providers that carry none, using rule A of the
 * cross-runtime preset-binding contract (lib/presetbind.js). Mutates and
 * returns the given config.
 *
 * Why on read: existing KV entries were written before preset binding existed.
 * The operator should not have to open every provider to get them bound —
 * the next read binds them, and the next save writes the result back to KV.
 *
 * Only providers WITHOUT a preset_id are touched, exactly as the contract
 * specifies: "custom" (explicitly unbound), a preset_id that exists in the
 * library, and even a stale preset_id the library no longer knows are all left
 * alone. origin=local providers are included: the binding is provider metadata,
 * not an export decision (the projection still excludes local providers).
 */
export function applyPresetBindings(config, presetsMap = getPresetMap()) {
  if (!config || typeof config !== 'object') return config;
  const providers = config.providers;
  if (!providers || typeof providers !== 'object') return config;
  for (const [pId, pData] of Object.entries(providers)) {
    if (!pData || typeof pData !== 'object') continue;
    if (typeof pData.preset_id === 'string' && pData.preset_id.trim()) continue;
    const matched = matchPresetForProvider(
      { id: pData.id || pId, name: pData.name || '', base_url: pData.base_url || '' },
      presetsMap
    );
    if (matched) pData.preset_id = matched;
  }
  return config;
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
        return applyPresetBindings(sanitizeStoredConfig(parsed));
      }
    } catch (_) {}
  }

  // Default empty configuration
  return {
    _version: 1,
    providers: {},
    agent_models: {},
    settings: {
      client_key: '',
      agent_routing_strategy: 'sticky_failover',
      agent_first_byte_timeout_sec: 120,
      cooldown_rate_limit_sec: 15,
      cooldown_server_error_sec: 30,
      cooldown_network_error_sec: 15,
      cooldown_auth_error_sec: 86400,
      ocr_max_inflight: 4,
      kb_global_max_concurrency: 16,
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

  // Refuse to publish a template that would silently break every node: an empty
  // provider set (or one with no enabled keys) leaves nodes with nothing to route.
  const incomingProviders = incomingConfig.providers || {};
  const storedProviders = stored.providers || {};
  if (Object.keys(storedProviders).length > 0) {
    const usable = Object.values(incomingProviders).filter(
      (p) => p && p.enabled !== false && Array.isArray(p.api_keys) && p.api_keys.some((k) => k && k.enabled !== false)
    );
    if (usable.length === 0) {
      throw new ConfigValidationError(
        'refusing to save an empty template: at least one enabled provider with an enabled key is required'
      );
    }
  }

  // Apply Kernel Guard to restore masked secrets, then drop removed settings
  // fields so a POST echoing a legacy GET cannot write them back to KV.
  // Then fill preset bindings for providers that still carry none: the console
  // POSTs back whatever GET handed it, and a config written by an older Hub has
  // no preset_id there, so the save is the moment the binding lands in KV.
  const sanitized = applyPresetBindings(sanitizeStoredConfig(applyKernelGuard(incomingConfig, stored)));

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
    for (const key of ['ADMIN_PASSWORD', 'NODE_ENV', 'HUB_URL']) {
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
  const adminPassword = env && typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD.trim() : '';
  if (!adminPassword) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Hub ADMIN_PASSWORD is not configured' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  }

  const authHeader = request.headers.get('authorization') || '';
  const expectedBearer = `Bearer ${adminPassword}`;

  if (authHeader && constantTimeCompare(hashToken(authHeader), hashToken(expectedBearer))) {
    return null;
  }

  const customHeader = request.headers.get('x-admin-key') || '';
  if (customHeader && constantTimeCompare(hashToken(customHeader), hashToken(adminPassword))) {
    return null;
  }

  return new Response(
    JSON.stringify({ ok: false, error: 'Unauthorized: Invalid admin credentials' }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
}

/**
 * Shared unmasked key lookup for both LLM providers and search_providers.
 */
export function findUnmaskedKey(prov, keyLabel) {
  if (!prov) return null;
  if (prov.keys && typeof prov.keys === 'object' && !Array.isArray(prov.keys)) {
    if (keyLabel && typeof prov.keys[keyLabel] === 'string' && !isMaskedSecret(prov.keys[keyLabel])) {
      return prov.keys[keyLabel];
    }
    for (const v of Object.values(prov.keys)) {
      if (typeof v === 'string' && v && !isMaskedSecret(v)) return v;
      if (v && typeof v === 'object' && v.key && !isMaskedSecret(v.key)) return v.key;
    }
  }
  if (Array.isArray(prov.keys)) {
    if (keyLabel) {
      const match = prov.keys.find(k => k && typeof k === 'object' && (k.label === keyLabel || k.id === keyLabel));
      if (match?.key && !isMaskedSecret(match.key)) return match.key;
    }
    for (const item of prov.keys) {
      if (typeof item === 'string' && item && !isMaskedSecret(item)) return item;
      if (item && typeof item === 'object' && item.key && !isMaskedSecret(item.key)) return item.key;
    }
  }
  if (Array.isArray(prov.api_keys)) {
    if (keyLabel) {
      const match = prov.api_keys.find(k => k && (k.label === keyLabel || k.id === keyLabel));
      if (match?.key && !isMaskedSecret(match.key)) return match.key;
    }
    for (const item of prov.api_keys) {
      if (item?.key && !isMaskedSecret(item.key)) return item.key;
    }
  }
  return null;
}

/**
 * Persists key verification health metadata into KV config (providers or search_providers).
 */
export async function persistProviderKeyHealth(env, mapName, providerId, keyLabel, result) {
  if (!providerId) return null;
  const kv = resolveKvBinding(env);
  if (!kv) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const config = await loadConfig(kv);
      const prov = config?.[mapName]?.[providerId];
      if (!prov || !Array.isArray(prov.api_keys)) return null;
      const match = keyLabel
        ? prov.api_keys.find(k => k && (k.label === keyLabel || k.id === keyLabel))
        : prov.api_keys[0];
      if (!match) return null;
      match.last_ok = Boolean(result.valid);
      match.last_status = Number(result.status) || 0;
      match.last_latency_ms = Number(result.latency_ms) || 0;
      if (result.models_count !== undefined) {
        match.last_models_count = Number(result.models_count) || 0;
      }
      match.last_checked_at = new Date().toISOString();
      // The console's per-key test verdict (same shape as the Full node's
      // KeyEntry.last_test) so the key-row pill survives a refresh without an
      // explicit provider save.
      if (result.last_test && typeof result.last_test === 'object') {
        match.last_test = result.last_test;
      }
      const saved = await saveConfigWithCAS(config, kv);
      return typeof saved?._version === 'number' ? saved._version : null;
    } catch (err) {
      if (attempt === 0 && (err instanceof CASConflictError || err?.status === 409)) {
        continue;
      }
      return null;
    }
  }
  return null;
}
