import { checkAdminAuth, isMaskedSecret, resolveKvBinding, resolveEnv, loadConfig, CONFIG_KV_KEY } from '../../lib/config.js';
import { getPresetMap } from '../../lib/presets.js';
import { resolveModelsUrl, scrubSecrets, extractModelIds } from '../../lib/models.js';

const isMaskedKey = isMaskedSecret;

async function persistKeyHealth(env, provider, keyLabel, result) {
  if (!provider) return;
  try {
    const kv = resolveKvBinding(env);
    if (!kv) return;
    const config = await loadConfig(kv);
    const prov = config?.providers?.[provider];
    if (!prov || !Array.isArray(prov.api_keys)) return;
    const match = keyLabel
      ? prov.api_keys.find(k => k && (k.label === keyLabel || k.id === keyLabel))
      : prov.api_keys[0];
    if (!match) return;
    match.last_ok = Boolean(result.valid);
    match.last_status = Number(result.status) || 0;
    match.last_latency_ms = Number(result.latency_ms) || 0;
    if (result.models_count !== undefined) {
      match.last_models_count = Number(result.models_count) || 0;
    }
    match.last_checked_at = new Date().toISOString();
    const serialized = JSON.stringify(config);
    if (typeof kv.put === 'function') {
      await kv.put(CONFIG_KV_KEY, serialized);
    } else if (typeof kv.setItem === 'function') {
      await kv.setItem(CONFIG_KV_KEY, serialized);
    }
  } catch (_) {}
}

function findUnmaskedKey(prov, keyLabel) {
  if (!prov) return null;
  // 1. prov.keys map: { [key_label]: "key" }
  if (prov.keys && typeof prov.keys === 'object' && !Array.isArray(prov.keys)) {
    if (keyLabel && typeof prov.keys[keyLabel] === 'string' && !isMaskedKey(prov.keys[keyLabel])) {
      return prov.keys[keyLabel];
    }
    for (const v of Object.values(prov.keys)) {
      if (typeof v === 'string' && v && !isMaskedKey(v)) return v;
      if (v && typeof v === 'object' && v.key && !isMaskedKey(v.key)) return v.key;
    }
  }
  // 2. prov.keys array
  if (Array.isArray(prov.keys)) {
    if (keyLabel) {
      const match = prov.keys.find(k => k && typeof k === 'object' && (k.label === keyLabel || k.id === keyLabel));
      if (match?.key && !isMaskedKey(match.key)) return match.key;
    }
    for (const item of prov.keys) {
      if (typeof item === 'string' && item && !isMaskedKey(item)) return item;
      if (item && typeof item === 'object' && item.key && !isMaskedKey(item.key)) return item.key;
    }
  }
  // 3. prov.api_keys array (standard schema)
  if (Array.isArray(prov.api_keys)) {
    if (keyLabel) {
      const match = prov.api_keys.find(k => k && (k.label === keyLabel || k.id === keyLabel));
      if (match?.key && !isMaskedKey(match.key)) return match.key;
    }
    for (const item of prov.api_keys) {
      if (item?.key && !isMaskedKey(item.key)) return item.key;
    }
  }
  return null;
}

export async function handleVerifyKey(request, env, fetchImplOrOpts) {
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

  let apiKey = typeof (body.api_key || body.key) === 'string' ? (body.api_key || body.key).trim() : '';
  const provider = body.provider;
  const keyLabel = body.key_label || body.keyLabel || '';
  let baseUrl = body.base_url || body.baseUrl;
  let apiType = body.api_type || body.apiType;

  if ((!apiKey || isMaskedKey(apiKey)) && provider) {
    const kv = resolveKvBinding(env);
    const config = await loadConfig(kv);
    const prov = config?.providers?.[provider];
    if (prov) {
      const resolvedKey = findUnmaskedKey(prov, keyLabel);
      if (resolvedKey) {
        apiKey = resolvedKey;
      }
      baseUrl = baseUrl || prov.base_url;
      apiType = apiType || prov.api_type;
    }
  }

  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'api_key_required' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  if (isMaskedKey(apiKey)) {
    return new Response(
      JSON.stringify({
        ok: true,
        valid: false,
        status: 400,
        error: 'cannot_verify_masked_key',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  if (!baseUrl && provider) {
    const presets = getPresetMap();
    if (presets[provider]?.base_url) {
      baseUrl = presets[provider].base_url;
    }
  }

  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'base_url_required' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const fetchFn =
    typeof fetchImplOrOpts === 'function'
      ? fetchImplOrOpts
      : fetchImplOrOpts?.fetchImpl || env?.fetchImpl || globalThis.fetch;

  const cleanKey = apiKey.trim();
  const authHeader = cleanKey.startsWith('Bearer ') ? cleanKey : `Bearer ${cleanKey}`;
  const headers = {
    accept: 'application/json',
    authorization: authHeader,
  };

  if (provider === 'anthropic' || provider === 'claude' || apiType === 'anthropic-messages') {
    headers['x-api-key'] = cleanKey.replace(/^Bearer\s+/i, '');
    headers['anthropic-version'] = '2023-06-01';
  }

  const targetUrl = resolveModelsUrl(baseUrl);
  const start = Date.now();
  let resp;

  try {
    resp = await fetchFn(targetUrl, {
      method: 'GET',
      headers,
    });
  } catch (err) {
    const latency_ms = Date.now() - start;
    return new Response(
      JSON.stringify({
        ok: true,
        valid: false,
        status: 0,
        latency_ms,
        error: scrubSecrets(err?.message || 'network_error', [cleanKey]),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  const latency_ms = Date.now() - start;

  if (resp.ok) {
    let modelsCount = 0;
    try {
      const data = await resp.json();
      const models = extractModelIds(data);
      modelsCount = models.length;
    } catch (_) {}

    await persistKeyHealth(env, provider, keyLabel, {
      valid: true,
      status: resp.status,
      latency_ms,
      models_count: modelsCount,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        valid: true,
        status: resp.status,
        latency_ms,
        models_count: modelsCount,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // Upstream returned non-2xx status
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

  await persistKeyHealth(env, provider, keyLabel, {
    valid: false,
    status: resp.status,
    latency_ms,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      valid: false,
      status: resp.status,
      latency_ms,
      error: scrubSecrets(errorMsg, [cleanKey]),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// EdgeOne Pages standard entry points
export async function onRequest(context) {
  const env = resolveEnv(context);
  const fetchImpl = context?.fetch || env?.fetchImpl || globalThis.fetch;
  return handleVerifyKey(context.request, env, fetchImpl);
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
    return handleVerifyKey(request, resolvedEnv, fetchImpl);
  },
};
