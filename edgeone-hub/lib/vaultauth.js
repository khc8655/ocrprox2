import { checkAdminAuth } from './config.js';
import { findNodeByToken } from './nodes.js';

/**
 * Vault endpoints accept either the Hub admin credential (console / manual sync)
 * or a valid, enabled node token (a full node syncing its own vault increment).
 *
 * Node tokens are read-only and only ever expose origin="vault" providers, so a
 * node never needs the Hub admin password embedded in its own config.
 */
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
      // fall through to 401
    }
  }

  return new Response(
    JSON.stringify({ ok: false, error: 'Unauthorized: invalid admin or node credentials' }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
}
