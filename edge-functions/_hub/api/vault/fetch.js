import { loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { checkVaultAuth } from '../../lib/vaultauth.js';
import { getPresetMap } from '../../lib/presets.js';
export async function handleVaultFetchRequest(request, env, kv) {
const auth = await checkVaultAuth(request, env, kv);
if (!auth.ok) return auth.response;
let body = {};
try {
body = await request.json();
} catch (_) {
return new Response(
JSON.stringify({ ok: false, error: 'invalid_json_body' }),
{ status: 400, headers: { 'content-type': 'application/json' } }
);
}
const { provider, key_label, keys } = body;
if (!provider) {
return new Response(
JSON.stringify({ ok: false, error: 'provider_required' }),
{ status: 400, headers: { 'content-type': 'application/json' } }
);
}
if (!auth.isAdmin) {
const scopeProvs = auth.node?.scope?.providers || ['*'];
if (!scopeProvs.includes('*') && !scopeProvs.includes(provider)) {
return new Response(
JSON.stringify({ ok: false, error: 'provider_out_of_node_scope' }),
{ status: 403, headers: { 'content-type': 'application/json' } }
);
}
}
const config = await loadConfig(kv);
const pData = config.providers?.[provider];
if (!pData || pData.origin === 'local' || pData.is_local) {
return new Response(
JSON.stringify({ ok: false, error: 'provider_not_found_or_local' }),
{ status: 404, headers: { 'content-type': 'application/json' } }
);
}
const targetLabels = new Set(
Array.isArray(keys) ? keys : (key_label ? [key_label] : [])
);
const matchedKeys = {};
for (const k of pData.api_keys || []) {
if (!k || !k.enabled || k.origin === 'local' || k.is_local) continue;
const lbl = k.label || k.id;
if (targetLabels.size === 0 || targetLabels.has(lbl)) {
matchedKeys[lbl] = k.key;
}
}
const presetsMap = getPresetMap();
let rules = pData.adapter_rules;
if (!rules && pData.preset_id && presetsMap[pData.preset_id]?.adapter_rules) {
rules = presetsMap[pData.preset_id].adapter_rules;
}
return new Response(
JSON.stringify({
ok: true,
provider,
provider_config: {
name: pData.name || provider,
preset_id: pData.preset_id || '',
base_url: pData.base_url || '',
anthropic_base_url: pData.anthropic_base_url || '',
hide_client_name: Boolean(pData.hide_client_name),
adapter_rules: rules || {},
keys: matchedKeys,
},
}),
{ status: 200, headers: { 'content-type': 'application/json' } }
);
}
export async function onRequest(context) {
const kv = resolveKvBinding(context);
const env = resolveEnv(context);
return handleVaultFetchRequest(context.request, env, kv);
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
return handleVaultFetchRequest(request, resolvedEnv, kv);
},
};