import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { handleConfigRequest } from '../api/config.js';
import { handleNodesRequest } from '../api/admin/nodes.js';
import { handleNodeConfigRequest } from '../api/node/config.js';
import { handleHeartbeatRequest } from '../api/node/heartbeat.js';
import * as edgeNodeHeartbeat from '../api/node/heartbeat.js';
import { handleVaultManifestRequest } from '../api/vault/manifest.js';
import { handleVaultFetchRequest } from '../api/vault/fetch.js';
import { handleVerifyKey } from '../api/admin/verify-key.js';
import { handleTestKey } from '../api/admin/test-key.js';
import { handleProbeModels } from '../api/admin/probe-models.js';
import { handleModelCatalogRequest } from '../api/admin/model-catalog.js';
import { CONFIG_KV_KEY, loadConfig, saveConfigWithCAS, resolveKvBinding, resolveEnv, checkAdminAuth } from '../lib/config.js';
import { generateNodeToken, hashToken, constantTimeCompare, computeEtag } from '../lib/crypto.js';
import { generateClientKey, NODES_KV_KEY, loadNodes, saveNodes } from '../lib/nodes.js';
import { projectConfigForNode } from '../lib/projection.js';
import { PRESET_MAP } from '../lib/generated-presets.js';
import { MODEL_CATALOG_KV_KEY, loadCatalog, saveCatalog, meta, slimModelsDev } from '../lib/model-catalog.js';
import * as edgeIndex from '../../edge-functions/index.js';
import * as edgeHealth from '../../edge-functions/health.js';
import * as edgeHealthz from '../../edge-functions/healthz.js';
import * as edgeConfig from '../../edge-functions/api/config.js';
import * as edgeAdminNodes from '../../edge-functions/api/admin/nodes.js';
import * as edgeNodeConfig from '../../edge-functions/api/node/config.js';
import * as edgeModelCatalog from '../../edge-functions/api/admin/model-catalog.js';
import * as edgeModelCatalogAction from '../../edge-functions/api/admin/model-catalog/[action].js';

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

