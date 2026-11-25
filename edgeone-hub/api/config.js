import {
  loadConfig,
  saveConfigWithCAS,
  checkAdminAuth,
  CASConflictError,
  ConfigValidationError,
  resolveKvBinding,
  resolveEnv,
} from '../lib/config.js';
import { meta as catalogMeta } from '../lib/model-catalog.js';

export async function handleConfigRequest(request, env, kv) {
  const authErr = checkAdminAuth(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'GET') {
    const config = await loadConfig(kv);
    // Meta only: the 1.6 MB catalog body must not ride on every page load.
    const m = await catalogMeta(kv);
    return new Response(
      JSON.stringify({
        ok: true,
        _version: config._version || 1,
        // Hub is the authoritative source: the admin console needs the plaintext key
        // to display and edit it. Node-facing projections stay masked (projection.js).
        ...config,
        // Meta only: the 1.6 MB catalog body must not ride on every page load.
        // Written last so a stale copy echoed back by an old KV cannot shadow it.
        model_catalog_meta: { present: m.present, fetched_at: m.fetched_at, model_count: m.model_count },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  if (method === 'POST' || method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return new Response(
        JSON.stringify({ ok: false, error: 'invalid_json_body' }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }

    try {
      const saved = await saveConfigWithCAS(body, kv);
      return new Response(
        JSON.stringify({
          ok: true,
          _version: saved._version,
          config: saved,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    } catch (err) {
      if (err instanceof CASConflictError || err?.name === 'CASConflictError' || err?.status === 409) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'config_version_conflict',
            current_version: Number(err.currentVersion ?? 1),
            submitted_version: err.submittedVersion !== undefined ? err.submittedVersion : null,
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        );
      }
      if (err instanceof ConfigValidationError || err?.name === 'ConfigValidationError' || err?.status === 400) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message || 'validation_failed' }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ ok: false, error: err.message || 'save_failed' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  }

  return new Response(
    JSON.stringify({ ok: false, error: 'method_not_allowed' }),
    { status: 405, headers: { 'content-type': 'application/json' } }
  );
}

// EdgeOne Pages standard entry points
export async function onRequest(context) {
  const kv = resolveKvBinding(context);
  const env = resolveEnv(context);
  return handleConfigRequest(context.request, env, kv);
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
    return handleConfigRequest(request, resolvedEnv, kv);
  },
};
