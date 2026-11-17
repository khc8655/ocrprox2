import { checkAdminAuth } from './config.js';
import { findNodeByToken } from './nodes.js';
export async function checkVaultAuth(request, env, kv) {
const adminErr = checkAdminAuth(request, env);
if (!adminErr) return null;
const header = request.headers.get('authorization') || '';
const token = header.replace(/^Bearer\s+/i, '').trim();
if (token.startsWith('stk_node_')) {
try {
const node = await findNodeByToken(token, kv);
if (node && node.enabled) return null;
} catch (_) {
}
}
return new Response(
JSON.stringify({ ok: false, error: 'Unauthorized: invalid admin or node credentials' }),
{ status: 401, headers: { 'content-type': 'application/json' } }
);
}