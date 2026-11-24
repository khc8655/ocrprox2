import {
  generateNodeToken,
  generateAdminPassword,
  hashToken,
  constantTimeCompare,
} from './crypto.js';

export const NODES_KV_KEY = 'relay_nodes';

export function generateClientKey() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `sk-llmproxy-${hex}`;
}

function sanitizeNode(n) {
  const copy = { ...n };
  delete copy.token_sha256;
  // The plaintext token is reachable only through GET /:id/credentials (the
  // explicit operator "show me the token" action, no-store). The nodes list is
  // polled every 15s and rendered as a table, so it never carries token material
  // it cannot display.
  delete copy.node_token_plaintext;
  delete copy.node_token_enc;
  delete copy.status_url;
  delete copy.has_status_url;
  delete copy.cached_status;
  delete copy.mcp_url;
  delete copy.telemetry;
  delete copy.kind;
  delete copy.service_type;
  // last_ip / last_seen / sync counters stay: the node list table shows
  // name / IP / status, and install success is observed as last_seen turning
  // recent (online).
  const scope = n.scope && typeof n.scope === 'object' ? n.scope : {};
  copy.scope = {
    models: Array.isArray(scope.models) ? scope.models : ['*'],
    providers: Array.isArray(scope.providers) ? scope.providers : ['*'],
  };
  return copy;
}

