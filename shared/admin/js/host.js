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
      HOST.setToken(password);
      // 1. Try login on full node
      try {
        const res = await fetch('/api/admin/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${password}` },
          body: JSON.stringify({ password }),
        });
        if (res.ok) {
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
      } catch (_) {}

      // 2. Validate token against /api/config
      try {
        const testRes = await fetch('/api/config', {
          headers: { 'authorization': `Bearer ${password}` },
        });
        if (testRes.status === 429) {
          HOST.setToken('');
          return { ok: false, error: '尝试过于频繁，已临时锁定，请稍后重试' };
        }
        if (testRes.status === 401) {
          HOST.setToken('');
          return { ok: false, error: '管理员凭据错误，请重试' };
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
      if (token && !headers['authorization']) {
        headers['authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(path, {
        ...options,
        headers,
      });

      if (res.status === 401) {
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

    async checkBalance(data) {
      const res = await HOST.request('/api/admin/balance', {
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

    async syncAutoList(data) {
      const res = await HOST.request('/api/admin/autolist-sync', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      try {
        return await res.json();
      } catch (_) {
        return { ok: res.ok, status: res.status };
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
      return HOST.request('/api/admin/config/export');
    },

    async importConfig(data) {
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
