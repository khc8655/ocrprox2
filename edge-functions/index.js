/**
 * GET / -> /admin (EdgeOne Hub Console).
 */
export function onRequestGet(context) {
  const url = new URL(context.request.url);
  url.pathname = '/admin';
  return new Response(null, {
    status: 302,
    headers: {
      location: url.pathname + url.search,
      'cache-control': 'no-store',
    },
  });
}

export function onRequestHead(context) {
  return onRequestGet(context);
}

export function onRequest(context) {
  return onRequestGet(context);
}

export default {
  async fetch(request, env, context) {
    return onRequestGet({ request, env, ...context });
  },
};
