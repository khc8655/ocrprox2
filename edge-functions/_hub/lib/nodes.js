import {
generateNodeToken,
generateAdminPassword,
hashToken,
constantTimeCompare,
} from './crypto.js';
export const NODES_KV_KEY = 'relay_nodes';
export function generateClientKey() {
const bytes = new Uint8Array(16);
globalThis.crypto.getRandomValues(bytes);
let hex = '';
for (let i = 0; i < bytes.length; i++) {
hex += bytes[i].toString(16).padStart(2, '0');
}
return `sk-llmproxy-${hex}`;
}
function sanitizeNode(n) {
const copy = { ...n };
delete copy.token_sha256;
delete copy.node_token_enc;
delete copy.status_url;
delete copy.has_status_url;
delete copy.cached_status;
delete copy.mcp_url;
delete copy.telemetry;
delete copy.kind;
delete copy.service_type;
const scope = n.scope && typeof n.scope === 'object' ? n.scope : {};
copy.scope = {
models: Array.isArray(scope.models) ? scope.models : ['*'],
providers: Array.isArray(scope.providers) ? scope.providers : ['*'],
};
return copy;
}
function sanitizeShellToken(val) {
if (!val || typeof val !== 'string') return '';
return val.trim().replace(/["'$`\\\s;|&<>(){}!]/g, '');
}
function buildBootstrapEnv(node, rawToken, hubUrl, clientKey = '') {
const role = node.role === 'full' ? 'full' : 'lite';
const cleanHub = sanitizeShellToken(hubUrl || 'https://hub.example.com').replace(/\/+$/, '');
const parts = [
`LLMPROXY_ROLE=${role}`,
`LLMPROXY_HUB_URL=${cleanHub}`,
`LLMPROXY_NODE_TOKEN=${rawToken}`,
];
const cleanKey = sanitizeShellToken(clientKey);
if (cleanKey) {
parts.push(`LLMPROXY_CLIENT_KEY=${cleanKey}`);
}
return parts.join(' ');
}
function buildInstallCommand(node, rawToken, hubUrl, clientKey = '', adminPassword = '') {
const cleanHub = sanitizeShellToken(hubUrl || 'https://hub.example.com').replace(/\/+$/, '');
const role = node.role === 'full' ? 'full' : 'lite';
const args = [
`--role=${role}`,
`--hub-url="${cleanHub}"`,
`--node-token="${rawToken}"`,
];
const cleanKey = sanitizeShellToken(clientKey);
if (cleanKey) {
args.push(`--client-key="${cleanKey}"`);
}
const cleanAdmin = sanitizeShellToken(adminPassword);
if (role === 'full' && cleanAdmin) {
args.push(`--admin-password="${cleanAdmin}"`);
}
args.push('-p 8787', '-y');
return `curl -fsSL ${cleanHub}/install.sh | sudo bash -s -- ${args.join(' ')}`;
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
export async function issueNode(params, kv, hubUrl = 'https://hub.example.com', clientKey = '') {
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
const effectiveClientKey = sanitizeShellToken(clientKey) || generateClientKey();
const adminPassword = node.role === 'full' ? generateAdminPassword(20) : '';
const bootstrapEnv = buildBootstrapEnv(node, rawToken, hubUrl, effectiveClientKey);
const installCommand = buildInstallCommand(node, rawToken, hubUrl, effectiveClientKey, adminPassword);
return {
node: sanitizeNode(node),
node_token: rawToken,
client_key: effectiveClientKey,
admin_password: adminPassword || undefined,
bootstrap_env: bootstrapEnv,
install_command: installCommand,
};
}
export async function patchNode(nodeId, patch, kv) {
const nodes = await loadNodes(kv);
const idx = nodes.findIndex((n) => n.id === nodeId);
if (idx === -1) return null;
const node = nodes[idx];
const prevLastSeen = node.last_seen ?? null;
const prevConfigVer = node.last_config_version ?? 0;
if (patch.name !== undefined) node.name = String(patch.name);
if (patch.role === 'full' || patch.role === 'lite') {
node.role = patch.role;
}
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
};
}
node.last_seen = prevLastSeen;
node.last_config_version = prevConfigVer;
nodes[idx] = node;
await saveNodes(nodes, kv);
return sanitizeNode(node);
}
export async function rotateNodeToken(nodeId, kv, hubUrl = 'https://hub.example.com', clientKey = '') {
const res = await reissueNodeToken(nodeId, kv, hubUrl, clientKey);
if (!res) return null;
const { node_token, client_key, admin_password, bootstrap_env, install_command } = res;
return { node_token, client_key, admin_password, bootstrap_env, install_command };
}
export async function reissueNodeToken(nodeId, kv, hubUrl = 'https://hub.example.com', clientKey = '') {
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
const effectiveClientKey = sanitizeShellToken(clientKey) || generateClientKey();
const adminPassword = node.role === 'full' ? generateAdminPassword(20) : '';
const bootstrapEnv = buildBootstrapEnv(node, rawToken, hubUrl, effectiveClientKey);
const installCommand = buildInstallCommand(node, rawToken, hubUrl, effectiveClientKey, adminPassword);
return {
node: sanitizeNode(node),
node_token: rawToken,
client_key: effectiveClientKey,
admin_password: adminPassword || undefined,
bootstrap_env: bootstrapEnv,
install_command: installCommand,
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
export async function touchNodeLastSeen(nodeId, kv, configVerOrMeta = 0, maybeMeta = {}) {
const configVer = typeof configVerOrMeta === 'number' ? configVerOrMeta : 0;
const meta = configVerOrMeta && typeof configVerOrMeta === 'object' ? configVerOrMeta : (maybeMeta || {});
const nodes = await loadNodes(kv);
const node = nodes.find((n) => n.id === nodeId);
if (!node) return;
const now = Date.now();
const lastTime = node.last_seen ? new Date(node.last_seen).getTime() : 0;
const prevBinVer = node.last_binary_version || '';
const cleanBinVer = meta && meta.binaryVersion
? String(meta.binaryVersion).replace(/[<>"'&\x00-\x1f\x7f]/g, '').trim().slice(0, 32)
: '';
const hasBinVerChange = Boolean(cleanBinVer && cleanBinVer !== prevBinVer);
const hasUsage = Boolean(meta && meta.usage && typeof meta.usage === 'object');
node.sync_count = (Number(node.sync_count) || 0) + 1;
if (meta && meta.is304) {
node.hit_304_count = (Number(node.hit_304_count) || 0) + 1;
}
if (meta && meta.ip) {
node.last_ip = String(meta.ip);
}
if (cleanBinVer) {
node.last_binary_version = cleanBinVer;
}
if (hasUsage) {
const models = {};
const raw = meta.usage.models && typeof meta.usage.models === 'object' ? meta.usage.models : {};
let guard = 0;
for (const [m, n] of Object.entries(raw)) {
if (guard >= 50) break;
const count = Number(n);
const cleanModel = String(m || '').replace(/[<>"'&\x00-\x1f\x7f]/g, '').trim().slice(0, 96);
if (!cleanModel || !Number.isFinite(count) || count <= 0) continue;
models[cleanModel] = Math.floor(count);
guard += 1;
}
let modelStats = null;
const rawStats = meta.usage.model_stats && typeof meta.usage.model_stats === 'object' ? meta.usage.model_stats : null;
if (rawStats) {
modelStats = {};
let sGuard = 0;
for (const [m, st] of Object.entries(rawStats)) {
if (sGuard >= 50) break;
if (!st || typeof st !== 'object') continue;
const cleanModel = String(m || '').replace(/[<>"'&\x00-\x1f\x7f]/g, '').trim().slice(0, 96);
if (!cleanModel) continue;
const calls = Math.max(0, Math.floor(Number(st.calls ?? st.requests) || 0));
const successes = Math.max(0, Math.floor(Number(st.successes ?? st.success) || 0));
const failed = Math.max(0, Math.floor(Number(st.failed) || 0));
const in_tokens = Math.max(0, Math.floor(Number(st.in_tokens ?? st.input_tokens) || 0));
const out_tokens = Math.max(0, Math.floor(Number(st.out_tokens ?? st.output_tokens) || 0));
if (calls <= 0 && successes <= 0 && failed <= 0 && in_tokens <= 0 && out_tokens <= 0) continue;
modelStats[cleanModel] = { calls, successes, failed, in_tokens, out_tokens };
if (!models[cleanModel] && calls > 0) {
models[cleanModel] = calls;
}
sGuard += 1;
}
}
node.usage = {
models,
...(modelStats ? { model_stats: modelStats } : {}),
requests: Number(meta.usage.requests) || 0,
successes: Number(meta.usage.successes) || 0,
failed: Number(meta.usage.failed) || 0,
in_tokens: Number(meta.usage.in_tokens) || 0,
out_tokens: Number(meta.usage.out_tokens) || 0,
updated_at: new Date(now).toISOString(),
};
}
const nowIso = new Date(now).toISOString();
if (lastTime > 0 && meta?.is304 && !hasUsage && !hasBinVerChange && now - lastTime < 60_000) return;
node.last_seen = nowIso;
if (configVer) node.last_config_version = configVer;
await saveNodes(nodes, kv);
}