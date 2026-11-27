import { onRequest as h } from '../../_hub/api/admin/test-key.js';
export async function onRequest(c){return h(c)}
export async function onRequestGet(c){return h(c)}
export async function onRequestPost(c){return h(c)}
export async function onRequestPut(c){return h(c)}
export async function onRequestPatch(c){return h(c)}
export async function onRequestDelete(c){return h(c)}
export async function onRequestOptions(){return new Response(null,{status:204})}
