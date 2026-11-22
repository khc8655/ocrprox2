/**
 * Stable content hash for hub-managed adapter rules.
 *
 * Both /api/vault/manifest and /api/vault/fetch stamp the resolved adapter_rules of a
 * provider with the same ruleHash() value, so a Full node can detect drift: it stores
 * the hash it fetched, and the manifest keeps publishing the current hash. When the hub
 * operator changes a provider's rules (or its preset fallback), the two hashes diverge
 * and the node console shows the「中枢规则已更新」banner until the operator re-fetches.
 *
 * FNV-1a 32-bit over the canonical JSON string: deterministic across engines and runs,
 * no crypto dependency (this is a change detector, not a security boundary).
 */
export function ruleHash(rules) {
  const json = JSON.stringify(rules || {});
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