function makeNodeReq(method, path, token, ifNoneMatch = null, body = null, extraHeaders = null) {
  const headers = {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (ifNoneMatch) {
    headers['if-none-match'] = ifNoneMatch;
  }
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }
  const init = {
    method,
    headers,
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://hub.example.com${path}`, init);
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
    test('Hub returns plaintext keys; Kernel Guard still restores masked submissions', async () => {
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

      // 2. GET returns the plaintext key: the Hub is the authoritative source and the
      //    admin console must be able to view and edit it. Node projections stay masked.
      const getReq = makeAdminReq('GET', '/api/config');
      const getResp = await handleConfigRequest(getReq, TEST_ENV, kv);
      const getData = await getResp.json();
      const visibleKeyVal = getData.providers.deepseek.api_keys[0].key;
      assert.equal(visibleKeyVal, 'sk-real-deepseek-secret-999');

      // 2b. A masked value arriving from a stale UI/cache must still be replaced by the
      //     stored secret instead of overwriting it (Kernel Guard).
      const maskedKeyVal = 'sk-re●●●●●●et-999';

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

    test('GET install-command re-issues token, rotates old one, and survives last_ip round-trips', async () => {
      // 1. Issue a node
      const issueResp = await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', {
        name: 'Install Cmd 01',
        role: 'lite',
      }), TEST_ENV, kv);
      assert.equal(issueResp.status, 200);
      const issueData = await issueResp.json();
      const nodeId = issueData.node.id;
      const initialToken = issueData.node_token;

      // 2. Simulate the node syncing once with a real client IP header: the
      // node table renders last_ip, so the full round-trip (sync → KV →
      // sanitizeNode → list) must carry the actual value, not just the key.
      const syncResp = await handleNodeConfigRequest(
        makeNodeReq('POST', '/api/node/config', initialToken, null, null, { 'x-forwarded-for': '203.0.113.77' }),
        TEST_ENV,
        kv
      );
      assert.equal(syncResp.status, 200);

      const listData = await (await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes'), TEST_ENV, kv)).json();
      const listed = listData.nodes.find((n) => n.id === nodeId);
      assert.ok(listed, 'node appears in list');
      assert.equal(listed.last_ip, '203.0.113.77', 'last_ip carries the syncing client IP through sanitizeNode');
      assert.ok('last_seen' in listed, 'last_seen survives sanitizeNode');

      // 3. GET install-command re-obtains deploy material and rotates the token
      const cmdResp = await handleNodesRequest(
        makeAdminReq('GET', `/api/admin/nodes/${nodeId}/install-command`),
        TEST_ENV,
        kv
      );
      assert.equal(cmdResp.status, 200);
      assert.equal(cmdResp.headers.get('cache-control'), 'no-store', 'plaintext-token GET must not be cacheable');
      const cmdData = await cmdResp.json();
      assert.equal(cmdData.ok, true);
      assert.match(cmdData.node_token, /^stk_node_[a-f0-9]{48}$/);
      assert.notEqual(cmdData.node_token, initialToken, 'install-command rotates the token');
      assert.ok(cmdData.install_command.includes('--node-token='));
      assert.ok(cmdData.install_command.includes('/install.sh'));
      assert.ok(cmdData.bootstrap_env.includes('LLMPROXY_HUB_URL='));
      // The node payload must be sanitized exactly like the list endpoint:
      // no digest, no reversible ciphertext, no cached secrets.
      for (const forbidden of ['token_sha256', 'node_token_plaintext', 'node_token_enc', 'status_url', 'has_status_url', 'cached_status', 'mcp_url', 'telemetry', 'kind', 'service_type']) {
        assert.equal(cmdData.node[forbidden], undefined, `install-command node payload must not expose ${forbidden}`);
      }
      assert.ok(cmdData.node.id && cmdData.node.name, 'sanitized node payload keeps its identity fields');
      assert.equal(typeof cmdData.client_key, 'string', 'client_key is returned for the deploy panel');

      // 4. Old token is now dead, new token works
      const oldSync = await handleNodeConfigRequest(
        makeNodeReq('POST', '/api/node/config', initialToken, null),
        TEST_ENV,
        kv
      );
      assert.equal(oldSync.status, 401, 'rotated-away token is rejected');
      const newSync = await handleNodeConfigRequest(
        makeNodeReq('POST', '/api/node/config', cmdData.node_token, null),
        TEST_ENV,
        kv
      );
      assert.equal(newSync.status, 200, 'install-command token authenticates');

      // 5. Unknown node id → 404
      const missingResp = await handleNodesRequest(
        makeAdminReq('GET', '/api/admin/nodes/node_nope/install-command'),
        TEST_ENV,
        kv
      );
      assert.equal(missingResp.status, 404);

      // 6. Malformed paths must NOT trigger a rotation: an endsWith-style
      // match on /install-command would silently invalidate a running node.
      const beforeList = await (await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes'), TEST_ENV, kv)).json();
      const beforePrefix = beforeList.nodes.find((n) => n.id === nodeId).token_prefix;
      for (const badPath of [
        `/api/admin/nodes/${nodeId}/rotate/install-command`,
        `/api/admin/nodes/${nodeId}/install-command/rotate`,
        `/api/admin/nodes/${nodeId}/install-command/extra`,
      ]) {
        const badResp = await handleNodesRequest(makeAdminReq('GET', badPath), TEST_ENV, kv);
        assert.notEqual(badResp.status, 200, `malformed path ${badPath} must not succeed`);
      }
      // The working token from step 3 must still authenticate (nothing rotated).
      const stillOk = await handleNodeConfigRequest(
        makeNodeReq('POST', '/api/node/config', cmdData.node_token, null),
        TEST_ENV,
        kv
      );
      assert.equal(stillOk.status, 200, 'malformed paths must not rotate the working token');
      const afterList = await (await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes'), TEST_ENV, kv)).json();
      assert.equal(afterList.nodes.find((n) => n.id === nodeId).token_prefix, beforePrefix, 'token unchanged after malformed paths');

      // Cleanup
      await handleNodesRequest(makeAdminReq('DELETE', `/api/admin/nodes/${nodeId}`), TEST_ENV, kv);
    });

    test('install-command endpoint rejects unauthenticated callers', async () => {
      const resp = await handleNodesRequest(
        new Request('https://hub.example.com/api/admin/nodes/node_x/install-command'),
        TEST_ENV,
        kv
      );
      assert.equal(resp.status, 401);
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
              hide_client_name: true,
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
      assert.equal(projData.payload.providers.minimax.hide_client_name, true, 'hide_client_name flag must project to nodes');
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
              // Provider-wide RPM ceiling: must ride both manifest and fetch payloads so a
              // node re-fetch cannot silently reset a configured limit to 0.
              rpm_per_key: 60,
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
      assert.equal(mfData.providers.openrouter.rpm_per_key, 60,
        'manifest publishes the provider-wide RPM ceiling so the console can show it before a fetch');
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
      // The fetch response carries the hub-managed protocol type and the same rule hash
      // the manifest publishes, so the node can store both and detect rule drift.
      assert.equal(ftData.provider_config.api_type, '', 'provider_config always carries api_type');
      assert.equal(typeof ftData.provider_config.rule_hash, 'string');
      assert.ok(ftData.provider_config.rule_hash.length > 0);
      assert.equal(ftData.provider_config.rule_hash, mfData.providers.openrouter.rule_hash,
        'manifest and fetch must stamp the same rule_hash for the same provider state');
      assert.equal(ftData.provider_config.rpm_per_key, 60,
        'fetch carries the provider-wide RPM ceiling; without it a node re-fetch resets the limit to 0');

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

    test('Resolves stored unmasked key when UI sends masked key with provider and key_label', async () => {
      const kv = new MockKV();
      await kv.put(
        CONFIG_KV_KEY,
        JSON.stringify({
          _version: 1,
          providers: {
            deepseek: {
              name: 'DeepSeek',
              base_url: 'https://api.deepseek.com/v1',
              api_keys: [
                { id: 'k1', label: 'prod-ds', key: 'sk-real-deepseek-unmasked-token-999', enabled: true },
              ],
            },
          },
        })
      );
      const testEnv = { ...TEST_ENV, agent_kv: kv };

      let calledHeaders = {};
      const mockFetch = async (url, opts) => {
        calledHeaders = opts.headers || {};
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const verifyReq = makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'deepseek',
        key_label: 'prod-ds',
        api_key: 'sk-●●●●●●999',
      });

      const resp = await handleVerifyKey(verifyReq, testEnv, mockFetch);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.ok, true);
      assert.equal(data.valid, true);
      assert.equal(calledHeaders.authorization, 'Bearer sk-real-deepseek-unmasked-token-999');
    });
  });

  describe('6b. Per-Key Inference Test (handleTestKey)', () => {
    const SECRET = 'sk-hub-test-secret-7c6b5a4d';
    const providerConfig = (extra = {}) => ({
      _version: 3,
      providers: {
        mockprov: {
          name: 'Mock Provider',
          base_url: 'https://api.mock.example.com/v1',
          anthropic_base_url: 'https://api.mock.example.com/anthropic',
          preset_id: 'openai',
          enabled: true,
          api_keys: [
            { id: 'k_old', label: 'old', key: 'sk-disabled-old-key-0001', enabled: false },
            { id: 'k_live', label: 'live', key: SECRET, enabled: true },
          ],
          ...(extra.provider || {}),
        },
      },
      agent_models: extra.agent_models || {},
      settings: {},
    });

    async function envWithConfig(config) {
      const kv = new MockKV();
      await kv.put(CONFIG_KV_KEY, JSON.stringify(config));
      return { ...TEST_ENV, agent_kv: kv };
    }

    test('Rejects unauthenticated requests with 401 and non-POST with 405', async () => {
      const unauthReq = new Request('https://hub.example.com/api/admin/test-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mockprov' }),
      });
      const resp = await handleTestKey(unauthReq, TEST_ENV);
      assert.equal(resp.status, 401);

      const getResp = await handleTestKey(makeAdminReq('GET', '/api/admin/test-key'), TEST_ENV);
      assert.equal(getResp.status, 405);
    });

    test('200 chat.completion -> valid true with reply_text, real key, and the fixed 你好 prompt', async () => {
      const env = await envWithConfig(providerConfig());
      let calledUrl = '';
      let calledHeaders = {};
      let calledBody = null;
      const mockFetch = async (url, opts) => {
        calledUrl = url;
        calledHeaders = opts.headers || {};
        calledBody = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_hub_1',
            choices: [{ message: { role: 'assistant', content: '你好！我是 Hub 测试回复。' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_hub_42' } }
        );
      };

      const req = makeAdminReq('POST', '/api/admin/test-key', {
        provider: 'mockprov',
        key_label: 'live',
        // The probe no longer invents a model: the console always sends the
        // model it is testing (see resolveModel's `missing` branch).
        model: 'mock-model-1',
      });
      const resp = await handleTestKey(req, env, mockFetch);
      assert.equal(resp.status, 200);
      const raw = await resp.text();
      const data = JSON.parse(raw);

      assert.equal(data.ok, true);
      assert.equal(data.valid, true);
      assert.equal(data.status, 200);
      assert.equal(data.reply_text, '你好！我是 Hub 测试回复。');
      assert.equal(data.provider, 'mockprov');
      assert.equal(data.key_id, 'k_live');
      assert.equal(data.key_label, 'live');
      assert.equal(data.api_type, 'openai-completions');
      assert.equal(data.model, 'mock-model-1');
      assert.equal(data.model_source, 'request');
      assert.equal(data.rid, 'req_hub_42');
      assert.equal(data.reason, '');
      assert.equal(data.err_type, '');

      assert.equal(calledUrl, 'https://api.mock.example.com/v1/chat/completions');
      assert.equal(calledHeaders.authorization, `Bearer ${SECRET}`);
      assert.equal(calledBody.model, 'mock-model-1');
      assert.equal(calledBody.max_tokens, 16);
      assert.equal(calledBody.stream, false);
      assert.deepEqual(calledBody.messages, [{ role: 'user', content: '你好' }]);
      assert.equal(raw.includes(SECRET), false, 'response must never echo the key');
    });

    test('the verdict is persisted onto the key so a refresh still shows it', async () => {
      const env = await envWithConfig(providerConfig());
      const mockFetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好！' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const resp = await handleTestKey(
        makeAdminReq('POST', '/api/admin/test-key', { provider: 'mockprov', key_label: 'live' }),
        env,
        mockFetch
      );
      assert.equal(resp.status, 200);

      const stored = JSON.parse(await env.agent_kv.get(CONFIG_KV_KEY));
      const key = stored.providers.mockprov.api_keys.find((k) => k.label === 'live');
      assert.ok(key.last_test, 'last_test must be stored on the key');
      assert.equal(key.last_test.ok, true);
      assert.equal(key.last_test.status, 200);
      assert.equal(key.last_test.reply_text, '你好！');
      assert.ok(key.last_test.at, 'last_test must carry a timestamp');
      // The other key and the secret itself are untouched.
      const other = stored.providers.mockprov.api_keys.find((k) => k.label === 'old');
      assert.equal(other.last_test, undefined);
      assert.equal(key.key, SECRET);
    });

    test('401 invalid_api_key -> valid false, reason auth_invalid, err_type invalid_api_key', async () => {
      const env = await envWithConfig(providerConfig());
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            // The upstream echoes the full key on purpose: the response must
            // still never contain it.
            error: { type: 'invalid_api_key', message: `Incorrect API key provided: ${SECRET}` },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        );

      const req = makeAdminReq('POST', '/api/admin/test-key', { provider: 'mockprov' });
      const resp = await handleTestKey(req, env, mockFetch);
      assert.equal(resp.status, 200);
      const raw = await resp.text();
      const data = JSON.parse(raw);

      assert.equal(data.ok, true);
      assert.equal(data.valid, false);
      assert.equal(data.status, 401);
      assert.equal(data.reason, 'auth_invalid');
      assert.equal(data.err_type, 'invalid_api_key');
      assert.ok(data.error.includes('Incorrect API key provided'));
      assert.equal(raw.includes(SECRET), false, 'response must never echo the key');
      // Default target: first enabled key.
      assert.equal(data.key_label, 'live');
    });

    test('Aborted fetch (20s probe budget) -> valid false, reason timeout', async () => {
      const env = await envWithConfig(providerConfig());
      const mockFetch = async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      };

      const req = makeAdminReq('POST', '/api/admin/test-key', { provider: 'mockprov' });
      const resp = await handleTestKey(req, env, mockFetch);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.ok, true);
      assert.equal(data.valid, false);
      assert.equal(data.status, 0);
      assert.equal(data.reason, 'timeout');
    });

    test('Anthropic protocol: /messages URL, x-api-key + version headers, content[] reply', async () => {
      const env = await envWithConfig(providerConfig({
        provider: { api_type: 'anthropic-messages', preset_id: 'anthropic' },
      }));
      let calledUrl = '';
      let calledHeaders = {};
      const mockFetch = async (url, opts) => {
        calledUrl = url;
        calledHeaders = opts.headers || {};
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            content: [
              { type: 'text', text: '你好' },
              { type: 'text', text: '，世界' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      const req = makeAdminReq('POST', '/api/admin/test-key', {
        provider: 'mockprov',
        key_id: 'k_live',
        model: 'claude-mock-1',
      });
      const resp = await handleTestKey(req, env, mockFetch);
      const data = await resp.json();

      assert.equal(data.valid, true);
      assert.equal(data.api_type, 'anthropic-messages');
      assert.equal(data.reply_text, '你好，世界');
      assert.equal(calledUrl, 'https://api.mock.example.com/anthropic/v1/messages');
      assert.equal(calledHeaders['x-api-key'], SECRET);
      assert.equal(calledHeaders['anthropic-version'], '2023-06-01');
      assert.equal(calledHeaders.authorization, undefined);
    });

    test('Model chain: request -> route -> preset -> fallback; key_id targets a disabled key', async () => {
      const env = await envWithConfig(providerConfig({
        agent_models: {
          chat: {
            enabled: true,
            candidates: [{ provider: 'mockprov', key_label: 'live', target_model: 'vendor-route-model', enabled: true }],
          },
        },
      }));
      let calledBody = null;
      const mockFetch = async (url, opts) => {
        calledBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const routeResp = await handleTestKey(
        makeAdminReq('POST', '/api/admin/test-key', { provider: 'mockprov' }),
        env,
        mockFetch
      );
      const routeData = await routeResp.json();
      assert.equal(routeData.model, 'vendor-route-model');
      assert.equal(routeData.model_source, 'route');
      assert.equal(calledBody.model, 'vendor-route-model');

      const reqResp = await handleTestKey(
        makeAdminReq('POST', '/api/admin/test-key', { provider: 'mockprov', model: 'explicit-model' }),
        env,
        mockFetch
      );
      const reqData = await reqResp.json();
      assert.equal(reqData.model, 'explicit-model');
      assert.equal(reqData.model_source, 'request');

      const disabledResp = await handleTestKey(
        makeAdminReq('POST', '/api/admin/test-key', { provider: 'mockprov', key_id: 'k_old' }),
        env,
        mockFetch
      );
      const disabledData = await disabledResp.json();
      assert.equal(disabledData.valid, true);
      assert.equal(disabledData.key_label, 'old');
      assert.equal(disabledData.key_id, 'k_old');
    });

    test('Preflight errors: unknown provider and unsafe upstream URL', async () => {
      const env = await envWithConfig(providerConfig());
      let fetchCalls = 0;
      const mockFetch = async () => {
        fetchCalls++;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const noProv = await handleTestKey(
        makeAdminReq('POST', '/api/admin/test-key', { provider: 'nope' }),
        env,
        mockFetch
      );
      assert.equal(noProv.status, 400);
      const noProvData = await noProv.json();
      assert.equal(noProvData.ok, false);
      assert.equal(noProvData.valid, false);
      assert.equal(noProvData.error, "provider 'nope' not found");

      const unsafeEnv = await envWithConfig({
        _version: 1,
        providers: {
          mockprov: {
            base_url: 'http://127.0.0.1:8080/v1',
            api_keys: [{ id: 'k1', label: 'live', key: SECRET, enabled: true }],
          },
        },
        settings: {},
      });
      const unsafe = await handleTestKey(
        makeAdminReq('POST', '/api/admin/test-key', { provider: 'mockprov' }),
        unsafeEnv,
        mockFetch
      );
      assert.equal(unsafe.status, 400);
      const unsafeData = await unsafe.json();
      assert.equal(unsafeData.error, 'unsafe_upstream_url');
      assert.equal(fetchCalls, 0, 'preflight rejections must not dial the upstream');
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

    test('Resolves stored unmasked key when UI sends masked key with provider', async () => {
      const kv = new MockKV();
      await kv.put(
        CONFIG_KV_KEY,
        JSON.stringify({
          _version: 1,
          providers: {
            deepseek: {
              name: 'DeepSeek',
              base_url: 'https://api.deepseek.com/v1',
              api_keys: [
                { id: 'k1', label: 'prod-ds', key: 'sk-real-deepseek-unmasked-token-999', enabled: true },
              ],
            },
          },
        })
      );
      const testEnv = { ...TEST_ENV, agent_kv: kv };

      let calledHeaders = {};
      const mockFetch = async (url, opts) => {
        calledHeaders = opts.headers || {};
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const probeReq = makeAdminReq('POST', '/api/admin/probe-models', {
        provider: 'deepseek',
        api_key: 'sk-●●●●●●999',
      });

      const resp = await handleProbeModels(probeReq, testEnv, mockFetch);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.ok, true);
      assert.deepEqual(data.models, ['deepseek-chat', 'deepseek-reasoner']);
      assert.equal(calledHeaders.authorization, 'Bearer sk-real-deepseek-unmasked-token-999');
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

    test('static admin/index.html renders Hub Admin Console with __HOST_KIND__="hub" and edge-functions/admin.js is absent', async () => {
      const rootDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
      assert.strictEqual(existsSync(join(rootDir, 'edge-functions/admin.js')), false, 'edge-functions/admin.js must not exist');
      const html = readFileSync(join(rootDir, 'admin/index.html'), 'utf8');
      assert.ok(html.includes('window.__HOST_KIND__="hub"'), 'Must inject window.__HOST_KIND__="hub"');
      assert.ok(html.includes('hubOverviewBox'), 'Must include hubOverviewBox');
      assert.ok(html.includes('<!DOCTYPE html>'));
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

      // ETag
      const etag = computeEtag({ key: 'val' });
      assert.match(etag, /^"[0-9a-f]{16}"$/, 'ETag must be 16 hex chars wrapped in quotes');
    });
  });

  describe('10. Hub Lite Projection & Bootstrap Closure', () => {
    test('client_key unmasked in GET/bootstrap_env, provider adapter_rules embedded, grace_ttl & role editable', async () => {
      // 1. Save Hub config with client_key and provider with custom adapter_rules & preset_id
      const saveResp = await handleConfigRequest(
        makeAdminReq('POST', '/api/config', {
          _version: 1,
          providers: {
            deepseek: {
              name: 'DeepSeek',
              preset_id: 'deepseek',
              origin: 'vault',
              enabled: true,
              base_url: 'https://api.deepseek.com/v1',
              rpm_per_key: 60,
              refresh_every: '6h',
              adapter_rules: { auth_header: 'X-Custom-Auth', auth_prefix: 'Token ' },
              api_keys: [
                { id: 'k1', label: 'ds-01', key: 'sk-ds-secret-123456', weight: 3, max_rpm: 30, enabled: true, origin: 'vault' },
              ],
            },
          },
          agent_models: {
            'deepseek-chat': {
              enabled: true,
              candidates: [{ provider: 'deepseek', key_label: 'ds-01', enabled: true }],
            },
          },
          settings: {
            client_key: 'sk-lite-hub-primary',
          },
        }),
        TEST_ENV,
        kv
      );
      assert.equal(saveResp.status, 200);

      // GET /api/config exposes settings.client_key unmasked for admin copy
      const getData = await (await handleConfigRequest(makeAdminReq('GET', '/api/config'), TEST_ENV, kv)).json();
      assert.equal(getData.settings.client_key, 'sk-lite-hub-primary');
      assert.equal(getData.settings.proxy_keys, undefined);

      // 2. Issue Lite node -> bootstrap_env includes LLMPROXY_CLIENT_KEY
      const issueData = await (
        await handleNodesRequest(
          makeAdminReq('POST', '/api/admin/nodes', {
            name: 'NAT Lite 01',
            role: 'lite',
            lease_ttl: 43200,
            grace_ttl: 7200,
            scope: { providers: ['*'], models: ['*'] },
          }),
          TEST_ENV,
          kv
        )
      ).json();
      assert.equal(issueData.ok, true);
      assert.equal(issueData.node.grace_ttl, 7200);
      assert.match(issueData.bootstrap_env, /LLMPROXY_ROLE=lite/);
      assert.match(issueData.bootstrap_env, /LLMPROXY_CLIENT_KEY=sk-lite-hub-primary/);
      assert.match(issueData.install_command, /^curl -fsSL https:\/\/hub\.example\.com\/install\.sh \| sudo bash -s -- --role=lite /);
      assert.match(issueData.install_command, /--client-key="sk-lite-hub-primary"/);
      assert.match(issueData.install_command, / -p 8787 -y$/);

      // 3. Patch node role & grace_ttl
      const patchData = await (
        await handleNodesRequest(
          makeAdminReq('PATCH', `/api/admin/nodes/${issueData.node.id}`, {
            role: 'full',
            grace_ttl: 1800,
          }),
          TEST_ENV,
          kv
        )
      ).json();
      assert.equal(patchData.node.role, 'full');
      assert.equal(patchData.node.grace_ttl, 1800);

      // 4. Node pulls config -> adapter_rules embedded directly on provider + settings.client_key present
      const pullResp = await handleNodeConfigRequest(
        makeNodeReq('POST', '/api/node/config', issueData.node_token),
        TEST_ENV,
        kv
      );
      assert.equal(pullResp.status, 200);
      const pullData = await pullResp.json();
      assert.equal(pullData.payload.settings.client_key, 'sk-lite-hub-primary');
      assert.equal(pullData.payload.settings.proxy_keys, undefined);
      const ds = pullData.payload.providers.deepseek;
      assert.equal(ds.rpm_per_key, 60);
      assert.equal(ds.refresh_every, undefined);
      assert.equal(ds.auto_include, undefined);
      assert.equal(ds.api_keys[0].weight, 3);
      assert.equal(ds.api_keys[0].max_rpm, 30);
      assert.deepEqual(ds.adapter_rules, { auth_header: 'X-Custom-Auth', auth_prefix: 'Token ' });
    });
  });
});

describe('9. Vault node-token auth & node binary version', () => {
  test('vault manifest/fetch accept a valid node token; invalid tokens and local providers stay blocked', async () => {
    const kv = new MockKV();
    await handleConfigRequest(
      makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {
          openrouter: {
            name: 'OR',
            enabled: true,
            api_keys: [{ id: 'k1', label: 'pool', key: 'sk-or-1', enabled: true }],
          },
          priv: {
            name: 'P',
            origin: 'local',
            enabled: true,
            api_keys: [{ id: 'kp', label: 'p', key: 'sk-loc-1', enabled: true }],
          },
        },
      }),
      TEST_ENV,
      kv
    );

    const issueData = await (
      await handleNodesRequest(
        makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_vault', role: 'full', lease_ttl: 600 }),
        TEST_ENV,
        kv
      )
    ).json();
    const token = issueData.node_token;
    assert.ok(token.startsWith('stk_node_'));

    // 1. Manifest with node token
    const mfReq = new Request('https://hub.example.com/api/vault/manifest', {
      headers: { authorization: `Bearer ${token}` },
    });
    const mfResp = await handleVaultManifestRequest(mfReq, TEST_ENV, kv);
    assert.equal(mfResp.status, 200, 'node token must be accepted for vault manifest');
    const mf = await mfResp.json();
    assert.ok(mf.providers.openrouter);
    assert.equal(mf.providers.priv, undefined, 'local provider must never be exposed to nodes');

    // 2. Fetch with node token
    const ftReq = new Request('https://hub.example.com/api/vault/fetch', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter' }),
    });
    const ftResp = await handleVaultFetchRequest(ftReq, TEST_ENV, kv);
    assert.equal(ftResp.status, 200, 'node token must be accepted for vault fetch');
    const ft = await ftResp.json();
    assert.equal(ft.provider_config.keys.pool, 'sk-or-1');

    // 3. Invalid node token -> 401
    const badReq = new Request('https://hub.example.com/api/vault/manifest', {
      headers: { authorization: `Bearer stk_node_${'0'.repeat(48)}` },
    });
    assert.equal((await handleVaultManifestRequest(badReq, TEST_ENV, kv)).status, 401);

    // 4. Admin credential keeps working
    assert.equal(
      (await handleVaultManifestRequest(makeAdminReq('GET', '/api/vault/manifest'), TEST_ENV, kv)).status,
      200
    );

    // 5. Disabled node loses vault access
    await handleNodesRequest(makeAdminReq('PATCH', `/api/admin/nodes/${issueData.node.id}`, { enabled: false }), TEST_ENV, kv);
    assert.equal((await handleVaultManifestRequest(mfReq, TEST_ENV, kv)).status, 401);
  });

  test('X-Node-Version header updates last_binary_version', async () => {
    const kv = new MockKV();
    await handleConfigRequest(makeAdminReq('POST', '/api/config', { _version: 1, providers: {} }), TEST_ENV, kv);
    const issueData = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_ver', role: 'lite' }), TEST_ENV, kv)
    ).json();

    const req = new Request('https://hub.example.com/api/node/config', {
      method: 'POST',
      headers: { authorization: `Bearer ${issueData.node_token}`, 'x-node-version': 'v20261117-02' },
    });
    await handleNodeConfigRequest(req, TEST_ENV, kv);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const list = await (
      await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes'), TEST_ENV, kv)
    ).json();
    const node = list.nodes.find((n) => n.id === issueData.node.id);
    assert.equal(node.last_binary_version, 'v20261117-02');
  });
});

describe('10. Empty-template guard (nodes must never be starved)', () => {
  test('rejects saving a config with zero usable providers once one exists', async () => {
    const kv = new MockKV();
    const base = {
      _version: 1,
      providers: {
        p1: { name: 'P1', enabled: true, api_keys: [{ id: 'k1', label: 'k1', key: 'sk-1', enabled: true }] },
      },
    };
    assert.equal((await handleConfigRequest(makeAdminReq('POST', '/api/config', base), TEST_ENV, kv)).status, 200);

    // Wiping providers must be refused with 400 rather than published to nodes.
    const wipeResp = await handleConfigRequest(
      makeAdminReq('POST', '/api/config', { _version: 2, providers: {} }),
      TEST_ENV,
      kv
    );
    assert.equal(wipeResp.status, 400);
    const wiped = await wipeResp.json();
    assert.match(String(wiped.error || ''), /empty template/i);

    // Stored config must still hold the original provider.
    const stored = await loadConfig(kv);
    assert.ok(stored.providers.p1);

    // Removing the only enabled key is equally destructive and must be refused.
    const noKeys = await handleConfigRequest(
      makeAdminReq('POST', '/api/config', {
        _version: 2,
        providers: { p1: { name: 'P1', enabled: true, api_keys: [{ id: 'k1', label: 'k1', key: 'sk-1', enabled: false }] } },
      }),
      TEST_ENV,
      kv
    );
    assert.equal(noKeys.status, 400);
  });
});

describe('11. Security Hardening & Flat Preset AdapterRules Gates', () => {
  test('SEC-02: checkAdminAuth fails closed with 503 when ADMIN_PASSWORD is missing and never defaults to "admin"', async () => {
    const savedEnvPwd = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    try {
      const reqDefault = new Request('https://hub.example.com/api/config', {
        headers: { authorization: 'Bearer admin' },
      });
      const resMissing = checkAdminAuth(reqDefault, {});
      assert.ok(resMissing, 'Missing ADMIN_PASSWORD must reject request');
      assert.equal(resMissing.status, 503);
      const bodyMissing = await resMissing.json();
      assert.equal(bodyMissing.ok, false);
      assert.match(bodyMissing.error, /ADMIN_PASSWORD is not configured/);

      const resBlank = checkAdminAuth(reqDefault, { ADMIN_PASSWORD: '   ' });
      assert.ok(resBlank);
      assert.equal(resBlank.status, 503);

      // Configured ADMIN_PASSWORD works via hashed constant-time compare
      const validReq = new Request('https://hub.example.com/api/config', {
        headers: { 'x-admin-key': 'super_secret_hub_pwd' },
      });
      assert.equal(checkAdminAuth(validReq, { ADMIN_PASSWORD: 'super_secret_hub_pwd' }), null);
      assert.equal(checkAdminAuth(reqDefault, { ADMIN_PASSWORD: 'super_secret_hub_pwd' }).status, 401);
    } finally {
      if (savedEnvPwd !== undefined) process.env.ADMIN_PASSWORD = savedEnvPwd;
    }
  });

  test('SEC-01: Vault enforces Full-only role (403 on Lite) and provider scope isolation on manifest & fetch', async () => {
    const kv = new MockKV();
    await handleConfigRequest(
      makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {
          openrouter: {
            name: 'OpenRouter',
            enabled: true,
            api_keys: [{ id: 'k1', label: 'or-1', key: 'sk-or-allowed', enabled: true }],
          },
          deepseek: {
            name: 'DeepSeek',
            enabled: true,
            api_keys: [{ id: 'k2', label: 'ds-1', key: 'sk-ds-forbidden', enabled: true }],
          },
          local_is_local: {
            name: 'LocalFlagged',
            is_local: true,
            enabled: true,
            api_keys: [{ id: 'k3', label: 'loc-1', key: 'sk-local-flag', enabled: true }],
          },
        },
      }),
      TEST_ENV,
      kv
    );

    // 1. Issue a scoped Full node allowed ONLY 'openrouter'
    const fullScoped = await (
      await handleNodesRequest(
        makeAdminReq('POST', '/api/admin/nodes', {
          name: 'scoped-full',
          role: 'full',
          scope: { providers: ['openrouter'], models: ['*'] },
        }),
        TEST_ENV,
        kv
      )
    ).json();

    // Manifest for scoped Full node only lists 'openrouter', never 'deepseek' or 'local_is_local'
    const mfResp = await handleVaultManifestRequest(
      new Request('https://hub.example.com/api/vault/manifest', {
        headers: { authorization: `Bearer ${fullScoped.node_token}` },
      }),
      TEST_ENV,
      kv
    );
    assert.equal(mfResp.status, 200);
    const mfData = await mfResp.json();
    assert.deepEqual(Object.keys(mfData.providers), ['openrouter']);

    // Fetch in-scope provider -> 200
    const okFetch = await handleVaultFetchRequest(
      makeNodeReq('POST', '/api/vault/fetch', fullScoped.node_token, null, { provider: 'openrouter' }),
      TEST_ENV,
      kv
    );
    assert.equal(okFetch.status, 200);

    // Fetch out-of-scope provider -> 403 provider_out_of_node_scope
    const forbiddenFetch = await handleVaultFetchRequest(
      makeNodeReq('POST', '/api/vault/fetch', fullScoped.node_token, null, { provider: 'deepseek' }),
      TEST_ENV,
      kv
    );
    assert.equal(forbiddenFetch.status, 403);
    const fbBody = await forbiddenFetch.json();
    assert.equal(fbBody.error, 'provider_out_of_node_scope');

    // Admin fetch on is_local provider -> 404
    const localFlagResp = await handleVaultFetchRequest(
      makeAdminReq('POST', '/api/vault/fetch', { provider: 'local_is_local' }),
      TEST_ENV,
      kv
    );
    assert.equal(localFlagResp.status, 404);

    // 2. Issue a Lite node -> rejected with 403 on both /api/vault/manifest and /api/vault/fetch
    const liteIssued = await (
      await handleNodesRequest(
        makeAdminReq('POST', '/api/admin/nodes', {
          name: 'lite-only',
          role: 'lite',
          scope: { providers: ['*'], models: ['*'] },
        }),
        TEST_ENV,
        kv
      )
    ).json();

    const liteMf = await handleVaultManifestRequest(
      new Request('https://hub.example.com/api/vault/manifest', {
        headers: { authorization: `Bearer ${liteIssued.node_token}` },
      }),
      TEST_ENV,
      kv
    );
    assert.equal(liteMf.status, 403);

    const liteFt = await handleVaultFetchRequest(
      makeNodeReq('POST', '/api/vault/fetch', liteIssued.node_token, null, { provider: 'openrouter' }),
      TEST_ENV,
      kv
    );
    assert.equal(liteFt.status, 403);
  });

  test('SEC-11: isSafePublicHttpUrl blocks SSRF targets and stored KV keys ignore caller-supplied base_url', async () => {
    const unsafeUrls = [
      'http://127.0.0.1:8080/v1',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost:11434/v1',
    ];

    let fetchCalled = false;
    const guardFetch = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };

    for (const badUrl of unsafeUrls) {
      const vResp = await handleVerifyKey(
        makeAdminReq('POST', '/api/admin/verify-key', {
          provider: 'custom',
          base_url: badUrl,
          api_key: 'sk-test-12345678',
        }),
        TEST_ENV,
        guardFetch
      );
      assert.equal(vResp.status, 400);
      const vJson = await vResp.json();
      assert.equal(vJson.ok, false);
      assert.equal(vJson.valid, false);
      assert.equal(vJson.error, 'unsafe_upstream_url');

      const pResp = await handleProbeModels(
        makeAdminReq('POST', '/api/admin/probe-models', {
          provider: 'custom',
          base_url: badUrl,
          api_key: 'sk-test-12345678',
        }),
        TEST_ENV,
        guardFetch
      );
      assert.equal(pResp.status, 400);
      const pJson = await pResp.json();
      assert.equal(pJson.ok, false);
      assert.equal(pJson.error, 'unsafe_upstream_url');
    }
    assert.equal(fetchCalled, false, 'Outbound fetch must never fire on unsafe URLs');

    // Stored KV key exfiltration guard: caller sends masked key + attacker base_url
    const kv = new MockKV();
    await kv.put(
      CONFIG_KV_KEY,
      JSON.stringify({
        _version: 1,
        providers: {
          openai: {
            name: 'OpenAI',
            enabled: true,
            base_url: 'https://api.openai.com/v1',
            api_keys: [{ id: 'k1', label: 'main', key: 'sk-stored-kv-real-secret-777', enabled: true }],
          },
        },
      })
    );
    const envWithKv = { ...TEST_ENV, agent_kv: kv };
    const seenUrls = [];
    const mockFetch = async (url) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const exfilVerify = await handleVerifyKey(
      makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'openai',
        key_label: 'main',
        api_key: 'sk-●●●●●●777',
        base_url: 'https://attacker.example.org/v1',
      }),
      envWithKv,
      mockFetch
    );
    assert.equal(exfilVerify.status, 200);
    assert.equal(seenUrls[0], 'https://api.openai.com/v1/models');

    const exfilProbe = await handleProbeModels(
      makeAdminReq('POST', '/api/admin/probe-models', {
        provider: 'openai',
        key_label: 'main',
        api_key: 'sk-●●●●●●777',
        base_url: 'https://attacker.example.org/v1',
      }),
      envWithKv,
      mockFetch
    );
    assert.equal(exfilProbe.status, 200);
    assert.equal(seenUrls[1], 'https://api.openai.com/v1/models');
  });

  test('F-02 & SEC-16: generated-presets.js emits flat v2 AdapterRules and node shell/usage inputs are sanitized', async () => {
    const vertexRules = PRESET_MAP.vertex?.adapter_rules;
    assert.ok(vertexRules, 'vertex preset must have adapter_rules');
    assert.equal(vertexRules.gemini_compat, true);
    assert.equal(vertexRules.thought_tag_marker, '<thought>');
    assert.equal(vertexRules.ensure_google_prefix, true);
    assert.equal(vertexRules.rescue_from_text, true);
    assert.equal(vertexRules.reasoning, undefined, 'nested v1 reasoning object must be flattened');
    assert.equal(vertexRules.tools, undefined, 'nested v1 tools object must be flattened');

    const minimaxRules = PRESET_MAP.minimax?.adapter_rules;
    assert.equal(minimaxRules.thinking_policy, 'force');
    assert.deepEqual(minimaxRules.strip_params, ['output_config']);
    assert.equal(minimaxRules.model_aliases['minimax-m3'], 'MiniMax-M3');

    const clineRules = PRESET_MAP.cline?.adapter_rules;
    assert.equal(clineRules.unwrap_root, 'data');

    const amdRules = PRESET_MAP.amd?.adapter_rules;
    assert.equal(amdRules.deny_developer_role, true);
    assert.equal(amdRules.system_first_only, true);
    assert.deepEqual(amdRules.reasoning_fields, ['reasoning']);

    const openrouterRules = PRESET_MAP.openrouter?.adapter_rules;
    assert.equal(openrouterRules.extra_headers['X-Title'], 'OCRProxy');

    // SEC-16 & F-09: client_key shell sanitization + usage model key sanitization
    const kv = new MockKV();
    await handleConfigRequest(
      makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {
          openai: {
            name: 'OpenAI',
            enabled: true,
            base_url: 'https://api.openai.com/v1',
            api_keys: [{ id: 'k1', label: 'k1', key: 'sk-12345678', enabled: true }],
          },
        },
        settings: {
          client_key: 'sk-good"$(whoami)`id` key',
        },
      }),
      TEST_ENV,
      kv
    );

    const issued = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'sec16', role: 'lite' }), TEST_ENV, kv)
    ).json();
    assert.equal(issued.bootstrap_env.includes('$('), false);
    assert.equal(issued.bootstrap_env.includes('`'), false);
    assert.equal(issued.bootstrap_env.includes('"'), false);

    const syncReq = new Request('https://hub.example.com/api/node/config', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${issued.node_token}`,
        'x-node-usage': JSON.stringify({
          requests: 5,
          successes: 5,
          models: { '<img src=x onerror=alert(1)>gpt-4o': 5 },
        }),
      },
    });
    await handleNodeConfigRequest(syncReq, TEST_ENV, kv);
    const nodesData = await (await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes'), TEST_ENV, kv)).json();
    const updatedNode = nodesData.nodes.find((n) => n.id === issued.node.id);
    const storedModelNames = Object.keys(updatedNode.usage.models);
    assert.equal(storedModelNames.length, 1);
    assert.equal(/[<>"'&]/.test(storedModelNames[0]), false);
  });

  test('Decision #2: projectConfigForNode projects kb_models & KB concurrency settings ONLY to Full nodes, stripping them for Lite', () => {
    const hubCfg = {
      providers: {
        minimax: {
          id: 'minimax',
          name: 'MiniMax',
          origin: 'vault',
          enabled: true,
          base_url: 'https://api.minimax.io/v1',
          api_keys: [{ id: 'k1', label: 'mm-1', key: 'sk-mm-123456', enabled: true, origin: 'vault' }],
        },
        local_only: {
          id: 'local_only',
          name: 'Local',
          origin: 'local',
          enabled: true,
          base_url: 'https://api.openai.com/v1',
          api_keys: [{ id: 'kl', label: 'loc', key: 'sk-loc-999', enabled: true, origin: 'local' }],
        },
      },
      agent_models: {
        'MiniMax-M3': {
          enabled: true,
          candidates: [{ provider: 'minimax', key_label: 'mm-1', target_model: 'MiniMax-M3', enabled: true }],
        },
        ocr: {
          enabled: true,
          routing_strategy: 'round_robin',
          candidates: [
            { provider: 'minimax', key_label: 'mm-1', target_model: 'MiniMax-M3', max_concurrency: 4, enabled: true },
            { provider: 'local_only', key_label: 'loc', target_model: 'gpt-4o', enabled: true },
          ],
        },
      },
      kb_models: {
        embedding: [
          { provider: 'minimax', key_label: 'mm-1', model: 'embo-01', max_concurrency: 8, enabled: true },
          { provider: 'local_only', key_label: 'loc', model: 'text-embedding-3-small', enabled: true },
        ],
      },
      settings: {
        client_key: 'sk-llmproxy-shared',
        agent_routing_strategy: 'sticky_failover',
        ocr_max_inflight: 6,
        kb_global_max_concurrency: 24,
      },
    };

    const liteProj = projectConfigForNode(
      { id: 'n_lite', role: 'lite', scope: { providers: ['*'], models: ['*'] } },
      hubCfg,
      PRESET_MAP
    );
    assert.equal(liteProj.kb_models, undefined, 'Lite node must not receive kb_models');
    assert.equal(liteProj.agent_models.ocr, undefined, 'Lite node must ignore fixed KB 4-channels');
    assert.ok(liteProj.agent_models['MiniMax-M3'], 'Lite node still receives regular agent models');
    assert.equal(liteProj.settings.ocr_max_inflight, undefined, 'Lite node settings omit ocr_max_inflight');
    assert.equal(liteProj.settings.kb_global_max_concurrency, undefined, 'Lite node settings omit kb_global_max_concurrency');

    const fullProj = projectConfigForNode(
      { id: 'n_full', role: 'full', scope: { providers: ['*'], models: ['*'] } },
      hubCfg,
      PRESET_MAP
    );
    assert.ok(fullProj.kb_models, 'Full node must receive kb_models');
    assert.equal(fullProj.kb_models.embedding.length, 1, 'Local provider stripped from Full kb_models');
    assert.equal(fullProj.kb_models.embedding[0].provider, 'minimax');
    assert.equal(fullProj.kb_models.ocr.length, 1, 'Unified fixed route projected to kb_models.ocr for Full node');
    assert.equal(fullProj.settings.ocr_max_inflight, 6);
    assert.equal(fullProj.settings.kb_global_max_concurrency, 24);
  });

  test('P0-10, LITE-P1, FULL-05 & P0-05: 304 usage/version bypass, model_stats, revoke last_seen preservation, sk-llmproxy- prefix, vault touch & verifyKey _version', async () => {
    const kv = new MockKV();
    assert.match(generateClientKey(), /^sk-llmproxy-[a-f0-9]{32}$/);

    // Seed config without client_key -> issued node auto-generates sk-llmproxy- client_key
    await handleConfigRequest(
      makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {
          openai: {
            name: 'OpenAI',
            enabled: true,
            base_url: 'https://api.openai.com/v1',
            api_keys: [{ id: 'k1', label: 'main', key: 'sk-real-openai-12345678', enabled: true }],
          },
        },
      }),
      TEST_ENV,
      kv
    );

    const liteNode = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'lite-304', role: 'lite' }), TEST_ENV, kv)
    ).json();
    assert.match(liteNode.client_key, /^sk-llmproxy-/);
    assert.match(liteNode.bootstrap_env, /LLMPROXY_CLIENT_KEY=sk-llmproxy-/);

    // 1. Initial 200 pull sets ETag and last_seen
    const pull1 = await handleNodeConfigRequest(makeNodeReq('POST', '/api/node/config', liteNode.node_token), TEST_ENV, kv);
    assert.equal(pull1.status, 200);
    const etag = pull1.headers.get('etag');

    // 2. Immediate 304 within 60s WITH X-Node-Usage (model_stats) & X-Node-Version MUST NOT be dropped!
    const req304WithUsage = new Request('https://hub.example.com/api/node/config', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${liteNode.node_token}`,
        'if-none-match': etag,
        'x-node-version': 'v20261118-live',
        'x-node-usage': JSON.stringify({
          requests: 12,
          successes: 11,
          failed: 1,
          in_tokens: 1200,
          out_tokens: 340,
          models: { 'gpt-4o': 12 },
          model_stats: {
            'gpt-4o': { calls: 12, successes: 11, failed: 1, in_tokens: 1200, out_tokens: 340 },
          },
        }),
      },
    });
    const pull2 = await handleNodeConfigRequest(req304WithUsage, TEST_ENV, kv);
    assert.equal(pull2.status, 304);

    // 3. Revoking node preserves last_seen & last_config_version
    const patched = await (
      await handleNodesRequest(
        makeAdminReq('PATCH', `/api/admin/nodes/${liteNode.node.id}`, { enabled: false }),
        TEST_ENV,
        kv
      )
    ).json();
    assert.equal(patched.node.enabled, false);
    assert.ok(patched.node.last_seen, 'Revoked node must preserve last_seen timestamp');
    assert.equal(patched.node.last_binary_version, 'v20261118-live');
    assert.deepEqual(patched.node.usage.model_stats['gpt-4o'], {
      calls: 12,
      successes: 11,
      failed: 1,
      in_tokens: 1200,
      out_tokens: 340,
    });

    // 4. Full node calling /api/vault/manifest updates last_seen & last_binary_version
    const fullNode = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'full-vault', role: 'full' }), TEST_ENV, kv)
    ).json();
    const vfResp = await handleVaultManifestRequest(
      new Request('https://hub.example.com/api/vault/manifest', {
        headers: {
          authorization: `Bearer ${fullNode.node_token}`,
          'x-node-version': 'v20261118-full',
        },
      }),
      TEST_ENV,
      kv
    );
    assert.equal(vfResp.status, 200);
    const allNodes = await (await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes'), TEST_ENV, kv)).json();
    const fullRecord = allNodes.nodes.find((n) => n.id === fullNode.node.id);
    assert.ok(fullRecord.last_seen, 'Vault manifest pull must update Full node last_seen');
    assert.equal(fullRecord.last_binary_version, 'v20261118-full');

    // 5. P0-05: handleVerifyKey returns bumped _version when KV health is persisted
    const envWithKv = { ...TEST_ENV, agent_kv: kv };
    const vResp = await handleVerifyKey(
      makeAdminReq('POST', '/api/admin/verify-key', {
        provider: 'openai',
        key_label: 'main',
        api_key: 'sk-●●●●●●5678',
      }),
      envWithKv,
      async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    assert.equal(vResp.status, 200);
    const vData = await vResp.json();
    assert.equal(vData.valid, true);
    assert.equal(typeof vData._version, 'number', 'verify-key must return updated _version to prevent UI 409 CAS conflict');
    assert.equal(vData._version, 3);
  });
});

