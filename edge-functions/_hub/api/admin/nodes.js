import { checkAdminAuth, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import {
listNodes,
issueNode,
patchNode,
rotateNodeToken,
deleteNode,
} from '../../lib/nodes.js';
export async function handleNodesRequest(request, env, kv, params) {
const authErr = checkAdminAuth(request, env);
if (authErr) return authErr;
const url = new URL(request.url);
const method = request.method.toUpperCase();
const pathParts = url.pathname.split('/').filter(Boolean);
const nodesIdx = pathParts.indexOf('nodes');
const pathTargetId = nodesIdx >= 0 && pathParts.length > nodesIdx + 1 ? pathParts[nodesIdx + 1] : null;
const targetId = (params && params.id) || pathTargetId;
const isRotate =
(nodesIdx >= 0 && pathParts.length > nodesIdx + 2 && pathParts[nodesIdx + 2] === 'rotate') ||
(params && params.action === 'rotate') ||
url.pathname.endsWith('/rotate');
const hubUrl = `${url.protocol}//${url.host}`;
if (method === 'GET' && !targetId) {
const nodes = await listNodes(kv);
return new Response(
JSON.stringify({ ok: true, nodes }),
{ status: 200, headers: { 'content-type': 'application/json' } }
);
}
if (method === 'POST' && !targetId) {
let body = {};
try {
body = await request.json();
} catch (_) {}
const res = await issueNode(body, kv, hubUrl);
return new Response(
JSON.stringify({
ok: true,
node: res.node,
node_token: res.node_token,
bootstrap_env: res.bootstrap_env,
}),
{ status: 200, headers: { 'content-type': 'application/json' } }
);
}
if (method === 'POST' && targetId && isRotate) {
const res = await rotateNodeToken(targetId, kv, hubUrl);
if (!res) {
return new Response(
JSON.stringify({ ok: false, error: 'node_not_found' }),
{ status: 404, headers: { 'content-type': 'application/json' } }
);
}
return new Response(
JSON.stringify({
ok: true,
node_token: res.node_token,
bootstrap_env: res.bootstrap_env,
}),
{ status: 200, headers: { 'content-type': 'application/json' } }
);
}
if (method === 'PATCH' && targetId) {
let body = {};
try {
body = await request.json();
} catch (_) {}
try {
const updated = await patchNode(targetId, body, kv);
if (!updated) {
return new Response(
JSON.stringify({ ok: false, error: 'node_not_found' }),
{ status: 404, headers: { 'content-type': 'application/json' } }
);
}
return new Response(
JSON.stringify({ ok: true, node: updated }),
{ status: 200, headers: { 'content-type': 'application/json' } }
);
} catch (err) {
if (err?.status === 400) {
return new Response(
JSON.stringify({ ok: false, error: err.message }),
{ status: 400, headers: { 'content-type': 'application/json' } }
);
}
throw err;
}
}
if (method === 'DELETE' && targetId) {
const ok = await deleteNode(targetId, kv);
if (!ok) {
return new Response(
JSON.stringify({ ok: false, error: 'node_not_found' }),
{ status: 404, headers: { 'content-type': 'application/json' } }
);
}
return new Response(
JSON.stringify({ ok: true }),
{ status: 200, headers: { 'content-type': 'application/json' } }
);
}
return new Response(
JSON.stringify({ ok: false, error: 'not_found' }),
{ status: 404, headers: { 'content-type': 'application/json' } }
);
}
export async function onRequest(context) {
const kv = resolveKvBinding(context);
const env = resolveEnv(context);
return handleNodesRequest(context.request, env, kv, context.params);
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
return handleNodesRequest(request, resolvedEnv, kv, context?.params);
},
};