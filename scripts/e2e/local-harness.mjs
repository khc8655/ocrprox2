#!/usr/bin/env node
/**
 * scratch/e2e-ui/harness.mjs — live E2E harness for the UI + real-request workflow.
 *
 *   node scratch/e2e-ui/harness.mjs up              # mock upstream + full node + seeded config
 *   node scratch/e2e-ui/harness.mjs stats           # what the mock upstream has seen so far
 *   node scratch/e2e-ui/harness.mjs reset           # zero the counters
 *   node scratch/e2e-ui/harness.mjs status          # is it alive?
 *   node scratch/e2e-ui/harness.mjs down            # stop both
 *
 * The mock upstream speaks both dialects the gateway forwards to:
 *   POST /openai/v1/chat/completions   OpenAI Chat Completions (JSON + SSE)
 *   POST /anthropic/v1/messages        Anthropic Messages (JSON + SSE)
 *   POST /fail/v1/chat/completions     always 500 (failover fodder)
 *   GET  /v1/models                    static list
 *
 * Every request is recorded (path, protocol, model, key, stream) so routing /
 * failover / concurrency claims can be checked against what the upstream really
 * saw rather than against the gateway's own logs.
 */

import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const stateDir = join(__dirname, 'state');
const pidFile = join(stateDir, 'pids.json');
const mockPort = 19191;
const nodePort = 19292;
const adminPass = 'E2Epass!2026';
const clientKey = 'ck_e2e_0123456789abcdef';

const record = [];

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({ _raw: raw });
      }
    });
  });
}

function summarize() {
  const byProtocol = {};
  const byKey = {};
  const byPath = {};
  const byModel = {};
  for (const r of record) {
    byProtocol[r.protocol] = (byProtocol[r.protocol] || 0) + 1;
    byPath[r.path] = (byPath[r.path] || 0) + 1;
    byModel[r.model] = (byModel[r.model] || 0) + 1;
    const k = r.key || '(none)';
    byKey[k] = (byKey[k] || 0) + 1;
  }
  return { total: record.length, byProtocol, byKey, byPath, byModel, last: record.slice(-8) };
}

function sse(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const e of events) res.write(e);
  res.end();
}

function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
    const p = url.pathname;

    if (p === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summarize()));
      return;
    }
    if (p === '/__reset') {
      record.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reset: true }));
      return;
    }

    if (req.method === 'GET' && p.endsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'gpt-test', object: 'model' },
        { id: 'claude-test', object: 'model' },
      ] }));
      return;
    }

    if (p.startsWith('/fail/')) {
      const b = await body(req);
      record.push({ path: p, protocol: 'fail', model: b.model || '', key: req.headers.authorization || req.headers['x-api-key'] || '', stream: !!b.stream, at: Date.now() });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock upstream exploded', type: 'server_error' } }));
      return;
    }

    const anthropic = p.startsWith('/anthropic/');
    const b = await body(req);
    const model = b.model || '';
    const auth = req.headers.authorization || req.headers['x-api-key'] || '';
    record.push({
      path: p,
      protocol: anthropic ? 'anthropic' : 'openai',
      model,
      key: String(auth).replace(/^Bearer\s+/i, ''),
      stream: !!b.stream,
      messages: Array.isArray(b.messages) ? b.messages.length : 0,
      hasSystem: Array.isArray(b.messages) ? b.messages.some((m) => m && m.role === 'system') : false,
      bodyKeys: Object.keys(b).sort(),
      sysField: typeof b.system !== 'undefined',
      maxTokens: b.max_tokens ?? b.max_completion_tokens ?? null,
      at: Date.now(),
    });

    if (anthropic) {
      if (b.stream) {
        sse(res, [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","model":"' + model + '","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello from mock"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: 'hello from mock' }],
        stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 },
      }));
      return;
    }

    if (b.stream) {
      sse(res, [
        'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"' + model + '","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"' + model + '","choices":[{"index":0,"delta":{"content":" from mock"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"' + model + '","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello from mock' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }));
  });
  server.listen(mockPort, '127.0.0.1');
  return server;
}

