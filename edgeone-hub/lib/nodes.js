import {
  generateNodeToken,
  hashToken,
  constantTimeCompare,
  encryptNodeToken,
  decryptNodeToken,
  resolveNodeEncryptSecret,
} from './crypto.js';
import { ConfigValidationError } from './config.js';

export const NODES_KV_KEY = 'relay_nodes';
const STATUS_CACHE_TTL_MS = 15_000;

function sanitizeNode(n) {
  const copy = { ...n };
  delete copy.token_sha256;
  delete copy.node_token_enc;
  copy.has_status_url = Boolean(n.status_url);
  const scope = n.scope && typeof n.scope === 'object' ? n.scope : {};
  copy.scope = {
    models: Array.isArray(scope.models) ? scope.models : ['*'],
    providers: Array.isArray(scope.providers) ? scope.providers : ['*'],
    search_providers: Array.isArray(scope.search_providers) ? scope.search_providers : ['*'],
  };
  return copy;
}

function sanitizeStatusUrl(raw) {
  if (raw === undefined || raw === null) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    throw new ConfigValidationError('status_url must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigValidationError('status_url must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new ConfigValidationError('status_url must not contain credentials');
  }
  return trimmed.replace(/\/+$/, '');
}

function buildBootstrapEnv(node, rawToken, hubUrl) {
  const providers = Array.isArray(node.scope?.providers) ? node.scope.providers : ['*'];
  const searchProviders = Array.isArray(node.scope?.search_providers) ? node.scope.search_providers : ['*'];
  if (providers.length === 0 && searchProviders.length > 0) {
    return `HUB_URL=${hubUrl} NODE_TOKEN=${rawToken}`;
  }
  return `LLMPROXY_ROLE=${node.role} LLMPROXY_HUB_URL=${hubUrl} LLMPROXY_NODE_TOKEN=${rawToken}`;
}

export async function loadNodes(kv) {
  let raw = null;
  if (kv) {
    if (typeof kv.get === 'function') {
      raw = await kv.get(NODES_KV_KEY);
    } else if (typeof kv.getItem === 'function') {
      raw = await kv.getItem(NODES_KV_KEY);
    }
  }

  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'object') return Object.values(parsed);
    } catch (_) {}
  }

  return [];
}

export async function saveNodes(nodes, kv) {
  const serialized = JSON.stringify(nodes);
  if (kv) {
    if (typeof kv.put === 'function') {
      await kv.put(NODES_KV_KEY, serialized);
    } else if (typeof kv.setItem === 'function') {
      await kv.setItem(NODES_KV_KEY, serialized);
    }
  }
}

/**
 * List all nodes, with sensitive sha256 hidden.
 */
export async function listNodes(kv) {
  const nodes = await loadNodes(kv);
  return nodes.map(sanitizeNode);
}

/**
 * Issue a new node token and save node.
 */
