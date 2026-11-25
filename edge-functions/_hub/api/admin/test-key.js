import {
checkAdminAuth,
isMaskedSecret,
resolveKvBinding,
resolveEnv,
loadConfig,
findUnmaskedKey,
persistProviderKeyHealth,
} from '../../lib/config.js';
import { getPresetMap } from '../../lib/presets.js';
import { scrubSecrets, isSafePublicHttpUrl, joinUpstreamUrl } from '../../lib/models.js';
import {
FAILURE_KIND,
classifyFailure,
compressError,
extractRequestId,
} from '../../lib/failure_reason.js';
const PROBE_TIMEOUT_MS = 20000;
const MAX_REPLY_CHARS = 200;
const USER_CONTENT = '你好';
const MAX_TOKENS = 16;
const JSON_HEADERS = { 'content-type': 'application/json' };
function jsonResponse(data, status = 200) {
const payload = { ...data, ok: status === 200 };
return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}
function emptyResult() {
return {
ok: false,
valid: false,
status: 0,
latency_ms: 0,
provider: '',
key_id: '',
key_label: '',
model: '',
model_source: '',
api_type: '',
reply_text: '',
reason: '',
err_type: '',
error: '',
rid: '',
};
}
function selectStoredKey(prov, keyId, keyLabel) {
const entries = Array.isArray(prov?.api_keys) ? prov.api_keys.filter(Boolean) : [];
const usable = (k) => Boolean(k && k.key && typeof k.key === 'string' && !isMaskedSecret(k.key));
const labelOf = (k) => k.label || k.id || '';
if (entries.length > 0) {
if (keyId || keyLabel) {
const match = entries.find((k) =>
(keyId && (k.id === keyId || k.label === keyId)) ||
(keyLabel && (k.label === keyLabel || k.id === keyLabel))
);
if (!match) return { error: 'key_not_found' };
if (!usable(match)) return { error: 'key_secret_unavailable' };
return { key: match.key.trim(), key_id: match.id || '', key_label: labelOf(match) };
}
const enabled = entries.find((k) => k.enabled !== false && usable(k));
if (!enabled) return { error: 'no_enabled_key' };
return { key: enabled.key.trim(), key_id: enabled.id || '', key_label: labelOf(enabled) };
}
const legacyKey = findUnmaskedKey(prov, keyLabel || keyId);
if (!legacyKey) return { error: keyId || keyLabel ? 'key_not_found' : 'no_enabled_key' };
return { key: legacyKey.trim(), key_id: '', key_label: keyLabel || keyId || '' };
}
function resolveApiType(providerName, prov) {
const raw = String(prov?.api_type || '').trim().toLowerCase();
if (raw === 'anthropic' || raw === 'anthropic-messages' || raw === 'messages') return 'anthropic-messages';
if (raw) return 'openai-completions';
const protocols = Array.isArray(prov?.protocols) ? prov.protocols.map((p) => String(p).toLowerCase()) : [];
if (protocols.length > 0) {
const hasAnthropic = protocols.some((p) => p === 'anthropic' || p === 'messages' || p === 'anthropic-messages');
const hasOpenAI = protocols.some((p) => p === 'openai' || p === 'chat' || p === 'responses');
return hasAnthropic && !hasOpenAI ? 'anthropic-messages' : 'openai-completions';
}
const presetID = String(prov?.preset_id || providerName || '').toLowerCase();
return presetID === 'anthropic' || presetID === 'claude' ? 'anthropic-messages' : 'openai-completions';
}
function resolveBaseUrl(prov, preset, apiType) {
const base = String(prov?.base_url || preset?.base_url || '').trim();
const anthropicBase = String(
prov?.anthropic_base_url || prov?.anthropic_url || preset?.anthropic_base_url || ''
).trim();
if (apiType === 'anthropic-messages' && anthropicBase) return anthropicBase;
return base || anthropicBase;
}
function resolveModel(config, providerName, prov, requested, apiType) {
const explicit = String(requested || '').trim();
if (explicit) return { model: explicit, source: 'request' };
const routes = config?.agent_models && typeof config.agent_models === 'object' ? config.agent_models : {};
const names = Object.keys(routes).sort();
const pickRoute = (requireEnabled) => {
for (const name of names) {
const route = routes[name];
if (!route || typeof route !== 'object') continue;
const candidates = Array.isArray(route.candidates) ? route.candidates : [];
for (const c of candidates) {
if (!c || c.provider !== providerName) continue;
if (requireEnabled && c.enabled === false) continue;
const m = String(c.target_model || '').trim();
if (m) return m;
}
}
return '';
};
const routeModel = pickRoute(true) || pickRoute(false);
if (routeModel) return { model: routeModel, source: 'route' };
const presets = getPresetMap();
const preset = presets[prov?.preset_id || providerName] || {};
const recommended = Array.isArray(preset.models)
? preset.models.find((m) => typeof m === 'string' && m.trim())
: '';
if (recommended) return { model: recommended.trim(), source: 'preset' };
return {
model: apiType === 'anthropic-messages' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini',
source: 'fallback',
};
}
function truncateChars(value, max) {
const chars = Array.from(String(value == null ? '' : value));
return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}
function extractReplyText(rawText, isAnthropic) {
if (!rawText) return '';
let data;
try {
data = JSON.parse(rawText);
} catch (_) {
return '';
}
if (!data || typeof data !== 'object') return '';
if (isAnthropic) {
const blocks = Array.isArray(data.content) ? data.content : [];
return blocks
.filter((b) => b && (b.type === undefined || b.type === 'text') && typeof b.text === 'string')
.map((b) => b.text)
.join('')
.trim();
}
const first = Array.isArray(data.choices) ? data.choices[0] : null;
const content = first?.message?.content;
if (typeof content === 'string') return content.trim();
if (Array.isArray(content)) {
return content
.filter((p) => p && (p.type === undefined || p.type === 'text') && typeof p.text === 'string')
.map((p) => p.text)
.join('')
.trim();
}
return '';
}
function isTimeoutAbort(err) {
const name = String(err?.name || '');
const message = String(err?.message || '');
return name === 'AbortError' || name === 'TimeoutError' || /aborted|timeout/i.test(message);
}
async function persistVerdict(env, result) {
if (!env || !result?.provider || (!result.key_id && !result.key_label)) return;
try {
await persistProviderKeyHealth(env, 'providers', result.provider, result.key_label || result.key_id, {
valid: result.valid,
status: result.status,
latency_ms: result.latency_ms,
last_test: {
ok: Boolean(result.valid),
status: Number(result.status) || 0,
latency_ms: Number(result.latency_ms) || 0,
reason: result.reason || '',
err_type: result.err_type || '',
error: result.error || '',
reply_text: result.reply_text || '',
at: new Date().toISOString(),
},
});
} catch (_) {}
}
export async function handleTestKey(request, env, fetchImplOrOpts) {
const authErr = checkAdminAuth(request, env);
if (authErr) return authErr;
const method = request.method.toUpperCase();
if (method !== 'POST') {
return jsonResponse({ ok: false, valid: false, error: 'method_not_allowed' }, 405);
}
let body = {};
try {
body = await request.json();
} catch (_) {
return jsonResponse({ ok: false, valid: false, error: 'invalid_json_body' }, 400);
}
const providerName = typeof body.provider === 'string' ? body.provider.trim() : '';
const keyId = typeof body.key_id === 'string' ? body.key_id.trim() : '';
const keyLabel = typeof body.key_label === 'string' ? body.key_label.trim() : '';
const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
const result = emptyResult();
result.provider = providerName;
result.model = requestedModel;
if (!providerName) {
result.error = 'missing_provider';
result.status = 400;
return jsonResponse(result, 400);
}
let config = null;
try {
const kv = resolveKvBinding(env);
config = await loadConfig(kv);
} catch (_) {
result.error = 'config_unavailable';
result.status = 503;
return jsonResponse(result, 503);
}
const prov = config?.providers?.[providerName];
if (!prov || typeof prov !== 'object') {
result.error = `provider '${providerName}' not found`;
result.status = 400;
return jsonResponse(result, 400);
}
const selected = selectStoredKey(prov, keyId, keyLabel);
if (selected.error) {
result.error = selected.error;
result.status = 400;
return jsonResponse(result, 400);
}
result.key_id = selected.key_id;
result.key_label = selected.key_label;
const presets = getPresetMap();
const preset = presets[prov.preset_id || providerName] || {};
const apiType = resolveApiType(providerName, prov);
result.api_type = apiType;
const baseUrl = resolveBaseUrl(prov, preset, apiType);
if (!baseUrl) {
result.error = 'provider base_url is empty';
result.status = 400;
return jsonResponse(result, 400);
}
const resolved = resolveModel(config, providerName, prov, requestedModel, apiType);
result.model = resolved.model;
result.model_source = resolved.source;
const isAnthropic = apiType === 'anthropic-messages';
const targetUrl = isAnthropic
? joinUpstreamUrl(baseUrl, 'messages')
: joinUpstreamUrl(baseUrl, 'chat/completions');
if (!isSafePublicHttpUrl(targetUrl)) {
result.error = 'unsafe_upstream_url';
result.status = 400;
return jsonResponse(result, 400);
}
const cleanKey = selected.key;
const headers = {
'content-type': 'application/json',
accept: 'application/json',
};
if (isAnthropic) {
headers['x-api-key'] = cleanKey;
headers['anthropic-version'] = '2023-06-01';
} else {
headers.authorization = `Bearer ${cleanKey}`;
}
const payload = {
model: result.model,
messages: [{ role: 'user', content: USER_CONTENT }],
max_tokens: MAX_TOKENS,
stream: false,
};
const fetchFn =
typeof fetchImplOrOpts === 'function'
? fetchImplOrOpts
: fetchImplOrOpts?.fetchImpl || env?.fetchImpl || globalThis.fetch;
const controller = typeof AbortController === 'function' ? new AbortController() : null;
const timer = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null;
const start = Date.now();
let resp;
try {
resp = await fetchFn(targetUrl, {
method: 'POST',
headers,
body: JSON.stringify(payload),
...(controller ? { signal: controller.signal } : {}),
});
} catch (err) {
result.latency_ms = Date.now() - start;
const kind = isTimeoutAbort(err) ? FAILURE_KIND.TIMEOUT : FAILURE_KIND.NETWORK;
const classified = classifyFailure(0, '', kind);
result.reason = classified.reason;
result.err_type = classified.err_type;
result.error = scrubSecrets(compressError(err?.message || 'network_error'), [cleanKey]);
await persistVerdict(env, result);
return jsonResponse(result, 200);
} finally {
if (timer) clearTimeout(timer);
}
result.latency_ms = Date.now() - start;
result.status = Number(resp.status) || 0;
result.rid = extractRequestId(resp.headers);
let rawText = '';
try {
rawText = await resp.text();
} catch (_) {
rawText = '';
}
if (resp.ok) {
result.valid = true;
result.reply_text = truncateChars(extractReplyText(rawText, isAnthropic), MAX_REPLY_CHARS);
await persistVerdict(env, result);
return jsonResponse(result, 200);
}
const classified = classifyFailure(result.status, rawText, FAILURE_KIND.HTTP);
result.reason = classified.reason;
result.err_type = classified.err_type;
let errorText = scrubSecrets(compressError(rawText), [cleanKey]);
if (!errorText) errorText = `upstream returned ${result.status}`;
result.error = errorText;
if (result.error.includes(cleanKey)) {
result.error = result.error.split(cleanKey).join('[REDACTED]');
}
await persistVerdict(env, result);
return jsonResponse(result, 200);
}
export async function onRequest(context) {
const env = resolveEnv(context);
const fetchImpl = context?.fetch || env?.fetchImpl || globalThis.fetch;
return handleTestKey(context.request, env, fetchImpl);
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
return handleTestKey(request, resolvedEnv, fetchImpl);
},
};