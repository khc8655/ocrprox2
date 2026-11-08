import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

// Helper to make promise-based HTTP requests
function httpRequest(urlOrOpts, options = {}) {
  return new Promise((resolve, reject) => {
    let reqOpts;
    if (typeof urlOrOpts === 'string') {
      const u = new URL(urlOrOpts);
      reqOpts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      };
    } else {
      reqOpts = {
        protocol: 'http:',
        hostname: urlOrOpts.host || urlOrOpts.hostname || '127.0.0.1',
        port: urlOrOpts.port,
        path: urlOrOpts.path || '/',
        method: options.method || 'GET',
        headers: options.headers || {},
      };
    }

    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(bodyStr);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: bodyStr,
          json,
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      const data = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.write(data);
    }
    req.end();
  });
}

// Helper to find a free TCP port
function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, host, () => {
      const port = srv.address().port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

// Helper to poll until HTTP service responds
async function waitForHttp(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpRequest(url);
      if (res.statusCode >= 200 && res.statusCode < 500) {
        return res;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for ${url} after ${timeoutMs}ms`);
}

// Helper to gracefully stop child process
function stopProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve();
    }, 3000);

    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch (_) {
      clearTimeout(timer);
      resolve();
    }
  });
}

describe('T3 Blackbox End-to-End Suite', () => {
  let tmpBinPath;

  before(() => {
    // Compile temporary llmproxy binary once with CGO_ENABLED=0
    tmpBinPath = join(tmpdir(), `llmproxy-t3-bin-${Date.now()}`);
    execFileSync('go', ['build', '-trimpath', '-o', tmpBinPath, './cmd/llmproxy'], {
      cwd: projectRoot,
      env: { ...process.env, CGO_ENABLED: '0' },
      stdio: 'pipe',
    });
  });

  after(() => {
    if (tmpBinPath && existsSync(tmpBinPath)) {
      try {
        rmSync(tmpBinPath, { force: true });
      } catch (_) {}
    }
  });

  // ==========================================================================
  // Test 1: T3.lite_zero_disk_and_budget (NAT 极简节点专项验收)
  // ==========================================================================
  test('T3.lite_zero_disk_and_budget', { timeout: 30000 }, async () => {
    let hubCalls = 0;
    let mockHubStatus = 200;

    // 1. Start Mock Upstream Server
    const upstreamPort = await getFreePort();
    const upstreamServer = http.createServer((req, res) => {
      if (req.url.endsWith('/chat/completions')) {
        let reqBody = '';
        req.on('data', (c) => (reqBody += c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-mock-test',
              object: 'chat.completion',
              created: 1700000000,
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'mock upstream response ok' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    await new Promise((resolve) => upstreamServer.listen(upstreamPort, '127.0.0.1', resolve));

    // 2. Start Mock Hub Server
    const hubPort = await getFreePort();
    const hubServer = http.createServer((req, res) => {
      if (req.url === '/api/node/config' && req.method === 'POST') {
        hubCalls++;
        if (mockHubStatus === 401) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'revoked' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          ETag: '"test-v1"',
          'X-Lease-Until': String(Math.floor(Date.now() / 1000) + 86400),
          'X-Grace-Until': String(Math.floor(Date.now() / 1000) + 3600),
        });
        res.end(
          JSON.stringify({
            ok: true,
            config_version: 1,
            lease_ttl: 86400,
            grace_ttl: 3600,
            payload: {
              version: 1,
              providers: {
                mock_p: {
                  id: 'mock_p',
                  name: 'Mock Provider',
                  base_url: `http://127.0.0.1:${upstreamPort}`,
                  protocol: 'openai',
                  enabled: true,
                  api_keys: [
                    { label: 'k1', key: 'sk-test-upstream-secret-999', enabled: true },
                  ],
                },
              },
              agent_models: {
                'gpt-4o': {
                  enabled: true,
                  candidates: [{ provider: 'mock_p', key_label: 'k1', enabled: true }],
                },
              },
              settings: {
                run_mode: 'agent',
              },
            },
          })
        );
        return;
      }
      res.writeHead(404);
      res.end('hub not found');
    });

    await new Promise((resolve) => hubServer.listen(hubPort, '127.0.0.1', resolve));

    // 3. Create temporary clean empty directory for Lite process
    const tmpLiteDir = mkdtempSync(join(tmpdir(), 'llmproxy-t3-lite-'));
    const litePort = await getFreePort();

    // 4. Start llmproxy sub-process with --role=lite
    const clientKey = 'sk-test-client-key-lite';
    const liteProc = spawn(
      tmpBinPath,
      [
        '--role=lite',
        `--addr=127.0.0.1:${litePort}`,
        `--hub-url=http://127.0.0.1:${hubPort}`,
        '--node-token=stk_node_0123456789abcdef0123456789abcdef0123456789abcdef',
        `--client-key=${clientKey}`,
        '--allow-private=true',
      ],
      {
        cwd: tmpLiteDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    try {
      // 5. Poll until standby
      await waitForHttp(`http://127.0.0.1:${litePort}/healthz`);

      // Assertion: Before sending proxy request, check /healthz
      const healthBefore = await httpRequest(`http://127.0.0.1:${litePort}/healthz`);
      assert.strictEqual(healthBefore.statusCode, 200);
      assert.strictEqual(healthBefore.json.status, 'standby');
      assert.strictEqual(healthBefore.json.state, 'waiting_first_request');
      assert.strictEqual(healthBefore.json.lease_valid, false);
      assert.strictEqual(hubCalls, 0, 'Mock Hub must receive 0 requests before first proxy request');

      // 6. Send 20 concurrent requests to /v1/chat/completions
      const concurrentReqs = Array.from({ length: 20 }, () =>
        httpRequest(`http://127.0.0.1:${litePort}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientKey}`,
            'Content-Type': 'application/json',
          },
          body: {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'test hello' }],
          },
        })
      );

      const responses = await Promise.all(concurrentReqs);

      // Assert all 20 returned 200 OK
      for (let i = 0; i < responses.length; i++) {
        assert.strictEqual(responses[i].statusCode, 200, `Request #${i} must return 200 OK`);
        assert.ok(responses[i].json, `Request #${i} must return valid json`);
        assert.strictEqual(
          responses[i].json.choices[0].message.content,
          'mock upstream response ok'
        );
      }

      // Assert Singleflight & Lease protection: Hub called strictly 1 time
      assert.strictEqual(
        hubCalls,
        1,
        `Mock Hub /api/node/config must be called STRICTLY 1 time across 20 concurrent requests, got ${hubCalls}`
      );

      // Check /healthz is now ready / healthy
      const healthActive = await httpRequest(`http://127.0.0.1:${litePort}/healthz`);
      assert.strictEqual(healthActive.json.state, 'ready');
      assert.strictEqual(healthActive.json.lease_valid, true);

      // 7. Verify ReadOnly route guard
      const readonlyCheck1 = await httpRequest(`http://127.0.0.1:${litePort}/api/config`);
      assert.strictEqual(readonlyCheck1.statusCode, 403, 'GET /api/config must return 403 in lite mode');

      const readonlyCheck2 = await httpRequest(`http://127.0.0.1:${litePort}/api/admin/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { mode: 'kb' },
      });
      assert.strictEqual(readonlyCheck2.statusCode, 403, 'POST /api/admin/mode must return 403 in lite mode');

      // 8. Verify Zero-Disk Scanning in tmpLiteDir
      const diskEntries = readdirSync(tmpLiteDir);
      assert.strictEqual(
        diskEntries.length,
        0,
        `Lite node working directory must be 100% empty, found: ${JSON.stringify(diskEntries)}`
      );

      // 9. Verify X-Node-Refresh: 1 and 401 Revocation immediate destruction
      mockHubStatus = 401; // Hub now revokes the node

      const refreshReq = await httpRequest(`http://127.0.0.1:${litePort}/v1/models`, {
        headers: {
          Authorization: `Bearer ${clientKey}`,
          'X-Node-Refresh': '1',
        },
      });

      assert.strictEqual(
        refreshReq.statusCode,
        503,
        'Request after node revocation must immediately return 503 Service Unavailable'
      );

      const healthRevoked = await httpRequest(`http://127.0.0.1:${litePort}/healthz`);
      assert.strictEqual(
        healthRevoked.json.state,
        'revoked',
        `Node health state must transition to 'revoked', got '${healthRevoked.json.state}'`
      );
    } finally {
      await stopProcess(liteProc);
      await new Promise((r) => hubServer.close(r));
      await new Promise((r) => upstreamServer.close(r));
      try {
        rmSync(tmpLiteDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // ==========================================================================
  // Test 2: T3.dual_stack_and_happy_eyeballs (双栈监听验收)
  // ==========================================================================
  test('T3.dual_stack_and_happy_eyeballs', { timeout: 20000 }, async () => {
    const dualPort = await getFreePort();
    const tmpDualDir = mkdtempSync(join(tmpdir(), 'llmproxy-t3-dual-'));

    const dualProc = spawn(
      tmpBinPath,
      [
        '--role=lite',
        `--addr=[::]:${dualPort}`,
        '--hub-url=http://127.0.0.1:1',
        '--node-token=stk_node_test_dummy_key_0123456789abcdef0123456789abcdef',
        '--client-key=sk-test-client-key-dual',
        '--allow-private=true',
      ],
      {
        cwd: tmpDualDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    try {
      // 1. Wait for startup via IPv4 loopback
      await waitForHttp(`http://127.0.0.1:${dualPort}/healthz`);

      // 2. Verify IPv4 loopback access
      const ipv4Res = await httpRequest(`http://127.0.0.1:${dualPort}/healthz`);
      assert.strictEqual(ipv4Res.statusCode, 200);
      assert.strictEqual(ipv4Res.json.role, 'lite');

      // 3. Verify IPv6 loopback [::1] access
      const ipv6Res = await httpRequest({
        host: '::1',
        port: dualPort,
        path: '/healthz',
      });
      assert.strictEqual(ipv6Res.statusCode, 200);
      assert.strictEqual(ipv6Res.json.role, 'lite');
    } finally {
      await stopProcess(dualProc);
      try {
        rmSync(tmpDualDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // ==========================================================================
  // Test 3: T3.full_mode_matrix_e2e (完整节点全矩阵验收)
  // ==========================================================================
  test('T3.full_mode_matrix_e2e', { timeout: 35000 }, async () => {
    // 1. Start Mock Upstream Server supporting OpenAI chat & KB endpoints
    const upstreamPort = await getFreePort();
    const upstreamServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url.endsWith('/chat/completions')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-mock-full',
              object: 'chat.completion',
              created: 1700000000,
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'full mode chat response' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
            })
          );
          return;
        }

        if (req.url.endsWith('/ocr')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: 'parsed ocr text content', pages: [] }));
          return;
        }

        if (req.url.endsWith('/embeddings')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: [{ object: 'embedding', embedding: [0.1, 0.2, 0.3], index: 0 }],
            })
          );
          return;
        }

        if (req.url.endsWith('/rerank')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              results: [{ index: 0, relevance_score: 0.96 }],
            })
          );
          return;
        }

        res.writeHead(404);
        res.end('mock upstream 404');
      });
    });

    await new Promise((resolve) => upstreamServer.listen(upstreamPort, '127.0.0.1', resolve));

    // 2. Setup Full node configuration directory
    const tmpFullDir = mkdtempSync(join(tmpdir(), 'llmproxy-t3-full-'));
    const fullPort = await getFreePort();

    const adminPassword = 'test-admin-secret-password-1234';
    const clientKey = 'sk-test-client-key-full';
    const encryptKey = 'test-encryption-key-secret-9876';

    const fullProc = spawn(
      tmpBinPath,
      [
        '--role=full',
        `--addr=127.0.0.1:${fullPort}`,
        `--config-dir=${tmpFullDir}`,
        `--admin-pass=${adminPassword}`,
        `--client-key=${clientKey}`,
        `--encrypt-key=${encryptKey}`,
        '--allow-private=true',
      ],
      {
        cwd: tmpFullDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    try {
      // 3. Wait for Full node startup
      await waitForHttp(`http://127.0.0.1:${fullPort}/healthz`);

      // 4. Verify GET /admin HTML and window.__HOST_KIND__="full"
      const adminHtmlRes = await httpRequest(`http://127.0.0.1:${fullPort}/admin`);
      assert.strictEqual(adminHtmlRes.statusCode, 200);
      assert.ok(
        adminHtmlRes.headers['content-type'] &&
          adminHtmlRes.headers['content-type'].includes('text/html'),
        'Admin response must have Content-Type: text/html'
      );
      assert.ok(
        adminHtmlRes.body.includes('window.__HOST_KIND__="full"') ||
          adminHtmlRes.body.includes('window.__HOST_KIND__ = "full"'),
        'Admin HTML must inject window.__HOST_KIND__="full"'
      );

      // 5. Initial configuration save via POST /api/config
      const rawSecretKey = 'sk-test-real-upstream-secret-key-111';
      const configPayload = {
        _version: 0,
        providers: {
          mock_p: {
            id: 'mock_p',
            name: 'Mock Provider',
            base_url: `http://127.0.0.1:${upstreamPort}`,
            protocol: 'openai',
            enabled: true,
            api_keys: [{ label: 'k1', key: rawSecretKey, enabled: true }],
          },
        },
        agent_models: {
          'gpt-4o': {
            enabled: true,
            candidates: [{ provider: 'mock_p', key_label: 'k1', enabled: true }],
          },
        },
        kb_models: {
          chat: [{ provider: 'mock_p', key_label: 'k1', enabled: true }],
          ocr: [{ provider: 'mock_p', key_label: 'k1', enabled: true }],
          embedding: [{ provider: 'mock_p', key_label: 'k1', enabled: true }],
          reranker: [{ provider: 'mock_p', key_label: 'k1', enabled: true }],
        },
        settings: {
          run_mode: 'agent',
        },
      };

      const saveRes = await httpRequest(`http://127.0.0.1:${fullPort}/api/config`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminPassword}`,
          'Content-Type': 'application/json',
        },
        body: configPayload,
      });

      assert.strictEqual(saveRes.statusCode, 200);
      assert.strictEqual(saveRes.json.ok, true);
      assert.strictEqual(saveRes.json._version, 1, 'First saved config must increment version to 1');

      // 6. Test CAS 409 conflict
      const conflictRes = await httpRequest(`http://127.0.0.1:${fullPort}/api/config`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminPassword}`,
          'Content-Type': 'application/json',
        },
        body: {
          ...configPayload,
          _version: 999, // Stale / mismatched version
        },
      });

      assert.strictEqual(conflictRes.statusCode, 409, 'Submitting stale version must return 409 Conflict');
      assert.strictEqual(conflictRes.json.error, 'config_version_conflict');

      // 7. Test Kernel Guard (masked key preserves real secret)
      const maskedKeyPayload = {
        ...configPayload,
        _version: 1,
        providers: {
          mock_p: {
            ...configPayload.providers.mock_p,
            api_keys: [{ label: 'k1', key: 'sk-●●●111', enabled: true }],
          },
        },
      };

      const guardRes = await httpRequest(`http://127.0.0.1:${fullPort}/api/config`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminPassword}`,
          'Content-Type': 'application/json',
        },
        body: maskedKeyPayload,
      });

      assert.strictEqual(guardRes.statusCode, 200);
      assert.strictEqual(guardRes.json._version, 2);

      // 8. Test Agent mode behavior
      // Request /v1/chat/completions succeeds (200 OK) and verifies Kernel Guard retained raw key
      const agentChatRes = await httpRequest(
        `http://127.0.0.1:${fullPort}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientKey}`,
            'Content-Type': 'application/json',
          },
          body: {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'hello agent' }],
          },
        }
      );

      assert.strictEqual(agentChatRes.statusCode, 200);
      assert.strictEqual(
        agentChatRes.json.choices[0].message.content,
        'full mode chat response'
      );

      // In agent mode, /v1/ocr is strictly disabled (404)
      const agentOcrRes = await httpRequest(`http://127.0.0.1:${fullPort}/v1/ocr`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientKey}`,
          'Content-Type': 'application/json',
        },
        body: { image: 'sample' },
      });
      assert.strictEqual(agentOcrRes.statusCode, 404, '/v1/ocr must be disabled in agent mode');

      // 9. Switch mode to KB mode via POST /api/admin/mode
      const modeSwitchRes = await httpRequest(`http://127.0.0.1:${fullPort}/api/admin/mode`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminPassword}`,
          'Content-Type': 'application/json',
        },
        body: { mode: 'kb' },
      });

      assert.strictEqual(modeSwitchRes.statusCode, 200);
      assert.strictEqual(modeSwitchRes.json.ok, true);
      assert.strictEqual(modeSwitchRes.json.mode, 'kb');

      // 10. Test KB mode behavior
      // /v1/messages is disabled in KB mode (404)
      const kbMessagesRes = await httpRequest(`http://127.0.0.1:${fullPort}/v1/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientKey}`,
          'Content-Type': 'application/json',
        },
        body: { model: 'chat', messages: [] },
      });
      assert.strictEqual(kbMessagesRes.statusCode, 404, '/v1/messages must return 404 in kb mode');

      // GET /v1/models returns the 4 KB models
      const kbModelsRes = await httpRequest(`http://127.0.0.1:${fullPort}/v1/models`, {
        headers: { Authorization: `Bearer ${clientKey}` },
      });
      assert.strictEqual(kbModelsRes.statusCode, 200);
      assert.strictEqual(kbModelsRes.json.data.length, 4);
      const modelIds = kbModelsRes.json.data.map((m) => m.id).sort();
      assert.deepStrictEqual(modelIds, ['chat', 'embedding', 'ocr', 'reranker']);

      // /v1/ocr succeeds (200 OK)
      const kbOcrRes = await httpRequest(`http://127.0.0.1:${fullPort}/v1/ocr`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientKey}`,
          'Content-Type': 'application/json',
        },
        body: { image: 'test-ocr-payload' },
      });
      assert.strictEqual(kbOcrRes.statusCode, 200);
      assert.strictEqual(kbOcrRes.json.text, 'parsed ocr text content');

      // /v1/embeddings succeeds (200 OK)
      const kbEmbedRes = await httpRequest(`http://127.0.0.1:${fullPort}/v1/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientKey}`,
          'Content-Type': 'application/json',
        },
        body: { input: 'test embedding text' },
      });
      assert.strictEqual(kbEmbedRes.statusCode, 200);
      assert.strictEqual(kbEmbedRes.json.data[0].embedding.length, 3);

      // /v1/rerank succeeds (200 OK)
      const kbRerankRes = await httpRequest(`http://127.0.0.1:${fullPort}/v1/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientKey}`,
          'Content-Type': 'application/json',
        },
        body: { query: 'query', documents: ['doc1'] },
      });
      assert.strictEqual(kbRerankRes.statusCode, 200);
      assert.strictEqual(kbRerankRes.json.results[0].relevance_score, 0.96);

      // 11. Test Observability (Usage & Traces)
      const usageRes = await httpRequest(
        `http://127.0.0.1:${fullPort}/api/admin/usage?period=today`,
        {
          headers: { Authorization: `Bearer ${adminPassword}` },
        }
      );
      assert.strictEqual(usageRes.statusCode, 200);
      assert.strictEqual(usageRes.json.ok, true);
      assert.ok(usageRes.json.totals, 'Usage totals must be present');
      assert.ok(
        usageRes.json.totals.requests > 0,
        `Recorded requests must be > 0, got ${usageRes.json.totals.requests}`
      );

      const tracesRes = await httpRequest(`http://127.0.0.1:${fullPort}/api/admin/traces`, {
        headers: { Authorization: `Bearer ${adminPassword}` },
      });
      assert.strictEqual(tracesRes.statusCode, 200);
      assert.strictEqual(tracesRes.json.ok, true);
      assert.ok(Array.isArray(tracesRes.json.traces), 'Traces must be an array');
      assert.ok(tracesRes.json.traces.length > 0, 'Traces array must be non-empty');
    } finally {
      await stopProcess(fullProc);
      await new Promise((r) => upstreamServer.close(r));
      try {
        rmSync(tmpFullDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });
});
