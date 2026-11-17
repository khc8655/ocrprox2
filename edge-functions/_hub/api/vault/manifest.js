import { loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { checkVaultAuth } from '../../lib/vaultauth.js';
import { getPresetMap } from '../../lib/presets.js';
import { touchNodeLastSeen } from '../../lib/nodes.js';
export async function handleVaultManifestRequest(request, env, kv) {
const auth = await checkVaultAuth(request, env, kv);
if (!auth.ok) return auth.response;
const config = await loadConfig(kv);
const presetsMap = getPresetMap();
if (!auth.isAdmin && auth.node) {
const clientIp =
(request.headers.get('eo-connecting-ip') ||
request.headers.get('cf-connecting-ip') ||
request.headers.get('x-forwarded-for') ||
'')
.split(',')[0]
.trim() || null;
let usageDigest = null;
const usageHeader = request.headers.get('x-node-usage');
if (usageHeader && usageHeader.length < 8192) {
try {
usageDigest = JSON.parse(usageHeader);
} catch (_) {}
}
try {
await touchNodeLastSeen(auth.node.id, kv, config._version || 1, {
ip: clientIp,
binaryVersion: (request.headers.get('x-node-version') || '').trim(),
usage: usageDigest,
});
} catch (_) {}
}
const scopeProvs = !auth.isAdmin ? (auth.node?.scope?.providers || ['*']) : ['*'];
const allowAllProvs = auth.isAdmin || scopeProvs.includes('*');
const manifest = {};
for (const [pId, pData] of Object.entries(config.providers || {})) {
if (!pData || pData.origin === 'local' || pData.is_local) continue;
if (!allowAllProvs && !scopeProvs.includes(pId)) continue;
const exportableKeys = (pData.api_keys || [])
.filter((k) => k && k.enabled && k.origin !== 'local' && !k.is_local)
.map((k) => k.label || k.id);
if (exportableKeys.length === 0) continue;
let rules = pData.adapter_rules;
if (!rules && pData.preset_id && presetsMap[pData.preset_id]?.adapter_rules) {
rules = presetsMap[pData.preset_id].adapter_rules;
}
manifest[pId] = {
name: pData.name || pId,
preset_id: pData.preset_id || '',
base_url: pData.base_url || '',
anthropic_base_url: pData.anthropic_base_url || '',
keys: exportableKeys,
rule_hash: pData.rule_hash || '',
adapter_rules: rules || {},
};
}
return new Response(
JSON.stringify({
ok: true,
_version: config._version || 1,
providers: manifest,
}),
{ status: 200, headers: { 'content-type': 'application/json' } }
);
}
export async function onRequest(context) {
const kv = resolveKvBinding(context);
const env = resolveEnv(context);
return handleVaultManifestRequest(context.request, env, kv);
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
return handleVaultManifestRequest(request, resolvedEnv, kv);
},
};