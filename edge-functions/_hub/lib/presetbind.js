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
export function matchPresetForProvider(prov, presetsMap) {
if (!prov || typeof prov !== 'object' || !presetsMap || typeof presetsMap !== 'object') return '';
if (String(prov.preset_id || '').trim().toLowerCase() === EXPLICIT_CUSTOM) return '';
const currentId = String(prov.preset_id || '').trim();
if (currentId && presetsMap[currentId]) return currentId;
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
matched = pickFromHostCandidates(hostCandidates, provIdLc, provNameLc);
}
}
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
export function presetBindingFor(prov, presetsMap) {
const presetId = String(prov?.preset_id || '').trim();
const preset = presetId ? presetsMap?.[presetId] : undefined;
return {
preset_id: presetId,
preset_version: preset ? String(preset.version || '') : '',
};
}
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