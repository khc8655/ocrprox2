#!/usr/bin/env node
/**
 * scripts/e2e/vm.mjs — 在真实测试 VM 上跑「完整节点 + 双协议 mock 上游」。
 *
 *   node scripts/e2e/vm.mjs up       # 交叉编译→上传→起 mock→起节点→灌配置→打印地址
 *   node scripts/e2e/vm.mjs stats    # 上游账本（VM 上真实收到过哪些请求）
 *   node scripts/e2e/vm.mjs reset    # 清零账本
 *   node scripts/e2e/vm.mjs status   # 活着没有
 *   node scripts/e2e/vm.mjs down     # 杀进程 + 删目录 + 关隧道（零残留）
 *   node scripts/e2e/vm.mjs ssh <cmd># 透传一条远程命令
 *
 * 节点和 mock 都跑在 VM 上；本机通过 SSH 隧道（127.0.0.1:18081 / :19090）访问，
 * 因为那台机的防火墙只放开了 80/443/8443。被验证的是 VM 上的真实二进制。
 * 凭据只从本地 scripts/e2e/vm.conf.json 读（已 gitignore），不进仓库、不进提示词。
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const confPath = join(__dirname, 'vm.conf.json');
const statePath = join(__dirname, 'vm.state.json');
const tunnelPath = join(__dirname, 'tunnel.pid');
const REMOTE_DIR = '/tmp/zz_e2e';
const adminPass = 'E2eAccept!2026';
const clientKey = 'ck_zz_e2e_0123456789abcdef';

if (!existsSync(confPath)) {
  console.error(JSON.stringify({ ok: false, error: `missing ${confPath}` }));
  process.exit(2);
}
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const argRelease = (process.argv.find((a) => a.startsWith('--release=')) || '').split('=')[1] || '';
const SSH_OPTS = [
  '-i', conf.key,
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=15',
  '-p', String(conf.port || 22),
];
const TARGET = `${conf.user}@${conf.host}`;

const base = `http://127.0.0.1:${conf.appPort}`;
const mock = `http://127.0.0.1:${conf.mockPort}`;

function ssh(cmd, opts = {}) {
  const r = spawnSync('ssh', [...SSH_OPTS, TARGET, cmd], { encoding: 'utf8', timeout: opts.timeout || 180000 });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`ssh failed (${r.status}) on [${cmd}]: stderr=${(r.stderr || '').trim().slice(0, 400)} stdout=${(r.stdout || '').trim().slice(0, 200)}`);
  }
  return (r.stdout || '').trim();
}

function scp(local, remote) {
  // ssh 的端口是 -p，scp 的是 -P；把 -p <port> 换掉再用。
  const opts = [];
  for (let i = 0; i < SSH_OPTS.length; i++) {
    if (SSH_OPTS[i] === '-p') { i++; continue; }
    opts.push(SSH_OPTS[i]);
  }
  const r = spawnSync('scp', [...opts, '-P', String(conf.port || 22), local, `${TARGET}:${remote}`], { encoding: 'utf8', timeout: 420000 });
  if (r.status !== 0) throw new Error(`scp failed (${r.status}) ${local} -> ${remote}: stderr=${(r.stderr || '').trim().slice(0, 400)} stdout=${(r.stdout || '').trim().slice(0, 300)}`);
}

function closeTunnel() {
  if (!existsSync(tunnelPath)) return;
  const pid = Number(readFileSync(tunnelPath, 'utf8'));
  try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  rmSync(tunnelPath, { force: true });
}

function openTunnel() {
  closeTunnel();
  const child = spawn('ssh', [
    ...SSH_OPTS,
    '-N',
    '-L', `${conf.appPort}:127.0.0.1:${conf.appPort}`,
    '-L', `${conf.mockPort}:127.0.0.1:${conf.mockPort}`,
    TARGET,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(tunnelPath, String(child.pid));
}

function seededConfig() {
  const key = (label, value) => ({ id: label, label, key: value, enabled: true, origin: 'local' });
  const openai = `http://127.0.0.1:${conf.mockPort}/openai/v1`;
  const anthropic = `http://127.0.0.1:${conf.mockPort}/anthropic`;
  const fail = `http://127.0.0.1:${conf.mockPort}/fail/v1`;
  return {
    _version: 1,
    providers: {
      mocka: { id: 'mocka', name: 'Mock A（OpenAI 协议）', base_url: openai, api_type: 'openai-completions', enabled: true, api_keys: [key('pool-a', 'sk-mock-a-0123456789')] },
      mockb: { id: 'mockb', name: 'Mock B（OpenAI 协议）', base_url: openai, api_type: 'openai-completions', enabled: true, api_keys: [key('pool-b', 'sk-mock-b-0123456789')] },
      mockant: { id: 'mockant', name: 'Mock Anthropic（Messages 协议）', base_url: anthropic, api_type: 'anthropic-messages', enabled: true, api_keys: [key('pool-ant', 'sk-mock-ant-0123456789')] },
      dual: { id: 'dual', name: 'Mock Dual（OpenAI + Anthropic 双端点）', base_url: openai, anthropic_base_url: anthropic, api_type: 'openai-completions', enabled: true, api_keys: [key('pool-dual', 'sk-mock-dual-0123456789')] },
      mockfail: { id: 'mockfail', name: 'Mock Fail（恒 500）', base_url: fail, api_type: 'openai-completions', enabled: true, api_keys: [key('pool-fail', 'sk-mock-fail-0123456789')] },
    },
    agent_models: {
      'gpt-test': { enabled: true, candidates: [
        { provider: 'mocka', upstream_model: 'gpt-test', enabled: true },
        { provider: 'mockb', upstream_model: 'gpt-test', enabled: true },
      ] },
      'claude-test': { enabled: true, candidates: [{ provider: 'mockant', upstream_model: 'claude-test', enabled: true }] },
      'dual-model': { enabled: true, candidates: [{ provider: 'dual', upstream_model: 'dual-model', enabled: true }] },
      'flaky': { enabled: true, candidates: [
        { provider: 'mockfail', upstream_model: 'flaky', enabled: true },
        { provider: 'mocka', upstream_model: 'flaky', enabled: true },
      ] },
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

async function httpJson(method, path, payload, cookie) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, json, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

async function up() {
  const arch = ssh('uname -m');
  const goarch = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'amd64';

  // 上一轮残留（同一对端口、同样是我们自己的进程）先清掉，再确认端口真的空闲。
  ssh(`pkill -f '[l]lmproxy.*--port=${conf.appPort}' || true; pkill -f '[m]ock_upstream.py ${conf.mockPort}' || true; sleep 0.5; true`, { allowFail: true });
  const busy = ssh(`ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':(${conf.appPort}|${conf.mockPort})$' || true`);
  if (busy) return { ok: false, error: `ports already in use on ${conf.host}: ${busy}` };

  // 发布产物优先：VM 直接拉 GitHub Release（1~2 秒），顺带校验 sha256。
  // 这样验的是"用户实际下载到的那个二进制"，而不是本机另编一份。
  const asset = `llmproxy-linux-${goarch}`;
  const relBase = `https://github.com/khc8655/ocrprox2/releases/download/${argRelease || conf.release || 'v20261123-09'}`;
  ssh(`rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}/config`);
  const dl = ssh(`cd ${REMOTE_DIR} && curl -fsSL --max-time 90 -o llmproxy ${relBase}/${asset} && ` +
    `curl -fsSL --max-time 30 -o SHA256SUMS ${relBase}/SHA256SUMS && chmod +x llmproxy && ` +
    `[ "$(sha256sum llmproxy | cut -d' ' -f1)" = "$(grep ' ${asset}$' SHA256SUMS | cut -d' ' -f1)" ] && echo SHA_OK && ./llmproxy --version`, { allowFail: true });
  if (!/llmproxy v\d/.test(dl)) {
    // 回退：本机交叉编译后推上去（链路慢时会很慢）
    const binPath = join(__dirname, `llmproxy-linux-${goarch}`);
    execFileSync('go', ['build', '-o', binPath, './cmd/llmproxy'], {
      cwd: projectRoot,
      env: { ...process.env, GOOS: 'linux', GOARCH: goarch, CGO_ENABLED: '0' },
      stdio: 'inherit',
    });
    scp(binPath, `${REMOTE_DIR}/llmproxy`);
    ssh(`cd ${REMOTE_DIR} && chmod +x llmproxy`);
  }

  // mock 只有 7KB：base64 塞进命令行（不依赖 stdin 通道，避免某些 ssh 会话挂住）
  const b64 = readFileSync(join(__dirname, 'mock_upstream.py')).toString('base64');
  ssh(`printf '%s' '${b64}' | base64 -d > ${REMOTE_DIR}/mock_upstream.py && wc -c ${REMOTE_DIR}/mock_upstream.py`);

  // 后台进程必须彻底脱离会话（stdin 也重定向），否则 ssh 会话关闭时返回 255。
  ssh(`cd ${REMOTE_DIR} && ` +
      `nohup python3 mock_upstream.py ${conf.mockPort} > mock.log 2>&1 < /dev/null & ` +
      `sleep 0.5; cd ${REMOTE_DIR} && CONFIG_DIR=${REMOTE_DIR}/config nohup ./llmproxy --role=full --port=${conf.appPort} --admin-pass='${adminPass}' --client-key='${clientKey}' --allow-private > node.log 2>&1 < /dev/null & ` +
      `sleep 0.5; echo started`, { allowFail: true });

  openTunnel();

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    return {
      ok: false,
      error: 'node did not become ready',
      log: ssh(`tail -30 ${REMOTE_DIR}/node.log || true`, { allowFail: true }),
      mockLog: ssh(`tail -20 ${REMOTE_DIR}/mock.log || true`, { allowFail: true }),
    };
  }

  const login = await httpJson('POST', '/api/admin/auth/login', { password: adminPass });
  if (login.status !== 200) return { ok: false, error: `admin login failed: ${login.status}` };
  const saved = await httpJson('POST', '/api/admin/config', seededConfig(), login.cookie);
  if (saved.status !== 200) return { ok: false, error: `config seed failed: ${saved.status} ${JSON.stringify(saved.json)}` };

  const remoteVer = ssh(`cd ${REMOTE_DIR} && ./llmproxy --version 2>/dev/null || true`, { allowFail: true });
  writeFileSync(statePath, JSON.stringify({ startedAt: Date.now(), arch, goarch, remoteVer }));
  return {
    ok: true,
    node: base,
    mock,
    adminPass,
    clientKey,
    vm: TARGET,
    arch,
    remoteVersion: remoteVer,
    note: '节点与 mock 上游都在 VM 上；本机通过 SSH 隧道访问 127.0.0.1:18081 / :19090',
    seeded: { providers: ['mocka', 'mockb', 'mockant', 'dual', 'mockfail'], models: ['gpt-test', 'claude-test', 'dual-model', 'flaky'] },
  };
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'up') { console.log(JSON.stringify(await up())); return; }
  if (cmd === 'stats') {
    const r = await fetch(`${mock}/__stats`);
    console.log(JSON.stringify(await r.json(), null, 2));
    return;
  }
  if (cmd === 'reset') {
    const r = await fetch(`${mock}/__reset`, { method: 'POST' });
    console.log(JSON.stringify(await r.json()));
    return;
  }
  if (cmd === 'status') {
    let alive = false;
    try { alive = (await fetch(`${base}/healthz`)).ok; } catch (_) {}
    console.log(JSON.stringify({ alive, node: base, mock }));
    return;
  }
  if (cmd === 'ssh') { console.log(ssh(process.argv.slice(3).join(' '))); return; }
  if (cmd === 'down') {
    ssh(`pkill -f '[l]lmproxy.*--port=${conf.appPort}' || true; pkill -f '[m]ock_upstream.py ${conf.mockPort}' || true; sleep 0.4; rm -rf ${REMOTE_DIR}; echo cleaned`, { allowFail: true });
    closeTunnel();
    rmSync(statePath, { force: true });
    console.log(JSON.stringify({ ok: true, stopped: true, cleaned: REMOTE_DIR }));
    return;
  }
  console.error('usage: vm.mjs up|stats|reset|status|down|ssh <cmd>');
  process.exit(2);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
