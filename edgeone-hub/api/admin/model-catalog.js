/**
 * Model catalog admin API.
 *
 *   POST /api/admin/model-catalog/update        pull models.dev, slim it, store in KV
 *   GET  /api/admin/model-catalog               catalog meta for the settings page
 *   GET  /api/admin/model-catalog/data          raw catalog JSON (what a Full node pulls)
 *   GET  /api/admin/model-catalog/lookup?preset=…&model=…
 *                                               one (preset, model) capability
 *
 * update and meta require the Hub admin credential. /data additionally accepts
 * a valid enabled Full node token (authenticateVaultCaller, same as
 * /api/vault/*): a node syncs its catalog cache with NODE_TOKEN and never holds
 * the Hub admin password. Lite tokens get 403 — lite does not consume the
 * catalog (it would blow the 1 MB node-config body limit).
 *
 * /lookup serves the Hub console itself (route-editor reasoning dropdown and the
 * add-model capability summary), so it stays admin-only; a Full node has its own
 * POST /api/admin/model-catalog/lookup backed by the embedded bundle.
 *
 * Failures during an update never touch KV: an unreachable upstream or an
 * invalid payload leaves the previously stored catalog exactly as it was.
 */

import { checkAdminAuth, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { probeSum } from '../../lib/zz-route-probe.js';
import { loadCatalog, lookup, lookupByModelID, meta, readCatalogText, saveCatalog, slimModelsDev } from '../../lib/model-catalog.js';
import { OVERRIDES, PROVIDER_MAP } from '../../lib/generated-model-map.js';
import { authenticateVaultCaller } from '../../lib/vaultauth.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 20000;

function jsonResponse(payload, status, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function detailOf(err) {
  // Never echo a response body or URL; one bounded line is enough to debug.
  const msg = String((err && err.message) || err || 'unknown_error').replace(/\s+/g, ' ').trim();
  return msg.slice(0, 200);
}

export async function handleModelCatalogRequest(request, env, kv, fetchImpl) {
  // Auth is per-action: GET /data is node-consumable (a Full node syncs its
  // catalog cache with its node token, same rule as /api/vault/*), while meta
  // and update stay admin-only (update writes KV and reaches the internet).
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const parts = url.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('model-catalog');
  const action = idx >= 0 && parts.length > idx + 1 ? parts[idx + 1] : null;

  if (method === 'GET' && action === 'data') {
    const auth = await authenticateVaultCaller(request, env, kv);
    if (!auth.ok) return auth.response;
  } else {
    const authErr = checkAdminAuth(request, env);
    if (authErr) return authErr;
  }

  // GET /api/admin/model-catalog/data — the raw catalog text, byte-for-byte as stored.
  if (method === 'GET' && action === 'data') {
    const text = await readCatalogText(kv);
    if (!text) return jsonResponse({ ok: false, error: 'catalog_not_found' }, 404);
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  // GET /api/admin/model-catalog — meta only (present / fetched_at / model_count / bytes).
  if (method === 'GET' && !action) {
    return jsonResponse({ ok: true, ...(await meta(kv)) }, 200);
  }

  // GET /api/admin/model-catalog/lookup?preset=deepseek&model=deepseek-v4-pro
  // Query params (not a token in the URL's path): both values are model ids, not
  // credentials. found=false means "not in the catalog" — the caller must fall
  // back to its preset rules instead of reading it as "no capability".
  if (method === 'GET' && action === 'lookup') {
    const catalog = await loadCatalog(kv);
    if (!catalog) return jsonResponse({ ok: false, error: 'catalog_not_found' }, 404);
    const preset = (url.searchParams.get('preset') || '').trim();
    const model = (url.searchParams.get('model') || '').trim();
    if (!preset || !model) {
      return jsonResponse({ ok: false, error: 'preset_and_model_required' }, 400);
    }
    const exact = lookup(catalog, PROVIDER_MAP, OVERRIDES, preset, model);
    if (exact.found) return jsonResponse({ ok: true, ...exact }, 200);
    // Same-named fallback: an unbound provider (reseller) still gets the vendor's
    // canonical numbers, labelled as such by the console.
    const fallback = lookupByModelID(catalog, model);
    return jsonResponse({ ok: true, ...(fallback.found ? fallback : exact) }, 200);
  }

  // POST /api/admin/model-catalog/update
  if (method === 'POST' && action === 'update') {
    const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;

    let fetched;
    try {
      const res = await fetchFn(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res || !res.ok) {
        return jsonResponse({ ok: false, error: 'models.dev_unreachable', detail: `http_${res ? res.status : 'none'}` }, 502);
      }
      fetched = await res.text();
    } catch (err) {
      return jsonResponse({ ok: false, error: 'models.dev_unreachable', detail: detailOf(err) }, 502);
    }

    let raw;
    try {
      raw = JSON.parse(fetched);
    } catch (_) {
      return jsonResponse({ ok: false, error: 'models.dev_invalid' }, 502);
    }

    let catalog;
    try {
      catalog = slimModelsDev(raw, new Date().toISOString());
    } catch (err) {
      return jsonResponse({ ok: false, error: 'catalog_invalid', detail: detailOf(err) }, 500);
    }

    let bytes;
    try {
      bytes = await saveCatalog(kv, JSON.stringify(catalog));
    } catch (err) {
      return jsonResponse({ ok: false, error: 'catalog_invalid', detail: detailOf(err) }, 500);
    }

    return jsonResponse(
      { ok: true, fetched_at: catalog.fetched_at, model_count: catalog.model_count, bytes },
      200
    );
  }

  if (method === 'GET' || method === 'POST') {
    return jsonResponse({ ok: false, error: action ? 'not_found' : 'method_not_allowed' }, action ? 404 : 405);
  }
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
}

// EdgeOne Pages standard entry points
void probeSum();

export async function onRequest(context) {
  const kv = resolveKvBinding(context);
  const env = resolveEnv(context);
  const fetchImpl = context?.fetch || env?.fetchImpl || globalThis.fetch;
  return handleModelCatalogRequest(context.request, env, kv, fetchImpl);
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
    const fetchImpl = context?.fetch || resolvedEnv?.fetchImpl || globalThis.fetch;
    return handleModelCatalogRequest(request, resolvedEnv, kv, fetchImpl);
  },
};