async function admin(method, path, payload) {
  const res = await fetch(`http://127.0.0.1:${nodePort}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: stateDir && globalThis.__cookie || '' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) globalThis.__cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

function seededConfig() {
  const key = (label, value) => ({ id: label, label, key: value, enabled: true, origin: 'local' });
  return {
    _version: 1,
    providers: {
      mocka: {
        id: 'mocka', name: 'Mock A（OpenAI 协议）', base_url: `http://127.0.0.1:${mockPort}/openai/v1`,
        api_type: 'openai-completions', enabled: true,
        api_keys: [key('pool-a', 'sk-mock-a-0123456789')],
      },
      mockb: {
        id: 'mockb', name: 'Mock B（OpenAI 协议）', base_url: `http://127.0.0.1:${mockPort}/openai/v1`,
        api_type: 'openai-completions', enabled: true,
        api_keys: [key('pool-b', 'sk-mock-b-0123456789')],
      },
      mockant: {
        id: 'mockant', name: 'Mock Anthropic（Messages 协议）', base_url: `http://127.0.0.1:${mockPort}/anthropic`,
        api_type: 'anthropic-messages', enabled: true,
        api_keys: [key('pool-ant', 'sk-mock-ant-0123456789')],
      },
      dual: {
        id: 'dual', name: 'Mock Dual（OpenAI + Anthropic 双端点）',
        base_url: `http://127.0.0.1:${mockPort}/openai/v1`,
        anthropic_base_url: `http://127.0.0.1:${mockPort}/anthropic`,
        api_type: 'openai-completions', enabled: true,
        api_keys: [key('pool-dual', 'sk-mock-dual-0123456789')],
      },
      mockfail: {
        id: 'mockfail', name: 'Mock Fail（恒 500）', base_url: `http://127.0.0.1:${mockPort}/fail/v1`,
        api_type: 'openai-completions', enabled: true,
        api_keys: [key('pool-fail', 'sk-mock-fail-0123456789')],
      },
    },
    agent_models: {
      'gpt-test': {
        enabled: true,
        candidates: [
          { provider: 'mocka', upstream_model: 'gpt-test', enabled: true },
          { provider: 'mockb', upstream_model: 'gpt-test', enabled: true },
        ],
      },
      'dual-model': {
        enabled: true,
        candidates: [{ provider: 'dual', upstream_model: 'dual-model', enabled: true }],
      },
      'claude-test': {
        enabled: true,
        candidates: [{ provider: 'mockant', upstream_model: 'claude-test', enabled: true }],
      },
      'flaky': {
        enabled: true,
        candidates: [
          { provider: 'mockfail', upstream_model: 'flaky', enabled: true },
          { provider: 'mocka', upstream_model: 'flaky', enabled: true },
        ],
      },
    },
    settings: {
      client_key: clientKey,
      agent_routing_strategy: 'sticky_failover',
      agent_first_byte_timeout_sec: 30,
      cooldown_rate_limit_sec: 15,
      cooldown_server_error_sec: 30,
      cooldown_network_error_sec: 15,
      cooldown_auth_error_sec: 86400,
    },
  };
}

