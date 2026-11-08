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
      runModes: false,
      kbModels: false,
      oauthLogin: false,
      usageAndTraces: false,
      systemUpdate: false,
    },
    full: {
      vaultHub: false,
      nodeManager: false,
      vaultClient: true,
      runModes: true,
      kbModels: true,
      oauthLogin: true,
      usageAndTraces: true,
      systemUpdate: true,
    },
    lite: {
      vaultHub: false,
      nodeManager: false,
      vaultClient: false,
      runModes: false,
      kbModels: false,
      oauthLogin: false,
      usageAndTraces: false,
      systemUpdate: false,
    },
  }[hostKind] || capabilities.full;

  const HOST = {
    kind: hostKind,
    capabilities,

    getToken() {
      return localStorage.getItem('llmproxy_admin_token') || '';
    },

    setToken(token) {
      if (token) {
        localStorage.setItem('llmproxy_admin_token', token);
      } else {
        localStorage.removeItem('llmproxy_admin_token');
      }
    },

    async request(path, options = {}) {
      const headers = {
        'content-type': 'application/json',
        ...(options.headers || {}),
      };

      const token = HOST.getToken();
      if (token && !headers['authorization']) {
        headers['authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(path, {
        ...options,
        headers,
      });

      if (res.status === 401) {
        const entered = prompt('请输入管理员密码 (ADMIN_PASSWORD):');
        if (entered) {
          HOST.setToken(entered);
          headers['authorization'] = `Bearer ${entered}`;
          return fetch(path, { ...options, headers });
        }
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

    async switchMode(mode) {
      const res = await HOST.request('/api/admin/mode', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
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

    async fetchVaultManifest(customHubUrl, customToken) {
      const hubUrl = customHubUrl || '';
      const token = customToken || '';
      const target = hubUrl ? `${hubUrl.replace(/\/+$/, '')}/api/vault/manifest` : '/api/vault/manifest';
      const headers = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await HOST.request(target, { headers });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
      }
    },

    async fetchVaultCredentials(provider, key_label, customHubUrl, customToken) {
      const hubUrl = customHubUrl || '';
      const token = customToken || '';
      const target = hubUrl ? `${hubUrl.replace(/\/+$/, '')}/api/vault/fetch` : '/api/vault/fetch';
      const headers = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await HOST.request(target, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider, key_label }),
      });
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
