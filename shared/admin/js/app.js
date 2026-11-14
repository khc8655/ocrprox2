/**
 * app.js — Magpie Minimalist Admin UI Controller
 * Zero inline style, no slide-over panels, zero left-border stripes, inline row editors.
 */

(function () {
  const state = {
    config: null,
    nodes: [],
    usage: null,
    traces: [],
    activeTab: 'providers',
    activeEditorKey: null,
    filterOnlyRetried: false,
    currentPeriod: 'today',
  };

  function toast(msg, type = 'info') {
    const box = document.getElementById('toastBox');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast';
    const dot = document.createElement('span');
    dot.className = `dot dot--${type === 'err' ? 'err' : type === 'warn' ? 'warn' : 'ok'}`;
    const txt = document.createElement('span');
    txt.textContent = msg;
    el.appendChild(dot);
    el.appendChild(txt);
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- Initializer ---
  async function init() {
    setupCapabilities();
    setupTheme();
    setupNavigation();
    setupCreationForms();
    await loadData();
  }

  function setupCapabilities() {
    const caps = window.HOST.capabilities;
    const isHub = window.HOST.kind === 'hub';

    const brandRole = document.getElementById('brandRole');
    if (brandRole) brandRole.textContent = isHub ? 'Hub' : 'Full';

    // Show/hide nav buttons based on capabilities
    const navModels = document.getElementById('navModels');
    const navNodes = document.getElementById('navNodes');
    const navActivity = document.getElementById('navActivity');
    const topVersionBox = document.getElementById('topVersionBox');
    const modeSwitchBox = document.getElementById('modeSwitchBox');
    const vaultSyncBar = document.getElementById('vaultSyncBar');
    const cfgVaultUrlGroup = document.getElementById('cfgVaultUrlGroup');
    const cfgVaultTokenGroup = document.getElementById('cfgVaultTokenGroup');

    if (navModels) navModels.hidden = !caps.runModes;
    if (navNodes) navNodes.hidden = !caps.nodeManager;
    if (navActivity) navActivity.hidden = !caps.usageAndTraces;
    if (topVersionBox) topVersionBox.hidden = !caps.vaultHub;
    if (modeSwitchBox) modeSwitchBox.hidden = !caps.runModes;
    if (vaultSyncBar) vaultSyncBar.hidden = !caps.vaultClient;
    if (cfgVaultUrlGroup) cfgVaultUrlGroup.hidden = !caps.vaultClient;
    if (cfgVaultTokenGroup) cfgVaultTokenGroup.hidden = !caps.vaultClient;

    state.activeTab = isHub ? 'providers' : 'models';
    switchTab(state.activeTab);
  }

  function setupTheme() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    const saved = localStorage.getItem('llmproxy_theme') || 'auto';
    applyTheme(saved);

    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'auto';
      const next = cur === 'dark' ? 'light' : cur === 'light' ? 'auto' : 'dark';
      applyTheme(next);
      localStorage.setItem('llmproxy_theme', next);
    });
  }

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function setupNavigation() {
    const seg = document.getElementById('navSeg');
    if (!seg) return;
    seg.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab) switchTab(tab);
      });
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        window.HOST.setToken('');
        location.reload();
      });
    }

    const modeBtnAgent = document.getElementById('modeBtnAgent');
    const modeBtnKB = document.getElementById('modeBtnKB');
    if (modeBtnAgent && modeBtnKB) {
      modeBtnAgent.addEventListener('click', () => switchRunMode('agent'));
      modeBtnKB.addEventListener('click', () => switchRunMode('kb'));
    }

    const btnIssueNode = document.getElementById('btnIssueNode');
    if (btnIssueNode) {
      btnIssueNode.addEventListener('click', () => {
        const form = document.getElementById('issueNodeForm');
        if (form) form.hidden = !form.hidden;
      });
    }

    const btnDoIssue = document.getElementById('btnDoIssue');
    if (btnDoIssue) {
      btnDoIssue.addEventListener('click', handleIssueNode);
    }

    const btnSyncManifest = document.getElementById('btnSyncManifest');
    if (btnSyncManifest) {
      btnSyncManifest.addEventListener('click', handleSyncManifest);
    }

    const btnSyncKeys = document.getElementById('btnSyncKeys');
    if (btnSyncKeys) {
      btnSyncKeys.addEventListener('click', handleSyncFromVault);
    }

    const periodSeg = document.getElementById('activityPeriodSeg');
    if (periodSeg) {
      periodSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const p = btn.getAttribute('data-period');
          if (!p || p === state.currentPeriod) return;
          state.currentPeriod = p;
          periodSeg.querySelectorAll('.seg-btn').forEach((b) => {
            if (b.getAttribute('data-period') === p) {
              b.classList.add('active');
            } else {
              b.classList.remove('active');
            }
          });
          await loadActivityData();
        });
      });
    }
  }

  const PRESETS_META = {
    openai: ['openai', 'OpenAI', 'https://api.openai.com/v1', 'openai-completions'],
    anthropic: ['anthropic', 'Anthropic', 'https://api.anthropic.com/v1', 'anthropic-messages'],
    gemini: ['gemini', 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini'],
    deepseek: ['deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'openai-completions'],
    openrouter: ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'openai-completions'],
    siliconflow: ['siliconflow', 'SiliconFlow', 'https://api.siliconflow.cn/v1', 'openai-completions'],
    groq: ['groq', 'Groq', 'https://api.groq.com/openai/v1', 'openai-completions'],
    xai: ['xai', 'xAI', 'https://api.x.ai/v1', 'openai-completions'],
  };

  function setupCreationForms() {
    const pForm = document.getElementById('addProviderForm');
    const mForm = document.getElementById('addModelForm');
    const toggle = (el, show) => {
      if (!el) return;
      el.hidden = show !== undefined ? !show : !el.hidden;
      el.classList.toggle('hidden', el.hidden);
    };

    document.getElementById('btnAddProvider')?.addEventListener('click', () => toggle(pForm));
    document.getElementById('btnCancelAddProvider')?.addEventListener('click', () => toggle(pForm, false));

    document.getElementById('newProvPreset')?.addEventListener('change', (e) => {
      const m = PRESETS_META[e.target.value];
      if (m) {
        document.getElementById('newProvId').value = m[0];
        document.getElementById('newProvName').value = m[1];
        document.getElementById('newProvBaseUrl').value = m[2];
        document.getElementById('newProvApiType').value = m[3];
      }
    });

    document.getElementById('btnConfirmAddProvider')?.addEventListener('click', async () => {
      const id = (document.getElementById('newProvId')?.value || '').trim();
      const name = (document.getElementById('newProvName')?.value || '').trim() || id;
      const baseUrl = (document.getElementById('newProvBaseUrl')?.value || '').trim();
      const apiType = document.getElementById('newProvApiType')?.value || 'openai-completions';
      const keyAlias = (document.getElementById('newProvKeyAlias')?.value || '').trim() || 'k1';
      const apiKey = (document.getElementById('newProvApiKey')?.value || '').trim();

      if (!id) return toast('请输入供应商标识 ID', 'warn');
      if (!baseUrl) return toast('请输入 Base URL', 'warn');

      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.providers = state.config.providers || {};
      if (state.config.providers[id]) return toast(`供应商 ${id} 已存在`, 'warn');

      const api_keys = apiKey ? [{ id: keyAlias, label: keyAlias, key: apiKey, enabled: true, origin: 'local' }] : [];
      state.config.providers[id] = { name, base_url: baseUrl, api_type: apiType, preset_id: id, enabled: true, origin: 'local', api_keys };
      state.activeEditorKey = `p_${id}`;
      toggle(pForm, false);
      await persistConfig('供应商创建成功');
    });

    document.getElementById('btnAddModel')?.addEventListener('click', () => {
      toggle(mForm);
      if (mForm && !mForm.hidden) populateModelProvidersDropdown();
    });
    document.getElementById('btnCancelAddModel')?.addEventListener('click', () => toggle(mForm, false));

    document.getElementById('btnConfirmAddModel')?.addEventListener('click', async () => {
      const mName = (document.getElementById('newModelName')?.value || '').trim();
      const prov = (document.getElementById('newModelProvider')?.value || '').trim();
      const target = (document.getElementById('newModelTarget')?.value || '').trim() || mName;

      if (!mName) return toast('请输入逻辑模型名称', 'warn');

      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.agent_models = state.config.agent_models || {};

      const firstKey = state.config?.providers?.[prov]?.api_keys?.[0];
      const keyLabel = firstKey?.label || firstKey?.id || 'k1';
      const candidates = prov ? [{ provider: prov, key_label: keyLabel, target_model: target, enabled: true, weight: 1 }] : [];

      state.config.agent_models[mName] = { routing_strategy: 'sticky_failover', active_key: '', enabled: true, candidates };
      state.activeEditorKey = `m_${mName}`;
      toggle(mForm, false);
      await persistConfig('模型添加成功');
    });
  }

  function populateModelProvidersDropdown() {
    const sel = document.getElementById('newModelProvider');
    if (!sel) return;
    sel.innerHTML = '';
    const provs = Object.keys(state.config?.providers || {}).sort();
    if (provs.length === 0) {
      sel.innerHTML = '<option value="">(暂无供应商)</option>';
    } else {
      provs.forEach((pId) => {
        const pName = state.config.providers[pId]?.name || pId;
        const opt = document.createElement('option');
        opt.value = pId;
        opt.textContent = `${pName} (${pId})`;
        sel.appendChild(opt);
      });
    }
  }

  function switchTab(tab) {
    state.activeTab = tab;
    state.activeEditorKey = null;

    document.querySelectorAll('.seg-btn').forEach((b) => {
      if (b.getAttribute('data-tab') === tab) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });

    const views = {
      models: document.getElementById('viewModels'),
      providers: document.getElementById('viewProviders'),
      nodes: document.getElementById('viewNodes'),
      activity: document.getElementById('viewActivity'),
      settings: document.getElementById('viewSettings'),
    };

    for (const [k, v] of Object.entries(views)) {
      if (v) v.hidden = k !== tab;
    }

    if (tab === 'activity' && window.HOST.capabilities.usageAndTraces) {
      loadActivityData();
    }
  }

  async function switchRunMode(mode) {
    if (!window.HOST.capabilities.runModes) return;
    try {
      const res = await window.HOST.switchMode(mode);
      if (res && res.ok) {
        toast(`已切换至 ${mode === 'agent' ? 'Agent 模式' : 'KB 知识库模式'}`, 'ok');
        if (state.config && state.config.settings) {
          state.config.settings.run_mode = mode;
        }
        updateRunModeUI(mode);
        renderModelsList();
      } else {
        toast(res.error || '切换模式失败', 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function updateRunModeUI(mode) {
    const isAgent = mode === 'agent';
    const btnAgent = document.getElementById('modeBtnAgent');
    const btnKB = document.getElementById('modeBtnKB');
    if (btnAgent && btnKB) {
      if (isAgent) {
        btnAgent.classList.add('active');
        btnKB.classList.remove('active');
      } else {
        btnAgent.classList.remove('active');
        btnKB.classList.add('active');
      }
    }
  }

  async function loadData() {
    try {
      const cfgResp = await window.HOST.getConfig();
      if (cfgResp && cfgResp.ok) {
        state.config = cfgResp;
        const verEl = document.getElementById('configVersionDisplay');
        if (verEl) verEl.textContent = `v${cfgResp._version || 1}`;

        if (state.config.settings && state.config.settings.run_mode) {
          updateRunModeUI(state.config.settings.run_mode);
        }

        renderProvidersList();
        renderModelsList();
        renderSettingsView();
      }

      if (window.HOST.capabilities.nodeManager) {
        await loadNodesData();
      }
    } catch (e) {
      toast(`数据加载失败: ${e.message}`, 'err');
    }
  }

  async function loadNodesData() {
    try {
      const res = await window.HOST.getNodes();
      if (res && res.ok) {
        state.nodes = res.nodes || [];
        renderNodesList();
      }
    } catch (e) {
      toast(`节点加载失败: ${e.message}`, 'err');
    }
  }

  async function loadActivityData() {
    try {
      const [usageRes, tracesRes] = await Promise.all([
        window.HOST.getUsage(state.currentPeriod),
        window.HOST.getTraces(),
      ]);
      if (usageRes && usageRes.ok) {
        state.usage = usageRes;
        renderUsageStats();
      }
      if (tracesRes && tracesRes.ok) {
        state.traces = tracesRes.traces || [];
        renderTracesList();
      }
    } catch (e) {
      toast(`统计加载失败: ${e.message}`, 'err');
    }
  }

  // --- Vault Hub Sync Handlers (Full Role) ---
  async function handleSyncManifest() {
    let hubUrl = state.config?.vault?.url || '';
    let nodeToken = state.config?.vault?.node_token || '';

    if (!hubUrl) {
      const inputUrl = prompt('请输入 EdgeOne Hub 中枢 URL (例如 https://hub.example.com):', '');
      if (!inputUrl) return;
      hubUrl = inputUrl.trim();
      const inputToken = prompt('请输入 Hub NODE_TOKEN (若已配置或中枢免鉴权可留空):', '') || '';
      nodeToken = inputToken.trim();
      state.config.vault = { url: hubUrl, node_token: nodeToken };
    }

    toast('正在连接中枢拉取清单...', 'info');
    try {
      const apiFn = window.HOST.api?.fetchVaultManifest || window.HOST.fetchVaultManifest;
      const res = await apiFn(hubUrl, nodeToken);
      if (res && (res.ok || res.providers)) {
        const provs = res.providers || {};
        const pKeys = Object.keys(provs);
        state.config.providers = state.config.providers || {};

        for (const [pId, pData] of Object.entries(provs)) {
          if (!state.config.providers[pId]) {
            state.config.providers[pId] = {
              id: pId,
              name: pData.name || pId,
              base_url: pData.base_url || '',
              anthropic_base_url: pData.anthropic_base_url || '',
              preset_id: pData.preset_id || '',
              origin: 'vault',
              enabled: true,
              api_keys: (pData.keys || []).map((lbl) => ({
                id: `k_${lbl}`,
                label: lbl,
                key: '••••••••',
                origin: 'vault',
                enabled: true,
              })),
            };
          } else {
            const ep = state.config.providers[pId];
            ep.origin = 'vault';
            if (pData.base_url) ep.base_url = pData.base_url;
            if (pData.preset_id) ep.preset_id = pData.preset_id;
            if (pData.anthropic_base_url) ep.anthropic_base_url = pData.anthropic_base_url;
          }
        }
        renderProvidersList();
        toast(`成功拉取中枢清单: 共 ${pKeys.length} 个供应商可同步`, 'ok');
      } else {
        toast(`拉取清单失败: ${res?.error || '无法连接中枢'}`, 'err');
      }
    } catch (e) {
      toast(`中枢连接异常: ${e.message}`, 'err');
    }
  }

  async function handleSyncFromVault() {
    let hubUrl = state.config?.vault?.url || '';
    let nodeToken = state.config?.vault?.node_token || '';

    if (!hubUrl) {
      const inputUrl = prompt('请输入 EdgeOne Hub 中枢 URL (例如 https://hub.example.com):', '');
      if (!inputUrl) return;
      hubUrl = inputUrl.trim();
      const inputToken = prompt('请输入 Hub NODE_TOKEN (若已配置或中枢免鉴权可留空):', '') || '';
      nodeToken = inputToken.trim();
      state.config.vault = { url: hubUrl, node_token: nodeToken };
    }

    toast('正在连接 Vault 中枢同步密钥...', 'info');
    try {
      const manifestFn = window.HOST.api?.fetchVaultManifest || window.HOST.fetchVaultManifest;
      const manifestRes = await manifestFn(hubUrl, nodeToken);
      if (!manifestRes || (!manifestRes.ok && !manifestRes.providers)) {
        toast(`拉取 Vault 清单失败: ${manifestRes?.error || '请求未成功'}`, 'err');
        return;
      }

      const provs = manifestRes.providers || {};
      const pKeys = Object.keys(provs);
      if (pKeys.length === 0) {
        toast('Vault 中枢暂无可同步的共享供应商', 'warn');
        return;
      }

      state.config.providers = state.config.providers || {};
      let totalSyncedKeys = 0;
      const credFn = window.HOST.api?.fetchVaultCredentials || window.HOST.fetchVaultCredentials;

      for (const pId of pKeys) {
        try {
          const credRes = await credFn(pId, undefined, hubUrl, nodeToken);
          if (credRes && (credRes.ok || credRes.provider_config)) {
            const pCfg = credRes.provider_config || {};
            if (!state.config.providers[pId]) {
              state.config.providers[pId] = {
                id: pId,
                name: pCfg.name || provs[pId].name || pId,
                base_url: pCfg.base_url || provs[pId].base_url || '',
                anthropic_base_url: pCfg.anthropic_base_url || '',
                preset_id: pCfg.preset_id || provs[pId].preset_id || '',
                origin: 'vault',
                enabled: true,
                api_keys: [],
              };
            }
            const p = state.config.providers[pId];
            p.origin = 'vault';
            if (pCfg.base_url) p.base_url = pCfg.base_url;
            if (pCfg.preset_id) p.preset_id = pCfg.preset_id;
            if (pCfg.anthropic_base_url) p.anthropic_base_url = pCfg.anthropic_base_url;
            if (pCfg.adapter_rules) p.adapter_rules = pCfg.adapter_rules;

            p.api_keys = p.api_keys || [];
            const keyMap = pCfg.keys || {};
            for (const [lbl, secret] of Object.entries(keyMap)) {
              const existing = p.api_keys.find((k) => k.label === lbl || k.id === lbl);
              if (existing) {
                existing.key = secret;
                existing.origin = 'vault';
                existing.enabled = true;
              } else {
                p.api_keys.push({
                  id: `k_${lbl}`,
                  label: lbl,
                  key: secret,
                  origin: 'vault',
                  enabled: true,
                });
              }
              totalSyncedKeys++;
            }
          }
        } catch (err) {
          console.warn(`Fetch credentials for ${pId} failed:`, err);
        }
      }

      await persistConfig(`从 Vault 同步成功: 更新了 ${totalSyncedKeys} 把密钥`);
    } catch (e) {
      toast(`Vault 同步异常: ${e.message}`, 'err');
    }
  }

  // --- View: Providers ---
  function renderProvidersList() {
    const container = document.getElementById('providersList');
    if (!container) return;
    container.innerHTML = '';

    const providers = (state.config && state.config.providers) || {};
    const pKeys = Object.keys(providers).sort();

    if (pKeys.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'row text-muted';
      emptyRow.textContent = '暂无已配置供应商，请点击上方「＋ 添加供应商」';
      container.appendChild(emptyRow);
      return;
    }

    for (const pId of pKeys) {
      const p = providers[pId] || {};
      const keyCount = (p.api_keys || []).length;
      const isLocal = p.origin === 'local';
      const isExpanded = state.activeEditorKey === `p_${pId}`;

      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = document.createElement('span');
      dot.className = `dot ${p.enabled && keyCount > 0 ? 'dot--ok' : 'dot--err'}`;

      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          <span>${escapeHtml(p.name || pId)}</span>
          ${isLocal ? '<span class="pill pill--amber">本地私有</span>' : '<span class="pill pill--green">共享</span>'}
        </div>
        <div class="sub">${escapeHtml(p.base_url || '未配置 Base URL')}</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill">${keyCount} 把 Key</span>
        <span class="caret">▾</span>
      `;

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);

      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `p_${pId}`;
        renderProvidersList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = document.createElement('div');
        editor.className = 'editor';
        editor.appendChild(buildProviderEditor(pId, p));
        container.appendChild(editor);
      }
    }
  }

  function buildProviderEditor(pId, p) {
    const wrap = document.createElement('div');
    const keys = p.api_keys || [];

    wrap.innerHTML = `
      <div class="editor-grid">
        <div class="form-group">
          <label class="form-label">供应商标识 / 名称</label>
          <input class="input" id="ed_p_name_${pId}" value="${escapeHtml(p.name || pId)}">
        </div>
        <div class="form-group">
          <label class="form-label">Base URL (OpenAI 协议)</label>
          <input class="input input--code" id="ed_p_base_${pId}" value="${escapeHtml(p.base_url || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Anthropic Base URL (可选)</label>
          <input class="input input--code" id="ed_p_ant_${pId}" value="${escapeHtml(p.anthropic_base_url || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">预设规则绑定</label>
          <input class="input input--code" id="ed_p_preset_${pId}" value="${escapeHtml(p.preset_id || '')}" placeholder="如 minimax, deepseek">
        </div>
      </div>

      <div class="section-bar mt-4">
        <span class="form-label">API 密钥池 (${keys.length})</span>
      </div>

      <table class="sub-table">
        <thead>
          <tr>
            <th>状态</th>
            <th>标签</th>
            <th>Key 密文</th>
            <th>归属</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="p_keys_tbody_${pId}"></tbody>
      </table>

      <div class="editor-grid mt-3">
        <div class="form-group">
          <input class="input" id="new_key_lbl_${pId}" placeholder="Key 标签 (如 pool-01)">
        </div>
        <div class="form-group">
          <input class="input input--code" id="new_key_val_${pId}" placeholder="粘贴完整 API Key">
        </div>
        <div class="form-group flex-end">
          <button class="btn btn--primary" id="btn_add_key_${pId}">＋ 添加 Key</button>
        </div>
      </div>

      <div class="section-bar mt-4 flex-end gap-2">
        <button class="btn" id="btn_probe_prov_${pId}">探测模型</button>
        <button class="btn btn--danger" id="btn_del_prov_${pId}">删除此供应商</button>
        <button class="btn btn--primary" id="btn_save_prov_${pId}">保存供应商配置</button>
      </div>
    `;

    const tbody = wrap.querySelector(`#p_keys_tbody_${pId}`);
    keys.forEach((k, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="dot ${k.enabled ? 'dot--ok' : 'dot--err'}"></span></td>
        <td><strong>${escapeHtml(k.label || k.id || `key-${idx}`)}</strong></td>
        <td><span class="tabular">${escapeHtml(k.key)}</span></td>
        <td><span class="pill">${k.origin === 'local' ? '本地' : '共享'}</span></td>
        <td>
          <button class="btn btn--sm btn_verify_k" data-idx="${idx}">校验</button>
          <button class="btn btn--sm btn--danger btn_del_k" data-idx="${idx}">删除</button>
        </td>
      `;
      tr.querySelector('.btn_verify_k').addEventListener('click', async () => {
        const baseUrl = wrap.querySelector(`#ed_p_base_${pId}`)?.value.trim() || p.base_url || '';
        const keyLabel = k.label || k.id || `key-${idx}`;
        toast(`正在校验 Key [${keyLabel}]...`, 'info');
        try {
          const apiFn = window.HOST.api?.verifyKey || window.HOST.verifyKey;
          const res = await apiFn({
            provider: pId,
            api_key: k.key,
            key: k.key,
            key_label: keyLabel,
            base_url: baseUrl,
            api_type: p.api_type || 'openai-completions',
          });
          if (res && (res.ok || res.latency_ms !== undefined || res.ms !== undefined)) {
            const latency = res.latency_ms ?? res.ms ?? res.latency ?? 0;
            toast(`Key [${keyLabel}] 校验成功: 延迟 ${latency}ms`, 'ok');
          } else {
            const errMsg = res?.error?.message || res?.error || '密钥无效或网络不可达';
            toast(`Key [${keyLabel}] 校验失败: ${errMsg}`, 'err');
          }
        } catch (e) {
          toast(`校验异常: ${e.message}`, 'err');
        }
      });
      tr.querySelector('.btn_del_k').addEventListener('click', () => {
        p.api_keys.splice(idx, 1);
        renderProvidersList();
      });
      tbody.appendChild(tr);
    });

    wrap.querySelector(`#btn_probe_prov_${pId}`).addEventListener('click', async () => {
      const baseUrl = wrap.querySelector(`#ed_p_base_${pId}`)?.value.trim() || p.base_url || '';
      const firstKey = p.api_keys?.[0]?.key || '';
      toast(`正在探测供应商 ${pId} 模型...`, 'info');
      try {
        const apiFn = window.HOST.api?.probeModels || window.HOST.probeModels;
        const res = await apiFn({
          provider: pId,
          base_url: baseUrl,
          api_key: firstKey,
          key: firstKey,
          api_type: p.api_type || 'openai-completions',
          api_keys: p.api_keys,
        });
        if (res && (res.ok || Array.isArray(res.models) || res.count !== undefined)) {
          const count = res.count ?? (Array.isArray(res.models) ? res.models.length : 0);
          toast(`探测成功: 发现 ${count} 个可用模型`, 'ok');
        } else {
          const errMsg = res?.error?.message || res?.error || '未发现可用模型';
          toast(`探测失败: ${errMsg}`, 'err');
        }
      } catch (e) {
        toast(`探测异常: ${e.message}`, 'err');
      }
    });

    wrap.querySelector(`#btn_add_key_${pId}`).addEventListener('click', () => {
      const lblInput = wrap.querySelector(`#new_key_lbl_${pId}`);
      const valInput = wrap.querySelector(`#new_key_val_${pId}`);
      const lbl = lblInput.value.trim();
      const val = valInput.value.trim();
      if (!lbl || !val) {
        toast('请填写 Key 标签和密钥内容', 'warn');
        return;
      }
      p.api_keys = p.api_keys || [];
      p.api_keys.push({
        id: `k_${Date.now().toString(36)}`,
        label: lbl,
        key: val,
        enabled: true,
        origin: 'vault',
      });
      renderProvidersList();
    });

    wrap.querySelector(`#btn_save_prov_${pId}`).addEventListener('click', async () => {
      p.name = wrap.querySelector(`#ed_p_name_${pId}`).value.trim();
      p.base_url = wrap.querySelector(`#ed_p_base_${pId}`).value.trim();
      p.anthropic_base_url = wrap.querySelector(`#ed_p_ant_${pId}`).value.trim();
      p.preset_id = wrap.querySelector(`#ed_p_preset_${pId}`).value.trim();

      await persistConfig('供应商保存成功');
    });

    wrap.querySelector(`#btn_del_prov_${pId}`).addEventListener('click', async () => {
      if (!confirm(`确定删除供应商 ${pId} 吗？`)) return;
      delete state.config.providers[pId];
      state.activeEditorKey = null;
      await persistConfig('供应商已删除');
    });

    return wrap;
  }

  // --- View: Nodes (Hub mode) ---
  function renderNodesList() {
    const container = document.getElementById('nodesList');
    if (!container) return;
    container.innerHTML = '';

    const nodes = state.nodes || [];
    if (nodes.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'row text-muted';
      emptyRow.textContent = '暂无中转节点，点击上方「＋ 签发新节点」一键生成';
      container.appendChild(emptyRow);
      return;
    }

    for (const node of nodes) {
      const isExpanded = state.activeEditorKey === `node_${node.id}`;
      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = document.createElement('span');
      dot.className = `dot ${node.enabled ? 'dot--ok' : 'dot--err'}`;

      const who = document.createElement('div');
      who.className = 'who';
      const modelsScope = (node.scope?.models || []).join(', ') || '*';
      const provsScope = (node.scope?.providers || []).join(', ') || '*';
      who.innerHTML = `
        <div class="name">
          <span>${escapeHtml(node.name || node.id)}</span>
          <span class="pill pill--accent">${escapeHtml(node.role)}</span>
          ${!node.enabled ? '<span class="pill pill--red">已吊销</span>' : ''}
        </div>
        <div class="sub">模型: ${escapeHtml(modelsScope)} · 供应商: ${escapeHtml(provsScope)} · Token: ${escapeHtml(node.token_prefix)}</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill">${node.last_seen ? '活跃: ' + formatTime(node.last_seen) : '未激活'}</span>
        <span class="caret">▾</span>
      `;

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);

      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `node_${node.id}`;
        renderNodesList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = document.createElement('div');
        editor.className = 'editor';
        editor.appendChild(buildNodeEditor(node));
        container.appendChild(editor);
      }
    }
  }

  function buildNodeEditor(node) {
    const wrap = document.createElement('div');
    const isEnabled = node.enabled;

    wrap.innerHTML = `
      <div class="editor-grid">
        <div class="form-group">
          <label class="form-label">节点名称</label>
          <input class="input" id="ed_node_name_${node.id}" value="${escapeHtml(node.name)}">
        </div>
        <div class="form-group">
          <label class="form-label">租约时长 (秒)</label>
          <input class="input" id="ed_node_ttl_${node.id}" type="number" value="${node.lease_ttl || 86400}">
        </div>
        <div class="form-group">
          <label class="form-label">允许供应商 (逗号分隔，* 为全量)</label>
          <input class="input" id="ed_node_provs_${node.id}" value="${escapeHtml((node.scope?.providers || []).join(','))}">
        </div>
        <div class="form-group">
          <label class="form-label">允许模型 (逗号分隔，* 为全量)</label>
          <input class="input" id="ed_node_models_${node.id}" value="${escapeHtml((node.scope?.models || []).join(','))}">
        </div>
      </div>

      <div class="section-bar mt-4 flex-end gap-2">
        <button class="btn btn--danger" id="btn_toggle_node_${node.id}">${isEnabled ? '吊销/停用此节点' : '恢复启用'}</button>
        <button class="btn" id="btn_rotate_node_${node.id}">轮换 Token</button>
        <button class="btn btn--danger" id="btn_del_node_${node.id}">删除节点</button>
        <button class="btn btn--primary" id="btn_save_node_${node.id}">保存节点配置</button>
      </div>

      <div class="form-group mt-3" id="node_token_display_box_${node.id}" hidden>
        <label class="form-label">新生成的 NODE_TOKEN (仅展示一次，请立即复制)</label>
        <input class="input input--code" readonly id="node_new_token_val_${node.id}">
        <label class="form-label mt-2">一键启动环境变量</label>
        <input class="input input--code" readonly id="node_new_env_val_${node.id}">
      </div>
    `;

    wrap.querySelector(`#btn_save_node_${node.id}`).addEventListener('click', async () => {
      const name = wrap.querySelector(`#ed_node_name_${node.id}`).value.trim();
      const leaseTtl = Number(wrap.querySelector(`#ed_node_ttl_${node.id}`).value) || 86400;
      const provsStr = wrap.querySelector(`#ed_node_provs_${node.id}`).value.trim();
      const modelsStr = wrap.querySelector(`#ed_node_models_${node.id}`).value.trim();

      const scope = {
        providers: provsStr ? provsStr.split(',').map((s) => s.trim()).filter(Boolean) : ['*'],
        models: modelsStr ? modelsStr.split(',').map((s) => s.trim()).filter(Boolean) : ['*'],
      };

      try {
        const res = await window.HOST.patchNode(node.id, { name, lease_ttl: leaseTtl, scope });
        if (res && res.ok) {
          toast('节点配置更新成功', 'ok');
          await loadNodesData();
        } else {
          toast(res.error || '更新失败', 'err');
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    wrap.querySelector(`#btn_toggle_node_${node.id}`).addEventListener('click', async () => {
      try {
        const res = await window.HOST.patchNode(node.id, { enabled: !isEnabled });
        if (res && res.ok) {
          toast(isEnabled ? '节点已吊销' : '节点已恢复', 'ok');
          await loadNodesData();
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    wrap.querySelector(`#btn_rotate_node_${node.id}`).addEventListener('click', async () => {
      if (!confirm('轮换 Token 会使旧 Token 立即失效，确定继续吗？')) return;
      try {
        const res = await window.HOST.rotateNode(node.id);
        if (res && res.ok) {
          toast('Token 轮换成功！', 'ok');
          const box = wrap.querySelector(`#node_token_display_box_${node.id}`);
          box.hidden = false;
          wrap.querySelector(`#node_new_token_val_${node.id}`).value = res.node_token;
          wrap.querySelector(`#node_new_env_val_${node.id}`).value = res.bootstrap_env;
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    wrap.querySelector(`#btn_del_node_${node.id}`).addEventListener('click', async () => {
      if (!confirm(`确认永久删除节点 ${node.name} 吗？`)) return;
      try {
        const res = await window.HOST.deleteNode(node.id);
        if (res && res.ok) {
          toast('节点已删除', 'ok');
          state.activeEditorKey = null;
          await loadNodesData();
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    return wrap;
  }

  async function handleIssueNode() {
    const name = document.getElementById('issueNodeName').value.trim();
    const role = document.getElementById('issueNodeRole').value;
    const leaseTtl = Number(document.getElementById('issueNodeTTL').value) || 86400;

    if (!name) {
      toast('请输入节点名称', 'warn');
      return;
    }

    try {
      const res = await window.HOST.issueNode({ name, role, lease_ttl: leaseTtl });
      if (res && res.ok) {
        toast('节点签发成功！', 'ok');
        const tokenDisplay = document.getElementById('issuedTokenDisplay');
        if (tokenDisplay) {
          tokenDisplay.hidden = false;
          document.getElementById('issuedTokenVal').value = res.node_token;
          document.getElementById('issuedEnvVal').value = res.bootstrap_env;
        }
        await loadNodesData();
      } else {
        toast(res.error || '签发失败', 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // --- View: Models (Full mode) ---
  function renderModelsList() {
    const container = document.getElementById('modelsList');
    if (!container) return;
    container.innerHTML = '';

    const isAgent = (state.config?.settings?.run_mode || 'agent') === 'agent';
    const btnAddModel = document.getElementById('btnAddModel');
    if (btnAddModel) {
      btnAddModel.hidden = !isAgent;
      btnAddModel.classList.toggle('hidden', !isAgent);
    }
    if (isAgent) {
      renderAgentModels(container);
    } else {
      renderKBModels(container);
    }
  }

  function renderAgentModels(container) {
    const models = state.config?.agent_models || {};
    const mKeys = Object.keys(models).sort();

    if (mKeys.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'row text-muted';
      emptyRow.textContent = '暂无已配置模型路由，请点击右上角「＋ 添加模型」';
      container.appendChild(emptyRow);
      return;
    }

    for (const mName of mKeys) {
      const m = models[mName] || {};
      const cCount = (m.candidates || []).length;
      const isExpanded = state.activeEditorKey === `m_${mName}`;

      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = document.createElement('span');
      dot.className = `dot ${m.enabled && cCount > 0 ? 'dot--ok' : 'dot--err'}`;

      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          <span>${escapeHtml(mName)}</span>
          <span class="pill pill--accent">${escapeHtml(m.routing_strategy || 'sticky_failover')}</span>
        </div>
        <div class="sub">首选 Key: ${escapeHtml(m.active_key || '未指定')} · 候选池: ${cCount} 个</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill">${cCount} 候选</span>
        <span class="caret">▾</span>
      `;

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);

      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `m_${mName}`;
        renderModelsList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = document.createElement('div');
        editor.className = 'editor';
        editor.appendChild(buildModelEditor(mName, m));
        container.appendChild(editor);
      }
    }
  }

  function buildModelEditor(mName, m) {
    const wrap = document.createElement('div');
    const candidates = m.candidates || [];

    wrap.innerHTML = `
      <div class="editor-grid">
        <div class="form-group">
          <label class="form-label">路由策略覆盖</label>
          <select class="select" id="ed_m_strat_${mName}">
            <option value="sticky_failover" ${m.routing_strategy === 'sticky_failover' ? 'selected' : ''}>粘性故障转移 (推荐)</option>
            <option value="round_robin" ${m.routing_strategy === 'round_robin' ? 'selected' : ''}>标准轮询 (Round Robin)</option>
            <option value="manual" ${m.routing_strategy === 'manual' ? 'selected' : ''}>手动严格直通</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">首选粘性 Key (active_key)</label>
          <input class="input" id="ed_m_act_${mName}" value="${escapeHtml(m.active_key || '')}" placeholder="格式: provider:key_label">
        </div>
      </div>

      <div class="section-bar mt-4">
        <span class="form-label">候选 Key 列表 (${candidates.length})</span>
      </div>

      <table class="sub-table">
        <thead>
          <tr>
            <th>供应商</th>
            <th>Key 标签</th>
            <th>目标模型</th>
            <th>权重</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="m_cands_tbody_${mName}"></tbody>
      </table>

      <div class="editor-grid mt-3">
        <div class="form-group">
          <input class="input" id="new_c_prov_${mName}" placeholder="供应商 ID (如 minimax)">
        </div>
        <div class="form-group">
          <input class="input" id="new_c_lbl_${mName}" placeholder="Key 标签 (如 pool-01)">
        </div>
        <div class="form-group">
          <input class="input" id="new_c_target_${mName}" placeholder="上游真实模型 (留空同名)">
        </div>
        <div class="form-group flex-end">
          <button class="btn btn--primary" id="btn_add_cand_${mName}">＋ 添加候选</button>
        </div>
      </div>

      <div class="section-bar mt-4 flex-end gap-2">
        <button class="btn btn--danger" id="btn_del_model_${mName}">删除此模型</button>
        <button class="btn btn--primary" id="btn_save_model_${mName}">保存模型配置</button>
      </div>
    `;

    const tbody = wrap.querySelector(`#m_cands_tbody_${mName}`);
    candidates.forEach((c, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(c.provider)}</strong></td>
        <td><span class="pill">${escapeHtml(c.key_label)}</span></td>
        <td><span class="tabular">${escapeHtml(c.target_model || '原名')}</span></td>
        <td><span class="tabular">${c.weight || 1}</span></td>
        <td>
          <button class="btn btn--sm btn_del_cand" data-idx="${idx}">移除</button>
        </td>
      `;
      tr.querySelector('.btn_del_cand').addEventListener('click', () => {
        candidates.splice(idx, 1);
        renderModelsList();
      });
      tbody.appendChild(tr);
    });

    wrap.querySelector(`#btn_add_cand_${mName}`).addEventListener('click', () => {
      const prov = wrap.querySelector(`#new_c_prov_${mName}`).value.trim();
      const lbl = wrap.querySelector(`#new_c_lbl_${mName}`).value.trim();
      const target = wrap.querySelector(`#new_c_target_${mName}`).value.trim();
      if (!prov || !lbl) {
        toast('请填写供应商和 Key 标签', 'warn');
        return;
      }
      candidates.push({
        provider: prov,
        key_label: lbl,
        target_model: target || '',
        enabled: true,
        weight: 1,
      });
      renderModelsList();
    });

    wrap.querySelector(`#btn_save_model_${mName}`).addEventListener('click', async () => {
      m.routing_strategy = wrap.querySelector(`#ed_m_strat_${mName}`).value;
      m.active_key = wrap.querySelector(`#ed_m_act_${mName}`).value.trim();
      await persistConfig('模型配置保存成功');
    });

    wrap.querySelector(`#btn_del_model_${mName}`).addEventListener('click', async () => {
      if (!confirm(`确定删除模型 ${mName} 吗？`)) return;
      delete state.config.agent_models[mName];
      state.activeEditorKey = null;
      await persistConfig('模型已删除');
    });

    return wrap;
  }

  function renderKBModels(container) {
    const categories = ['chat', 'embedding', 'reranker', 'ocr'];
    categories.forEach((cat) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="dot dot--ok"></span>
        <div class="who">
          <div class="name"><span>/v1/${cat}</span> <span class="pill pill--accent">KB 模式固定</span></div>
          <div class="sub">知识库专用高并发流水线</div>
        </div>
      `;
      container.appendChild(row);
    });
  }

  function formatTokenCount(num) {
    if (!num) return '0';
    if (num >= 1000000) return `${Math.round((num / 1000000) * 10) / 10}M`;
    if (num >= 1000) return `${Math.round((num / 1000) * 10) / 10}k`;
    return Number(num).toLocaleString();
  }

  // --- View: Activity (Full mode) ---
  function renderUsageStats() {
    const totals = state.usage?.totals;
    const summary = state.usage?.summary;

    const requests = totals?.requests ?? summary?.total_requests ?? 0;
    const failed = totals?.failed ?? summary?.failed_requests ?? 0;
    const success = totals?.success ?? summary?.success_requests ?? (requests - failed);
    const inTokens = totals?.input_tokens ?? summary?.total_in_tokens ?? 0;
    const outTokens = totals?.output_tokens ?? summary?.total_out_tokens ?? 0;
    const totalTokens = inTokens + outTokens;
    const avgTtft = totals?.avg_ttft_ms ?? summary?.avg_ttft_ms ?? 0;

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val !== undefined ? val : '-';
    };

    setVal('statRequests', Number(requests).toLocaleString());
    setVal('statSuccess', requests > 0 ? `${Math.round((success / requests) * 1000) / 10}%` : '-');
    setVal('statTokens', formatTokenCount(totalTokens));
    setVal('statTTFT', avgTtft ? `${Math.round(avgTtft)}ms` : '-');

    renderUsageModels();
  }

  function renderUsageModels() {
    const container = document.getElementById('usageModelsList');
    if (!container) return;
    container.innerHTML = '';

    const rawModels = state.usage?.models;
    let modelsList = [];

    if (Array.isArray(rawModels)) {
      modelsList = rawModels.map((m) => {
        const reqs = m.requests || 0;
        const succs = m.successes ?? (m.success_rate !== undefined ? Math.round(reqs * m.success_rate) : (reqs - (m.failed || 0)));
        const rate = m.success_rate !== undefined ? m.success_rate : (reqs > 0 ? succs / reqs : 0);
        const inT = m.input_tokens ?? m.in_tokens ?? 0;
        const outT = m.output_tokens ?? m.out_tokens ?? 0;
        return {
          model: m.model || m.name || 'unknown',
          requests: reqs,
          successRate: rate,
          inTokens: inT,
          outTokens: outT,
          totalTokens: inT + outT,
          cacheTokens: m.cache_read_tokens || 0,
          avgTtft: m.avg_ttft_ms ?? 0,
        };
      });
    } else if (rawModels && typeof rawModels === 'object') {
      modelsList = Object.entries(rawModels).map(([modelName, s]) => {
        const reqs = s.requests || 0;
        const succs = s.successes ?? s.success ?? (reqs - (s.failed || 0));
        const rate = s.success_rate !== undefined ? s.success_rate : (reqs > 0 ? succs / reqs : 0);
        const inT = s.input_tokens ?? s.in_tokens ?? 0;
        const outT = s.output_tokens ?? s.out_tokens ?? 0;
        const avgTtft = s.avg_ttft_ms ?? (s.total_ms && reqs > 0 ? Math.round(s.total_ms / reqs) : 0);
        return {
          model: modelName,
          requests: reqs,
          successRate: rate,
          inTokens: inT,
          outTokens: outT,
          totalTokens: inT + outT,
          cacheTokens: s.cache_read_tokens || 0,
          avgTtft: avgTtft,
        };
      });
    }

    if (modelsList.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'row text-muted';
      emptyRow.textContent = '当前周期暂无模型用量记录';
      container.appendChild(emptyRow);
      return;
    }

    modelsList.sort((a, b) => b.requests - a.requests);

    for (const m of modelsList) {
      const row = document.createElement('div');
      row.className = 'row';

      const dot = document.createElement('span');
      dot.className = `dot ${m.successRate >= 0.99 ? 'dot--ok' : m.successRate >= 0.9 ? 'dot--warn' : 'dot--err'}`;

      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          <span>${escapeHtml(m.model)}</span>
          <span class="pill">${m.requests.toLocaleString()} 次</span>
          <span class="pill pill--accent">${formatTokenCount(m.totalTokens)} tok</span>
        </div>
        <div class="sub">成功率: ${(m.successRate * 100).toFixed(1)}% · 缓存: ${formatTokenCount(m.cacheTokens)}${m.avgTtft ? ' · TTFT ' + Math.round(m.avgTtft) + 'ms' : ''}</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill tabular">${(m.successRate * 100).toFixed(1)}%</span>
      `;

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);
      container.appendChild(row);
    }
  }

  function renderTracesList() {
    const container = document.getElementById('tracesList');
    if (!container) return;
    container.innerHTML = '';

    const traces = state.traces || [];
    const filtered = state.filterOnlyRetried
      ? traces.filter((t) => t.status >= 400 || (t.tries && t.tries.length > 1))
      : traces;

    if (filtered.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'row text-muted';
      emptyRow.textContent = '暂无符合条件的请求轨迹';
      container.appendChild(emptyRow);
      return;
    }

    for (const t of filtered) {
      const isExpanded = state.activeEditorKey === `tr_${t.id}`;
      const triesCount = (t.tries || []).length;
      const isOk = t.status >= 200 && t.status < 300;
      const hasRetries = triesCount > 1;

      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = document.createElement('span');
      dot.className = `dot ${!isOk ? 'dot--err' : hasRetries ? 'dot--warn' : 'dot--ok'}`;

      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          <span>${formatTime(t.ts)}</span>
          <span class="tabular">${escapeHtml(t.req_model)}</span>
          <span class="text-muted">→</span>
          <span class="pill">${escapeHtml(t.winner_provider || 'none')}</span>
          ${hasRetries ? `<span class="pill pill--amber">${triesCount}次尝试</span>` : ''}
        </div>
        <div class="sub">${escapeHtml(t.endpoint)} · ${t.total_ms || 0}ms (TTFT ${t.ttft_ms || 0}ms)</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill ${isOk ? 'pill--green' : 'pill--red'}">HTTP ${t.status}</span>
        <span class="caret">▾</span>
      `;

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);

      row.addEventListener('click', () => {
        state.activeEditorKey = isExpanded ? null : `tr_${t.id}`;
        renderTracesList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = document.createElement('div');
        editor.className = 'editor';
        editor.appendChild(buildTraceEditor(t));
        container.appendChild(editor);
      }
    }
  }

  function buildTraceEditor(t) {
    const wrap = document.createElement('div');
    const tries = t.tries || [];

    wrap.innerHTML = `
      <div class="mb-2 text-sm text-muted">
        <strong>端点:</strong> ${escapeHtml(t.endpoint)} · 
        <strong>Token:</strong> 入 ${t.in_tokens || 0} / 出 ${t.out_tokens || 0} / 缓存 ${t.cache_read_tokens || 0} · 
        <strong>TTFT:</strong> ${t.ttft_ms || 0}ms · <strong>总耗时:</strong> ${t.total_ms || 0}ms
      </div>
      <div class="form-label mb-1">故障转移与重试回放 (Tries[]):</div>
      <div id="tries_container_${t.id}"></div>
    `;

    const triesCont = wrap.querySelector(`#tries_container_${t.id}`);
    tries.forEach((tr) => {
      const trRow = document.createElement('div');
      trRow.className = 'try-row';
      const isSuccess = tr.status >= 200 && tr.status < 300;
      trRow.innerHTML = `
        <span class="dot ${isSuccess ? 'dot--ok' : 'dot--err'}"></span>
        <div class="flex-1">
          <div>
            <strong>Try #${tr.attempt}</strong>: 
            <span>${escapeHtml(tr.provider)} / ${escapeHtml(tr.key_id)}</span> 
            <span class="pill ${isSuccess ? 'pill--green' : 'pill--red'}">HTTP ${tr.status}</span>
            <span class="tabular">(${tr.ms}ms${tr.ttft_ms ? ', TTFT ' + tr.ttft_ms + 'ms' : ''})</span>
            ${tr.cooldown_applied_sec ? `<span class="pill pill--amber">触发冷却 ${tr.cooldown_applied_sec}s</span>` : ''}
          </div>
          ${tr.error_snippet ? `<div class="text-danger text-sm mt-1">${escapeHtml(tr.error_snippet)}</div>` : ''}
        </div>
      `;
      triesCont.appendChild(trRow);
    });

    return wrap;
  }

  // --- View: Settings ---
  function renderSettingsView() {
    const s = state.config?.settings || {};
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val !== undefined ? val : '';
    };

    setVal('cfgRoutingStrategy', s.agent_routing_strategy || 'sticky_failover');
    setVal('cfgFirstByteTimeout', s.agent_first_byte_timeout_sec || 120);
    setVal('cfgCooldown429', s.cooldown_rate_limit_sec || 15);
    setVal('cfgCooldown5xx', s.cooldown_server_error_sec || 30);
    setVal('cfgCooldownNet', s.cooldown_network_error_sec || 15);
    setVal('cfgCooldownAuth', s.cooldown_auth_error_sec || 86400);

    if (window.HOST.capabilities.vaultClient) {
      const v = state.config?.vault || {};
      setVal('cfgVaultUrl', v.url || '');
      setVal('cfgVaultToken', v.node_token || '');
    }

    const btnSave = document.getElementById('btnSaveSettings');
    if (btnSave) {
      btnSave.onclick = async () => {
        s.agent_routing_strategy = document.getElementById('cfgRoutingStrategy').value;
        s.agent_first_byte_timeout_sec = Number(document.getElementById('cfgFirstByteTimeout').value) || 120;
        s.cooldown_rate_limit_sec = Number(document.getElementById('cfgCooldown429').value) || 15;
        s.cooldown_server_error_sec = Number(document.getElementById('cfgCooldown5xx').value) || 30;
        s.cooldown_network_error_sec = Number(document.getElementById('cfgCooldownNet').value) || 15;
        s.cooldown_auth_error_sec = Number(document.getElementById('cfgCooldownAuth').value) || 86400;

        if (window.HOST.capabilities.vaultClient) {
          const vUrl = document.getElementById('cfgVaultUrl')?.value.trim();
          const vToken = document.getElementById('cfgVaultToken')?.value.trim();
          if (vUrl || vToken) {
            state.config.vault = {
              url: vUrl || '',
              node_token: vToken || '',
            };
          }
        }

        await persistConfig('设置保存成功');
      };
    }
  }

  // --- Common Helper: Persist Config ---
  async function persistConfig(successMsg) {
    try {
      const res = await window.HOST.saveConfig(state.config);
      const data = res?.data || res || {};

      const isConflict = res?.status === 409 ||
        data?.error === 'config_version_conflict' ||
        res?.error === 'config_version_conflict' ||
        data?.code === 'cas_version_conflict' ||
        data?.error?.code === 'cas_version_conflict' ||
        (typeof data?.error === 'string' && data.error.includes('conflict'));

      if (isConflict) {
        toast('配置版本冲突 (CAS)：其他会话已修改配置，已自动加载最新版本', 'warn');
        await loadData();
        return;
      }

      if (res?.status === 200 || data?.ok || data?._version !== undefined) {
        if (data.config) {
          state.config = data.config;
          if (data._version) state.config._version = data._version;
        } else if (data._version !== undefined || data.providers) {
          state.config = data;
        }
        const ver = state.config?._version || data._version;
        const verEl = document.getElementById('configVersionDisplay');
        if (verEl && ver) verEl.textContent = `v${ver}`;
        toast(successMsg || '保存成功', 'ok');
        renderProvidersList();
        renderModelsList();
        renderSettingsView();
      } else {
        const errMsg = typeof data.error === 'string' ? data.error : data.error?.message || '保存失败';
        toast(errMsg, 'err');
      }
    } catch (e) {
      toast(`保存异常: ${e.message}`, 'err');
    }
  }

  function formatTime(isoOrSec) {
    if (!isoOrSec) return '';
    const d = typeof isoOrSec === 'number' ? new Date(isoOrSec * 1000) : new Date(isoOrSec);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
