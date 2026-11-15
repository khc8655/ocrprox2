export function projectConfigForNode(node, config, presetsMap = {}) {
const scopeProviders = node.scope?.providers || ['*'];
const scopeModels = node.scope?.models || ['*'];
const allowAllProviders = scopeProviders.includes('*');
const allowAllModels = scopeModels.includes('*');
const projectedProviders = {};
const projectedAdapterRules = {};
const sourceProviders = config.providers || {};
for (const [pId, pData] of Object.entries(sourceProviders)) {
if (!pData) continue;
if (pData.origin === 'local') {
continue;
}
if (!allowAllProviders && !scopeProviders.includes(pId)) {
continue;
}
const rawKeys = Array.isArray(pData.api_keys) ? pData.api_keys : [];
const validKeys = rawKeys.filter((k) => {
if (!k || !k.enabled) return false;
if (k.origin === 'local') return false;
if (!k.key) return false;
return true;
});
if (validKeys.length === 0) {
continue;
}
projectedProviders[pId] = {
id: pData.id || pId,
name: pData.name || pId,
preset_id: pData.preset_id || '',
base_url: pData.base_url || '',
anthropic_base_url: pData.anthropic_base_url || '',
enabled: Boolean(pData.enabled),
origin: 'vault',
rule_hash: pData.rule_hash || '',
api_keys: validKeys.map((k) => ({
id: k.id || k.label,
label: k.label,
key: k.key,
enabled: true,
origin: 'vault',
auth_type: k.auth_type || 'api_key',
})),
model_aliases: pData.model_aliases || {},
};
if (pData.adapter_rules && Object.keys(pData.adapter_rules).length > 0) {
projectedAdapterRules[pId] = pData.adapter_rules;
} else if (pData.preset_id && presetsMap[pData.preset_id]?.adapter_rules) {
projectedAdapterRules[pId] = presetsMap[pData.preset_id].adapter_rules;
}
}
const projectedModels = {};
const sourceModels = config.agent_models || {};
for (const [mName, mRoute] of Object.entries(sourceModels)) {
if (!mRoute || !mRoute.enabled) continue;
if (!allowAllModels && !scopeModels.includes(mName)) {
continue;
}
const validCandidates = (mRoute.candidates || []).filter((c) => {
if (!c || !c.enabled) return false;
return Boolean(projectedProviders[c.provider]);
});
if (validCandidates.length > 0) {
projectedModels[mName] = {
enabled: true,
active_key: mRoute.active_key || '',
routing_strategy: mRoute.routing_strategy || '',
candidates: validCandidates,
};
}
}
const projectedSearchProviders = projectSearchProviders(node, config);
const srcSel = config.search_selection || {};
const projectedSearchSelection = {
search: Array.isArray(srcSel.search)
? srcSel.search.filter((id) => Boolean(projectedSearchProviders[id]))
: [],
fetch:
srcSel.fetch &&
projectedSearchProviders[srcSel.fetch] &&
Array.isArray(projectedSearchProviders[srcSel.fetch].capabilities) &&
projectedSearchProviders[srcSel.fetch].capabilities.includes('fetch')
? srcSel.fetch
: '',
};
return {
providers: projectedProviders,
agent_models: projectedModels,
settings: config.settings || {},
adapter_rules: projectedAdapterRules,
search_providers: projectedSearchProviders,
search_selection: projectedSearchSelection,
};
}
function projectSearchProviders(node, config) {
const scopeSearch = Array.isArray(node.scope?.search_providers)
? node.scope.search_providers
: ['*'];
const allowAllSearch = scopeSearch.includes('*');
const projected = {};
const source = config.search_providers || {};
for (const [spId, sp] of Object.entries(source)) {
if (!sp || sp.enabled === false) continue;
if (sp.origin === 'local') continue;
if (!allowAllSearch && !scopeSearch.includes(spId)) continue;
const rawKeys = Array.isArray(sp.api_keys) ? sp.api_keys : [];
const validKeys = rawKeys.filter((k) => {
if (!k || k.enabled === false) return false;
if (k.origin === 'local') return false;
if (!k.key) return false;
return true;
});
if (validKeys.length === 0) continue;
const entry = {
id: sp.id || spId,
name: sp.name || spId,
enabled: true,
origin: 'vault',
base_url: sp.base_url || '',
capabilities: Array.isArray(sp.capabilities) ? [...sp.capabilities] : ['search'],
timeout_ms: Number(sp.timeout_ms) || 10000,
api_keys: validKeys.map((k) => ({
id: k.id || k.label,
label: k.label,
key: k.key,
enabled: true,
origin: 'vault',
})),
};
if (sp.adapter) entry.adapter = sp.adapter;
if (sp.quirks && typeof sp.quirks === 'object') entry.quirks = sp.quirks;
if (sp.request && typeof sp.request === 'object') entry.request = sp.request;
if (sp.response && typeof sp.response === 'object') entry.response = sp.response;
if (sp.fetch && typeof sp.fetch === 'object') entry.fetch = sp.fetch;
projected[spId] = entry;
}
return projected;
}