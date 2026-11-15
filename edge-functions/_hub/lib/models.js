export function resolveModelsUrl(baseUrl) {
if (!baseUrl || typeof baseUrl !== 'string') return '';
const trimmed = baseUrl.trim().replace(/\/+$/, '');
if (trimmed.endsWith('/models')) {
return trimmed;
}
if (trimmed.endsWith('/v1') || trimmed.includes('/openai') || trimmed.includes('/v1beta')) {
return `${trimmed}/models`;
}
const modelsPath = ['/v1', 'models'].join('/');
return `${trimmed}${modelsPath}`;
}
export function scrubSecrets(text, extraSecrets = []) {
if (!text || typeof text !== 'string') return text;
let scrubbed = text;
for (const secret of extraSecrets) {
if (secret && typeof secret === 'string' && secret.length >= 6) {
scrubbed = scrubbed.split(secret).join('[REDACTED]');
}
}
scrubbed = scrubbed.replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]');
scrubbed = scrubbed.replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,})/gi, '[REDACTED]');
scrubbed = scrubbed.replace(/\b(AIza[0-9A-Za-z_-]{16,})/gi, '[REDACTED]');
return scrubbed;
}
export function extractModelIds(data) {
if (!data) return [];
let rawList = [];
if (Array.isArray(data.data)) {
rawList = data.data;
} else if (Array.isArray(data.models)) {
rawList = data.models;
} else if (Array.isArray(data)) {
rawList = data;
}
const modelSet = new Set();
for (const item of rawList) {
let id = null;
if (typeof item === 'string') {
id = item;
} else if (item && typeof item === 'object') {
if (item.id) id = item.id;
else if (item.name) id = item.name.replace(/^models\//, '');
else if (item.model) id = item.model;
}
if (id && typeof id === 'string' && id.trim()) {
modelSet.add(id.trim());
}
}
return Array.from(modelSet).sort();
}