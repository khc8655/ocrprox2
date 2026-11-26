import { presetBindingFor, resolveAdapterRules } from './presetbind.js';
const FIXED_KB_CHANNELS = ['chat', 'ocr', 'embedding', 'reranker'];
const FIXED_KB_SET = new Set(FIXED_KB_CHANNELS);
export function projectConfigForNode(node, config, presetsMap = {}) {
const isFullNode = node?.role === 'full';
const scopeProviders = node.scope?.providers || ['*'];
const scopeModels = node.scope?.models || ['*'];
const allowAllProviders = scopeProviders.includes('*');
const allowAllModels = scopeModels.includes('*');
const projectedProviders = {};
const projectedAdapterRules = {};
const sourceProviders = config.providers || {};
for (const [pId, pData] of Object.entries(sourceProviders)) {
if (!pData) continue;
if (pData.origin === 'local' || pData.is_local) {
continue;
}
if (!allowAllProviders && !scopeProviders.includes(pId)) {
continue;
}
const rawKeys = Array.isArray(pData.api_keys) ? pData.api_keys : [];
const validKeys = rawKeys.filter((k) => {
if (!k || !k.enabled) return false;
if (k.origin === 'local' || k.is_local) return false;
if (!k.key) return false;
return true;
});
if (validKeys.length === 0) {
continue;
}
const binding = presetBindingFor(pData, presetsMap);
const { rules: effectiveRules } = resolveAdapterRules(pData, presetsMap);
const projectedProvider = {
id: pData.id || pId,
name: pData.name || pId,
preset_id: binding.preset_id,
preset_version: binding.preset_version,
api_type: pData.api_type || '',
base_url: pData.base_url || '',
anthropic_base_url: pData.anthropic_base_url || '',
enabled: Boolean(pData.enabled),
origin: 'vault',
rule_hash: pData.rule_hash || '',
api_keys: validKeys.map((k) => {
const keyOut = {
id: k.id || k.label,
label: k.label,
key: k.key,
enabled: true,
origin: 'vault',
auth_type: k.auth_type || 'api_key',
};
if (k.weight) keyOut.weight = k.weight;
if (k.max_rpm) keyOut.max_rpm = k.max_rpm;
if (k.remark) keyOut.remark = k.remark;
return keyOut;
}),
model_aliases: pData.model_aliases || {},
};
if (pData.rpm_per_key) projectedProvider.rpm_per_key = pData.rpm_per_key;
if (pData.quota_reset_at) projectedProvider.quota_reset_at = pData.quota_reset_at;
if (pData.hide_client_name) projectedProvider.hide_client_name = true;
if (Object.keys(effectiveRules).length > 0) {
projectedProvider.adapter_rules = effectiveRules;
projectedAdapterRules[pId] = effectiveRules;
}
projectedProviders[pId] = projectedProvider;
}
const projectedModels = {};
const sourceModels = config.agent_models || {};
for (const [mName, mRoute] of Object.entries(sourceModels)) {
if (!mRoute || !mRoute.enabled) continue;
if (!isFullNode && FIXED_KB_SET.has(mName)) continue;
if (!allowAllModels && !scopeModels.includes(mName)) {
continue;
}
const validCandidates = (mRoute.candidates || []).filter((c) => {
if (!c || !c.enabled) return false;
return Boolean(projectedProviders[c.provider]);
});
if (validCandidates.length > 0) {
const projectedRoute = {
enabled: true,
active_key: mRoute.active_key || '',
routing_strategy: mRoute.routing_strategy || '',
candidates: validCandidates,
};
if (mRoute.no_reasoning) projectedRoute.no_reasoning = true;
if (mRoute.force_non_stream) projectedRoute.force_non_stream = true;
if (mRoute.allow_key_fallback) projectedRoute.allow_key_fallback = true;
projectedModels[mName] = projectedRoute;
}
}
const projectedSettings = { ...(config.settings || {}) };
delete projectedSettings.proxy_keys;
if (!isFullNode) {
delete projectedSettings.ocr_max_inflight;
delete projectedSettings.kb_global_max_concurrency;
}
const out = {
providers: projectedProviders,
agent_models: projectedModels,
settings: projectedSettings,
adapter_rules: projectedAdapterRules,
};
if (isFullNode) {
const projectedKbModels = {};
const sourceKb = config.kb_models || {};
for (const cat of FIXED_KB_CHANNELS) {
if (!allowAllModels && !scopeModels.includes(cat)) continue;
if (Array.isArray(sourceKb[cat]) && sourceKb[cat].length > 0) {
const validKb = sourceKb[cat]
.filter((c) => c && c.enabled !== false && Boolean(projectedProviders[c.provider]))
.map((c) => ({
provider: c.provider,
key_label: c.key_label || c.key || '',
model: c.model || c.target_model || '',
...(c.max_concurrency ? { max_concurrency: Number(c.max_concurrency) } : {}),
enabled: true,
}));
if (validKb.length > 0) projectedKbModels[cat] = validKb;
} else if (projectedModels[cat]?.candidates?.length > 0) {
projectedKbModels[cat] = projectedModels[cat].candidates.map((c) => ({
provider: c.provider,
key_label: c.key_label || '',
model: c.target_model || c.model || '',
...(c.max_concurrency ? { max_concurrency: Number(c.max_concurrency) } : {}),
enabled: true,
}));
}
}
out.kb_models = projectedKbModels;
}
return out;
}