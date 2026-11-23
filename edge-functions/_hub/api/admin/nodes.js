import { checkAdminAuth, loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import {
listNodes,
loadNodes,
issueNode,
patchNode,
rotateNodeToken,
reissueNodeToken,
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
const isInstallCommand =
method === 'GET' &&
((nodesIdx >= 0 && pathParts.length === nodesIdx + 3 && pathParts[nodesIdx + 2] === 'install-command') ||
(params && params.action === 'install-command'));
const isCredentials =
method === 'GET' &&
((nodesIdx >= 0 && pathParts.length === nodesIdx + 3 && pathParts[nodesIdx + 2] === 'credentials') ||
(params && params.action === 'credentials'));
const hubUrl = `${url.protocol}//${url.host}`;
if (method === 'GET' && !targetId) {
const nodes = await listNodes(kv);
return new Response(
JSON.stringify({ ok: true, nodes }),
{ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
);
}
if (isCredentials && targetId) {
const nodes = await loadNodes(kv);
const node = nodes.find((n) => n.id === targetId);
if (!node) {
return new Response(
JSON.stringify({ ok: false, error: 'node_not_found' }),
{ status: 404, headers: { 'content-type': 'application/json' } }
);
}
const cfg = await loadConfig(kv);
const clientKey = cfg?.settings?.client_key || cfg?.settings?.proxy_api_key || '';
const adminPassword = node.role === 'full' ? String(node.admin_password || '') : '';
const payload = {
ok: true,
id: node.id,
role: node.role,
admin_password: adminPassword || null,
client_key: clientKey || null,
};
if (node.role !== 'full') {
payload.admin_password_note = 'lite 节点无后台密码（Lite 部署没有管理控制台）';
} else if (!adminPassword) {
payload.admin_password_note =
'该节点签发于未存储后台密码的旧版本；重新获取安装命令（将轮换 Token）时会生成新密码并保存';
}
if (!clientKey) {
payload.client_key_note =
'Hub 未配置主客户端密钥（settings.client_key）；节点安装时使用的是一次性随机密钥，未在 Hub 存储，请在系统设置配置后重新获取安装命令';
}
return new Response(
JSON.stringify(payload),
{ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
);
}
if (isInstallCommand && targetId) {
const cfg = await loadConfig(kv);
const clientKey = cfg?.settings?.client_key || cfg?.settings?.proxy_api_key || '';
const res = await reissueNodeToken(targetId, kv, hubUrl, clientKey);
if (!res) {
return new Response(
JSON.stringify({ ok: false, error: 'node_not_found' }),
{ status: 404, headers: { 'content-type': 'application/json' } }
);
}
return new Response(
JSON.stringify({
ok: true,
node: res.node,
node_token: res.node_token,
client_key: res.client_key,
admin_password: res.admin_password,
bootstrap_env: res.bootstrap_env,
install_command: res.install_command,
}),
{ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
);
}
if (method === 'POST' && !targetId) {
let body = {};
try {
body = await request.json();
} catch (_) {}
try {
const cfg = await loadConfig(kv);
const clientKey = cfg?.settings?.client_key || cfg?.settings?.proxy_api_key || '';
const res = await issueNode(body, kv, hubUrl, clientKey);
return new Response(
JSON.stringify({
ok: true,
node: res.node,
node_token: res.node_token,
client_key: res.client_key,
admin_password: res.admin_password,
bootstrap_env: res.bootstrap_env,
install_command: res.install_command,
}),
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
if (method === 'POST' && targetId && isRotate) {
const cfg = await loadConfig(kv);
const clientKey = cfg?.settings?.client_key || cfg?.settings?.proxy_api_key || '';
const res = await rotateNodeToken(targetId, kv, hubUrl, clientKey);
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
client_key: res.client_key,
admin_password: res.admin_password,
bootstrap_env: res.bootstrap_env,
install_command: res.install_command,
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