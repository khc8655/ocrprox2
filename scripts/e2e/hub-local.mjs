#!/usr/bin/env node
/**
 * scripts/e2e/hub-local.mjs — 在本机跑一份完整的 Hub（真实 edgeone-hub 处理器，
 * 内存 KV），用来在没有生产凭据的情况下走通「Hub 签发节点 → lite 安装 →
 * 配置下发」这条链。
 *
 *   node scripts/e2e/hub-local.mjs            # 监听 127.0.0.1:19091
 *
 * 覆盖的路由与 edge-functions/api 一一对应（nodes / probe-models / verify-key /
 * config / node/config / node/heartbeat / vault/manifest / vault/fetch），
 * 另外提供 /admin（Hub 版控制台）、/install.sh（一键安装脚本）与 /healthz。
 *
 * 环境变量：HUB_PORT（默认 19091）、ADMIN_PASSWORD（默认 hub-admin-secret）。
 * 凭据是一次性的合成值，不碰生产 Hub。
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const PORT = Number(process.env.HUB_PORT || 19091);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hub-admin-secret';

const kv = {
  store: new Map(),
  async get(k) { return this.store.get(k) ?? null; },
  async put(k, v) { this.store.set(k, String(v)); },
  async delete(k) { this.store.delete(k); },
};

const handlers = {
  nodes: () => import('../../edgeone-hub/api/admin/nodes.js'),
  probe: () => import('../../edgeone-hub/api/admin/probe-models.js'),
  verify: () => import('../../edgeone-hub/api/admin/verify-key.js'),
  config: () => import('../../edgeone-hub/api/config.js'),
  nodeConfig: () => import('../../edgeone-hub/api/node/config.js'),
  heartbeat: () => import('../../edgeone-hub/api/node/heartbeat.js'),
  vaultManifest: () => import('../../edgeone-hub/api/vault/manifest.js'),
  vaultFetch: () => import('../../edgeone-hub/api/vault/fetch.js'),
};

const routes = [
  [/^\/api\/admin\/nodes(?:\/.*)?$/, handlers.nodes],
  [/^\/api\/admin\/probe-models$/, handlers.probe],
  [/^\/api\/admin\/verify-key$/, handlers.verify],
  [/^\/api\/config$/, handlers.config],
  [/^\/api\/node\/config$/, handlers.nodeConfig],
  [/^\/api\/node\/heartbeat$/, handlers.heartbeat],
  [/^\/api\/vault\/manifest$/, handlers.vaultManifest],
  [/^\/api\/vault\/fetch$/, handlers.vaultFetch],
];

function sendFile(res, path, type) {
  if (!existsSync(path)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const body = readFileSync(path);
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', role: 'hub', kv_bound: true, local: true, version: 'local-shim' }));
      return;
    }
    if (url.pathname === '/install.sh') {
      sendFile(res, join(projectRoot, 'deploy', 'install.sh'), 'text/x-shellscript; charset=utf-8');
      return;
    }
    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin/index.html') {
      sendFile(res, join(projectRoot, 'admin', 'index.html'), 'text/html; charset=utf-8');
      return;
    }

    const route = routes.find(([re]) => re.test(url.pathname));
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found', path: url.pathname }));
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const init = { method: req.method, headers: { ...req.headers } };
    if (bodyText && req.method !== 'GET' && req.method !== 'HEAD') init.body = bodyText;
    const request = new Request(url.href, init);

    const mod = await route[1]();
    const context = { request, env: { ADMIN_PASSWORD }, KV: kv, params: {}, waitUntil: () => {} };
    const resp = await mod.onRequest(context);
    const text = await resp.text();
    res.writeHead(resp.status, Object.fromEntries([...resp.headers.entries()]));
    res.end(text);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'local_hub_error', detail: String((err && err.stack) || err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`local hub (real edgeone-hub handlers, in-memory KV) on http://127.0.0.1:${PORT}`);
  console.log(`admin console: http://127.0.0.1:${PORT}/admin   admin password: ${ADMIN_PASSWORD}`);
});
