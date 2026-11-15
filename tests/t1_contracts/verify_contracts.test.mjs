import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

describe('T1 Static Contracts & Schema Gate Suite', () => {

  describe('T1.settings_contract', () => {
    test('settings.schema.json, runtime-profiles.json, and Go RuntimeSettings 1:1 aligned with no deprecated fields', () => {
      // 1. Load settings.schema.json
      const schemaPath = join(projectRoot, 'shared/config/settings.schema.json');
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
      assert.ok(schema.properties, 'schema must have properties');
      const schemaKeys = Object.keys(schema.properties).sort();

      // 2. Load runtime-profiles.json
      const profilesPath = join(projectRoot, 'shared/config/runtime-profiles.json');
      const runtimeProfiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
      assert.ok(runtimeProfiles.profiles, 'runtime-profiles must have profiles');

      const expectedRoles = ['hub', 'lite', 'full'];
      for (const role of expectedRoles) {
        assert.ok(runtimeProfiles.profiles[role], `profiles must contain '${role}'`);
        const roleSettings = runtimeProfiles.profiles[role].settings;
        assert.ok(roleSettings, `profile '${role}' must have settings`);
        const profileKeys = Object.keys(roleSettings).sort();

        // Every key in roleSettings must be defined in schema
        for (const k of profileKeys) {
          assert.ok(schema.properties[k], `profile key '${k}' in '${role}' must exist in schema.properties`);
        }

        // Check defaults match for all keys present in profile
        for (const [k, v] of Object.entries(roleSettings)) {
          const propDef = schema.properties[k];
          if (propDef && propDef.default !== undefined) {
            assert.deepStrictEqual(
              v,
              propDef.default,
              `default mismatch in '${role}' for key '${k}': profile=${v}, schema=${propDef.default}`
            );
          }
        }
      }

      // 3. Extract RuntimeSettings json tags from Go types.go
      const typesGoPath = join(projectRoot, 'internal/types/types.go');
      const typesGoContent = readFileSync(typesGoPath, 'utf8');

      const structMatch = typesGoContent.match(/type\s+RuntimeSettings\s+struct\s*\{([\s\S]*?)\n\}/);
      assert.ok(structMatch, 'internal/types/types.go must define RuntimeSettings struct');
      const structBody = structMatch[1];

      const goJsonTags = [];
      const tagRegex = /json:"([a-z0-9_]+)(?:,[^"]*)?"/g;
      let match;
      while ((match = tagRegex.exec(structBody)) !== null) {
        goJsonTags.push(match[1]);
      }
      goJsonTags.sort();

      // Assert 1:1 alignment between Go RuntimeSettings and settings.schema.json
      assert.deepStrictEqual(
        goJsonTags,
        schemaKeys,
        `Go RuntimeSettings json tags must match schema.properties 1-to-1.\nGo: ${JSON.stringify(goJsonTags)}\nSchema: ${JSON.stringify(schemaKeys)}`
      );

      // 4. Assert NO resurrected deprecated fields
      const deprecatedFields = [
        'request_total_budget_sec',
        'max_retries',
        'max_attempts_per_provider',
      ];

      for (const dep of deprecatedFields) {
        assert.strictEqual(
          schema.properties[dep],
          undefined,
          `Deprecated field '${dep}' must NOT exist in settings.schema.json`
        );
        for (const role of expectedRoles) {
          assert.strictEqual(
            runtimeProfiles.profiles[role].settings[dep],
            undefined,
            `Deprecated field '${dep}' must NOT exist in runtime-profiles.json for role '${role}'`
          );
        }
        assert.strictEqual(
          goJsonTags.includes(dep),
          false,
          `Deprecated field '${dep}' must NOT exist in Go RuntimeSettings struct`
        );
        assert.strictEqual(
          typesGoContent.includes(`"${dep}"`),
          false,
          `Deprecated field '${dep}' must NOT be referenced in types.go`
        );
      }
    });
  });

  describe('T1.admin_ui_contract', () => {
    test('shared/contracts/admin-ui-backend.json and shared/admin/js/host.js HOST.capabilities match exactly', () => {
      // 1. Read admin-ui-backend.json
      const contractPath = join(projectRoot, 'shared/contracts/admin-ui-backend.json');
      const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
      assert.ok(contract.capabilities, 'contract must have capabilities');
      assert.ok(contract.capabilities.hub, 'contract must have hub capabilities');
      assert.ok(contract.capabilities.full, 'contract must have full capabilities');
      assert.ok(contract.capabilities.lite, 'contract must have lite capabilities');

      // 2. Read host.js and extract capabilities object literal
      const hostJsPath = join(projectRoot, 'shared/admin/js/host.js');
      const hostJsContent = readFileSync(hostJsPath, 'utf8');

      // Extract capabilities object from host.js
      const capMatch = hostJsContent.match(/const\s+capabilities\s*=\s*(\{[\s\S]*?\n\s*\})\[hostKind\]/);
      assert.ok(capMatch, 'host.js must define capabilities dictionary');

      // Safely evaluate object literal
      const parseCapabilities = new Function(`return (${capMatch[1]});`);
      const hostCapabilities = parseCapabilities();

      // Compare hub, full, lite capabilities
      const roles = ['hub', 'full', 'lite'];
      const expectedCaps = [
        'vaultHub',
        'nodeManager',
        'vaultClient',
        'runModes',
        'kbModels',
        'oauthLogin',
        'usageAndTraces',
        'systemUpdate',
      ];

      for (const role of roles) {
        assert.ok(hostCapabilities[role], `host.js must define capabilities for '${role}'`);
        for (const cap of expectedCaps) {
          assert.strictEqual(
            hostCapabilities[role][cap],
            contract.capabilities[role][cap],
            `Capability mismatch for [${role}].${cap}: host.js=${hostCapabilities[role][cap]}, contract=${contract.capabilities[role][cap]}`
          );
        }
      }

      // Check endpoints declaration in admin-ui-backend.json
      assert.ok(contract.endpoints, 'contract must define endpoints');
      const requiredEndpoints = [
        'config_read',
        'config_write',
        'nodes_list',
        'nodes_issue',
        'node_config',
        'verify_search_key',
      ];
      for (const ep of requiredEndpoints) {
        assert.ok(contract.endpoints[ep], `contract must declare endpoint '${ep}'`);
        assert.ok(contract.endpoints[ep].path, `endpoint '${ep}' must have path`);
        assert.ok(contract.endpoints[ep].method, `endpoint '${ep}' must have method`);
        assert.ok(contract.endpoints[ep].roles, `endpoint '${ep}' must have roles`);
      }
      assert.strictEqual(
        contract.endpoints.nodes_status,
        undefined,
        'Option A one-way architecture must not declare nodes_status callback endpoint'
      );

      // Check backend route implementations existence
      const adminGoPath = join(projectRoot, 'internal/admin/admin.go');
      const adminGoContent = readFileSync(adminGoPath, 'utf8');
      const mainGoPath = join(projectRoot, 'cmd/llmproxy/main.go');
      const mainGoContent = readFileSync(mainGoPath, 'utf8');

      for (const [name, ep] of Object.entries(contract.endpoints)) {
        if (ep.roles.includes('full')) {
          // Verify registered in internal/admin/admin.go or cmd/llmproxy/main.go
          const registered = adminGoContent.includes(ep.path) || mainGoContent.includes(ep.path);
          assert.ok(
            registered,
            `Endpoint '${name}' (${ep.path}) with role 'full' must be registered in internal/admin/admin.go or cmd/llmproxy/main.go`
          );
        }

        if (ep.roles.includes('hub')) {
          // Verify implementation file in edgeone-hub/api/
          const clean = ep.path.replace(/^\/api\//, '');
          const directFile = join(projectRoot, 'edgeone-hub/api', `${clean}.js`);
          const noParams = clean.replace(/\/:[^/]+(\/[^/]+)*/, '');
          const baseFile = join(projectRoot, 'edgeone-hub/api', `${noParams}.js`);
          const exists = existsSync(directFile) || existsSync(baseFile);
          assert.ok(
            exists,
            `Endpoint '${name}' (${ep.path}) with role 'hub' must have an implementation file in edgeone-hub/api/`
          );
        }
      }
    });

    test('shared/contracts/mcp-node-contract.json aligns with projectConfigForNode & edge-functions routes', async () => {
      const mcpContractPath = join(projectRoot, 'shared/contracts/mcp-node-contract.json');
      assert.ok(existsSync(mcpContractPath), 'shared/contracts/mcp-node-contract.json must exist');
      const mcpContract = JSON.parse(readFileSync(mcpContractPath, 'utf8'));

      assert.ok(Number.isInteger(mcpContract.contract_version) && mcpContract.contract_version >= 1);
      assert.strictEqual(mcpContract.architecture, 'one_way_pull_zero_heartbeat');
      assert.strictEqual(mcpContract.endpoint?.method, 'POST');
      assert.strictEqual(mcpContract.endpoint?.path, '/api/node/config');
      assert.ok(mcpContract.request_body?.telemetry?.fields?.playwright_ready, 'telemetry must declare playwright_ready');
      assert.ok(mcpContract.request_body?.telemetry?.fields?.search_count, 'telemetry must declare search_count');
      assert.ok(mcpContract.request_body?.telemetry?.fields?.crawl_count, 'telemetry must declare crawl_count');

      const { projectConfigForNode } = await import('../../edgeone-hub/lib/projection.js');
      const projected = projectConfigForNode(
        { scope: { providers: [], models: [], search_providers: ['brave', 'jina'] } },
        {
          providers: { minimax: { enabled: true, origin: 'vault', api_keys: [{ id: 'k1', key: 'sk-1', enabled: true, origin: 'vault' }] } },
          agent_models: {},
          settings: {},
          search_providers: mcpContract.sample_200_response.payload.search_providers,
          search_selection: mcpContract.sample_200_response.payload.search_selection,
        }
      );

      for (const field of mcpContract.response_200.payload_fields) {
        assert.ok(Object.prototype.hasOwnProperty.call(projected, field), `projected payload missing '${field}'`);
      }
      assert.deepStrictEqual(Object.keys(projected.providers), []);
      for (const field of mcpContract.response_200.search_provider_fields) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(projected.search_providers.brave, field),
          `projected search provider missing '${field}'`
        );
      }
      for (const field of mcpContract.response_200.search_key_fields) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(projected.search_providers.brave.api_keys[0], field),
          `projected search api_key missing '${field}'`
        );
      }
      assert.ok(
        existsSync(join(projectRoot, 'edge-functions/api/admin/verify-search-key.js')),
        'edge-functions/api/admin/verify-search-key.js must be generated by build'
      );
      assert.strictEqual(
        existsSync(join(projectRoot, 'edge-functions/api/admin/nodes/[id]/status.js')),
        false,
        'stale edge-functions/api/admin/nodes/[id]/status.js must be removed'
      );
    });
  });

  describe('T1.readonly_route_guard', () => {
    test('internal/router/readonly.go defines AllowedLiteRoutes, FullOnlyRoutes, and ValidateRegisteredRoutes', () => {
      const readonlyGoPath = join(projectRoot, 'internal/router/readonly.go');
      assert.ok(existsSync(readonlyGoPath), 'internal/router/readonly.go must exist');
      const readonlyContent = readFileSync(readonlyGoPath, 'utf8');

      assert.ok(
        readonlyContent.includes('AllowedLiteRoutes'),
        'readonly.go must define AllowedLiteRoutes'
      );
      assert.ok(
        readonlyContent.includes('FullOnlyRoutes'),
        'readonly.go must define FullOnlyRoutes'
      );
      assert.ok(
        readonlyContent.includes('ValidateRegisteredRoutes'),
        'readonly.go must define ValidateRegisteredRoutes'
      );

      // Verify specific route boundaries
      assert.ok(readonlyContent.includes('"GET /healthz"'), 'AllowedLiteRoutes must include GET /healthz');
      assert.ok(readonlyContent.includes('"POST /v1/chat/completions"'), 'AllowedLiteRoutes must include POST /v1/chat/completions');
      assert.ok(readonlyContent.includes('"/api/config"'), 'FullOnlyRoutes must include /api/config');
      assert.ok(readonlyContent.includes('"/api/admin/mode"'), 'FullOnlyRoutes must include /api/admin/mode');
    });
  });

  describe('T1.presets_integrity', () => {
    test('shared/presets/*.json 16 vendor presets are valid syntax and match catalog.json', () => {
      const presetsDir = join(projectRoot, 'shared/presets');
      const allFiles = readdirSync(presetsDir);
      const presetFiles = allFiles
        .filter((f) => f.endsWith('.json') && f !== 'catalog.json')
        .sort();

      assert.strictEqual(presetFiles.length, 16, `Must have exactly 16 preset files, found ${presetFiles.length}`);

      const catalogPath = join(presetsDir, 'catalog.json');
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
      assert.ok(Array.isArray(catalog.providers), 'catalog.json must have providers array');
      assert.strictEqual(catalog.providers.length, 16, 'catalog.json must index all 16 presets');

      const catalogMap = new Map(catalog.providers.map((p) => [p.id, p]));

      for (const file of presetFiles) {
        const filePath = join(presetsDir, file);
        const content = readFileSync(filePath, 'utf8');
        let preset;
        try {
          preset = JSON.parse(content);
        } catch (e) {
          assert.fail(`Preset file ${file} is invalid JSON: ${e.message}`);
        }

        assert.ok(preset.id, `Preset in ${file} must have 'id'`);
        assert.ok(preset.name, `Preset in ${file} must have 'name'`);
        assert.ok(preset.protocol, `Preset in ${file} must have 'protocol'`);
        assert.ok(preset.base_url !== undefined, `Preset in ${file} must have 'base_url'`);

        const rulesStr = JSON.stringify(preset.adapter_rules || {});
        const expectedRuleHash = createHash('sha256').update(rulesStr).digest('hex').slice(0, 12);

        const catalogEntry = catalogMap.get(preset.id);
        assert.ok(catalogEntry, `Preset '${preset.id}' (${file}) not found in catalog.json`);
        assert.strictEqual(catalogEntry.rule_hash, expectedRuleHash, `rule_hash mismatch for preset ${preset.id}`);
        assert.strictEqual(catalogEntry.name, preset.name, `name mismatch for preset ${preset.id}`);
        assert.strictEqual(catalogEntry.base_url, preset.base_url, `base_url mismatch for preset ${preset.id}`);
      }
    });
  });

  describe('T1.ui_layout_and_zero_inline_style', () => {
    test('zero inline style, zero drawer, zero left-border stripes, and bundle <= 245,760 bytes', () => {
      const adminDir = join(projectRoot, 'shared/admin');
      const htmlPath = join(adminDir, 'admin.html');
      const cssPath = join(adminDir, 'css/app.css');
      const hostJsPath = join(adminDir, 'js/host.js');
      const appJsPath = join(adminDir, 'js/app.js');
      const distPath = join(adminDir, 'dist/index.html');

      const html = readFileSync(htmlPath, 'utf8');
      const css = readFileSync(cssPath, 'utf8');
      const hostJs = readFileSync(hostJsPath, 'utf8');
      const appJs = readFileSync(appJsPath, 'utf8');

      // 1. Zero inline style in HTML and JS
      const htmlStyleMatch = html.match(/style\s*=/i);
      assert.strictEqual(htmlStyleMatch, null, 'admin.html must have 0 style= inline attributes');

      const hostStyleMatch = hostJs.match(/style\s*=/i);
      assert.strictEqual(hostStyleMatch, null, 'host.js must have 0 style= inline attributes');

      const appStyleMatch = appJs.match(/style\s*=/i);
      assert.strictEqual(appStyleMatch, null, 'app.js must have 0 style= inline attributes');

      const stylePropMatch = appJs.match(/\.style\.[a-zA-Z]+/i) || hostJs.match(/\.style\.[a-zA-Z]+/i);
      assert.strictEqual(stylePropMatch, null, 'JS must have 0 .style.xxx property manipulations (use [hidden])');

      // 2. Zero drawer in HTML, CSS, JS
      const drawerHtml = html.match(/class\s*=\s*["'][^"']*\bdrawer\b/i);
      assert.strictEqual(drawerHtml, null, 'admin.html must have 0 .drawer classes');

      const drawerCss = css.match(/\.drawer\b/i);
      assert.strictEqual(drawerCss, null, 'app.css must have 0 .drawer classes');

      const drawerJs = appJs.match(/\bdrawer\b/i) || hostJs.match(/\bdrawer\b/i);
      assert.strictEqual(drawerJs, null, 'JS must have 0 drawer components');

      // 3. Zero left-border stripes in CSS
      const leftBorderMatch = css.match(/border-left\s*:\s*[^;]*(#|rgb|hsl|var\(--)/i);
      assert.strictEqual(leftBorderMatch, null, 'app.css must have 0 colored left-border stripes');

      // 4. Dist bundle <= 245,760 bytes (240 KB)
      assert.ok(statSync(distPath), 'shared/admin/dist/index.html must exist');
      const stat = statSync(distPath);
      assert.ok(
        stat.size <= 245760,
        `shared/admin/dist/index.html size (${stat.size} bytes) exceeds 245,760 bytes limit`
      );
    });
  });

  describe('T1.hub_export_guard', () => {
    test('edgeone-hub has no /v1/ traffic proxy and projection.js strictly filters origin === "local"', async () => {
      const hubDir = join(projectRoot, 'edgeone-hub');

      // 1. Recursive scan of edgeone-hub to assert no /v1/ routes or proxy files
      function scanDir(dir) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            assert.strictEqual(
              entry.name.toLowerCase() === 'v1',
              false,
              `Found illegal /v1/ directory in hub: ${fullPath}`
            );
            scanDir(fullPath);
          } else if (entry.isFile()) {
            assert.strictEqual(
              entry.name.toLowerCase().includes('v1'),
              false,
              `Found illegal v1 file in hub: ${fullPath}`
            );

            // Check file content for proxy route registration
            const content = readFileSync(fullPath, 'utf8');
            const v1ProxyRegex = /["']\/v1\/(?:chat\/completions|messages|responses|models)["']/i;
            assert.strictEqual(
              v1ProxyRegex.test(content),
              false,
              `Found /v1/ proxy traffic route in ${fullPath}`
            );
          }
        }
      }
      scanDir(hubDir);

      // 2. projection.js AST / source code check for origin === 'local'
      const projectionPath = join(hubDir, 'lib/projection.js');
      const projectionSrc = readFileSync(projectionPath, 'utf8');
      assert.ok(
        projectionSrc.includes("origin === 'local'") || projectionSrc.includes('origin === "local"'),
        'projection.js must physically check for origin === "local"'
      );

      // 3. Functional behavior test of projectConfigForNode
      const { projectConfigForNode } = await import(projectionPath);
      const testConfig = {
        providers: {
          hub_public: {
            id: 'hub_public',
            name: 'Hub Public Provider',
            origin: 'vault',
            enabled: true,
            api_keys: [
              { label: 'shared-key', key: 'sk-shared-12345678', origin: 'vault', enabled: true },
              { label: 'local-key', key: 'sk-local-secret-999', origin: 'local', enabled: true },
            ],
          },
          hub_private: {
            id: 'hub_private',
            name: 'Hub Private Provider',
            origin: 'local',
            enabled: true,
            api_keys: [
              { label: 'private-key', key: 'sk-private-11111111', origin: 'local', enabled: true },
            ],
          },
        },
        agent_models: {
          'test-model': {
            enabled: true,
            candidates: [
              { provider: 'hub_public', key_label: 'shared-key', enabled: true },
              { provider: 'hub_private', key_label: 'private-key', enabled: true },
            ],
          },
        },
        settings: {
          run_mode: 'agent',
        },
      };

      const node = {
        id: 'node_test',
        scope: { providers: ['*'], models: ['*'] },
      };

      const projected = projectConfigForNode(node, testConfig, {});

      // Physical zero-leak asserts
      assert.strictEqual(projected.providers.hub_private, undefined, 'Provider with origin="local" must NEVER be projected');
      assert.ok(projected.providers.hub_public, 'Public provider must be projected');
      assert.strictEqual(projected.providers.hub_public.api_keys.length, 1, 'Only vault keys can be projected');
      assert.strictEqual(projected.providers.hub_public.api_keys[0].label, 'shared-key');
      assert.strictEqual(projected.providers.hub_public.api_keys[0].key, 'sk-shared-12345678');

      // Candidate targeting private provider must be stripped
      const modelCandidates = projected.agent_models['test-model'].candidates;
      assert.strictEqual(modelCandidates.length, 1, 'Candidates referencing local providers must be stripped');
      assert.strictEqual(modelCandidates[0].provider, 'hub_public');

      // Search providers projection + scope + zero-leak checks
      const searchConfig = {
        ...testConfig,
        search_providers: {
          brave: {
            id: 'brave',
            name: 'Brave Search',
            enabled: true,
            origin: 'vault',
            capabilities: ['search'],
            adapter: 'brave',
            api_keys: [
              { id: 'k1', label: 'k1', key: 'BSA-vault-secret', enabled: true, origin: 'vault' },
              { id: 'k_loc', label: 'k_loc', key: 'BSA-local-leak', enabled: true, origin: 'local' },
            ],
          },
          tavily: {
            id: 'tavily',
            name: 'Tavily',
            enabled: true,
            origin: 'vault',
            capabilities: ['search', 'fetch'],
            adapter: 'tavily',
            api_keys: [{ id: 'k1', label: 'k1', key: 'tvly-vault-secret', enabled: true, origin: 'vault' }],
          },
          local_only: {
            id: 'local_only',
            name: 'Local Private Search',
            enabled: true,
            origin: 'local',
            capabilities: ['search', 'fetch'],
            adapter: 'jina',
            api_keys: [{ id: 'k1', label: 'k1', key: 'jina-local-secret', enabled: true, origin: 'local' }],
          },
        },
        search_selection: {
          search: ['brave', 'tavily', 'local_only'],
          fetch: 'local_only',
        },
      };

      const mcpNode = {
        id: 'node_mcp',
        scope: { providers: [], models: [], search_providers: ['brave'] },
      };
      const mcpProjected = projectConfigForNode(mcpNode, searchConfig, {});
      assert.deepStrictEqual(Object.keys(mcpProjected.providers), [], 'Empty LLM scope must project zero LLM providers');
      assert.deepStrictEqual(Object.keys(mcpProjected.search_providers), ['brave'], 'Only scoped vault search provider may project');
      assert.strictEqual(mcpProjected.search_providers.brave.api_keys.length, 1, 'origin=local search key must be stripped');
      assert.strictEqual(mcpProjected.search_providers.brave.api_keys[0].key, 'BSA-vault-secret');
      assert.deepStrictEqual(mcpProjected.search_selection, { search: ['brave'], fetch: '' }, 'Selection must be filtered to projected search providers');
    });

    test('pure Web Standard gate: edgeone-hub/lib, edgeone-hub/api, and edge-functions have zero node: imports and zero Buffer', () => {
      const dirsToScan = [
        join(projectRoot, 'edgeone-hub/lib'),
        join(projectRoot, 'edgeone-hub/api'),
        join(projectRoot, 'edge-functions'),
      ];

      const forbiddenPatterns = [
        { regex: /["']node:[a-z]/i, desc: 'node:* builtin import' },
        { regex: /\brequire\s*\(/, desc: 'require(...)' },
        { regex: /\bBuffer\.(from|alloc)\b/, desc: 'Buffer.from/alloc' },
        { regex: /\bprocess\.cwd\b/, desc: 'process.cwd' },
      ];

      function scanFiles(dir) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            scanFiles(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.js')) {
            const content = readFileSync(fullPath, 'utf8');

            // For edge-functions, assert zero boundary escaping (no ../edgeone-hub)
            if (fullPath.includes('/edge-functions/')) {
              assert.strictEqual(
                content.includes('../edgeone-hub'),
                false,
                `Found boundary escaping reference '../edgeone-hub' in ${fullPath}`
              );
            }

            for (const { regex, desc } of forbiddenPatterns) {
              const matched = regex.test(content);
              assert.strictEqual(
                matched,
                false,
                `Forbidden Node-specific API '${desc}' detected in ${fullPath}`
              );
            }
          }
        }
      }

      for (const d of dirsToScan) {
        scanFiles(d);
      }
    });

    test('edge-functions route files forbid export * from and explicitly declare onRequest handler', () => {
      const edgeFuncDir = join(projectRoot, 'edge-functions');

      function scanDir(dir) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === '_hub') continue;
            scanDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.js')) {
            const content = readFileSync(fullPath, 'utf8');

            // 1. Edge functions route entry files must NOT use 'export * from'
            assert.strictEqual(
              /export\s+\*\s+from/i.test(content),
              false,
              `Found forbidden 'export * from' in route file: ${fullPath}. EdgeOne AST scanner requires explicit handler declarations.`
            );

            // 2. Must explicitly declare export (async )?function onRequest
            assert.ok(
              /export\s+(?:async\s+)?function\s+onRequest\b/.test(content),
              `Route file must explicitly declare 'export (async )?function onRequest': ${fullPath}`
            );
          }
        }
      }

      scanDir(edgeFuncDir);
    });
  });

});
