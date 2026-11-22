import { loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { checkVaultAuth } from '../../lib/vaultauth.js';
import { getPresetMap } from '../../lib/presets.js';
import { touchNodeLastSeen } from '../../lib/nodes.js';
import { ruleHash } from '../../lib/rulehash.js';
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
const scopeModels = !auth.isAdmin ? (auth.node?.scope?.models || ['*']) : ['*'];
const allowAllModels = auth.isAdmin || scopeModels.includes('*');
const manifest = {};
for (const [pId, pData] of Object.entries(config.providers || {})) {
if (!pData || pData.origin === 'local' || pData.is_local) continue;
if (!allowAllProvs && !scopeProvs.includes(pId)) continue;
const exportableKeys = (pData.api_keys || [])
.filter((k) => k && k.enabled && k.origin !== 'local' && !k.is_local && k.key)
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
rule_hash: ruleHash(rules || {}),
adapter_rules: rules || {},
rpm_per_key: Number(pData.rpm_per_key) || 0,
};
}
const agentModels = {};
for (const [mName, mRoute] of Object.entries(config.agent_models || {})) {
if (!mRoute || !mRoute.enabled) continue;
if (!allowAllModels && !scopeModels.includes(mName)) continue;
const candidates = (mRoute.candidates || [])
.filter((c) => c && c.enabled && Boolean(manifest[c.provider]))
.map((c) => ({
provider: c.provider,
key_label: c.key_label || '',
target_model: c.target_model || '',
enabled: true,
weight: Number(c.weight) || 0,
max_concurrency: Number(c.max_concurrency) || 0,
}));
if (candidates.length === 0) continue;
agentModels[mName] = {
routing_strategy: mRoute.routing_strategy || '',
active_key: mRoute.active_key || '',
no_reasoning: Boolean(mRoute.no_reasoning),
force_non_stream: Boolean(mRoute.force_non_stream),
allow_key_fallback: Boolean(mRoute.allow_key_fallback),
candidates,
};
}
return new Response(
JSON.stringify({
ok: true,
_version: config._version || 1,
providers: manifest,
agent_models: agentModels,
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