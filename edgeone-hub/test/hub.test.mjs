import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleConfigRequest } from '../api/config.js';
import { handleNodesRequest } from '../api/admin/nodes.js';
import { handleNodeConfigRequest } from '../api/node/config.js';
import { handleVaultManifestRequest } from '../api/vault/manifest.js';
import { handleVaultFetchRequest } from '../api/vault/fetch.js';
import { handleVerifyKey } from '../api/admin/verify-key.js';
import { handleProbeModels } from '../api/admin/probe-models.js';
import { CONFIG_KV_KEY, loadConfig, resolveKvBinding, resolveEnv } from '../lib/config.js';
import { generateNodeToken, hashToken, constantTimeCompare, computeEtag } from '../lib/crypto.js';
import * as edgeAdmin from '../../edge-functions/admin.js';
import * as edgeIndex from '../../edge-functions/index.js';
import * as edgeHealth from '../../edge-functions/health.js';
import * as edgeHealthz from '../../edge-functions/healthz.js';
import * as edgeConfig from '../../edge-functions/api/config.js';
import * as edgeAdminNodes from '../../edge-functions/api/admin/nodes.js';
import * as edgeNodeConfig from '../../edge-functions/api/node/config.js';

class MockKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.get(key) || null;
  }
  async put(key, val) {
    this.store.set(key, val);
  }
  async delete(key) {
    this.store.delete(key);
  }
}

const TEST_ENV = { ADMIN_PASSWORD: 'test_admin_pwd' };

