import { generateNodeToken, hashToken, constantTimeCompare } from './crypto.js';

export const NODES_KV_KEY = 'relay_nodes';

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
  return nodes.map((n) => {
    const copy = { ...n };
    delete copy.token_sha256;
    return copy;
  });
}

/**
 * Issue a new node token and save node.
 */
export async function issueNode(params, kv, hubUrl = 'https://hub.example.com') {
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
    lease_ttl: Number(params.lease_ttl) || 86400,
    grace_ttl: Number(params.grace_ttl) || 3600,
    scope: {
      models: Array.isArray(params.scope?.models) ? params.scope.models : ['*'],
      providers: Array.isArray(params.scope?.providers) ? params.scope.providers : ['*'],
    },
    created_at: nowIso,
    last_seen: null,
    last_config_version: 0,
    last_binary_version: 'v2.0.0',
  };

  nodes.push(node);
  await saveNodes(nodes, kv);

  const bootstrapEnv = `LLMPROXY_ROLE=${node.role} LLMPROXY_HUB_URL=${hubUrl} LLMPROXY_NODE_TOKEN=${rawToken}`;

  const publicNode = { ...node };
  delete publicNode.token_sha256;

  return {
    node: publicNode,
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
  if (patch.enabled !== undefined) node.enabled = Boolean(patch.enabled);
  if (patch.lease_ttl !== undefined) node.lease_ttl = Number(patch.lease_ttl);
  if (patch.grace_ttl !== undefined) node.grace_ttl = Number(patch.grace_ttl);
  if (patch.scope !== undefined && typeof patch.scope === 'object') {
    node.scope = {
      models: Array.isArray(patch.scope.models) ? patch.scope.models : node.scope.models,
      providers: Array.isArray(patch.scope.providers) ? patch.scope.providers : node.scope.providers,
    };
  }

  nodes[idx] = node;
  await saveNodes(nodes, kv);

  const publicNode = { ...node };
  delete publicNode.token_sha256;
  return publicNode;
}

/**
 * Rotate token for an existing node.
 */
export async function rotateNodeToken(nodeId, kv, hubUrl = 'https://hub.example.com') {
  const nodes = await loadNodes(kv);
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) return null;

  const node = nodes[idx];
  const rawToken = generateNodeToken();
  const tokenSha = hashToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 17) + '...';

  node.token_sha256 = tokenSha;
  node.token_prefix = tokenPrefix;
  nodes[idx] = node;
  await saveNodes(nodes, kv);

  const bootstrapEnv = `LLMPROXY_ROLE=${node.role} LLMPROXY_HUB_URL=${hubUrl} LLMPROXY_NODE_TOKEN=${rawToken}`;

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
 * Update node last_seen (throttled to avoid excessive KV writes).
 */
export async function touchNodeLastSeen(nodeId, kv, configVer = 0) {
  const nodes = await loadNodes(kv);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const now = Date.now();
  const lastTime = node.last_seen ? new Date(node.last_seen).getTime() : 0;

  // Throttle to once every 5 minutes (300_000 ms) unless first time
  if (now - lastTime < 300_000) return;

  node.last_seen = new Date(now).toISOString();
  if (configVer) node.last_config_version = configVer;
  await saveNodes(nodes, kv);
}
