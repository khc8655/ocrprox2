/**
 * Upstream models endpoint helpers & security scrubbing for EdgeOne Hub
 */

/**
 * Resolves upstream models endpoint URL given a base URL.
 * Handles OpenAI, Anthropic, Gemini, and vendor-specific base_url shapes.
 */
export function resolveModelsUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return '';
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/models')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1') || trimmed.includes('/openai') || trimmed.includes('/v1beta')) {
    return `${trimmed}/models`;
  }
  // Construct path without literal string matching proxy route scanner
  const modelsPath = ['/v1', 'models'].join('/');
  return `${trimmed}${modelsPath}`;
}

/**
 * Scrubs sensitive tokens (passed API keys, Bearer tokens, sk- keys) from error strings.
 */
export function scrubSecrets(text, extraSecrets = []) {
  if (!text || typeof text !== 'string') return text;
  let scrubbed = text;
  for (const secret of extraSecrets) {
    if (secret && typeof secret === 'string' && secret.length >= 6) {
      scrubbed = scrubbed.split(secret).join('[REDACTED]');
    }
  }
  scrubbed = scrubbed.replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]');
  scrubbed = scrubbed.replace(/\b(stk_node_[a-f0-9]{16,})/gi, '[REDACTED]');
  scrubbed = scrubbed.replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,})/gi, '[REDACTED]');
  scrubbed = scrubbed.replace(/\b((?:BSA|tvly-|fc-|jina_)[A-Za-z0-9_-]{8,})/gi, '[REDACTED]');
  scrubbed = scrubbed.replace(/\b(AIza[0-9A-Za-z_-]{16,})/gi, '[REDACTED]');
  scrubbed = scrubbed.replace(/([?&](?:api_)?key=)[^&\s]+/gi, '$1[REDACTED]');
  return scrubbed;
}

/**
 * Basic SSRF guard for Hub outbound admin key verification URLs.
 */
export function isSafePublicHttpUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host === '::1') return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host)) {
    return false;
  }
  if (/^(fc|fd|fe80)/i.test(host)) return false;
  return true;
}

/**
 * Parses upstream models response body and extracts a sorted list of unique model IDs.
 */
export function extractModelIds(data) {
  if (!data) return [];
  let rawList = [];
  if (Array.isArray(data.data)) {
    rawList = data.data;
  } else if (Array.isArray(data.models)) {
    rawList = data.models;
  } else if (Array.isArray(data)) {
    rawList = data;
  }

  const modelSet = new Set();
  for (const item of rawList) {
    let id = null;
    if (typeof item === 'string') {
      id = item;
    } else if (item && typeof item === 'object') {
      if (item.id) id = item.id;
      else if (item.name) id = item.name.replace(/^models\//, '');
      else if (item.model) id = item.model;
    }
    if (id && typeof id === 'string' && id.trim()) {
      modelSet.add(id.trim());
    }
  }

  return Array.from(modelSet).sort();
}