describe('11. Full-node issuance carries an admin password', () => {
  test('issue returns admin_password and puts it in install_command; lite does not', async () => {
    const kv = new MockKV();

    const fullRes = await handleNodesRequest(
      makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_full_pw', role: 'full' }),
      TEST_ENV,
      kv
    );
    assert.equal(fullRes.status, 200);
    const full = await fullRes.json();
    assert.ok(full.admin_password, 'full issuance must return admin_password');
    assert.ok(full.admin_password.length >= 16, 'admin password must be long enough');
    assert.ok(
      full.install_command.includes(`--admin-password="${full.admin_password}"`),
      'install_command must carry the generated admin password so the operator can log in'
    );

    const liteRes = await handleNodesRequest(
      makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_lite_nopw', role: 'lite' }),
      TEST_ENV,
      kv
    );
    const lite = await liteRes.json();
    assert.equal(lite.admin_password, undefined, 'lite nodes have no admin console');
    assert.ok(!lite.install_command.includes('--admin-password'));

    // Rotating a full node's install material REUSES the stored admin password:
    // KV keeps it in plaintext so the operator's saved value stays valid; only the
    // node token rotates (legacy nodes without a stored password get one minted).
    const rotateRes = await handleNodesRequest(
      makeAdminReq('POST', `/api/admin/nodes/${full.node.id}/rotate`),
      TEST_ENV,
      kv
    );
    const rotated = await rotateRes.json();
    assert.ok(rotated.admin_password, 'rotate must return the stored admin password');
    assert.equal(
      rotated.admin_password,
      full.admin_password,
      'rotate must reuse the KV-stored admin password, not mint a new one'
    );
    assert.notEqual(rotated.node_token, full.node_token, 'rotate must still rotate the node token');
    assert.ok(rotated.install_command.includes(`--admin-password="${full.admin_password}"`));
  });
});

