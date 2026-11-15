import {
generateNodeToken,
hashToken,
constantTimeCompare,
} from './crypto.js';
import { scrubSecrets } from './models.js';
export const NODES_KV_KEY = 'relay_nodes';
function sanitizeNode(n) {
const copy = { ...n };
delete copy.token_sha256;
delete copy.node_token_enc;
delete copy.status_url;
delete copy.has_status_url;
delete copy.cached_status;
const scope = n.scope && typeof n.scope === 'object' ? n.scope : {};
copy.scope = {
models: Array.isArray(scope.models) ? scope.models : ['*'],
providers: Array.isArray(scope.providers) ? scope.providers : ['*'],
search_providers: Array.isArray(scope.search_providers) ? scope.search_providers : ['*'],
};
return copy;
}
function buildBootstrapEnv(node, rawToken, hubUrl) {
const providers = Array.isArray(node.scope?.providers) ? node.scope.providers : ['*'];
const searchProviders = Array.isArray(node.scope?.search_providers) ? node.scope.search_providers : ['*'];
if (providers.length === 0 && searchProviders.length > 0) {
return `HUB_URL=${hubUrl} NODE_TOKEN=${rawToken}`;
}
return `LLMPROXY_ROLE=${node.role} LLMPROXY_HUB_URL=${hubUrl} LLMPROXY_NODE_TOKEN=${rawToken}`;
}
export async function loadNodes(kv) {
let raw = null;
if (kv) {
if (typeof kv.get === 'function') {
raw = await kv.get(NODES_KV_KEY);
} else if (typeof kv.getItem === 'function') {
raw = await kv.getItem(NODES_KV_KEY);
}
}
if (raw) {
try {
const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
if (Array.isArray(parsed)) return parsed;
if (typeof parsed === 'object') return Object.values(parsed);
} catch (_) {}
}
return [];
}
export async function saveNodes(nodes, kv) {
const serialized = JSON.stringify(nodes);
if (kv) {
if (typeof kv.put === 'function') {
await kv.put(NODES_KV_KEY, serialized);
} else if (typeof kv.setItem === 'function') {
await kv.setItem(NODES_KV_KEY, serialized);
}
}
}
export async function listNodes(kv) {
const nodes = await loadNodes(kv);
return nodes.map(sanitizeNode);
}
function clampCount(val) {
const num = Number(val);
return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
}
function sanitizeTelemetry(raw, nowIso) {
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
const out = {
requests: clampCount(raw.requests),
success: clampCount(raw.success),
tokens: clampCount(raw.tokens),
updated_at: nowIso,
};
if (typeof raw.version === 'string' && raw.version.trim()) {
out.version = scrubSecrets(raw.version.trim()).slice(0, 64);
}
if (raw.uptime_sec !== undefined && raw.uptime_sec !== null) {
out.uptime_sec = clampCount(raw.uptime_sec);
}
if (typeof raw.playwright_ready === 'boolean') {
out.playwright_ready = raw.playwright_ready;
}
if (raw.search_count !== undefined && raw.search_count !== null) {
out.search_count = clampCount(raw.search_count);
}
if (raw.crawl_count !== undefined && raw.crawl_count !== null) {
out.crawl_count = clampCount(raw.crawl_count);
}
if (Array.isArray(raw.resting_keys)) {
out.resting_keys = raw.resting_keys
.map((item) => scrubSecrets(String(item || '').trim()).slice(0, 64))
.filter(Boolean)
.slice(0, 20);
}
if (raw.resting_keys_count !== undefined || out.resting_keys) {
out.resting_keys_count = Math.max(
clampCount(raw.resting_keys_count),
Array.isArray(out.resting_keys) ? out.resting_keys.length : 0
);
}
if (typeof raw.last_error === 'string' && raw.last_error.trim()) {
out.last_error = scrubSecrets(raw.last_error.trim()).slice(0, 240);
}
return out;
}
export async function issueNode(params, kv, hubUrl = 'https://hub.example.com') {
const nodes = await loadNodes(kv);
const rawToken = generateNodeToken();
const tokenSha = hashToken(rawToken);
const tokenPrefix = rawToken.slice(0, 17) + '...';
const nodeId = `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const nowIso = new Date().toISOString();
const node = {
id: nodeId,
name: params.name || 'Unnamed Node',
role: params.role === 'full' ? 'full' : 'lite',
enabled: true,
token_prefix: tokenPrefix,
token_sha256: tokenSha,
lease_ttl: Number(params.lease_ttl) || 86400,
grace_ttl: Number(params.grace_ttl) || 3600,
scope: {
models: Array.isArray(params.scope?.models) ? params.scope.models : ['*'],
providers: Array.isArray(params.scope?.providers) ? params.scope.providers : ['*'],
search_providers: Array.isArray(params.scope?.search_providers)
? params.scope.search_providers
: ['*'],
},
created_at: nowIso,
last_seen: null,
last_ip: null,
last_config_version: 0,
last_binary_version: 'v2.1.3',
sync_count: 0,
hit_304_count: 0,
};
nodes.push(node);
await saveNodes(nodes, kv);
const bootstrapEnv = buildBootstrapEnv(node, rawToken, hubUrl);
return {
node: sanitizeNode(node),
node_token: rawToken,
bootstrap_env: bootstrapEnv,
};
}
export async function patchNode(nodeId, patch, kv) {
const nodes = await loadNodes(kv);
const idx = nodes.findIndex((n) => n.id === nodeId);
if (idx === -1) return null;
const node = nodes[idx];
if (patch.name !== undefined) node.name = String(patch.name);
if (patch.enabled !== undefined) {
node.enabled = Boolean(patch.enabled);
}
if (patch.lease_ttl !== undefined) node.lease_ttl = Number(patch.lease_ttl);
if (patch.grace_ttl !== undefined) node.grace_ttl = Number(patch.grace_ttl);
if (patch.scope !== undefined && typeof patch.scope === 'object') {
const existingScope = node.scope && typeof node.scope === 'object' ? node.scope : {};
node.scope = {
models: Array.isArray(patch.scope.models) ? patch.scope.models : (existingScope.models || ['*']),
providers: Array.isArray(patch.scope.providers) ? patch.scope.providers : (existingScope.providers || ['*']),
search_providers: Array.isArray(patch.scope.search_providers)
? patch.scope.search_providers
: (existingScope.search_providers || ['*']),
};
}
nodes[idx] = node;
await saveNodes(nodes, kv);
return sanitizeNode(node);
}
export async function rotateNodeToken(nodeId, kv, hubUrl = 'https://hub.example.com') {
const nodes = await loadNodes(kv);
const idx = nodes.findIndex((n) => n.id === nodeId);
if (idx === -1) return null;
const node = nodes[idx];
const rawToken = generateNodeToken();
const tokenSha = hashToken(rawToken);
const tokenPrefix = rawToken.slice(0, 17) + '...';
node.token_sha256 = tokenSha;
node.token_prefix = tokenPrefix;
delete node.node_token_enc;
delete node.status_url;
delete node.cached_status;
nodes[idx] = node;
await saveNodes(nodes, kv);
const bootstrapEnv = buildBootstrapEnv(node, rawToken, hubUrl);
return {
node_token: rawToken,
bootstrap_env: bootstrapEnv,
};
}
export async function deleteNode(nodeId, kv) {
const nodes = await loadNodes(kv);
const filtered = nodes.filter((n) => n.id !== nodeId);
if (filtered.length === nodes.length) return false;
await saveNodes(filtered, kv);
return true;
}
export async function findNodeByToken(rawToken, kv) {
if (!rawToken) return null;
const hash = hashToken(rawToken);
const nodes = await loadNodes(kv);
for (const n of nodes) {
if (constantTimeCompare(n.token_sha256, hash)) {
return n;
}
}
return null;
}
export async function touchNodeLastSeen(nodeId, kv, configVer = 0, meta = {}) {
const nodes = await loadNodes(kv);
const node = nodes.find((n) => n.id === nodeId);
if (!node) return;
const now = Date.now();
const lastTime = node.last_seen ? new Date(node.last_seen).getTime() : 0;
node.sync_count = (Number(node.sync_count) || 0) + 1;
if (meta && meta.is304) {
node.hit_304_count = (Number(node.hit_304_count) || 0) + 1;
}
if (meta && meta.ip) {
node.last_ip = String(meta.ip);
}
const nowIso = new Date(now).toISOString();
const parsedTelemetry = sanitizeTelemetry(meta?.telemetry, nowIso);
if (parsedTelemetry) {
node.telemetry = parsedTelemetry;
}
if (lastTime > 0 && meta?.is304 && now - lastTime < 60_000) return;
node.last_seen = nowIso;
if (configVer) node.last_config_version = configVer;
await saveNodes(nodes, kv);
}