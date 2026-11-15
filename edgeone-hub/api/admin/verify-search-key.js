import {
  checkAdminAuth,
  isMaskedSecret,
  resolveKvBinding,
  resolveEnv,
  loadConfig,
  findUnmaskedKey,
  persistProviderKeyHealth,
} from '../../lib/config.js';
import { scrubSecrets, isSafePublicHttpUrl } from '../../lib/models.js';

const SEARCH_DEFAULT_BASE_URLS = {
  brave: 'https://api.search.brave.com',
  tavily: 'https://api.tavily.com',
  jina: 'https://s.jina.ai',
  serper: 'https://google.serper.dev',
  firecrawl: 'https://api.firecrawl.dev',
  exa: 'https://api.exa.ai',
};

function interpolateTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateTemplate(item, vars));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateTemplate(v, vars);
    }
    return out;
  }
  return value;
}

function buildSearchProbeRequest({ adapter, provider, baseUrl, requestSpec, fetchSpec, apiKey }) {
  const kind = String(adapter || provider || '').trim().toLowerCase();
  const cleanBase = String(baseUrl || SEARCH_DEFAULT_BASE_URLS[kind] || '')
    .trim()
    .replace(/\/+$/, '');

  const spec =
    requestSpec && typeof requestSpec === 'object'
      ? requestSpec
      : fetchSpec && typeof fetchSpec === 'object'
        ? fetchSpec
        : null;

  if (spec && (spec.url || spec.path)) {
    const vars = {
      api_key: apiKey,
      key: apiKey,
      query: 'ping',
      q: 'ping',
      max_results: 1,
      limit: 1,
      url: 'https://example.com',
    };
    let rawUrl = String(spec.url || '').trim();
    if (!rawUrl && spec.path) {
      if (!cleanBase) return { error: 'base_url_required' };
      const rel = String(spec.path).startsWith('/') ? String(spec.path) : `/${spec.path}`;
      rawUrl = `${cleanBase}${rel}`;
    }
    rawUrl = interpolateTemplate(rawUrl, vars);
    if (spec.query && typeof spec.query === 'object') {
      try {
        const u = new URL(rawUrl);
        for (const [qk, qv] of Object.entries(spec.query)) {
          u.searchParams.set(qk, String(interpolateTemplate(qv, vars)));
        }
        rawUrl = u.toString();
      } catch (_) {}
    }
    const method = String(spec.method || 'GET').toUpperCase();
    const headers = { accept: 'application/json', ...(interpolateTemplate(spec.headers || {}, vars)) };
    let body;
    if (spec.body !== undefined && spec.body !== null && method !== 'GET' && method !== 'HEAD') {
      const renderedBody = interpolateTemplate(spec.body, vars);
      if (typeof renderedBody === 'string') {
        body = renderedBody;
      } else {
        body = JSON.stringify(renderedBody);
        if (!headers['content-type'] && !headers['Content-Type']) {
          headers['content-type'] = 'application/json';
        }
      }
    }
    return { url: rawUrl, method, headers, body };
  }

  if (!cleanBase) {
    return { error: 'base_url_required' };
  }

  switch (kind) {
    case 'brave': {
      const url = cleanBase.includes('/res/v1/')
        ? `${cleanBase}?q=ping&count=1`
        : `${cleanBase}/res/v1/web/search?q=ping&count=1`;
      return {
        url,
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
      };
    }
    case 'tavily': {
      const url = cleanBase.endsWith('/search') ? cleanBase : `${cleanBase}/search`;
      return {
        url,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ api_key: apiKey, query: 'ping', max_results: 1 }),
      };
    }
    case 'jina': {
      const target = cleanBase.includes('r.jina.ai')
        ? `${cleanBase}/https://example.com`
        : `${cleanBase}/?q=ping`;
      return {
        url: target,
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
        },
      };
    }
    case 'serper': {
      const url = cleanBase.endsWith('/search') ? cleanBase : `${cleanBase}/search`;
      return {
        url,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'X-API-KEY': apiKey,
        },
        body: JSON.stringify({ q: 'ping', num: 1 }),
      };
    }
    case 'firecrawl': {
      const url = cleanBase.endsWith('/search') ? cleanBase : `${cleanBase}/v1/search`;
      return {
        url,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: 'ping', limit: 1 }),
      };
    }
    case 'exa': {
      const url = cleanBase.endsWith('/search') ? cleanBase : `${cleanBase}/search`;
      return {
        url,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ query: 'ping', numResults: 1 }),
      };
    }
    default:
      return { error: 'unsupported_search_adapter_or_missing_request_spec' };
  }
}

