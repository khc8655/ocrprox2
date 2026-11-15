import { constantTimeCompare } from './crypto.js';
export const CONFIG_KV_KEY = 'llmproxy_config';
export class CASConflictError extends Error {
constructor(currentVersion, submittedVersion) {
super(`Config version conflict: current is ${currentVersion}, submitted is ${submittedVersion}`);
this.name = 'CASConflictError';
this.status = 409;
this.currentVersion = currentVersion;
this.submittedVersion = submittedVersion;
}
}
export function isMaskedSecret(val) {
if (!val) return false;
if (typeof val !== 'string') return false;
return val.includes('●') || val.includes('***') || val.startsWith('sk-●') || val.includes('...');
}
export function maskSecret(val) {
if (!val || typeof val !== 'string') return '';
if (val.length <= 8) return '●●●●●●●●';
return `${val.slice(0, 3)}●●●●●●${val.slice(-4)}`;
}
export function toMaskedConfig(config) {
const cloned = JSON.parse(JSON.stringify(config || {}));
const providers = cloned.providers || {};
for (const prov of Object.values(providers)) {
if (prov && Array.isArray(prov.api_keys)) {
for (const k of prov.api_keys) {
if (k && k.key) {
k.key = maskSecret(k.key);
}
}
}
}
return cloned;
}
export function applyKernelGuard(incomingConfig, storedConfig) {
if (!incomingConfig || !incomingConfig.providers) return incomingConfig;
const storedProviders = (storedConfig && storedConfig.providers) || {};
for (const [pId, pData] of Object.entries(incomingConfig.providers)) {
if (!pData || !Array.isArray(pData.api_keys)) continue;
const storedPData = storedProviders[pId] || {};
const storedKeys = Array.isArray(storedPData.api_keys) ? storedPData.api_keys : [];
const restoredKeys = [];
for (const k of pData.api_keys) {
if (!k) continue;
if (isMaskedSecret(k.key)) {
const match = storedKeys.find(
(sk) => (k.id && sk.id === k.id) || (k.label && sk.label === k.label)
);
if (match && match.key && !isMaskedSecret(match.key)) {
k.key = match.key;
restoredKeys.push(k);
} else {
console.warn(`Kernel Guard: Dropping masked key without stored counterpart: ${pId}/${k.label || k.id}`);
}
} else {
restoredKeys.push(k);
}
}
pData.api_keys = restoredKeys;
}
return incomingConfig;
}
export async function loadConfig(kv) {
let raw = null;
if (kv) {
if (typeof kv.get === 'function') {
raw = await kv.get(CONFIG_KV_KEY);
} else if (typeof kv.getItem === 'function') {
raw = await kv.getItem(CONFIG_KV_KEY);
}
}
if (raw) {
try {
const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
if (parsed && typeof parsed._version === 'number') {
return parsed;
}
} catch (_) {}
}
return {
_version: 1,
providers: {},
agent_models: {},
settings: {
run_mode: 'agent',
agent_routing_strategy: 'sticky_failover',
agent_first_byte_timeout_sec: 120,
cooldown_rate_limit_sec: 15,
cooldown_server_error_sec: 30,
cooldown_network_error_sec: 15,
cooldown_auth_error_sec: 86400,
ocr_max_inflight: 4,
kb_global_max_concurrency: 16,
mode_schedule_enabled: false,
mode_schedule_agent_window: '08:30-22:30',
mode_schedule_timezone: 'Asia/Shanghai',
},
};
}
export async function saveConfigWithCAS(incomingConfig, kv) {
const stored = await loadConfig(kv);
const incomingVer = incomingConfig._version !== undefined ? Number(incomingConfig._version) : null;
const currentVer = Number(stored._version || 1);
if (incomingVer === null || incomingVer !== currentVer) {
throw new CASConflictError(currentVer, incomingVer);
}
const sanitized = applyKernelGuard(incomingConfig, stored);
sanitized._version = currentVer + 1;
const serialized = JSON.stringify(sanitized);
if (kv) {
if (typeof kv.put === 'function') {
await kv.put(CONFIG_KV_KEY, serialized);
} else if (typeof kv.setItem === 'function') {
await kv.setItem(CONFIG_KV_KEY, serialized);
}
}
return sanitized;
}
export const KV_BINDING_CANDIDATES = [
'agent_kv',
'KV',
'EDGE_KV',
'ocrproxy_kv',
'my_kv',
'kv',
'KV_NAMESPACE',
'__MOCK_KV__',
];
function looksLikeKv(obj) {
return Boolean(obj && typeof obj === 'object' && typeof obj.get === 'function');
}
function isKvDuck(obj) {
return Boolean(
obj &&
typeof obj === 'object' &&
typeof obj.get === 'function' &&
typeof obj.put === 'function'
);
}
export function resolveKvBinding(contextOrEnv, explicitKv) {
if (explicitKv && typeof explicitKv.get === 'function') {
return explicitKv;
}
if (isKvDuck(contextOrEnv)) {
return contextOrEnv;
}
const scopes = [];
if (contextOrEnv && typeof contextOrEnv === 'object') {
scopes.push(contextOrEnv);
if (contextOrEnv.env && typeof contextOrEnv.env === 'object') scopes.push(contextOrEnv.env);
if (contextOrEnv.bindings && typeof contextOrEnv.bindings === 'object') scopes.push(contextOrEnv.bindings);
}
if (typeof globalThis !== 'undefined') {
scopes.push(globalThis);
}
for (const scope of scopes) {
for (const name of KV_BINDING_CANDIDATES) {
const candidate = scope?.[name];
if (looksLikeKv(candidate)) {
return candidate;
}
}
}
try { if (typeof agent_kv !== 'undefined' && looksLikeKv(agent_kv)) return agent_kv; } catch (_) {}
try { if (typeof my_kv !== 'undefined' && looksLikeKv(my_kv)) return my_kv; } catch (_) {}
try { if (typeof KV !== 'undefined' && looksLikeKv(KV)) return KV; } catch (_) {}
try { if (typeof EDGE_KV !== 'undefined' && looksLikeKv(EDGE_KV)) return EDGE_KV; } catch (_) {}
try { if (typeof ocrproxy_kv !== 'undefined' && looksLikeKv(ocrproxy_kv)) return ocrproxy_kv; } catch (_) {}
try { if (typeof kv !== 'undefined' && looksLikeKv(kv)) return kv; } catch (_) {}
try { if (typeof KV_NAMESPACE !== 'undefined' && looksLikeKv(KV_NAMESPACE)) return KV_NAMESPACE; } catch (_) {}
try { if (typeof __MOCK_KV__ !== 'undefined' && looksLikeKv(__MOCK_KV__)) return __MOCK_KV__; } catch (_) {}
for (const scope of scopes) {
if (!scope || typeof scope !== 'object') continue;
for (const key of Object.keys(scope)) {
const sub = scope[key];
if (isKvDuck(sub)) {
return sub;
}
if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
for (const innerKey of Object.keys(sub)) {
const innerSub = sub[innerKey];
if (isKvDuck(innerSub)) {
return innerSub;
}
}
}
}
}
return undefined;
}
export function resolveEnv(contextOrEnv) {
const merged = {};
if (typeof process !== 'undefined' && process?.env) {
Object.assign(merged, process.env);
}
if (typeof globalThis !== 'undefined') {
for (const key of ['ADMIN_PASSWORD', 'NODE_ENV', 'HUB_URL']) {
if (typeof globalThis[key] === 'string') {
merged[key] = globalThis[key];
}
}
}
try {
if (typeof ADMIN_PASSWORD !== 'undefined' && typeof ADMIN_PASSWORD === 'string') {
merged.ADMIN_PASSWORD = ADMIN_PASSWORD;
}
} catch (_) {}
if (contextOrEnv && typeof contextOrEnv === 'object') {
for (const [k, v] of Object.entries(contextOrEnv)) {
if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
merged[k] = v;
}
}
if (contextOrEnv.env && typeof contextOrEnv.env === 'object') {
for (const [k, v] of Object.entries(contextOrEnv.env)) {
if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
merged[k] = v;
}
}
}
}
return new Proxy(merged, {
get(target, prop) {
if (typeof prop !== 'string') return target[prop];
if (contextOrEnv && typeof contextOrEnv === 'object') {
if (contextOrEnv.env && contextOrEnv.env[prop] !== undefined) {
return contextOrEnv.env[prop];
}
if (contextOrEnv[prop] !== undefined) {
return contextOrEnv[prop];
}
}
if (typeof globalThis !== 'undefined' && globalThis[prop] !== undefined) {
return globalThis[prop];
}
if (prop === 'ADMIN_PASSWORD') {
try {
if (typeof ADMIN_PASSWORD !== 'undefined') return ADMIN_PASSWORD;
} catch (_) {}
}
if (typeof process !== 'undefined' && process?.env && process.env[prop] !== undefined) {
return process.env[prop];
}
return target[prop];
},
});
}
export function checkAdminAuth(request, envOrContext) {
const env = resolveEnv(envOrContext);
const adminPassword = (env && env.ADMIN_PASSWORD) || 'admin';
const authHeader = request.headers.get('authorization') || '';
const expectedBearer = `Bearer ${adminPassword}`;
if (constantTimeCompare(authHeader, expectedBearer)) {
return null;
}
const customHeader = request.headers.get('x-admin-key') || '';
if (constantTimeCompare(customHeader, adminPassword)) {
return null;
}
return new Response(
JSON.stringify({ ok: false, error: 'Unauthorized: Invalid admin credentials' }),
{ status: 401, headers: { 'content-type': 'application/json' } }
);
}