describe('11b. Admin password lifecycle (credentials endpoint & role switches)', () => {
  // Exercises the plaintext-in-KV tradeoff the operator explicitly chose (方案 A):
  // the stored console password stays re-viewable via GET /:id/credentials, every
  // credential-bearing GET is no-store, role switches stay symmetric. Synthetic
  // credentials only — never real key material.
  const RAW_CLIENT_KEY = "sk-test-We'ird\$Key;|&<>{}!echo";

  test('GET /:id/credentials: auth gate, 404, no-store, full password, lite note', async () => {
    const kv = new MockKV();

    const full = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_cred_full', role: 'full' }), TEST_ENV, kv)
    ).json();

    // Auth gate: no admin credential -> 401 before anything else happens.
    const noAuth = await handleNodesRequest(
      new Request(`https://hub.example.com/api/admin/nodes/${full.node.id}/credentials`),
      TEST_ENV,
      kv
    );
    assert.equal(noAuth.status, 401, 'credentials endpoint must require admin auth');

    const missing = await handleNodesRequest(
      makeAdminReq('GET', '/api/admin/nodes/node_does_not_exist/credentials'),
      TEST_ENV,
      kv
    );
    assert.equal(missing.status, 404);

    // Full node: no-store header + the issued password, verbatim.
    const credResp = await handleNodesRequest(
      makeAdminReq('GET', `/api/admin/nodes/${full.node.id}/credentials`),
      TEST_ENV,
      kv
    );
    assert.equal(credResp.status, 200);
    assert.equal(credResp.headers.get('cache-control'), 'no-store', 'credential-bearing GET must be no-store');
    const cred = await credResp.json();
    assert.equal(cred.admin_password, full.admin_password, 'credentials must return the stored password');
    assert.equal(cred.admin_password_note, undefined);
    // No settings.client_key configured: the one-off key was never persisted — say so.
    assert.equal(cred.client_key, null);
    assert.ok(cred.client_key_note.includes('settings.client_key'));

    // Lite node: no password + explanatory note.
    const lite = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_cred_lite', role: 'lite' }), TEST_ENV, kv)
    ).json();
    const liteCred = await (
      await handleNodesRequest(makeAdminReq('GET', `/api/admin/nodes/${lite.node.id}/credentials`), TEST_ENV, kv)
    ).json();
    assert.equal(liteCred.admin_password, null);
    assert.ok(liteCred.admin_password_note.includes('lite 节点无后台密码'));
  });

  test('node list carries admin_password for full nodes and is no-store', async () => {
    const kv = new MockKV();
    const full = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_list_full', role: 'full' }), TEST_ENV, kv)
    ).json();

    const listResp = await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes'), TEST_ENV, kv);
    assert.equal(listResp.headers.get('cache-control'), 'no-store', 'list payload carries plaintext passwords -> no-store');
    const listData = await listResp.json();
    const listed = listData.nodes.find((n) => n.id === full.node.id);
    assert.equal(listed.admin_password, full.admin_password, 'list payload exposes the stored admin password (operator-chosen)');
  });

  test('full -> lite clears the stored password; lite -> full mints one immediately', async () => {
    const kv = new MockKV();
    const full = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_switch', role: 'full' }), TEST_ENV, kv)
    ).json();

    // full -> lite: a password left over from the full lifetime must not linger in KV.
    const litePatch = await (
      await handleNodesRequest(makeAdminReq('PATCH', `/api/admin/nodes/${full.node.id}`, { role: 'lite' }), TEST_ENV, kv)
    ).json();
    assert.equal(litePatch.node.role, 'lite');
    assert.equal(litePatch.node.admin_password, undefined, 'full -> lite must delete the stored password');
    const liteCred = await (
      await handleNodesRequest(makeAdminReq('GET', `/api/admin/nodes/${full.node.id}/credentials`), TEST_ENV, kv)
    ).json();
    assert.equal(liteCred.admin_password, null);
    assert.ok(liteCred.admin_password_note.includes('lite 节点无后台密码'));

    // lite -> full: mint right away so the credentials endpoint works without a
    // detour through install-command, and a later rotate reuses (not re-mints) it.
    const fullPatch = await (
      await handleNodesRequest(makeAdminReq('PATCH', `/api/admin/nodes/${full.node.id}`, { role: 'full' }), TEST_ENV, kv)
    ).json();
    assert.ok(fullPatch.node.admin_password, 'lite -> full must mint and persist a console password');
    assert.ok(fullPatch.node.admin_password.length >= 16);
    const cred = await (
      await handleNodesRequest(makeAdminReq('GET', `/api/admin/nodes/${full.node.id}/credentials`), TEST_ENV, kv)
    ).json();
    assert.equal(cred.admin_password, fullPatch.node.admin_password);
    const rotated = await (
      await handleNodesRequest(makeAdminReq('POST', `/api/admin/nodes/${full.node.id}/rotate`), TEST_ENV, kv)
    ).json();
    assert.equal(rotated.admin_password, fullPatch.node.admin_password, 'rotate must reuse the minted password');
  });

  test('rotate mints a password exactly once for a legacy node without one', async () => {
    const kv = new MockKV();
    // Hand-seed a pre-v3.4 record: full node, no admin_password field.
    const legacy = {
      id: 'node_legacy_pwless',
      name: 'zz_legacy',
      role: 'full',
      enabled: true,
      token_prefix: 'stk_node_legacy01...',
      token_sha256: hashToken('stk_node_legacy_dummy_token'),
      scope: { models: ['*'], providers: ['*'] },
      created_at: '2026-01-01T00:00:00Z',
    };
    await kv.put(NODES_KV_KEY, JSON.stringify([legacy]));

    const before = await (
      await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes/node_legacy_pwless/credentials'), TEST_ENV, kv)
    ).json();
    assert.equal(before.admin_password, null);
    assert.ok(before.admin_password_note.includes('旧版本'), 'legacy node note explains the missing password');

    const rotated = await (
      await handleNodesRequest(makeAdminReq('POST', `/api/admin/nodes/node_legacy_pwless/rotate`), TEST_ENV, kv)
    ).json();
    assert.ok(rotated.admin_password, 'legacy rotate must mint a password');

    const after = await (
      await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes/node_legacy_pwless/credentials'), TEST_ENV, kv)
    ).json();
    assert.equal(after.admin_password, rotated.admin_password, 'minted password must be persisted for later lookups');
    assert.equal(after.admin_password_note, undefined, 'note must disappear once a password is stored');

    const rotatedAgain = await (
      await handleNodesRequest(makeAdminReq('POST', `/api/admin/nodes/node_legacy_pwless/rotate`), TEST_ENV, kv)
    ).json();
    assert.equal(rotatedAgain.admin_password, rotated.admin_password, 'second rotate reuses the persisted password');
  });

  test('credentials endpoint returns the RAW settings client_key (the value full nodes enforce)', async () => {
    const kv = new MockKV();
    await handleConfigRequest(
      makeAdminReq('POST', '/api/config', {
        _version: 1,
        providers: {},
        settings: { client_key: RAW_CLIENT_KEY },
      }),
      TEST_ENV,
      kv
    );
    const full = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_raw_key', role: 'full' }), TEST_ENV, kv)
    ).json();

    const cred = await (
      await handleNodesRequest(makeAdminReq('GET', `/api/admin/nodes/${full.node.id}/credentials`), TEST_ENV, kv)
    ).json();
    assert.equal(
      cred.client_key,
      RAW_CLIENT_KEY,
      'client_key must be returned verbatim: config sync projects the raw value and the node enforces it'
    );
  });

  test('GET /:id/credentials returns the KV-stored plaintext token for full and lite nodes', async () => {
    const kv = new MockKV();
    const full = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_tok_full', role: 'full' }), TEST_ENV, kv)
    ).json();
    const lite = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_tok_lite', role: 'lite' }), TEST_ENV, kv)
    ).json();

    for (const issued of [full, lite]) {
      const resp = await handleNodesRequest(
        makeAdminReq('GET', `/api/admin/nodes/${issued.node.id}/credentials`),
        TEST_ENV,
        kv
      );
      assert.equal(resp.status, 200);
      assert.equal(resp.headers.get('cache-control'), 'no-store', 'plaintext token GET must not be cacheable');
      const cred = await resp.json();
      assert.equal(cred.node_token, issued.node_token, 'credentials must return the exact issued token');
      assert.match(cred.node_token, /^stk_node_[a-f0-9]{48}$/);
      assert.equal(cred.node_token_note, undefined, 'no legacy note once the plaintext is stored');
    }

    // The KV record keeps both forms: plaintext for re-view, digest for auth.
    const stored = (await loadNodes(kv)).find((n) => n.id === lite.node.id);
    assert.equal(stored.node_token_plaintext, lite.node_token, 'plaintext token is persisted in KV (operator choice)');
    assert.equal(stored.token_sha256, hashToken(lite.node_token), 'digest remains the authentication value');

    // Neither the list payload nor the install-command node payload may carry it.
    const listData = await (await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes'), TEST_ENV, kv)).json();
    for (const n of listData.nodes) {
      assert.equal(n.node_token_plaintext, undefined, 'list payload must not carry plaintext tokens');
    }

    // The reported plaintext is the live credential, not a stale copy.
    const sync = await handleNodeConfigRequest(
      makeNodeReq('POST', '/api/node/config', lite.node_token, null),
      TEST_ENV,
      kv
    );
    assert.equal(sync.status, 200, 'the token returned by credentials authenticates');
  });

  test('rotate refreshes node_token_plaintext so credentials never shows a dead token', async () => {
    const kv = new MockKV();
    const issued = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes', { name: 'zz_tok_rot', role: 'lite' }), TEST_ENV, kv)
    ).json();
    const rotated = await (
      await handleNodesRequest(makeAdminReq('POST', `/api/admin/nodes/${issued.node.id}/rotate`), TEST_ENV, kv)
    ).json();
    assert.notEqual(rotated.node_token, issued.node_token);

    const cred = await (
      await handleNodesRequest(makeAdminReq('GET', `/api/admin/nodes/${issued.node.id}/credentials`), TEST_ENV, kv)
    ).json();
    assert.equal(cred.node_token, rotated.node_token, 'credentials follows the rotation');
    assert.notEqual(cred.node_token, issued.node_token, 'the pre-rotation plaintext is gone');

    const stale = await handleNodeConfigRequest(
      makeNodeReq('POST', '/api/node/config', issued.node_token, null),
      TEST_ENV,
      kv
    );
    assert.equal(stale.status, 401, 'the pre-rotation token must not authenticate');
  });

  test('legacy digest-only node reports node_token null with a rotate hint, then rotates into view', async () => {
    const kv = new MockKV();
    const legacy = {
      id: 'node_legacy_tokless',
      name: 'zz_legacy_tok',
      role: 'lite',
      enabled: true,
      token_prefix: 'stk_node_legacy01...',
      token_sha256: hashToken('stk_node_legacy_dummy_token'),
      scope: { models: ['*'], providers: ['*'] },
      created_at: '2026-01-01T00:00:00Z',
    };
    await kv.put(NODES_KV_KEY, JSON.stringify([legacy]));

    const before = await (
      await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes/node_legacy_tokless/credentials'), TEST_ENV, kv)
    ).json();
    assert.equal(before.node_token, null);
    assert.ok(before.node_token_note.includes('轮换'), 'legacy note points at rotation');

    const rotated = await (
      await handleNodesRequest(makeAdminReq('POST', '/api/admin/nodes/node_legacy_tokless/rotate'), TEST_ENV, kv)
    ).json();
    assert.match(rotated.node_token, /^stk_node_[a-f0-9]{48}$/);

    const after = await (
      await handleNodesRequest(makeAdminReq('GET', '/api/admin/nodes/node_legacy_tokless/credentials'), TEST_ENV, kv)
    ).json();
    assert.equal(after.node_token, rotated.node_token, 'rotation persists the plaintext for later re-view');
    assert.equal(after.node_token_note, undefined, 'note disappears once the plaintext is stored');
  });
});

