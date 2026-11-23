import { resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { findNodeByToken, touchNodeHeartbeat } from '../../lib/nodes.js';

/**
 * POST /api/node/heartbeat — minimal liveness + version signal for Full nodes.
 *
 * Cost-conscious by design (EdgeOne Makers meters invocations AND KV writes):
 *  - Bearer stk_node_* auth reuses findNodeByToken; no config is loaded, no
 *    projection is computed, no payload is returned.
 *  - Server-side debounce: a heartbeat inside 60s of last_seen returns 204
 *    without any KV write (touchNodeHeartbeat short-circuits on last_seen).
 *  - Success is always a bodyless 204 — the node only needs to know it was seen.
 */
export async function handleHeartbeatRequest(request, env, kv) {
  const method = (request && request.method ? request.method : 'GET').toUpperCase();
  if (method !== 'POST') {
    return new Response(
      JSON.stringify({ ok: false, error: 'method_not_allowed' }),
      { status: 405, headers: { 'content-type': 'application/json' } }
    );
  }

  // 1. Authenticate node via Authorization: Bearer stk_node_<hex>...
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(stk_node_[a-f0-9]+)$/i);
  if (!match) {
    return new Response(
      JSON.stringify({ ok: false, error: 'node_revoked_or_invalid' }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  }

  const node = await findNodeByToken(match[1], kv);
  // Revoked/disabled nodes (and unknown tokens) get the same 401 as other node endpoints.
  if (!node || node.enabled === false) {
    return new Response(
      JSON.stringify({ ok: false, error: 'node_revoked_or_invalid' }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  }

  // 2. Derive the client IP with the same header precedence as /api/node/config.
  const clientIp =
    (request.headers.get('eo-connecting-ip') ||
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '')
      .split(',')[0]
      .trim() || null;

  // 3. Touch liveness only. touchNodeHeartbeat debounces < 60s on last_seen
  // and never writes on the debounced path. A version-less heartbeat keeps the
  // previously reported version intact. Failures are swallowed: a heartbeat
  // must never break the caller; the next scheduled beat will retry.
  try {
    await touchNodeHeartbeat(node, kv, {
      ip: clientIp,
      binaryVersion: (request.headers.get('x-node-version') || '').trim(),
    });
  } catch (_) {}

  // 4. Always 204, no body — no config, no payload, no telemetry echo.
  return new Response(null, { status: 204 });
}

// EdgeOne Pages standard entry points
export async function onRequest(context) {
  const kv = resolveKvBinding(context);
  const env = resolveEnv(context);
  return handleHeartbeatRequest(context.request, env, kv);
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
    return handleHeartbeatRequest(request, resolvedEnv, kv);
  },
};
