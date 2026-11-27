import { checkAdminAuth } from '../../lib/config.js';
export async function onRequest(context) {
const { request } = context;
const env = context.env || {};
const authErr = checkAdminAuth(request, context);
if (authErr) return authErr;
const origin = new URL(request.url).origin;
const target = origin + '/version.json';
const started = Date.now();
try {
const res = await fetch(target, { headers: { 'cache-control': 'no-store' } });
const body = await res.text();
return new Response(JSON.stringify({
ok: true, target, status: res.status, bytes: body.length,
contentType: res.headers.get('content-type') || '',
ms: Date.now() - started, preview: body.slice(0, 60),
}), { status: 200, headers: { 'content-type': 'application/json' } });
} catch (e) {
return new Response(JSON.stringify({
ok: false, target, ms: Date.now() - started, error: String(e && e.message || e),
}), { status: 200, headers: { 'content-type': 'application/json' } });
}
}