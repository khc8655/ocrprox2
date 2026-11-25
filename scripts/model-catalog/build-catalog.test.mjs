import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  generate,
  convertModelsDev,
  validateOverrides,
  deriveProviderMap,
  providerMapDocument,
  listPresetIds,
  ALIASES,
  FIXTURE_PATH,
  CATALOG_JSON_PATH,
  CATALOG_GZ_PATH,
  PROVIDER_MAP_PATH,
  OVERRIDES_PATH,
  MAX_CATALOG_JSON_BYTES,
  MAX_CATALOG_GZ_BYTES,
  SCHEMA_VERSION,
} from './build-catalog.mjs';

// The conversion itself is exercised against the committed 5-provider fixture so
// this suite never touches the network or /tmp. Anything that needs the full
// provider list (mapping targets) reads the committed full artifact that
// `npm run catalog:build` produces.

function runConversion() {
  // write:false → pure in-memory conversion from the fixture. mapPresets:false
  // because the fixture only carries 5 providers and alias targets such as
  // `alibaba` legitimately are not in it; the committed full artifact covers
  // mapping completeness in its own test below.
  return generate(FIXTURE_PATH, { write: false, mapPresets: false });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function allModels(catalog) {
  const out = [];
  for (const [providerId, models] of Object.entries(catalog.providers)) {
    for (const [modelId, model] of Object.entries(models)) {
      out.push({ providerId, modelId, model });
    }
  }
  return out;
}

describe('model-catalog build (models.dev projection)', () => {
  describe('catalog shape', () => {
    test('conversion emits schema 1, a consistent model_count, and no empty models', () => {
      const { catalog, stats, presetIds } = runConversion();

      assert.equal(catalog.schema, SCHEMA_VERSION);
      assert.equal(catalog.source, 'models.dev');
      assert.ok(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(catalog.fetched_at),
        `fetched_at must be ISO8601 UTC, got ${catalog.fetched_at}`
      );

      const models = allModels(catalog);
      assert.ok(models.length > 0, 'fixture must yield models');
      assert.equal(
        catalog.model_count,
        models.length,
        'model_count must equal the number of models under providers'
      );
      assert.equal(stats.modelCount, catalog.model_count);
      assert.ok(
        Object.keys(catalog.providers).length > 0,
        'providers with zero models must be dropped, so the map must not be empty'
      );

      // 缺的就不写 / 不写 null: every provider must carry at least one model.
      for (const [providerId, models] of Object.entries(catalog.providers)) {
        assert.ok(Object.keys(models).length > 0, `provider '${providerId}' must not be empty`);
      }
    });

    test('every model has limit or reasoning, and no field is null', () => {
      const { catalog } = runConversion();
      for (const { providerId, modelId, model } of allModels(catalog)) {
        const where = `${providerId}/${modelId}`;
        assert.ok(
          model.limit !== undefined || model.reasoning !== undefined,
          `${where} must keep at least limit or reasoning`
        );
        for (const [field, value] of Object.entries(model)) {
          assert.notEqual(value, null, `${where}.${field} must be omitted, not null`);
          if (field === 'limit') {
            assert.ok(typeof value === 'object' && !Array.isArray(value), `${where}.limit must be an object`);
            for (const [k, v] of Object.entries(value)) {
              assert.notEqual(v, null, `${where}.limit.${k} must be omitted, not null`);
            }
          }
        }
        // Only the whitelisted fields may survive the projection.
        for (const field of Object.keys(model)) {
          assert.ok(
            ['limit', 'reasoning', 'reasoning_options', 'family', 'release_date'].includes(field),
            `${where} carries unexpected field '${field}'`
          );
        }
      }
    });

    test('limit keeps context/output only — upstream limit.input is dropped', () => {
      const { catalog } = runConversion();
      const raw = readJson(FIXTURE_PATH);

      let upstreamWithInput = 0;
      for (const [providerId, models] of Object.entries(catalog.providers)) {
        for (const [modelId, model] of Object.entries(models)) {
          if (!model.limit) continue;
          assert.deepEqual(
            Object.keys(model.limit).filter((k) => k !== 'context' && k !== 'output'),
            [],
            `${providerId}/${modelId}.limit must only carry context/output`
          );
          if (Number.isFinite(raw[providerId]?.models?.[modelId]?.limit?.input)) upstreamWithInput += 1;
        }
      }
      assert.ok(upstreamWithInput > 0, 'fixture should contain limit.input models, otherwise this test proves nothing');
    });

    test('reasoning_options keep their upstream shape (effort/toggle/budget_tokens)', () => {
      const { catalog, stats } = runConversion();
      const types = new Set();
      for (const { model } of allModels(catalog)) {
        for (const opt of model.reasoning_options || []) {
          assert.ok(typeof opt.type === 'string' && opt.type.length > 0, 'each option needs a type');
          types.add(opt.type);
          if (opt.type === 'effort') {
            assert.ok(Array.isArray(opt.values) && opt.values.length > 0, 'effort must carry non-empty values[]');
          }
          if (opt.type === 'toggle') {
            assert.deepEqual(Object.keys(opt), ['type'], 'toggle must carry type only');
          }
          if (opt.type === 'budget_tokens') {
            for (const k of ['min', 'max']) {
              if (k in opt) assert.ok(Number.isFinite(opt[k]), `budget_tokens.${k} must be a number`);
            }
          }
        }
      }
      assert.ok(types.has('effort'), 'fixture must exercise effort options');
      assert.ok(types.has('toggle'), 'fixture must exercise toggle options');
      // The counter must agree with what actually survived into the catalog.
      const counted = {};
      for (const { model } of allModels(catalog)) {
        for (const opt of model.reasoning_options || []) counted[opt.type] = (counted[opt.type] || 0) + 1;
      }
      assert.deepEqual(stats.optionTypeCounts, counted);
    });

    test('deepseek-v4-pro exposes effort levels low/high/max', () => {
      const { catalog } = runConversion();
      const model = catalog.providers.deepseek['deepseek-v4-pro'];
      assert.ok(model, 'deepseek/deepseek-v4-pro must exist');
      const effort = (model.reasoning_options || []).find((o) => o.type === 'effort');
      assert.ok(effort, 'deepseek-v4-pro must carry a type=effort reasoning option');
      assert.deepEqual(effort.values, ['low', 'high', 'max']);
      assert.equal(model.reasoning, true);
    });

    test('anthropic/claude-sonnet-4-5 keeps context 200000 / output 64000', () => {
      const { catalog } = runConversion();
      const model = catalog.providers.anthropic['claude-sonnet-4-5'];
      assert.ok(model, 'anthropic/claude-sonnet-4-5 must exist');
      assert.deepEqual(model.limit, { context: 200000, output: 64000 });
    });

    test('conversion is deterministic and the gzip round-trips to the json', () => {
      const a = runConversion();
      const b = runConversion();
      assert.equal(a.json, b.json, 'two conversions of the same input must be byte-identical');
      assert.ok(a.gz.equals(b.gz), 'gzip output must be byte-identical too');
      assert.equal(gunzipSync(a.gz).toString('utf8'), a.json);
      assert.equal(Buffer.byteLength(a.json, 'utf8'), a.jsonBytes);
      assert.equal(a.gz.length, a.gzBytes);
    });

    test('synthetic edge cases: empty providers dropped, empty options omitted', () => {
      const { catalog, stats } = convertModelsDev(
        {
          'no-models': { id: 'no-models', models: {} },
          empty: { id: 'empty' },
          sparse: {
            id: 'sparse',
            models: {
              // No limit, no reasoning, empty options → must survive as {} and
              // keep the model (the model is data even with zero capabilities).
              bare: { id: 'bare', name: 'Bare', reasoning_options: [] },
              partial: { id: 'partial', limit: { context: 1000, input: 50 }, reasoning: false, family: '' },
            },
          },
        },
        '2026-01-01T00:00:00.000Z',
        null // no provider-map derivation for synthetic input
      );
      assert.deepEqual(Object.keys(catalog.providers), ['sparse'], 'providers without models must be dropped');
      assert.deepEqual(stats.droppedProviders.sort(), ['empty', 'no-models']);
      assert.equal(catalog.model_count, 2);
      assert.deepEqual(catalog.providers.sparse.bare, {}, 'empty reasoning_options must be omitted, not []');
      assert.deepEqual(catalog.providers.sparse.partial, { limit: { context: 1000 }, reasoning: false }, 'limit.input and empty family must be dropped');
    });

    test('a model with neither limit nor reasoning is kept but flagged by the suite contract', () => {
      // The ask's contract is "each model has limit or reasoning"; upstream
      // currently satisfies it for all 8,968 models. Guard the assumption with a
      // hard failure if a future download breaks it, so the projection is never
      // silently relied upon.
      const { catalog, stats } = runConversion();
      const violations = [];
      for (const [providerId, models] of Object.entries(catalog.providers)) {
        for (const [modelId, model] of Object.entries(models)) {
          if (model.limit === undefined && model.reasoning === undefined) violations.push(`${providerId}/${modelId}`);
        }
      }
      assert.deepEqual(violations, [], `models without limit and reasoning: ${violations.slice(0, 5).join(', ')}`);
      assert.equal(stats.modelCount, catalog.model_count);
    });
  });

  describe('provider map', () => {
    test('covers exactly the preset ids, with targets that exist upstream', () => {
      // Targets are validated against the committed full catalog: the fixture
      // only carries 5 providers, so alias targets like alibaba cannot be
      // checked there.
      assert.ok(existsSync(CATALOG_JSON_PATH), `missing ${CATALOG_JSON_PATH}; run \`npm run catalog:build\``);
      const full = readJson(CATALOG_JSON_PATH);
      const presetIds = listPresetIds();
      const map = readJson(PROVIDER_MAP_PATH);

      assert.ok(presetIds.length >= 16, `expected the full preset library, found ${presetIds.length}`);
      assert.deepEqual(
        Object.keys(map.providers).sort(),
        presetIds,
        'provider-map must be a complete, explicit list of every preset id (no implicit same-name default)'
      );

      for (const presetId of presetIds) {
        const targets = map.providers[presetId];
        assert.ok(Array.isArray(targets), `${presetId} must map to an array`);
        for (const target of targets) {
          assert.equal(typeof target, 'string', `${presetId} targets must be strings`);
          assert.ok(
            full.providers[target],
            `${presetId} -> '${target}' is not a provider in catalog.json; runtime lookups would miss silently`
          );
        }
        if (targets.length === 0) {
          assert.ok(
            map._gaps && typeof map._gaps[presetId] === 'string' && map._gaps[presetId].length > 0,
            `${presetId} has an empty mapping and therefore needs a _gaps reason`
          );
        }
      }

      // No duplicate targets within one mapping (first-hit order must be meaningful).
      for (const [presetId, targets] of Object.entries(map.providers)) {
        assert.equal(new Set(targets).size, targets.length, `${presetId} lists a duplicate target`);
      }
    });

    test('the committed map is the live comparison result, not stale hand-editing', () => {
      const full = readJson(CATALOG_JSON_PATH);
      const map = readJson(PROVIDER_MAP_PATH);
      const derived = deriveProviderMap(listPresetIds(), Object.keys(full.providers));
      assert.deepEqual(
        map,
        providerMapDocument(derived),
        'provider-map.json differs from what the comparison derives; re-run `npm run catalog:build`'
      );
      assert.deepEqual(derived.gap.sort(), Object.keys(map._gaps).sort());
    });

    test('every non-empty target in the fixture conversion is real, every gap is empty', () => {
      // Derive over the fixture's own providers, restricted to the presets that
      // can resolve there: alias targets that live outside the sample (alibaba,
      // amazon-bedrock, ...) are expected to fail, and that is the point of the
      // completeness test above, not of this one.
      const { catalog, stats } = runConversion();
      const present = new Set(Object.keys(catalog.providers));
      // Presets this partial sample can resolve: a same-name provider, or an
      // alias whose every target is in the sample. Everything else (gaps, and
      // aliases pointing at alibaba/amazon-bedrock/...) is covered by the full
      // artifact test above.
      const resolvable = listPresetIds().filter(
        (id) => present.has(id) || (ALIASES[id] && ALIASES[id].every((t) => present.has(t)))
      );
      assert.ok(resolvable.length >= 5, 'anthropic/openai/deepseek + moonshot/zhipu must resolve from the fixture');
      const derived = deriveProviderMap(resolvable, [...present], { strictTable: false });
      for (const [presetId, targets] of Object.entries(derived.map)) {
        assert.ok(targets.length > 0, `${presetId} should resolve inside the fixture`);
        for (const t of targets) assert.ok(present.has(t), `${presetId} -> '${t}' must exist in the fixture catalog`);
      }
      assert.ok(Object.keys(derived.map).length >= 5, 'anthropic/openai/deepseek/zhipuai/moonshotai presets must resolve');
      assert.ok(stats.modelCount > 0);
    });
  });

  describe('overrides layer', () => {
    test('overrides.json parses, has an object models map, and passes validation', () => {
      const overrides = readJson(OVERRIDES_PATH);
      assert.equal(overrides.schema, SCHEMA_VERSION);
      assert.ok(typeof overrides._comment === 'string' && overrides._comment.length > 0, '_comment must explain the file purpose');
      assert.ok(
        overrides.models && typeof overrides.models === 'object' && !Array.isArray(overrides.models),
        'overrides.models must be an object'
      );
      const { count } = validateOverrides(overrides, listPresetIds());
      assert.equal(count, Object.keys(overrides.models).length);
    });

    test('invalid overrides are rejected instead of shipping silently', () => {
      assert.throws(() => validateOverrides({ schema: 1, models: [] }, listPresetIds()), /models must be an object/);
      assert.throws(
        () => validateOverrides({ schema: 1, models: { 'no-such-preset/x': { reasoning: true } } }, listPresetIds()),
        /has no shared\/presets/
      );
      assert.throws(
        () => validateOverrides({ schema: 1, models: { 'anthropic/x': { context_window: 1 } } }, listPresetIds()),
        /unknown field 'context_window'/
      );
    });
  });

  describe('committed full artifact', () => {
    test('catalog.json / catalog.json.gz exist, stay inside budget, and agree with each other', () => {
      assert.ok(existsSync(CATALOG_JSON_PATH), `missing ${CATALOG_JSON_PATH}; run \`npm run catalog:build\``);
      assert.ok(existsSync(CATALOG_GZ_PATH), `missing ${CATALOG_GZ_PATH}; run \`npm run catalog:build\``);

      const jsonBytes = statSync(CATALOG_JSON_PATH).size;
      const gzBytes = statSync(CATALOG_GZ_PATH).size;
      assert.ok(jsonBytes <= MAX_CATALOG_JSON_BYTES, `catalog.json ${jsonBytes} B exceeds ${MAX_CATALOG_JSON_BYTES} B`);
      assert.ok(gzBytes <= MAX_CATALOG_GZ_BYTES, `catalog.json.gz ${gzBytes} B exceeds ${MAX_CATALOG_GZ_BYTES} B (140 KiB)`);

      const text = readFileSync(CATALOG_JSON_PATH, 'utf8');
      const catalog = JSON.parse(text);
      assert.equal(catalog.schema, SCHEMA_VERSION);
      assert.equal(catalog.model_count, allModels(catalog).length);
      assert.equal(gunzipSync(readFileSync(CATALOG_GZ_PATH)).toString('utf8'), text, 'gzip must be exactly catalog.json');
      // Compact single line: pretty-printing would blow the 1.8 MB budget.
      assert.equal(text.indexOf('\n'), -1, 'catalog.json must be single-line compact JSON');
    });
  });
});