describe('12. Vault manifest agent_models (on-demand route templates)', () => {
  // Synthetic credentials only — never real key material.
  const ALPHA_KEY = 'sk-test-0123456789abcdef';
  const ALPHA_KEY2 = 'sk-test-fedcba9876543210';
  const BETA_KEY = 'sk-test-1111222233334444';
  const GHOST_KEY = 'sk-test-5555666677778888';

  function vaultConfig(agentModels) {
    return {
      _version: 1,
      providers: {
        prov_alpha: {
          name: 'Alpha',
          enabled: true,
          api_keys: [
            { id: 'ka1', label: 'alpha-k1', key: ALPHA_KEY, enabled: true },
            { id: 'ka2', label: 'alpha-k2', key: ALPHA_KEY2, enabled: true },
          ],
        },
        prov_beta: {
          name: 'Beta',
          enabled: true,
          api_keys: [{ id: 'kb1', label: 'beta-k1', key: BETA_KEY, enabled: true }],
        },
        local_vault: {
          name: 'Ghost',
          origin: 'local',
          enabled: true,
          api_keys: [{ id: 'kg1', label: 'ghost-k1', key: GHOST_KEY, enabled: true }],
        },
      },
      agent_models: agentModels,
    };
  }

  async function issueFullNode(kv, name, scope) {
    return (
      await handleNodesRequest(
        makeAdminReq('POST', '/api/admin/nodes', { name, role: 'full', scope }),
        TEST_ENV,
        kv
      )
    ).json();
  }

  test('model-scope whitelist filters routes; admin call is treated as scope ["*"]', async () => {
    const kv = new MockKV();
    await handleConfigRequest(
      makeAdminReq(
        'POST',
        '/api/config',
        vaultConfig({
          'm-in': {
            enabled: true,
            routing_strategy: 'sticky_failover',
            active_key: 'prov_alpha:alpha-k1',
            candidates: [
              {
                provider: 'prov_alpha',
                key_label: 'alpha-k1',
                target_model: 'alpha-prod',
                enabled: true,
                weight: 3,
                max_concurrency: 8,
              },
              { provider: 'prov_beta', key_label: 'beta-k1', target_model: 'beta-prod', enabled: true },
            ],
          },
          'm-out': {
            enabled: true,
            routing_strategy: 'round_robin',
            candidates: [{ provider: 'prov_beta', key_label: 'beta-k1', target_model: 'beta-out', enabled: true }],
          },
        })
      ),
      TEST_ENV,
      kv
    );

    const scoped = await issueFullNode(kv, 'zz_route_scope', { providers: ['*'], models: ['m-in'] });
    const nodeMf = await (
      await handleVaultManifestRequest(makeNodeReq('GET', '/api/vault/manifest', scoped.node_token), TEST_ENV, kv)
    ).json();
    assert.deepEqual(Object.keys(nodeMf.agent_models), ['m-in'], 'out-of-model-scope routes must not be listed');
    assert.deepEqual(
      nodeMf.agent_models['m-in'].candidates.map((c) => c.provider),
      ['prov_alpha', 'prov_beta'],
      'in-scope route keeps candidates whose providers are alive in the node manifest'
    );

    const adminMf = await (
      await handleVaultManifestRequest(makeAdminReq('GET', '/api/vault/manifest'), TEST_ENV, kv)
    ).json();
    assert.deepEqual(Object.keys(adminMf.agent_models).sort(), ['m-in', 'm-out'], 'admin sees every enabled route');
  });

  test('disabled routes and dead candidates are culled; routes without live candidates are dropped', async () => {
    const kv = new MockKV();
    await handleConfigRequest(
      makeAdminReq(
        'POST',
        '/api/config',
        vaultConfig({
          'm-disabled-route': {
            enabled: false,
            routing_strategy: 'round_robin',
            candidates: [{ provider: 'prov_alpha', key_label: 'alpha-k1', target_model: 'never', enabled: true }],
          },
          'm-mixed': {
            enabled: true,
            routing_strategy: 'weighted',
            candidates: [
              { provider: 'local_vault', key_label: 'ghost-k1', target_model: 'ghost-model', enabled: true },
              { provider: 'prov_nonexistent', key_label: 'nk', target_model: 'nx-model', enabled: true },
              {
                provider: 'prov_alpha',
                key_label: 'alpha-k2',
                target_model: 'alpha-live',
                enabled: true,
                weight: 2,
                max_concurrency: 4,
              },
              { provider: 'prov_alpha', key_label: 'alpha-k1', target_model: 'alpha-off', enabled: false },
            ],
          },
          'm-all-dead': {
            enabled: true,
            routing_strategy: 'round_robin',
            candidates: [
              { provider: 'local_vault', key_label: 'ghost-k1', target_model: 'dead-only', enabled: true },
              { provider: 'prov_nonexistent', key_label: 'nk', target_model: 'nx', enabled: true },
            ],
          },
          'm-beta-only': {
            enabled: true,
            routing_strategy: 'round_robin',
            candidates: [{ provider: 'prov_beta', key_label: 'beta-k1', target_model: 'beta-live', enabled: true }],
          },
        })
      ),
      TEST_ENV,
      kv
    );

    const adminMf = await (
      await handleVaultManifestRequest(makeAdminReq('GET', '/api/vault/manifest'), TEST_ENV, kv)
    ).json();
    assert.equal(adminMf.agent_models['m-disabled-route'], undefined, 'disabled routes must never be listed');
    assert.equal(adminMf.agent_models['m-all-dead'], undefined, 'routes with zero live candidates must be dropped');
    assert.deepEqual(
      adminMf.agent_models['m-mixed'].candidates,
      [{ provider: 'prov_alpha', key_label: 'alpha-k2', target_model: 'alpha-live', enabled: true, weight: 2, max_concurrency: 4 }],
      'dead providers and disabled candidates are culled from the surviving route'
    );
    assert.ok(adminMf.agent_models['m-beta-only'], 'live routes stay listed for admin');

    // Scoped node: prov_beta is out of provider scope, so it never reaches the node's
    // manifest providers section — candidates referencing it count as dead.
    const scoped = await issueFullNode(kv, 'zz_route_dead', { providers: ['prov_alpha'], models: ['*'] });
    const nodeMf = await (
      await handleVaultManifestRequest(makeNodeReq('GET', '/api/vault/manifest', scoped.node_token), TEST_ENV, kv)
    ).json();
    assert.equal(
      nodeMf.agent_models['m-beta-only'],
      undefined,
      'route whose only candidate is out of provider scope is dropped for the node'
    );
    assert.deepEqual(
      nodeMf.agent_models['m-mixed'].candidates.map((c) => c.provider),
      ['prov_alpha']
    );
  });

  test('agent_models carries metadata only — key labels, never plaintext key material', async () => {
    const kv = new MockKV();
    await handleConfigRequest(
      makeAdminReq(
        'POST',
        '/api/config',
        vaultConfig({
          'm-meta': {
            enabled: true,
            routing_strategy: 'sticky_failover',
            active_key: 'prov_alpha:alpha-k1',
            no_reasoning: true,
            force_non_stream: true,
            allow_key_fallback: true,
            candidates: [
              {
                provider: 'prov_alpha',
                key_label: 'alpha-k1',
                target_model: 'alpha-prod',
                enabled: true,
                weight: 3,
                max_concurrency: 8,
              },
            ],
          },
        })
      ),
      TEST_ENV,
      kv
    );

    const adminMf = await (
      await handleVaultManifestRequest(makeAdminReq('GET', '/api/vault/manifest'), TEST_ENV, kv)
    ).json();
    assert.deepEqual(
      adminMf.agent_models['m-meta'],
      {
        routing_strategy: 'sticky_failover',
        active_key: 'prov_alpha:alpha-k1',
        no_reasoning: true,
        force_non_stream: true,
        allow_key_fallback: true,
        candidates: [
          { provider: 'prov_alpha', key_label: 'alpha-k1', target_model: 'alpha-prod', enabled: true, weight: 3, max_concurrency: 8 },
        ],
      },
      'route metadata shape is exactly {routing_strategy, active_key, no_reasoning, force_non_stream, allow_key_fallback, candidates}'
    );

    const scoped = await issueFullNode(kv, 'zz_route_meta', { providers: ['*'], models: ['*'] });
    const nodeMf = await (
      await handleVaultManifestRequest(makeNodeReq('GET', '/api/vault/manifest', scoped.node_token), TEST_ENV, kv)
    ).json();

    for (const [who, body] of [
      ['admin', JSON.stringify(adminMf)],
      ['node', JSON.stringify(nodeMf)],
    ]) {
      for (const secret of [ALPHA_KEY, ALPHA_KEY2, BETA_KEY, GHOST_KEY]) {
        assert.ok(!body.includes(secret), `plaintext key material must never appear in the ${who} manifest`);
      }
      assert.ok(!body.includes('ghost-k1'), `local provider key label must never appear in the ${who} manifest`);
    }

    for (const mf of [adminMf, nodeMf]) {
      assert.ok(mf.providers.prov_alpha, 'providers segment stays intact next to agent_models');
      for (const route of Object.values(mf.agent_models)) {
        assert.deepEqual(
          Object.keys(route).sort(),
          ['active_key', 'allow_key_fallback', 'candidates', 'force_non_stream', 'no_reasoning', 'routing_strategy'],
          'routes expose exactly the metadata allowlist'
        );
        for (const cand of route.candidates) {
          assert.deepEqual(
            Object.keys(cand).sort(),
            ['enabled', 'key_label', 'max_concurrency', 'provider', 'target_model', 'weight'],
            'candidates expose exactly the metadata allowlist'
          );
          assert.equal(cand.key, undefined, 'candidates must never carry a key field');
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Node heartbeat — quota-saving liveness endpoint (invocations + KV writes).
// Task: /api/node/heartbeat must be 204-only, auth-guarded, debounced < 60s on
// last_seen (no KV write on the debounced path), preserve last_binary_version
// when X-Node-Version is absent, and never load or return config payloads.
// ---------------------------------------------------------------------------
describe('12b. Node config sync records the client IP with the same fallback chain as the heartbeat', () => {
  let kv;

  beforeEach(() => {
    kv = new MockKV();
  });

  async function issueNode(name) {
    const res = await handleNodesRequest(
      makeAdminReq('POST', '/api/admin/nodes', { name, role: 'lite' }),
      TEST_ENV,
      kv
    );
    assert.equal(res.status, 200);
    return res.json();
  }

  async function lastIpOf(nodeId) {
    return (await loadNodes(kv)).find((n) => n.id === nodeId)?.last_ip ?? null;
  }

  test('a config sync with no proxy header records request.eo.clientIp', async () => {
    const issue = await issueNode('zz_cfg_eoip');
    const req = makeNodeReq('POST', '/api/node/config', issue.node_token);
    req.eo = { clientIp: '203.0.113.11' };

    const resp = await handleNodeConfigRequest(req, TEST_ENV, kv);
    assert.equal(resp.status, 200);
    assert.equal(
      await lastIpOf(issue.node.id),
      '203.0.113.11',
      'a lite that only syncs config (heartbeat disabled) must still record an IP'
    );
  });

  test('a proxy header still wins on the config sync path', async () => {
    const issue = await issueNode('zz_cfg_hdr');
    const req = makeNodeReq('POST', '/api/node/config', issue.node_token, null, null, {
      'x-forwarded-for': '198.51.100.7',
    });
    req.eo = { clientIp: '203.0.113.11' };

    await handleNodeConfigRequest(req, TEST_ENV, kv);
    assert.equal(await lastIpOf(issue.node.id), '198.51.100.7');
  });

  test('no header and no eo.clientIp leaves the config-sync IP null', async () => {
    const issue = await issueNode('zz_cfg_noip');
    const resp = await handleNodeConfigRequest(
      makeNodeReq('POST', '/api/node/config', issue.node_token),
      TEST_ENV,
      kv
    );
    assert.equal(resp.status, 200);
    assert.equal(await lastIpOf(issue.node.id), null);
  });
});

describe('13. Node heartbeat (low-cost liveness & binary version)', () => {
  let kv;
  beforeEach(() => {
    kv = new MockKV();
  });

  function heartbeatReq(token, extraHeaders = null) {
    const headers = { authorization: `Bearer ${token}` };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    return new Request('https://hub.example.com/api/node/heartbeat', {
      method: 'POST',
      headers,
    });
  }

  async function issueHeartbeatNode(kv, name = 'zz_hb', role = 'full') {
    const res = await handleNodesRequest(
      makeAdminReq('POST', '/api/admin/nodes', { name, role }),
      TEST_ENV,
      kv
    );
    assert.equal(res.status, 200);
    return res.json();
  }

  async function findRawNode(kv, nodeId) {
    return (await loadNodes(kv)).find((n) => n.id === nodeId);
  }

  test('valid token first heartbeat → 200 + config_version, updates last_seen and last_binary_version', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_first');
    const before = await findRawNode(kv, issue.node.id);
    assert.equal(before.last_seen, null, 'fresh node has no last_seen');
    const initialVersion = before.last_binary_version;

    const resp = await handleHeartbeatRequest(
      heartbeatReq(issue.node_token, {
        'x-node-version': 'v20261123-heartbeat',
        'x-forwarded-for': '198.51.100.42',
      }),
      TEST_ENV,
      kv
    );
    assert.equal(resp.status, 200, 'heartbeat success is 200');
    // v20261124-XX: the body carries exactly one field — the hub's current
    // config_version — so a node can tell the template changed and pull it.
    // Before this, a node only refreshed on lease expiry (24h by default) and an
    // operator's edit looked like it did nothing (found in the lite E2E).
    const hbBody = await resp.json();
    assert.equal(hbBody.ok, true);
    assert.ok(Number.isInteger(hbBody.config_version), 'config_version is an integer');
    assert.deepEqual(Object.keys(hbBody).sort(), ['config_version', 'ok'], 'no config payload, no telemetry echo');

    const after = await findRawNode(kv, issue.node.id);
    assert.ok(after.last_seen, 'last_seen is now set');
    assert.ok(new Date(after.last_seen).getTime() > 0);
    assert.equal(after.last_binary_version, 'v20261123-heartbeat', 'reported binary version is stored');
    assert.equal(after.last_ip, '198.51.100.42', 'client IP from x-forwarded-for is stored');
    assert.equal(after.sync_count, before.sync_count, 'heartbeat does not inflate sync_count');
    assert.equal(after.last_config_version, before.last_config_version, 'heartbeat does not touch config version');
    assert.notEqual(after.last_binary_version, initialVersion, 'version actually advanced from the issued default');
  });

  // The IP fallback chain, pinned so a later refactor cannot quietly drop it.
  // EdgeOne exposes no socket peer address; request.eo.clientIp is the platform-
  // parsed client IP, and it is the only source when a proxy adds no headers.
  test('client IP falls back to request.eo.clientIp when no proxy header is present', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_eoip');
    const req = heartbeatReq(issue.node_token, { 'x-node-version': 'v-eoip' });
    // EdgeOne attaches `eo` to the Request object; simulate that shape.
    req.eo = { clientIp: '203.0.113.9' };

    const resp = await handleHeartbeatRequest(req, TEST_ENV, kv);
    assert.equal(resp.status, 200);
    const after = await findRawNode(kv, issue.node.id);
    assert.equal(after.last_ip, '203.0.113.9', 'eo.clientIp is used when no header supplies an IP');
  });

  test('a proxy header wins over request.eo.clientIp', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_eopre');
    const req = heartbeatReq(issue.node_token, { 'x-forwarded-for': '198.51.100.42, 10.0.0.1' });
    req.eo = { clientIp: '203.0.113.9' };

    await handleHeartbeatRequest(req, TEST_ENV, kv);
    const after = await findRawNode(kv, issue.node.id);
    assert.equal(after.last_ip, '198.51.100.42', 'the explicit header keeps precedence over eo.clientIp');
  });

  test('no header and no eo.clientIp leaves last_ip null (UI shows 未上报)', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_noip');
    const resp = await handleHeartbeatRequest(heartbeatReq(issue.node_token), TEST_ENV, kv);
    assert.equal(resp.status, 200);
    const after = await findRawNode(kv, issue.node.id);
    assert.equal(after.last_ip, null, 'no IP source means null, never a placeholder string');
  });

  test('blank eo.clientIp is treated as absent', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_blankip');
    const req = heartbeatReq(issue.node_token);
    req.eo = { clientIp: '   ' };

    await handleHeartbeatRequest(req, TEST_ENV, kv);
    const after = await findRawNode(kv, issue.node.id);
    assert.equal(after.last_ip, null);
  });

  test('second heartbeat within 60s → 204 and last_seen unchanged (debounce, no KV write)', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_debounce');

    const first = await handleHeartbeatRequest(
      heartbeatReq(issue.node_token, { 'x-node-version': 'v-debounce-1' }),
      TEST_ENV,
      kv
    );
    assert.equal(first.status, 200);
    const afterFirst = await findRawNode(kv, issue.node.id);
    const firstSeen = afterFirst.last_seen;
    const firstVersion = afterFirst.last_binary_version;

    // Spy on KV.put to prove the debounced path performs ZERO writes.
    const kvWrites = [];
    const spyingKv = {
      get: (...args) => kv.get(...args),
      put: async (...args) => {
        kvWrites.push(args[0]);
        return kv.put(...args);
      },
    };

    // Immediately again (well inside 60s), reporting a different version.
    const second = await handleHeartbeatRequest(
      heartbeatReq(issue.node_token, { 'x-node-version': 'v-debounce-2' }),
      TEST_ENV,
      spyingKv
    );
    assert.equal(second.status, 200, 'debounced heartbeat still answers');
    assert.equal(kvWrites.length, 0, 'debounced heartbeat issues ZERO KV.put calls');

    const afterSecond = await findRawNode(kv, issue.node.id);
    assert.equal(afterSecond.last_seen, firstSeen, 'last_seen is unchanged while inside the 60s window');
    assert.equal(afterSecond.last_binary_version, firstVersion, 'debounced heartbeat does not write a new version either');
  });

  test('invalid token → 401 node_revoked_or_invalid', async () => {
    await issueHeartbeatNode(kv, 'zz_hb_invalid');
    const resp = await handleHeartbeatRequest(
      heartbeatReq('stk_node_000000000000000000000000000000000000000000000000'),
      TEST_ENV,
      kv
    );
    assert.equal(resp.status, 401);
    const body = await resp.json();
    assert.deepEqual(body, { ok: false, error: 'node_revoked_or_invalid' });
  });

  test('revoked (disabled) node → 401', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_revoked');
    const patchResp = await handleNodesRequest(
      makeAdminReq('PATCH', `/api/admin/nodes/${issue.node.id}`, { enabled: false }),
      TEST_ENV,
      kv
    );
    assert.equal(patchResp.status, 200);

    const before = await findRawNode(kv, issue.node.id);
    const seenBefore = before.last_seen;
    const resp = await handleHeartbeatRequest(
      heartbeatReq(issue.node_token, { 'x-node-version': 'v-should-not-stick' }),
      TEST_ENV,
      kv
    );
    assert.equal(resp.status, 401, 'disabled node token is rejected');
    const after = await findRawNode(kv, issue.node.id);
    assert.equal(after.last_seen, seenBefore, 'revoked node telemetry is untouched');
  });

  test('heartbeat without X-Node-Version keeps the previous last_binary_version', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_nover');
    // Seed a known version via a first heartbeat with a header.
    const seeded = await handleHeartbeatRequest(
      heartbeatReq(issue.node_token, { 'x-node-version': 'v-keep-me' }),
      TEST_ENV,
      kv
    );
    assert.equal(seeded.status, 200);
    const withVersion = await findRawNode(kv, issue.node.id);
    assert.equal(withVersion.last_binary_version, 'v-keep-me');

    // Force last_seen back beyond the debounce window so the next beat writes.
    withVersion.last_seen = new Date(Date.now() - 120_000).toISOString();
    const nodes = await loadNodes(kv);
    const idx = nodes.findIndex((n) => n.id === issue.node.id);
    nodes[idx] = withVersion;
    await saveNodes(nodes, kv);

    const noHeader = await handleHeartbeatRequest(heartbeatReq(issue.node_token), TEST_ENV, kv);
    assert.equal(noHeader.status, 200);
    const after = await findRawNode(kv, issue.node.id);
    assert.equal(after.last_binary_version, 'v-keep-me', 'absent X-Node-Version never clears the stored version');
    assert.ok(new Date(after.last_seen).getTime() > new Date(withVersion.last_seen).getTime(), 'liveness still advanced');
  });

  // v20261124-XX: the heartbeat now returns the hub's config_version so a node
  // can notice a changed template without waiting out its lease (24h default).
  // That costs exactly ONE config read per non-debounced beat, and the body
  // still carries nothing but `{ok, config_version}` — never a config payload.
  test('returns only config_version: one config read, no payload; non-POST rejected', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_noconfig');
    const configReads = [];
    const auditKv = {
      get: async (key) => {
        configReads.push(key);
        return kv.get(key);
      },
      put: (...args) => kv.put(...args),
    };

    const resp = await handleHeartbeatRequest(
      heartbeatReq(issue.node_token, { 'x-node-version': 'v-no-config' }),
      TEST_ENV,
      auditKv
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(Object.keys(body).sort(), ['config_version', 'ok'], 'body is version-only — no config payload');
    assert.equal(
      configReads.filter((k) => k === 'llmproxy_config').length,
      1,
      'exactly one config read per non-debounced beat (needed for config_version)'
    );
    assert.ok(
      configReads.every((key) => key === NODES_KV_KEY || key === 'llmproxy_config'),
      'heartbeat reads only the node store and the config version'
    );

    const getResp = await handleHeartbeatRequest(
      new Request('https://hub.example.com/api/node/heartbeat', {
        method: 'GET',
        headers: { authorization: `Bearer ${issue.node_token}` },
      }),
      TEST_ENV,
      kv
    );
    assert.equal(getResp.status, 405, 'non-POST method is rejected');
  });

  test('EdgeOne onRequest/onRequestPost/default.fetch entry points all answer with config_version', async () => {
    const issue = await issueHeartbeatNode(kv, 'zz_hb_entries');
    const context = {
      request: heartbeatReq(issue.node_token, { 'x-node-version': 'v-entry' }),
      env: { ...TEST_ENV, KV: kv },
    };
    const a = await edgeNodeHeartbeat.onRequest(context);
    assert.equal(a.status, 200);
    assert.ok(Number.isInteger((await a.json()).config_version));
    const b = await edgeNodeHeartbeat.onRequestPost(context);
    assert.equal(b.status, 200);
    assert.ok(Number.isInteger((await b.json()).config_version));
    const c = await edgeNodeHeartbeat.default.fetch(heartbeatReq(issue.node_token), { ...TEST_ENV, KV: kv });
    assert.equal(c.status, 200);
    assert.ok(Number.isInteger((await c.json()).config_version));
  });
});

