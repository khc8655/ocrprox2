import { resolveKvBinding } from './_hub/lib/config.js';
import { VERSION, SEMVER, RELEASE_DATE } from './_hub/lib/generated-version.js';

export function handleHealthRequest(context) {
  const kv = resolveKvBinding(context);
  return new Response(
    JSON.stringify({
      status: 'ok',
      role: 'hub',
      kv_bound: Boolean(kv),
      version: VERSION,
      semver: SEMVER,
      release_date: RELEASE_DATE,
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    }
  );
}

export function onRequest(context) {
  return handleHealthRequest(context);
}

export function onRequestGet(context) {
  return handleHealthRequest(context);
}

export function onRequestHead(context) {
  return handleHealthRequest(context);
}

export default {
  async fetch(request, env, context) {
    return handleHealthRequest({ request, env, ...context });
  },
};
