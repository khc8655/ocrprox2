import { checkAdminAuth } from './config.js';
import { findNodeByToken } from './nodes.js';

/**
 * Vault endpoints accept either the Hub admin credential (console / manual sync)
 * or a valid, enabled Full node token (a full node syncing its own vault increment).
 * Lite node tokens are rejected with 403 because Lite nodes only use /api/node/config.
 */
export async function authenticateVaultCaller(request, env, kv) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();

  if (token.startsWith('stk_node_')) {
    try {
      const node = await findNodeByToken(token, kv);
      if (!node || node.enabled === false) {
        return {
          ok: false,
          response: new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized: invalid or disabled node credentials' }),
            { status: 401, headers: { 'content-type': 'application/json' } }
          ),
        };
      }
      if (node.role !== 'full') {
        return {
          ok: false,
          response: new Response(
            JSON.stringify({ ok: false, error: 'Forbidden: lite node tokens cannot access vault endpoints' }),
            { status: 403, headers: { 'content-type': 'application/json' } }
          ),
        };
      }
      return { ok: true, isAdmin: false, node };
    } catch (_) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ ok: false, error: 'Unauthorized: invalid node credentials' }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        ),
      };
    }
  }

  const adminErr = checkAdminAuth(request, env);
  if (!adminErr) {
    return { ok: true, isAdmin: true, node: null };
  }
  if (adminErr.status === 503) {
    return { ok: false, response: adminErr };
  }

  return {
    ok: false,
    response: new Response(
      JSON.stringify({ ok: false, error: 'Unauthorized: invalid admin or node credentials' }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    ),
  };
}

export const checkVaultAuth = authenticateVaultCaller;
