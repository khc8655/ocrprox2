/**
 * Projection Engine: Computes safe, scoped runtime configuration for VM nodes.
 *
 * CRITICAL INVARIANTS:
 * 1. PHYSICAL ZERO-LEAK: No provider or key marked with origin: "local" may ever be projected.
 * 2. SCOPE ISOLATION: Nodes only receive providers and models allowed in their scope.
 */

export function projectConfigForNode(node, config, presetsMap = {}) {
  const scopeProviders = node.scope?.providers || ['*'];
  const scopeModels = node.scope?.models || ['*'];

  const allowAllProviders = scopeProviders.includes('*');
  const allowAllModels = scopeModels.includes('*');

  const projectedProviders = {};
  const projectedAdapterRules = {};

  const sourceProviders = config.providers || {};
  for (const [pId, pData] of Object.entries(sourceProviders)) {
    if (!pData) continue;

    // 1. Physical zero-leak check on provider
    if (pData.origin === 'local') {
      continue;
    }

    // 2. Scope check on provider
    if (!allowAllProviders && !scopeProviders.includes(pId)) {
      continue;
    }

    // 3. Filter keys within provider (physical zero-leak)
    const rawKeys = Array.isArray(pData.api_keys) ? pData.api_keys : [];
    const validKeys = rawKeys.filter((k) => {
      if (!k || !k.enabled) return false;
      if (k.origin === 'local') return false;
      if (!k.key) return false;
      return true;
    });

    if (validKeys.length === 0) {
      // No exportable keys for this provider
      continue;
    }

    // Clone provider data safely
    const projectedProvider = {
      id: pData.id || pId,
      name: pData.name || pId,
      preset_id: pData.preset_id || '',
      api_type: pData.api_type || '',
      base_url: pData.base_url || '',
      anthropic_base_url: pData.anthropic_base_url || '',
      enabled: Boolean(pData.enabled),
      origin: 'vault',
      rule_hash: pData.rule_hash || '',
      api_keys: validKeys.map((k) => {
        const keyOut = {
          id: k.id || k.label,
          label: k.label,
          key: k.key,
          enabled: true,
          origin: 'vault',
          auth_type: k.auth_type || 'api_key',
        };
        if (k.weight) keyOut.weight = k.weight;
        if (k.max_rpm) keyOut.max_rpm = k.max_rpm;
        if (k.remark) keyOut.remark = k.remark;
        return keyOut;
      }),
      model_aliases: pData.model_aliases || {},
    };
    if (pData.rpm_per_key) projectedProvider.rpm_per_key = pData.rpm_per_key;
    if (pData.quota_reset_at) projectedProvider.quota_reset_at = pData.quota_reset_at;
    if (pData.refresh_every) projectedProvider.refresh_every = pData.refresh_every;
    if (pData.auto_include) projectedProvider.auto_include = pData.auto_include;

    // Attach adapter rules directly on ProviderConfig (for Go ProxyConfig deserialization)
    // and keep top-level adapter_rules map for backward compatibility.
    if (pData.adapter_rules && Object.keys(pData.adapter_rules).length > 0) {
      projectedProvider.adapter_rules = pData.adapter_rules;
      projectedAdapterRules[pId] = pData.adapter_rules;
    } else if (pData.preset_id && presetsMap[pData.preset_id]?.adapter_rules) {
      projectedProvider.adapter_rules = presetsMap[pData.preset_id].adapter_rules;
      projectedAdapterRules[pId] = presetsMap[pData.preset_id].adapter_rules;
    }

    projectedProviders[pId] = projectedProvider;
  }

  // Filter agent_models by scope
  const projectedModels = {};
  const sourceModels = config.agent_models || {};
  for (const [mName, mRoute] of Object.entries(sourceModels)) {
    if (!mRoute || !mRoute.enabled) continue;

    if (!allowAllModels && !scopeModels.includes(mName)) {
      continue;
    }

    // Filter candidates to ensure they only reference projected providers
    const validCandidates = (mRoute.candidates || []).filter((c) => {
      if (!c || !c.enabled) return false;
      return Boolean(projectedProviders[c.provider]);
    });

    if (validCandidates.length > 0) {
      const projectedRoute = {
        enabled: true,
        active_key: mRoute.active_key || '',
        routing_strategy: mRoute.routing_strategy || '',
        candidates: validCandidates,
      };
      if (mRoute.no_reasoning) projectedRoute.no_reasoning = true;
      if (mRoute.force_non_stream) projectedRoute.force_non_stream = true;
      projectedModels[mName] = projectedRoute;
    }
  }

  return {
    providers: projectedProviders,
    agent_models: projectedModels,
    settings: config.settings || {},
    adapter_rules: projectedAdapterRules,
  };
}
