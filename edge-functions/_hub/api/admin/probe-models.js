import { checkAdminAuth, isMaskedSecret, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { getPresetMap } from '../../lib/presets.js';
import { resolveModelsUrl, scrubSecrets, extractModelIds } from '../../lib/models.js';

export async function handleProbeModels(request, env, fetchImplOrOpts) {
  const authErr = checkAdminAuth(request, env);
  if (authErr) return authErr;

  const method = request.method.toUpperCase();
  if (method !== 'POST') {
    return new Response(
      JSON.stringify({ ok: false, error: 'method_not_allowed' }),
      { status: 405, headers: { 'content-type': 'application/json' } }
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_json_body' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const { provider, api_key } = body;
  let { base_url } = body;

  if (!api_key || typeof api_key !== 'string' || !api_key.trim()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'api_key_required' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  if (isMaskedSecret(api_key)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'cannot_probe_with_masked_key' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  if (!base_url && provider) {
    const presets = getPresetMap();
    if (presets[provider]?.base_url) {
      base_url = presets[provider].base_url;
    }
  }

  if (!base_url || typeof base_url !== 'string' || !base_url.trim()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'base_url_required' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const fetchFn =
    typeof fetchImplOrOpts === 'function'
      ? fetchImplOrOpts
      : fetchImplOrOpts?.fetchImpl || env?.fetchImpl || globalThis.fetch;

  const cleanKey = api_key.trim();
  const authHeader = cleanKey.startsWith('Bearer ') ? cleanKey : `Bearer ${cleanKey}`;
  const headers = {
    accept: 'application/json',
    authorization: authHeader,
  };

  if (provider === 'anthropic' || provider === 'claude') {
    headers['x-api-key'] = cleanKey.replace(/^Bearer\s+/i, '');
    headers['anthropic-version'] = '2023-06-01';
  }

  const targetUrl = resolveModelsUrl(base_url);
  let resp;

  try {
    resp = await fetchFn(targetUrl, {
      method: 'GET',
      headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        status: 0,
        error: scrubSecrets(err?.message || 'network_error', [cleanKey]),
      }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  if (!resp.ok) {
    let errorMsg = `Upstream returned status ${resp.status}`;
    try {
      const errData = await resp.json();
      if (errData?.error?.message) {
        errorMsg = errData.error.message;
      } else if (typeof errData?.error === 'string') {
        errorMsg = errData.error;
      } else if (errData?.message) {
        errorMsg = errData.message;
      }
    } catch (_) {
      try {
        const rawText = await resp.text();
        if (rawText && rawText.length < 256) {
          errorMsg = rawText;
        }
      } catch (_) {}
    }

    const httpStatus = resp.status >= 400 && resp.status < 600 ? resp.status : 502;
    return new Response(
      JSON.stringify({
        ok: false,
        status: resp.status,
        error: scrubSecrets(errorMsg, [cleanKey]),
      }),
      { status: httpStatus, headers: { 'content-type': 'application/json' } }
    );
  }

  // Parse upstream models response
  let data;
  try {
    data = await resp.json();
  } catch (_) {
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_json_from_upstream' }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  const models = extractModelIds(data);
  return new Response(
    JSON.stringify({
      ok: true,
      models,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// EdgeOne Pages standard entry points
export async function onRequest(context) {
  const env = resolveEnv(context);
  const fetchImpl = context?.fetch || env?.fetchImpl || globalThis.fetch;
  return handleProbeModels(context.request, env, fetchImpl);
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
    const resolvedEnv = resolveEnv(env || context);
    const fetchImpl = context?.fetch || resolvedEnv?.fetchImpl || globalThis.fetch;
    return handleProbeModels(request, resolvedEnv, fetchImpl);
  },
};
