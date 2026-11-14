import { checkAdminAuth, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import {
  listNodes,
  issueNode,
  patchNode,
  rotateNodeToken,
  deleteNode,
} from '../../lib/nodes.js';

export async function handleNodesRequest(request, env, kv, params) {
  const authErr = checkAdminAuth(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathParts = url.pathname.split('/').filter(Boolean);
  // Expected path variants:
  // /api/admin/nodes
  // /api/admin/nodes/:id
  // /api/admin/nodes/:id/rotate

  const nodesIdx = pathParts.indexOf('nodes');
  const pathTargetId = nodesIdx >= 0 && pathParts.length > nodesIdx + 1 ? pathParts[nodesIdx + 1] : null;
  const targetId = (params && params.id) || pathTargetId;
  const isRotate =
    (nodesIdx >= 0 && pathParts.length > nodesIdx + 2 && pathParts[nodesIdx + 2] === 'rotate') ||
    (params && params.action === 'rotate') ||
    url.pathname.endsWith('/rotate');

  const hubUrl = `${url.protocol}//${url.host}`;

  // 1. GET /api/admin/nodes
  if (method === 'GET' && !targetId) {
    const nodes = await listNodes(kv);
    return new Response(
      JSON.stringify({ ok: true, nodes }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // 2. POST /api/admin/nodes (Issue)
  if (method === 'POST' && !targetId) {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {}

    const res = await issueNode(body, kv, hubUrl);
    return new Response(
      JSON.stringify({
        ok: true,
        node: res.node,
        node_token: res.node_token,
        bootstrap_env: res.bootstrap_env,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // 3. POST /api/admin/nodes/:id/rotate
  if (method === 'POST' && targetId && isRotate) {
    const res = await rotateNodeToken(targetId, kv, hubUrl);
    if (!res) {
      return new Response(
        JSON.stringify({ ok: false, error: 'node_not_found' }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        node_token: res.node_token,
        bootstrap_env: res.bootstrap_env,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // 4. PATCH /api/admin/nodes/:id (Update / Revoke / Restore)
  if (method === 'PATCH' && targetId) {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {}

    const updated = await patchNode(targetId, body, kv);
    if (!updated) {
      return new Response(
        JSON.stringify({ ok: false, error: 'node_not_found' }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ ok: true, node: updated }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // 5. DELETE /api/admin/nodes/:id
  if (method === 'DELETE' && targetId) {
    const ok = await deleteNode(targetId, kv);
    if (!ok) {
      return new Response(
        JSON.stringify({ ok: false, error: 'node_not_found' }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ ok: false, error: 'not_found' }),
    { status: 404, headers: { 'content-type': 'application/json' } }
  );
}

// EdgeOne Pages standard entry points
export async function onRequest(context) {
  const kv = resolveKvBinding(context);
  const env = resolveEnv(context);
  return handleNodesRequest(context.request, env, kv, context.params);
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
    return handleNodesRequest(request, resolvedEnv, kv, context?.params);
  },
};