export async function handleVerifySearchKey(request, env, fetchImplOrOpts) {
  const authErr = checkAdminAuth(request, env);
  if (authErr) return authErr;

  if (request.method.toUpperCase() !== 'POST') {
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
  const provider = String(body.provider || '').trim();
  const keyLabel = String(body.key_label || body.keyLabel || '').trim();
  let adapter = body.adapter ? String(body.adapter).trim() : '';
  let baseUrl = body.base_url || body.baseUrl || '';
  let requestSpec = body.request;
  let fetchSpec = body.fetch;

  if (provider && (!apiKey || isMaskedSecret(apiKey) || !adapter || !baseUrl || (!requestSpec && !fetchSpec))) {
    const kv = resolveKvBinding(env);
    const config = await loadConfig(kv);
    const sp = config?.search_providers?.[provider];
    if (sp) {
      if (!apiKey || isMaskedSecret(apiKey)) {
        const resolved = findUnmaskedKey(sp, keyLabel);
        if (resolved) apiKey = resolved;
      }
      adapter = adapter || sp.adapter || '';
      baseUrl = baseUrl || sp.base_url || '';
      if (!requestSpec && sp.request) requestSpec = sp.request;
      if (!fetchSpec && sp.fetch) fetchSpec = sp.fetch;
    }
  }

  if (!apiKey) {
    return new Response(
      JSON.stringify({ ok: false, error: 'api_key_required' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  if (isMaskedSecret(apiKey)) {
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

  const cleanKey = apiKey.trim();
  const probe = buildSearchProbeRequest({
    adapter,
    provider,
    baseUrl,
    requestSpec,
    fetchSpec,
    apiKey: cleanKey,
  });

  if (probe.error) {
    return new Response(
      JSON.stringify({ ok: false, error: probe.error }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  if (!isSafePublicHttpUrl(probe.url)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'unsafe_or_invalid_url' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const fetchFn =
    typeof fetchImplOrOpts === 'function'
      ? fetchImplOrOpts
      : fetchImplOrOpts?.fetchImpl || env?.fetchImpl || globalThis.fetch;

  const startMs = Date.now();
  let resp;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
    try {
      resp = await fetchFn(probe.url, {
        method: probe.method,
        headers: probe.headers,
        body: probe.body,
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    const latency_ms = Math.max(0, Date.now() - startMs);
    const errMsg = scrubSecrets(err?.message || 'Upstream connection failed', [cleanKey]);
    await persistProviderKeyHealth(env, 'search_providers', provider, keyLabel, {
      valid: false,
      status: 0,
      latency_ms,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        valid: false,
        status: 0,
        latency_ms,
        error: errMsg,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  const latency_ms = Math.max(0, Date.now() - startMs);
  if (resp.ok) {
    await persistProviderKeyHealth(env, 'search_providers', provider, keyLabel, {
      valid: true,
      status: resp.status,
      latency_ms,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        valid: true,
        status: resp.status,
        latency_ms,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  let errorMsg = `Upstream returned status ${resp.status}`;
  try {
    const errData = await resp.json();
    if (errData?.error?.message) errorMsg = errData.error.message;
    else if (typeof errData?.error === 'string') errorMsg = errData.error;
    else if (errData?.message) errorMsg = errData.message;
    else if (errData?.detail) errorMsg = typeof errData.detail === 'string' ? errData.detail : JSON.stringify(errData.detail);
  } catch (_) {
    try {
      const rawText = await resp.text();
      if (rawText && rawText.length < 256) errorMsg = rawText;
    } catch (_) {}
  }

  await persistProviderKeyHealth(env, 'search_providers', provider, keyLabel, {
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

export async function onRequest(context) {
  const env = resolveEnv(context);
  const fetchImpl = context?.fetch || env?.fetchImpl || globalThis.fetch;
  return handleVerifySearchKey(context.request, env, fetchImpl);
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

export default {
  async fetch(request, env, context) {
    const resolvedEnv = resolveEnv(env || context);
    const fetchImpl = context?.fetch || resolvedEnv?.fetchImpl || globalThis.fetch;
    return handleVerifySearchKey(request, resolvedEnv, fetchImpl);
  },
};