export async function issueNode(params, kv, hubUrl = 'https://hub.example.com', env = {}) {
  const nodes = await loadNodes(kv);

  const rawToken = generateNodeToken();
  const tokenSha = hashToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 17) + '...';
  const encSecret = resolveNodeEncryptSecret(env);
  const tokenEnc = await encryptNodeToken(rawToken, encSecret);
  const statusUrl = sanitizeStatusUrl(params.status_url);

  const nodeId = `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();

  const node = {
    id: nodeId,
    name: params.name || 'Unnamed Node',
    role: params.role === 'full' ? 'full' : 'lite',
    enabled: true,
    token_prefix: tokenPrefix,
    token_sha256: tokenSha,
    node_token_enc: tokenEnc,
    status_url: statusUrl,
    lease_ttl: Number(params.lease_ttl) || 86400,
    grace_ttl: Number(params.grace_ttl) || 3600,
    scope: {
      models: Array.isArray(params.scope?.models) ? params.scope.models : ['*'],
      providers: Array.isArray(params.scope?.providers) ? params.scope.providers : ['*'],
      search_providers: Array.isArray(params.scope?.search_providers)
        ? params.scope.search_providers
        : ['*'],
    },
    created_at: nowIso,
    last_seen: null,
    last_ip: null,
    last_config_version: 0,
    last_binary_version: 'v2.1.3',
    sync_count: 0,
    hit_304_count: 0,
  };

  nodes.push(node);
  await saveNodes(nodes, kv);

  const bootstrapEnv = buildBootstrapEnv(node, rawToken, hubUrl);

  return {
    node: sanitizeNode(node),
    node_token: rawToken,
    bootstrap_env: bootstrapEnv,
  };
}

/**
 * Update an existing node.
 */
export async function patchNode(nodeId, patch, kv) {
  const nodes = await loadNodes(kv);
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) return null;

  const node = nodes[idx];
  if (patch.name !== undefined) node.name = String(patch.name);
  if (patch.enabled !== undefined) {
    node.enabled = Boolean(patch.enabled);
    if (!node.enabled) {
      delete node.cached_status;
    }
  }
  if (patch.lease_ttl !== undefined) node.lease_ttl = Number(patch.lease_ttl);
  if (patch.grace_ttl !== undefined) node.grace_ttl = Number(patch.grace_ttl);
  if (patch.status_url !== undefined) {
    node.status_url = sanitizeStatusUrl(patch.status_url);
  }
  if (patch.scope !== undefined && typeof patch.scope === 'object') {
    const existingScope = node.scope && typeof node.scope === 'object' ? node.scope : {};
    node.scope = {
      models: Array.isArray(patch.scope.models) ? patch.scope.models : (existingScope.models || ['*']),
      providers: Array.isArray(patch.scope.providers) ? patch.scope.providers : (existingScope.providers || ['*']),
      search_providers: Array.isArray(patch.scope.search_providers)
        ? patch.scope.search_providers
        : (existingScope.search_providers || ['*']),
    };
  }

  nodes[idx] = node;
  await saveNodes(nodes, kv);

  return sanitizeNode(node);
}

/**
 * Rotate token for an existing node.
 */
export async function rotateNodeToken(nodeId, kv, hubUrl = 'https://hub.example.com', env = {}) {
  const nodes = await loadNodes(kv);
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) return null;

  const node = nodes[idx];
  const rawToken = generateNodeToken();
  const tokenSha = hashToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 17) + '...';
  const tokenEnc = await encryptNodeToken(rawToken, resolveNodeEncryptSecret(env));

  node.token_sha256 = tokenSha;
  node.token_prefix = tokenPrefix;
  node.node_token_enc = tokenEnc;
  delete node.cached_status;
  nodes[idx] = node;
  await saveNodes(nodes, kv);

  const bootstrapEnv = buildBootstrapEnv(node, rawToken, hubUrl);

  return {
    node_token: rawToken,
    bootstrap_env: bootstrapEnv,
  };
}

/**
 * Delete a node permanently.
 */
export async function deleteNode(nodeId, kv) {
  const nodes = await loadNodes(kv);
  const filtered = nodes.filter((n) => n.id !== nodeId);
  if (filtered.length === nodes.length) return false;
  await saveNodes(filtered, kv);
  return true;
}

/**
 * Find active node by bearer token.
 */
export async function findNodeByToken(rawToken, kv) {
  if (!rawToken) return null;
  const hash = hashToken(rawToken);
  const nodes = await loadNodes(kv);
  for (const n of nodes) {
    if (constantTimeCompare(n.token_sha256, hash)) {
      return n;
    }
  }
  return null;
}

/**
 * Update node last_seen and sync telemetry (throttled on repeated 304s to avoid excessive KV writes).
 */
export async function touchNodeLastSeen(nodeId, kv, configVer = 0, meta = {}) {
  const nodes = await loadNodes(kv);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const now = Date.now();
  const lastTime = node.last_seen ? new Date(node.last_seen).getTime() : 0;

  node.sync_count = (Number(node.sync_count) || 0) + 1;
  if (meta && meta.is304) {
    node.hit_304_count = (Number(node.hit_304_count) || 0) + 1;
  }
  if (meta && meta.ip) {
    node.last_ip = String(meta.ip);
  }
  if (meta && meta.telemetry && typeof meta.telemetry === 'object') {
    node.telemetry = {
      requests: Number(meta.telemetry.requests) || 0,
      success: Number(meta.telemetry.success) || 0,
      tokens: Number(meta.telemetry.tokens) || 0,
      updated_at: new Date(now).toISOString(),
    };
  }

  // Throttle repeated 304 writes to once every 60s unless first sync or full 200 pull
  if (lastTime > 0 && meta?.is304 && now - lastTime < 60_000) return;

  node.last_seen = new Date(now).toISOString();
  if (configVer) node.last_config_version = configVer;
  await saveNodes(nodes, kv);
}

/**
 * On-demand server-side status pull from a downstream node's /node/status endpoint.
 * Uses encrypted node_token_enc and caches recent successful responses (15s TTL).
 */
export async function fetchNodeStatus(nodeId, kv, env = {}, options = {}) {
  const nodes = await loadNodes(kv);
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) return null;

  const node = nodes[idx];
  if (node.enabled === false) {
    return {
      ok: false,
      state: 'offline',
      stale: false,
      http_status: 401,
      error: 'node_revoked_or_invalid',
      last_seen: node.last_status_ok_at || node.last_seen || null,
    };
  }
  if (!node.status_url) {
    return {
      ok: false,
      state: 'offline',
      stale: false,
      error: 'status_url_not_configured',
      last_seen: node.last_status_ok_at || node.last_seen || null,
    };
  }

  const nowMs = Date.now();
  const cached = node.cached_status;
  if (!options.refresh && cached && cached.fetched_at_ms && nowMs - cached.fetched_at_ms < STATUS_CACHE_TTL_MS) {
    return {
      ok: true,
      state: 'online',
      stale: false,
      cached: true,
      fetched_at: cached.fetched_at,
      status: cached.status,
      last_seen: node.last_status_ok_at || node.last_seen || null,
    };
  }

  let rawToken = '';
  try {
    rawToken = await decryptNodeToken(node.node_token_enc, resolveNodeEncryptSecret(env));
  } catch (_) {
    rawToken = '';
  }
  if (!rawToken) {
    return {
      ok: false,
      state: cached ? 'stale' : 'offline',
      stale: Boolean(cached),
      error: 'node_token_unavailable_rotate_required',
      last_seen: node.last_status_ok_at || node.last_seen || null,
      cached_status: cached ? cached.status : null,
    };
  }

  const doFetch = options.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return {
      ok: false,
      state: cached ? 'stale' : 'offline',
      stale: Boolean(cached),
      error: 'fetch_unavailable',
      last_seen: node.last_status_ok_at || node.last_seen || null,
      cached_status: cached ? cached.status : null,
    };
  }

  const cleanBase = node.status_url.replace(/\/+$/, '');
  const targetUrl = cleanBase.endsWith('/node/status') ? cleanBase : `${cleanBase}/node/status`;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 4500) : null;
    let resp;
    try {
      resp = await doFetch(targetUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${rawToken}`,
          Accept: 'application/json',
        },
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!resp.ok) {
      const errCode = resp.status === 401 ? 'node_revoked_or_invalid' : `upstream_http_${resp.status}`;
      return {
        ok: false,
        state: cached ? 'stale' : 'offline',
        stale: Boolean(cached),
        http_status: resp.status,
        error: errCode,
        last_seen: node.last_status_ok_at || node.last_seen || null,
        cached_status: cached ? cached.status : null,
      };
    }

    const data = await resp.json();
    const fetchedAt = new Date(nowMs).toISOString();
    node.last_status_ok_at = fetchedAt;
    node.cached_status = {
      fetched_at: fetchedAt,
      fetched_at_ms: nowMs,
      status: data,
    };
    nodes[idx] = node;
    await saveNodes(nodes, kv);

    return {
      ok: true,
      state: 'online',
      stale: false,
      cached: false,
      fetched_at: fetchedAt,
      status: data,
      last_seen: fetchedAt,
    };
  } catch (err) {
    const safeMsg = String(err?.message || 'unreachable').replace(rawToken, '***');
    return {
      ok: false,
      state: cached ? 'stale' : 'offline',
      stale: Boolean(cached),
      error: safeMsg || 'unreachable',
      last_seen: node.last_status_ok_at || node.last_seen || null,
      cached_status: cached ? cached.status : null,
    };
  }
}
