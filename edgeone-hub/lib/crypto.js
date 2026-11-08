import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Generate a node token formatted as stk_node_<48hex> (24 random bytes).
 */
export function generateNodeToken() {
  const bytes = randomBytes(24);
  return `stk_node_${bytes.toString('hex')}`;
}

/**
 * Compute SHA-256 hash of a string.
 */
export function hashToken(token) {
  if (!token) return '';
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Compute ETag for arbitrary data.
 */
export function computeEtag(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  const hash = createHash('sha256').update(str).digest('hex').slice(0, 16);
  return `"${hash}"`;
}
