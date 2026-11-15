/**
 * app.js — Magpie Minimalist Admin UI Controller
 * Zero inline style, zero left-border stripes, inline row editors.
 */

(function () {
  const state = {
    config: null,
    nodes: [],
    usage: null,
    traces: [],
    lanes: {},
    cooldowns: {},
    activeTab: 'activity',
    activeEditorKey: null,
    modelSubMode: 'agent',
    providerQuery: '',
    providerFilter: 'all',
    searchQuery: '',
    modelQuery: '',
    filterOnlyRetried: false,
    currentPeriod: 'today',
    lanesTimer: null,
    batchVerifying: false,
    extServiceProto: 'all',
    selectedMcpNodeId: '',
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

  function scrubUiText(raw, extra = []) {
    let s = String(raw || '');
    for (const sec of extra) {
      const k = String(sec || '').trim();
      if (k.length >= 6 && s.includes(k)) s = s.split(k).join('[REDACTED]');
    }
    return s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]').replace(/((?:api_?key|token|secret)=)[^&\s"']+/gi, '$1[REDACTED]').replace(/\b(?:tvly|fc|BSA|sk|AIza|ghp)-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]');
  }

  async function copyToClipboard(text, msg) {
    if (!text) return toast('无可复制内容', 'warn');
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(String(text)); return toast(msg || '已复制', 'ok'); } } catch (_) {}
    toast('请手动复制', 'warn');
  }

  function isValidOptionalHttpUrl(raw) {
    const t = String(raw || '').trim();
    if (!t) return true;
    try { const u = new URL(t); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch (_) { return false; }
  }

  function getMcpNodes() {
    return (state.nodes || []).filter((n) => n && (n.mcp_url || n.telemetry || (Array.isArray(n.scope?.providers) && !n.scope.providers.length)));
  }

  function getNodeSyncSnapshotStatus(n) {
    if (!n || n.enabled === false) return { key: 'revoked', pillCls: 'pill--red', label: '已吊销', leaseText: '已吊销', syncMs: 0 };
    const r = n.last_seen || n.telemetry?.updated_at;
    const syncMs = r ? (typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : new Date(r).getTime()) : 0;
    if (!syncMs || Number.isNaN(syncMs)) return { key: 'never', pillCls: 'pill', label: '从未同步', leaseText: '从未同步', syncMs: 0 };
    const lease = Number(n.lease_ttl) || 86400, grace = Number(n.grace_ttl) || 3600, age = Math.max(0, Math.floor((Date.now() - syncMs) / 1000));
    if (age > lease + grace) return { key: 'expired', pillCls: 'pill--red', label: '过期 / 离线', leaseText: '租约已过期', syncMs };
    if (age > lease) return { key: 'grace', pillCls: 'pill--amber', label: '宽限期内', leaseText: '宽限期内', syncMs };
    return { key: 'synced', pillCls: 'pill--green', label: '已同步', leaseText: `租约剩 ${formatCooldown(Math.max(1, lease - age))}`, syncMs };
  }

  function computeSearchProviderHealth(sp) {
    const keys = Array.isArray(sp?.api_keys) ? sp.api_keys : [];
    const enabled = keys.filter((k) => k && k.enabled !== false);
    const ok = enabled.filter((k) => k.last_ok === true).length;
    const fail = enabled.filter((k) => k.last_ok === false).length;
    let statusText = '未校验', pillCls = 'pill', dotCls = 'dot--warn';
    if (sp?.enabled === false) { statusText = '已停用'; pillCls = 'pill pill--red'; dotCls = 'dot--err'; }
    else if (!enabled.length) statusText = '无可用 Key';
    else if (ok && !fail) { statusText = '正常'; pillCls = 'pill pill--green'; dotCls = 'dot--ok'; }
    else if (ok && fail) { statusText = '部分异常'; pillCls = 'pill pill--amber'; }
    else if (fail && !ok) { statusText = '全部异常'; pillCls = 'pill pill--red'; dotCls = 'dot--err'; }
    let maxMs = 0, latestCheckedAt = '', latestLatencyMs = null;
    for (const k of keys) {
      const ms = k?.last_checked_at ? new Date(k.last_checked_at).getTime() : 0;
      if (ms >= maxMs && k?.last_checked_at) { maxMs = ms; latestCheckedAt = k.last_checked_at; latestLatencyMs = Number.isFinite(Number(k.last_latency_ms)) ? Number(k.last_latency_ms) : null; }
    }
    return { totalCount: keys.length, enabledCount: enabled.length, statusText, pillCls, dotCls, latestCheckedAt, latestLatencyMs };
  }

  function validateSearchSpec({ name, baseUrl, timeoutRaw, caps, adapter, reqRaw, respRaw, fetchRaw, quirksRaw, secrets = [] }) {
    if (!name) return { error: '显示名称不能为空' };
    if (!caps.length) return { error: '请至少勾选一种能力 (search 或 fetch)' };
    if (!isValidOptionalHttpUrl(baseUrl)) return { error: 'Base URL 需为 http:// 或 https:// 地址' };
    const timeoutMs = String(timeoutRaw || '').trim() ? Number(timeoutRaw) : 15000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) return { error: 'timeout_ms 需在 500-60000 之间' };
    let reqObj, respObj, fetchObj, quirksObj;
    try {
      reqObj = parseOptionalJsonField(reqRaw, 'request');
      respObj = parseOptionalJsonField(respRaw, 'response');
      fetchObj = parseOptionalJsonField(fetchRaw, 'fetch');
      quirksObj = quirksRaw !== undefined ? parseOptionalJsonField(quirksRaw, 'quirks') : undefined;
    } catch (e) { return { error: scrubUiText(e.message, secrets) }; }
    if (!adapter && !reqObj && !fetchObj) return { error: '未填 adapter 时需提供 request 或 fetch JSON' };
    if (!adapter && reqObj && !respObj) return { error: '未填 adapter 且有 request 时需补充 response JSON' };
    return { timeoutMs: Math.round(timeoutMs), reqObj, respObj, fetchObj, quirksObj };
  }

  // Never render a raw secret in the key table: saved keys arrive masked from the
  // server, but a key added in this session is still plaintext until saved.
  function maskKeyForDisplay(raw) {
    const s = String(raw || '');
    if (!s) return '';
    if (s.includes('●')) return s;
    if (s.length <= 8) return '●●●●●●';
    return `${s.slice(0, 3)}●●●●●●${s.slice(-4)}`;
  }

  // Short human duration for cooldown pills: 45s / 12m / 3h / 1d.
  function formatCooldown(sec) {
    const n = Number(sec) || 0;
    if (n <= 0) return '';
    if (n < 60) return `${n}s`;
    if (n < 3600) return `${Math.round(n / 60)}m`;
    if (n < 86400) return `${Math.round(n / 3600)}h`;
    return `${Math.round(n / 86400)}d`;
  }

  // Which routes reference this provider/key pair? Used to warn before a key is
  // disabled or deleted, since candidates bind to an explicit provider:key_label.
  function routesUsingKey(providerId, keyLabel) {
    const refs = [];
    const agentModels = (state.config && state.config.agent_models) || {};
    for (const [model, route] of Object.entries(agentModels)) {
      const cands = (route && route.candidates) || [];
      if (cands.some((c) => c && c.provider === providerId && (c.key_label === keyLabel) && c.enabled !== false)) {
        refs.push(`Agent 模型 ${model}`);
      }
    }
    const kbModels = (state.config && state.config.kb_models) || {};
    for (const [kind, list] of Object.entries(kbModels)) {
      if ((list || []).some((c) => c && c.provider === providerId && c.key_label === keyLabel)) {
        refs.push(`KB 流水线 ${kind}`);
      }
    }
    return refs;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setupStaticIcons() {
    const setIcon = (id, name) => {
      const el = document.getElementById(id);
      if (el && window.uiIcon) el.innerHTML = window.uiIcon(name);
    };
    setIcon('brandMark', 'server');
    setIcon('loginBrandMark', 'server');
    setIcon('logoutBtn', 'logout');
    setIcon('providerSearchIcon', 'search');
    setIcon('searchProvSearchIcon', 'search');
    setIcon('modelSearchIcon', 'search');
  }

  // --- Initializer ---
  async function init() {
    setupStaticIcons();
    setupLoginScreen();
    setupCapabilities();
    setupTheme();
    setupPrivacyMask();
    setupKeyboardShortcuts();
    setupNavigation();
    setupCreationForms();
    setupToolbars();
    setupConfigBackup();
    // Only fetch data when a credential is already present. An unauthenticated
    // page load must not issue /api/* requests: every one of those is a 401 and
    // would otherwise burn the anti-bruteforce budget (5 hits = 10 min lockout).
    if (window.HOST.getToken()) {
      await loadData();
    }
    startLanesPolling();
  }

  // --- 1. In-Page Magpie Login Overlay (M14) ---
  function setupLoginScreen() {
    const loginForm = document.getElementById('loginForm');
    const pwdInput = document.getElementById('loginPassword');
    const errEl = document.getElementById('loginError');
    const badge = document.getElementById('loginHostBadge');

    if (badge) {
      badge.textContent = window.HOST.kind === 'hub' ? 'Hub' : 'Full';
    }

    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pwd = (pwdInput?.value || '').trim();
        if (!pwd) {
          if (errEl) {
            errEl.textContent = '请输入管理员密码';
            errEl.hidden = false;
            errEl.classList.remove('hidden');
          }
          return;
        }

        const res = await window.HOST.login(pwd);
        if (res.ok) {
          toast('登录成功', 'ok');
          if (errEl) {
            errEl.hidden = true;
            errEl.classList.add('hidden');
          }
          await loadData();
        } else {
          if (errEl) {
            errEl.textContent = res.error || '密码验证失败，请重试';
            errEl.hidden = false;
            errEl.classList.remove('hidden');
          }
        }
      });
    }

    // Auto-prompt login if no token set
    if (!window.HOST.getToken()) {
      window.HOST.showLogin();
    }
  }

  function setupCapabilities() {
    const caps = window.HOST.capabilities;
    const isHub = window.HOST.kind === 'hub';

    const brandRole = document.getElementById('brandRole');
    if (brandRole) brandRole.textContent = isHub ? 'Hub' : 'Full';

    const navModels = document.getElementById('navModels');
    const navSearch = document.getElementById('navSearch');
    const navNodes = document.getElementById('navNodes');
    const navActivity = document.getElementById('navActivity');
    const topVersionBox = document.getElementById('topVersionBox');
    const modeSwitchBox = document.getElementById('modeSwitchBox');
    const vaultSyncBar = document.getElementById('vaultSyncBar');
    const cfgVaultLinkBox = document.getElementById('cfgVaultLinkBox');
    const hubOverviewBox = document.getElementById('hubOverviewBox');
    const fullOverviewBox = document.getElementById('fullOverviewBox');
    const btnClearAllCooldowns = document.getElementById('btnClearAllCooldowns');

    if (navModels) navModels.hidden = false;
    if (navSearch) navSearch.hidden = !caps.vaultHub;
    if (navNodes) navNodes.hidden = !caps.nodeManager;
    if (navActivity) navActivity.hidden = false;
    if (topVersionBox) topVersionBox.hidden = !caps.vaultHub;
    if (modeSwitchBox) modeSwitchBox.hidden = !caps.runModes;
    if (vaultSyncBar) vaultSyncBar.hidden = !caps.vaultClient;
    if (cfgVaultLinkBox) cfgVaultLinkBox.hidden = !caps.vaultClient;
    if (hubOverviewBox) hubOverviewBox.hidden = !isHub;
    if (fullOverviewBox) fullOverviewBox.hidden = isHub;
    if (btnClearAllCooldowns) btnClearAllCooldowns.hidden = !caps.runModes;

    state.activeTab = 'activity';
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
    const btn = document.getElementById('themeToggleBtn');
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (btn && window.uiIcon) btn.innerHTML = window.uiIcon('moon');
    } else if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      if (btn && window.uiIcon) btn.innerHTML = window.uiIcon('sun');
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (btn && window.uiIcon) btn.innerHTML = window.uiIcon('monitor');
    }
  }

  // --- 2. Privacy Masking & Keyboard Shortcuts (M15) ---
  function setupPrivacyMask() {
    const btn = document.getElementById('btnPrivacyMask');
    if (!btn) return;
    const isMasked = localStorage.getItem('llmproxy_privacy_mask') === '1';
    if (isMasked) {
      document.body.classList.add('privacy-masked');
    }
    if (window.uiIcon) {
      btn.innerHTML = window.uiIcon(isMasked ? 'eyeOff' : 'eye');
    }

    btn.addEventListener('click', () => {
      const active = document.body.classList.toggle('privacy-masked');
      localStorage.setItem('llmproxy_privacy_mask', active ? '1' : '0');
      if (window.uiIcon) {
        btn.innerHTML = window.uiIcon(active ? 'eyeOff' : 'eye');
      }
      toast(active ? '隐私遮罩已开启' : '隐私遮罩已关闭', 'info');
    });
  }

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const pForm = document.getElementById('addProviderForm');
        const spForm = document.getElementById('addSearchProviderForm');
        const mForm = document.getElementById('addModelForm');
        const nForm = document.getElementById('issueNodeForm');
        let closedSomething = false;
        if (pForm && !pForm.hidden) { pForm.hidden = true; pForm.classList.add('hidden'); closedSomething = true; }
        if (spForm && !spForm.hidden) { spForm.hidden = true; spForm.classList.add('hidden'); closedSomething = true; }
        if (mForm && !mForm.hidden) { mForm.hidden = true; mForm.classList.add('hidden'); closedSomething = true; }
        if (nForm && !nForm.hidden) { nForm.hidden = true; nForm.classList.add('hidden'); closedSomething = true; }
        if (state.activeEditorKey) {
          state.activeEditorKey = null;
          closedSomething = true;
          if (state.activeTab === 'providers') renderProvidersList();
          else if (state.activeTab === 'search') renderSearchProvidersList();
          else if (state.activeTab === 'models') renderModelsList();
          else if (state.activeTab === 'nodes') renderNodesList();
          else if (state.activeTab === 'activity') renderTracesList();
        }
        if (closedSomething) toast('已取消操作并关闭编辑器', 'info');
      } else if (e.key === '/') {
        const targetTag = (e.target.tagName || '').toLowerCase();
        if (targetTag !== 'input' && targetTag !== 'textarea' && targetTag !== 'select') {
          const firstInput = document.querySelector(`section:not([hidden]) input:not([readonly])`);
          if (firstInput) {
            e.preventDefault();
            firstInput.focus();
          }
        }
      }
    });
  }

  // --- 3. Live Concurrency Lanes & Cooldowns Polling (M11) ---
  function startLanesPolling() {
    if (!window.HOST.capabilities.runModes) return;
    if (state.lanesTimer) clearInterval(state.lanesTimer);

    const poll = async () => {
      if (document.visibilityState === 'hidden' || !window.HOST.getToken()) return;
      if (state.activeTab !== 'providers' && state.activeTab !== 'models') return;
      try {
        const [lanesRes, cdRes] = await Promise.all([
          window.HOST.getLanes(),
          window.HOST.getCooldowns(),
        ]);
        if (lanesRes && lanesRes.ok) {
          state.lanes = lanesRes.lane_map || {};
        }
        if (cdRes) {
          // Index cooldowns by their target key ("p:<provider>:k:<label>") so the
          // key table can show a live 冷却中 state instead of a static 就绪.
          const cdMap = {};
          for (const entry of cdRes.cooldowns || []) {
            if (entry && entry.target) cdMap[entry.target] = entry.remaining_sec || 0;
          }
          state.cooldowns = cdMap;
          state.cooldownsAll = cdRes.cooldowns || [];
        }
      } catch (_) {}
    };

    state.lanesTimer = setInterval(poll, 3000);
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

    // Provider detail panel "自动探测协议" button (rendered per-row inside .editor).
    document.addEventListener('click', async (e) => {
      const target = e.target instanceof Element ? e.target.closest('button[id^="btn_detect_ed_"]') : null;
      if (!target) return;
      const pId = target.id.slice('btn_detect_ed_'.length);
      if (!pId || target.disabled) return;
      target.disabled = true;
      try {
        const baseEl = document.getElementById(`ed_p_base_${pId}`);
        const res = await window.HOST.detectProvider({
          provider: pId,
          base_url: baseEl ? baseEl.value.trim() : '',
        });
        if (res && res.ok) {
          const protocols = Array.isArray(res.protocols) ? res.protocols.join(' / ') : '';
          toast(`协议探测成功${protocols ? `: ${protocols}` : ''}`, 'ok');
          if (baseEl && res.normalized_base_url) baseEl.value = res.normalized_base_url;
        } else {
          toast(`协议探测失败: ${(res && res.error) || '未知错误'}`, 'err');
        }
      } catch (err) {
        toast(`协议探测失败: ${err.message}`, 'err');
      } finally {
        target.disabled = false;
      }
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        window.HOST.setToken('');
        window.HOST.showLogin();
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

    // Analytics Period Selector
    const periodSeg = document.getElementById('activityPeriodSeg');
    if (periodSeg) {
      periodSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const p = btn.getAttribute('data-period');
          if (!p || p === state.currentPeriod) return;
          state.currentPeriod = p;
          periodSeg.querySelectorAll('.seg-btn').forEach((b) => {
            if (b.getAttribute('data-period') === p) b.classList.add('active');
            else b.classList.remove('active');
          });
          await loadActivityData();
        });
      });
    }

    // Analytics 3-Dimension Breakdown Sub-Tabs (M10)
    const dimSeg = document.getElementById('usageDimensionSeg');
    if (dimSeg) {
      dimSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const dim = btn.getAttribute('data-dim');
          if (!dim) return;
          window.USAGE.state.subTab = dim;
          dimSeg.querySelectorAll('.seg-btn').forEach((b) => {
            if (b.getAttribute('data-dim') === dim) b.classList.add('active');
            else b.classList.remove('active');
          });
          if (state.usage) window.USAGE.renderBreakdown(state.usage);
        });
      });
    }

    const btnClearTraces = document.getElementById('btnClearTraces');
    if (btnClearTraces) {
      btnClearTraces.addEventListener('click', async () => {
        if (!confirm('确定清空所有请求轨迹与监控日志吗？')) return;
        try {
          const res = await window.HOST.clearTraces();
          if (res && res.ok) {
            toast('轨迹已清空', 'ok');
            await loadActivityData();
          }
        } catch (e) {
          toast(e.message, 'err');
        }
      });
    }

    const btnFilterRetried = document.getElementById('btnFilterRetried');
    if (btnFilterRetried) {
      btnFilterRetried.addEventListener('click', () => {
        state.filterOnlyRetried = !state.filterOnlyRetried;
        btnFilterRetried.classList.toggle('active', state.filterOnlyRetried);
        renderTracesList();
      });
    }
  }

  // --- 4. Presets & cURL Auto-Parser (M3, M4) ---
  const PRESETS_META = {
    openai: ['openai', 'OpenAI (官方)', 'https://api.openai.com/v1', 'openai-completions'],
    anthropic: ['anthropic', 'Anthropic (官方)', 'https://api.anthropic.com/v1', 'anthropic-messages'],
    gemini: ['gemini', 'Google Gemini (OpenAI兼容)', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini'],
    deepseek: ['deepseek', 'DeepSeek (官方)', 'https://api.deepseek.com/v1', 'openai-completions'],
    openrouter: ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'openai-completions'],
    groq: ['groq', 'Groq Cloud', 'https://api.groq.com/openai/v1', 'openai-completions'],
    xai: ['xai', 'xAI', 'https://api.x.ai/v1', 'openai-completions'],
    'minimax-global': ['minimax', 'MiniMax (Global)', 'https://api.minimaxi.chat/v1', 'openai-completions'],
    'minimax-cn': ['minimax', 'MiniMax (国内)', 'https://api.minimax.chat/v1', 'openai-completions'],
    'kimi-cn': ['kimi', 'Kimi / Moonshot (国内)', 'https://api.moonshot.cn/v1', 'openai-completions'],
    'kimi-global': ['kimi', 'Kimi / Moonshot (Global)', 'https://api.moonshot.ai/v1', 'openai-completions'],
    zhipu: ['zhipu', '智谱 BigModel (PayG)', 'https://open.bigmodel.cn/api/paas/v4', 'openai-completions'],
    'zhipu-coding': ['zhipu', '智谱 Coding', 'https://open.bigmodel.cn/api/coding/paas/v4', 'openai-completions'],
    volcengine: ['volcengine', '火山方舟 Ark (PayG)', 'https://ark.cn-beijing.volces.com/api/v3', 'openai-completions'],
    'volcengine-coding': ['volcengine', '火山方舟 Coding', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'openai-completions'],
    'stepfun-cn': ['stepfun', '阶跃星辰 Stepfun (国内)', 'https://api.stepfun.com/v1', 'openai-completions'],
    'stepfun-global': ['stepfun', '阶跃星辰 Stepfun (Global)', 'https://api.stepfun.ai/v1', 'openai-completions'],
    alibaba: ['alibaba', '阿里百炼 / DashScope (国内)', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai-completions'],
    'alibaba-intl': ['alibaba', '阿里百炼 / DashScope (国际)', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'openai-completions'],
    siliconflow: ['siliconflow', 'SiliconFlow (硅基流动)', 'https://api.siliconflow.cn/v1', 'openai-completions'],
    ollama: ['ollama', 'Ollama (本地)', 'http://localhost:11434/v1', 'openai-completions'],
  };

  // Robust cURL Command Parser (M3)
  function parseCurl(text) {
    let s = String(text || '').trim();
    const head = /^curl(?:\.exe)?(?=\s)/i.exec(s);
    if (!head) return null;
    s = s.slice(head[0].length).replace(/(?:\\|\^|`)[ \t]*\r?\n/g, ' ');

    const words = [];
    let w = null;
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (/\s/.test(c)) { if (w !== null) words.push(w); w = null; i++; continue; }
      w ??= '';
      if (c === "'") {
        let j = i + 1;
        const k = s.indexOf("'", j);
        if (k < 0) { w += s.slice(j); break; }
        w += s.slice(j, k);
        i = k + 1;
      } else if (c === '"') {
        for (i++; i < s.length && s[i] !== '"'; i++) {
          if (s[i] === '\\' && i + 1 < s.length) i++;
          w += s[i] ?? '';
        }
        i++;
      } else {
        w += c;
        i++;
      }
    }
    if (w !== null) words.push(w);

    let url = '';
    const headers = [];
    let body = '';

    for (let i = 0; i < words.length; i++) {
      const x = words[i];
      let opt = x, val = null;
      if (/^-[Hd]/.test(x)) { opt = x.slice(0, 2); val = x.slice(2); }
      else if (/^(-H|--header|-d|--data|--data-raw|--json|--url)$/.test(x)) val = words[++i] ?? '';
      else if (x.startsWith('-')) continue;
      else { if (!url) url = x; continue; }

      if (opt === '-H' || opt === '--header') headers.push(val);
      else if (opt === '--url') url = val;
      else if (/^(-d|--data(-raw)?|--json)$/.test(opt)) body = val;
    }

    let key = '';
    for (const h of headers) {
      const m = /^\s*(authorization|x-api-key|x-goog-api-key|api-key)\s*:\s*(.*?)\s*$/i.exec(h);
      if (m) {
        const val = m[1].toLowerCase() === 'authorization' ? m[2].replace(/^bearer\s+/i, '') : m[2];
        if (val && !/^\$|^<.*>|your[_-]?key/i.test(val)) {
          key = val.trim();
          break;
        }
      }
    }

    let protocol = 'openai-completions';
    let base = url;
    if (/\/messages\b/i.test(url)) {
      protocol = 'anthropic-messages';
      base = url.replace(/\/messages.*$/i, '');
    } else if (/\/chat\/completions\b/i.test(url)) {
      protocol = 'openai-completions';
      base = url.replace(/\/chat\/completions.*$/i, '');
    } else if (/\/v1beta\b/i.test(url) || /generativelanguage/i.test(url)) {
      protocol = 'gemini';
    }

    let model = '';
    try {
      const parsedBody = JSON.parse(body.replace(/\\"/g, '"'));
      if (typeof parsedBody?.model === 'string') model = parsedBody.model.trim();
    } catch (_) {}

    return { url, base, protocol, key, model };
  }

  function populatePresetDropdown() {
    const sel = document.getElementById('newProvPreset');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- 选择预设模板或手动填写 --</option>';
    for (const [key, meta] of Object.entries(PRESETS_META)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = meta[1];
      sel.appendChild(opt);
    }
  }

  function setupToolbars() {
    const provSearch = document.getElementById('providerSearchInput');
    if (provSearch) {
      provSearch.addEventListener('input', (e) => {
        state.providerQuery = (e.target.value || '').trim().toLowerCase();
        renderProvidersList();
      });
    }

    const provFilter = document.getElementById('providerFilterSeg');
    if (provFilter) {
      provFilter.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const f = btn.getAttribute('data-filter') || 'all';
          state.providerFilter = f;
          provFilter.querySelectorAll('.seg-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-filter') === f);
          });
          renderProvidersList();
        });
      });
    }

    const modelSearch = document.getElementById('modelSearchInput');
    if (modelSearch) {
      modelSearch.addEventListener('input', (e) => {
        state.modelQuery = (e.target.value || '').trim().toLowerCase();
        renderModelsList();
      });
    }

    const searchProvSearch = document.getElementById('searchProvSearchInput');
    if (searchProvSearch) {
      searchProvSearch.addEventListener('input', (e) => {
        state.searchQuery = (e.target.value || '').trim().toLowerCase();
        renderSearchProvidersList();
      });
    }

    const modelSubSeg = document.getElementById('modelPipelineSeg');
    if (modelSubSeg) {
      modelSubSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const m = btn.getAttribute('data-submode') || 'agent';
          state.modelSubMode = m;
          modelSubSeg.querySelectorAll('.seg-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-submode') === m);
          });
          renderModelsList();
        });
      });
    }

    document.getElementById('btnHubRefreshOverview')?.addEventListener('click', loadData);
    document.getElementById('btnHubBatchVerifyAll')?.addEventListener('click', verifyAllHubKeys);
    document.getElementById('btnGoProvidersFromHub')?.addEventListener('click', () => switchTab('providers'));
    document.getElementById('btnGoNodesFromHub')?.addEventListener('click', () => switchTab('nodes'));
    document.getElementById('btnGoSearchFromHub')?.addEventListener('click', () => switchTab('search'));

    const extSeg = document.getElementById('extServiceProtoSeg');
    if (extSeg) {
      extSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const proto = btn.getAttribute('data-proto') || 'all';
          state.extServiceProto = proto;
          extSeg.querySelectorAll('.seg-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-proto') === proto);
          });
          renderExtensionServices();
        });
      });
    }
  }

  function setupConfigBackup() {
    document.getElementById('btnExportConfig')?.addEventListener('click', async () => {
      try {
        const res = await window.HOST.exportConfig();
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `llmproxy_config_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast('配置已导出下载', 'ok');
      } catch (e) {
        toast(`导出失败: ${e.message}`, 'err');
      }
    });

    const importInput = document.getElementById('importConfigFile');
    document.getElementById('btnTriggerImport')?.addEventListener('click', () => {
      importInput?.click();
    });

    if (importInput) {
      importInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const parsed = JSON.parse(reader.result);
            const mode = document.getElementById('importConfigMode')?.value || 'merge';
            const res = await window.HOST.importConfig({ mode, config: parsed });
            if (res && (res.ok || res._version !== undefined)) {
              toast('配置恢复导入成功', 'ok');
              await loadData();
            } else {
              toast(res?.error || '导入失败', 'err');
            }
          } catch (err) {
            toast(`解析配置失败: ${err.message}`, 'err');
          } finally {
            importInput.value = '';
          }
        };
        reader.readAsText(file);
      });
    }
  }

  function setupCreationForms() {
    populatePresetDropdown();
    const pForm = document.getElementById('addProviderForm');
    const mForm = document.getElementById('addModelForm');
    const toggle = (el, show) => {
      if (!el) return;
      el.hidden = show !== undefined ? !show : !el.hidden;
      el.classList.toggle('hidden', el.hidden);
    };

    document.getElementById('btnAddProvider')?.addEventListener('click', () => toggle(pForm));
    document.getElementById('btnCancelAddProvider')?.addEventListener('click', () => toggle(pForm, false));

    // cURL Paste Toggle & Input (M3)
    const btnToggleCurl = document.getElementById('btnToggleCurlPaste');
    const curlWrap = document.getElementById('curlPasteWrap');
    const curlInput = document.getElementById('curlPasteInput');
    if (btnToggleCurl && curlInput) {
      btnToggleCurl.addEventListener('click', () => {
        const target = curlWrap || curlInput;
        target.hidden = !target.hidden;
        target.classList.toggle('hidden', target.hidden);
        if (!target.hidden) curlInput.focus();
      });

      curlInput.addEventListener('input', () => {
        const parsed = parseCurl(curlInput.value);
        if (parsed) {
          if (parsed.base) document.getElementById('newProvBaseUrl').value = parsed.base;
          if (parsed.key) document.getElementById('newProvApiKey').value = parsed.key;
          if (parsed.protocol) document.getElementById('newProvApiType').value = parsed.protocol;
          if (parsed.model) {
            const mId = document.getElementById('newProvId');
            if (mId && !mId.value) mId.value = parsed.model.split('/')[0].split('-')[0];
          }
          toast('已从 cURL 自动解析填充 Base URL 与密钥！', 'ok');
        }
      });
    }

    // Auto-detect protocols button in Add Provider (M1)
    const btnDetect = document.getElementById('btnDetectProvider');
    if (btnDetect) {
      btnDetect.addEventListener('click', async () => {
        const baseUrl = (document.getElementById('newProvBaseUrl')?.value || '').trim();
        const apiKey = (document.getElementById('newProvApiKey')?.value || '').trim();
        if (!baseUrl) return toast('请先输入 Base URL', 'warn');
        toast('正在探测上游支持协议与延迟...', 'info');
        try {
          const res = await window.HOST.detectProvider({ base_url: baseUrl, api_key: apiKey });
          if (res && res.ok) {
            toast(`探测成功！已发现协议支持 (延迟: ${res.latency_ms || 0}ms)`, 'ok');
            if (res.base_url) document.getElementById('newProvBaseUrl').value = res.base_url;
            if (res.protocol) document.getElementById('newProvApiType').value = res.protocol;
          } else {
            // Fallback probe
            const probe = await window.HOST.probeModels({ base_url: baseUrl, api_key: apiKey });
            if (probe && (probe.ok || probe.count)) {
              toast(`探测成功: 发现 ${probe.count || probe.models?.length || 0} 个可用模型`, 'ok');
            } else {
              toast(`协议探测完成: Base URL 有效`, 'info');
            }
          }
        } catch (e) {
          toast(`探测完成: ${e.message}`, 'info');
        }
      });
    }

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

    setupSearchCreationForm(toggle);
  }

  const SEARCH_PRESETS_META = {
    brave: { id: 'brave', name: 'Brave Search', adapter: 'brave', base_url: 'https://api.search.brave.com', capabilities: ['search'] },
    tavily: { id: 'tavily', name: 'Tavily Search', adapter: 'tavily', base_url: 'https://api.tavily.com', capabilities: ['search', 'fetch'] },
    jina: { id: 'jina', name: 'Jina Reader / Search', adapter: 'jina', base_url: 'https://s.jina.ai', capabilities: ['search', 'fetch'] },
    serper: { id: 'serper', name: 'Serper (Google)', adapter: 'serper', base_url: 'https://google.serper.dev', capabilities: ['search'] },
    firecrawl: { id: 'firecrawl', name: 'Firecrawl', adapter: 'firecrawl', base_url: 'https://api.firecrawl.dev', capabilities: ['search', 'fetch'] },
  };

  function parseOptionalJsonField(raw, fieldName) {
    const txt = String(raw || '').trim();
    if (!txt) return undefined;
    try {
      const parsed = JSON.parse(txt);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${fieldName} 必须是 JSON 对象`);
      }
      return parsed;
    } catch (e) {
      throw new Error(`${fieldName} JSON 解析失败: ${e.message}`);
    }
  }

  function setupSearchCreationForm(toggle) {
    const presetSel = document.getElementById('newSearchPreset');
    if (presetSel) {
      presetSel.innerHTML = '<option value="">-- 自定义搜索提供商 --</option>';
      Object.entries(SEARCH_PRESETS_META).forEach(([k, meta]) => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = meta.name;
        presetSel.appendChild(opt);
      });
      presetSel.addEventListener('change', (e) => {
        const meta = SEARCH_PRESETS_META[e.target.value];
        if (!meta) return;
        document.getElementById('newSearchId').value = meta.id;
        document.getElementById('newSearchName').value = meta.name;
        document.getElementById('newSearchAdapter').value = meta.adapter;
        document.getElementById('newSearchBaseUrl').value = meta.base_url;
        document.getElementById('newSearchCapSearch').checked = meta.capabilities.includes('search');
        document.getElementById('newSearchCapFetch').checked = meta.capabilities.includes('fetch');
      });
    }

    const spForm = document.getElementById('addSearchProviderForm');
    document.getElementById('btnAddSearchProvider')?.addEventListener('click', () => toggle(spForm));
    document.getElementById('btnCancelAddSearchProvider')?.addEventListener('click', () => toggle(spForm, false));

    document.getElementById('btnConfirmAddSearchProvider')?.addEventListener('click', async () => {
      const id = (document.getElementById('newSearchId')?.value || '').trim().toLowerCase();
      const name = (document.getElementById('newSearchName')?.value || '').trim();
      const origin = document.getElementById('newSearchOrigin')?.value || 'vault';
      const adapter = (document.getElementById('newSearchAdapter')?.value || '').trim();
      const baseUrl = (document.getElementById('newSearchBaseUrl')?.value || '').trim();
      const timeoutRaw = document.getElementById('newSearchTimeoutMs')?.value;
      const keyAlias = (document.getElementById('newSearchKeyAlias')?.value || '').trim() || 'k1';
      const apiKey = (document.getElementById('newSearchApiKey')?.value || '').trim();

      const caps = [];
      if (document.getElementById('newSearchCapSearch')?.checked) caps.push('search');
      if (document.getElementById('newSearchCapFetch')?.checked) caps.push('fetch');

      if (!/^[a-z0-9-]+$/.test(id)) return toast('提供商 ID 仅支持小写字母、数字和连字符', 'warn');
      const v = validateSearchSpec({
        name,
        baseUrl,
        timeoutRaw,
        caps,
        adapter,
        reqRaw: document.getElementById('newSearchRequestJson')?.value,
        respRaw: document.getElementById('newSearchResponseJson')?.value,
        fetchRaw: document.getElementById('newSearchFetchJson')?.value,
        secrets: [apiKey],
      });
      if (v.error) return toast(v.error, 'warn');

      state.config = state.config || { providers: {}, agent_models: {}, search_providers: {}, search_selection: { search: [], fetch: '' } };
      state.config.search_providers = state.config.search_providers || {};
      if (state.config.search_providers[id]) return toast(`搜索提供商 ${id} 已存在`, 'warn');

      const entry = {
        id,
        name,
        enabled: true,
        origin,
        capabilities: caps,
        timeout_ms: v.timeoutMs,
        api_keys: apiKey ? [{ id: keyAlias, label: keyAlias, key: apiKey, enabled: true, origin }] : [],
      };
      if (baseUrl) entry.base_url = baseUrl;
      if (adapter) entry.adapter = adapter;
      if (v.reqObj) entry.request = v.reqObj;
      if (v.respObj) entry.response = v.respObj;
      if (v.fetchObj) entry.fetch = v.fetchObj;

      state.config.search_providers[id] = entry;
      state.activeEditorKey = `sp_${id}`;
      ['newSearchId', 'newSearchName', 'newSearchAdapter', 'newSearchBaseUrl', 'newSearchKeyAlias', 'newSearchApiKey', 'newSearchRequestJson', 'newSearchResponseJson', 'newSearchFetchJson'].forEach((fid) => {
        const el = document.getElementById(fid);
        if (el) el.value = '';
      });
      toggle(spForm, false);
      await persistConfig('搜索提供商创建成功');
    });

    document.getElementById('btnSaveSearchSelection')?.addEventListener('click', async () => {
      const spMap = state.config?.search_providers || {};
      const searchIds = Array.from(document.querySelectorAll('#searchSelectionSearchGroup input[type="checkbox"]:checked'))
        .map((cb) => cb.value)
        .filter((id) => Boolean(id) && spMap[id] && Array.isArray(spMap[id].capabilities) && spMap[id].capabilities.includes('search'));
      const fetchRadio = document.querySelector('#searchSelectionFetchGroup input[type="radio"]:checked');
      const fetchId = fetchRadio ? fetchRadio.value : '';
      if (fetchId && (!spMap[fetchId] || !Array.isArray(spMap[fetchId].capabilities) || !spMap[fetchId].capabilities.includes('fetch'))) {
        return toast(`选中的抓取提供商 ${fetchId} 不存在或未启用 fetch 能力`, 'warn');
      }

      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.search_selection = { search: searchIds, fetch: fetchId };
      await persistConfig('全局搜索筛选策略已保存');
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
      search: document.getElementById('viewSearch'),
      nodes: document.getElementById('viewNodes'),
      activity: document.getElementById('viewActivity'),
      settings: document.getElementById('viewSettings'),
    };

    for (const [k, v] of Object.entries(views)) {
      if (v) v.hidden = k !== tab;
    }

    if (tab === 'search') {
      renderSearchView();
    } else if (tab === 'activity') {
      if (window.HOST.kind === 'hub') {
        renderHubOverview();
      } else if (window.HOST.capabilities.usageAndTraces) {
        loadActivityData();
      }
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
        state.modelSubMode = mode;
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
      btnAgent.classList.toggle('active', isAgent);
      btnKB.classList.toggle('active', !isAgent);
    }
    const modelSubSeg = document.getElementById('modelPipelineSeg');
    if (modelSubSeg) {
      modelSubSeg.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-submode') === mode);
      });
    }
  }

  async function loadData() {
    try {
      const cfgResp = await window.HOST.getConfig();
      if (cfgResp && (cfgResp.ok || cfgResp.providers || cfgResp._version !== undefined)) {
        state.config = cfgResp;
        const verEl = document.getElementById('configVersionDisplay');
        if (verEl) verEl.textContent = `v${cfgResp._version || 1}`;

        if (state.config.settings && state.config.settings.run_mode) {
          state.modelSubMode = state.config.settings.run_mode;
          updateRunModeUI(state.config.settings.run_mode);
        }

        renderProvidersList();
        renderModelsList();
        renderSearchView();
        renderSettingsView();
      }

      if (window.HOST.capabilities.nodeManager) {
        await loadNodesData();
      }

      if (window.HOST.kind === 'hub' && state.activeTab === 'activity') {
        renderHubOverview();
      } else if (window.HOST.capabilities.usageAndTraces && state.activeTab === 'activity') {
        await loadActivityData();
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
        renderSearchView();
        if (window.HOST.kind === 'hub' && state.activeTab === 'activity') {
          renderHubOverview();
        }
      }
    } catch (e) {
      toast(`节点加载失败: ${e.message}`, 'err');
    }
  }

  function renderHubOverview() {
    const kpiGrid = document.getElementById('hubKpiGrid');
    const provBody = document.getElementById('hubProviderStatsBody');
    const nodeBody = document.getElementById('hubNodeStatsBody');
    const summarySub = document.getElementById('hubHealthSummarySub');
    if (!kpiGrid || !provBody || !nodeBody) return;

    const cfg = state.config || {};
    const providers = cfg.providers || {};
    const provEntries = Object.entries(providers).sort(([a], [b]) => a.localeCompare(b));
    const agentModels = cfg.agent_models || {};
    const kbModels = cfg.kb_models || {};
    const nodes = state.nodes || [];

    let enabledProvs = 0;
    let totalKeys = 0;
    let enabledKeys = 0;
    let okKeys = 0;
    let failKeys = 0;
    let untestedKeys = 0;

    for (const [, p] of provEntries) {
      if (p.enabled !== false) enabledProvs++;
      const keys = p.api_keys || [];
      for (const k of keys) {
        totalKeys++;
        if (k.enabled !== false) enabledKeys++;
        if (k.last_ok === true) okKeys++;
        else if (k.last_ok === false) failKeys++;
        else untestedKeys++;
      }
    }

    const agentModelCount = Object.keys(agentModels).length;
    let agentCandCount = 0;
    for (const m of Object.values(agentModels)) {
      agentCandCount += (m?.candidates || []).length;
    }

    let kbCandCount = 0;
    for (const list of Object.values(kbModels)) {
      if (Array.isArray(list)) kbCandCount += list.length;
    }

    let activeNodes = 0;
    let totalSyncs = 0;
    let total304 = 0;
    for (const n of nodes) {
      if (n.enabled) activeNodes++;
      totalSyncs += Number(n.sync_count || 0);
      total304 += Number(n.hit_304_count || 0);
    }

    const testedCount = okKeys + failKeys;
    const healthRate = testedCount > 0 ? `${Math.round((okKeys / testedCount) * 100)}%` : '-';

    const kpis = [
      { label: '纳管供应商', value: String(provEntries.length), sub: `${enabledProvs} 个已启用` },
      { label: 'API 密钥总量', value: String(totalKeys), sub: `${enabledKeys} 把已启用` },
      { label: '密钥探活健康度', value: healthRate, sub: `正常 ${okKeys} · 异常 ${failKeys} · 未测 ${untestedKeys}` },
      { label: 'Agent 路由模型', value: String(agentModelCount), sub: `${agentCandCount} 个上游候选` },
      { label: '知识库流水线', value: String(kbCandCount), sub: '4 条 KB 并发通道' },
      { label: '注册中转节点', value: String(nodes.length), sub: `${activeNodes} 个在线启用` },
      { label: '节点同步 / 304', value: String(totalSyncs), sub: `304 缓存命中 ${total304} 次` },
      { label: '当前配置版本', value: `v${cfg._version || 1}`, sub: 'EdgeOne KV CAS' },
    ];

    kpiGrid.innerHTML = kpis.map((item) => `
      <div class="kpi-card">
        <span class="kpi-label">${escapeHtml(item.label)}</span>
        <span class="kpi-value">${escapeHtml(item.value)}</span>
        <span class="kpi-sub">${escapeHtml(item.sub)}</span>
      </div>
    `).join('');

    if (summarySub) {
      summarySub.textContent = `共 ${provEntries.length} 个供应商、${totalKeys} 把密钥（已探活正常 ${okKeys}，异常 ${failKeys}，未测 ${untestedKeys}）`;
    }

    if (provEntries.length === 0) {
      provBody.innerHTML = '<tr><td colspan="6" class="text-muted">暂无供应商配置，点击右上角「管理供应商」添加或导入</td></tr>';
    } else {
      provBody.innerHTML = '';
      for (const [pId, p] of provEntries) {
        const keys = p.api_keys || [];
        const pTotal = keys.length;
        const pEnabled = keys.filter((k) => k.enabled !== false).length;
        const pOk = keys.filter((k) => k.last_ok === true).length;
        const pFail = keys.filter((k) => k.last_ok === false).length;
        const pLat = keys.reduce((acc, k) => (k.last_latency_ms ? Math.min(acc, k.last_latency_ms) : acc), Infinity);
        const latText = Number.isFinite(pLat) ? `${pLat}ms` : '-';
        const pct = pTotal > 0 ? Math.round(((pOk > 0 ? pOk : (pFail > 0 ? 0 : pEnabled)) / pTotal) * 100) : 0;
        const barCls = pFail > 0 && pOk === 0 ? 'health-fill--err' : pOk > 0 ? 'health-fill--ok' : 'health-fill--warn';
        const icoHtml = window.renderBrandIcon ? window.renderBrandIcon(p.preset_id || pId) : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>
            <div class="name">${icoHtml}<span>${escapeHtml(p.name || pId)}</span><span class="pill">${escapeHtml(pId)}</span></div>
          </td>
          <td><span class="pill">${escapeHtml(p.api_type || 'openai')}</span></td>
          <td class="tabular">${pEnabled} / ${pTotal}</td>
          <td>
            <div class="health-bar">
              <svg viewBox="0 0 100 6" width="72" height="6">
                <rect x="0" y="0" width="100" height="6" rx="3" fill="currentColor" opacity="0.12"></rect>
                <rect x="0" y="0" width="${pct}" height="6" rx="3" class="health-fill ${barCls}"></rect>
              </svg>
              <span class="text-xs text-muted">${pOk}正常 / ${pFail}异常</span>
            </div>
          </td>
          <td class="tabular">${latText}</td>
          <td>
            <button class="btn btn--sm btn-hub-verify-prov" data-pid="${escapeHtml(pId)}" type="button">探活</button>
          </td>
        `;
        tr.querySelector('.btn-hub-verify-prov').addEventListener('click', () => verifyProviderKeys(pId));
        provBody.appendChild(tr);
      }
    }

    nodeBody.innerHTML = nodes.length
      ? nodes.map((n) => {
          const snap = getNodeSyncSnapshotStatus(n);
          return `<tr><td><strong>${escapeHtml(n.name || n.id)}</strong></td><td><span class="pill pill--accent">${escapeHtml(n.role || 'full')}</span></td><td><span class="pill ${snap.pillCls}">${escapeHtml(snap.label)}</span> <span class="text-xs text-muted">${escapeHtml(snap.leaseText)}</span></td><td class="tabular">${escapeHtml(`${n.last_ip || '-'} · ${n.last_config_version ? `v${n.last_config_version}` : '-'}`)}</td><td class="tabular">${n.sync_count || 0} / ${n.hit_304_count || 0}</td><td class="tabular">${escapeHtml(snap.syncMs ? formatTime(snap.syncMs) : '从未同步')}</td></tr>`;
        }).join('')
      : '<tr><td colspan="6" class="text-muted">暂无中转节点</td></tr>';

    renderHubMcpTelemetry();
  }

  function renderHubMcpTelemetry() {
    const tbody = document.getElementById('hubMcpTelemetryBody');
    if (!tbody) return;
    const targets = getMcpNodes();
    if (!targets.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted">暂无 MCP 节点快照，同步 /api/node/config 时上报</td></tr>';
      return;
    }
    tbody.innerHTML = targets.map((n) => {
      const snap = getNodeSyncSnapshotStatus(n), t = n.telemetry;
      const pwPill = t?.playwright_ready === true ? '<span class="pill pill--green">就绪</span>' : (t?.playwright_ready === false ? '<span class="pill pill--red">未就绪</span>' : '<span class="pill">-</span>');
      const counts = t ? `${t.search_count ?? t.requests ?? 0} / ${t.crawl_count ?? 0}` : '-';
      const resting = t ? (t.resting_keys?.length ? t.resting_keys.join(', ') : `${t.resting_keys_count ?? 0} 休眠`) : '未上报';
      return `<tr><td><strong>${escapeHtml(n.name || n.id)}</strong></td><td><span class="pill ${snap.pillCls}">${escapeHtml(snap.label)}</span> <span class="text-xs text-muted">${escapeHtml(snap.leaseText)}</span></td><td class="tabular">${escapeHtml(t?.version || '-')} · ${pwPill}</td><td class="tabular">${escapeHtml(counts)}</td><td><span class="tabular">${escapeHtml(resting)}</span> · <span class="text-xs text-muted">${escapeHtml(t?.last_error ? scrubUiText(t.last_error) : '-')}</span></td><td class="tabular">${escapeHtml(snap.syncMs ? formatTime(snap.syncMs) : '从未同步')}</td></tr>`;
    }).join('');
  }

  async function verifyProviderKeys(pId) {
    const p = state.config?.providers?.[pId];
    if (!p) return;
    const keys = p.api_keys || [];
    if (keys.length === 0) return toast(`${p.name || pId} 暂无密钥可探活`, 'warn');
    toast(`正在探活 ${p.name || pId} (${keys.length} 把密钥)...`, 'info');
    let okCount = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const lbl = k.label || k.id || `key-${i}`;
      try {
        const r = await window.HOST.verifyKey({
          provider: pId,
          api_key: k.key,
          key: k.key,
          key_label: lbl,
          base_url: p.base_url || '',
          api_type: p.api_type || 'openai-completions',
        });
        k.last_ok = !!(r && (r.ok || r.valid));
        k.last_status = r?.status || (k.last_ok ? 200 : 0);
        k.last_latency_ms = r?.latency_ms ?? r?.ms ?? 0;
        k.last_checked_at = new Date().toISOString();
        if (k.last_ok) okCount++;
      } catch (_) {
        k.last_ok = false;
      }
    }
    toast(`${p.name || pId} 探活完成: ${okCount}/${keys.length} 正常`, okCount === keys.length ? 'ok' : 'warn');
    if (window.HOST.kind === 'hub') renderHubOverview();
    renderProvidersList();
  }

  async function verifyAllHubKeys() {
    if (state.batchVerifying) return;
    const providers = state.config?.providers || {};
    const pIds = Object.keys(providers).sort();
    if (pIds.length === 0) return toast('暂无供应商可探活', 'warn');

    const btn = document.getElementById('btnHubBatchVerifyAll');
    state.batchVerifying = true;
    if (btn) btn.disabled = true;

    let total = 0;
    let ok = 0;
    try {
      toast(`开始批量探活 ${pIds.length} 个供应商密钥池...`, 'info');
      for (const pId of pIds) {
        const p = providers[pId];
        const keys = (p?.api_keys || []).filter((k) => k.enabled !== false);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          total++;
          const lbl = k.label || k.id || `key-${i}`;
          try {
            const r = await window.HOST.verifyKey({
              provider: pId,
              api_key: k.key,
              key: k.key,
              key_label: lbl,
              base_url: p.base_url || '',
              api_type: p.api_type || 'openai-completions',
            });
            k.last_ok = !!(r && (r.ok || r.valid));
            k.last_status = r?.status || (k.last_ok ? 200 : 0);
            k.last_latency_ms = r?.latency_ms ?? r?.ms ?? 0;
            k.last_checked_at = new Date().toISOString();
            if (k.last_ok) ok++;
          } catch (_) {
            k.last_ok = false;
          }
        }
        renderHubOverview();
      }
      toast(`全部密钥探活完成: ${ok}/${total} 正常`, ok === total ? 'ok' : 'warn');
    } finally {
      state.batchVerifying = false;
      if (btn) btn.disabled = false;
      renderProvidersList();
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
        window.USAGE.renderKPIs(usageRes);
        window.USAGE.renderStackedBarChart(usageRes);
        window.USAGE.renderHeatmap(usageRes);
        window.USAGE.renderBreakdown(usageRes);
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

  // --- View: Providers (M1~M6, U2, U4) ---
  function renderProvidersList() {
    const container = document.getElementById('providersList');
    if (!container) return;
    container.innerHTML = '';

    const providers = (state.config && state.config.providers) || {};
    const q = state.providerQuery || '';
    const f = state.providerFilter || 'all';

    const pKeys = Object.keys(providers).sort().filter((pId) => {
      const p = providers[pId] || {};
      const keys = p.api_keys || [];
      if (q) {
        const hay = `${pId} ${p.name || ''} ${p.base_url || ''} ${p.preset_id || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (f === 'enabled') return p.enabled !== false && keys.length > 0;
      if (f === 'healthy') return keys.some((k) => k.last_ok === true);
      if (f === 'issue') return keys.length === 0 || keys.some((k) => k.last_ok !== true);
      return true;
    });

    if (pKeys.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'row row--static text-muted';
      emptyRow.textContent = q || f !== 'all' ? '没有符合筛选条件的供应商' : '暂无已配置供应商，请点击上方「添加供应商」';
      container.appendChild(emptyRow);
      return;
    }

    for (const pId of pKeys) {
      const p = providers[pId] || {};
      const keys = p.api_keys || [];
      const keyCount = keys.length;
      const okCount = keys.filter((k) => k.last_ok === true).length;
      const failCount = keys.filter((k) => k.last_ok === false).length;
      const isLocal = p.origin === 'local';
      const isExpanded = state.activeEditorKey === `p_${pId}`;
      const brandIcon = window.renderBrandIcon ? window.renderBrandIcon(p.preset_id || pId) : '';

      // Check live lanes concurrency for this provider
      let busyCount = 0;
      let waitCount = 0;
      if (state.lanes) {
        for (const [laneKey, laneVal] of Object.entries(state.lanes)) {
          if (laneKey.startsWith(pId + ':') || laneKey === pId) {
            busyCount += laneVal.Busy || 0;
            waitCount += laneVal.Waiting || 0;
          }
        }
      }

      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = document.createElement('span');
      const dotCls = p.enabled === false || keyCount === 0 || (failCount > 0 && okCount === 0)
        ? 'dot--err'
        : okCount > 0
          ? 'dot--ok'
          : 'dot--warn';
      dot.className = `dot ${dotCls}`;

      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          ${brandIcon}
          <span>${escapeHtml(p.name || pId)}</span>
          <span class="pill">${escapeHtml(pId)}</span>
          ${isLocal ? '<span class="pill pill--amber">本地私有</span>' : '<span class="pill pill--green">共享</span>'}
          ${okCount > 0 ? `<span class="pill pill--green">${okCount}/${keyCount} 正常</span>` : ''}
          ${failCount > 0 ? `<span class="pill pill--red">${failCount} 异常</span>` : ''}
          ${busyCount > 0 ? `<span class="pill pill--accent">运行中: ${busyCount}${waitCount ? ` (排队:${waitCount})` : ''}</span>` : ''}
          ${p._balance ? `<span class="pill pill--green">${escapeHtml(p._balance)}</span>` : ''}
        </div>
        <div class="sub">${escapeHtml(p.base_url || '未配置 Base URL')}</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill tabular">${keyCount} 把 Key</span>
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
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">供应商标识 / 名称</label>
          <input class="input" id="ed_p_name_${pId}" value="${escapeHtml(p.name || pId)}">
        </div>
        <div class="form-group">
          <label class="form-label">Base URL (OpenAI 协议)</label>
          <div class="input-row">
            <input class="input input--code" id="ed_p_base_${pId}" value="${escapeHtml(p.base_url || '')}">
            <button class="btn" id="btn_detect_ed_${pId}" type="button">自动探测</button>
          </div>
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

      <!-- Advanced Settings Toggle -->
      <details class="headers-details mt-3">
        <summary class="form-label">高级配置 (配额刷新、余额查询与自动纳管)</summary>
        <div class="form-grid mt-2">
          <div class="form-group">
            <label class="form-label">每日重置时间 (quota_reset_at)</label>
            <input class="input" id="ed_p_reset_${pId}" value="${escapeHtml(p.quota_reset_at || '00:00+08:00')}">
          </div>
          <div class="form-group">
            <label class="form-label">单 Key RPM 限制 (rpm_per_key)</label>
            <input class="input" id="ed_p_rpm_${pId}" type="number" value="${p.rpm_per_key || ''}" placeholder="不限">
          </div>
          <div class="form-group">
            <label class="form-label">自定义余额查询 URL (balance_url)</label>
            <input class="input input--code" id="ed_p_bal_url_${pId}" value="${escapeHtml(p.balance_url || '')}" placeholder="https://api.../user/balance">
          </div>
          <div class="form-group">
            <label class="form-label">余额提取 JSONPath (balance_path)</label>
            <input class="input input--code" id="ed_p_bal_path_${pId}" value="${escapeHtml(p.balance_path || '')}" placeholder="$.balance">
          </div>
        </div>
        <div class="section-bar mt-2 flex-end">
          <button class="btn btn--sm" id="btn_autolist_sync_${pId}" type="button">立即刷新并纳管模型</button>
        </div>
      </details>

      <div class="section-bar mt-4">
        <span class="form-label">API 密钥池 (${keys.length})</span>
        <div class="fields">
          <button class="btn btn--sm" id="btn_batch_test_keys_${pId}" type="button">一键测全部 Key</button>
          <button class="btn btn--sm" id="btn_oauth_start_${pId}" type="button" ${window.HOST.capabilities.oauthLogin ? '' : 'hidden'}>OAuth 扫码登录</button>
        </div>
      </div>

      <!-- OAuth inline prompt box -->
      <div class="snippet-box hidden mb-3" id="oauth_box_${pId}" hidden>
        <div class="snippet-header">
          <span class="form-label">MiniMax OAuth 设备授权码:</span>
          <span class="pill pill--amber" id="oauth_status_${pId}">等待扫码...</span>
        </div>
        <div class="text-sm mt-1">
          请点击访问：<a id="oauth_link_${pId}" href="#" target="_blank" class="tabular"></a>
          并在页面中输入验证码：<strong class="tabular" id="oauth_code_${pId}"></strong>
        </div>
      </div>

      <!-- Per-Key Table -->
      <div class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>启用</th>
                <th>标签</th>
                <th>Key 密文</th>
                <th>归属</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="p_keys_tbody_${pId}"></tbody>
          </table>
        </div>
      </div>

      <div class="form-grid mt-3">
        <div class="form-group">
          <input class="input" id="new_key_lbl_${pId}" placeholder="Key 标签 (如 pool-01)">
        </div>
        <div class="form-group">
          <input class="input input--code privacy-mask" id="new_key_val_${pId}" placeholder="粘贴完整 API Key">
        </div>
        <div class="form-group flex-end">
          <button class="btn" id="btn_add_key_${pId}" type="button">添加 Key</button>
        </div>
      </div>

      <!-- Model Probing & Pills Area -->
      <div class="section-bar mt-4">
        <span class="form-label">模型探测与一键纳管</span>
        <div class="fields">
          <button class="btn btn--sm" id="btn_check_balance_${pId}" type="button">查询余额</button>
          <button class="btn btn--sm" id="btn_probe_prov_${pId}" type="button">探测模型</button>
        </div>
      </div>
      <div id="probe_pills_container_${pId}" class="hidden" hidden>
        <div class="section-bar mt-1">
          <input class="input input--code flex-1 mr-2" id="probe_pills_filter_${pId}" placeholder="过滤探测到的模型...">
          <span class="text-muted text-xs" id="probe_pills_count_${pId}"></span>
        </div>
        <div class="probe-pills-wrap" id="probe_pills_list_${pId}"></div>
      </div>

      <div class="form-actions form-actions--split">
        <div class="form-actions-group">
          <button class="btn btn--danger" id="btn_del_prov_${pId}" type="button">删除此供应商</button>
        </div>
        <div class="form-actions-group">
          <button class="btn btn--primary" id="btn_save_prov_${pId}" type="button">保存供应商配置</button>
        </div>
      </div>
    `;

    const tbody = wrap.querySelector(`#p_keys_tbody_${pId}`);
    keys.forEach((k, idx) => {
      const tr = document.createElement('tr');
      const keyLabel = k.label || k.id || `key-${idx}`;
      const cooldownSec = state.cooldowns?.[`p:${pId}:k:${keyLabel}`] || 0;
      let statusHtml = cooldownSec > 0
        ? `<span class="pill pill--amber tabular">冷却中 ${formatCooldown(cooldownSec)}</span>`
        : '<span class="pill pill--green">就绪</span>';
      if (k.last_ok === true) {
        statusHtml = `<span class="pill pill--green tabular">正常 ${k.last_latency_ms || 0}ms</span>`;
      } else if (k.last_ok === false) {
        statusHtml = `<span class="pill pill--red">异常${k.last_status ? ` (${k.last_status})` : ''}</span>`;
      }

      tr.innerHTML = `
        <td><input type="checkbox" class="k_enable_cb" data-idx="${idx}" ${k.enabled !== false ? 'checked' : ''}></td>
        <td><strong>${escapeHtml(keyLabel)}</strong></td>
        <td><span class="tabular privacy-mask">${escapeHtml(maskKeyForDisplay(k.key))}</span></td>
        <td><span class="pill">${k.origin === 'local' ? '本地' : '共享'}</span></td>
        <td>${statusHtml}</td>
        <td>
          <div class="fields">
            <button class="btn btn--sm btn_verify_k" data-idx="${idx}" type="button">校验</button>
            <button class="btn btn--sm btn--danger btn_del_k" data-idx="${idx}" type="button">删除</button>
          </div>
        </td>
      `;

      tr.querySelector('.k_enable_cb').addEventListener('change', (e) => {
        if (!e.target.checked) {
          const refs = routesUsingKey(pId, keyLabel);
          if (refs.length > 0) {
            const ok = window.confirm(
              `Key [${keyLabel}] 正被以下路由引用：\n${refs.join('\n')}\n\n禁用后这些路由将没有可用 Key，请求可能返回 503。仍要禁用？`
            );
            if (!ok) {
              e.target.checked = true;
              return;
            }
          }
        }
        k.enabled = e.target.checked;
      });

      tr.querySelector('.btn_verify_k').addEventListener('click', async () => {
        const baseUrl = wrap.querySelector(`#ed_p_base_${pId}`)?.value.trim() || p.base_url || '';
        const keyLabel = k.label || k.id || `key-${idx}`;
        toast(`正在校验 Key [${keyLabel}]...`, 'info');
        try {
          const res = await window.HOST.verifyKey({
            provider: pId,
            api_key: k.key,
            key: k.key,
            key_label: keyLabel,
            base_url: baseUrl,
            api_type: p.api_type || 'openai-completions',
          });
          if (res && (res.ok || res.valid || res.latency_ms !== undefined)) {
            const lat = res.latency_ms ?? res.ms ?? 0;
            k.last_ok = true;
            k.last_latency_ms = lat;
            k.last_status = res.status || 200;
            toast(`Key [${keyLabel}] 校验成功: 延迟 ${lat}ms`, 'ok');
          } else {
            k.last_ok = false;
            k.last_status = res?.status || 0;
            toast(`Key [${keyLabel}] 校验失败: ${res?.error || '无效凭据'}`, 'err');
          }
          renderProvidersList();
          if (window.HOST.kind === 'hub') renderHubOverview();
        } catch (e) {
          toast(`校验异常: ${e.message}`, 'err');
        }
      });

      tr.querySelector('.btn_del_k').addEventListener('click', () => {
        const refs = routesUsingKey(pId, keyLabel);
        if (refs.length > 0) {
          const ok = window.confirm(
            `Key [${keyLabel}] 正被以下路由引用：\n${refs.join('\n')}\n\n删除后这些路由将没有可用 Key，请求可能返回 503。仍要删除？`
          );
          if (!ok) return;
        }
        p.api_keys.splice(idx, 1);
        renderProvidersList();
      });

      tbody.appendChild(tr);
    });

    // Check Balance (M2)
    wrap.querySelector(`#btn_check_balance_${pId}`).addEventListener('click', async () => {
      const baseUrl = wrap.querySelector(`#ed_p_base_${pId}`)?.value.trim() || p.base_url || '';
      const firstKey = p.api_keys?.[0]?.key || '';
      const balUrl = wrap.querySelector(`#ed_p_bal_url_${pId}`)?.value.trim() || p.balance_url || '';
      const balPath = wrap.querySelector(`#ed_p_bal_path_${pId}`)?.value.trim() || p.balance_path || '';

      toast(`正在查询供应商 ${pId} 余额...`, 'info');
      try {
        const res = await window.HOST.checkBalance({
          provider: pId,
          base_url: baseUrl,
          api_key: firstKey,
          balance_url: balUrl,
          balance_path: balPath,
        });
        if (res && (res.ok || res.balance !== undefined)) {
          const bal = res.formatted || res.balance || '正常可用';
          p._balance = String(bal);
          toast(`余额查询成功: ${bal}`, 'ok');
          renderProvidersList();
        } else {
          toast(`余额查询不可用: ${res?.error || '上游无余额接口'}`, 'warn');
        }
      } catch (e) {
        toast(`查询异常: ${e.message}`, 'err');
      }
    });

    // Batch Test All Keys (U2)
    wrap.querySelector(`#btn_batch_test_keys_${pId}`).addEventListener('click', async () => {
      toast(`正在一键测试 ${keys.length} 把 Key...`, 'info');
      let succ = 0;
      const baseUrl = wrap.querySelector(`#ed_p_base_${pId}`)?.value.trim() || p.base_url || '';
      for (const k of keys) {
        try {
          const r = await window.HOST.verifyKey({
            provider: pId,
            api_key: k.key,
            base_url: baseUrl,
            key_label: k.label,
          });
          if (r && (r.ok || r.valid)) succ++;
        } catch (_) {}
      }
      toast(`一键测试完成: ${succ}/${keys.length} 把 Key 正常可用`, succ === keys.length ? 'ok' : 'warn');
    });

    // OAuth Device Flow (U4)
    wrap.querySelector(`#btn_oauth_start_${pId}`).addEventListener('click', async () => {
      toast('正在发起 OAuth 设备登录请求...', 'info');
      try {
        const res = await window.HOST.startOAuth({ endpoint: 'https://api.minimax.chat/oauth/device/code' });
        if (res && (res.ok || res.device_code)) {
          const box = wrap.querySelector(`#oauth_box_${pId}`);
          box.hidden = false;
          box.classList.remove('hidden');
          const link = wrap.querySelector(`#oauth_link_${pId}`);
          link.href = res.verification_uri || 'https://api.minimax.chat';
          link.textContent = res.verification_uri || '前往授权页面';
          wrap.querySelector(`#oauth_code_${pId}`).textContent = res.user_code || res.device_code;

          // Poll OAuth
          const intervalSec = (res.interval || 5) * 1000;
          const pollTimer = setInterval(async () => {
            try {
              const pollRes = await window.HOST.pollOAuth({
                device_code: res.device_code,
                endpoint: 'https://api.minimax.chat/oauth/token',
              });
              if (pollRes && (pollRes.ok || pollRes.access_token)) {
                clearInterval(pollTimer);
                wrap.querySelector(`#oauth_status_${pId}`).textContent = '授权成功！';
                p.api_keys = p.api_keys || [];
                p.api_keys.push({
                  id: `k_oauth_${Date.now().toString(36)}`,
                  label: 'oauth-token',
                  key: pollRes.access_token,
                  enabled: true,
                  origin: 'local',
                });
                await persistConfig('OAuth 授权成功，密钥已保存');
              }
            } catch (_) {}
          }, intervalSec);
          setTimeout(() => clearInterval(pollTimer), (res.expires_in || 300) * 1000);
        } else {
          toast(res?.error || '发起 OAuth 失败', 'err');
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    // Probe Models and Clickable Pills (U2)
    wrap.querySelector(`#btn_probe_prov_${pId}`).addEventListener('click', async () => {
      const baseUrl = wrap.querySelector(`#ed_p_base_${pId}`)?.value.trim() || p.base_url || '';
      const firstKey = p.api_keys?.[0]?.key || '';
      toast(`正在探测供应商 ${pId} 模型...`, 'info');
      try {
        const res = await window.HOST.probeModels({
          provider: pId,
          base_url: baseUrl,
          api_key: firstKey,
          api_type: p.api_type || 'openai-completions',
        });
        const models = res?.models || [];
        if (models.length > 0) {
          toast(`探测成功: 发现 ${models.length} 个可用模型`, 'ok');
          const cont = wrap.querySelector(`#probe_pills_container_${pId}`);
          cont.hidden = false;
          cont.classList.remove('hidden');
          const list = wrap.querySelector(`#probe_pills_list_${pId}`);
          list.innerHTML = '';
          wrap.querySelector(`#probe_pills_count_${pId}`).textContent = `共 ${models.length} 个，点击一键纳管`;

          const renderPills = (filter = '') => {
            list.innerHTML = '';
            const filtered = models.filter((m) => m.toLowerCase().includes(filter.toLowerCase())).slice(0, 48);
            filtered.forEach((modelName) => {
              const pill = document.createElement('span');
              pill.className = 'probe-pill';
              pill.textContent = modelName;
              pill.title = `点击一键纳管 ${modelName} 到 Agent 路由`;
              pill.addEventListener('click', async () => {
                state.config.agent_models = state.config.agent_models || {};
                const firstKeyLabel = p.api_keys?.[0]?.label || 'k1';
                state.config.agent_models[modelName] = {
                  routing_strategy: 'sticky_failover',
                  active_key: '',
                  enabled: true,
                  candidates: [
                    { provider: pId, key_label: firstKeyLabel, target_model: modelName, enabled: true, weight: 1 },
                  ],
                };
                await persistConfig(`已成功纳管模型: ${modelName}`);
              });
              list.appendChild(pill);
            });
          };

          renderPills();
          wrap.querySelector(`#probe_pills_filter_${pId}`).addEventListener('input', (e) => {
            renderPills(e.target.value);
          });
        } else {
          toast('未探测到可用模型列表', 'warn');
        }
      } catch (e) {
        toast(`探测异常: ${e.message}`, 'err');
      }
    });

    // AutoList Sync
    wrap.querySelector(`#btn_autolist_sync_${pId}`).addEventListener('click', async () => {
      toast('正在同步模型列表并纳管...', 'info');
      try {
        const res = await window.HOST.syncAutoList({ provider: pId });
        if (res && res.ok) {
          toast('模型同步纳管成功！', 'ok');
          await loadData();
        } else {
          toast('已触发自动纳管请求', 'info');
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    wrap.querySelector(`#btn_add_key_${pId}`).addEventListener('click', () => {
      const lbl = wrap.querySelector(`#new_key_lbl_${pId}`).value.trim();
      const val = wrap.querySelector(`#new_key_val_${pId}`).value.trim();
      if (!lbl || !val) return toast('请填写 Key 标签和密钥内容', 'warn');
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
      p.quota_reset_at = wrap.querySelector(`#ed_p_reset_${pId}`).value.trim();
      const rpm = Number(wrap.querySelector(`#ed_p_rpm_${pId}`).value);
      if (rpm > 0) p.rpm_per_key = rpm;
      p.balance_url = wrap.querySelector(`#ed_p_bal_url_${pId}`).value.trim();
      p.balance_path = wrap.querySelector(`#ed_p_bal_path_${pId}`).value.trim();

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

  function parseScopeInput(rawStr) {
    const s = String(rawStr || '').trim();
    if (!s || s === '*') return ['*'];
    if (s === '[]' || s.toLowerCase() === 'none') return [];
    return s.split(',').map((item) => item.trim()).filter(Boolean);
  }

  function formatScopeInput(arr) {
    if (!Array.isArray(arr)) return '*';
    if (arr.length === 0) return '[]';
    return arr.join(', ');
  }

  // --- View: Extension Services / Search Providers & Selection (Hub mode) ---
  function isUsableSharedSearchProvider(sp) {
    if (!sp || sp.enabled === false || sp.origin === 'local') return false;
    return Array.isArray(sp.api_keys) && sp.api_keys.some((k) => k && k.enabled !== false && String(k.key || '').trim());
  }

  function renderSearchView() {
    renderExtensionServices();
    renderMcpAccessCard();
    renderSearchSelectionCard();
    renderSearchProvidersList();
  }

  function renderExtensionServices() {
    const el = document.getElementById('extServicesList');
    if (!el) return;
    if (state.extServiceProto && state.extServiceProto !== 'all' && state.extServiceProto !== 'mcp') {
      el.innerHTML = '<div class="row row--static text-muted">暂无该协议服务</div>';
      return;
    }
    const spEntries = Object.entries(state.config?.search_providers || {});
    const searchCnt = spEntries.filter(([, sp]) => sp?.capabilities?.includes('search')).length;
    const fetchCnt = spEntries.filter(([, sp]) => sp?.capabilities?.includes('fetch')).length;
    const usable = spEntries.filter(([, sp]) => isUsableSharedSearchProvider(sp)).length;
    const mcpNodes = getMcpNodes();
    const activeCnt = mcpNodes.filter((n) => n.enabled !== false).length;

    el.innerHTML = `<div class="row row--static"><span class="dot ${usable > 0 ? 'dot--ok' : 'dot--warn'}"></span><div class="who"><div class="name"><span>网络搜索 (khc-search)</span><span class="pill pill--accent">MCP</span><span class="pill ${usable > 0 ? 'pill--green' : 'pill--amber'}">${usable > 0 ? `${usable} 共享就绪` : '待配上游'}</span><span class="pill tabular">v${state.config?._version || 1}</span><span class="pill">${activeCnt} 节点${mcpNodes.some((n) => n.mcp_url) ? '' : ' · 未填地址'}</span></div><div class="sub">集中配置搜索/抓取上游与策略；MCP 节点单向拉取并在本地运行（支持 Playwright 兜底）。</div></div><div class="fields"><span class="pill tabular">Search ${searchCnt} · Fetch ${fetchCnt}</span><button class="btn btn--sm" id="btnExtGoNodes" type="button">节点地址</button></div></div>`;
    el.querySelector('#btnExtGoNodes')?.addEventListener('click', () => switchTab('nodes'));
  }

  function renderMcpAccessCard() {
    const card = document.getElementById('mcpAccessCard');
    if (!card) return;
    const mcpNodes = getMcpNodes();
    if (!state.selectedMcpNodeId || !mcpNodes.some((n) => n.id === state.selectedMcpNodeId)) {
      const pref = mcpNodes.find((n) => n.enabled !== false && n.mcp_url) || mcpNodes.find((n) => n.enabled !== false) || mcpNodes[0];
      state.selectedMcpNodeId = pref ? pref.id : '';
    }
    const node = mcpNodes.find((n) => n.id === state.selectedMcpNodeId) || null;
    const mcpUrl = (node?.mcp_url || '').trim();
    const snap = node ? getNodeSyncSnapshotStatus(node) : null;
    const snippet = JSON.stringify({ mcpServers: { 'khc-search': { type: 'http', url: mcpUrl || 'https://<your-space>.hf.space/mcp', headers: { Authorization: 'Bearer <MCP_BEARER_TOKEN>' } } } }, null, 2);
    const opts = mcpNodes.length
      ? mcpNodes.map((n) => `<option value="${escapeHtml(n.id)}" ${n.id === state.selectedMcpNodeId ? 'selected' : ''}>${escapeHtml(n.name || n.id)}${n.mcp_url ? ` (${escapeHtml(n.mcp_url)})` : ' (未设地址)'}</option>`).join('')
      : '<option value="">暂无 MCP 节点</option>';
    const notice = !node
      ? '<div class="notice-strip notice-strip--warn mb-3"><span>未检测到 MCP 节点，请先在「中转节点」签发节点。</span><button class="btn btn--sm" id="btnMcpAccessGoNodes" type="button">前往中转节点</button></div>'
      : !mcpUrl
        ? `<div class="notice-strip notice-strip--warn mb-3"><span>节点 <strong>${escapeHtml(node.name || node.id)}</strong> 未配置服务地址，请在中转节点填写 <code>mcp_url</code>。</span><button class="btn btn--sm" id="btnMcpAccessGoNodes" type="button">去配置</button></div>`
        : `<div class="notice-strip notice-strip--ok mb-3"><span>${escapeHtml(node.name || node.id)} · 快照：${escapeHtml(snap.label)}（${escapeHtml(snap.leaseText)}）</span></div>`;

    card.innerHTML = `<div class="card-header"><div><h2 class="card-title">MCP 接入信息</h2><div class="card-sub">客户端 Bearer 令牌与 NODE_TOKEN 独立</div></div><div class="fields"><select class="select" id="mcpAccessNodeSelect">${opts}</select></div></div>${notice}<div class="form-grid form-grid--2"><div class="form-group"><label class="form-label">服务地址 (mcp_url)</label><div class="input-row"><input class="input input--code" readonly value="${escapeHtml(mcpUrl || '未配置服务地址')}"><button class="btn" id="btnCopyMcpUrl" type="button">复制</button></div></div><div class="form-group"><label class="form-label">暴露的工具</label><div class="check-group mt-1">${['khc_research', 'khc_search', 'khc_fetch', 'khc_crawl_site'].map((t) => `<span class="pill pill--accent">${t}</span>`).join('')}</div></div></div><div class="snippet-card mt-3"><div class="code-snippet-head"><label class="form-label">客户端配置示例 (mcpServers)</label><button class="btn btn--sm" id="btnCopyMcpSnippet" type="button">复制</button></div><pre class="code-pre">${escapeHtml(snippet)}</pre></div>`;

    card.querySelector('#mcpAccessNodeSelect')?.addEventListener('change', (e) => { state.selectedMcpNodeId = e.target.value; renderMcpAccessCard(); });
    card.querySelector('#btnMcpAccessGoNodes')?.addEventListener('click', () => switchTab('nodes'));
    card.querySelector('#btnCopyMcpUrl')?.addEventListener('click', () => (mcpUrl ? copyToClipboard(mcpUrl, 'MCP 地址已复制') : toast('尚未配置 mcp_url', 'warn')));
    card.querySelector('#btnCopyMcpSnippet')?.addEventListener('click', () => copyToClipboard(snippet, 'MCP 配置已复制'));
  }

  function renderSearchSelectionCard() {
    const searchGroup = document.getElementById('searchSelectionSearchGroup');
    const fetchGroup = document.getElementById('searchSelectionFetchGroup');
    const summaryEl = document.getElementById('searchSelectionSummary');
    const alertsEl = document.getElementById('searchSelectionAlerts');
    if (!searchGroup || !fetchGroup) return;

    const spMap = state.config?.search_providers || {}, sel = state.config?.search_selection || { search: [], fetch: '' };
    const selectedSearchIds = Array.isArray(sel.search) ? sel.search : [], selectedSearch = new Set(selectedSearchIds);
    const selectedFetch = typeof sel.fetch === 'string' ? sel.fetch : '';
    const entries = Object.entries(spMap).sort(([a], [b]) => a.localeCompare(b));
    const searchCap = entries.filter(([, sp]) => sp?.capabilities?.includes('search'));
    const fetchCap = entries.filter(([, sp]) => sp?.capabilities?.includes('fetch'));
    const usableSel = selectedSearchIds.filter((id) => isUsableSharedSearchProvider(spMap[id]));
    const fetchUsable = selectedFetch && isUsableSharedSearchProvider(spMap[selectedFetch]);

    if (summaryEl) summaryEl.textContent = `已选 Search: ${selectedSearch.size} (共享可用 ${usableSel.length}) · Fetch: ${selectedFetch ? (spMap[selectedFetch]?.name || selectedFetch) : '无'}`;

    const suffixOf = (sp) => (sp.enabled === false ? ' (停用)' : (sp.origin === 'local' ? ' (本地)' : (!(sp.api_keys || []).some((k) => k.enabled !== false) ? ' (无Key)' : '')));
    searchGroup.innerHTML = '';
    if (!searchCap.length) searchGroup.innerHTML = '<span class="text-xs text-muted">暂无 search 提供商</span>';
    else for (const [spId, sp] of searchCap) {
      const lbl = document.createElement('label');
      lbl.className = 'check-chip';
      lbl.innerHTML = `<input type="checkbox" value="${escapeHtml(spId)}" ${selectedSearch.has(spId) ? 'checked' : ''}><span>${escapeHtml((sp.name || spId) + suffixOf(sp))}</span>`;
      searchGroup.appendChild(lbl);
    }

    fetchGroup.innerHTML = `<label class="check-chip"><input type="radio" name="searchSelectionFetch" value="" ${!selectedFetch ? 'checked' : ''}><span>不启用（本地兜底）</span></label>`;
    for (const [spId, sp] of fetchCap) {
      const lbl = document.createElement('label');
      lbl.className = 'check-chip';
      lbl.innerHTML = `<input type="radio" name="searchSelectionFetch" value="${escapeHtml(spId)}" ${selectedFetch === spId ? 'checked' : ''}><span>${escapeHtml((sp.name || spId) + suffixOf(sp))}</span>`;
      fetchGroup.appendChild(lbl);
    }

    if (alertsEl) {
      const notices = [usableSel.length
        ? `<div class="notice-strip notice-strip--ok"><span>网页搜索就绪：${escapeHtml(usableSel.join(', '))}</span></div>`
        : '<div class="notice-strip notice-strip--warn"><span>无可用共享 Search 提供商，khc_search 将无可用上游。</span></div>'];
      if (!fetchUsable) notices.push('<div class="notice-strip notice-strip--warn mt-2"><span>未选择抓取提供商，khc_fetch 将走节点本地兜底。</span></div>');
      alertsEl.innerHTML = notices.join('');
    }
  }

  function renderSearchProvidersList() {
    const container = document.getElementById('searchProvidersList');
    if (!container) return;
    container.innerHTML = '';

    const spMap = state.config?.search_providers || {}, sel = state.config?.search_selection || { search: [], fetch: '' };
    const selectedSearch = new Set(Array.isArray(sel.search) ? sel.search : []), q = state.searchQuery || '';
    const ids = Object.keys(spMap).sort().filter((spId) => !q || `${spId} ${spMap[spId]?.name || ''} ${spMap[spId]?.adapter || ''} ${spMap[spId]?.base_url || ''}`.toLowerCase().includes(q));

    if (!ids.length) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'row row--static text-muted';
      emptyRow.textContent = q ? '没有匹配的搜索提供商' : '暂无搜索提供商，请点击右上角「添加搜索提供商」';
      container.appendChild(emptyRow);
      return;
    }

    for (const spId of ids) {
      const sp = spMap[spId] || {}, health = computeSearchProviderHealth(sp), isLocal = sp.origin === 'local', isExpanded = state.activeEditorKey === `sp_${spId}`, caps = Array.isArray(sp.capabilities) ? sp.capabilities : [];
      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;
      row.innerHTML = `<span class="dot ${health.dotCls}"></span><div class="who"><div class="name"><span>${escapeHtml(sp.name || spId)}</span><span class="pill">${escapeHtml(spId)}</span><span class="${health.pillCls}">${escapeHtml(health.statusText)}</span><span class="pill ${isLocal ? 'pill--amber' : 'pill--green'}">${isLocal ? '本地私有，不下发节点' : '共享下发'}</span>${caps.map((c) => `<span class="pill pill--accent">${escapeHtml(c)}</span>`).join('')}${selectedSearch.has(spId) ? '<span class="pill pill--green">Search 已选</span>' : ''}${sel.fetch === spId ? '<span class="pill pill--green">Fetch 已选</span>' : ''}</div><div class="sub">${escapeHtml(sp.adapter ? `适配器: ${sp.adapter}` : '声明式 HTTP')} · ${escapeHtml(sp.base_url || '未设 Base URL')} · ${sp.timeout_ms || 15000}ms</div></div><div class="fields">${health.totalCount ? `<span class="pill tabular">启用 ${health.enabledCount} / 总 ${health.totalCount} 把 Key</span>` : '<span class="pill">未配置密钥（不会下发给节点）</span>'}${health.latestCheckedAt ? `<span class="pill tabular">探活 ${escapeHtml(formatTime(health.latestCheckedAt))}${health.latestLatencyMs !== null ? ` · ${health.latestLatencyMs}ms` : ''}</span>` : ''}<span class="caret">▾</span></div>`;
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `sp_${spId}`;
        renderSearchProvidersList();
      });

      container.appendChild(row);
      if (isExpanded) {
        const editor = document.createElement('div');
        editor.className = 'editor';
        editor.appendChild(buildSearchProviderEditor(spId, sp));
        container.appendChild(editor);
      }
    }
  }

  function buildSearchProviderEditor(spId, sp) {
    const wrap = document.createElement('div');
    const keys = sp.api_keys || [];
    const caps = Array.isArray(sp.capabilities) ? sp.capabilities : [];
    const fmtJson = (obj) => (obj ? JSON.stringify(obj, null, 2) : '');

    wrap.innerHTML = `<div class="form-grid"><div class="form-group"><label class="form-label">显示名称</label><input class="input" id="ed_sp_name_${spId}" value="${escapeHtml(sp.name || spId)}"></div><div class="form-group"><label class="form-label">作用域 (origin)</label><select class="select" id="ed_sp_origin_${spId}"><option value="vault" ${sp.origin !== 'local' ? 'selected' : ''}>vault (共享下发)</option><option value="local" ${sp.origin === 'local' ? 'selected' : ''}>local (仅本中枢留存)</option></select></div><div class="form-group"><label class="form-label">适配器 adapter (可选)</label><input class="input input--code" id="ed_sp_adapter_${spId}" value="${escapeHtml(sp.adapter || '')}"></div><div class="form-group"><label class="form-label">超时 ms (timeout_ms)</label><input class="input tabular" id="ed_sp_timeout_${spId}" type="number" value="${sp.timeout_ms || 15000}"></div><div class="form-group form-group--span2"><label class="form-label">Base URL (可选)</label><input class="input input--code" id="ed_sp_base_${spId}" value="${escapeHtml(sp.base_url || '')}"></div><div class="form-group"><label class="form-label">启用与能力</label><div class="check-group"><label class="check-chip"><input type="checkbox" id="ed_sp_enabled_${spId}" ${sp.enabled !== false ? 'checked' : ''}> 启用</label><label class="check-chip"><input type="checkbox" id="ed_sp_cap_search_${spId}" ${caps.includes('search') ? 'checked' : ''}> search</label><label class="check-chip"><input type="checkbox" id="ed_sp_cap_fetch_${spId}" ${caps.includes('fetch') ? 'checked' : ''}> fetch</label></div></div></div><details class="headers-details mt-3"><summary class="form-label">声明式请求 / 响应映射与 Quirks (JSON)</summary><div class="form-grid form-grid--2 mt-2">${[['req', 'request', sp.request], ['resp', 'response', sp.response], ['fetch', 'fetch', sp.fetch], ['quirks', 'quirks', sp.quirks]].map(([kId, lbl, val]) => `<div class="form-group"><label class="form-label">${lbl} (JSON)</label><textarea class="textarea textarea--json" id="ed_sp_${kId}_${spId}">${escapeHtml(fmtJson(val))}</textarea></div>`).join('')}</div></details><div class="section-bar mt-4"><span class="form-label">API 密钥池 (${keys.length} 把 Key)</span><div class="fields"><button class="btn btn--sm" id="btn_verify_all_sp_keys_${spId}" type="button">一键测 Key</button><button class="btn btn--sm" id="btn_clear_sp_keys_${spId}" type="button">清除全部密钥</button></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>启用</th><th>标签</th><th>密钥 (脱敏)</th><th>来源</th><th>状态</th><th>操作</th></tr></thead><tbody id="sp_keys_tbody_${spId}"></tbody></table></div><div class="form-grid mt-3"><div class="form-group"><input class="input" id="new_sp_key_lbl_${spId}" placeholder="Key 标签 (如 k1)"></div><div class="form-group"><input class="input input--code privacy-mask" id="new_sp_key_val_${spId}" placeholder="粘贴完整 API Key"></div><div class="form-group flex-end"><button class="btn" id="btn_add_sp_key_${spId}" type="button">添加 Key</button></div></div><div class="form-actions form-actions--split"><div class="form-actions-group"><button class="btn btn--danger" id="btn_del_sp_${spId}" type="button">删除提供商</button></div><div class="form-actions-group"><button class="btn btn--primary" id="btn_save_sp_${spId}" type="button">保存搜索提供商</button></div></div>`;

    function buildSearchVerifyPayload(k, idx) {
      const adapterVal = wrap.querySelector(`#ed_sp_adapter_${spId}`)?.value.trim() || sp.adapter || '';
      const baseVal = wrap.querySelector(`#ed_sp_base_${spId}`)?.value.trim() || sp.base_url || '';
      const payload = {
        provider: spId,
        key_label: k.label || k.id || `key-${idx}`,
        api_key: k.key,
        adapter: adapterVal,
        base_url: baseVal,
      };
      try {
        const reqDraft = parseOptionalJsonField(wrap.querySelector(`#ed_sp_req_${spId}`)?.value, 'request');
      if (reqDraft) payload.request = reqDraft;
      const fetchDraft = parseOptionalJsonField(wrap.querySelector(`#ed_sp_fetch_${spId}`)?.value, 'fetch');
      if (fetchDraft) payload.fetch = fetchDraft;
    } catch (_) {}
    return payload;
    }

    async function runSearchKeyVerify(k, idx) {
      try {
        const res = await window.HOST.verifySearchKey(buildSearchVerifyPayload(k, idx));
        k.last_checked_at = new Date().toISOString();
        k.last_latency_ms = res?.latency_ms || 0;
        k.last_ok = Boolean(res && res.valid === true);
        k.last_status = res?.status || (k.last_ok ? 200 : 0);
        k.last_error = k.last_ok ? '' : scrubUiText(res?.error || '无效凭据', [k.key]);
        return k.last_ok;
      } catch (e) {
        k.last_checked_at = new Date().toISOString();
        k.last_ok = false;
        k.last_error = scrubUiText(e?.message || '校验异常', [k.key]);
        return false;
      }
    }

    const tbody = wrap.querySelector(`#sp_keys_tbody_${spId}`);
    if (keys.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted">未配置密钥（不会下发给节点）</td></tr>';
    } else {
      keys.forEach((k, idx) => {
        const keyLabel = k.label || k.id || `key-${idx}`;
        let stHtml = '<span class="pill">未校验</span>';
        if (k.last_ok === true) {
          stHtml = `<span class="pill pill--green">正常 ${k.last_latency_ms || 0}ms</span>`;
        } else if (k.last_ok === false) {
          const errSub = k.last_error ? `<div class="text-xs text-muted mt-1">${escapeHtml(scrubUiText(k.last_error, [k.key]))}</div>` : '';
          stHtml = `<span class="pill pill--red">异常${k.last_status ? ` (${k.last_status})` : ''}${k.last_latency_ms ? ` · ${k.last_latency_ms}ms` : ''}</span>${errSub}`;
        }
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><input type="checkbox" class="sp_k_enable_cb" ${k.enabled !== false ? 'checked' : ''}></td><td><strong>${escapeHtml(keyLabel)}</strong></td><td><span class="tabular privacy-mask">${escapeHtml(maskKeyForDisplay(k.key))}</span></td><td><span class="pill">${k.origin === 'local' ? '本地' : '共享'}</span></td><td>${stHtml}</td><td><div class="fields"><button class="btn btn--sm sp_btn_verify_k" type="button">${k.last_ok === false ? '重新校验' : '校验'}</button><button class="btn btn--sm btn--danger sp_btn_del_k" type="button">删除</button></div></td>`;
        tr.querySelector('.sp_k_enable_cb').addEventListener('change', (e) => { k.enabled = e.target.checked; });
        tr.querySelector('.sp_btn_verify_k').addEventListener('click', async () => {
          toast(`正在校验 [${keyLabel}]...`, 'info');
          const ok = await runSearchKeyVerify(k, idx);
          toast(ok ? `Key [${keyLabel}] 正常 (${k.last_latency_ms}ms)` : `Key [${keyLabel}] 失败: ${k.last_error}`, ok ? 'ok' : 'err');
          renderSearchProvidersList();
        });
        tr.querySelector('.sp_btn_del_k').addEventListener('click', () => { sp.api_keys.splice(idx, 1); renderSearchProvidersList(); });
        tbody.appendChild(tr);
      });
    }

    wrap.querySelector(`#btn_verify_all_sp_keys_${spId}`)?.addEventListener('click', async () => {
      if (!keys.length) return toast('暂无密钥可校验', 'warn');
      toast(`正在校验 ${keys.length} 把 Key...`, 'info');
      let succ = 0;
      for (let i = 0; i < keys.length; i++) if (await runSearchKeyVerify(keys[i], i)) succ++;
      renderSearchProvidersList();
      toast(`校验完成: ${succ}/${keys.length} 可用`, succ === keys.length ? 'ok' : 'warn');
    });

    wrap.querySelector(`#btn_add_sp_key_${spId}`).addEventListener('click', () => {
      const lbl = wrap.querySelector(`#new_sp_key_lbl_${spId}`).value.trim();
      const val = wrap.querySelector(`#new_sp_key_val_${spId}`).value.trim();
      if (!lbl || !val) return toast('请填写 Key 标签和密钥内容', 'warn');
      sp.api_keys = sp.api_keys || [];
      sp.api_keys.push({
        id: `k_${Date.now().toString(36)}`,
        label: lbl,
        key: val,
        enabled: true,
        origin: wrap.querySelector(`#ed_sp_origin_${spId}`)?.value || sp.origin || 'vault',
      });
      renderSearchProvidersList();
    });

    wrap.querySelector(`#btn_clear_sp_keys_${spId}`).addEventListener('click', () => {
      sp.api_keys = [];
      renderSearchProvidersList();
      toast('已清空密钥列表，点击「保存搜索提供商」生效', 'info');
    });

    wrap.querySelector(`#btn_save_sp_${spId}`).addEventListener('click', async () => {
      const nextName = wrap.querySelector(`#ed_sp_name_${spId}`).value.trim();
      const nextBaseUrl = wrap.querySelector(`#ed_sp_base_${spId}`).value.trim();
      const nextCaps = [];
      if (wrap.querySelector(`#ed_sp_cap_search_${spId}`)?.checked) nextCaps.push('search');
      if (wrap.querySelector(`#ed_sp_cap_fetch_${spId}`)?.checked) nextCaps.push('fetch');
      const adapter = wrap.querySelector(`#ed_sp_adapter_${spId}`)?.value.trim() || '';
      const v = validateSearchSpec({
        name: nextName,
        baseUrl: nextBaseUrl,
        timeoutRaw: wrap.querySelector(`#ed_sp_timeout_${spId}`).value,
        caps: nextCaps,
        adapter,
        reqRaw: wrap.querySelector(`#ed_sp_req_${spId}`)?.value,
        respRaw: wrap.querySelector(`#ed_sp_resp_${spId}`)?.value,
        fetchRaw: wrap.querySelector(`#ed_sp_fetch_${spId}`)?.value,
        quirksRaw: wrap.querySelector(`#ed_sp_quirks_${spId}`)?.value,
      });
      if (v.error) return toast(v.error, 'warn');

      sp.name = nextName;
      sp.origin = wrap.querySelector(`#ed_sp_origin_${spId}`).value || 'vault';
      sp.enabled = Boolean(wrap.querySelector(`#ed_sp_enabled_${spId}`)?.checked);
      sp.capabilities = nextCaps;
      sp.base_url = nextBaseUrl;
      sp.timeout_ms = v.timeoutMs;
      if (adapter) sp.adapter = adapter; else delete sp.adapter;
      if (v.reqObj) sp.request = v.reqObj; else delete sp.request;
      if (v.respObj) sp.response = v.respObj; else delete sp.response;
      if (v.fetchObj) sp.fetch = v.fetchObj; else delete sp.fetch;
      if (v.quirksObj) sp.quirks = v.quirksObj; else delete sp.quirks;

      await persistConfig('搜索提供商配置已保存');
    });

    wrap.querySelector(`#btn_del_sp_${spId}`).addEventListener('click', async () => {
      if (!confirm(`确定删除搜索提供商 ${spId} 吗？`)) return;
      delete state.config.search_providers[spId];
      if (state.config.search_selection) {
        if (Array.isArray(state.config.search_selection.search)) {
          state.config.search_selection.search = state.config.search_selection.search.filter((id) => id !== spId);
        }
        if (state.config.search_selection.fetch === spId) {
          state.config.search_selection.fetch = '';
        }
      }
      state.activeEditorKey = null;
      await persistConfig('搜索提供商已删除');
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
      const modelsScope = formatScopeInput(node.scope?.models);
      const provsScope = formatScopeInput(node.scope?.providers);
      const searchScope = formatScopeInput(node.scope?.search_providers);
      const snap = getNodeSyncSnapshotStatus(node);
      const mcpSub = node.mcp_url ? ` · MCP: ${node.mcp_url}` : '';
      who.innerHTML = `
        <div class="name">
          <span>${escapeHtml(node.name || node.id)}</span>
          <span class="pill pill--accent">${escapeHtml(node.role)}</span>
          <span class="pill ${snap.pillCls}">${escapeHtml(snap.label)}</span>
        </div>
        <div class="sub">模型: ${escapeHtml(modelsScope)} · 供应商: ${escapeHtml(provsScope)} · 搜索: ${escapeHtml(searchScope)}${escapeHtml(mcpSub)} · Token: ${escapeHtml(node.token_prefix)}</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill">${snap.syncMs ? '同步: ' + formatTime(snap.syncMs) : '从未同步'} · ${escapeHtml(snap.leaseText)}</span>
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

    wrap.innerHTML = `<div class="form-grid"><div class="form-group"><label class="form-label">节点名称</label><input class="input" id="ed_node_name_${node.id}" value="${escapeHtml(node.name)}"></div><div class="form-group"><label class="form-label">租约时长 (秒)</label><input class="input tabular" id="ed_node_ttl_${node.id}" type="number" value="${node.lease_ttl || 86400}"></div><div class="form-group"><label class="form-label">允许供应商 (* 全量, [] 无)</label><input class="input input--code" id="ed_node_provs_${node.id}" value="${escapeHtml(formatScopeInput(node.scope?.providers))}"></div><div class="form-group"><label class="form-label">允许模型 (* 全量, [] 无)</label><input class="input input--code" id="ed_node_models_${node.id}" value="${escapeHtml(formatScopeInput(node.scope?.models))}"></div><div class="form-group"><label class="form-label">允许搜索 (* 全量, [] 无)</label><input class="input input--code" id="ed_node_search_provs_${node.id}" value="${escapeHtml(formatScopeInput(node.scope?.search_providers))}"></div><div class="form-group form-group--span2"><label class="form-label">MCP 接入地址 mcp_url (可选)</label><input class="input input--code" id="ed_node_mcp_url_${node.id}" value="${escapeHtml(node.mcp_url || '')}" placeholder="https://your-space.hf.space/mcp"></div></div><div class="form-actions form-actions--split"><div class="form-actions-group"><button class="btn btn--danger" id="btn_del_node_${node.id}" type="button">删除节点</button><button class="btn ${isEnabled ? 'btn--danger' : ''}" id="btn_toggle_node_${node.id}" type="button">${isEnabled ? '吊销/停用' : '恢复启用'}</button><button class="btn" id="btn_rotate_node_${node.id}" type="button">轮换 Token</button></div><div class="form-actions-group"><button class="btn btn--primary" id="btn_save_node_${node.id}" type="button">保存节点</button></div></div><div class="editor-section" id="node_token_display_box_${node.id}" hidden><div class="form-grid form-grid--2"><div class="form-group"><label class="form-label">新 NODE_TOKEN (仅显示一次)</label><input class="input input--code" readonly id="node_new_token_val_${node.id}"></div><div class="form-group"><label class="form-label">启动环境变量</label><input class="input input--code" readonly id="node_new_env_val_${node.id}"></div></div></div>`;

    wrap.querySelector(`#btn_save_node_${node.id}`).addEventListener('click', async () => {
      const name = wrap.querySelector(`#ed_node_name_${node.id}`).value.trim();
      const leaseTtl = Number(wrap.querySelector(`#ed_node_ttl_${node.id}`).value) || 86400;
      const provsStr = wrap.querySelector(`#ed_node_provs_${node.id}`).value;
      const modelsStr = wrap.querySelector(`#ed_node_models_${node.id}`).value;
      const searchProvsStr = wrap.querySelector(`#ed_node_search_provs_${node.id}`).value;
      const mcpUrl = (wrap.querySelector(`#ed_node_mcp_url_${node.id}`)?.value || '').trim();
      if (!isValidOptionalHttpUrl(mcpUrl)) {
        return toast('mcp_url 必须是合法的 http:// 或 https:// URL（不含凭据）', 'warn');
      }

      const scope = {
        providers: parseScopeInput(provsStr),
        models: parseScopeInput(modelsStr),
        search_providers: parseScopeInput(searchProvsStr),
      };

      try {
        const res = await window.HOST.patchNode(node.id, { name, lease_ttl: leaseTtl, scope, mcp_url: mcpUrl });
        if (res && res.ok) {
          toast('节点配置更新成功', 'ok');
          await loadNodesData();
        } else {
          toast(res.error || '更新失败', 'err');
        }
      } catch (e) {
        toast(scrubUiText(e.message), 'err');
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
    const provsRaw = document.getElementById('issueNodeProvs')?.value;
    const modelsRaw = document.getElementById('issueNodeModels')?.value;
    const searchProvsRaw = document.getElementById('issueNodeSearchProvs')?.value;
    const mcpUrl = (document.getElementById('issueNodeMcpUrl')?.value || '').trim();

    if (!name) return toast('请输入节点名称', 'warn');
    if (!isValidOptionalHttpUrl(mcpUrl)) return toast('mcp_url 必须是合法的 http:// 或 https:// URL（不含凭据）', 'warn');

    const scope = {
      providers: parseScopeInput(provsRaw),
      models: parseScopeInput(modelsRaw),
      search_providers: parseScopeInput(searchProvsRaw),
    };

    try {
      const payload = { name, role, lease_ttl: leaseTtl, scope };
      if (mcpUrl) payload.mcp_url = mcpUrl;
      const res = await window.HOST.issueNode(payload);
      if (res && res.ok) {
        toast('节点签发成功！', 'ok');
        const mcpEl = document.getElementById('issueNodeMcpUrl');
        if (mcpEl) mcpEl.value = '';
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

  // --- View: Models & KB Pipeline Visual Editor (U1, U5, M16) ---
  function renderModelsList() {
    const container = document.getElementById('modelsList');
    if (!container) return;
    container.innerHTML = '';

    const isAgent = (state.modelSubMode || 'agent') === 'agent';
    const btnAddModel = document.getElementById('btnAddModel');
    if (btnAddModel) {
      btnAddModel.hidden = !isAgent;
      btnAddModel.classList.toggle('hidden', !isAgent);
    }
    if (isAgent) {
      renderAgentModels(container);
    } else {
      renderKBPipelines(container);
    }
  }

  function renderAgentModels(container) {
    const models = state.config?.agent_models || {};
    const q = state.modelQuery || '';
    const mKeys = Object.keys(models).sort().filter((mName) => {
      if (!q) return true;
      const m = models[mName] || {};
      const cands = (m.candidates || []).map((c) => `${c.provider} ${c.target_model}`).join(' ');
      return `${mName} ${cands}`.toLowerCase().includes(q);
    });

    if (mKeys.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'row row--static text-muted';
      emptyRow.textContent = q ? '没有匹配的模型路由' : '暂无已配置模型路由，请点击右上角「添加模型」';
      container.appendChild(emptyRow);
      return;
    }

    for (const mName of mKeys) {
      const m = models[mName] || {};
      const cCount = (m.candidates || []).length;
      const isExpanded = state.activeEditorKey === `m_${mName}`;
      const brandIcon = window.renderBrandIcon ? window.renderBrandIcon(mName) : '';

      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = document.createElement('span');
      dot.className = `dot ${m.enabled && cCount > 0 ? 'dot--ok' : 'dot--err'}`;

      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          ${brandIcon}
          <span>${escapeHtml(mName)}</span>
          <span class="pill pill--accent">${escapeHtml(m.routing_strategy || 'sticky_failover')}</span>
          ${m._lastTestLatency ? `<span class="pill pill--green">${m._lastTestLatency}ms</span>` : ''}
        </div>
        <div class="sub">首选 Key: ${escapeHtml(m.active_key || '未指定')} · 候选池: ${cCount} 个</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <button class="btn btn--sm btn_test_agent_m" data-model="${escapeHtml(mName)}" type="button">测试路由</button>
        <span class="pill">${cCount} 候选</span>
        <span class="caret">▾</span>
      `;

      // Agent Model Route Test Button (U5)
      fields.querySelector('.btn_test_agent_m').addEventListener('click', async (e) => {
        e.stopPropagation();
        toast(`正在测试模型 ${mName} 路由...`, 'info');
        try {
          const res = await window.HOST.testAgentModel({ model: mName });
          if (res && res.ok) {
            const lat = res.latency_ms || res.ms || 0;
            m._lastTestLatency = lat;
            toast(`测试通过！耗时: ${lat}ms (优胜: ${res.winner_provider || '直连'})`, 'ok');
            renderAgentModels(container);
          } else {
            toast(`测试失败: ${res?.error || '路由无响应'}`, 'err');
          }
        } catch (err) {
          toast(`测试异常: ${err.message}`, 'err');
        }
      });

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
      <div class="form-grid form-grid--2">
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

      <div class="card">
        <div class="table-wrap">
          <table class="data-table">
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
        </div>
      </div>

      <div class="form-grid mt-3">
        <div class="form-group">
          <input class="input" id="new_c_prov_${mName}" placeholder="供应商 ID (如 minimax)">
        </div>
        <div class="form-group">
          <input class="input" id="new_c_lbl_${mName}" placeholder="Key 标签 (如 pool-01)">
        </div>
        <div class="form-group">
          <input class="input" id="new_c_target_${mName}" placeholder="上游真实模型 (留空同名)">
        </div>
      </div>
      <div class="section-bar mt-2 flex-end">
        <button class="btn" id="btn_add_cand_${mName}" type="button">添加候选</button>
      </div>

      <div class="form-actions form-actions--split">
        <div class="form-actions-group">
          <button class="btn btn--danger" id="btn_del_model_${mName}" type="button">删除此模型</button>
        </div>
        <div class="form-actions-group">
          <button class="btn btn--primary" id="btn_save_model_${mName}" type="button">保存模型配置</button>
        </div>
      </div>
    `;

    const tbody = wrap.querySelector(`#m_cands_tbody_${mName}`);
    candidates.forEach((c, idx) => {
      const tr = document.createElement('tr');
      const brandIco = window.renderBrandIcon ? window.renderBrandIcon(c.provider) : '';
      tr.innerHTML = `
        <td>${brandIco}<strong>${escapeHtml(c.provider)}</strong></td>
        <td><span class="pill">${escapeHtml(c.key_label)}</span></td>
        <td><span class="tabular">${escapeHtml(c.target_model || '原名')}</span></td>
        <td><span class="tabular">${c.weight || 1}</span></td>
        <td>
          <button class="btn btn--sm btn--danger btn_del_cand" data-idx="${idx}" type="button">移除</button>
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
      if (!prov || !lbl) return toast('请填写供应商和 Key 标签', 'warn');
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

  // KB 4-Pipeline Visual Editor (U1, M16)
  function renderKBPipelines(container) {
    const pipelines = [
      { id: 'chat', name: '对话流水线', path: '/v1/chat/completions', desc: 'RAG 生成对话专用高并发通道' },
      { id: 'embedding', name: '向量嵌入流水线', path: '/v1/embeddings', desc: '文档分块高吞吐向量化' },
      { id: 'reranker', name: '重排流水线', path: '/v1/rerank', desc: '多候选语义重排打分' },
      { id: 'ocr', name: '图文解析流水线', path: '/v1/ocr', desc: '文档图像多模态 OCR 提取' },
    ];

    state.config.kb_models = state.config.kb_models || {};

    pipelines.forEach((pl) => {
      const cands = state.config.kb_models[pl.id] || [];
      const isExpanded = state.activeEditorKey === `kb_${pl.id}`;

      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = document.createElement('span');
      dot.className = `dot ${cands.length > 0 ? 'dot--ok' : 'dot--warn'}`;

      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          <span>${pl.path}</span>
          <span class="pill pill--accent">${pl.name}</span>
          <span class="pill">${cands.length} 候选实例</span>
        </div>
        <div class="sub">${pl.desc}</div>
      `;

      const fields = document.createElement('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="caret">▾</span>
      `;

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);

      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `kb_${pl.id}`;
        renderModelsList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = document.createElement('div');
        editor.className = 'editor';
        editor.appendChild(buildKBPipelineEditor(pl.id, pl, cands));
        container.appendChild(editor);
      }
    });
  }

  function buildKBPipelineEditor(cat, pl, cands) {
    const wrap = document.createElement('div');

    wrap.innerHTML = `
      <div class="section-bar">
        <span class="form-label">${pl.name} (${pl.path}) 候选池列表</span>
      </div>

      <div class="card">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>启用</th>
                <th>供应商</th>
                <th>Key 标签</th>
                <th>目标模型 ID</th>
                <th>并发限制</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="kb_cands_tbody_${cat}"></tbody>
          </table>
        </div>
      </div>

      <div class="form-grid mt-3">
        <div class="form-group">
          <input class="input" id="new_kb_prov_${cat}" placeholder="供应商 ID">
        </div>
        <div class="form-group">
          <input class="input" id="new_kb_key_${cat}" placeholder="Key 标签">
        </div>
        <div class="form-group">
          <input class="input" id="new_kb_model_${cat}" placeholder="上游真实模型 ID">
        </div>
        <div class="form-group">
          <input class="input tabular" id="new_kb_conc_${cat}" type="number" placeholder="最大并发 (默认 4)" value="4">
        </div>
        <div class="form-group flex-end">
          <button class="btn" id="btn_add_kb_cand_${cat}" type="button">添加候选</button>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn--primary" id="btn_save_kb_${cat}" type="button">保存流水线配置</button>
      </div>
    `;

    const tbody = wrap.querySelector(`#kb_cands_tbody_${cat}`);
    cands.forEach((c, idx) => {
      const tr = document.createElement('tr');
      const brandIco = window.renderBrandIcon ? window.renderBrandIcon(c.provider) : '';
      tr.innerHTML = `
        <td><input type="checkbox" class="kb_c_en" data-idx="${idx}" ${c.enabled !== false ? 'checked' : ''}></td>
        <td>${brandIco}<strong>${escapeHtml(c.provider)}</strong></td>
        <td><span class="pill">${escapeHtml(c.key_label || c.key)}</span></td>
        <td><span class="tabular">${escapeHtml(c.model)}</span></td>
        <td><span class="tabular">${c.max_concurrency || c.max_conc || 4}</span></td>
        <td>
          <button class="btn btn--sm btn_test_kb_cand" data-idx="${idx}" type="button">测试管道</button>
          <button class="btn btn--sm btn--danger btn_del_kb_cand" data-idx="${idx}" type="button">移除</button>
        </td>
      `;

      tr.querySelector('.kb_c_en').addEventListener('change', (e) => {
        c.enabled = e.target.checked;
      });

      // Test candidate endpoint (POST /api/admin/test-candidate)
      tr.querySelector('.btn_test_kb_cand').addEventListener('click', async () => {
        toast(`正在烟雾测试 [${cat}] 候选 ${c.provider}/${c.model}...`, 'info');
        try {
          const res = await window.HOST.testCandidate({
            provider: c.provider,
            key_label: c.key_label || c.key,
            model: c.model,
            type: cat,
          });
          if (res && res.ok) {
            toast(`管道测试通过！延迟: ${res.latency_ms || res.ms || 0}ms`, 'ok');
          } else {
            toast(`测试失败: ${res?.error || '无响应'}`, 'err');
          }
        } catch (e) {
          toast(`测试异常: ${e.message}`, 'err');
        }
      });

      tr.querySelector('.btn_del_kb_cand').addEventListener('click', () => {
        cands.splice(idx, 1);
        renderModelsList();
      });

      tbody.appendChild(tr);
    });

    wrap.querySelector(`#btn_add_kb_cand_${cat}`).addEventListener('click', () => {
      const prov = wrap.querySelector(`#new_kb_prov_${cat}`).value.trim();
      const kLbl = wrap.querySelector(`#new_kb_key_${cat}`).value.trim();
      const mdl = wrap.querySelector(`#new_kb_model_${cat}`).value.trim();
      const conc = Number(wrap.querySelector(`#new_kb_conc_${cat}`).value) || 4;

      if (!prov || !mdl) return toast('请填写供应商与模型 ID', 'warn');
      cands.push({
        provider: prov,
        key_label: kLbl,
        model: mdl,
        max_concurrency: conc,
        enabled: true,
      });
      state.config.kb_models[cat] = cands;
      renderModelsList();
    });

    wrap.querySelector(`#btn_save_kb_${cat}`).addEventListener('click', async () => {
      state.config.kb_models[cat] = cands;
      await persistConfig('知识库流水线配置保存成功');
    });

    return wrap;
  }

  // --- View: Activity & Traces (M7~M10, M12) ---
  function renderTracesList() {
    const container = document.getElementById('tracesList');
    if (!container) return;
    container.innerHTML = '';

    const traces = state.traces || [];
    const filtered = state.filterOnlyRetried
      ? traces.filter((t) => t.status >= 400 || (t.tries && t.tries.length > 1) || (t.retried_ms || 0) > 0)
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
      const hasRetries = triesCount > 1 || (t.retried_ms || 0) > 0;
      const brandIcon = window.renderBrandIcon ? window.renderBrandIcon(t.winner_provider || t.req_model) : '';

      const row = document.createElement('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = document.createElement('span');
      dot.className = `dot ${!isOk ? 'dot--err' : hasRetries ? 'dot--warn' : 'dot--ok'}`;

      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          ${brandIcon}
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
        editor.appendChild(window.USAGE.buildTraceWaterfall(t));
        container.appendChild(editor);
      }
    }
  }

  // --- View: Settings (M16, U3, U4) ---
  function renderSettingsView() {
    const s = state.config?.settings || {};
    const isFull = window.HOST.capabilities.runModes;

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val !== undefined ? val : '';
    };

    setVal('cfgRoutingStrategy', s.agent_routing_strategy || 'sticky_failover');
    setVal('cfgFirstByteTimeout', s.agent_first_byte_timeout_sec || 120);
    setVal('cfgCooldown429', s.cooldown_rate_limit_sec || 15);
    setVal('cfgCooldown5xx', s.cooldown_server_error_sec || 30);
    setVal('cfgCooldownNet', s.cooldown_network_error_sec || 15);
    setVal('cfgCooldownAuth', s.cooldown_auth_error_sec ?? 86400);

    // Full role Gateway Access Center (M16)
    const gwBox = document.getElementById('gatewayAccessCenter');
    const modeBox = document.getElementById('modeScheduleBox');
    const backupBox = document.getElementById('configBackupBox');

    if (gwBox) gwBox.hidden = !isFull;
    if (modeBox) modeBox.hidden = !isFull;
    if (backupBox) backupBox.hidden = false;

    if (isFull) {
      const baseOrigin = location.origin || 'http://127.0.0.1:3425';
      const localBase = `${baseOrigin}/v1`;
      const clientKey = s.client_key || s.proxy_api_key || 'sk-proxy-key';

      const gwBaseUrl = document.getElementById('gwBaseUrl');
      if (gwBaseUrl) gwBaseUrl.value = localBase;

      const gwClientKey = document.getElementById('gwClientKey');
      if (gwClientKey) gwClientKey.value = clientKey;

      const snippetClaude = document.getElementById('snippetClaude');
      if (snippetClaude) snippetClaude.textContent = `export ANTHROPIC_BASE_URL="${localBase}" ANTHROPIC_API_KEY="${clientKey}"`;

      const snippetCursor = document.getElementById('snippetCursor');
      if (snippetCursor) snippetCursor.textContent = `OPENAI_BASE_URL="${localBase}" OPENAI_API_KEY="${clientKey}"`;

      const btnGen = document.getElementById('btnGenClientKey');
      if (btnGen) {
        btnGen.onclick = () => {
          const rand = `sk-proxy-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
          if (gwClientKey) gwClientKey.value = rand;
          if (snippetClaude) snippetClaude.textContent = `export ANTHROPIC_BASE_URL="${localBase}" ANTHROPIC_API_KEY="${rand}"`;
          if (snippetCursor) snippetCursor.textContent = `OPENAI_BASE_URL="${localBase}" OPENAI_API_KEY="${rand}"`;
        };
      }

      const btnSaveKey = document.getElementById('btnSaveClientKey');
      if (btnSaveKey) {
        btnSaveKey.onclick = async () => {
          const k = (gwClientKey?.value || '').trim();
          s.client_key = k;
          s.proxy_api_key = k;
          await window.HOST.updateAccessKey({ client_key: k });
          await persistConfig('客户端鉴权密钥更新成功');
        };
      }

      const btnCopyClaude = document.getElementById('btnCopyClaudeSnippet');
      if (btnCopyClaude) {
        btnCopyClaude.onclick = () => {
          navigator.clipboard.writeText(snippetClaude?.textContent || '');
          toast('已复制 Claude Code 配置', 'ok');
        };
      }

      const btnCopyCursor = document.getElementById('btnCopyCursorSnippet');
      if (btnCopyCursor) {
        btnCopyCursor.onclick = () => {
          navigator.clipboard.writeText(snippetCursor?.textContent || '');
          toast('已复制 Cursor 配置', 'ok');
        };
      }

      // Mode Schedule (U4)
      const schedEnabled = document.getElementById('cfgModeSchedEnabled');
      if (schedEnabled) schedEnabled.checked = !!s.mode_schedule_enabled;
      setVal('cfgModeSchedWindow', s.mode_schedule_agent_window || '08:30-22:30');
      setVal('cfgModeSchedTz', s.mode_schedule_timezone || 'Asia/Shanghai');
      setVal('cfgModeSchedWebhook', s.mode_schedule_webhook_url || '');
      setVal('cfgOcrInflight', s.ocr_max_inflight || 4);
      setVal('cfgKbConcurrency', s.kb_global_max_concurrency || 16);

      const btnClearCd = document.getElementById('btnClearAllCooldowns');
      if (btnClearCd) {
        btnClearCd.onclick = async () => {
          if (!confirm('确定解除所有模型与密钥的当前冷却限制吗？')) return;
          try {
            const res = await window.HOST.clearCooldowns();
            if (res && res.ok) toast('已清除所有冷却状态', 'ok');
          } catch (e) {
            toast(e.message, 'err');
          }
        };
      }
    }

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
        s.cooldown_auth_error_sec = Math.max(0, Number(document.getElementById('cfgCooldownAuth').value) || 0);

        if (isFull) {
          s.mode_schedule_enabled = !!document.getElementById('cfgModeSchedEnabled')?.checked;
          s.mode_schedule_agent_window = document.getElementById('cfgModeSchedWindow')?.value.trim() || '08:30-22:30';
          s.mode_schedule_timezone = document.getElementById('cfgModeSchedTz')?.value.trim() || 'Asia/Shanghai';
          s.mode_schedule_webhook_url = document.getElementById('cfgModeSchedWebhook')?.value.trim() || '';
          s.ocr_max_inflight = Number(document.getElementById('cfgOcrInflight')?.value) || 4;
          s.kb_global_max_concurrency = Number(document.getElementById('cfgKbConcurrency')?.value) || 16;
        }

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
        toast('配置已被其他人修改，请刷新后重试', 'warn');
        await loadData();
        return;
      }

      const activeSecrets = [];
      for (const sp of Object.values(state.config?.search_providers || {})) {
        for (const k of sp?.api_keys || []) {
          if (k?.key && !String(k.key).includes('●')) activeSecrets.push(k.key);
        }
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
        renderSearchView();
        renderSettingsView();
      } else {
        const errMsg = typeof data.error === 'string' ? data.error : data.error?.message || '保存失败';
        toast(scrubUiText(errMsg, activeSecrets), 'err');
      }
    } catch (e) {
      toast(`保存异常: ${scrubUiText(e.message)}`, 'err');
    }
  }

  function formatTime(isoOrSec) {
    if (!isoOrSec) return '';
    const d = typeof isoOrSec === 'number' ? new Date(isoOrSec * 1000) : new Date(isoOrSec);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
