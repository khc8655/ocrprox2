import { onRequest as _onRequest } from '../../_hub/api/node/config.js';

export async function onRequest(context) { return _onRequest(context); }
export async function onRequestGet(context) { return _onRequest(context); }
export async function onRequestPost(context) { return _onRequest(context); }
export async function onRequestPut(context) { return _onRequest(context); }
export async function onRequestPatch(context) { return _onRequest(context); }
export async function onRequestDelete(context) { return _onRequest(context); }
export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
