import { checkAdminAuth, loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import {
  listNodes,
  issueNode,
  patchNode,
  rotateNodeToken,
  reissueNodeToken,
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
  // GET /api/admin/nodes/:id/install-command — re-obtain the one-click install
  // command for an existing node. Rotates the token under the hood (KV only
  // stores the SHA-256 digest), which is the spec-compliant way to re-issue.
  // Path match is exact (segments after the id, nothing after): an endsWith
  // fallback would let malformed paths like /:id/rotate/install-command hit
  // this branch and silently invalidate a running node's credential.
  const isInstallCommand =
    method === 'GET' &&
    ((nodesIdx >= 0 && pathParts.length === nodesIdx + 3 && pathParts[nodesIdx + 2] === 'install-command') ||
      (params && params.action === 'install-command'));

  const hubUrl = `${url.protocol}//${url.host}`;

  // 1. GET /api/admin/nodes
  if (method === 'GET' && !targetId) {
    const nodes = await listNodes(kv);
    return new Response(
      JSON.stringify({ ok: true, nodes }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // 1b. GET /api/admin/nodes/:id/install-command (token rotation + deploy material)
  if (isInstallCommand && targetId) {
    const cfg = await loadConfig(kv);
    const clientKey = cfg?.settings?.client_key || cfg?.settings?.proxy_api_key || '';
    const res = await reissueNodeToken(targetId, kv, hubUrl, clientKey);
    if (!res) {
      return new Response(
        JSON.stringify({ ok: false, error: 'node_not_found' }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        node: res.node,
        node_token: res.node_token,
        client_key: res.client_key,
        admin_password: res.admin_password,
        bootstrap_env: res.bootstrap_env,
        install_command: res.install_command,
      }),
      // no-store: this is the only GET in the repo whose body carries a
      // plaintext node token; no intermediary may retain it.
      { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
    );
  }

  // 2. POST /api/admin/nodes (Issue)
  if (method === 'POST' && !targetId) {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {}

    try {
      const cfg = await loadConfig(kv);
      const clientKey = cfg?.settings?.client_key || cfg?.settings?.proxy_api_key || '';
      const res = await issueNode(body, kv, hubUrl, clientKey);
      return new Response(
        JSON.stringify({
          ok: true,
          node: res.node,
          node_token: res.node_token,
          client_key: res.client_key,
          admin_password: res.admin_password,
          bootstrap_env: res.bootstrap_env,
          install_command: res.install_command,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    } catch (err) {
      if (err?.status === 400) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      throw err;
    }
  }

  // 3. POST /api/admin/nodes/:id/rotate
  if (method === 'POST' && targetId && isRotate) {
    const cfg = await loadConfig(kv);
    const clientKey = cfg?.settings?.client_key || cfg?.settings?.proxy_api_key || '';
    const res = await rotateNodeToken(targetId, kv, hubUrl, clientKey);
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
        client_key: res.client_key,
        admin_password: res.admin_password,
        bootstrap_env: res.bootstrap_env,
        install_command: res.install_command,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // 5. PATCH /api/admin/nodes/:id (Update / Revoke / Restore)
  if (method === 'PATCH' && targetId) {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {}

    try {
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
    } catch (err) {
      if (err?.status === 400) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      throw err;
    }
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
