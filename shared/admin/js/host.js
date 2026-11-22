/**
 * host.js — LLMProxy2 Host Adapter and Capability Provider
 */

(function () {
  const hostKind = window.__HOST_KIND__ || (location.hostname.includes('hub') ? 'hub' : 'full');

  const capabilities = {
    hub: {
      vaultHub: true,
      nodeManager: true,
      vaultClient: false,
      kbModels: false,
      oauthLogin: false,
      usageAndTraces: false,
      systemUpdate: false,
    },
    full: {
      vaultHub: false,
      nodeManager: false,
      vaultClient: true,
      kbModels: true,
      oauthLogin: true,
      usageAndTraces: true,
      systemUpdate: true,
    },
    lite: {
      vaultHub: false,
      nodeManager: false,
      vaultClient: false,
      kbModels: false,
      oauthLogin: false,
      usageAndTraces: false,
      systemUpdate: false,
    },
  }[hostKind] || {
    vaultHub: false,
    nodeManager: false,
    vaultClient: true,
    kbModels: true,
    oauthLogin: true,
    usageAndTraces: true,
    systemUpdate: true,
  };

  const SESSION_MARKER = '__cookie_session__';
  let memoryToken = ''; // fallback when storage is blocked (private browsing)

  function isMaskedVaultToken(val) {
    if (!val || typeof val !== 'string') return false;
    return val.includes('●') || val.includes('•') || val.includes('***') || val.includes('...');
  }

  function normalizeProviderMap(rawMap, defaultOrigin) {
    const out = {};
    for (const [pId, p] of Object.entries(rawMap || {})) {
      if (!p || typeof p !== 'object') continue;
      let apiKeys = Array.isArray(p.api_keys) ? p.api_keys.map((k) => ({ ...k })) : [];
      if (apiKeys.length === 0 && p.keys && typeof p.keys === 'object') {
        apiKeys = Object.entries(p.keys).map(([lbl, secret], idx) => ({
          id: `k_${lbl || idx}`,
          label: lbl,
          key: typeof secret === 'string' ? secret : (secret?.key || ''),
          enabled: typeof secret === 'object' ? secret.enabled !== false : true,
          origin: (typeof secret === 'object' && secret.origin) || p.origin || defaultOrigin || 'vault',
        }));
      }
      out[pId] = {
        ...p,
        name: p.name || pId,
        enabled: p.enabled !== false,
        origin: p.origin || defaultOrigin || 'vault',
        api_keys: apiKeys,
      };
      delete out[pId].keys;
    }
    return out;
  }

  function normalizeImportedConfig(raw, defaultOrigin) {
    const src = raw?.config && typeof raw.config === 'object' ? raw.config : raw || {};
    const providers = normalizeProviderMap(src.providers, defaultOrigin);

    const agentModels = {};
    for (const [mName, m] of Object.entries(src.agent_models || {})) {
      if (!m || typeof m !== 'object') continue;
      let candidates = Array.isArray(m.candidates) ? m.candidates.map((c) => ({ ...c })) : [];
      if (candidates.length === 0 && Array.isArray(m.keys)) {
        candidates = m.keys.map((k) => ({
          provider: k.provider || '',
          key_label: k.key_label || k.key || '',
          target_model: k.target_model || k.model || mName,
          enabled: k.enabled !== false,
          weight: k.weight || 1,
        }));
      }
      agentModels[mName] = {
        routing_strategy: m.routing_strategy || 'sticky_failover',
        active_key: m.active_key || '',
        enabled: m.enabled !== false,
        candidates,
      };
    }

    const kbModels = {};
    const rawKb = src.kb_models || src.candidates || {};
    for (const [cat, list] of Object.entries(rawKb)) {
      if (!Array.isArray(list)) continue;
      kbModels[cat] = list.map((c) => ({
        provider: c.provider || '',
        key_label: c.key_label || c.key || '',
        model: c.model || c.target_model || '',
        max_concurrency: Number(c.max_concurrency || c.max_conc) || 4,
        enabled: c.enabled !== false,
      }));
    }

    return {
      providers,
      agent_models: agentModels,
      kb_models: kbModels,
      settings: src.settings && typeof src.settings === 'object' ? { ...src.settings } : {},
    };
  }

  const HOST = {
    kind: hostKind,
    capabilities,

    getToken() {
      // Hub has no login endpoint (the admin password IS the bearer credential), so
      // the value cannot be replaced by a server-issued session token. Keep it in
      // sessionStorage only: it dies with the tab and never lands in the long-lived
      // localStorage profile that any origin script or later user can read back.
      // Full uses the opaque SESSION_MARKER + HttpOnly cookie instead.
      try {
        return sessionStorage.getItem('llmproxy_admin_token') || memoryToken;
      } catch (_) {
        return memoryToken;
      }
    },

    setToken(token) {
      try {
        if (token) {
          sessionStorage.setItem('llmproxy_admin_token', token);
        } else {
          sessionStorage.removeItem('llmproxy_admin_token');
        }
      } catch (_) {
        // Storage unavailable (private mode): stay in-memory only.
        memoryToken = token || '';
      }
      // Migrate any value left behind by an older build so it stops persisting.
      try {
        localStorage.removeItem('llmproxy_admin_token');
      } catch (_) {}
    },

    showLogin() {
      const scr = document.getElementById('loginScreen');
      if (scr) {
        scr.hidden = false;
        scr.classList.remove('hidden');
        const err = document.getElementById('loginError');
        if (err) {
          err.hidden = true;
          err.classList.add('hidden');
          err.textContent = '';
        }
        const pwd = document.getElementById('loginPassword');
        if (pwd) pwd.focus();
      }
    },

    hideLogin() {
      const scr = document.getElementById('loginScreen');
      if (scr) {
        scr.hidden = true;
        scr.classList.add('hidden');
      }
    },

    async login(password) {
      if (hostKind === 'full') {
        try {
          const res = await fetch('/api/admin/auth/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password }),
          });
          if (res.ok) {
            HOST.setToken(SESSION_MARKER);
            HOST.hideLogin();
            return { ok: true };
          }
          if (res.status === 429) {
            let retry = '';
            try {
              const body = await res.json();
              if (body && body.retry_after_sec) retry = `（约 ${Math.ceil(body.retry_after_sec / 60)} 分钟后重试）`;
            } catch (_) {}
            HOST.setToken('');
            return { ok: false, error: `尝试过于频繁，已临时锁定${retry}` };
          }
          if (res.status === 401 || res.status === 403 || res.status === 503) {
            let errMsg = '管理员凭据错误，请重试';
            try {
              const body = await res.json();
              if (body && body.error && res.status === 503) errMsg = body.error;
            } catch (_) {}
            HOST.setToken('');
            return { ok: false, error: errMsg };
          }
        } catch (err) {
          return { ok: false, error: err.message || '网络连接失败' };
        }
      }

      HOST.setToken(password);
      // Validate Bearer token against /api/config (Hub stateless KV)
      try {
        const testRes = await fetch('/api/config', {
          credentials: 'same-origin',
          headers: { 'authorization': `Bearer ${password}` },
        });
        if (testRes.status === 429) {
          HOST.setToken('');
          return { ok: false, error: '尝试过于频繁，已临时锁定，请稍后重试' };
        }
        if (testRes.status === 401 || testRes.status === 503) {
          let errMsg = '管理员凭据错误，请重试';
          if (testRes.status === 503) {
            try {
              const body = await testRes.json();
              if (body && body.error) errMsg = body.error;
            } catch (_) {}
          }
          HOST.setToken('');
          return { ok: false, error: errMsg };
        }
        HOST.hideLogin();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || '网络连接失败' };
      }
    },

    async request(path, options = {}) {
      const headers = {
        'content-type': 'application/json',
        ...(options.headers || {}),
      };

      const token = HOST.getToken();
      if (token && token !== SESSION_MARKER && !headers['authorization']) {
        headers['authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers,
      });

      if (res.status === 401) {
        // Drop the stale credential: otherwise the 3s lane poll keeps retrying
        // with a bad token, and 5 such hits put the admin IP into the 10-minute
        // anti-bruteforce lockout — even for the correct password.
        HOST.setToken('');
        HOST.showLogin();
      }

      return res;
    },

    async getConfig() {
      const res = await HOST.request('/api/config');
      return res.json();
    },

    async saveConfig(config) {
      const res = await HOST.request('/api/config', {
        method: 'POST',
        body: JSON.stringify(config),
      });
      return { status: res.status, data: await res.json() };
    },

    async getNodes() {
      const res = await HOST.request('/api/admin/nodes');
      return res.json();
    },

    async issueNode(data) {
      const res = await HOST.request('/api/admin/nodes', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return res.json();
    },

    async patchNode(id, data) {
      const res = await HOST.request(`/api/admin/nodes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      return res.json();
    },

    async rotateNode(id) {
      const res = await HOST.request(`/api/admin/nodes/${encodeURIComponent(id)}/rotate`, {
        method: 'POST',
      });
      return res.json();
    },

    // Re-obtain the one-click install command for an existing node. The hub
    // rotates the NODE_TOKEN (KV keeps only the SHA-256 digest), so the caller
    // must treat the returned token as the node's new credential.
    async getNodeInstallCommand(id) {
      const res = await HOST.request(`/api/admin/nodes/${encodeURIComponent(id)}/install-command`);
      return res.json();
    },

    async deleteNode(id) {
      const res = await HOST.request(`/api/admin/nodes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      return res.json();
    },

    async getUsage(period = 'today', tz = 'Asia/Shanghai') {
      const res = await HOST.request(`/api/admin/usage?period=${period}&tz=${encodeURIComponent(tz)}`);
      return res.json();
    },

    async getTraces() {
      const res = await HOST.request('/api/admin/traces');
      return res.json();
    },

    async clearTraces() {
      const res = await HOST.request('/api/admin/traces', { method: 'DELETE' });
      return res.json();
    },

    async getLanes() {
      const res = await HOST.request('/api/lanes');
      return res.json();
    },

    async getCooldowns() {
      const res = await HOST.request('/api/admin/cooldowns');
      return res.json();
    },

    async clearCooldowns(target) {
      const path = target ? `/api/admin/cooldowns?target=${encodeURIComponent(target)}` : '/api/admin/cooldowns';
      const res = await HOST.request(path, { method: 'DELETE' });
      return res.json();
    },

    async probeModels(data) {
      const res = await HOST.request('/api/admin/probe-models', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
      }
    },

    async verifyKey(data) {
      const res = await HOST.request('/api/admin/verify-key', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
      }
    },

    async detectProvider(data) {
      const res = await HOST.request('/api/admin/detect-provider', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
      }
    },

    async getPresetsExtra() {
      const res = await HOST.request('/api/admin/presets-extra');
      try {
        return await res.json();
      } catch (_) {
        return { ok: false };
      }
    },

    async startOAuth(data) {
      const res = await HOST.request('/api/admin/oauth/start', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return res.json();
    },

    async pollOAuth(data) {
      const res = await HOST.request('/api/admin/oauth/poll', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return res.json();
    },

    async testCandidate(data) {
      const res = await HOST.request('/api/admin/test-candidate', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return res.json();
    },

    async testAgentModel(data) {
      const res = await HOST.request('/api/admin/test-agent-model', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return res.json();
    },

    async exportConfig() {
      if (hostKind === 'hub') {
        const cfg = await HOST.getConfig();
        const json = JSON.stringify(cfg, null, 2);
        return {
          ok: true,
          blob: async () => new Blob([json], { type: 'application/json' }),
          json: async () => cfg,
        };
      }
      return HOST.request('/api/admin/config/export');
    },

    async importConfig(data) {
      if (hostKind === 'hub') {
        const mode = data?.mode || 'merge';
        const raw = data?.config || data || {};
        const cur = await HOST.getConfig();
        const norm = normalizeImportedConfig(raw, 'vault');
        const target = mode === 'overwrite'
          ? {
              _version: cur?._version || 1,
              providers: norm.providers,
              search_providers: norm.search_providers,
              search_selection: norm.search_selection,
              agent_models: norm.agent_models,
              kb_models: norm.kb_models,
              settings: { ...(cur?.settings || {}), ...(norm.settings || {}) },
            }
          : {
              ...cur,
              providers: { ...(cur?.providers || {}), ...norm.providers },
              search_providers: { ...(cur?.search_providers || {}), ...norm.search_providers },
              search_selection: norm.search_selection?.search?.length || norm.search_selection?.fetch
                ? norm.search_selection
                : (cur?.search_selection || { search: [], fetch: '' }),
              agent_models: { ...(cur?.agent_models || {}), ...norm.agent_models },
              kb_models: { ...(cur?.kb_models || {}), ...norm.kb_models },
              settings: { ...(cur?.settings || {}), ...(norm.settings || {}) },
            };
        const saved = await HOST.saveConfig(target);
        return saved?.data || saved || { ok: true };
      }
      const res = await HOST.request('/api/admin/config/import', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return res.json();
    },

    async getAccessInfo() {
      const res = await HOST.request('/api/admin/access-info');
      try {
        return await res.json();
      } catch (_) {
        return { ok: false };
      }
    },

    async updateAccessKey(data) {
      const res = await HOST.request('/api/admin/access-key', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok };
      }
    },

    async fetchVaultManifest(customHubUrl, customToken) {
      if (hostKind === 'full') {
        // POST body: the node token must not ride in the URL, where access/CDN logs
        // would retain it (the /api/vault/fetch proxy already uses the same shape).
        const payload = {};
        const hubUrl = typeof customHubUrl === 'string' ? customHubUrl.trim() : '';
        const nodeToken = typeof customToken === 'string' ? customToken.trim() : '';
        if (hubUrl) payload.hub_url = hubUrl;
        if (nodeToken && !isMaskedVaultToken(nodeToken)) {
          payload.node_token = nodeToken;
        }
        const res = await HOST.request('/api/vault/manifest', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        try {
          return await res.json();
        } catch (_) {
          return { ok: res.ok, status: res.status };
        }
      }
      const res = await HOST.request('/api/vault/manifest');
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
      }
    },

    async fetchVaultCredentials(provider, key_label, customHubUrl, customToken, keys) {
      if (hostKind === 'full') {
        const hubUrl = typeof customHubUrl === 'string' ? customHubUrl.trim() : '';
        const nodeToken = typeof customToken === 'string' ? customToken.trim() : '';
        const payload = { provider };
        if (key_label !== undefined) payload.key_label = key_label;
        if (Array.isArray(keys)) payload.keys = keys;
        if (hubUrl) payload.hub_url = hubUrl;
        if (nodeToken && !isMaskedVaultToken(nodeToken)) {
          payload.node_token = nodeToken;
        }
        const res = await HOST.request('/api/vault/fetch', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        try {
          return await res.json();
        } catch (_) {
          return { ok: res.ok, status: res.status };
        }
      }
      const payload = { provider };
      if (key_label !== undefined) payload.key_label = key_label;
      if (Array.isArray(keys)) payload.keys = keys;
      const res = await HOST.request('/api/vault/fetch', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
      }
    },

    async logout() {
      if (hostKind === 'full') {
        try {
          await fetch('/api/admin/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (_) {}
      }
      HOST.setToken('');
    },

    async getSystemVersion() {
      const res = await HOST.request('/api/admin/system/version');
      try {
        return await res.json();
      } catch (_) {
        return { ok: false };
      }
    },

    async checkSystemUpdate() {
      const res = await HOST.request('/api/admin/system/check-update');
      try {
        return await res.json();
      } catch (_) {
        return { ok: false };
      }
    },

    async upgradeSystem() {
      const res = await HOST.request('/api/admin/system/upgrade', { method: 'POST' });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
      }
    },

    async restartService() {
      const res = await HOST.request('/api/admin/restart', { method: 'POST' });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
      }
    },
  };

  HOST.api = HOST;

  window.HOST = HOST;
})();
