import { checkAdminAuth, resolveKvBinding, resolveEnv } from '../../lib/config.js';
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
const msg = String((err && err.message) || err || 'unknown_error').replace(/\s+/g, ' ').trim();
return msg.slice(0, 200);
}
export async function handleModelCatalogRequest(request, env, kv, fetchImpl) {
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
if (method === 'GET' && action === 'data') {
const text = await readCatalogText(kv);
if (!text) return jsonResponse({ ok: false, error: 'catalog_not_found' }, 404);
return new Response(text, {
status: 200,
headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
}
if (method === 'GET' && !action) {
return jsonResponse({ ok: true, ...(await meta(kv)) }, 200);
}
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
const fallback = lookupByModelID(catalog, model);
return jsonResponse({ ok: true, ...(fallback.found ? fallback : exact) }, 200);
}
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
export default {
async fetch(request, env, context) {
const kv = resolveKvBinding(context || env, env?.KV || env?.EDGE_KV);
const resolvedEnv = resolveEnv(env || context);
const fetchImpl = context?.fetch || resolvedEnv?.fetchImpl || globalThis.fetch;
return handleModelCatalogRequest(request, resolvedEnv, kv, fetchImpl);
},
};