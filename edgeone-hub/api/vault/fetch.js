import { loadConfig, resolveKvBinding, resolveEnv } from '../../lib/config.js';
import { checkVaultAuth } from '../../lib/vaultauth.js';
import { getPresetMap } from '../../lib/presets.js';
import { resolveAdapterRules } from '../../lib/presetbind.js';
import { touchNodeLastSeen } from '../../lib/nodes.js';
import { ruleHash } from '../../lib/rulehash.js';

export async function handleVaultFetchRequest(request, env, kv) {
  const auth = await checkVaultAuth(request, env, kv);
  if (!auth.ok) return auth.response;

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_json_body' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const { provider, key_label, keys } = body;
  if (!provider) {
    return new Response(
      JSON.stringify({ ok: false, error: 'provider_required' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  if (!auth.isAdmin) {
    const scopeProvs = auth.node?.scope?.providers || ['*'];
    if (!scopeProvs.includes('*') && !scopeProvs.includes(provider)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'provider_out_of_node_scope' }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      );
    }
  }

  const config = await loadConfig(kv);

  if (!auth.isAdmin && auth.node) {
    const clientIp =
      (request.headers.get('eo-connecting-ip') ||
        request.headers.get('cf-connecting-ip') ||
        request.headers.get('x-forwarded-for') ||
        '')
        .split(',')[0]
        .trim() || null;
    try {
      await touchNodeLastSeen(auth.node.id, kv, config._version || 1, {
        ip: clientIp,
        binaryVersion: (request.headers.get('x-node-version') || '').trim(),
      });
    } catch (_) {}
  }

  const pData = config.providers?.[provider];

  if (!pData || pData.origin === 'local' || pData.is_local) {
    return new Response(
      JSON.stringify({ ok: false, error: 'provider_not_found_or_local' }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    );
  }

  const targetLabels = new Set(
    Array.isArray(keys) ? keys : (key_label ? [key_label] : [])
  );

  const matchedKeys = {};
  for (const k of pData.api_keys || []) {
    if (!k || !k.enabled || k.origin === 'local' || k.is_local) continue;
    const lbl = k.label || k.id;
    if (targetLabels.size === 0 || targetLabels.has(lbl)) {
      matchedKeys[lbl] = k.key;
    }
  }

  const presetsMap = getPresetMap();
  // Same resolver as the manifest and the projection: no custom rules -> the
  // CURRENT preset rules, so a new hub-side preset reaches nodes on re-fetch.
  const { rules } = resolveAdapterRules(pData, presetsMap);
  const presetMeta = pData.preset_id ? presetsMap[pData.preset_id] : undefined;

  // api_type and rule_hash are hub-managed like base_url/adapter_rules: the node stores
  // them on fetch, and the manifest publishes the same ruleHash so the node console can
  // flag rule drift. No "enabled" flag here — enabling/disabling is local node state.
  // rpm_per_key is the provider-wide ceiling the scheduler enforces; it MUST ride the
  // payload, otherwise a re-fetch silently resets a node-side limit to 0 (the node adopts
  // the payload wholesale on replace).
  // preset_version likewise: the node records which preset version its rules came
  // from, so the one-click update can tell preset-owned rules from hand-edited ones.
  return new Response(
    JSON.stringify({
      ok: true,
      provider,
      provider_config: {
        name: pData.name || provider,
        preset_id: pData.preset_id || '',
        preset_version: presetMeta ? String(presetMeta.version || '') : '',
        api_type: pData.api_type || '',
        base_url: pData.base_url || '',
        anthropic_base_url: pData.anthropic_base_url || '',
        hide_client_name: Boolean(pData.hide_client_name),
        rpm_per_key: Number(pData.rpm_per_key) || 0,
        adapter_rules: rules || {},
        rule_hash: ruleHash(rules || {}),
        keys: matchedKeys,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// EdgeOne Pages standard entry points
export async function onRequest(context) {
  const kv = resolveKvBinding(context);
  const env = resolveEnv(context);
  return handleVaultFetchRequest(context.request, env, kv);
}

export async function onRequestGet(context) {
  return onRequest(context);
}

export async function onRequestPost(context) {
  return onRequest(context);
}

export async function onRequestPut(context) {
  return onRequest(context);
}

export async function onRequestPatch(context) {
  return onRequest(context);
}

export async function onRequestDelete(context) {
  return onRequest(context);
}

// EdgeOne fetch entry point
export default {
  async fetch(request, env, context) {
    const kv = resolveKvBinding(context || env, env?.KV || env?.EDGE_KV);
    const resolvedEnv = resolveEnv(env || context);
    return handleVaultFetchRequest(request, resolvedEnv, kv);
  },
};
