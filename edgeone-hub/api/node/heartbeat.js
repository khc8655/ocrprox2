import { loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { findNodeByToken, touchNodeHeartbeat } from '../../lib/nodes.js';

/**
 * POST /api/node/heartbeat — minimal liveness + version signal for Full nodes.
 *
 * Cost-conscious by design (EdgeOne Makers meters invocations AND KV writes):
 *  - Bearer stk_node_* auth reuses findNodeByToken; no config is loaded, no
 *    projection is computed, no payload is returned.
 *  - Server-side debounce: a heartbeat inside 60s of last_seen returns 204
 *    without any KV write (touchNodeHeartbeat short-circuits on last_seen).
 *  - The response carries the hub's CURRENT config_version so a node can tell
 *    that the template changed and pull it. Without this, a node only refreshed
 *    on lease expiry (default 24h) — the operator edited a model and saw nothing
 *    happen (found in the 2026-11-24 lite E2E). The version is one integer and
 *    the config is already read for the 304/cache path, so this costs no extra
 *    KV read in the common case.
 *  - The body is otherwise empty; older nodes ignore it.
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

  // 2. Derive the client IP. Header precedence matches /api/node/config:
  //    the platform's own header first (a caller cannot spoof it), then
  //    Cloudflare's, then a proxy-supplied X-Forwarded-For chain.
  const headerIp =
    (request.headers.get('eo-connecting-ip') ||
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '')
      .split(',')[0]
      .trim();

  // 2b. No proxy header (direct hit on the edge, local/dev runtime): fall back
  //     to the platform's own client-IP property. EdgeOne Functions get no
  //     socket peer address — EventContext carries only request / params / env /
  //     waitUntil, with no remoteAddr — but the Request object exposes
  //     `request.eo.clientIp` (IncomingRequestEoProperties.clientIp: "客户端请求
  //     IP"). Optional-chained because the local Node test harness has no `eo`.
  const edgeOneIp =
    request && request.eo && typeof request.eo.clientIp === 'string'
      ? request.eo.clientIp.trim()
      : '';

  const clientIp = headerIp || edgeOneIp || null;

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

  // 4. Report the current config version. This is the only signal a node gets
  //    that the template changed: it compares against the version it holds and
  //    pulls when they differ. Kept as a tiny JSON body on an otherwise empty
  //    response, and only on the non-debounced path so a quiet node costs
  //    nothing extra.
  //
  //    A failure to read the version must never fail the heartbeat: liveness is
  //    the primary purpose, and the node simply retries on its next beat.
  let configVersion = 0;
  try {
    const config = await loadConfig(kv);
    configVersion = Number(config && config._version) || 0;
  } catch (_) {}

  return new Response(
    JSON.stringify({ ok: true, config_version: configVersion }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
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