function makeAdminReq(method, path, body = null) {
  const init = {
    method,
    headers: {
      'authorization': 'Bearer test_admin_pwd',
      'content-type': 'application/json',
    },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://hub.example.com${path}`, init);
}

function makeNodeReq(method, path, token, ifNoneMatch = null) {
  const headers = {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (ifNoneMatch) {
    headers['if-none-match'] = ifNoneMatch;
  }
  return new Request(`https://hub.example.com${path}`, {
    method,
    headers,
  });
}

describe('EdgeOne Makers Lightweight Hub Test Suite', () => {
  let kv;

  beforeEach(() => {
    kv = new MockKV();
  });

  describe('1. CAS Optimistic Locking & Versioning', () => {
    test('Initial config starts at _version 1 and saves incrementing to _version 2', async () => {
      // 1. Initial GET
      const getReq = makeAdminReq('GET', '/api/config');
      const getResp = await handleConfigRequest(getReq, TEST_ENV, kv);
      assert.equal(getResp.status, 200);
      const data = await getResp.json();
      assert.equal(data._version, 1);

      // 2. First update with matching version
      const updateReq = makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {
          minimax: {
            name: 'MiniMax',
            enabled: true,
            base_url: 'https://api.minimaxi.com/v1',
            api_keys: [{ id: 'k1', label: 'prod-01', key: 'sk-minimax-secret-12345678', enabled: true }],
          },
        },
      });
      const updateResp = await handleConfigRequest(updateReq, TEST_ENV, kv);
      assert.equal(updateResp.status, 200);
      const updateData = await updateResp.json();
      assert.equal(updateData._version, 2);

      // 3. Update with stale version (1 instead of 2) -> 409 Conflict
      const staleReq = makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {},
      });
      const staleResp = await handleConfigRequest(staleReq, TEST_ENV, kv);
      assert.equal(staleResp.status, 409);
      const staleData = await staleResp.json();
      assert.equal(staleData.error, 'config_version_conflict');
      assert.equal(staleData.current_version, 2);
      assert.equal(staleData.submitted_version, 1);
    });
  });

  describe('2. Kernel Guard: Preventing Mask Overwrite', () => {
    test('Kernel Guard restores original secret when UI submits masked ● key', async () => {
      // 1. Save original real secret
      const saveReq = makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {
          deepseek: {
            name: 'DeepSeek',
            enabled: true,
            base_url: 'https://api.deepseek.com/v1',
            api_keys: [{ id: 'ds_key_1', label: 'pool-01', key: 'sk-real-deepseek-secret-999', enabled: true }],
          },
        },
      });
      const saveResp = await handleConfigRequest(saveReq, TEST_ENV, kv);
      assert.equal(saveResp.status, 200);

      // 2. GET returns masked key
      const getReq = makeAdminReq('GET', '/api/config');
      const getResp = await handleConfigRequest(getReq, TEST_ENV, kv);
      const getData = await getResp.json();
      const maskedKeyVal = getData.providers.deepseek.api_keys[0].key;
      assert.match(maskedKeyVal, /●/);
      assert.doesNotMatch(maskedKeyVal, /secret-999/);

      // 3. UI sends back the masked key while modifying provider name
      const uiUpdateReq = makeAdminReq('POST', '/api/config', {
        _version: 2,
        providers: {
          deepseek: {
            name: 'DeepSeek AI Official',
            enabled: true,
            base_url: 'https://api.deepseek.com/v1',
            api_keys: [{ id: 'ds_key_1', label: 'pool-01', key: maskedKeyVal, enabled: true }],
          },
        },
      });
      const uiResp = await handleConfigRequest(uiUpdateReq, TEST_ENV, kv);
      assert.equal(uiResp.status, 200);

      // 4. Verify unmasked secret in KV directly
      const rawStored = await loadConfig(kv);
      const actualKeyInStorage = rawStored.providers.deepseek.api_keys[0].key;
      assert.equal(actualKeyInStorage, 'sk-real-deepseek-secret-999');
    });
  });

  describe('3. Node Token Issuance, Rotation & Revocation', () => {
    test('Issue node, check format stk_node_<48hex>, rotate and revoke', async () => {
      // 1. Issue Node
      const issueReq = makeAdminReq('POST', '/api/admin/nodes', {
        name: 'HK NAT 01',
        role: 'lite',
        lease_ttl: 86400,
        grace_ttl: 3600,
        scope: {
          models: ['*'],
          providers: ['minimax', 'deepseek'],
        },
      });
      const issueResp = await handleNodesRequest(issueReq, TEST_ENV, kv);
      assert.equal(issueResp.status, 200);
      const issueData = await issueResp.json();
      assert.equal(issueData.ok, true);
      assert.match(issueData.node_token, /^stk_node_[a-f0-9]{48}$/);
      assert.equal(issueData.node.role, 'lite');
      assert.equal(issueData.node.enabled, true);

      const nodeId = issueData.node.id;
      const initialToken = issueData.node_token;

      // 2. List nodes (token_sha256 hidden)
      const listReq = makeAdminReq('GET', '/api/admin/nodes');
      const listResp = await handleNodesRequest(listReq, TEST_ENV, kv);
      const listData = await listResp.json();
      assert.equal(listData.nodes.length, 1);
      assert.equal(listData.nodes[0].id, nodeId);
      assert.equal(listData.nodes[0].token_sha256, undefined);
      assert.match(listData.nodes[0].token_prefix, /^stk_node_/);

      // 3. Rotate token
      const rotateReq = makeAdminReq('POST', `/api/admin/nodes/${nodeId}/rotate`);
      const rotateResp = await handleNodesRequest(rotateReq, TEST_ENV, kv);
      assert.equal(rotateResp.status, 200);
      const rotateData = await rotateResp.json();
      assert.match(rotateData.node_token, /^stk_node_[a-f0-9]{48}$/);
      assert.notEqual(rotateData.node_token, initialToken);

      // 4. Revoke (PATCH enabled: false)
      const patchReq = makeAdminReq('PATCH', `/api/admin/nodes/${nodeId}`, { enabled: false });
      const patchResp = await handleNodesRequest(patchReq, TEST_ENV, kv);
      assert.equal(patchResp.status, 200);
      const patchData = await patchResp.json();
      assert.equal(patchData.node.enabled, false);

      // 5. Delete Node
      const delReq = makeAdminReq('DELETE', `/api/admin/nodes/${nodeId}`);
      const delResp = await handleNodesRequest(delReq, TEST_ENV, kv);
      assert.equal(delResp.status, 200);

      const listAfterDel = await (await handleNodesRequest(listReq, TEST_ENV, kv)).json();
      assert.equal(listAfterDel.nodes.length, 0);
    });
  });

  describe('4. Node Config Projection & Invariants', () => {
    test('Passive projection, physical zero-leak, ETag 304, and 401 revocation', async () => {
      // Setup Config with:
      // - Provider 1: vault shared (minimax)
      // - Provider 2: local private (vertex_local) -> MUST BE FILTERED
      // - Provider 1 has 1 vault key and 1 local key -> local key MUST BE FILTERED
      await handleConfigRequest(
        makeAdminReq('POST', '/api/config', {
          _version: 1,
          providers: {
            minimax: {
              name: 'MiniMax',
              preset_id: 'minimax',
              origin: 'vault',
              enabled: true,
              base_url: 'https://api.minimaxi.com/v1',
              api_keys: [
                { id: 'k_shared', label: 'shared-pool', key: 'sk-shared-key-111', enabled: true, origin: 'vault' },
                { id: 'k_priv', label: 'local-private', key: 'sk-private-key-222', enabled: true, origin: 'local' },
              ],
            },
            vertex_local: {
              name: 'Vertex Private',
              origin: 'local',
              enabled: true,
              base_url: 'https://vertex.local',
              api_keys: [{ id: 'k_v', label: 'priv-v', key: 'sk-vertex-priv-333', enabled: true }],
            },
          },
          agent_models: {
            'MiniMax-M2.5': {
              enabled: true,
              candidates: [{ provider: 'minimax', key_label: 'shared-pool', enabled: true }],
            },
          },
        }),
        TEST_ENV,
        kv
      );

      // Issue Node
      const issueRes = await (
        await handleNodesRequest(
          makeAdminReq('POST', '/api/admin/nodes', {
            name: 'Lite Node',
            role: 'lite',
            lease_ttl: 86400,
            grace_ttl: 3600,
            scope: { models: ['*'], providers: ['*'] },
          }),
          TEST_ENV,
          kv
        )
      ).json();

      const nodeToken = issueRes.node_token;
      const nodeId = issueRes.node.id;

      // 1. Initial POST /api/node/config -> 200 OK
      const projReq = makeNodeReq('POST', '/api/node/config', nodeToken);
      const projResp = await handleNodeConfigRequest(projReq, TEST_ENV, kv);
      assert.equal(projResp.status, 200);

      const etag = projResp.headers.get('etag');
      assert.ok(etag, 'ETag must be present');
      assert.ok(projResp.headers.get('x-config-version'), 'X-Config-Version must be present');
      assert.ok(projResp.headers.get('x-lease-until'), 'X-Lease-Until must be present');
      assert.ok(projResp.headers.get('x-grace-until'), 'X-Grace-Until must be present');

      const projData = await projResp.json();
      assert.equal(projData.ok, true);

      // PHYSICAL ZERO-LEAK ASSERTIONS:
      // 1. vertex_local provider MUST NOT EXIST
      assert.equal(projData.payload.providers.vertex_local, undefined, 'Provider with origin=local must be excluded');
      // 2. minimax provider MUST EXIST
      assert.ok(projData.payload.providers.minimax, 'Shared provider must be present');
      // 3. local private key MUST NOT EXIST in minimax
      const returnedKeys = projData.payload.providers.minimax.api_keys;
      assert.equal(returnedKeys.length, 1);
      assert.equal(returnedKeys[0].label, 'shared-pool');
      assert.equal(returnedKeys[0].key, 'sk-shared-key-111');
      assert.equal(returnedKeys[0].origin, 'vault');

      // 2. ETag 304 Zero-Payload Keepalive
      const keepaliveReq = makeNodeReq('POST', '/api/node/config', nodeToken, etag);
      const keepaliveResp = await handleNodeConfigRequest(keepaliveReq, TEST_ENV, kv);
      assert.equal(keepaliveResp.status, 304, 'Must return 304 Not Modified on ETag match');
      const bodyBytes = await keepaliveResp.arrayBuffer();
      assert.equal(bodyBytes.byteLength, 0, '304 must return 0 payload bytes');
      assert.ok(keepaliveResp.headers.get('x-lease-until'));

      // 3. 401 Interception when revoked
      await handleNodesRequest(makeAdminReq('PATCH', `/api/admin/nodes/${nodeId}`, { enabled: false }), TEST_ENV, kv);

      const revokedReq = makeNodeReq('POST', '/api/node/config', nodeToken);
      const revokedResp = await handleNodeConfigRequest(revokedReq, TEST_ENV, kv);
      assert.equal(revokedResp.status, 401, 'Revoked node must receive 401 Unauthorized');
      const revokedData = await revokedResp.json();
      assert.equal(revokedData.error, 'node_revoked_or_invalid');

      // 4. Invalid token -> 401
      const badReq = makeNodeReq('POST', '/api/node/config', 'stk_node_000000000000000000000000000000000000000000000000');
      const badResp = await handleNodeConfigRequest(badReq, TEST_ENV, kv);
      assert.equal(badResp.status, 401);
    });
  });

  describe('5. Vault Manifest & Fetch with Local Protection', () => {
    test('Vault manifest hides secrets; fetch returns single key; local excluded', async () => {
      await handleConfigRequest(
        makeAdminReq('POST', '/api/config', {
          _version: 1,
          providers: {
            openrouter: {
              name: 'OpenRouter',
              preset_id: 'openrouter',
              enabled: true,
              api_keys: [{ id: 'k1', label: 'pool-open', key: 'sk-or-sec-111', enabled: true }],
            },
            private_prov: {
              name: 'Private',
              origin: 'local',
              enabled: true,
              api_keys: [{ id: 'kp', label: 'priv', key: 'sk-secret-local', enabled: true }],
            },
          },
        }),
        TEST_ENV,
        kv
      );

      // 1. Manifest
      const mfReq = makeAdminReq('GET', '/api/vault/manifest');
      const mfResp = await handleVaultManifestRequest(mfReq, TEST_ENV, kv);
      assert.equal(mfResp.status, 200);
      const mfData = await mfResp.json();
      assert.ok(mfData.providers.openrouter);
      assert.deepEqual(mfData.providers.openrouter.keys, ['pool-open']);
      assert.equal(mfData.providers.private_prov, undefined, 'Local provider omitted from manifest');

      // 2. Fetch shared key
      const ftReq = makeAdminReq('POST', '/api/vault/fetch', {
        provider: 'openrouter',
        key_label: 'pool-open',
      });
      const ftResp = await handleVaultFetchRequest(ftReq, TEST_ENV, kv);
      assert.equal(ftResp.status, 200);
      const ftData = await ftResp.json();
      assert.equal(ftData.provider_config.keys['pool-open'], 'sk-or-sec-111');

      // 3. Fetch local key -> 404
      const ftPrivReq = makeAdminReq('POST', '/api/vault/fetch', {
        provider: 'private_prov',
      });
      const ftPrivResp = await handleVaultFetchRequest(ftPrivReq, TEST_ENV, kv);
      assert.equal(ftPrivResp.status, 404);
    });
  });

  describe('6. Key Verification (handleVerifyKey)', () => {
    test('Rejects unauthenticated requests with 401', async () => {
      const unauthReq = new Request('https://hub.example.com/api/admin/verify-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'minimax', api_key: 'sk-test' }),
      });
      const resp = await handleVerifyKey(unauthReq, TEST_ENV);
      assert.equal(resp.status, 401);
    });

    test('Validates required parameters and masked key detection', async () => {
      // 1. Missing api_key
      const noKeyReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'minimax',
        base_url: 'https://api.minimaxi.com/v1',
      });
      const noKeyResp = await handleVerifyKey(noKeyReq, TEST_ENV);
      assert.equal(noKeyResp.status, 400);
      const noKeyData = await noKeyResp.json();
      assert.equal(noKeyData.error, 'api_key_required');

      // 2. Masked key -> returns valid: false without making outbound call
      const maskedReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'minimax',
        base_url: 'https://api.minimaxi.com/v1',
        api_key: 'sk-●●●●●●1234',
      });
      const maskedResp = await handleVerifyKey(maskedReq, TEST_ENV);
      assert.equal(maskedResp.status, 200);
      const maskedData = await maskedResp.json();
      assert.equal(maskedData.ok, true);
      assert.equal(maskedData.valid, false);
      assert.equal(maskedData.error, 'cannot_verify_masked_key');

      // 3. Missing base_url with unknown provider
      const noUrlReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'unknown_custom_provider',
        api_key: 'sk-valid-format-key',
      });
      const noUrlResp = await handleVerifyKey(noUrlReq, TEST_ENV);
      assert.equal(noUrlResp.status, 400);
      const noUrlData = await noUrlResp.json();
      assert.equal(noUrlData.error, 'base_url_required');
    });

    test('Successful key verification calls upstream and returns valid: true with models count', async () => {
      let calledUrl = '';
      let calledHeaders = {};

      const mockFetch = async (url, opts) => {
        calledUrl = url;
        calledHeaders = opts.headers || {};
        return new Response(
          JSON.stringify({
            data: [{ id: 'MiniMax-M2.5' }, { id: 'MiniMax-M3' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      const verifyReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'minimax',
        base_url: 'https://api.minimaxi.com/v1',
        api_key: 'sk-real-minimax-token-12345',
      });

      const resp = await handleVerifyKey(verifyReq, TEST_ENV, mockFetch);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.ok, true);
      assert.equal(data.valid, true);
      assert.equal(data.status, 200);
      assert.equal(data.models_count, 2);
      assert.ok(typeof data.latency_ms === 'number');

      // Verify outbound request details
      assert.ok(calledUrl.startsWith('https://api.minimaxi.com/v1'));
      assert.ok(calledUrl.endsWith('/models'));
      assert.equal(calledHeaders.authorization, 'Bearer sk-real-minimax-token-12345');
    });

    test('Key verification failure scrubs plain secret from error message', async () => {
      const secretToScrub = 'sk-super-secret-leaked-key-998877';
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: `Authentication failed: key ${secretToScrub} is invalid or expired.`,
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        );
      };

      const verifyReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'minimax',
        base_url: 'https://api.minimaxi.com/v1',
        api_key: secretToScrub,
      });

      const resp = await handleVerifyKey(verifyReq, TEST_ENV, mockFetch);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.ok, true);
      assert.equal(data.valid, false);
      assert.equal(data.status, 401);
      assert.ok(data.error);
      assert.equal(data.error.includes(secretToScrub), false, 'Plain API key must NOT be leaked in error message');
      assert.ok(data.error.includes('[REDACTED]'));
    });

    test('Network error during verification returns valid: false with status 0 and scrubs errors', async () => {
      const mockFetch = async () => {
        throw new Error('connect ECONNREFUSED for sk-super-private-token-1122');
      };

      const verifyReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'minimax',
        base_url: 'https://api.minimaxi.com/v1',
        api_key: 'sk-super-private-token-1122',
      });

      const resp = await handleVerifyKey(verifyReq, TEST_ENV, mockFetch);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.ok, true);
      assert.equal(data.valid, false);
      assert.equal(data.status, 0);
      assert.equal(data.error.includes('sk-super-private-token-1122'), false);
    });

    test('Handles Anthropic headers and automatic base_url lookup from presets', async () => {
      let calledUrl = '';
      let calledHeaders = {};

      const mockFetch = async (url, opts) => {
        calledUrl = url;
        calledHeaders = opts.headers || {};
        return new Response(
          JSON.stringify({ data: [{ id: 'claude-3-7-sonnet' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      // 1. Anthropic headers
      const antReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'anthropic',
        base_url: 'https://api.anthropic.com/v1',
        api_key: 'sk-ant-test-key-555',
      });
      await handleVerifyKey(antReq, TEST_ENV, mockFetch);
      assert.equal(calledHeaders['x-api-key'], 'sk-ant-test-key-555');
      assert.equal(calledHeaders['anthropic-version'], '2023-06-01');

      // 2. Auto base_url lookup for deepseek preset
      const dsReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'deepseek',
        api_key: 'sk-ds-key-12345678',
      });
      await handleVerifyKey(dsReq, TEST_ENV, mockFetch);
      assert.ok(calledUrl.startsWith('https://api.deepseek.com'));
      assert.ok(calledUrl.endsWith('/models'));
    });
  });

  describe('7. Model List Probing (handleProbeModels)', () => {
    test('Rejects unauthenticated requests with 401', async () => {
      const unauthReq = new Request('https://hub.example.com/api/admin/probe-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'minimax', api_key: 'sk-test' }),
      });
      const resp = await handleProbeModels(unauthReq, TEST_ENV);
      assert.equal(resp.status, 401);
    });

    test('Validates required parameters and masked key detection', async () => {
      const maskedReq = makeAdminReq('POST', '/api/admin/probe-models', {
        provider: 'minimax',
        base_url: 'https://api.minimaxi.com/v1',
        api_key: 'sk-●●●●●●1234',
      });
      const maskedResp = await handleProbeModels(maskedReq, TEST_ENV);
      assert.equal(maskedResp.status, 400);
      const maskedData = await maskedResp.json();
      assert.equal(maskedData.error, 'cannot_probe_with_masked_key');
    });

    test('Probes models and parses list (OpenAI shape & Gemini shape)', async () => {
      // 1. OpenAI shape: { data: [{ id: 'model-b' }, { id: 'model-a' }] }
      const mockFetchOpenAI = async () => {
        return new Response(
          JSON.stringify({
            data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      const req1 = makeAdminReq('POST', '/api/admin/probe-models', {
        provider: 'minimax',
        base_url: 'https://api.minimaxi.com/v1',
        api_key: 'sk-test-token',
      });
      const resp1 = await handleProbeModels(req1, TEST_ENV, mockFetchOpenAI);
      assert.equal(resp1.status, 200);
      const data1 = await resp1.json();
      assert.equal(data1.ok, true);
      assert.deepEqual(data1.models, ['model-a', 'model-b']);

      // 2. Gemini shape: { models: [{ name: 'models/gemini-2.5-flash' }] }
      const mockFetchGemini = async () => {
        return new Response(
          JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      const req2 = makeAdminReq('POST', '/api/admin/probe-models', {
        provider: 'google',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
        api_key: 'AIza-test-gemini-key',
      });
      const resp2 = await handleProbeModels(req2, TEST_ENV, mockFetchGemini);
      assert.equal(resp2.status, 200);
      const data2 = await resp2.json();
      assert.equal(data2.ok, true);
      assert.deepEqual(data2.models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
    });

    test('Probe failure returns error without leaking secret', async () => {
      const secret = 'sk-probe-fail-key-abcdef';
      const mockFetchFail = async () => {
        return new Response(
          JSON.stringify({
            error: { message: `Unauthorized access for token ${secret}` },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } }
        );
      };

      const failReq = makeAdminReq('POST', '/api/admin/probe-models', {
        provider: 'minimax',
        base_url: 'https://api.minimaxi.com/v1',
        api_key: secret,
      });
      const resp = await handleProbeModels(failReq, TEST_ENV, mockFetchFail);
      assert.equal(resp.status, 403);
      const data = await resp.json();
      assert.equal(data.ok, false);
      assert.equal(data.status, 403);
      assert.equal(data.error.includes(secret), false, 'API key must NOT be leaked');
      assert.ok(data.error.includes('[REDACTED]'));
    });
  });

  describe('8. EdgeOne Pages onRequest Standard Runtime & Bindings Adapter', () => {
    test('resolveKvBinding resolves KV from all EdgeOne Pages / Makers injection styles', () => {
      const mockKv = new MockKV();

      // 1. Explicit KV parameter
      assert.strictEqual(resolveKvBinding({}, mockKv), mockKv);

      // 2. Candidate names on context
      assert.strictEqual(resolveKvBinding({ agent_kv: mockKv }), mockKv);
      assert.strictEqual(resolveKvBinding({ ocrproxy_kv: mockKv }), mockKv);
      assert.strictEqual(resolveKvBinding({ my_kv: mockKv }), mockKv);
      assert.strictEqual(resolveKvBinding({ kv: mockKv }), mockKv);
      assert.strictEqual(resolveKvBinding({ KV_NAMESPACE: mockKv }), mockKv);
      assert.strictEqual(resolveKvBinding({ __MOCK_KV__: mockKv }), mockKv);

      // 3. Candidate names on context.env
      assert.strictEqual(resolveKvBinding({ env: { KV: mockKv } }), mockKv);
      assert.strictEqual(resolveKvBinding({ env: { EDGE_KV: mockKv } }), mockKv);
      assert.strictEqual(resolveKvBinding({ env: { agent_kv: mockKv } }), mockKv);

      // 4. Candidate names on context.bindings
      assert.strictEqual(resolveKvBinding({ bindings: { EDGE_KV: mockKv } }), mockKv);
      assert.strictEqual(resolveKvBinding({ bindings: { agent_kv: mockKv } }), mockKv);

      // 5. Duck-typing scan: unknown property with .get and .put
      const customStore = {
        async get(k) { return null; },
        async put(k, v) {},
      };
      assert.strictEqual(resolveKvBinding({ custom_db_instance: customStore }), customStore);
      assert.strictEqual(resolveKvBinding({ bindings: { nested_store: customStore } }), customStore);

      // 6. Direct KV passed as context
      assert.strictEqual(resolveKvBinding(mockKv), mockKv);

      // 7. No KV returns undefined
      assert.strictEqual(resolveKvBinding({}), undefined);
      assert.strictEqual(resolveKvBinding(null), undefined);
    });

    test('resolveEnv resolves ADMIN_PASSWORD from context.env, context, or process.env', () => {
      // 1. From context.env
      const env1 = resolveEnv({ env: { ADMIN_PASSWORD: 'from_context_env' } });
      assert.strictEqual(env1.ADMIN_PASSWORD, 'from_context_env');

      // 2. From context root
      const env2 = resolveEnv({ ADMIN_PASSWORD: 'from_context_root' });
      assert.strictEqual(env2.ADMIN_PASSWORD, 'from_context_root');

      // 3. Priority: context.env > context
      const env3 = resolveEnv({
        ADMIN_PASSWORD: 'lower_priority',
        env: { ADMIN_PASSWORD: 'higher_priority' },
      });
      assert.strictEqual(env3.ADMIN_PASSWORD, 'higher_priority');
    });

    test('edge-functions/admin.js renders Hub Admin Console with __HOST_KIND__="hub"', async () => {
      const req = new Request('https://hub.example.com/admin', { method: 'GET' });
      const context = { request: req, env: TEST_ENV };

      const resp = await edgeAdmin.onRequestGet(context);
      assert.strictEqual(resp.status, 200);
      assert.strictEqual(resp.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.strictEqual(resp.headers.get('cache-control'), 'no-store');

      const html = await resp.text();
      assert.ok(html.includes('window.__HOST_KIND__="hub"'), 'Must inject window.__HOST_KIND__="hub"');
      assert.ok(html.includes('<!DOCTYPE html>'));

      // onRequest generic handler
      const resp2 = await edgeAdmin.onRequest(context);
      assert.strictEqual(resp2.status, 200);
    });

    test('edge-functions/index.js redirects GET / to /admin', async () => {
      const req = new Request('https://hub.example.com/', { method: 'GET' });
      const context = { request: req, env: TEST_ENV };

      const resp = await edgeIndex.onRequestGet(context);
      assert.strictEqual(resp.status, 302);
      assert.strictEqual(resp.headers.get('location'), '/admin');
      assert.strictEqual(resp.headers.get('cache-control'), 'no-store');
    });

    test('edge-functions/health.js and healthz.js report hub status and kv_bound accurately', async () => {
      const mockKv = new MockKV();

      // With KV bound
      const req1 = new Request('https://hub.example.com/health', { method: 'GET' });
      const ctxWithKv = { request: req1, agent_kv: mockKv };
      const resp1 = await edgeHealth.onRequest(ctxWithKv);
      assert.strictEqual(resp1.status, 200);
      const data1 = await resp1.json();
      assert.strictEqual(data1.status, 'ok');
      assert.strictEqual(data1.role, 'hub');
      assert.strictEqual(data1.kv_bound, true);
      assert.ok(data1.timestamp);

      // Without KV bound
      const req2 = new Request('https://hub.example.com/healthz', { method: 'GET' });
      const ctxNoKv = { request: req2 };
      const resp2 = await edgeHealthz.onRequest(ctxNoKv);
      assert.strictEqual(resp2.status, 200);
      const data2 = await resp2.json();
      assert.strictEqual(data2.status, 'ok');
      assert.strictEqual(data2.role, 'hub');
      assert.strictEqual(data2.kv_bound, false);
    });

    test('edge-functions/api/config.js handles onRequestGet and onRequestPost/Put', async () => {
      const mockKv = new MockKV();
      const ctx = {
        request: makeAdminReq('GET', '/api/config'),
        env: TEST_ENV,
        agent_kv: mockKv,
      };

      // 1. GET initial config
      const getResp = await edgeConfig.onRequestGet(ctx);
      assert.strictEqual(getResp.status, 200);
      const getData = await getResp.json();
      assert.strictEqual(getData.ok, true);
      assert.strictEqual(getData._version, 1);

      // 2. PUT / POST config update
      const updateReq = makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {
          openai: {
            name: 'OpenAI',
            base_url: 'https://api.openai.com/v1',
            api_keys: [{ id: 'k1', key: 'sk-new-key-12345678', enabled: true }],
          },
        },
      });
      const postCtx = { request: updateReq, env: TEST_ENV, agent_kv: mockKv };
      const postResp = await edgeConfig.onRequestPost(postCtx);
      assert.strictEqual(postResp.status, 200);
      const postData = await postResp.json();
      assert.strictEqual(postData.ok, true);
      assert.strictEqual(postData._version, 2);
    });

    test('edge-functions/api/admin/nodes.js and node/config.js full flow via onRequest', async () => {
      const mockKv = new MockKV();

      // Seed KV with version 1 config
      await edgeConfig.onRequestPost({
        request: makeAdminReq('POST', '/api/config', {
          _version: 1,
          providers: {
            openai: {
              name: 'OpenAI',
              base_url: 'https://api.openai.com/v1',
              api_keys: [{ id: 'k1', key: 'sk-secret-xyz12345', enabled: true }],
            },
          },
        }),
        env: TEST_ENV,
        agent_kv: mockKv,
      });

      // 1. Issue a new node via edge-functions/api/admin/nodes.js onRequestPost
      const issueReq = makeAdminReq('POST', '/api/admin/nodes', {
        name: 'edgeone-test-node',
        scope: ['openai'],
      });
      const issueCtx = { request: issueReq, env: TEST_ENV, agent_kv: mockKv };
      const issueResp = await edgeAdminNodes.onRequestPost(issueCtx);
      assert.strictEqual(issueResp.status, 200);
      const issueData = await issueResp.json();
      assert.strictEqual(issueData.ok, true);
      assert.ok(issueData.node_token.startsWith('stk_node_'));
      const issuedToken = issueData.node_token;
      const nodeId = issueData.node.id;

      // 2. List nodes via onRequestGet
      const listReq = makeAdminReq('GET', '/api/admin/nodes');
      const listCtx = { request: listReq, env: TEST_ENV, agent_kv: mockKv };
      const listResp = await edgeAdminNodes.onRequestGet(listCtx);
      assert.strictEqual(listResp.status, 200);
      const listData = await listResp.json();
      assert.strictEqual(listData.ok, true);
      assert.ok(listData.nodes.some((n) => n.id === nodeId));

      // 3. Dynamic route edge-functions/api/admin/nodes/[id].js
      const nodeParamModule = await import('../../edge-functions/api/admin/nodes/[id].js');
      const patchReq = makeAdminReq('PATCH', `/api/admin/nodes/${nodeId}`, {
        name: 'edgeone-renamed-node',
      });
      const patchCtx = {
        request: patchReq,
        env: TEST_ENV,
        agent_kv: mockKv,
        params: { id: nodeId },
      };
      const patchResp = await nodeParamModule.onRequestPatch(patchCtx);
      assert.strictEqual(patchResp.status, 200);
      const patchData = await patchResp.json();
      assert.strictEqual(patchData.ok, true);
      assert.strictEqual(patchData.node.name, 'edgeone-renamed-node');

      // 3b. Multi-level dynamic route edge-functions/api/admin/nodes/[[default]].js
      const defaultParamModule = await import('../../edge-functions/api/admin/nodes/[[default]].js');
      const rotateReq = makeAdminReq('POST', `/api/admin/nodes/${nodeId}/rotate`);
      const rotateCtx = {
        request: rotateReq,
        env: TEST_ENV,
        agent_kv: mockKv,
        params: { default: [nodeId, 'rotate'] },
      };
      const rotateResp = await defaultParamModule.onRequestPost(rotateCtx);
      assert.strictEqual(rotateResp.status, 200);
      const rotateData = await rotateResp.json();
      assert.strictEqual(rotateData.ok, true);
      assert.ok(rotateData.node_token.startsWith('stk_node_'));
      const rotatedToken = rotateData.node_token;

      // 4. Fetch node configuration via edge-functions/api/node/config.js onRequestPost
      const nodePullReq = makeNodeReq('POST', '/api/node/config', rotatedToken);
      const nodePullCtx = { request: nodePullReq, env: TEST_ENV, agent_kv: mockKv };
      const pullResp = await edgeNodeConfig.onRequestPost(nodePullCtx);
      assert.strictEqual(pullResp.status, 200);
      assert.ok(pullResp.headers.get('ETag'));
      assert.strictEqual(pullResp.headers.get('X-Config-Version'), '2');
      const pullData = await pullResp.json();
      assert.strictEqual(pullData.ok, true);
      assert.ok(pullData.payload.providers.openai);
      assert.strictEqual(pullData.payload.providers.openai.api_keys[0].key, 'sk-secret-xyz12345');
    });
  });

  describe('9. Web Standard Pure Crypto & SHA-256 Vectors', () => {
    test('SHA-256 standard vectors and token format compliance', () => {
      // Standard vectors (NIST FIPS 180-4)
      assert.strictEqual(
        hashToken('hello'),
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        'SHA-256("hello") must match FIPS standard vector'
      );
      assert.strictEqual(
        hashToken(''),
        '',
        'hashToken("") must return empty string for empty input'
      );
      assert.strictEqual(
        hashToken('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        'SHA-256("abc") must match FIPS standard vector'
      );

      // Node token format
      const token = generateNodeToken();
      assert.ok(token.startsWith('stk_node_'), 'Token must start with stk_node_');
      assert.strictEqual(token.length, 57, 'Token must be exactly 57 chars (9 + 48 hex)');
      assert.match(token, /^stk_node_[0-9a-f]{48}$/, 'Token must match stk_node_<48hex>');

      // Constant time comparison
      assert.strictEqual(constantTimeCompare('secret_pass', 'secret_pass'), true);
      assert.strictEqual(constantTimeCompare('secret_pass', 'wrong_pass'), false);
      assert.strictEqual(constantTimeCompare('short', 'longer_string'), false);
      assert.strictEqual(constantTimeCompare(null, 'test'), false);

      // ETag computation
      const etag = computeEtag({ key: 'val' });
      assert.match(etag, /^"[0-9a-f]{16}"$/, 'ETag must be 16 hex chars wrapped in quotes');
    });
  });
});
