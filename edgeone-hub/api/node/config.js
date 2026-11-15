import { loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { findNodeByToken, touchNodeLastSeen } from '../../lib/nodes.js';
import { projectConfigForNode } from '../../lib/projection.js';
import { computeEtag } from '../../lib/crypto.js';
import { getPresetMap } from '../../lib/presets.js';

export async function handleNodeConfigRequest(request, env, kv) {
  const method = request.method.toUpperCase();
  if (method !== 'POST') {
    return new Response(
      JSON.stringify({ ok: false, error: 'method_not_allowed' }),
      { status: 405, headers: { 'content-type': 'application/json' } }
    );
  }

  // 1. Authenticate Node via NODE_TOKEN (Authorization: Bearer stk_node_...)
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(stk_node_[a-f0-9]+)$/i);
  if (!match) {
    return new Response(
      JSON.stringify({ ok: false, error: 'node_revoked_or_invalid' }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  }

  const rawToken = match[1];
  const node = await findNodeByToken(rawToken, kv);

  // 401 Interception if node not found or revoked/disabled
  if (!node || node.enabled === false) {
    return new Response(
      JSON.stringify({ ok: false, error: 'node_revoked_or_invalid' }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  }

  // 2. Load authoritative configuration
  const config = await loadConfig(kv);
  const presetsMap = getPresetMap();

  // 3. Compute safe, scoped projection (Physical Zero-Leak + Scope Isolation)
  const payload = projectConfigForNode(node, config, presetsMap);

  const nowSec = Math.floor(Date.now() / 1000);
  const leaseTtl = Number(node.lease_ttl) || 86400;
  const graceTtl = Number(node.grace_ttl) || 3600;
  const leaseUntil = nowSec + leaseTtl;
  const graceUntil = leaseUntil + graceTtl;

  // 4. Compute ETag
  const etag = computeEtag({
    v: config._version || 1,
    scope: node.scope,
    payload,
  });

  const ifNoneMatch = request.headers.get('if-none-match');
  const is304 = Boolean(ifNoneMatch && ifNoneMatch === etag);
  const clientIp =
    (request.headers.get('eo-connecting-ip') ||
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '')
      .split(',')[0]
      .trim() || null;

  let telemetry = null;
  try {
    const reqClone = request.clone();
    const reqJson = await reqClone.json();
    if (reqJson && typeof reqJson.telemetry === 'object') {
      telemetry = reqJson.telemetry;
    }
  } catch (_) {}

  // Touch node's last_seen and sync counters
  touchNodeLastSeen(node.id, kv, config._version, { is304, ip: clientIp, telemetry }).catch(() => {});

  const responseHeaders = {
    'ETag': etag,
    'X-Config-Version': String(config._version || 1),
    'X-Lease-Until': String(leaseUntil),
    'X-Grace-Until': String(graceUntil),
  };

  // 5. ETag 304 Zero-Payload Check
  if (is304) {
    return new Response(null, {
      status: 304,
      headers: responseHeaders,
    });
  }

  // 6. 200 OK Response
  const respBody = {
    ok: true,
    config_version: config._version || 1,
    lease_ttl: leaseTtl,
    grace_ttl: graceTtl,
    lease_until: leaseUntil,
    payload,
  };

  return new Response(JSON.stringify(respBody), {
    status: 200,
    headers: {
      ...responseHeaders,
      'content-type': 'application/json',
    },
  });
}

// EdgeOne Pages standard entry points
export async function onRequest(context) {
  const kv = resolveKvBinding(context);
  const env = resolveEnv(context);
  return handleNodeConfigRequest(context.request, env, kv);
}

export async function onRequestGet(context) {
  return onRequest(context);
}

export async function onRequestPost(context) {
  return onRequest(context);
}

export async function onRequestPut(context) {
  return onRequest(context);
}

export async function onRequestPatch(context) {
  return onRequest(context);
}

export async function onRequestDelete(context) {
  return onRequest(context);
}

// EdgeOne fetch entry point
export default {
  async fetch(request, env, context) {
    const kv = resolveKvBinding(context || env, env?.KV || env?.EDGE_KV);
    const resolvedEnv = resolveEnv(env || context);
    return handleNodeConfigRequest(request, resolvedEnv, kv);
  },
};