// #8: the Hub is the other half of "a legacy proxy_keys array is ignored". Go
// already ignores it (unknown JSON field, never authenticates), but a KV written by
// an older Hub used to hand it straight back: GET /api/config returned it, the
// console POSTed it back on the next save, and the projection shipped it to nodes.
// Every path that reads or writes config must drop it.
describe('14. Legacy proxy_keys is dropped by the Hub (load / save / projection)', () => {
  const legacySettings = () => ({
    client_key: 'sk-main',
    proxy_keys: ['sk-legacy-extra-1', 'sk-legacy-extra-2'],
    agent_routing_strategy: 'sticky_failover',
  });

  async function seedLegacy(kv) {
    await kv.put(
      CONFIG_KV_KEY,
      JSON.stringify({
        _version: 4,
        providers: {
          deepseek: {
            id: 'deepseek',
            name: 'DeepSeek',
            base_url: 'https://api.deepseek.com',
            enabled: true,
            api_keys: [{ id: 'ds-01', label: 'ds-01', key: 'sk-deepseek-live', enabled: true }],
          },
        },
        agent_models: {
          'deepseek-chat': {
            enabled: true,
            candidates: [{ provider: 'deepseek', key_label: 'ds-01', enabled: true }],
          },
        },
        settings: legacySettings(),
      })
    );
  }

  test('loadConfig strips proxy_keys from a KV written by an older Hub', async () => {
    const kv = new MockKV();
    await seedLegacy(kv);
    const loaded = await loadConfig(kv);
    assert.equal(loaded.settings.client_key, 'sk-main');
    assert.equal(loaded.settings.proxy_keys, undefined, 'loadConfig must not hand back removed fields');
    // The callers mutate then save what they loaded; the stored copy must stay untouched
    // until an explicit save (load must not become an implicit write path).
    assert.match(await kv.get(CONFIG_KV_KEY), /sk-legacy-extra-1/);
  });

  test('GET/POST /api/config never read or write proxy_keys back to KV', async () => {
    const kv = new MockKV();
    await seedLegacy(kv);

    const getData = await (await handleConfigRequest(makeAdminReq('GET', '/api/config'), TEST_ENV, kv)).json();
    assert.equal(getData.settings.client_key, 'sk-main');
    assert.equal(getData.settings.proxy_keys, undefined, 'GET must not echo a removed field');

    // Simulate the console save: POST back exactly what GET returned (the leak's
    // actual mechanism was `{...config}` round-tripping an untouched field).
    getData._version = 4;
    const saveResp = await handleConfigRequest(makeAdminReq('POST', '/api/config', getData), TEST_ENV, kv);
    assert.equal(saveResp.status, 200);

    const stored = JSON.parse(await kv.get(CONFIG_KV_KEY));
    assert.equal(stored.settings.proxy_keys, undefined, 'a console save must not persist proxy_keys');
    assert.equal(stored.settings.client_key, 'sk-main');
  });

  test('saveConfigWithCAS drops a proxy_keys array submitted directly', async () => {
    const kv = new MockKV();
    await seedLegacy(kv);
    const saved = await saveConfigWithCAS(
      {
        _version: 4,
        providers: {
          deepseek: {
            id: 'deepseek',
            base_url: 'https://api.deepseek.com',
            enabled: true,
            api_keys: [{ id: 'ds-01', label: 'ds-01', key: 'sk-deepseek-live', enabled: true }],
          },
        },
        settings: { client_key: 'sk-rotated', proxy_keys: ['sk-should-not-persist'] },
      },
      kv
    );
    assert.equal(saved.settings.proxy_keys, undefined);
    assert.equal(saved.settings.client_key, 'sk-rotated');
    const stored = JSON.parse(await kv.get(CONFIG_KV_KEY));
    assert.equal(stored.settings.proxy_keys, undefined);
  });

  test('node projection never ships proxy_keys to lite or full nodes', async () => {
    const kv = new MockKV();
    await seedLegacy(kv);
    const config = await loadConfig(kv);
    // loadConfig already cleaned it; feed the raw shape too so the projection's own
    // guard is covered independently of the loader.
    const rawConfig = { ...config, settings: { ...config.settings, proxy_keys: ['sk-legacy-extra-1'] } };
    for (const role of ['lite', 'full']) {
      const projected = projectConfigForNode({ role, scope: { providers: ['*'], models: ['*'] } }, rawConfig, {});
      assert.equal(projected.settings.client_key, 'sk-main');
      assert.equal(projected.settings.proxy_keys, undefined, `${role} projection must not carry proxy_keys`);
    }
  });
});


