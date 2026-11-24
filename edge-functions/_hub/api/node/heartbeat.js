import { loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { findNodeByToken, touchNodeHeartbeat } from '../../lib/nodes.js';
export async function handleHeartbeatRequest(request, env, kv) {
const method = (request && request.method ? request.method : 'GET').toUpperCase();
if (method !== 'POST') {
return new Response(
JSON.stringify({ ok: false, error: 'method_not_allowed' }),
{ status: 405, headers: { 'content-type': 'application/json' } }
);
}
const authHeader = request.headers.get('authorization') || '';
const match = authHeader.match(/^Bearer\s+(stk_node_[a-f0-9]+)$/i);
if (!match) {
return new Response(
JSON.stringify({ ok: false, error: 'node_revoked_or_invalid' }),
{ status: 401, headers: { 'content-type': 'application/json' } }
);
}
const node = await findNodeByToken(match[1], kv);
if (!node || node.enabled === false) {
return new Response(
JSON.stringify({ ok: false, error: 'node_revoked_or_invalid' }),
{ status: 401, headers: { 'content-type': 'application/json' } }
);
}
const clientIp =
(request.headers.get('eo-connecting-ip') ||
request.headers.get('cf-connecting-ip') ||
request.headers.get('x-forwarded-for') ||
'')
.split(',')[0]
.trim() || null;
try {
await touchNodeHeartbeat(node, kv, {
ip: clientIp,
binaryVersion: (request.headers.get('x-node-version') || '').trim(),
});
} catch (_) {}
let configVersion = 0;
try {
const config = await loadConfig(kv);
configVersion = Number(config && config._version) || 0;
} catch (_) {}
return new Response(
JSON.stringify({ ok: true, config_version: configVersion }),
{ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
);
}
export async function onRequest(context) {
const kv = resolveKvBinding(context);
const env = resolveEnv(context);
return handleHeartbeatRequest(context.request, env, kv);
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
return handleHeartbeatRequest(request, resolvedEnv, kv);
},
};