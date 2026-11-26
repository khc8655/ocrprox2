/**
 * Preset auto-match (rule A of the cross-runtime preset-binding contract).
 *
 * The SAME order and the SAME inputs are implemented in three places and must
 * stay in lockstep: this module (EdgeOne Hub JS), shared/admin/js/app.js (the
 * console) and the Go node. Any change here is a contract change — update all
 * three or say so in the contract notes.
 *
 * Inputs: a provider's id, name, base_url and the preset library
 * (shared/presets/*.json, each entry with id / name / base_url / version).
 *
 * Order:
 *   1) preset_id === "custom"            -> the operator explicitly chose not
 *                                           to bind; stay unbound.
 *   2) existing preset_id that exists in
 *      the library                       -> keep it.
 *   3) lowercase hostname of base_url equals a preset's base_url hostname
 *      (presets whose base_url contains a "{" placeholder are skipped — this
 *      exclusion applies to the host step only). When several presets share
 *      the host, steps 4)/5) pick among those and ONLY among those; if none
 *      of them wins, stay unbound.
 *   4) provider id (lowercase) equals a preset id (whole library).
 *   5) provider name (lowercase, trimmed) equals a preset name (lowercase) or
 *      a preset id (whole library).
 *   6) nothing matched                   -> unbound (the UI shows「自定义」).
 *
 * Steps 4)/5) run over the whole library only when the host step found no
 * candidate at all (unresolvable same-host ties stop at "unbound" per the
 * contract). Placeholder presets like vertex can therefore still be bound via
 * id/name — their base_url template just never wins a host match.
 */

const PLACEHOLDER_MARKER = '{';
const EXPLICIT_CUSTOM = 'custom';

function normalizeHostname(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    return new URL(rawUrl.trim()).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function isPlaceholderBaseUrl(baseUrl) {
  return typeof baseUrl === 'string' && baseUrl.includes(PLACEHOLDER_MARKER);
}

/**
 * Picks one preset out of the candidates that share the provider's host, by
 * rule 4 (provider id === preset id) then rule 5 (provider name === preset
 * name or preset id). Returns undefined when none of them matches, or when
 * rule 5 would match more than one — an ambiguous tie is "挑不出", not a
 * coin flip on library iteration order.
 *
 * Preset ids are unique, so rule 4 can hit at most one candidate.
 */
function pickFromHostCandidates(candidates, provIdLc, provNameLc) {
  if (provIdLc) {
    for (const p of candidates) {
      if (String(p?.id || '').toLowerCase() === provIdLc) return p;
    }
  }
  if (!provNameLc) return undefined;
  const hits = candidates.filter((p) => {
    const nameLc = String(p?.name || '').toLowerCase();
    return nameLc && (nameLc === provNameLc || String(p?.id || '').toLowerCase() === provNameLc);
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Rule A. Pure function, exported for the hub's load/save paths and tests.
 *
 * @param {object} prov    provider fields: id, name, base_url, preset_id
 * @param {object} presetsMap  preset library keyed by preset id; each value
 *        needs { id, name, base_url } (version is not used for matching)
 * @returns {string} preset id to bind ('' = keep unbound)
 */
export function matchPresetForProvider(prov, presetsMap) {
  if (!prov || typeof prov !== 'object' || !presetsMap || typeof presetsMap !== 'object') return '';

  // 1) Explicit "custom" — the operator said no binding.
  if (String(prov.preset_id || '').trim().toLowerCase() === EXPLICIT_CUSTOM) return '';

  // 2) An existing preset_id that still exists in the library wins.
  const currentId = String(prov.preset_id || '').trim();
  if (currentId && presetsMap[currentId]) return currentId;

  // 3) Hostname match. Presets with a "{" placeholder in base_url are skipped
  // (the exclusion is scoped to this step). A single hit wins; several hits
  // are resolved by rules 4/5 among those candidates ONLY — an unresolved tie
  // stays unbound, it does not fall through to the global steps.
  const provIdLc = String(prov.id || '').trim().toLowerCase();
  const provNameLc = String(prov.name || '').trim().toLowerCase();
  let matched;
  let hostCandidates = [];
  const provHost = normalizeHostname(prov.base_url);
  if (provHost) {
    for (const p of Object.values(presetsMap)) {
      if (!p || isPlaceholderBaseUrl(p.base_url)) continue;
      if (normalizeHostname(p.base_url) === provHost) hostCandidates.push(p);
    }
    if (hostCandidates.length === 1) {
      matched = hostCandidates[0];
    } else if (hostCandidates.length > 1) {
      // Same host hit several presets (e.g. minimax vs minimax-cn).
      matched = pickFromHostCandidates(hostCandidates, provIdLc, provNameLc);
    }
  }

  // 4)/5) Only when the host step produced no candidate at all: match over the
  // whole library by id, then by name (preset name or preset id).
  if (!matched && hostCandidates.length === 0) {
    if (provIdLc) {
      for (const p of Object.values(presetsMap)) {
        if (p && String(p.id || '').toLowerCase() === provIdLc) {
          matched = p;
          break;
        }
      }
    }
  }
  if (!matched && hostCandidates.length === 0 && provNameLc) {
    // Rule 5 over the whole library. Two presets can share a name in principle;
    // like the host tie, an ambiguous match is left unbound rather than picked
    // by iteration order.
    const hits = [];
    for (const p of Object.values(presetsMap)) {
      const nameLc = String(p?.name || '').toLowerCase();
      if (nameLc && (nameLc === provNameLc || String(p?.id || '').toLowerCase() === provNameLc)) hits.push(p);
      if (hits.length > 1) break;
    }
    if (hits.length === 1) matched = hits[0];
  }

  return matched ? String(matched.id || '') : '';
}

/**
 * Reads out a provider's preset binding with the version the current library
 * carries. Unbound providers get empty strings, so callers can serialize the
 * fields verbatim.
 */
export function presetBindingFor(prov, presetsMap) {
  const presetId = String(prov?.preset_id || '').trim();
  const preset = presetId ? presetsMap?.[presetId] : undefined;
  return {
    preset_id: presetId,
    preset_version: preset ? String(preset.version || '') : '',
  };
}

/**
 * Resolves the adapter rules a provider is governed by.
 *
 * Contract B: a provider with no custom adapter_rules always runs the CURRENT
 * rules of its preset — the library is the source of truth, so deploying a new
 * preset version on the hub takes effect on the next projection, without the
 * operator touching the provider.
 *
 * "No custom rules" means absent OR an empty object: an empty `{}` carries no
 * rules, and the projection already treated it that way. All three call sites
 * (projection, vault manifest, vault fetch) share this one resolver so they can
 * never disagree about which rules a provider actually runs.
 *
 * @returns {{ rules: object, fromPreset: boolean }}
 */
export function resolveAdapterRules(prov, presetsMap) {
  const custom = prov?.adapter_rules;
  if (custom && typeof custom === 'object' && Object.keys(custom).length > 0) {
    return { rules: custom, fromPreset: false };
  }
  const presetId = String(prov?.preset_id || '').trim();
  const presetRules = presetId ? presetsMap?.[presetId]?.adapter_rules : undefined;
  if (presetRules && typeof presetRules === 'object') {
    return { rules: presetRules, fromPreset: true };
  }
  return { rules: {}, fromPreset: false };
}