describe('15. Model catalog storage & admin API', () => {
  const FIXTURE_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../scripts/model-catalog/fixtures/models-dev-sample.json'
  );
  const sampleRaw = () => JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  const oldCatalogText = () =>
    JSON.stringify({
      schema: 1,
      source: 'models.dev',
      fetched_at: '2026-01-01T00:00:00.000Z',
      model_count: 1,
      providers: { oldprov: { 'old-model': { limit: { context: 1 } } } },
    });

  const updateReq = (auth = true) =>
    new Request('https://hub.example.com/api/admin/model-catalog/update', {
      method: 'POST',
      headers: auth ? { authorization: `Bearer ${TEST_ENV.ADMIN_PASSWORD}` } : {},
    });

  test('unauthenticated POST update returns 401', async () => {
    const kv = new MockKV();
    const resp = await handleModelCatalogRequest(updateReq(false), TEST_ENV, kv, async () => {
      throw new Error('must not fetch without auth');
    });
    assert.equal(resp.status, 401);
    assert.equal(await kv.get(MODEL_CATALOG_KV_KEY), null);
  });

  test('successful update slims the payload, stores it, and reports model_count', async () => {
    const kv = new MockKV();
    const raw = sampleRaw();
    const mockFetch = async (url, opts) => {
      assert.equal(url, 'https://models.dev/api.json');
      assert.ok(opts && opts.signal, 'fetch must carry a timeout signal');
      return new Response(JSON.stringify(raw), { status: 200 });
    };

    const resp = await handleModelCatalogRequest(updateReq(), TEST_ENV, kv, mockFetch);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);

    const stored = JSON.parse(await kv.get(MODEL_CATALOG_KV_KEY));
    assert.equal(stored.schema, 1);
    assert.equal(stored.source, 'models.dev');
    assert.match(stored.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(data.fetched_at, stored.fetched_at);
    assert.equal(data.model_count, stored.model_count);
    assert.equal(data.bytes, Buffer.byteLength(await kv.get(MODEL_CATALOG_KV_KEY), 'utf8'));

    // model_count equals what the fixture actually contains
    let expected = 0;
    for (const p of Object.values(raw)) expected += Object.keys(p.models || {}).length;
    assert.equal(stored.model_count, expected);

    // Only the five whitelisted fields survive per model
    for (const models of Object.values(stored.providers)) {
      for (const m of Object.values(models)) {
        for (const k of Object.keys(m)) {
          assert.ok(
            ['limit', 'reasoning', 'reasoning_options', 'family', 'release_date'].includes(k),
            `unexpected key '${k}' in catalog model`
          );
        }
        assert.equal(m.limit && m.limit.input, undefined, 'upstream limit.input must be dropped');
      }
    }

    // The dropped upstream fields must be gone
    const sonnet = stored.providers.anthropic['claude-sonnet-4-5'];
    assert.equal(sonnet.description, undefined);
    assert.equal(sonnet.cost, undefined);
    assert.equal(sonnet.modalities, undefined);
    assert.equal(sonnet.limit.context, 200000);
    assert.deepEqual(sonnet.reasoning_options, [{ type: 'budget_tokens', min: 1024 }]);
    assert.equal(sonnet.reasoning, true);

    // Provider / model ids sorted, provider keys are not our preset ids
    const providerIds = Object.keys(stored.providers);
    assert.deepEqual(providerIds, providerIds.slice().sort());
    const modelIds = Object.keys(stored.providers.anthropic);
    assert.deepEqual(modelIds, modelIds.slice().sort());
  });

  test('timeout while fetching returns 502 and leaves the stored catalog untouched', async () => {
    const kv = new MockKV();
    const before = oldCatalogText();
    await kv.put(MODEL_CATALOG_KV_KEY, before);

    const mockFetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };

    const resp = await handleModelCatalogRequest(updateReq(), TEST_ENV, kv, mockFetch);
    assert.equal(resp.status, 502);
    const data = await resp.json();
    assert.equal(data.ok, false);
    assert.equal(data.error, 'models.dev_unreachable');
    assert.ok(data.detail, 'failure must carry a detail line');

    assert.equal(await kv.get(MODEL_CATALOG_KV_KEY), before, 'a failed update must keep the old catalog');
    const m = await meta(kv);
    assert.equal(m.present, true);
    assert.equal(m.fetched_at, '2026-01-01T00:00:00.000Z');
  });

  test('non-JSON upstream body returns 502 models.dev_invalid', async () => {
    const kv = new MockKV();
    const before = oldCatalogText();
    await kv.put(MODEL_CATALOG_KV_KEY, before);

    const resp = await handleModelCatalogRequest(
      updateReq(),
      TEST_ENV,
      kv,
      async () => new Response('<html>not json</html>', { status: 200 })
    );
    assert.equal(resp.status, 502);
    assert.equal((await resp.json()).error, 'models.dev_invalid');
    assert.equal(await kv.get(MODEL_CATALOG_KV_KEY), before);
  });

  test('upstream HTTP error returns 502 models.dev_unreachable and keeps the old catalog', async () => {
    const kv = new MockKV();
    const before = oldCatalogText();
    await kv.put(MODEL_CATALOG_KV_KEY, before);

    const resp = await handleModelCatalogRequest(
      updateReq(),
      TEST_ENV,
      kv,
      async () => new Response('{}', { status: 503 })
    );
    assert.equal(resp.status, 502);
    assert.equal((await resp.json()).error, 'models.dev_unreachable');
    assert.equal(await kv.get(MODEL_CATALOG_KV_KEY), before);
  });

  test('a payload that slims to nothing returns 500 catalog_invalid and keeps the old catalog', async () => {
    const kv = new MockKV();
    const before = oldCatalogText();
    await kv.put(MODEL_CATALOG_KV_KEY, before);

    // Valid JSON, zero models -> slimModelsDev refuses to emit an empty catalog
    const resp = await handleModelCatalogRequest(
      updateReq(),
      TEST_ENV,
      kv,
      async () => new Response(JSON.stringify({ provider_a: { models: {} } }), { status: 200 })
    );
    assert.equal(resp.status, 500);
    const data = await resp.json();
    assert.equal(data.ok, false);
    assert.equal(data.error, 'catalog_invalid');
    assert.ok(data.detail);
    assert.equal(await kv.get(MODEL_CATALOG_KV_KEY), before);
  });

  test('GET meta reports absent then present catalog', async () => {
    const kv = new MockKV();
    const emptyResp = await handleModelCatalogRequest(makeAdminReq('GET', '/api/admin/model-catalog'), TEST_ENV, kv);
    assert.equal(emptyResp.status, 200);
    const empty = await emptyResp.json();
    assert.equal(empty.ok, true);
    assert.equal(empty.present, false);
    assert.equal(empty.model_count, 0);
    assert.equal(empty.fetched_at, '');
    assert.equal(empty.bytes, 0);

    await saveCatalog(kv, oldCatalogText());
    const present = await (
      await handleModelCatalogRequest(makeAdminReq('GET', '/api/admin/model-catalog'), TEST_ENV, kv)
    ).json();
    assert.equal(present.present, true);
    assert.equal(present.fetched_at, '2026-01-01T00:00:00.000Z');
    assert.equal(present.model_count, 1);
    assert.equal(present.bytes, Buffer.byteLength(oldCatalogText(), 'utf8'));
  });

  test('GET data returns the stored catalog text verbatim with no-store', async () => {
    const kv = new MockKV();
    const text = oldCatalogText();
    await saveCatalog(kv, text);
    const resp = await handleModelCatalogRequest(makeAdminReq('GET', '/api/admin/model-catalog/data'), TEST_ENV, kv);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'application/json');
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(await resp.text(), text);

    // No catalog -> 404, not an empty 200
    const emptyKv = new MockKV();
    const missing = await handleModelCatalogRequest(
      makeAdminReq('GET', '/api/admin/model-catalog/data'),
      TEST_ENV,
      emptyKv
    );
    assert.equal(missing.status, 404);
  });

  test('GET /api/config carries model_catalog_meta but not the catalog body', async () => {
    const kv = new MockKV();
    const resp0 = await handleConfigRequest(makeAdminReq('GET', '/api/config'), TEST_ENV, kv);
    const data0 = await resp0.json();
    assert.deepEqual(data0.model_catalog_meta, { present: false, fetched_at: '', model_count: 0 });
    assert.equal(JSON.stringify(data0).includes('old-model'), false);

    await saveCatalog(kv, oldCatalogText());
    const data1 = await (await handleConfigRequest(makeAdminReq('GET', '/api/config'), TEST_ENV, kv)).json();
    assert.deepEqual(data1.model_catalog_meta, {
      present: true,
      fetched_at: '2026-01-01T00:00:00.000Z',
      model_count: 1,
    });
    assert.equal(JSON.stringify(data1).includes('old-model'), false, '/api/config must not inline the catalog');
    assert.deepEqual(Object.keys(data1.model_catalog_meta), ['present', 'fetched_at', 'model_count']);
  });

  test('model_catalog_meta is not persisted by a console save', async () => {
    const kv = new MockKV();
    const got = await (await handleConfigRequest(makeAdminReq('GET', '/api/config'), TEST_ENV, kv)).json();
    const resp = await handleConfigRequest(makeAdminReq('POST', '/api/config', got), TEST_ENV, kv);
    assert.equal(resp.status, 200);
    const stored = JSON.parse(await kv.get(CONFIG_KV_KEY));
    assert.equal(stored.model_catalog_meta, undefined);
  });

  test('saveCatalog rejects invalid payloads without touching the stored catalog', async () => {
    const kv = new MockKV();
    const before = oldCatalogText();
    await kv.put(MODEL_CATALOG_KV_KEY, before);

    const bad = [
      ['not json', {}],
      [JSON.stringify({ schema: 2, providers: {} }), {}],
      [JSON.stringify({ schema: 1 }), {}],
      [JSON.stringify({ schema: 1, providers: [] }), {}],
      ['', {}],
    ];
    for (const [text] of bad) {
      await assert.rejects(() => saveCatalog(kv, text), (err) => /[\u4e00-\u9fa5]/.test(err.message));
      assert.equal(await kv.get(MODEL_CATALOG_KV_KEY), before, `rejected payload must not overwrite: ${text}`);
    }

    // Oversized payload: one model with a huge family string pushes past 4 MB
    const huge = JSON.stringify({
      schema: 1,
      providers: { p: { m: { family: 'x'.repeat(4 * 1024 * 1024 + 10) } } },
    });
    await assert.rejects(() => saveCatalog(kv, huge), /超过/);
    assert.equal(await kv.get(MODEL_CATALOG_KV_KEY), before);
  });

  test('loadCatalog returns null (warns, does not throw) for a corrupt value', async () => {
    const kv = new MockKV();
    await kv.put(MODEL_CATALOG_KV_KEY, '{broken');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      assert.equal(await loadCatalog(kv), null);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /model-catalog/);
    assert.equal((await meta(kv)).present, false);
  });

  // GET /api/admin/model-catalog/lookup is the Hub console's single-model query
  // (route-editor reasoning dropdown + add-model summary). It must answer exactly
  // what the Go node store answers, so both consoles render the same options.
  describe('GET /model-catalog/lookup — Hub capability query', () => {
    const lookupReq = (query, auth = 'Bearer test_admin_pwd') =>
      new Request(`https://hub.example.com/api/admin/model-catalog/lookup${query}`, {
        headers: auth ? { authorization: auth } : {},
      });

    const seededKv = async () => {
      const kv = new MockKV();
      await kv.put(MODEL_CATALOG_KV_KEY, JSON.stringify(slimModelsDev(sampleRaw(), '2026-01-01T00:00:00.000Z')));
      return kv;
    };

    test('effort ladder, toggle, budget and not-found all match the node contract', async () => {
      const kv = await seededKv();

      const pro = await handleModelCatalogRequest(lookupReq('?preset=deepseek&model=deepseek-v4-pro'), TEST_ENV, kv);
      assert.equal(pro.status, 200);
      const p = await pro.json();
      assert.equal(p.ok, true);
      assert.equal(p.found, true);
      assert.equal(p.context_tokens, 1048576);
      assert.equal(p.output_tokens, 393216);
      assert.deepEqual(p.efforts, ['low', 'high', 'max']);
      assert.equal(p.toggle, true);
      assert.equal(p.budget, null);

      const proUpper = await handleModelCatalogRequest(lookupReq('?preset=deepseek&model=DEEPSEEK-V4-PRO'), TEST_ENV, kv);
      const pu = await proUpper.json();
      assert.equal(pu.found, true, 'case-insensitive fallback must resolve too');
      assert.deepEqual(pu.efforts, ['low', 'high', 'max']);

      // Toggle-only: no ladder, reported through `toggle`, never faked as levels.
      const glm = await handleModelCatalogRequest(lookupReq('?preset=zhipu&model=glm-4.5'), TEST_ENV, kv);
      const g = await glm.json();
      assert.equal(g.found, true);
      assert.equal(g.efforts, null);
      assert.equal(g.toggle, true);

      // Budget-only: its own field, and still no fake ladder.
      const sonnet = await handleModelCatalogRequest(lookupReq('?preset=anthropic&model=claude-sonnet-4-5'), TEST_ENV, kv);
      const s = await sonnet.json();
      assert.equal(s.found, true);
      assert.equal(s.efforts, null);
      assert.deepEqual(s.budget, { min: 1024, max: 0 });

      // A documented preset gap (bai) still resolves through the same-named
      // model fallback: the model id is listed by other providers, so the
      // console can show the vendor's canonical numbers labelled 按同名模型.
      const bai = await handleModelCatalogRequest(lookupReq('?preset=bai&model=glm-5.3-flash'), TEST_ENV, kv);
      const b = await bai.json();
      assert.equal(b.found, true);
      assert.equal(b.matched_by, 'model_id');
      assert.ok(b.listed_by >= 1);
      assert.ok(b.context_tokens > 0);

      // Genuinely unknown ids still report found=false, never an error.
      const miss = await handleModelCatalogRequest(lookupReq('?preset=deepseek&model=no-such-model'), TEST_ENV, kv);
      assert.equal(miss.status, 200);
      const m = await miss.json();
      assert.equal(m.ok, true);
      assert.equal(m.found, false);
      assert.equal(m.efforts, null);
    });

    test('auth, missing params and absent catalog are rejected without querying anything', async () => {
      const kv = await seededKv();

      const unauth = await handleModelCatalogRequest(lookupReq('?preset=deepseek&model=deepseek-v4-pro', null), TEST_ENV, kv);
      assert.equal(unauth.status, 401);

      const missing = await handleModelCatalogRequest(lookupReq('?preset=deepseek'), TEST_ENV, kv);
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).error, 'preset_and_model_required');

      const empty = await handleModelCatalogRequest(lookupReq('?preset=deepseek&model=deepseek-v4-pro'), TEST_ENV, new MockKV());
      assert.equal(empty.status, 404);
      assert.equal((await empty.json()).error, 'catalog_not_found');
    });

    test('a Full node token is rejected: /lookup stays admin-only like meta and update', async () => {
      const kv = await seededKv();
      const issued = await handleNodesRequest(
        makeAdminReq('POST', '/api/admin/nodes', { name: 'catalog-lookup-full', role: 'full' }),
        TEST_ENV,
        kv
      );
      assert.equal(issued.status, 200);
      const { node_token } = await issued.json();

      const resp = await handleModelCatalogRequest(
        lookupReq('?preset=deepseek&model=deepseek-v4-pro', `Bearer ${node_token}`),
        TEST_ENV,
        kv
      );
      assert.equal(resp.status, 401);
      assert.equal((await resp.json()).ok, false);
    });

    test('the edge entry point serves /lookup too (route entry guard covers the path)', async () => {
      const kv = await seededKv();
      const resp = await edgeModelCatalogAction.onRequestGet({
        request: new Request('https://hub.example.com/api/admin/model-catalog/lookup?preset=openai&model=gpt-5-pro', {
          headers: { authorization: 'Bearer test_admin_pwd' },
        }),
        env: TEST_ENV,
        agent_kv: kv,
      });
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.found, true);
      assert.deepEqual(data.efforts, ['high']);
    });
  });

  // The edge bundle cannot read files, so the provider map / overrides are frozen
  // into generated-model-map.js. A stale copy would make the Hub answer different
  // ladder/toggle questions than a Full node using the same catalog — the exact
  // drift this guard exists to catch.
  test('generated-model-map.js matches shared/model-catalog/{provider-map,overrides}.json', async () => {
    const { renderHubMapModule } = await import('../../scripts/model-catalog/build-hub-map.mjs');
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const providerMapDoc = JSON.parse(readFileSync(join(root, 'shared/model-catalog/provider-map.json'), 'utf8'));
    const overridesDoc = JSON.parse(readFileSync(join(root, 'shared/model-catalog/overrides.json'), 'utf8'));
    const expected = renderHubMapModule(providerMapDoc, overridesDoc);
    const actual = readFileSync(join(root, 'edgeone-hub/lib/generated-model-map.js'), 'utf8');

    const wantMap = new Function(`${expected.replace(/^export const /gm, 'const ')}; return { PROVIDER_MAP, OVERRIDES };`)();
    const gotMap = new Function(`${actual.replace(/^export const /gm, 'const ')}; return { PROVIDER_MAP, OVERRIDES };`)();
    assert.deepEqual(gotMap, wantMap, 're-run scripts/model-catalog/build-hub-map.mjs');
  });

  test('edge-functions entries route base /update and /data through onRequest exports', async () => {
    const kv = new MockKV();
    const ctx = (request, extra = {}) => ({ request, env: TEST_ENV, agent_kv: kv, ...extra });

    const metaResp = await edgeModelCatalog.onRequestGet(
      ctx(new Request('https://hub.example.com/api/admin/model-catalog', { headers: { authorization: 'Bearer test_admin_pwd' } }))
    );
    assert.equal(metaResp.status, 200);
    assert.equal((await metaResp.json()).present, false);

    const updateResp = await edgeModelCatalogAction.onRequestPost(
      ctx(
        new Request('https://hub.example.com/api/admin/model-catalog/update', {
          method: 'POST',
          headers: { authorization: 'Bearer test_admin_pwd' },
        }),
        { fetch: async () => new Response(JSON.stringify(sampleRaw()), { status: 200 }) }
      )
    );
    assert.equal(updateResp.status, 200);
    const updated = await updateResp.json();
    assert.equal(updated.ok, true);
    assert.equal(updated.model_count, 96);

    const dataResp = await edgeModelCatalogAction.onRequestGet(
      ctx(
        new Request('https://hub.example.com/api/admin/model-catalog/data', {
          headers: { authorization: 'Bearer test_admin_pwd' },
        })
      )
    );
    assert.equal(dataResp.status, 200);
    assert.equal(JSON.parse(await dataResp.text()).schema, 1);

    // unauthenticated update is rejected at the entry too
    const unauth = await edgeModelCatalogAction.onRequestPost(
      ctx(new Request('https://hub.example.com/api/admin/model-catalog/update', { method: 'POST' }))
    );
    assert.equal(unauth.status, 401);
  });

  test('slimModelsDev keeps limit.context and reasoning_options and drops description', () => {
    const catalog = slimModelsDev(sampleRaw(), '2026-01-01T00:00:00.000Z');
    assert.equal(catalog.schema, 1);
    assert.equal(catalog.source, 'models.dev');
    assert.equal(catalog.fetched_at, '2026-01-01T00:00:00.000Z');

    const sonnet = catalog.providers.anthropic['claude-sonnet-4-5'];
    assert.equal(sonnet.limit.context, 200000);
    assert.equal(sonnet.limit.output, 64000);
    assert.equal(sonnet.description, undefined);
    assert.equal(sonnet.cost, undefined);
    assert.equal(sonnet.modalities, undefined);
    assert.equal(sonnet.reasoning, true);
    assert.deepEqual(sonnet.reasoning_options, [{ type: 'budget_tokens', min: 1024 }]);
    assert.equal(sonnet.family, 'claude-sonnet');
    assert.equal(sonnet.release_date, '2025-09-29');
    assert.deepEqual(Object.keys(sonnet), ['limit', 'reasoning', 'reasoning_options', 'family', 'release_date']);

    // Pure: calling twice with the same args yields identical text
    assert.equal(JSON.stringify(catalog), JSON.stringify(slimModelsDev(sampleRaw(), '2026-01-01T00:00:00.000Z')));
  });

  // /data is the one catalog action a Full node consumes, so it accepts the
  // node token it already holds instead of the Hub admin password (the node
  // must never be given that password — AGENT_DEPLOY_GUIDE §7). meta and update
  // stay admin-only: they reach the internet / write KV.
  describe('GET /data accepts a full node token, everything else stays admin-only', () => {
    const issue = async (kv, role) => {
      const resp = await handleNodesRequest(
        makeAdminReq('POST', '/api/admin/nodes', { name: `catalog-${role}`, role }),
        TEST_ENV,
        kv
      );
      assert.equal(resp.status, 200);
      return resp.json();
    };
    const dataReq = (token) =>
      new Request('https://hub.example.com/api/admin/model-catalog/data', {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    test('full node token -> 200 with the catalog text verbatim', async () => {
      const kv = new MockKV();
      const text = oldCatalogText();
      await saveCatalog(kv, text);
      const full = await issue(kv, 'full');

      const resp = await handleModelCatalogRequest(dataReq(full.node_token), TEST_ENV, kv);
      assert.equal(resp.status, 200);
      assert.equal(resp.headers.get('content-type'), 'application/json');
      assert.equal(resp.headers.get('cache-control'), 'no-store');
      assert.equal(await resp.text(), text);
    });

    test('lite node token -> 403 (lite does not consume the catalog)', async () => {
      const kv = new MockKV();
      await saveCatalog(kv, oldCatalogText());
      const lite = await issue(kv, 'lite');

      const resp = await handleModelCatalogRequest(dataReq(lite.node_token), TEST_ENV, kv);
      assert.equal(resp.status, 403);
      const body = await resp.text();
      assert.match(body, /lite/i);
      assert.equal(body.includes('old-model'), false, 'the 403 body must not leak the catalog');
    });

    test('revoked full node token -> 401', async () => {
      const kv = new MockKV();
      await saveCatalog(kv, oldCatalogText());
      const full = await issue(kv, 'full');
      const patch = await handleNodesRequest(
        makeAdminReq('PATCH', `/api/admin/nodes/${full.node.id}`, { enabled: false }),
        TEST_ENV,
        kv
      );
      assert.equal(patch.status, 200);

      const resp = await handleModelCatalogRequest(dataReq(full.node_token), TEST_ENV, kv);
      assert.equal(resp.status, 401);
    });

    test('unknown token -> 401', async () => {
      const kv = new MockKV();
      await saveCatalog(kv, oldCatalogText());
      const resp = await handleModelCatalogRequest(dataReq(`stk_node_${'0'.repeat(48)}`), TEST_ENV, kv);
      assert.equal(resp.status, 401);
    });

    test('admin password still returns 200 (existing behaviour unchanged)', async () => {
      const kv = new MockKV();
      const text = oldCatalogText();
      await saveCatalog(kv, text);
      const resp = await handleModelCatalogRequest(dataReq(TEST_ENV.ADMIN_PASSWORD), TEST_ENV, kv);
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), text);
    });

    test('no credentials -> 401', async () => {
      const kv = new MockKV();
      await saveCatalog(kv, oldCatalogText());
      const resp = await handleModelCatalogRequest(dataReq(null), TEST_ENV, kv);
      assert.equal(resp.status, 401);
    });

    test('meta and update still reject a full node token (auth not widened)', async () => {
      const kv = new MockKV();
      const full = await issue(kv, 'full');

      const metaResp = await handleModelCatalogRequest(
        new Request('https://hub.example.com/api/admin/model-catalog', {
          headers: { authorization: `Bearer ${full.node_token}` },
        }),
        TEST_ENV,
        kv
      );
      assert.equal(metaResp.status, 401);

      const updateResp = await handleModelCatalogRequest(
        new Request('https://hub.example.com/api/admin/model-catalog/update', {
          method: 'POST',
          headers: { authorization: `Bearer ${full.node_token}` },
        }),
        TEST_ENV,
        kv,
        async () => {
          throw new Error('node token must not reach models.dev');
        }
      );
      assert.equal(updateResp.status, 401);
      assert.equal(await kv.get(MODEL_CATALOG_KV_KEY), null);
    });
  });
});