export function sanitizeShellToken(val) {
  if (!val || typeof val !== 'string') return '';
  return val.trim().replace(/["'$`\\\s;|&<>(){}!]/g, '');
}

function buildBootstrapEnv(node, rawToken, hubUrl, clientKey = '') {
  const role = node.role === 'full' ? 'full' : 'lite';
  const cleanHub = sanitizeShellToken(hubUrl || 'https://hub.example.com').replace(/\/+$/, '');
  const parts = [
    `LLMPROXY_ROLE=${role}`,
    `LLMPROXY_HUB_URL=${cleanHub}`,
    `LLMPROXY_NODE_TOKEN=${rawToken}`,
  ];
  const cleanKey = sanitizeShellToken(clientKey);
  if (cleanKey) {
    parts.push(`LLMPROXY_CLIENT_KEY=${cleanKey}`);
  }
  return parts.join(' ');
}

function buildInstallCommand(node, rawToken, hubUrl, clientKey = '', adminPassword = '') {
  const cleanHub = sanitizeShellToken(hubUrl || 'https://hub.example.com').replace(/\/+$/, '');
  const role = node.role === 'full' ? 'full' : 'lite';
  const args = [
    `--role=${role}`,
    `--hub-url="${cleanHub}"`,
    `--node-token="${rawToken}"`,
  ];
  const cleanKey = sanitizeShellToken(clientKey);
  if (cleanKey) {
    args.push(`--client-key="${cleanKey}"`);
  }
  // A Full node needs an admin console password. Generate it here so the command is
  // self-contained; the installer then echoes it back instead of masking it.
  const cleanAdmin = sanitizeShellToken(adminPassword);
  if (role === 'full' && cleanAdmin) {
    args.push(`--admin-password="${cleanAdmin}"`);
  }
  args.push('-p 8787', '-y');
  return `curl -fsSL ${cleanHub}/install.sh | sudo bash -s -- ${args.join(' ')}`;
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
export async function issueNode(params, kv, hubUrl = 'https://hub.example.com', clientKey = '') {
  const nodes = await loadNodes(kv);

  const rawToken = generateNodeToken();
  const tokenSha = hashToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 17) + '...';

  const nodeId = `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();

  const node = {
    id: nodeId,
    name: params.name || 'Unnamed Node',
    role: params.role === 'full' ? 'full' : 'lite',
    enabled: true,
    token_prefix: tokenPrefix,
    token_sha256: tokenSha,
    // Plaintext token kept in KV by explicit operator choice (same tradeoff as
    // admin_password): the Hub console can re-show the node's credential at any
    // time via GET /:id/credentials instead of forcing a rotation just to read
    // it. token_sha256 stays the only value used for authentication.
    node_token_plaintext: rawToken,
    lease_ttl: Number(params.lease_ttl) || 86400,
    grace_ttl: Number(params.grace_ttl) || 3600,
    scope: {
      models: Array.isArray(params.scope?.models) ? params.scope.models : ['*'],
      providers: Array.isArray(params.scope?.providers) ? params.scope.providers : ['*'],
    },
    created_at: nowIso,
    last_seen: null,
    last_ip: null,
    last_config_version: 0,
    last_binary_version: 'v2.1.3',
    sync_count: 0,
    hit_304_count: 0,
  };

  // Full-node admin console password. Stored in KV plaintext by explicit
  // operator choice so the console password stays re-viewable in the admin UI
  // instead of being a one-time secret that only the install command ever saw.
  // Lite nodes have no admin console — no field at all.
  const adminPassword = node.role === 'full' ? generateAdminPassword(20) : '';
  if (node.role === 'full') {
    node.admin_password = adminPassword;
  }

  nodes.push(node);
  await saveNodes(nodes, kv);

  const effectiveClientKey = sanitizeShellToken(clientKey) || generateClientKey();
  const bootstrapEnv = buildBootstrapEnv(node, rawToken, hubUrl, effectiveClientKey);
  const installCommand = buildInstallCommand(node, rawToken, hubUrl, effectiveClientKey, adminPassword);

  return {
    node: sanitizeNode(node),
    node_token: rawToken,
    client_key: effectiveClientKey,
    admin_password: adminPassword || undefined,
    bootstrap_env: bootstrapEnv,
    install_command: installCommand,
  };
}

/**
 * Update an existing node (preserving last_seen / last_config_version across revoke/restore).
 */
export async function patchNode(nodeId, patch, kv) {
  const nodes = await loadNodes(kv);
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) return null;

  const node = nodes[idx];
  const prevLastSeen = node.last_seen ?? null;
  const prevConfigVer = node.last_config_version ?? 0;
  if (patch.name !== undefined) node.name = String(patch.name);
  if (patch.role === 'full' || patch.role === 'lite') {
    // A lite node has no admin console: a password left over from an earlier
    // full lifetime must not linger in KV (issueNode never writes one for lite).
    if (patch.role === 'lite' && node.role === 'full') {
      delete node.admin_password;
    }
    // lite -> full: mint a console password right away so the node is immediately
    // viewable via the credentials endpoint — otherwise that endpoint would report
    // admin_password:null with a misleading "legacy node" note for a freshly
    // switched node until the next install-command reissue mints one.
    if (patch.role === 'full' && node.role === 'lite') {
      node.admin_password = generateAdminPassword(20);
    }
    node.role = patch.role;
  }
  if (patch.enabled !== undefined) {
    node.enabled = Boolean(patch.enabled);
  }
  if (patch.lease_ttl !== undefined) node.lease_ttl = Number(patch.lease_ttl);
  if (patch.grace_ttl !== undefined) node.grace_ttl = Number(patch.grace_ttl);
  if (patch.scope !== undefined && typeof patch.scope === 'object') {
    const existingScope = node.scope && typeof node.scope === 'object' ? node.scope : {};
    node.scope = {
      models: Array.isArray(patch.scope.models) ? patch.scope.models : (existingScope.models || ['*']),
      providers: Array.isArray(patch.scope.providers) ? patch.scope.providers : (existingScope.providers || ['*']),
    };
  }
  node.last_seen = prevLastSeen;
  node.last_config_version = prevConfigVer;

  nodes[idx] = node;
  await saveNodes(nodes, kv);

  return sanitizeNode(node);
}

/**
 * Rotate token for an existing node.
 */
export async function rotateNodeToken(nodeId, kv, hubUrl = 'https://hub.example.com', clientKey = '') {
  const res = await reissueNodeToken(nodeId, kv, hubUrl, clientKey);
  // Callers of the classic rotate endpoint do not consume the node payload;
  // keep its historical response shape.
  if (!res) return null;
  // admin_password is additive (absent for lite), so the historical shape is kept
  // while a rotated full node still gets a usable one-click command.
  const { node_token, client_key, admin_password, bootstrap_env, install_command } = res;
  return { node_token, client_key, admin_password, bootstrap_env, install_command };
}

/**
 * Re-issue (rotate) the token of a node and return the full deployment material
 * (install command + bootstrap env). This is the only spec-compliant way to
 * re-obtain a one-click install command after the issuance moment: KV stores
 * only the SHA-256 digest, so the plaintext token must be regenerated. The
 * admin console password is different: it lives in KV plaintext, so rotation
 * reuses the stored value (the operator may already have it saved); only a
 * legacy node issued before passwords were stored gets one minted here, and
 * that mint is persisted so later lookups stay stable.
 */
export async function reissueNodeToken(nodeId, kv, hubUrl = 'https://hub.example.com', clientKey = '') {
  const nodes = await loadNodes(kv);
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) return null;

  const node = nodes[idx];
  const rawToken = generateNodeToken();
  const tokenSha = hashToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 17) + '...';

  node.token_sha256 = tokenSha;
  node.token_prefix = tokenPrefix;
  // Rotation must move the plaintext copy forward too: leaving the old value
  // would make the credentials endpoint show a token that no longer works.
  node.node_token_plaintext = rawToken;
  delete node.node_token_enc;
  delete node.status_url;
  delete node.cached_status;
  let adminPassword = node.role === 'full' ? String(node.admin_password || '') : '';
  if (node.role === 'full' && !adminPassword) {
    // Legacy node issued before passwords were persisted: mint once and write
    // it back so later lookups (credentials endpoint, next rotation) stay stable.
    adminPassword = generateAdminPassword(20);
    node.admin_password = adminPassword;
  }
  nodes[idx] = node;
  await saveNodes(nodes, kv);

  const effectiveClientKey = sanitizeShellToken(clientKey) || generateClientKey();
  const bootstrapEnv = buildBootstrapEnv(node, rawToken, hubUrl, effectiveClientKey);
  const installCommand = buildInstallCommand(node, rawToken, hubUrl, effectiveClientKey, adminPassword);

  return {
    node: sanitizeNode(node),
    node_token: rawToken,
    client_key: effectiveClientKey,
    admin_password: adminPassword || undefined,
    bootstrap_env: bootstrapEnv,
    install_command: installCommand,
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
 * Strip unsafe characters from a node-reported binary version and cap its length.
 * Shared by the config sync path and the lightweight heartbeat path so both
 * apply exactly the same cleaning (nodes.js historical logic, 32-char cap).
 */
function cleanBinaryVersion(val) {
  if (!val) return '';
  return String(val).replace(/[<>"'&\x00-\x1f\x7f]/g, '').trim().slice(0, 32);
}

/**
 * Update node last_seen and sync telemetry (throttled only on idle 304s without usage or version change).
 */
export async function touchNodeLastSeen(nodeId, kv, configVerOrMeta = 0, maybeMeta = {}) {
  const configVer = typeof configVerOrMeta === 'number' ? configVerOrMeta : 0;
  const meta = configVerOrMeta && typeof configVerOrMeta === 'object' ? configVerOrMeta : (maybeMeta || {});

  const nodes = await loadNodes(kv);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const now = Date.now();
  const lastTime = node.last_seen ? new Date(node.last_seen).getTime() : 0;
  const prevBinVer = node.last_binary_version || '';
  const cleanBinVer = meta && meta.binaryVersion
    ? cleanBinaryVersion(meta.binaryVersion)
    : '';
  const hasBinVerChange = Boolean(cleanBinVer && cleanBinVer !== prevBinVer);
  const hasUsage = Boolean(meta && meta.usage && typeof meta.usage === 'object');

  node.sync_count = (Number(node.sync_count) || 0) + 1;
  if (meta && meta.is304) {
    node.hit_304_count = (Number(node.hit_304_count) || 0) + 1;
  }
  if (meta && meta.ip) {
    node.last_ip = String(meta.ip);
  }
  if (cleanBinVer) {
    node.last_binary_version = cleanBinVer;
  }
  // Usage digest reported by the node on each sync (models + per-model stats).
  if (hasUsage) {
    const models = {};
    const raw = meta.usage.models && typeof meta.usage.models === 'object' ? meta.usage.models : {};
    let guard = 0;
    for (const [m, n] of Object.entries(raw)) {
      if (guard >= 50) break;
      const count = Number(n);
      const cleanModel = String(m || '').replace(/[<>"'&\x00-\x1f\x7f]/g, '').trim().slice(0, 96);
      if (!cleanModel || !Number.isFinite(count) || count <= 0) continue;
      models[cleanModel] = Math.floor(count);
      guard += 1;
    }

    let modelStats = null;
    const rawStats = meta.usage.model_stats && typeof meta.usage.model_stats === 'object' ? meta.usage.model_stats : null;
    if (rawStats) {
      modelStats = {};
      let sGuard = 0;
      for (const [m, st] of Object.entries(rawStats)) {
        if (sGuard >= 50) break;
        if (!st || typeof st !== 'object') continue;
        const cleanModel = String(m || '').replace(/[<>"'&\x00-\x1f\x7f]/g, '').trim().slice(0, 96);
        if (!cleanModel) continue;
        const calls = Math.max(0, Math.floor(Number(st.calls ?? st.requests) || 0));
        const successes = Math.max(0, Math.floor(Number(st.successes ?? st.success) || 0));
        const failed = Math.max(0, Math.floor(Number(st.failed) || 0));
        const in_tokens = Math.max(0, Math.floor(Number(st.in_tokens ?? st.input_tokens) || 0));
        const out_tokens = Math.max(0, Math.floor(Number(st.out_tokens ?? st.output_tokens) || 0));
        if (calls <= 0 && successes <= 0 && failed <= 0 && in_tokens <= 0 && out_tokens <= 0) continue;
        modelStats[cleanModel] = { calls, successes, failed, in_tokens, out_tokens };
        if (!models[cleanModel] && calls > 0) {
          models[cleanModel] = calls;
        }
        sGuard += 1;
      }
    }

    node.usage = {
      models,
      ...(modelStats ? { model_stats: modelStats } : {}),
      requests: Number(meta.usage.requests) || 0,
      successes: Number(meta.usage.successes) || 0,
      failed: Number(meta.usage.failed) || 0,
      in_tokens: Number(meta.usage.in_tokens) || 0,
      out_tokens: Number(meta.usage.out_tokens) || 0,
      updated_at: new Date(now).toISOString(),
    };
  }
  const nowIso = new Date(now).toISOString();

  // Only throttle pure idle 304 heartbeats with no usage payload and no binaryVersion change
  if (lastTime > 0 && meta?.is304 && !hasUsage && !hasBinVerChange && now - lastTime < 60_000) return;

  node.last_seen = nowIso;
  if (configVer) node.last_config_version = configVer;
  await saveNodes(nodes, kv);
}

/**
 * Lightweight heartbeat touch: update last_seen / last_ip / last_binary_version only.
 * Deliberately does NOT touch sync_count, config version, usage or any config
 * payload — the heartbeat exists purely to keep the node's "online" signal and
 * reported binary version fresh at the lowest possible EdgeOne Makers cost.
 *
 * Server-side debounce uses last_seen itself (no extra KV field): if the node
 * was seen less than 60s ago we return without loading or writing KV again.
 * The 60s floor matches the client's minimum heartbeat interval.
 *
 * @param node the node object returned by findNodeByToken (auth already loaded it)
 * @returns {{written: boolean, debounced: boolean}}
 */
export async function touchNodeHeartbeat(node, kv, meta = {}) {
  if (!node) return { written: false, debounced: false };

  const now = Date.now();
  const lastTime = node.last_seen ? new Date(node.last_seen).getTime() : 0;
  // Debounce on the existing last_seen field. No KV write (not even a read of
  // the full array) on the hot path — this is the quota-saving decision.
  if (lastTime > 0 && now - lastTime < 60_000) {
    return { written: false, debounced: true };
  }

  const cleanBinVer = cleanBinaryVersion(meta && meta.binaryVersion);
  const cleanIp = meta && meta.ip ? String(meta.ip) : '';

  const nodes = await loadNodes(kv);
  const target = nodes.find((n) => n.id === node.id);
  if (!target) return { written: false, debounced: false };

  target.last_seen = new Date(now).toISOString();
  if (cleanIp) target.last_ip = cleanIp;
  // Preserve the previous version when the node omits X-Node-Version — never clear it.
  if (cleanBinVer) target.last_binary_version = cleanBinVer;

  await saveNodes(nodes, kv);
  return { written: true, debounced: false };
}