async function up() {
  mkdirSync(stateDir, { recursive: true });
  if (existsSync(pidFile)) {
    console.log(JSON.stringify({ ok: false, error: 'already running; run `down` first' }));
    return 1;
  }
  if (!existsSync(join(__dirname, 'llmproxy'))) {
    execFileSync('go', ['build', '-o', join(__dirname, 'llmproxy'), './cmd/llmproxy'], { cwd: projectRoot, stdio: 'inherit' });
  }
  const mock = startMock();
  const child = spawn(join(__dirname, 'llmproxy'), ['--role=full', `--port=${nodePort}`, `--admin-pass=${adminPass}`, `--client-key=${clientKey}`, '--allow-private'], {
    cwd: __dirname,
    env: { ...process.env, CONFIG_DIR: join(stateDir, 'config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  // wait for the admin plane
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${nodePort}/healthz`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    console.log(JSON.stringify({ ok: false, error: 'node did not become ready', log: log.join('') }));
    try { child.kill('SIGKILL'); } catch (_) {}
    try { mock.close(); } catch (_) {}
    return 1;
  }

  const login = await admin('POST', '/api/admin/auth/login', { password: adminPass });
  if (login.status !== 200) {
    console.log(JSON.stringify({ ok: false, error: `admin login failed: ${login.status}` }));
    return 1;
  }
  const saved = await admin('POST', '/api/admin/config', seededConfig());
  if (saved.status !== 200) {
    console.log(JSON.stringify({ ok: false, error: `config seed failed: ${saved.status} ${JSON.stringify(saved.json)}` }));
    return 1;
  }

  writeFileSync(pidFile, JSON.stringify({
    mockPid: process.pid, nodePid: child.pid, startedAt: Date.now(),
    nodePort, mockPort, adminPass, clientKey,
  }));
  // The mock lives in this process; keep it alive by parking until killed.
  writeFileSync(join(stateDir, 'harness.pid'), String(process.pid));
  writeFileSync(join(stateDir, 'harness.log'), JSON.stringify({
    ok: true,
    node: `http://127.0.0.1:${nodePort}`,
    mock: `http://127.0.0.1:${mockPort}`,
    adminPass, clientKey,
    seeded: { providers: ['mocka', 'mockb', 'mockant', 'mockfail', 'dual'], models: ['gpt-test', 'claude-test', 'flaky', 'dual-model'] },
  }) + '\n');
  // stay alive
  process.on('SIGTERM', () => { try { mock.close(); } catch (_) {} process.exit(0); });
  await new Promise(() => setInterval(() => {}, 1 << 30));
  return 0;
}

async function start() {
  // Spawn `up` detached and wait for it to print its JSON line, so a caller
  // (world.run / a shell) gets control back instead of blocking on the daemon.
  if (existsSync(join(stateDir, 'harness.pid'))) {
    try { process.kill(Number(readFileSync(join(stateDir, 'harness.pid'), 'utf8')), 0); } catch (_) {
      rmSync(join(stateDir, 'harness.pid'), { force: true });
      rmSync(pidFile, { force: true });
    }
  }
  const logPath = join(stateDir, 'harness.log');
  mkdirSync(stateDir, { recursive: true });
  const child = spawn(process.execPath, [join(__dirname, 'harness.mjs'), 'up'], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  for (let i = 0; i < 80; i++) {
    if (existsSync(logPath)) {
      const line = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).pop();
      if (line && line.startsWith('{')) { console.log(line); return 0; }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(JSON.stringify({ ok: false, error: 'harness did not report readiness' }));
  return 1;
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'up') return up();
  if (cmd === 'start') return start();
  if (cmd === 'stats') {
    const r = await fetch(`http://127.0.0.1:${mockPort}/__stats`);
    console.log(JSON.stringify(await r.json(), null, 2));
    return 0;
  }
  if (cmd === 'reset') {
    const r = await fetch(`http://127.0.0.1:${mockPort}/__reset`);
    console.log(JSON.stringify(await r.json()));
    return 0;
  }
  if (cmd === 'status') {
    let alive = false;
    try { alive = (await fetch(`http://127.0.0.1:${nodePort}/healthz`)).ok; } catch (_) {}
    console.log(JSON.stringify({ alive, node: `http://127.0.0.1:${nodePort}` }));
    return 0;
  }
  if (cmd === 'down') {
    if (existsSync(pidFile)) {
      const st = JSON.parse(readFileSync(pidFile, 'utf8'));
      try { process.kill(st.nodePid, 'SIGKILL'); } catch (_) {}
      try { process.kill(st.mockPid, 'SIGKILL'); } catch (_) {}
      rmSync(pidFile, { force: true });
      rmSync(join(stateDir, 'harness.pid'), { force: true });
    }
    console.log(JSON.stringify({ ok: true, stopped: true }));
    return 0;
  }
  console.error('usage: harness.mjs up|stats|reset|status|down');
  return 2;
}

main().then((code) => { if (code !== 0) process.exit(code); }).catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
