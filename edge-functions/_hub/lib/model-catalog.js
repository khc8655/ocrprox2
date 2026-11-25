export const MODEL_CATALOG_KV_KEY = 'model_catalog';
const SCHEMA_VERSION = 1;
const SOURCE = 'models.dev';
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
export function utf8Bytes(text) {
return new TextEncoder().encode(String(text)).length;
}
async function kvGet(kv, key) {
if (!kv) return null;
if (typeof kv.get === 'function') return await kv.get(key);
if (typeof kv.getItem === 'function') return await kv.getItem(key);
return null;
}
async function kvPut(kv, key, value) {
if (!kv) throw new Error('KV 未绑定，无法写入模型目录');
if (typeof kv.put === 'function') return await kv.put(key, value);
if (typeof kv.setItem === 'function') return await kv.setItem(key, value);
throw new Error('KV 对象不支持 put/setItem，无法写入模型目录');
}
export async function readCatalogText(kv) {
const raw = await kvGet(kv, MODEL_CATALOG_KV_KEY);
if (raw === null || raw === undefined || raw === '') return null;
return typeof raw === 'string' ? raw : JSON.stringify(raw);
}
let parsedCatalog = { text: null, catalog: null };
export async function loadCatalog(kv) {
const text = await readCatalogText(kv);
if (!text) return null;
if (parsedCatalog.text === text) return parsedCatalog.catalog;
try {
const catalog = JSON.parse(text);
parsedCatalog = { text, catalog };
return catalog;
} catch (err) {
console.warn(`[model-catalog] KV 里的目录不是合法 JSON，按无目录处理：${(err && err.message) || err}`);
return null;
}
}
export async function saveCatalog(kv, text) {
if (typeof text !== 'string' || text.trim() === '') {
throw new Error('目录内容必须是非空 JSON 字符串');
}
let parsed;
try {
parsed = JSON.parse(text);
} catch (_) {
throw new Error('目录不是合法 JSON');
}
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
throw new Error('目录必须是 JSON 对象');
}
if (parsed.schema !== SCHEMA_VERSION) {
throw new Error(`目录 schema 必须是 ${SCHEMA_VERSION}（收到 ${JSON.stringify(parsed.schema)}）`);
}
if (!parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) {
throw new Error('目录缺少 providers 对象');
}
const bytes = utf8Bytes(text);
if (bytes > MAX_CATALOG_BYTES) {
throw new Error(`目录 ${bytes} B 超过 ${MAX_CATALOG_BYTES} B 单次写入上限`);
}
await kvPut(kv, MODEL_CATALOG_KV_KEY, text);
return bytes;
}
export async function meta(kv) {
const text = await readCatalogText(kv);
if (!text) return { present: false, fetched_at: '', model_count: 0, bytes: 0 };
const bytes = utf8Bytes(text);
try {
const catalog = JSON.parse(text);
return {
present: true,
fetched_at: String(catalog.fetched_at || ''),
model_count: Number(catalog.model_count) || 0,
bytes,
};
} catch (_) {
return { present: false, fetched_at: '', model_count: 0, bytes };
}
}
function nonEmptyString(s) {
return typeof s === 'string' && s.trim() !== '';
}
function slimModel(src) {
const m = src && typeof src === 'object' ? src : {};
const out = {};
const lim = m.limit;
if (lim && typeof lim === 'object' && !Array.isArray(lim)) {
const limit = {};
if (Number.isFinite(lim.context) && lim.context >= 0) limit.context = Math.floor(lim.context);
if (Number.isFinite(lim.output) && lim.output >= 0) limit.output = Math.floor(lim.output);
if (Object.keys(limit).length > 0) out.limit = limit;
}
if (typeof m.reasoning === 'boolean') out.reasoning = m.reasoning;
if (Array.isArray(m.reasoning_options) && m.reasoning_options.length > 0) {
const options = [];
for (const raw of m.reasoning_options) {
if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !nonEmptyString(raw.type)) continue;
const option = { type: raw.type };
if (Array.isArray(raw.values) && raw.values.length > 0) option.values = raw.values.slice();
if (Number.isFinite(raw.min)) option.min = Math.floor(raw.min);
if (Number.isFinite(raw.max)) option.max = Math.floor(raw.max);
options.push(option);
}
if (options.length > 0) out.reasoning_options = options;
}
if (nonEmptyString(m.family)) out.family = m.family;
if (nonEmptyString(m.release_date)) out.release_date = m.release_date;
return out;
}
export function slimModelsDev(raw, fetchedAt) {
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
throw new Error('models.dev 数据必须是按 provider id 索引的 JSON 对象');
}
const providers = {};
let modelCount = 0;
for (const providerId of Object.keys(raw).sort()) {
const source = raw[providerId] && typeof raw[providerId] === 'object' ? raw[providerId] : {};
const models = source.models && typeof source.models === 'object' ? source.models : {};
const modelIds = Object.keys(models).sort();
if (modelIds.length === 0) continue;
const outModels = {};
for (const modelId of modelIds) {
outModels[modelId] = slimModel(models[modelId]);
modelCount += 1;
}
providers[providerId] = outModels;
}
if (modelCount === 0) {
throw new Error('models.dev 数据里没有任何模型，拒绝写入空目录');
}
return {
schema: SCHEMA_VERSION,
source: SOURCE,
fetched_at: fetchedAt,
model_count: modelCount,
providers,
};
}
function optionList(info) {
return info && Array.isArray(info.reasoning_options) ? info.reasoning_options : [];
}
function effortValues(options) {
for (const o of options) {
if (o && o.type === 'effort' && Array.isArray(o.values) && o.values.length > 0) return o.values;
}
return null;
}
function asModelInfo(raw) {
const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
const lim = m.limit && typeof m.limit === 'object' ? m.limit : {};
return {
context_tokens: Number.isFinite(lim.context) ? lim.context : 0,
output_tokens: Number.isFinite(lim.output) ? lim.output : 0,
reasoning: m.reasoning === true,
options: optionList(m),
family: typeof m.family === 'string' ? m.family : '',
release_date: typeof m.release_date === 'string' ? m.release_date : '',
};
}
function mergeOverride(info, patch) {
if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return info;
const out = { ...info, options: info.options };
if (patch.limit && typeof patch.limit === 'object') {
if (Number.isFinite(patch.limit.context)) out.context_tokens = patch.limit.context;
if (Number.isFinite(patch.limit.output)) out.output_tokens = patch.limit.output;
}
if (typeof patch.reasoning === 'boolean') out.reasoning = patch.reasoning;
if (Array.isArray(patch.reasoning_options)) out.options = patch.reasoning_options;
if (typeof patch.family === 'string' && patch.family) out.family = patch.family;
if (typeof patch.release_date === 'string' && patch.release_date) out.release_date = patch.release_date;
return out;
}
function lookupModelsDev(catalog, providerMap, presetID, modelID) {
const candidates = Array.isArray(providerMap[presetID]) ? providerMap[presetID] : [];
if (candidates.length === 0) return null; // documented gap: not an error
const providers = catalog && catalog.providers && typeof catalog.providers === 'object' ? catalog.providers : {};
for (const prov of candidates) {
const models = providers[prov];
if (models && Object.prototype.hasOwnProperty.call(models, modelID)) {
return { info: asModelInfo(models[modelID]), providerID: prov };
}
}
const lower = modelID.toLowerCase();
for (const prov of candidates) {
const models = providers[prov];
if (!models) continue;
let bestID = '';
for (const id of Object.keys(models)) {
if (id.toLowerCase() !== lower) continue;
if (bestID === '' || id < bestID) bestID = id;
}
if (bestID !== '') return { info: asModelInfo(models[bestID]), providerID: prov };
}
return null;
}
function familyEfforts(catalog, providerID, info) {
if (!providerID || !info.family) return null;
const providers = catalog && catalog.providers && typeof catalog.providers === 'object' ? catalog.providers : {};
const models = providers[providerID];
if (!models) return null;
let best = null;
for (const id of Object.keys(models)) {
const sib = asModelInfo(models[id]);
if (sib.family !== info.family || sib.release_date > info.release_date) continue;
const vals = effortValues(sib.options);
if (!vals) continue;
if (!best || sib.release_date > best.date || (sib.release_date === best.date && id > best.id)) {
best = { id, date: sib.release_date, values: vals };
}
}
return best ? best.values : null;
}
export function lookupByModelID(catalog, modelID) {
const want = typeof modelID === 'string' ? modelID.trim() : '';
const out = {
found: false,
context_tokens: 0,
output_tokens: 0,
reasoning: false,
efforts: null,
toggle: false,
budget: null,
family: '',
release_date: '',
from_override: false,
matched_by: '',
modal_providers: 0,
listed_by: 0,
};
if (!want) return out;
const providers = catalog && typeof catalog === 'object' && catalog.providers && typeof catalog.providers === 'object'
? catalog.providers
: {};
const buckets = new Map();
let total = 0;
for (const pid of Object.keys(providers).sort()) {
const models = providers[pid];
if (!models || typeof models !== 'object') continue;
const ids = Object.keys(models);
const id = ids.find((candidate) => candidate.toLowerCase() === want.toLowerCase());
if (!id) continue;
const info = models[id];
if (!info || typeof info !== 'object') continue;
total += 1;
const efforts = effortValues(Array.isArray(info.reasoning_options) ? info.reasoning_options : []);
let toggle = false;
let budget = null;
for (const o of Array.isArray(info.reasoning_options) ? info.reasoning_options : []) {
if (!o) continue;
if (o.type === 'toggle') toggle = true;
if (o.type === 'budget_tokens') {
budget = { min: Number.isFinite(o.min) ? o.min : 0, max: Number.isFinite(o.max) ? o.max : 0 };
}
}
const spec = [
Number(info.limit && info.limit.context) || 0,
Number(info.limit && info.limit.output) || 0,
info.reasoning === true ? 1 : 0,
efforts ? efforts.join(',') : '',
toggle ? 1 : 0,
budget ? `${budget.min}-${budget.max}` : '',
].join('|');
const entry = buckets.get(spec) || {
count: 0,
ctx: Number(info.limit && info.limit.context) || 0,
out: Number(info.limit && info.limit.output) || 0,
effortLen: efforts ? efforts.length : 0,
efforts,
toggle,
budget,
info,
};
entry.count += 1;
buckets.set(spec, entry);
}
if (total === 0) return out;
const ordered = Array.from(buckets.values()).sort((a, b) => {
if (a.count !== b.count) return b.count - a.count;
if (a.ctx + a.out !== b.ctx + b.out) return (b.ctx + b.out) - (a.ctx + a.out);
if (a.effortLen !== b.effortLen) return b.effortLen - a.effortLen;
return String(a.efforts || '').localeCompare(String(b.efforts || ''));
});
const best = ordered[0];
out.found = true;
out.matched_by = 'model_id';
out.modal_providers = best.count;
out.listed_by = total;
out.context_tokens = best.ctx;
out.output_tokens = best.out;
out.reasoning = best.info.reasoning === true;
out.family = typeof best.info.family === 'string' ? best.info.family : '';
out.release_date = typeof best.info.release_date === 'string' ? best.info.release_date : '';
if (best.efforts) out.efforts = best.efforts.slice();
out.toggle = best.toggle;
out.budget = best.budget;
return out;
}
export function lookup(catalog, providerMap, overrides, presetID, modelID) {
const preset = typeof presetID === 'string' ? presetID.trim() : '';
const model = typeof modelID === 'string' ? modelID.trim() : '';
const out = {
found: false,
context_tokens: 0,
output_tokens: 0,
reasoning: false,
efforts: null,
toggle: false,
budget: null,
family: '',
release_date: '',
from_override: false,
};
if (!preset || !model) return out;
const hit = lookupModelsDev(catalog, providerMap || {}, preset, model);
let info = hit ? hit.info : null;
let found = Boolean(hit);
let fromOverride = false;
const patchTable = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
const patch = patchTable[`${preset}/${model}`];
if (patch && typeof patch === 'object' && Object.keys(patch).some((k) => k !== 'note')) {
info = mergeOverride(info || { context_tokens: 0, output_tokens: 0, reasoning: false, options: [], family: '', release_date: '' }, patch);
found = true;
fromOverride = true;
}
if (!found) return out;
out.found = true;
out.from_override = fromOverride;
out.context_tokens = info.context_tokens;
out.output_tokens = info.output_tokens;
out.reasoning = info.reasoning;
out.family = info.family;
out.release_date = info.release_date;
const effort = effortValues(info.options);
if (effort) {
out.efforts = effort.slice();
} else if (info.reasoning && info.options.length === 0) {
const sibling = familyEfforts(catalog, hit ? hit.providerID : '', info);
if (sibling) out.efforts = sibling.slice();
}
for (const o of info.options) {
if (!o) continue;
if (o.type === 'toggle') out.toggle = true;
if (o.type === 'budget_tokens') {
out.budget = { min: Number.isFinite(o.min) ? o.min : 0, max: Number.isFinite(o.max) ? o.max : 0 };
}
}
return out;
}