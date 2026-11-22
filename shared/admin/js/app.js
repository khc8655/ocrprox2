/**
 * app.js — Magpie Minimalist Admin UI Controller
 * Zero inline style, zero left-border stripes, inline row editors.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const ce = (t) => document.createElement(t);
  const clk = (el, fn) => el && el.addEventListener('click', fn);
  const fg = (lbl, ctrl, id = '', cls = '') => `<div class="form-group${cls ? ' ' + cls : ''}"${id ? ` id="${id}"` : ''}><label class="form-label">${lbl}</label>${ctrl}</div>`;
  const state = {
    config: null,
    nodes: [],
    usage: null,
    traces: [],
    lanes: {},
    cooldowns: {},
    cooldownsAll: [],
    systemVersion: null,
    extraPresetsLoaded: false,
    activeTab: 'activity',
    activeEditorKey: null,
    providerQuery: '',
    providerFilter: 'all',
    searchQuery: '',
    modelQuery: '',
    traceQuery: '',
    traceModeFilter: 'all',
    traceEndpointFilter: 'all',
    filterOnlyRetried: false,
    currentPeriod: 'today',
    lanesTimer: null,
    oauthPollTimer: null,
    oauthExpireTimer: null,
    nodesTimer: null,
    batchVerifying: false,
    probedModelsByProvider: {},
    probeFilterByProvider: {},
    vaultManifest: null,
    addProvVaultPick: '',
    addModelProbed: null,
    // modelSubMode (the「全部/自定义模型」seg toggle) is gone: with the fixed-4-channel
    // generation removed, every route is a custom route and the toggle filtered nothing.
  };

  function byIdIn(root, id) {
    if (!root || !id) return null;
    const rawId = String(id);
    if (root.id === rawId) return root;
    const escaped = rawId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const local = root.querySelector(`[id="${escaped}"]`);
    if (local) return local;
    if (root.ownerDocument) {
      const hit = root.ownerDocument.getElementById(rawId);
      if (hit && (hit === root || root.contains(hit))) return hit;
    }
    return null;
  }

  function makeScopedQuery(wrap) {
    return (s) => {
      const sel = String(s || '');
      if (sel.startsWith('#') && !/[>+~\[\],]/.test(sel) && !sel.slice(1).includes(' .') && !sel.slice(1).includes(' #')) {
        return byIdIn(wrap, sel.slice(1));
      }
      try {
        return wrap.querySelector(sel);
      } catch (_) {
        return null;
      }
    };
  }

  function syncVersionFromRes(res) {
    if (res && typeof res._version === 'number' && state.config) {
      state.config._version = res._version;
      const verEl = $('configVersionDisplay');
      if (verEl) verEl.textContent = `v${res._version}`;
    }
  }

  function generateRandomAlphaNum(len = 20) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = new Uint8Array(len);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  function generateClientSecretKey() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return `sk-llmproxy-${hex}`;
  }

  function normalizeApiType(val) {
    const s = String(val || '').trim().toLowerCase();
    if (s === 'anthropic' || s === 'anthropic-messages') return 'anthropic-messages';
    if (s === 'gemini' || s === 'google' || s === 'google_openai') return 'gemini';
    if (s === 'ocr') return 'ocr';
    return 'openai-completions';
  }

  function findKeyCooldown(pId, k, idx) {
    const cdMap = state.cooldowns || {};
    const candidates = [k?.id, k?.label, `key-${idx}`].filter(Boolean);
    let bestTarget = '';
    let bestSec = 0;
    for (const idOrLbl of candidates) {
      const exact = `p:${pId}:k:${idOrLbl}`;
      if ((cdMap[exact] || 0) > bestSec) {
        bestSec = cdMap[exact];
        bestTarget = exact;
      }
      const prefix = `${exact}:`;
      for (const [target, sec] of Object.entries(cdMap)) {
        if (target.startsWith(prefix) && (sec || 0) > bestSec) {
          bestSec = sec;
          bestTarget = target;
        }
      }
    }
    return { target: bestTarget, sec: bestSec };
  }

  function refreshDatalists() {
    const provDl = $('datalistProviders');
    if (provDl) {
      const pIds = Object.keys(state.config?.providers || {}).sort();
      provDl.innerHTML = pIds.map((id) => `<option value="${eh(id)}"></option>`).join('');
    }
  }

  function renumberSettingsSections() {
    const sec = $('viewSettings');
    if (!sec) return;
    let num = 1;
    sec.querySelectorAll('.card').forEach((card) => {
      if (card.hidden || card.classList.contains('hidden')) return;
      const badge = card.querySelector('.step-num');
      if (badge) badge.textContent = String(num++);
    });
  }

  function stopOAuthPolling() {
    if (state.oauthPollTimer) {
      clearInterval(state.oauthPollTimer);
      state.oauthPollTimer = null;
    }
    if (state.oauthExpireTimer) {
      clearTimeout(state.oauthExpireTimer);
      state.oauthExpireTimer = null;
    }
  }

  function isMaskedSecretVal(val) {
    const s = String(val || '').trim();
    if (!s) return false;
    return s.includes('●') || s.includes('•') || s.includes('***') || s.includes('...');
  }

  function toast(msg, type = 'info') {
    const box = $('toastBox');
    if (!box) return;
    const el = ce('div');
    el.className = 'toast';
    const dot = ce('span');
    dot.className = `dot dot--${type === 'err' ? 'err' : type === 'warn' ? 'warn' : 'ok'}`;
    const txt = ce('span');
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

  function isHubMode() {
    return window.HOST?.kind === 'hub';
  }

  // --- Vault On-Demand Manifest (Full) ---
  // Silent by design: the manifest is a background cache for the add-provider
  // form and the template-import dialog. A missing hub link must never block
  // the rest of the console — the settings page offers an explicit「测试连接」.
  async function loadVaultManifest(opts = {}) {
    if (isHubMode() || !window.HOST.capabilities.vaultClient) return null;
    if (state.vaultManifest && !opts.force) return state.vaultManifest;
    try {
      const res = await window.HOST.fetchVaultManifest();
      if (res && res.ok && res.providers && typeof res.providers === 'object') {
        state.vaultManifest = res;
        return state.vaultManifest;
      }
    } catch (_) {}
    return null;
  }

  function vaultManifestProviders() {
    const raw = state.vaultManifest?.providers;
    return raw && typeof raw === 'object' ? raw : {};
  }

  function vaultManifestModels() {
    const raw = state.vaultManifest?.agent_models;
    return raw && typeof raw === 'object' ? raw : {};
  }

  function nextKeyLabel(keys = [], prefix = 'k') {
    const used = new Set((keys || []).map((k) => k?.label || k?.id).filter(Boolean));
    let i = 1;
    while (used.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }

  // Default to local: a credential is only vault-owned when the caller explicitly
  // says so (hub console, or a vault sync). Defaulting to vault used to mark
  // node-side keys as read-only hub keys.
  function parseMultiApiKeys(raw, rawLabel, existing = [], origin = 'local') {
    const items = String(raw || '').split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) return { keys: [] };
    const lbl = String(rawLabel || '').trim();
    const used = new Set((existing || []).map((k) => k?.label || k?.id).filter(Boolean));
    if (items.length === 1 && lbl) {
      if (used.has(lbl)) return { error: `标签 ${lbl} 已存在，请更换标签（或留空自动递增）` };
      return { keys: [{ id: `k_${Date.now().toString(36)}`, label: lbl, key: items[0], enabled: true, origin }] };
    }
    const prefix = lbl ? `${lbl}-` : 'k';
    const out = [];
    let idx = 1;
    for (const secret of items) {
      while (used.has(`${prefix}${idx}`)) idx++;
      const tag = `${prefix}${idx}`;
      used.add(tag);
      out.push({ id: `k_${Date.now().toString(36)}_${idx}`, label: tag, key: secret, enabled: true, origin });
      idx++;
    }
    return { keys: out };
  }

  function getNodeSyncSnapshotStatus(n) {
    const r = n && n.last_seen;
    const rawSyncMs = r ? (typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : new Date(r).getTime()) : 0;
    const syncMs = rawSyncMs && !Number.isNaN(rawSyncMs) ? rawSyncMs : 0;
    if (!n || n.enabled === false) return { key: 'revoked', pillCls: 'pill--red', label: '已吊销', leaseText: '已吊销', syncMs };
    if (!syncMs) return { key: 'never', pillCls: 'pill', label: '从未同步', leaseText: '从未同步', syncMs: 0 };
    const lease = Number(n.lease_ttl) || 86400, grace = Number(n.grace_ttl) || 3600, age = Math.max(0, Math.floor((Date.now() - syncMs) / 1000));
    if (age > lease + grace) return { key: 'expired', pillCls: 'pill--red', label: '过期 / 离线', leaseText: '租约已过期', syncMs };
    if (age > lease) return { key: 'grace', pillCls: 'pill--amber', label: '宽限期内', leaseText: '宽限期内', syncMs };
    return { key: 'synced', pillCls: 'pill--green', label: '已同步', leaseText: `租约剩 ${formatCooldown(Math.max(1, lease - age))}`, syncMs };
  }

  // Never render a raw secret in the key table: saved keys arrive masked from the
  // server, but a key added in this session is still plaintext until saved.
  function maskKeyForDisplay(raw) {
    const s = String(raw || '');
    if (!s) return '';
    // Already a server-issued hint (either legacy dots or the short "sk-...7Yjl" form).
    if (s.includes('●') || s.includes('-...')) return s;
    if (s.length <= 8) return '***';
    // Match the server format so the list stays readable without revealing the key.
    const head = s.slice(0, 3).replace(/[-_]+$/, '') || s.slice(0, 1);
    return `${head}-...${s.slice(-4)}`;
  }

  // Key cell visibility rules:
  //  - Hub (authoritative): full plaintext, editable.
  //  - Node, locally added key: full plaintext, editable.
  //  - Node, key synced from the hub vault: short hint only, read-only.
  function renderKeyCell(k, vaultKey, idx) {
    const raw = String(k.key || '');
    if (vaultKey) {
      return `<span class="tabular text-muted" title="中枢下发的 Key，仅显示首尾">${eh(maskKeyForDisplay(raw))}</span>`;
    }
    const cellId = `k_val_${idx}_${Math.random().toString(36).slice(2, 8)}`;
    const masked = maskKeyForDisplay(raw);
    const safeFull = eh(raw);
    const safeMask = eh(masked);
    return `<span class="key-cell">`
      + `<code class="tabular" id="${cellId}" data-full="${safeFull}" data-mask="${safeMask}" data-masked="1">${safeMask}</code>`
      + `<button class="btn btn--sm btn_reveal_key" type="button" data-target="${cellId}" aria-label="显示或隐藏完整密钥">显示</button>`
      + `</span>`;
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

  // The legacy KB fixed-4-channel metadata map (FIXED_SLOT_META) is gone for good:
  // chat/embedding/reranker/ocr are ordinary agent_models routes now — they appear
  // wherever they exist (full and hub alike), are importable from templates, and
  // carry no special rendering, filtering or search behavior.

  // Only two strategies are surfaced by default; the rest stay available but are
  // grouped under "高级策略" because they need operator judgement (weights, latency
  // profiles, pinned keys) that the common case does not.
  const ADVANCED_STRATEGIES = ['weighted', 'least_busy', 'fast', 'manual'];
  const STRATEGY_LABELS = {
    sticky_failover: '多路会话粘性',
    round_robin: '空闲优先轮询',
    weighted: '按权重比例分摊',
    least_busy: '最少并发优先',
    fast: '动态低延迟优先',
    manual: '手动严格直通',
  };
  // One-line "what it does + when to use it" copy shown under the strategy pills.
  const STRATEGY_HINTS = {
    sticky_failover: '会话固定同一 Key，失败才切换；保上下文缓存（推荐）',
    round_robin: '优先分给空闲 Key；高并发均摊',
    weighted: '按权重比例分摊；配额差异大时用',
    least_busy: '优先分给并发最小 Key；求瞬时均衡',
    fast: '按实测延迟动态选最快 Key；首字敏感时用',
    manual: '按候选顺序直通；调试排障用',
  };

  // Which routes reference this provider/key pair? Used to warn before a key is
  // disabled or deleted, since candidates bind to an explicit provider:key_label.
  function routesUsingKey(providerId, keyLabel) {
    const refs = [];
    const agentModels = (state.config && state.config.agent_models) || {};
    for (const [model, route] of Object.entries(agentModels)) {
      const cands = (route && route.candidates) || [];
      if (cands.some((c) => c && c.provider === providerId && (c.key_label === keyLabel) && c.enabled !== false)) {
        refs.push(`模型路由 ${model}`);
      }
    }
    const kbModels = (state.config && state.config.kb_models) || {};
    for (const [kind, list] of Object.entries(kbModels)) {
      if (agentModels[kind]) continue;
      if ((list || []).some((c) => c && c.provider === providerId && c.key_label === keyLabel)) {
        refs.push(`固定通道 ${kind}`);
      }
    }
    return refs;
  }

  const eh = escapeHtml;

  // Shared show/hide helper. Must live at module scope: the node-issue button is
  // wired in setupNavigation while the creation forms are wired later, so a
  // function-local definition caused "toggle is not defined" at runtime.
  function toggle(target, show) {
    // Accepts an element or an element id: the node-issue button passes a string,
    // and assigning .hidden on a string silently does nothing (that was the reason
    // the issue form never opened).
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    el.hidden = show !== undefined ? !show : !el.hidden;
    el.classList.toggle('hidden', el.hidden);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setupStaticIcons() {
    const setIcon = (id, name) => {
      const el = $(id);
      if (el && window.uiIcon) el.innerHTML = window.uiIcon(name);
    };
    setIcon('brandMark', 'server');
    setIcon('loginBrandMark', 'server');
    setIcon('logoutBtn', 'logout');
    setIcon('providerSearchIcon', 'search');
    setIcon('modelSearchIcon', 'search');
    setIcon('traceSearchIcon', 'search');
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
    startNodesPolling();
  }

  // --- 1. In-Page Magpie Login Overlay (M14) ---
  function setupLoginScreen() {
    const loginForm = $('loginForm');
    const pwdInput = $('loginPassword');
    const errEl = $('loginError');
    const badge = $('loginHostBadge');

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

    const brandRole = $('brandRole');
    if (brandRole) brandRole.textContent = isHub ? 'Hub' : 'Full';

    const navModels = $('navModels');
    const navNodes = $('navNodes');
    const navActivity = $('navActivity');
    const topVersionBox = $('topVersionBox');
    const cfgVaultLinkBox = $('cfgVaultLinkBox');
    const hubOverviewBox = $('hubOverviewBox');
    const fullOverviewBox = $('fullOverviewBox');
    const btnClearAllCooldowns = $('btnClearAllCooldowns');
    const btnImportFromTemplate = $('btnImportFromTemplate');

    if (navModels) navModels.hidden = false;
    if (navNodes) navNodes.hidden = !caps.nodeManager;
    if (navActivity) navActivity.hidden = false;
    if (topVersionBox) topVersionBox.hidden = !caps.vaultHub;
    if (cfgVaultLinkBox) cfgVaultLinkBox.hidden = !caps.vaultClient;
    if (hubOverviewBox) hubOverviewBox.hidden = !isHub;
    if (fullOverviewBox) fullOverviewBox.hidden = isHub;
    if (btnClearAllCooldowns) btnClearAllCooldowns.hidden = !caps.kbModels;
    if (btnImportFromTemplate) btnImportFromTemplate.hidden = !caps.vaultClient;
    const guardBox = $('concurrencyGuardBox');
    if (guardBox) guardBox.hidden = false;
    const sysBox = $('systemUpdateBox');
    if (sysBox) sysBox.hidden = !caps.systemUpdate;

    const provSub = $('providersSubtitle');
    if (provSub) {
      provSub.textContent = isHub
        ? '统一维护共享供应商与密钥池，按节点权限范围安全下发至接入的 Full / Lite 节点'
        : '集中管理本地私有供应商；中枢托管供应商按需拉取（清单 → 整体拉取 → 按 Key 补拉）';
    }
    const modelsTitle = $('modelsTitle');
    const modelsSub = $('modelsSubtitle');
    if (modelsTitle) {
      modelsTitle.textContent = isHub ? '模型路由模板（下发编排）' : '模型路由与高并发通道';
    }
    if (modelsSub) {
      modelsSub.textContent = isHub
        ? '仅下发给 lite 节点；full 节点可选导入'
        : '管理当前网关对外暴露的模型路由与多密钥粘性/轮询策略。';
    }
    const rpTitle = $('routingPolicyTitle');
    const rpSub = $('routingPolicySub');
    if (rpTitle) {
      rpTitle.textContent = isHub ? '下发模板默认值与冷却策略' : '全局路由与异常冷却策略';
    }
    if (rpSub) {
      rpSub.textContent = isHub
        ? '作为节点拉取配置时的默认路由与异常冷却策略，节点可在本地覆盖'
        : '控制当前网关默认路由策略、首字超时及上游异常自动冷却时长';
    }
    const cgSub = $('concurrencyGuardSub');
    if (cgSub) {
      cgSub.textContent = isHub
        ? '仅对 Full 节点下发生效 · Lite 节点自动忽略'
        : '限制 OCR 大图并发预读与固定通道全局并发上限';
    }
    renumberSettingsSections();

    state.activeTab = 'activity';
    switchTab(state.activeTab);
  }

  function setupTheme() {
    const btn = $('themeToggleBtn');
    if (!btn) return;
    const saved = localStorage.getItem('llmproxy_theme') || 'auto';
    applyTheme(saved);

    clk(btn, () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'auto';
      const next = cur === 'dark' ? 'light' : cur === 'light' ? 'auto' : 'dark';
      applyTheme(next);
      localStorage.setItem('llmproxy_theme', next);
    });
  }

  function applyTheme(theme) {
    const btn = $('themeToggleBtn');
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
    const btn = $('btnPrivacyMask');
    if (!btn) return;
    const isMasked = localStorage.getItem('llmproxy_privacy_mask') === '1';
    if (isMasked) {
      document.body.classList.add('privacy-masked');
    }
    if (window.uiIcon) {
      btn.innerHTML = window.uiIcon(isMasked ? 'eyeOff' : 'eye');
    }

    clk(btn, () => {
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
        const pForm = $('addProviderForm');
        const mForm = $('addModelForm');
        const nForm = $('issueNodeForm');
        let closedSomething = false;
        if (pForm && !pForm.hidden) { pForm.hidden = true; pForm.classList.add('hidden'); closedSomething = true; }
        if (mForm && !mForm.hidden) { mForm.hidden = true; mForm.classList.add('hidden'); closedSomething = true; }
        if (nForm && !nForm.hidden) { nForm.hidden = true; nForm.classList.add('hidden'); closedSomething = true; }
        const installOverlay = $('nodeInstallOverlay');
        if (installOverlay && !installOverlay.hidden) { closeNodeInstallOverlay(); closedSomething = true; }
        const tplImportOverlay = $('templateImportOverlay');
        if (tplImportOverlay && !tplImportOverlay.hidden) { closeTemplateImportOverlay(); closedSomething = true; }
        if (state.activeEditorKey) {
          state.activeEditorKey = null;
          closedSomething = true;
          if (state.activeTab === 'providers') renderProvidersList();
          else if (state.activeTab === 'models') renderModelsList();
          else if (state.activeTab === 'nodes') renderNodesList();
          else if (state.activeTab === 'activity') renderTracesList();
        }
        if (closedSomething) toast('已取消操作并关闭弹层', 'info');
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
    if (!window.HOST.capabilities.kbModels) return;
    if (state.lanesTimer) clearInterval(state.lanesTimer);

    const poll = async () => {
      if (document.visibilityState === 'hidden' || !window.HOST.getToken()) return;
      if (state.activeTab !== 'providers' && state.activeTab !== 'models' && state.activeTab !== 'activity') return;
      try {
        const [lanesRes, cdRes] = await Promise.all([
          window.HOST.getLanes(),
          window.HOST.getCooldowns(),
        ]);
        if (lanesRes && lanesRes.ok) {
          state.lanes = lanesRes.lane_map || {};
        }
        if (cdRes) {
          const cdMap = {};
          for (const entry of cdRes.cooldowns || []) {
            if (entry && entry.target) cdMap[entry.target] = entry.remaining_sec || 0;
          }
          state.cooldowns = cdMap;
          state.cooldownsAll = cdRes.cooldowns || [];
        }
        if (state.activeTab === 'activity' && window.USAGE) {
          if (state.usage) {
            window.USAGE.renderKPIs(state.usage, { lanes: state.lanes, cooldowns: state.cooldownsAll });
          }
          window.USAGE.renderLiveStrip(state.lanes, state.cooldownsAll, clearSingleCooldown);
        }
      } catch (_) {}
    };

    state.lanesTimer = setInterval(poll, 3000);
  }

  function setupNavigation() {
    const seg = $('navSeg');
    if (!seg) return;
    seg.querySelectorAll('.seg-btn').forEach((btn) => {
      clk(btn, () => {
        const tab = btn.getAttribute('data-tab');
        if (tab) switchTab(tab);
      });
    });

    // Provider detail panel "自动探测协议" button (rendered per-row inside .editor).
    clk(document, async (e) => {
      const target = e.target instanceof Element ? e.target.closest('button[id^="btn_detect_ed_"]') : null;
      if (!target) return;
      const pId = target.id.slice('btn_detect_ed_'.length);
      if (!pId || target.disabled) return;
      target.disabled = true;
      try {
        const baseEl = $(`ed_p_base_${pId}`);
        const baseVal = baseEl ? baseEl.value.trim() : '';
        if (isHubMode()) {
          const probe = await window.HOST.probeModels({ provider: pId, base_url: baseVal });
          if (probe && (probe.ok || Array.isArray(probe.models))) {
            toast(`模型探测成功: 发现 ${(probe.models || []).length} 个可用模型`, 'ok');
          } else {
            toast(`探测失败: ${(probe && probe.error) || '请求未成功'}`, 'err');
          }
          return;
        }
        const res = await window.HOST.detectProvider({
          provider: pId,
          base_url: baseVal,
        });
        if (res && res.ok) {
          const protocols = Array.isArray(res.protocols) ? res.protocols.join(' / ') : '';
          if (protocols) {
            toast(`协议探测成功: ${protocols}`, 'ok');
            if (baseEl && res.normalized_base_url) baseEl.value = res.normalized_base_url;
          } else {
            const parts = Object.values(res.results || {}).map((r) => {
              const why = r && (r.status ? `HTTP ${r.status}` : '');
              const msg = r && r.error ? String(r.error) : '';
              return `${r.protocol}${why ? ` ${why}` : ''}${msg ? ` (${msg})` : ''}`;
            });
            toast(`协议探测失败：${parts.join('；') || '所有协议均无响应'}`, 'err');
          }
        } else if (res && res.status === 404) {
          const probe = await window.HOST.probeModels({ provider: pId, base_url: baseVal });
          if (probe && (probe.ok || Array.isArray(probe.models))) {
            toast(`模型探测成功: 发现 ${(probe.models || []).length} 个可用模型`, 'ok');
          } else {
            toast(`探测失败: ${(probe && probe.error) || '请求未成功'}`, 'err');
          }
        } else {
          toast(`协议探测失败: ${(res && res.error) || '请求未成功（检查登录态或网络）'}`, 'err');
        }
      } catch (err) {
        toast(`协议探测失败: ${err.message}`, 'err');
      } finally {
        target.disabled = false;
      }
    });

    const logoutBtn = $('logoutBtn');
    if (logoutBtn) {
      clk(logoutBtn, async () => {
        stopOAuthPolling();
        if (window.HOST.logout) await window.HOST.logout();
        else window.HOST.setToken('');
        window.HOST.showLogin();
      });
    }

    const btnIssueNode = $('btnIssueNode');
    if (btnIssueNode) {
      clk(btnIssueNode, () => {
        toggle('issueNodeForm');
        mountIssueScopeLists();
      });
    }

    const btnDoIssue = $('btnDoIssue');
    if (btnDoIssue) {
      clk(btnDoIssue, handleIssueNode);
    }

    const btnCloseNodeInstall = $('btnCloseNodeInstall');
    if (btnCloseNodeInstall) {
      clk(btnCloseNodeInstall, closeNodeInstallOverlay);
    }

    // Esc already closes editors globally; also close the install overlay so the
    // keyboard story stays "Esc cancels whatever is open". Clicking the dimmed
    // backdrop does the same.
    const nodeInstallOverlay = $('nodeInstallOverlay');
    if (nodeInstallOverlay) {
      nodeInstallOverlay.addEventListener('click', (ev) => {
        if (ev.target === nodeInstallOverlay) closeNodeInstallOverlay();
      });
    }

    clk($('btnImportFromTemplate'), async () => {
      // Force a reload: the cached manifest is a snapshot, and template routes newly
      // published on the hub must be importable without a full page refresh.
      await loadVaultManifest({ force: true });
      openTemplateImportOverlay();
    });
    clk($('btnCloseTemplateImport'), closeTemplateImportOverlay);
    clk($('btnConfirmImportRoutes'), handleConfirmImportRoutes);
    const templateImportOverlay = $('templateImportOverlay');
    if (templateImportOverlay) {
      templateImportOverlay.addEventListener('click', (ev) => {
        if (ev.target === templateImportOverlay) closeTemplateImportOverlay();
      });
    }
    clk($('btnTestVaultLink'), handleTestVaultLink);

    // Analytics Period Selector
    const periodSeg = $('activityPeriodSeg');
    if (periodSeg) {
      periodSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        clk(btn, async () => {
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
    const dimSeg = $('usageDimensionSeg');
    if (dimSeg) {
      dimSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        clk(btn, () => {
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

    const btnClearTraces = $('btnClearTraces');
    if (btnClearTraces) {
      clk(btnClearTraces, async () => {
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

    const btnFilterRetried = $('btnFilterRetried');
    if (btnFilterRetried) {
      clk(btnFilterRetried, () => {
        state.filterOnlyRetried = !state.filterOnlyRetried;
        btnFilterRetried.classList.toggle('active', state.filterOnlyRetried);
        renderTracesList();
      });
    }

    clk($('btnRefreshActivity'), async () => {
      await loadActivityData();
      toast('运行监控与统计已刷新', 'ok');
    });

    const chartMetricSeg = $('usageChartMetricSeg');
    if (chartMetricSeg) {
      chartMetricSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        clk(btn, () => {
          const m = btn.getAttribute('data-metric');
          if (!m) return;
          window.USAGE.state.chartMetric = m;
          chartMetricSeg.querySelectorAll('.seg-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-metric') === m);
          });
          if (state.usage) window.USAGE.renderStackedBarChart(state.usage);
        });
      });
    }

    $('traceSearchInput')?.addEventListener('input', (e) => {
      state.traceQuery = (e.target.value || '').trim().toLowerCase();
      renderTracesList();
    });
    $('traceModeFilter')?.addEventListener('change', (e) => {
      state.traceModeFilter = e.target.value || 'all';
      renderTracesList();
    });
    $('traceEndpointFilter')?.addEventListener('change', (e) => {
      state.traceEndpointFilter = e.target.value || 'all';
      renderTracesList();
    });
  }

  async function clearSingleCooldown(target) {
    if (!target) return;
    try {
      const res = await window.HOST.clearCooldowns(target);
      if (res && res.ok) {
        toast(`已解除冷却: ${target}`, 'ok');
        const cdRes = await window.HOST.getCooldowns();
        if (cdRes) {
          const cdMap = {};
          for (const entry of cdRes.cooldowns || []) {
            if (entry && entry.target) cdMap[entry.target] = entry.remaining_sec || 0;
          }
          state.cooldowns = cdMap;
          state.cooldownsAll = cdRes.cooldowns || [];
        }
        if (state.activeTab === 'activity' && window.USAGE) {
          if (state.usage) window.USAGE.renderKPIs(state.usage, { lanes: state.lanes, cooldowns: state.cooldownsAll });
          window.USAGE.renderLiveStrip(state.lanes, state.cooldownsAll, clearSingleCooldown);
        } else if (state.activeTab === 'providers') {
          renderProvidersList();
        }
      }
    } catch (e) {
      toast(`解除冷却失败: ${e.message}`, 'err');
    }
  }

  // --- 4. Canonical Presets (1:1 aligned with shared/presets/*.json) & cURL Parser ---
  // Compact tuple form: [label, base_url, api_type, version, updated_at, anthropic_base_url?].
  // version / updated_at mirror each adapter file (shared/presets/catalog.json);
  // anthropic has no adapter file, so it carries no version info. Expanded to the
  // object shape below (id = key, preset_id = id unless overridden by minimax-cn).
  const PRESETS_META = {
    openai: ['OpenAI 官方', 'https://api.openai.com/v1', 'openai-completions', '1.2.1', '2026-10-19'],
    anthropic: ['Anthropic 官方', 'https://api.anthropic.com/v1', 'anthropic-messages'],
    deepseek: ['DeepSeek 官方开放平台', 'https://api.deepseek.com/v1', 'openai-completions', '1.2.0', '2026-10-18'],
    google: ['Google AI Studio (Gemini)', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini', '1.2.0', '2026-10-18'],
    vertex: ['Google Vertex AI', 'https://{region}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{region}/endpoints/openapi', 'openai-completions', '1.1.0', '2026-10-18'],
    openrouter: ['OpenRouter', 'https://openrouter.ai/api/v1', 'openai-completions', '1.0.0', '2026-10-18', 'https://openrouter.ai/api/v1'],
    minimax: ['MiniMax (国际 api.minimax.io)', 'https://api.minimax.io/v1', 'openai-completions', '1.4.0', '2026-10-18', 'https://api.minimax.io/anthropic'],
    // minimax-cn binds the shared 'minimax' preset but has NO adapter file of its
    // own (presets-extra omits version for it): carry no version here, or the card
    // would show a nonexistent adapter's version.
    'minimax-cn': ['MiniMax (国内 api.minimaxi.com)', 'https://api.minimaxi.com/v1', 'openai-completions', '', '', 'https://api.minimaxi.com/anthropic', 'minimax'],
    siliconflow: ['硅基流动 (SiliconFlow)', 'https://api.siliconflow.cn/v1', 'openai-completions', '1.2.0', '2026-10-18'],
    stepfun: ['阶跃星辰 (StepFun)', 'https://api.stepfun.com/step_plan', 'openai-completions', '1.2.0', '2026-10-18'],
    sensenova: ['商汤日日新 (SenseNova)', 'https://token.sensenova.cn/v1', 'openai-completions', '1.3.0', '2026-10-18', 'https://token.sensenova.cn/v1'],
    nvidia: ['NVIDIA NIM', 'https://integrate.api.nvidia.com/v1', 'openai-completions', '2.0.0', '2026-10-18'],
    opencode: ['OpenCode Zen', 'https://opencode.ai/zen/v1', 'openai-completions', '2.0.0', '2026-10-18'],
    cline: ['Cline 官方 API', 'https://api.cline.bot/api/v1', 'openai-completions', '1.1.1', '2026-10-30'],
    amd: ['AMD Radeon Cloud', 'https://developer.amd.com.cn/radeon/api/v1', 'openai-completions', '2026.10.19', '2026-10-19', 'https://developer.amd.com.cn/radeon/api/v1'],
    agnes: ['Agnes AI', 'https://apihub.agnes-ai.com/v1', 'openai-completions', '1.4.0', '2026-10-18', 'https://apihub.agnes-ai.com/v1'],
    bai: ['B.AI', 'https://api.b.ai/v1', 'openai-completions', '1.4.0', '2026-10-18', 'https://api.b.ai/v1'],
    tokenrhythm: ['TokenRhythm', 'https://tokenrhythm.studio/v1', 'openai-completions', '1.2.0', '2026-10-18'],
  };
  for (const [k, a] of Object.entries(PRESETS_META)) {
    PRESETS_META[k] = { id: k, preset_id: a[6] || k, label: a[0], base_url: a[1], api_type: a[2], version: a[3] || '', updated_at: a[4] || '', anthropic_base_url: a[5] || '' };
  }

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

  // Presets are no longer surfaced as a head-of-form dropdown: PRESETS_META is
  // only the matching source for「按输入的名称/ID 自动匹配」(see
  // applyPresetAutoMatch). Server-side extra presets still join the source.
  function mergeExtraPresets(extraPresets = []) {
    if (!Array.isArray(extraPresets)) return;
    for (const p of extraPresets) {
      if (!p || !p.id) continue;
      const meta = PRESETS_META[p.id];
      if (meta) {
        // Known id: keep the table's label/urls but let the server refresh the
        // adapter-file version metadata (PresetDef) — otherwise the pill would
        // keep rendering a stale literal after the adapter file moves on.
        meta.version = p.version || '';
        meta.updated_at = p.updated_at || '';
        continue;
      }
      PRESETS_META[p.id] = {
        id: p.id,
        preset_id: p.id,
        label: p.name || p.id,
        base_url: p.base_url || '',
        anthropic_base_url: p.anthropic_base_url || '',
        api_type: normalizeApiType(p.protocol),
        // Adapter-file version metadata sent along with presets-extra (PresetDef);
        // keeps the provider card version pill working for server-side presets.
        version: p.version || '',
        updated_at: p.updated_at || '',
      };
    }
  }

  // Resolve the adapter (preset) meta bound to a provider: direct id hit first,
  // then preset_id match (e.g. a minimax-cn provider binds the shared 'minimax'
  // preset). Falls back to the provider id, mirroring the brand-icon lookup.
  function presetMetaForProvider(p, pId) {
    const pid = String(p?.preset_id || pId || '').trim();
    if (!pid) return null;
    if (PRESETS_META[pid]) return PRESETS_META[pid];
    for (const meta of Object.values(PRESETS_META)) {
      if (meta.preset_id && meta.preset_id === pid) return meta;
    }
    return null;
  }

  // Version pill for provider cards: 适配 {id} · v{version} · {updated_at}.
  function presetVersionText(meta) {
    if (!meta || !meta.version) return '';
    return `适配 ${meta.id} · v${meta.version}${meta.updated_at ? ` · ${meta.updated_at}` : ''}`;
  }

  // 已适配 = the provider actually runs an adapter script (plan D): a preset with
  // an adapter file (meta carries its version), hub-pulled rules (rule_hash), or
  // inline adapter_rules. A preset_id that only names a protocol (e.g. anthropic,
  // which has no adapter file) or an empty binding does NOT count — those are
  // 自定义（无适配文件）.
  function providerHasAdapter(p) {
    if (p.adapter_rules && Object.keys(p.adapter_rules).length > 0) return true;
    if (p.rule_hash) return true;
    const pid = String(p?.preset_id || '').trim();
    if (!pid) return false;
    return Boolean(presetVersionText(presetMetaForProvider(p, pid)));
  }

  // Adapter badge on provider cards (full + hub alike): a bound preset with an
  // adapter file shows its version, anything else is visibly「自定义（无适配文件）」
  // so operators can tell adapted providers apart at a glance (pairs with the
  // 已适配 filter, which uses the same providerHasAdapter judgement).
  function presetVersionPillHtml(p) {
    const pid = String(p?.preset_id || '').trim();
    const text = pid ? presetVersionText(presetMetaForProvider(p, pid)) : '';
    if (!text) return '<span class="pill" title="无适配文件">自定义（无适配文件）</span>';
    return `<span class="pill tabular" title="适配文件版本">${eh(text)}</span>`;
  }


  function setupToolbars() {
    const provSearch = $('providerSearchInput');
    if (provSearch) {
      provSearch.addEventListener('input', (e) => {
        state.providerQuery = (e.target.value || '').trim().toLowerCase();
        renderProvidersList();
      });
    }

    const provFilter = $('providerFilterSeg');
    if (provFilter) {
      provFilter.querySelectorAll('.seg-btn').forEach((btn) => {
        clk(btn, () => {
          const f = btn.getAttribute('data-filter') || 'all';
          state.providerFilter = f;
          provFilter.querySelectorAll('.seg-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-filter') === f);
          });
          renderProvidersList();
        });
      });
    }

    const modelSearch = $('modelSearchInput');
    if (modelSearch) {
      modelSearch.addEventListener('input', (e) => {
        state.modelQuery = (e.target.value || '').trim().toLowerCase();
        renderModelsList();
      });
    }

    clk($('btnHubRefreshOverview'), loadData);
    clk($('btnHubBatchVerifyAll'), verifyAllHubKeys);
    clk($('btnGoProvidersFromHub'), () => switchTab('providers'));
    clk($('btnGoNodesFromHub'), () => switchTab('nodes'));
  }

  function setupConfigBackup() {
    clk($('btnExportConfig'), async () => {
      try {
        const res = await window.HOST.exportConfig();
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = ce('a');
        a.href = url;
        a.download = `llmproxy_config_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast('配置已导出下载', 'ok');
      } catch (e) {
        toast(`导出失败: ${e.message}`, 'err');
      }
    });

    const importInput = $('importConfigFile');
    clk($('btnTriggerImport'), () => {
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
            const mode = $('importConfigMode')?.value || 'merge';
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

    const rawDetails = $('rawJsonDetails');
    const rawArea = $('rawConfigTextarea');
    const fillRawJson = () => {
      if (rawArea && state.config) {
        rawArea.value = JSON.stringify(state.config, null, 2);
      }
    };
    if (rawDetails) {
      rawDetails.addEventListener('toggle', () => {
        if (rawDetails.open && rawArea && !rawArea.value.trim()) fillRawJson();
      });
    }
    clk($('btnRefreshRawJson'), () => {
      fillRawJson();
      toast('已重新载入当前配置快照', 'ok');
    });
    clk($('btnFormatRawJson'), () => {
      if (!rawArea) return;
      try {
        rawArea.value = JSON.stringify(JSON.parse(rawArea.value), null, 2);
        toast('JSON 已格式化', 'ok');
      } catch (e) {
        toast(`JSON 语法错误: ${e.message}`, 'err');
      }
    });
    clk($('btnSaveRawJson'), async () => {
      if (!rawArea) return;
      try {
        const parsed = JSON.parse(rawArea.value);
        if (!confirm('确认直接应用这段 JSON 配置吗？保存时会自动保留未修改的脱敏密钥。')) return;
        if (state.config?._version !== undefined && parsed._version === undefined) {
          parsed._version = state.config._version;
        }
        state.config = parsed;
        await persistConfig('原始 JSON 配置已保存生效');
        fillRawJson();
      } catch (e) {
        toast(`保存失败: ${e.message}`, 'err');
      }
    });

    clk($('btnCheckSystemUpdate'), async () => {
      const btn = $('btnCheckSystemUpdate');
      const box = $('systemUpdateResult');
      if (btn) btn.disabled = true;
      toast('正在检测最新版本...', 'info');
      try {
        const data = await window.HOST.checkSystemUpdate();
        if (box) {
          box.hidden = false;
          box.classList.remove('hidden');
          if (data?.network_error) {
            box.innerHTML = `<div class="text-sm">无法连接发布服务器 (${eh(data.error || 'timeout')}) · 当前版本 <strong class="tabular">${eh(data.current_version || '-')}</strong></div>`;
            toast('检查更新失败: 无法连接发布服务器', 'warn');
          } else if (data?.has_update) {
            const notes = eh(data.notes || '').replace(/\n/g, '<br>');
            box.innerHTML = `
              <div class="section-bar">
                <div>
                  <span class="pill pill--amber">发现新版本 ${eh(data.latest_version)}</span>
                  <span class="text-sm text-muted ml-2">当前: ${eh(data.current_version)} · ${eh(data.title || '')}</span>
                </div>
                <button class="btn btn--primary btn--sm" id="btnDoSystemUpgrade" type="button">一键在线平滑升级</button>
              </div>
              ${notes ? `<div class="update-notes">${notes}</div>` : ''}
            `;
            clk($('btnDoSystemUpgrade'), async () => {
              if (!confirm(`确定下载并升级到 ${data.latest_version} 并自动重启服务吗？`)) return;
              const uBtn = $('btnDoSystemUpgrade');
              if (uBtn) uBtn.disabled = true;
              toast('正在下载校验最新二进制并平滑替换...', 'info');
              const uRes = await window.HOST.upgradeSystem();
              if (uRes && uRes.ok) {
                toast(uRes.message || '升级替换成功，服务正在重启...', 'ok');
              } else {
                toast(`在线升级失败: ${uRes?.error || '未知错误'}`, 'err');
                if (uBtn) uBtn.disabled = false;
              }
            });
          } else {
            box.innerHTML = `<div class="text-sm text-ok">当前已是最新版本 <strong class="tabular">${eh(data?.current_version || '-')}</strong> (检测于 ${eh(data?.checked_at || '')})</div>`;
            toast('当前已是最新版本', 'ok');
          }
        }
      } catch (e) {
        toast(`检查更新异常: ${e.message}`, 'err');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    clk($('btnRestartService'), async () => {
      if (!confirm('确定向服务发送平滑重启信号 (SIGTERM) 吗？(systemd 托管下约 2-3 秒自动恢复)')) return;
      try {
        const res = await window.HOST.restartService();
        toast(res?.message || '已触发平滑重启', 'ok');
      } catch (e) {
        toast(`重启失败: ${e.message}`, 'err');
      }
    });
  }

  // --- Add Provider: source select (custom vs vault on-demand) ---
  // Vault mode locks the hub-managed fields (the hub is authoritative) and only
  // lists manifest providers that are not configured locally yet. The hub console
  // itself hosts the vault, so the on-demand option only exists on Full nodes.
  function applyNewProvSourceMode() {
    const vaultOption = $('newProvSource')?.querySelector('option[value="vault"]');
    if (isHubMode() && vaultOption) vaultOption.hidden = true;
    const vaultMode = ($('newProvSource')?.value || 'custom') === 'vault';
    const setDisabled = (id, dis) => {
      const el = $(id);
      if (el) el.disabled = dis;
    };
    setDisabled('newProvId', vaultMode);
    setDisabled('newProvName', vaultMode);
    setDisabled('newProvBaseUrl', vaultMode);
    setDisabled('newProvApiType', vaultMode);
    toggle('newProvVaultGroup', vaultMode);
    toggle('newProvKeyAliasGroup', !vaultMode);
    toggle('newProvApiKeyGroup', !vaultMode);
    toggle('btnDetectProvider', !vaultMode);
    toggle('btnToggleCurlPaste', !vaultMode);
    if (vaultMode) {
      const curlWrap = $('curlPasteWrap');
      if (curlWrap && !curlWrap.hidden) toggle(curlWrap, false);
      state.addProvVaultPick = '';
      renderVaultProviderPicks();
    } else {
      state.addProvVaultPick = '';
      applyPresetAutoMatch();
    }
    const hintEl = $('newProvSourceHint');
    if (hintEl) {
      hintEl.textContent = vaultMode
        ? '选中后整体拉取该供应商的适配规则与全部 Key，名称 / URL 以中枢为准'
        : '手动填写端点信息；输入名称或 ID 会自动匹配预设适配规则';
    }
  }

  function renderVaultProviderPicks() {
    const box = $('newProvVaultPick');
    if (!box) return;
    box.innerHTML = '';
    const hintEl = $('newProvVaultHint');
    if (hintEl) hintEl.textContent = '';
    const localProviders = state.config?.providers || {};
    const manifestProvs = vaultManifestProviders();
    const entries = Object.entries(manifestProvs).filter(([pId]) => !localProviders[pId]);
    if (entries.length === 0) {
      const empty = ce('span');
      empty.className = 'text-xs text-muted';
      // Three distinct empty states: manifest not loaded / loaded but hub hosts nothing /
      // loaded and every hub provider already exists locally.
      empty.textContent = !state.vaultManifest
        ? '中枢清单未加载（请在系统设置配置 Vault 连接并点击「测试连接」）'
        : Object.keys(manifestProvs).length === 0
          ? '中枢清单为空：中枢暂未托管任何可拉取的供应商'
          : '中枢清单中的供应商均已配置在本地，无需重复添加';
      box.appendChild(empty);
      return;
    }
    for (const [pId, meta] of entries) {
      const keyCount = Array.isArray(meta.keys) ? meta.keys.length : 0;
      const pill = ce('button');
      pill.type = 'button';
      pill.className = `probe-pill${state.addProvVaultPick === pId ? ' probe-pill--managed' : ''}`;
      pill.innerHTML = `${eh(meta.name || pId)} · ${keyCount} Key${meta.preset_id ? ` <span class="pill">预设 ${eh(meta.preset_id)}</span>` : ''}`;
      clk(pill, () => {
        state.addProvVaultPick = pId;
        box.querySelectorAll('.probe-pill').forEach((b) => b.classList.toggle('probe-pill--managed', b === pill));
        const idEl = $('newProvId');
        const nameEl = $('newProvName');
        const baseEl = $('newProvBaseUrl');
        if (idEl) idEl.value = pId;
        if (nameEl) nameEl.value = meta.name || pId;
        if (baseEl) baseEl.value = meta.base_url || '';
        if (hintEl) {
          hintEl.textContent = `中枢 ${keyCount} 个 Key · 适配规则${meta.preset_id ? ` · 预设 ${meta.preset_id}` : ''}`;
        }
      });
      box.appendChild(pill);
    }
  }

  // --- Preset auto-match (custom source): presets are matched by the typed
  // name / ID instead of a dropdown (aligned with v1 applyPresetForProviderName:
  // only fill Base URL when it is still empty, always align the protocol).
  function matchPresetMeta(idOrName) {
    const key = String(idOrName || '').trim().toLowerCase();
    if (!key) return null;
    for (const meta of Object.values(PRESETS_META)) {
      if (String(meta.id || '').toLowerCase() === key || String(meta.label || '').toLowerCase() === key) {
        return meta;
      }
    }
    return null;
  }

  function applyPresetAutoMatch() {
    if (($('newProvSource')?.value || 'custom') !== 'custom') return;
    const hintEl = $('newProvPresetHint');
    const meta = matchPresetMeta($('newProvName')?.value) || matchPresetMeta($('newProvId')?.value);
    if (hintEl) {
      hintEl.textContent = meta ? `已按预设 ${meta.label} 自动填充` : '';
      hintEl.hidden = !meta;
      hintEl.classList.toggle('hidden', !meta);
    }
    if (!meta) return;
    const apiSel = $('newProvApiType');
    const apiType = normalizeApiType(meta.api_type);
    if (apiSel && [...apiSel.options].some((o) => o.value === apiType)) apiSel.value = apiType;
    const baseEl = $('newProvBaseUrl');
    if (baseEl && !baseEl.value.trim() && meta.base_url) baseEl.value = meta.base_url;
  }

  // Closes the provider combobox panel of the add-model modal. Assigned by
  // setupProvCombo once the static panel markup exists; the noop
  // default keeps the modal-cancel closures safe before that.
  let closeProvPanel = () => {};

  function setupCreationForms() {
    const pForm = $('addProviderForm');
    const mForm = $('addModelForm');


    clk($('btnAddProvider'), async () => {
      toggle(pForm);
      if (pForm && !pForm.hidden) {
        applyNewProvSourceMode();
        // Force a reload so hub-side key/template changes since page load are visible.
        await loadVaultManifest({ force: true });
        if (($('newProvSource')?.value || '') === 'vault') renderVaultProviderPicks();
      }
    });
    clk($('btnCancelAddProvider'), () => toggle(pForm, false));

    const srcSel = $('newProvSource');
    if (srcSel) srcSel.addEventListener('change', applyNewProvSourceMode);
    $('newProvName')?.addEventListener('input', applyPresetAutoMatch);
    $('newProvId')?.addEventListener('input', applyPresetAutoMatch);

    // cURL Paste Toggle & Input (M3)
    const btnToggleCurl = $('btnToggleCurlPaste');
    const curlWrap = $('curlPasteWrap');
    const curlInput = $('curlPasteInput');
    if (btnToggleCurl && curlInput) {
      clk(btnToggleCurl, () => {
        const target = curlWrap || curlInput;
        target.hidden = !target.hidden;
        target.classList.toggle('hidden', target.hidden);
        if (!target.hidden) curlInput.focus();
      });

      curlInput.addEventListener('input', () => {
        const parsed = parseCurl(curlInput.value);
        if (parsed) {
          if (parsed.base) $('newProvBaseUrl').value = parsed.base;
          if (parsed.key) $('newProvApiKey').value = parsed.key;
          if (parsed.protocol) $('newProvApiType').value = parsed.protocol;
          if (parsed.model) {
            const mId = $('newProvId');
            if (mId && !mId.value) mId.value = parsed.model.split('/')[0].split('-')[0];
          }
          toast('已从 cURL 自动解析填充 Base URL 与密钥！', 'ok');
        }
      });
    }

    // Auto-detect protocols button in Add Provider (M1)
    const btnDetect = $('btnDetectProvider');
    if (btnDetect) {
      clk(btnDetect, async () => {
        const baseUrl = ($('newProvBaseUrl')?.value || '').trim();
        const apiKey = ($('newProvApiKey')?.value || '').trim();
        if (!baseUrl) return toast('请先输入 Base URL', 'warn');
        toast('正在探测上游支持协议与延迟...', 'info');
        try {
          const res = isHubMode() ? null : await window.HOST.detectProvider({ base_url: baseUrl, api_key: apiKey });
          if (res && res.ok) {
            const protos = Array.isArray(res.protocols) ? res.protocols : (res.protocol ? [res.protocol] : []);
            toast(`探测成功！支持协议: ${protos.join(' / ') || 'openai-completions'}`, 'ok');
            if (res.normalized_base_url) $('newProvBaseUrl').value = res.normalized_base_url;
            else if (res.base_url) $('newProvBaseUrl').value = res.base_url;
            const firstProto = protos[0] || res.protocol;
            if (firstProto) {
              const sel = $('newProvApiType');
              if (sel) {
                const mapped = firstProto === 'openai' ? 'openai-completions' : firstProto === 'anthropic' ? 'anthropic-messages' : firstProto;
                if ([...sel.options].some((o) => o.value === mapped)) sel.value = mapped;
              }
            }
          } else {
            // Fallback probe
            const probe = await window.HOST.probeModels({ base_url: baseUrl, api_key: apiKey });
            if (probe && (probe.ok || probe.count)) {
              toast(`探测成功: 发现 ${probe.count || probe.models?.length || 0} 个可用模型`, 'ok');
            } else {
              toast(`探测未返回模型列表: ${probe?.error || '请填写有效 API Key 后探测'}`, 'warn');
            }
          }
        } catch (e) {
          toast(`探测完成: ${e.message}`, 'info');
        }
      });
    }

    clk($('btnConfirmAddProvider'), async () => {
      const sourceVal = $('newProvSource')?.value || 'custom';

      // Vault on-demand path: one-shot fetch (rules + all keys). The gateway
      // merges the hub response server-side, so we only refresh afterwards.
      if (sourceVal === 'vault') {
        const pickId = state.addProvVaultPick;
        if (!pickId) return toast('请先选择一个中枢托管供应商', 'warn');
        if (state.config?.providers?.[pickId]) {
          // The existing provider may be vault-origin (editor offers「重新拉取」) or
          // locally created (no such button — it must be deleted or renamed first).
          return toast(`供应商 ${pickId} 已存在：中枢托管供应商可在其编辑器中「重新拉取」，本地创建的供应商请先删除或改名`, 'warn');
        }
        const btn = $('btnConfirmAddProvider');
        if (btn) btn.disabled = true;
        toast(`正在从中枢拉取供应商 ${pickId}（规则与全部 Key）...`, 'info');
        try {
          const res = await window.HOST.fetchVaultCredentials(pickId);
          if (res && res.ok) {
            state.activeEditorKey = `p_${pickId}`;
            toggle(pForm, false);
            await loadData();
            toast(`已拉取中枢供应商 ${pickId}`, 'ok');
          } else {
            toast(`从中枢拉取失败: ${scrubUiText(res?.error || '请求未成功')}`, 'err');
          }
        } catch (e) {
          toast(`从中枢拉取异常: ${e.message}`, 'err');
        } finally {
          if (btn) btn.disabled = false;
        }
        return;
      }

      const id = ($('newProvId')?.value || '').trim();
      const name = ($('newProvName')?.value || '').trim() || id;
      const baseUrl = ($('newProvBaseUrl')?.value || '').trim();
      const apiType = normalizeApiType($('newProvApiType')?.value);
      const keyAlias = ($('newProvKeyAlias')?.value || '').trim() || 'k1';
      const apiKey = ($('newProvApiKey')?.value || '').trim();
      const matchedMeta = matchPresetMeta(name) || matchPresetMeta(id);
      const resolvedPresetId = matchedMeta
        ? (matchedMeta.preset_id || matchedMeta.id)
        : (PRESETS_META[id]?.preset_id || '');

      if (!id) return toast('请输入供应商标识 ID', 'warn');
      if (!baseUrl) return toast('请输入 Base URL', 'warn');

      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.providers = state.config.providers || {};
      if (state.config.providers[id]) return toast(`供应商 ${id} 已存在`, 'warn');

      const defOrigin = isHubMode() ? 'vault' : 'local';
      const parsed = parseMultiApiKeys(apiKey, keyAlias, [], defOrigin);
      if (parsed.error) return toast(parsed.error, 'warn');
      const newProv = {
        id,
        name,
        base_url: baseUrl,
        api_type: apiType,
        preset_id: resolvedPresetId,
        enabled: true,
        origin: defOrigin,
        api_keys: parsed.keys,
      };
      if (matchedMeta?.anthropic_base_url) {
        newProv.anthropic_base_url = matchedMeta.anthropic_base_url;
      }
      state.config.providers[id] = newProv;
      state.activeEditorKey = `p_${id}`;
      toggle(pForm, false);
      await persistConfig('供应商创建成功');
    });

    // Both creation forms are centered overlays now (same dimmed-backdrop pattern
    // as the login screen): a click on the backdrop itself cancels, and each has an
    // explicit 关闭 button in its header next to the Esc key.
    if (pForm) {
      pForm.addEventListener('click', (ev) => {
        if (ev.target === pForm) toggle(pForm, false);
      });
    }
    clk($('btnXProv'), () => toggle(pForm, false));

    const cancelAddModel = () => {
      toggle(mForm, false);
      closeProvPanel();
      resetProbe();
    };
    if (mForm) {
      mForm.addEventListener('click', (ev) => {
        if (ev.target === mForm) cancelAddModel();
      });
    }
    clk($('btnXModel'), cancelAddModel);

    setupProvCombo();

    clk($('btnAddModel'), () => {
      toggle(mForm);
      if (mForm && !mForm.hidden) {
        // Fresh form on every open: a model name left over from the previous
        // session would otherwise be confirmed into the new route untouched.
        resetProbe();
        closeProvPanel();
        const provInput = $('newModelProvider');
        if (provInput) provInput.value = '';
        const nameInput = $('newModelName');
        if (nameInput) nameInput.value = '';
        renderKeyPills();
      }
    });
    clk($('btnCancelAddModel'), cancelAddModel);

    // Switching the provider invalidates the previous probe results, the picked
    // keys (they belong to the old provider's key pool) and the picked upstream
    // target (it belongs to the old provider's model list) — resetProbe covers all.
    $('newModelProvider')?.addEventListener('change', () => {
      resetProbe();
      renderKeyPills();
    });

    // Probe the upstream model list through the gateway (works for both full and
    // hub hosts: the backend resolves an unmasked key from the stored provider).
    const probeBtn = $('btnProbeModel');
    // Failure/empty probes keep a persistent inline note inside the probe result
    // box (#npbPills): the toast alone auto-dismisses, and resetProbe() then
    // leaves the form looking untouched — the operator would never see why
    // nothing appeared. Cleared by the next probe, provider switch or close.
    const showProbeFail = (msg) => {
      const list = $('npbPills');
      if (list) list.innerHTML = `<span class="text-xs text-muted">${eh(msg)}</span>`;
      toggle('npbBox', true);
    };
    clk(probeBtn, async () => {
      const prov = ($('newModelProvider')?.value || '').trim();
      if (!prov) return toast('请先选择供应商', 'warn');
      const p = state.config?.providers?.[prov] || {};
      toast(`探测 ${prov}...`, 'info');
      probeBtn.disabled = true;
      try {
        const res = await window.HOST.probeModels({
          provider: prov,
          base_url: p.base_url || '',
          api_type: normalizeApiType(p.api_type),
        });
        const models = Array.isArray(res?.models) ? res.models : [];
        if (models.length > 0) {
          resetProbe();
          state.addModelProbed = models;
          renderProbePills();
          toast(`探测成功: ${models.length} 个模型`, 'ok');
        } else {
          // A failed/empty probe invalidates the previous result too: leave no
          // unmarked stale pills from an earlier probe behind.
          resetProbe();
          const msg = res?.error ? `未探测到模型: ${scrubUiText(res.error)}` : '未探测到可用模型，可手填上游目标模型 ID';
          showProbeFail(msg);
          toast(msg, 'warn');
        }
      } catch (e) {
        resetProbe();
        const msg = `探测异常: ${scrubUiText(e.message)}`;
        showProbeFail(msg);
        toast(msg, 'err');
      } finally {
        probeBtn.disabled = false;
      }
    });

    clk($('btnConfirmAddModel'), async () => {
      const mName = ($('newModelName')?.value || '').trim();
      const prov = ($('newModelProvider')?.value || '').trim();
      const target = ($('newModelTarget')?.value || '').trim() || mName;
      const pickedLabels = [...document.querySelectorAll('#nmKeys .probe-pill--managed')]
        .map((b) => b.dataset.key)
        .filter(Boolean);

      if (!mName) return toast('请输入模型名', 'warn');

      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.agent_models = state.config.agent_models || {};

      if (state.config.agent_models[mName]) {
        state.activeEditorKey = `m_${mName}`;
        toggle(mForm, false);
        renderModelsList();
        return toast('模型已存在', 'info');
      }

      if (!prov) return toast('请选择供应商', 'warn');
      // 手动输入 may hold any free-text id: fail on a missing provider before the
      // key check, otherwise the misleading「请至少勾选一把 Key」hides the real cause.
      if (!state.config?.providers?.[prov]) return toast(`供应商 ${prov} 不存在，请先在供应商页创建`, 'warn');
      // Key picking is mandatory: every checked key becomes one candidate, and none
      // is pre-checked (the pool must be an explicit operator choice).
      if (pickedLabels.length === 0) return toast('请至少勾选一把 Key', 'warn');

      const provKeys = state.config?.providers?.[prov]?.api_keys || [];
      const candidates = pickedLabels
        // Disabled keys are not pillable and not bindable: the scheduler drops
        // them when expanding candidates, so a binding would never route.
        .filter((lbl) => provKeys.some((k) => k && k.enabled !== false && (k.label || k.id) === lbl))
        .map((lbl) => ({ provider: prov, key_label: lbl, target_model: target, enabled: true, weight: 1 }));
      if (candidates.length === 0) return toast('勾选的 Key 已不存在或已禁用', 'warn');

      state.config.agent_models[mName] = { routing_strategy: 'sticky_failover', active_key: '', enabled: true, candidates };
      state.activeEditorKey = `m_${mName}`;
      toggle(mForm, false);
      resetProbe();
      await persistConfig('模型添加成功');
    });
  }

  // --- Provider combobox (searchable dropdown for「首选供应商」) ---
  // Replaces the bare <select>: an input + an in-flow panel card whose rows show
  // the provider name plus a small Base URL line, a top search filter and a
  // bottom「手动输入…」free entry. No new CSS: rows reuse .row/.who/.name from the
  // provider list, the panel is a plain .card. Keyboard semantics mirror a native
  // select: ArrowDown/ArrowUp walk the options, Esc closes the panel first and
  // only then lets the global handler close the modal.
  function setupProvCombo() {
    const input = $('newModelProvider');
    const panel = $('npPanel');
    if (!input || !panel) return;

    const showPanel = () => {
      const search = $('npSearch');
      search.value = '';
      syncProvOptions();
      toggle(panel, true);
      search.focus();
    };
    closeProvPanel = () => toggle(panel, false);

    input.addEventListener('focus', () => { if (panel.hidden) showPanel(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        e.stopPropagation();
        closeProvPanel();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (panel.hidden) showPanel();
        panel.querySelector('button.row')?.focus();
      }
    });

    $('npSearch')?.addEventListener('input', () => syncProvOptions());

    // Esc / arrows anywhere inside the panel (search box included, events bubble):
    // close it, or walk the option rows.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        e.stopPropagation();
        closeProvPanel();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = [...panel.querySelectorAll('button.row')];
      if (rows.length === 0) return;
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement);
      (e.key === 'ArrowDown' ? rows[idx + 1] || rows[0] : rows[idx - 1] || rows[rows.length - 1])?.focus();
    });

    // Free entry: keep whatever is in the combobox input as the provider ID.
    clk($('npManual'), () => {
      const v = (input.value || '').trim();
      if (!v) return toast('请先输入供应商 ID', 'warn');
      pickProv(v);
    });
  }

  function syncProvOptions() {
    const box = $('npOptions');
    if (!box) return;
    const f = String($('npSearch')?.value || '').trim().toLowerCase();
    const provs = state.config?.providers || {};
    const ids = Object.keys(provs).sort().filter((pId) => {
      if (!f) return true;
      const p = provs[pId] || {};
      return `${pId} ${p.name || ''} ${p.base_url || ''}`.toLowerCase().includes(f);
    });
    box.innerHTML = '';
    if (ids.length === 0) {
      box.innerHTML = '<div class="row row--static text-xs text-muted">无匹配供应商，可手动输入</div>';
      return;
    }
    ids.forEach((pId) => {
      const p = provs[pId] || {};
      const rowBtn = ce('button');
      rowBtn.className = 'row';
      rowBtn.setAttribute('role', 'option');
      rowBtn.innerHTML = `<div class="who"><div class="name">${eh(p.name || pId)}</div><div class="text-xs text-muted">${eh(p.base_url || '')}</div></div>`;
      clk(rowBtn, () => pickProv(pId));
      box.appendChild(rowBtn);
    });
  }

  // Commit the picked provider: fill the combobox input, close the panel and
  // refresh everything that depends on the provider (probe results + key pills).
  function pickProv(pId) {
    const input = $('newModelProvider');
    if (input) input.value = pId;
    closeProvPanel();
    resetProbe();
    renderKeyPills();
  }

  // --- Add-model form: key picking + upstream model probe ---
  // Clears everything the previous probe session produced, including「上游目标模型
  // ID」: a target picked (or typed) against one provider must never survive a
  // provider switch — confirm would otherwise persist the old provider's model id
  // into the new provider's candidates as a silent broken route.
  function resetProbe() {
    state.addModelProbed = null;
    const filterEl = $('npbFilter');
    if (filterEl) filterEl.value = '';
    toggle('npbBox', false);
    const pills = $('npbPills');
    if (pills) pills.innerHTML = '';
    const targetEl = $('newModelTarget');
    if (targetEl) targetEl.value = '';
  }

  // Key capsules for the selected provider. None is pre-checked on purpose: the
  // candidate pool of the new route must be an explicit operator choice. Disabled
  // keys are not listed — the scheduler drops disabled keys when expanding
  // candidates, so binding one would create a route that silently never routes.
  // Selection state lives in the DOM (.probe-pill--managed), re-read at confirm time.
  function renderKeyPills() {
    const box = $('nmKeys');
    if (!box) return;
    box.innerHTML = '';
    const provId = ($('newModelProvider')?.value || '').trim();
    const allKeys = state.config?.providers?.[provId]?.api_keys || [];
    const keys = allKeys.filter((k) => k && k.enabled !== false);
    if (!provId || keys.length === 0) {
      box.innerHTML = `<span class="text-xs text-muted">${!provId ? '请先选择供应商' : '该供应商没有已启用的 Key'}</span>`;
      return;
    }
    // Badge convention mirrors the provider key table: only the full-node console
    // distinguishes vault (hub-issued, read-only) from local keys.
    keys.forEach((k, idx) => {
      const label = k?.label || k?.id || `key-${idx}`;
      const pill = ce('button');
      pill.type = 'button';
      pill.dataset.key = label;
      pill.className = 'probe-pill';
      pill.innerHTML = isHubMode() ? eh(label)
        : `${eh(label)}${k?.origin === 'vault' ? ' <span class="pill">中枢只读</span>' : ' <span class="pill pill--amber">本地</span>'}`;
      clk(pill, () => pill.classList.toggle('probe-pill--managed'));
      box.appendChild(pill);
    });
  }

  // Probe result capsules: click fills「上游目标模型 ID」and highlights the pill
  // (single selection — clicking another pill just moves the highlight).
  // #npbFilter is static DOM and its input listener is bound once, so draw must
  // re-read state.addModelProbed on every call: closing over one probe's array
  // made the filter re-render the previous provider's list after a re-probe.
  function renderProbePills() {
    const list = $('npbPills');
    if (!list) return;
    const models = Array.isArray(state.addModelProbed) ? state.addModelProbed : [];
    if (models.length === 0) {
      toggle('npbBox', false);
      list.innerHTML = '';
      return;
    }
    toggle('npbBox', true);
    const targetInput = $('newModelTarget');
    const draw = (rawFilter) => {
      const live = state.addModelProbed || [];
      list.innerHTML = '';
      const f = String(rawFilter || '').trim().toLowerCase();
      const visible = (f ? live.filter((m) => String(m).toLowerCase().includes(f)) : live).slice(0, 200);
      const curTarget = (targetInput?.value || '').trim();
      visible.forEach((modelName) => {
        const pill = ce('button');
        pill.type = 'button';
        pill.className = `probe-pill${curTarget === modelName ? ' probe-pill--managed' : ''}`;
        pill.textContent = modelName;
        clk(pill, () => {
          if (targetInput) targetInput.value = modelName;
          list.querySelectorAll('.probe-pill').forEach((b) => b.classList.toggle('probe-pill--managed', b === pill));
        });
        list.appendChild(pill);
      });
    };
    draw('');
    const filterEl = $('npbFilter');
    if (filterEl && !filterEl.dataset.bound) {
      filterEl.dataset.bound = '1';
      filterEl.addEventListener('input', (e) => draw(e.target.value));
    }
  }

  function switchTab(tab) {
    stopOAuthPolling();
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
      models: $('viewModels'),
      providers: $('viewProviders'),
      nodes: $('viewNodes'),
      activity: $('viewActivity'),
      settings: $('viewSettings'),
    };

    for (const [k, v] of Object.entries(views)) {
      if (v) v.hidden = k !== tab;
    }

    if (tab === 'activity') {
      if (window.HOST.kind === 'hub') {
        renderHubOverview();
      } else if (window.HOST.capabilities.usageAndTraces) {
        loadActivityData();
      }
    }

    if (tab === 'providers' && !isHubMode() && window.HOST.capabilities.vaultClient) {
      loadVaultManifest().then((manifest) => {
        const srcSel = $('newProvSource');
        const pForm = $('addProviderForm');
        if (manifest && srcSel && srcSel.value === 'vault' && pForm && !pForm.hidden) {
          renderVaultProviderPicks();
        }
      });
    }
  }

  async function loadData() {
    try {
      const cfgResp = await window.HOST.getConfig();
      if (cfgResp && (cfgResp.ok || cfgResp.providers || cfgResp._version !== undefined)) {
        state.config = cfgResp;
        const verEl = $('configVersionDisplay');
        if (verEl) verEl.textContent = `v${cfgResp._version || 1}`;

        refreshDatalists();
        renderProvidersList();
        renderModelsList();
        renderSettingsView();
      }

      if (window.HOST.capabilities.nodeManager) {
        await loadNodesData();
        mountIssueScopeLists();
      }

      if (!isHubMode() && !state.extraPresetsLoaded && window.HOST.getPresetsExtra) {
        state.extraPresetsLoaded = true;
        window.HOST.getPresetsExtra().then((res) => {
          if (res && res.ok && Array.isArray(res.presets)) {
            mergeExtraPresets(res.presets);
            // The first paint already used the table literals: re-render so the
            // version pills reflect the server-refreshed adapter metadata.
            renderProvidersList();
          }
        }).catch(() => {});
      }

      if (!isHubMode() && window.HOST.capabilities.vaultClient) {
        loadVaultManifest();
      }

      if (window.HOST.capabilities.systemUpdate && !state.systemVersion && window.HOST.getSystemVersion) {
        window.HOST.getSystemVersion().then((v) => {
          if (v && v.ok) {
            state.systemVersion = v;
            renderSettingsView();
          }
        }).catch(() => {});
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
        if (window.HOST.kind === 'hub' && state.activeTab === 'activity') {
          renderHubOverview();
        }
      }
    } catch (e) {
      toast(`节点加载失败: ${e.message}`, 'err');
    }
  }


  function renderHubOverview() {
    const kpiGrid = $('hubKpiGrid');
    const nodeBody = $('hubNodeStatsBody');
    const usageBody = $('hubModelUsageBody');
    const summarySub = $('hubHealthSummarySub');
    if (!kpiGrid || !nodeBody || !usageBody) return;

    const cfg = state.config || {};
    const providers = cfg.providers || {};
    const agentModels = cfg.agent_models || {};
    const nodes = (state.nodes || []).slice();

    const ONLINE_MS = 15 * 60 * 1000;
    const nowMs = Date.now();
    let onlineCount = 0;
    let enabledNodes = 0;
    let totalSyncs = 0;
    let total304 = 0;
    const modelUsage = new Map(); // model -> { nodes:Set, requests, success, failed, inTok, outTok }

    for (const n of nodes) {
      if (n.enabled !== false) enabledNodes++;
      totalSyncs += Number(n.sync_count || 0);
      total304 += Number(n.hit_304_count || 0);
      const lastMs = n.last_seen ? new Date(n.last_seen).getTime() : 0;
      if (n.enabled !== false && lastMs && nowMs - lastMs <= ONLINE_MS) onlineCount++;

      const u = n.usage;
      if (!u || typeof u !== 'object') continue;
      const statsMap = u.model_stats && typeof u.model_stats === 'object' ? u.model_stats : null;
      if (statsMap && Object.keys(statsMap).length > 0) {
        for (const [model, st] of Object.entries(statsMap)) {
          if (!st || typeof st !== 'object') continue;
          const calls = Number(st.calls ?? st.requests) || 0;
          if (calls <= 0) continue;
          let agg = modelUsage.get(model);
          if (!agg) {
            agg = { nodes: new Set(), requests: 0, success: 0, failed: 0, inTok: 0, outTok: 0, hasExactStats: false };
            modelUsage.set(model, agg);
          }
          agg.nodes.add(n.name || n.id);
          agg.requests += calls;
          agg.success += Number(st.successes ?? st.success) || 0;
          agg.failed += Number(st.failed) || 0;
          agg.inTok += Number(st.in_tokens ?? st.input_tokens) || 0;
          agg.outTok += Number(st.out_tokens ?? st.output_tokens) || 0;
          agg.hasExactStats = true;
        }
      } else {
        const models = u.models && typeof u.models === 'object' ? u.models : {};
        for (const [model, count] of Object.entries(models)) {
          const c = Number(count) || 0;
          if (c <= 0) continue;
          let agg = modelUsage.get(model);
          if (!agg) {
            agg = { nodes: new Set(), requests: 0, success: 0, failed: 0, inTok: 0, outTok: 0, hasExactStats: false };
            modelUsage.set(model, agg);
          }
          agg.nodes.add(n.name || n.id);
          agg.requests += c;
        }
      }
    }

    let totalKeys = 0;
    for (const p of Object.values(providers)) totalKeys += (p.api_keys || []).length;

    const kpis = [
      { label: '纳管 VM 节点', value: String(nodes.length), sub: `${onlineCount} 在线 · ${enabledNodes} 已启用` },
      { label: '下发供应商', value: String(Object.keys(providers).length), sub: `${totalKeys} 把密钥` },
      { label: '下发模型', value: String(Object.keys(agentModels).length), sub: `${Object.values(agentModels).reduce((a, m) => a + (m?.candidates || []).length, 0)} 个候选` },
      { label: '实际在用模型', value: String(modelUsage.size), sub: modelUsage.size ? '近一个上报窗口' : '暂无上报' },
      { label: '节点同步总次数', value: String(totalSyncs), sub: `304 命中 ${total304} 次` },
      { label: '当前配置版本', value: `v${cfg._version || 1}`, sub: 'EdgeOne KV CAS' },
    ];

    kpiGrid.innerHTML = kpis.map((item) => `
      <div class="kpi-card">
        <span class="kpi-label">${eh(item.label)}</span>
        <span class="kpi-value">${eh(item.value)}</span>
        <span class="kpi-sub">${eh(item.sub)}</span>
      </div>
    `).join('');

    if (summarySub) {
      summarySub.textContent = `共 ${nodes.length} 个节点，${onlineCount} 个在线（15 分钟内同步过）`;
    }

    // --- Active VM table ---
    const sortedNodes = nodes.slice().sort((a, b) => {
      const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0;
      const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0;
      return tb - ta;
    });

    if (sortedNodes.length === 0) {
      nodeBody.innerHTML = '<tr><td colspan="7" class="text-muted">暂无接入节点，点击右上角「管理节点」签发</td></tr>';
    } else {
      nodeBody.innerHTML = '';
      for (const n of sortedNodes) {
        const lastMs = n.last_seen ? new Date(n.last_seen).getTime() : 0;
        const online = n.enabled !== false && lastMs && (nowMs - lastMs) <= ONLINE_MS;
        const statusHtml = n.enabled === false
          ? '<span class="pill pill--red">已停用</span>'
          : online
            ? '<span class="pill pill--green">在线</span>'
            : '<span class="pill pill--amber">离线</span>';

        const usageModels = n.usage && n.usage.models ? Object.keys(n.usage.models) : [];
        const modelText = usageModels.length
          ? usageModels.slice(0, 3).map((m) => eh(m)).join(', ') + (usageModels.length > 3 ? ` +${usageModels.length - 3}` : '')
          : '<span class="text-muted">未上报</span>';

        const binBadge = n.last_binary_version
          ? ` <span class="pill tabular">${eh(n.last_binary_version)}</span>`
          : '';
        const tr = ce('tr');
        tr.innerHTML = `
          <td><strong>${eh(n.name || n.id)}</strong></td>
          <td><span class="pill pill--accent">${eh(n.role || 'full')}</span>${binBadge}</td>
          <td>${statusHtml}</td>
          <td class="text-sm">${modelText}</td>
          <td class="tabular">${eh(`v${n.last_config_version || 1}`)} · ${n.sync_count || 0} 次</td>
          <td class="tabular">${eh(lastMs ? formatTime(lastMs / 1000) : '从未同步')}</td>
          <td class="tabular">${eh(n.last_ip || '-')}</td>
        `;
        nodeBody.appendChild(tr);
      }
    }

    // --- Model usage distribution ---
    const usageRows = [...modelUsage.entries()].sort((a, b) => b[1].requests - a[1].requests);
    if (usageRows.length === 0) {
      usageBody.innerHTML = '<tr><td colspan="6" class="text-muted">暂无节点上报模型使用数据。节点在下一次配置同步时会自动上报。</td></tr>';
      return;
    }
    usageBody.innerHTML = '';
    for (const [model, agg] of usageRows) {
      const tr = ce('tr');
      const icoHtml = window.renderBrandIcon ? window.renderBrandIcon(model) : '';
      tr.innerHTML = `
        <td><div class="name">${icoHtml}<span>${eh(model)}</span></div></td>
        <td class="tabular">${agg.nodes.size}</td>
        <td class="tabular">${agg.requests}</td>
        <td class="tabular">${agg.hasExactStats ? `${agg.success} / ${agg.failed}` : '-'}</td>
        <td class="tabular">${agg.hasExactStats ? `${agg.inTok} / ${agg.outTok}` : '-'}</td>
        <td class="text-sm">${eh([...agg.nodes].slice(0, 4).join(', '))}${agg.nodes.size > 4 ? ' …' : ''}</td>
      `;
      usageBody.appendChild(tr);
    }
  }

  async function verifyAllHubKeys() {
    if (state.batchVerifying) return;
    const providers = state.config?.providers || {};
    const pIds = Object.keys(providers).sort();
    if (pIds.length === 0) return toast('暂无供应商可探活', 'warn');

    const btn = $('btnHubBatchVerifyAll');
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
              api_type: normalizeApiType(p.api_type),
            });
            syncVersionFromRes(r);
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
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      const [usageRes, tracesRes, lanesRes, cdRes] = await Promise.all([
        window.HOST.getUsage(state.currentPeriod, tz),
        window.HOST.getTraces(),
        window.HOST.getLanes().catch(() => null),
        window.HOST.getCooldowns().catch(() => null),
      ]);
      if (lanesRes && lanesRes.ok) {
        state.lanes = lanesRes.lane_map || {};
      }
      if (cdRes) {
        const cdMap = {};
        for (const entry of cdRes.cooldowns || []) {
          if (entry && entry.target) cdMap[entry.target] = entry.remaining_sec || 0;
        }
        state.cooldowns = cdMap;
        state.cooldownsAll = cdRes.cooldowns || [];
      }
      if (usageRes && usageRes.ok) {
        state.usage = usageRes;
        window.USAGE.renderKPIs(usageRes, { lanes: state.lanes, cooldowns: state.cooldownsAll });
        window.USAGE.renderLiveStrip(state.lanes, state.cooldownsAll, clearSingleCooldown);
        window.USAGE.renderStackedBarChart(usageRes);
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

  // --- Vault Link Connectivity Test (Full, settings page) ---
  // Uses the credentials currently typed into the settings form (NOT the saved
  // ones), so the operator can validate a new hub URL / NODE_TOKEN before
  // pressing「保存全部设置」.
  async function handleTestVaultLink() {
    const hubUrl = ($('cfgVaultUrl')?.value || '').trim();
    const nodeToken = ($('cfgVaultToken')?.value || '').trim();
    if (!hubUrl) return toast('请先填写 Vault 中枢地址', 'warn');
    const btn = $('btnTestVaultLink');
    if (btn) btn.disabled = true;
    toast('正在测试 Vault 中枢连接...', 'info');
    try {
      const tokenForReq = isMaskedSecretVal(nodeToken) ? '' : nodeToken;
      const res = await window.HOST.fetchVaultManifest(hubUrl, tokenForReq);
      if (res && res.ok && res.providers && typeof res.providers === 'object') {
        toast(`连接成功：中枢可用供应商 ${Object.keys(res.providers).length} 个`, 'ok');
      } else {
        toast(`连接失败: ${scrubUiText(res?.error || `HTTP ${res?.status || '请求未成功'}`)}`, 'err');
      }
    } catch (e) {
      toast(`连接失败: ${scrubUiText(e.message)}`, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- View: Providers (M1~M6, U2, U4) ---
  function renderProvidersList() {
    const container = $('providersList');
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
      // 已适配: the provider runs a real adapter script — adapter-file preset,
      // hub rules (rule_hash) or inline adapter_rules (plan D). A preset_id that
      // only names a protocol (anthropic, no adapter file) is NOT adapted.
      if (f === 'adapted') return providerHasAdapter(p);
      return true;
    });

    if (pKeys.length === 0) {
      const emptyRow = ce('div');
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
            busyCount += laneVal?.busy ?? laneVal?.Busy ?? 0;
            waitCount += laneVal?.waiting ?? laneVal?.Waiting ?? 0;
          }
        }
      }

      const row = ce('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = ce('span');
      const dotCls = p.enabled === false || keyCount === 0 || (failCount > 0 && okCount === 0)
        ? 'dot--err'
        : okCount > 0
          ? 'dot--ok'
          : 'dot--warn';
      dot.className = `dot ${dotCls}`;

      const who = ce('div');
      who.className = 'who';
      // Vault-pulled providers carry no version field in the hub manifest; show the
      // rule_hash fingerprint (same source as the drift check) instead of a version.
      // Without a hash they fall back to the standard adapted/custom badge.
      const isVaultCard = !isHubMode() && p.origin === 'vault';
      const versionPill = isVaultCard && p.rule_hash
        ? `<span class="pill tabular" title="中枢规则指纹 (rule_hash 前 8 位)">指纹 ${eh(String(p.rule_hash).slice(0, 8))}</span>`
        : presetVersionPillHtml(p);
      who.innerHTML = `
        <div class="name">
          ${brandIcon}
          <span>${eh(p.name || pId)}</span>
          ${(p.name && p.name !== pId) ? `<span class="pill">${eh(pId)}</span>` : ''}
          ${versionPill}
          ${isHubMode() ? '' : (isLocal ? '<span class="pill pill--amber">本地私有</span>' : '<span class="pill pill--green">共享</span>')}
          ${okCount > 0 ? `<span class="pill pill--green">${okCount}/${keyCount} 正常</span>` : ''}
          ${failCount > 0 ? `<span class="pill pill--red">${failCount} 异常</span>` : ''}
          ${busyCount > 0 ? `<span class="pill pill--accent">运行中: ${busyCount}${waitCount ? ` (排队:${waitCount})` : ''}</span>` : ''}
        </div>
        <div class="sub">${eh(p.base_url || '未配置 Base URL')}</div>
      `;

      const fields = ce('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill tabular">${keyCount} 把 Key</span>
        <span class="caret">▾</span>
      `;

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);

      clk(row, (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `p_${pId}`;
        renderProvidersList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = ce('div');
        editor.className = 'editor';
        editor.appendChild(buildProviderEditor(pId, p));
        container.appendChild(editor);
      }
    }
  }

  function renderProbePillsForProvider(q, pId, p) {
    const models = state.probedModelsByProvider[pId];
    const cont = q(`#probe_pills_container_${pId}`);
    const list = q(`#probe_pills_list_${pId}`);
    const countEl = q(`#probe_pills_count_${pId}`);
    const filterEl = q(`#probe_pills_filter_${pId}`);
    if (!cont || !list) return;
    if (!Array.isArray(models) || models.length === 0) {
      cont.hidden = true;
      cont.classList.add('hidden');
      return;
    }
    cont.hidden = false;
    cont.classList.remove('hidden');
    const curFilter = state.probeFilterByProvider[pId] || '';
    if (filterEl && filterEl.value !== curFilter) {
      filterEl.value = curFilter;
    }

    const draw = (rawFilter) => {
      const f = String(rawFilter || '').trim().toLowerCase();
      state.probeFilterByProvider[pId] = rawFilter || '';
      list.innerHTML = '';
      const matched = f ? models.filter((m) => m.toLowerCase().includes(f)) : models;
      const visible = matched.slice(0, 200);
      if (countEl) {
        countEl.textContent = matched.length > visible.length
          ? `匹配 ${matched.length} / 共 ${models.length} 个（显示前 ${visible.length} 个），点击一键纳管`
          : `共 ${matched.length} 个，点击一键纳管（已纳管模型自动标记）`;
      }
      visible.forEach((modelName) => {
        const managed = Boolean(state.config?.agent_models?.[modelName]);
        const pill = ce('span');
        pill.className = `probe-pill${managed ? ' probe-pill--managed' : ''}`;
        pill.textContent = managed ? `${modelName} ✓ 已纳管` : `${modelName} +`;
        pill.title = managed ? `${modelName} 已在模型路由列表中` : `点击一键纳管 ${modelName} 到模型路由`;
        clk(pill, async () => {
          state.config = state.config || { providers: {}, agent_models: {} };
          state.config.agent_models = state.config.agent_models || {};
          if (state.config.agent_models[modelName]) {
            const existingRoute = state.config.agent_models[modelName];
            existingRoute.candidates = existingRoute.candidates || [];
            const hasProv = existingRoute.candidates.some((c) => c && c.provider === pId);
            if (hasProv) {
              toast(`模型 ${modelName} 已纳管该供应商`, 'info');
              return;
            }
            const provKeys = p.api_keys || [];
            const firstKey = provKeys.find((k) => k && k.enabled !== false) || provKeys[0];
            const firstKeyLabel = firstKey ? (firstKey.label || firstKey.id || '') : '';
            existingRoute.candidates.push({
              provider: pId,
              key_label: firstKeyLabel,
              target_model: modelName,
              enabled: true,
              weight: 1,
            });
            await persistConfig(`已将供应商 ${pId} 追加至模型 ${modelName}`);
            return;
          }
          const provKeys = p.api_keys || [];
          const firstKey = provKeys.find((k) => k && k.enabled !== false) || provKeys[0];
          const firstKeyLabel = firstKey ? (firstKey.label || firstKey.id || '') : '';
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

    draw(curFilter);
    if (filterEl && !filterEl.dataset.bound) {
      filterEl.dataset.bound = '1';
      filterEl.addEventListener('input', (e) => draw(e.target.value));
    }
  }

  function buildProviderEditor(pId, p) {
    const wrap = ce('div');
    const q = makeScopedQuery(wrap);
    const keys = p.api_keys || [];
    const isVaultProv = !isHubMode() && p.origin === 'vault';
    const curApiType = normalizeApiType(p.api_type);
    const isMiniMax = String(p.preset_id || pId || '').toLowerCase().startsWith('minimax');
    const showOAuth = Boolean(window.HOST.capabilities.oauthLogin && !isVaultProv && isMiniMax);
    // Hub-authoritative fields (base_url / adapter_rules / preset_id / api_type)
    // are locked for vault providers; the manifest rule_hash detects drift.
    const manifestProv = isVaultProv ? vaultManifestProviders()[pId] || null : null;
    const ruleHashDrift = Boolean(
      manifestProv && manifestProv.rule_hash && p.rule_hash && manifestProv.rule_hash !== p.rule_hash
    );

    const aliasText = Object.entries(p.model_aliases || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const adapterText = p.adapter_rules && Object.keys(p.adapter_rules).length > 0
      ? JSON.stringify(p.adapter_rules, null, 2)
      : '';
    // Adapter-file version/date note under the preset binding input; rendered for
    // vault providers too (the input itself is locked, the note stays read-only).
    // Mirrors the card badge: adapter file → version, hub rules → 指纹, none →
    // 自定义（无适配文件）. A preset_id without an adapter file is NOT「适配 …」.
    const versionText = isVaultProv && p.rule_hash
      ? `中枢规则指纹 ${String(p.rule_hash).slice(0, 8)}`
      : (presetVersionText(presetMetaForProvider(p, String(p?.preset_id || '').trim())) || '自定义（无适配文件）');
    const presetVersionHint = `<span class="text-xs text-muted mt-1">${eh(versionText)}</span>`;

    const lockAttr = isVaultProv ? ' disabled' : '';
    const apiTypeSelectHtml = `<select class="select" id="ed_p_type_${pId}"${lockAttr}>`
      + `<option value="openai-completions" ${curApiType === 'openai-completions' ? 'selected' : ''}>OpenAI 兼容 (/v1/chat/completions)</option>`
      + `<option value="anthropic-messages" ${curApiType === 'anthropic-messages' ? 'selected' : ''}>Anthropic 原生 (/v1/messages)</option>`
      + `<option value="gemini" ${curApiType === 'gemini' ? 'selected' : ''}>Gemini 兼容</option>`
      + `<option value="ocr" ${curApiType === 'ocr' ? 'selected' : ''}>原生 OCR 接口 (/v1/ocr)</option>`
      + `</select>`;

    const syncDraftFields = () => {
      if (q(`#ed_p_name_${pId}`)) p.name = q(`#ed_p_name_${pId}`).value.trim();
      if (q(`#ed_p_base_${pId}`)) p.base_url = q(`#ed_p_base_${pId}`).value.trim();
      if (q(`#ed_p_ant_${pId}`)) p.anthropic_base_url = q(`#ed_p_ant_${pId}`).value.trim();
      if (q(`#ed_p_preset_${pId}`)) p.preset_id = q(`#ed_p_preset_${pId}`).value.trim();
      if (q(`#ed_p_type_${pId}`)) p.api_type = normalizeApiType(q(`#ed_p_type_${pId}`).value);
      if (q(`#ed_p_hide_ua_${pId}`)) {
        if (q(`#ed_p_hide_ua_${pId}`).checked) p.hide_client_name = true;
        else delete p.hide_client_name;
      }
      if (q(`#ed_p_reset_${pId}`)) p.quota_reset_at = q(`#ed_p_reset_${pId}`).value.trim();
      if (q(`#ed_p_rpm_${pId}`)) {
        const rpm = Number(q(`#ed_p_rpm_${pId}`).value);
        if (rpm > 0) p.rpm_per_key = rpm;
        else delete p.rpm_per_key;
      }
    };

    const vaultNotice = isVaultProv
      ? `<div class="notice-strip mb-3"><span>中枢托管供应商：名称、URL、协议与适配规则由中枢统一管理（只读）。如需修改请在中枢控制台操作后点击「重新拉取」。</span></div>${ruleHashDrift ? '<div class="notice-strip notice-strip--warn mb-3"><span>中枢规则已更新：本地适配规则与中枢清单不一致，请点击「重新拉取」同步最新规则与 Key。</span></div>' : ''}`
      : '';
    const vaultKeyPickHtml = isVaultProv
      ? `<div class="section-bar mt-3"><span class="form-label">从中枢添加 Key（仅列出本地缺失的标签）</span><div class="fields"><button class="btn btn--sm" id="btn_vault_add_keys_${pId}" type="button">从中枢添加</button></div></div><div class="probe-pills-wrap mb-2 hidden" id="vault_keys_pick_${pId}" hidden></div><div class="form-actions hidden" id="vault_keys_actions_${pId}" hidden><button class="btn btn--sm btn--primary" id="btn_vault_fetch_keys_${pId}" type="button">拉取所选 Key</button></div>`
      : `<div class="form-grid mt-3" id="add_key_form_${pId}"><div class="form-group"><input class="input" id="new_key_lbl_${pId}" placeholder="Key 标签 (如 pool-01，留空自动递增)"></div><div class="form-group"><input class="input input--code privacy-mask" id="new_key_val_${pId}" placeholder="粘贴完整 API Key（支持逗号分隔多把）"></div><div class="form-group flex-end"><button class="btn" id="btn_add_key_${pId}" type="button">添加 Key</button></div></div>`;
    const editorActionsHtml = `<div class="form-actions form-actions--split"><div class="form-actions-group"><button class="btn btn--danger" id="btn_del_prov_${pId}" type="button">删除此供应商</button>${isVaultProv ? `<button class="btn" id="btn_refetch_prov_${pId}" type="button">重新拉取</button>` : ''}</div>${isVaultProv ? '' : `<div class="form-actions-group"><button class="btn btn--primary" id="btn_save_prov_${pId}" type="button">保存供应商配置</button></div>`}</div>`;

    wrap.innerHTML = `<div class="form-grid">${[
      fg('供应商标识 / 名称', `<input class="input" id="ed_p_name_${pId}" value="${eh(p.name || pId)}"${lockAttr}>`),
      fg('Base URL', `<div class="input-row"><input class="input input--code" id="ed_p_base_${pId}" value="${eh(p.base_url || '')}"${lockAttr}><button class="btn" id="btn_detect_ed_${pId}" type="button" ${isHubMode() || isVaultProv ? 'hidden' : ''}>自动探测</button></div>`),
      fg('上游协议类型', apiTypeSelectHtml),
      // Plan C: rpm_per_key is the provider's OVERALL RPM ceiling — it lives at
      // the top of the provider editor, not folded away and not per-key.
      fg('该供应商整体 RPM 上限 (rpm_per_key)', `<input class="input" id="ed_p_rpm_${pId}" type="number" value="${p.rpm_per_key || ''}" placeholder="0 = 不限"${lockAttr}>`),
      fg('Anthropic Base URL (可选)', `<input class="input input--code" id="ed_p_ant_${pId}" value="${eh(p.anthropic_base_url || '')}"${lockAttr}>`),
      fg('预设规则绑定', `<input class="input input--code" id="ed_p_preset_${pId}" value="${eh(p.preset_id || '')}" placeholder="如 minimax, deepseek"${lockAttr}>${presetVersionHint}`),
      `<div class="form-group"><label class="form-label form-label--check"><input type="checkbox" id="ed_p_hide_ua_${pId}" ${p.hide_client_name ? 'checked' : ''}${lockAttr}><span>隐藏客户端 User-Agent</span></label></div>`,
    ].join('')}</div><details class="headers-details mt-3"><summary class="form-label">高级配置 (配额重置、模型别名与适配器规则)</summary><div class="form-grid mt-2">${[
      fg('每日重置时间 (quota_reset_at)', `<input class="input" id="ed_p_reset_${pId}" value="${eh(p.quota_reset_at || '00:00+08:00')}">`),
      fg('模型别名映射 (每行 对外名=上游名)', `<textarea class="textarea input--code" id="ed_p_aliases_${pId}" placeholder="fast-model=deepseek-chat">${eh(aliasText)}</textarea>`),
      fg('声明式适配规则 (adapter_rules JSON，中枢托管时只读)', `<textarea class="textarea textarea--json" id="ed_p_rules_${pId}" placeholder='{"stream_only":false}'${lockAttr}>${eh(adapterText)}</textarea>`),
    ].join('')}</div></details>${vaultNotice}<div class="section-bar mt-4"><span class="form-label">API 密钥池 (${keys.length})</span><div class="fields"><button class="btn btn--sm" id="btn_batch_test_keys_${pId}" type="button">一键测全部 Key</button><button class="btn btn--sm" id="btn_oauth_start_${pId}" type="button" ${showOAuth ? '' : 'hidden'}>OAuth 扫码登录</button></div></div><div class="snippet-box hidden mb-3" id="oauth_box_${pId}" hidden><div class="snippet-header"><span class="form-label">MiniMax OAuth 设备授权码:</span><span class="pill pill--amber" id="oauth_status_${pId}">等待扫码...</span></div><div class="text-sm mt-1">请点击访问：<a id="oauth_link_${pId}" target="_blank" rel="noopener noreferrer" class="tabular"></a> 并在页面中输入验证码：<strong class="tabular" id="oauth_code_${pId}"></strong></div></div><div class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>启用</th><th>标签</th><th>Key 密文</th><th>权重</th>${isHubMode() ? '' : '<th>归属</th>'}<th>状态</th><th>操作</th></tr></thead><tbody id="p_keys_tbody_${pId}"></tbody></table></div></div>${vaultKeyPickHtml}<div class="section-bar mt-4"><span class="form-label">模型探测与一键纳管</span><div class="fields"><button class="btn btn--sm" id="btn_probe_prov_${pId}" type="button">探测模型</button></div></div><div id="probe_pills_container_${pId}" class="hidden" hidden><div class="section-bar mt-1"><input class="input input--code flex-1 mr-2" id="probe_pills_filter_${pId}" placeholder="过滤探测到的模型..."><span class="text-muted text-xs" id="probe_pills_count_${pId}"></span></div><div class="probe-pills-wrap" id="probe_pills_list_${pId}"></div></div>${editorActionsHtml}`;

    const tbody = q(`#p_keys_tbody_${pId}`);
    if (tbody && !tbody.dataset.revealWired) {
      tbody.dataset.revealWired = '1';
      tbody.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('.btn_reveal_key') : null;
        if (!btn) return;
        ev.stopPropagation();
        const code = byIdIn(tbody, btn.dataset.target);
        if (!code) return;
        const masked = code.dataset.masked === '1';
        if (masked) {
          code.textContent = code.dataset.full || code.textContent;
          code.dataset.masked = '0';
          btn.textContent = '隐藏';
        } else {
          code.textContent = code.dataset.mask || code.textContent;
          code.dataset.masked = '1';
          btn.textContent = '显示';
        }
      });
    }
    keys.forEach((k, idx) => {
      const tr = ce('tr');
      const keyLabel = k.label || k.id || `key-${idx}`;
      const cdInfo = findKeyCooldown(pId, k, idx);
      const cooldownSec = cdInfo.sec;
      const cdTarget = cdInfo.target;
      let statusHtml = cooldownSec > 0
        ? `<button class="btn btn--sm btn--danger btn_clear_k_cd tabular" type="button" title="点击解除此 Key 冷却">冷却 ${formatCooldown(cooldownSec)} · 解除</button>`
        : '<span class="pill pill--green">就绪</span>';
      if (cooldownSec <= 0 && k.last_ok === true) {
        statusHtml = `<span class="pill pill--green tabular">正常 ${k.last_latency_ms || 0}ms</span>`;
      } else if (cooldownSec <= 0 && k.last_ok === false) {
        statusHtml = `<span class="pill pill--red">异常${k.last_status ? ` (${k.last_status})` : ''}</span>`;
      }

      const vaultKey = !isHubMode() && (isVaultProv || k.origin === 'vault');
      tr.innerHTML = `
        <td><input type="checkbox" class="k_enable_cb" data-idx="${idx}" ${k.enabled !== false ? 'checked' : ''} ${vaultKey ? 'disabled title="中枢下发的 Key 不可在节点修改"' : ''}></td>
        <td><strong>${eh(keyLabel)}</strong>${k.auth_type === 'oauth_device' ? ' <span class="pill pill--accent">OAuth</span>' : ''}</td>
        <td>${renderKeyCell(k, vaultKey, idx)}</td>
        <td><div class="input-row"><input class="input input--compact tabular k_weight_in" type="number" min="1" value="${k.weight || 1}" title="权重" ${vaultKey ? 'disabled' : ''}></div></td>
        ${isHubMode() ? '' : `<td><span class="pill">${vaultKey ? '中枢只读' : '本地'}</span></td>`}
        <td>${statusHtml}</td>
        <td>
          <div class="fields">
            <button class="btn btn--sm btn_verify_k" data-idx="${idx}" type="button">校验</button>
            <button class="btn btn--sm btn--danger btn_del_k" data-idx="${idx}" type="button">删除</button>
          </div>
        </td>
      `;

      tr.querySelector('.k_weight_in')?.addEventListener('change', (e) => {
        k.weight = Math.max(1, Number(e.target.value) || 1);
      });
      // Key-row RPM input removed (plan C): rpm_per_key is provider-wide and is
      // edited at the top of this editor; an existing api_keys[].max_rpm from an
      // older config keeps its key-level meaning but is no longer editable here.
      tr.querySelector('.btn_clear_k_cd')?.addEventListener('click', () => {
        clearSingleCooldown(cdTarget);
      });

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

      clk(tr.querySelector('.btn_verify_k'), async () => {
        syncDraftFields();
        const baseUrl = p.base_url || '';
        toast(`正在校验 Key [${keyLabel}]...`, 'info');
        try {
          const res = await window.HOST.verifyKey({
            provider: pId,
            api_key: k.key,
            key: k.key,
            key_label: keyLabel,
            base_url: baseUrl,
            api_type: normalizeApiType(p.api_type),
          });
          syncVersionFromRes(res);
          if (res && (res.valid === true || (res.ok && res.valid !== false && res.latency_ms !== undefined))) {
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

      const delKeyBtn = tr.querySelector('.btn_del_k');
      if (delKeyBtn) {
        clk(delKeyBtn, async () => {
          const refs = routesUsingKey(pId, keyLabel);
          if (refs.length > 0) {
            const ok = window.confirm(
              `Key [${keyLabel}] 正被以下路由引用：\n${refs.join('\n')}\n\n删除后这些路由将没有可用 Key，请求可能返回 503。仍要删除？`
            );
            if (!ok) return;
          }
          syncDraftFields();
          p.api_keys.splice(idx, 1);
          if (isVaultProv || vaultKey) {
            // Vault provider has no「保存供应商配置」button: the deletion must
            // land immediately. The hub copy is untouched —「从中枢添加」or a
            // full refetch restores the key locally.
            await persistConfig(`本地已删除 Key [${keyLabel}]（中枢不受影响，可经「从中枢添加」或「重新拉取」恢复）`);
          } else {
            renderProvidersList();
          }
        });
      }

      tbody.appendChild(tr);
    });

    // Batch Test All Keys (via verifyKey)
    clk(q(`#btn_batch_test_keys_${pId}`), async () => {
      syncDraftFields();
      toast(`正在一键测试 ${keys.length} 把 Key...`, 'info');
      let succ = 0;
      const baseUrl = p.base_url || '';
      const selType = normalizeApiType(p.api_type);
      for (const k of keys) {
        try {
          const r = await window.HOST.verifyKey({
            provider: pId,
            api_key: k.key,
            base_url: baseUrl,
            key_label: k.label,
            api_type: selType,
          });
          syncVersionFromRes(r);
          if (r && (r.valid === true || (r.ok && r.valid !== false))) {
            k.last_ok = true;
            k.last_latency_ms = r.latency_ms ?? r.ms ?? 0;
            succ++;
          } else {
            k.last_ok = false;
            k.last_status = r?.status || 0;
          }
        } catch (_) {}
      }
      toast(`一键测试完成: ${succ}/${keys.length} 把 Key 正常可用`, succ === keys.length ? 'ok' : 'warn');
      renderProvidersList();
    });

    // OAuth Device Flow (MiniMax only, non-vault provider)
    const oauthBtn = q(`#btn_oauth_start_${pId}`);
    if (oauthBtn && showOAuth) {
      clk(oauthBtn, async () => {
        stopOAuthPolling();
        toast('正在发起 OAuth 设备登录请求...', 'info');
        try {
          const res = await window.HOST.startOAuth({ endpoint: 'https://api.minimax.chat/oauth/device/code' });
          if (res && (res.ok || res.device_code)) {
            const box = q(`#oauth_box_${pId}`);
            box.hidden = false;
            box.classList.remove('hidden');
            const link = q(`#oauth_link_${pId}`);
            const uri = String(res.verification_uri || 'https://api.minimax.chat').trim();
            if (/^https?:\/\//i.test(uri)) {
              link.href = uri;
            } else {
              link.removeAttribute('href');
            }
            link.textContent = uri || '前往授权页面';
            q(`#oauth_code_${pId}`).textContent = res.user_code || res.device_code;

            const intervalSec = (res.interval || 5) * 1000;
            state.oauthPollTimer = setInterval(async () => {
              try {
                const pollRes = await window.HOST.pollOAuth({
                  device_code: res.device_code,
                  endpoint: 'https://api.minimax.chat/oauth/token',
                });
                const tok = pollRes?.token && typeof pollRes.token === 'object' ? pollRes.token : pollRes;
                if (pollRes && pollRes.ok && tok && tok.access_token) {
                  stopOAuthPolling();
                  const stEl = q(`#oauth_status_${pId}`);
                  if (stEl) stEl.textContent = '授权成功！';
                  p.api_keys = p.api_keys || [];
                  const expIn = Number(tok.expires_in) || 0;
                  p.api_keys.push({
                    id: `k_oauth_${Date.now().toString(36)}`,
                    label: nextKeyLabel(p.api_keys, 'oauth'),
                    key: tok.access_token,
                    enabled: true,
                    origin: 'local',
                    auth_type: 'oauth_device',
                    oauth_meta: {
                      provider: 'minimax',
                      refresh_token: tok.refresh_token || '',
                      expires_at: expIn > 0 ? Math.floor(Date.now() / 1000) + expIn : 0,
                    },
                  });
                  await persistConfig('OAuth 授权成功，密钥已保存');
                } else if (pollRes && pollRes.status === 'expired') {
                  stopOAuthPolling();
                  const stEl = q(`#oauth_status_${pId}`);
                  if (stEl) stEl.textContent = '授权已过期，请重试';
                }
              } catch (_) {}
            }, intervalSec);
            state.oauthExpireTimer = setTimeout(() => stopOAuthPolling(), (res.expires_in || 300) * 1000);
          } else {
            toast(res?.error || '发起 OAuth 失败', 'err');
          }
        } catch (e) {
          toast(e.message, 'err');
        }
      });
    }

    // Restore previously probed models if present
    renderProbePillsForProvider(q, pId, p);

    // Probe Models and Persistent Clickable Pills (P0-08)
    clk(q(`#btn_probe_prov_${pId}`), async () => {
      syncDraftFields();
      const baseUrl = p.base_url || '';
      const firstKey = p.api_keys?.[0]?.key || '';
      toast(`正在探测供应商 ${pId} 模型...`, 'info');
      try {
        const res = await window.HOST.probeModels({
          provider: pId,
          base_url: baseUrl,
          api_key: firstKey,
          api_type: normalizeApiType(p.api_type),
        });
        const models = res?.models || [];
        if (models.length > 0) {
          state.probedModelsByProvider[pId] = models;
          toast(`探测成功: 发现 ${models.length} 个可用模型`, 'ok');
          renderProbePillsForProvider(q, pId, p);
        } else {
          toast(res?.error ? `未探测到模型: ${res.error}` : '未探测到可用模型列表', 'warn');
        }
      } catch (e) {
        toast(`探测异常: ${e.message}`, 'err');
      }
    });

    const addKeyBtn = q(`#btn_add_key_${pId}`);
    if (addKeyBtn && !isVaultProv) {
      clk(addKeyBtn, () => {
        const lbl = q(`#new_key_lbl_${pId}`)?.value.trim() || '';
        const val = q(`#new_key_val_${pId}`)?.value.trim() || '';
        if (!val) return toast('请填写密钥内容', 'warn');
        const parsed = parseMultiApiKeys(val, lbl, p.api_keys || [], isHubMode() ? 'vault' : 'local');
        if (parsed.error) return toast(parsed.error, 'warn');
        syncDraftFields();
        p.api_keys = p.api_keys || [];
        p.api_keys.push(...parsed.keys);
        renderProvidersList();
      });
    }

    // Vault provider: pull missing key labels from the hub manifest on demand.
    if (isVaultProv) {
      const pickBtn = q(`#btn_vault_add_keys_${pId}`);
      const pickBox = q(`#vault_keys_pick_${pId}`);
      const actionsBox = q(`#vault_keys_actions_${pId}`);
      const fetchBtn = q(`#btn_vault_fetch_keys_${pId}`);
      const pickedLabels = new Set();
      const hideActions = () => {
        if (actionsBox) {
          actionsBox.hidden = true;
          actionsBox.classList.add('hidden');
        }
      };
      const renderKeyPick = () => {
        if (!pickBox) return;
        pickBox.innerHTML = '';
        pickedLabels.clear();
        hideActions();
        if (!manifestProv) {
          const empty = ce('span');
          empty.className = 'text-xs text-muted';
          empty.textContent = '中枢清单未加载，无法补拉（请稍后重试或检查 Vault 连接）';
          pickBox.appendChild(empty);
          return;
        }
        const localLabels = new Set(keys.map((k) => k.label || k.id).filter(Boolean));
        const missing = (Array.isArray(manifestProv.keys) ? manifestProv.keys : []).filter((lbl) => !localLabels.has(lbl));
        if (missing.length === 0) {
          const empty = ce('span');
          empty.className = 'text-xs text-muted';
          empty.textContent = '中枢清单中没有本地缺失的 Key 标签';
          pickBox.appendChild(empty);
          return;
        }
        for (const lbl of missing) {
          const pill = ce('button');
          pill.type = 'button';
          pill.className = 'probe-pill';
          pill.textContent = lbl;
          clk(pill, () => {
            if (pickedLabels.has(lbl)) pickedLabels.delete(lbl);
            else pickedLabels.add(lbl);
            pill.classList.toggle('probe-pill--managed', pickedLabels.has(lbl));
            if (actionsBox) {
              actionsBox.hidden = pickedLabels.size === 0;
              actionsBox.classList.toggle('hidden', pickedLabels.size === 0);
            }
          });
          pickBox.appendChild(pill);
        }
      };
      if (pickBtn && pickBox) {
        clk(pickBtn, () => {
          renderKeyPick();
          toggle(pickBox);
          if (pickBox.hidden) hideActions();
        });
      }
      if (fetchBtn) {
        clk(fetchBtn, async () => {
          if (pickedLabels.size === 0) return toast('请先勾选要补拉的 Key 标签', 'warn');
          fetchBtn.disabled = true;
          toast(`正在补拉 ${pickedLabels.size} 个 Key 标签...`, 'info');
          try {
            const res = await window.HOST.fetchVaultCredentials(pId, undefined, undefined, undefined, [...pickedLabels]);
            if (res && res.ok) {
              toast(`已补拉 ${pickedLabels.size} 个 Key 标签`, 'ok');
              await loadData();
            } else {
              toast(`补拉失败: ${scrubUiText(res?.error || '请求未成功')}`, 'err');
            }
          } catch (e) {
            toast(`补拉异常: ${e.message}`, 'err');
          } finally {
            fetchBtn.disabled = false;
            if (pickBox) {
              pickBox.hidden = true;
              pickBox.classList.add('hidden');
            }
            hideActions();
          }
        });
      }
    }

    // Vault provider: one-shot refetch (rules + all keys), then reload.
    const refetchBtn = q(`#btn_refetch_prov_${pId}`);
    if (refetchBtn) {
      clk(refetchBtn, async () => {
        refetchBtn.disabled = true;
        toast(`正在重新拉取供应商 ${pId}（规则与全部 Key）...`, 'info');
        try {
          const res = await window.HOST.fetchVaultCredentials(pId);
          if (res && res.ok) {
            await loadData();
            // The refetch replaces the vault key list wholesale (keys the hub no
            // longer holds disappear): the route-card dot only counts candidates,
            // so flag routes whose candidates now bind to missing key labels.
            const provs = state.config?.providers || {};
            const dangling = Object.entries(state.config?.agent_models || {})
              .filter(([n2, m2]) => templateRouteMissingKeyLabels(n2, m2, provs).length > 0)
              .map(([n2]) => n2);
            toast(dangling.length
              ? `警告: 路由 ${dangling.join('、')} 有候选绑定的 Key 已缺失，请编辑候选池`
              : `供应商 ${pId} 已按中枢最新内容重新拉取`, dangling.length ? 'warn' : 'ok');
          } else {
            toast(`重新拉取失败: ${scrubUiText(res?.error || '请求未成功')}`, 'err');
          }
        } catch (e) {
          toast(`重新拉取异常: ${e.message}`, 'err');
        } finally {
          refetchBtn.disabled = false;
        }
      });
    }

    clk(q(`#btn_save_prov_${pId}`), async () => {
      syncDraftFields();
      delete p.refresh_every;
      delete p.auto_include;

      const rawAliases = q(`#ed_p_aliases_${pId}`)?.value || '';
      const aliasMap = {};
      rawAliases.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes('=')) return;
        const eqIdx = trimmed.indexOf('=');
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        if (k && v) aliasMap[k] = v;
      });
      if (Object.keys(aliasMap).length > 0) p.model_aliases = aliasMap;
      else delete p.model_aliases;

      const rawRules = (q(`#ed_p_rules_${pId}`)?.value || '').trim();
      if (rawRules) {
        try {
          p.adapter_rules = JSON.parse(rawRules);
        } catch (err) {
          return toast(`adapter_rules JSON 格式有误: ${err.message}`, 'err');
        }
      } else {
        delete p.adapter_rules;
      }

      if (isHubMode()) {
        p.origin = 'vault';
        (p.api_keys || []).forEach((k) => { if (k) k.origin = 'vault'; });
      }

      await persistConfig('供应商保存成功');
    });

    clk(q(`#btn_del_prov_${pId}`), async () => {
      if (!confirm(`确定删除供应商 ${pId} 吗？`)) return;
      delete state.config.providers[pId];
      delete state.probedModelsByProvider[pId];
      delete state.probeFilterByProvider[pId];
      state.activeEditorKey = null;
      await persistConfig(isVaultProv ? `供应商 ${pId} 已从本地删除（中枢不受影响，可重新按需拉取）` : '供应商已删除');
    });

    return wrap;
  }

  // --- Hub Node Scope: checkbox groups (issue form + node editor) ---
  // Master「全量 (*)」checked = scope ['*'] with the list collapsed; unchecked =
  // expanded explicit checkboxes (empty selection = scope [], i.e. nothing).
  function renderScopeCheckboxGroup(container, optionList) {
    if (!container) return;
    container.innerHTML = '';
    for (const opt of optionList || []) {
      const lbl = ce('label');
      lbl.className = 'form-label form-label--check';
      const cb = ce('input');
      cb.type = 'checkbox';
      cb.value = opt;
      const txt = ce('span');
      txt.textContent = opt;
      lbl.appendChild(cb);
      lbl.appendChild(txt);
      container.appendChild(lbl);
    }
  }

  function collectScopeSelection(container) {
    const vals = [];
    container?.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if (cb.checked) vals.push(cb.value);
    });
    return vals;
  }

  function mountScopeControls(masterEl, listEl, options, selected) {
    renderScopeCheckboxGroup(listEl, options || []);
    const isAll = Array.isArray(selected) && selected.includes('*');
    if (masterEl) {
      masterEl.checked = isAll;
      masterEl.onchange = () => {
        if (listEl) listEl.hidden = masterEl.checked;
      };
    }
    if (listEl) {
      listEl.hidden = isAll;
      if (!isAll && Array.isArray(selected)) {
        listEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          cb.checked = selected.includes(cb.value);
        });
      }
    }
  }

  function templateScopeOptions() {
    return {
      providers: Object.keys(state.config?.providers || {}).sort(),
      models: Object.keys(state.config?.agent_models || {}).sort(),
    };
  }

  function currentScopeSelection(listEl, masterEl) {
    // Preserve uncommitted operator picks across re-mounts: loadData fires on login,
    // config import, and conflict rollbacks — none of them may reset an open issue
    // form back to「全量」. First mount (no checkboxes rendered yet) defaults to ['*'].
    if (!listEl || !listEl.querySelector('input[type="checkbox"]')) return ['*'];
    if (masterEl?.checked) return ['*'];
    return collectScopeSelection(listEl);
  }

  function mountIssueScopeLists() {
    if (!isHubMode()) return;
    const opts = templateScopeOptions();
    mountScopeControls(
      $('issueNodeProvAll'),
      $('issueNodeProvs'),
      opts.providers,
      currentScopeSelection($('issueNodeProvs'), $('issueNodeProvAll'))
    );
    mountScopeControls(
      $('issueNodeModelAll'),
      $('issueNodeModels'),
      opts.models,
      currentScopeSelection($('issueNodeModels'), $('issueNodeModelAll'))
    );
  }

  // --- View: Nodes (Hub mode) ---
  // In-memory only (never sessionStorage/localStorage): the plaintext NODE_TOKEN
  // of the most recent issuance/rotation, so the install overlay can be re-opened
  // within the same session without forcing another rotation. A page refresh
  // forgets it, and re-opening the overlay then falls back to rotate-and-show.
  const nodeTokenMem = new Map();
  // Full-node ADMIN_PASSWORDs are generated client-side (the hub never stores
  // them), so keep them stable per node within a session: re-opening the install
  // overlay must not silently mint a different password into the command.
  const nodeAdminPassMem = new Map();
  let nodeInstallReturnEl = null;

  function getStableNodeAdminPass(nodeId, role) {
    if (role !== 'full') return '';
    let pass = nodeAdminPassMem.get(nodeId);
    if (!pass) {
      pass = generateRandomAlphaNum(20);
      nodeAdminPassMem.set(nodeId, pass);
    }
    return pass;
  }

  function openNodeInstallOverlay(nodeId, material, opts = {}) {
    const overlay = $('nodeInstallOverlay');
    if (!overlay) return;
    const node = (state.nodes || []).find((n) => n.id === nodeId);
    const role = (material.node && material.node.role) || (node && node.role) || 'lite';
    const titleEl = $('nodeInstallTitle');
    const subEl = $('nodeInstallSub');
    const rotNotice = $('nodeInstallRotateNotice');
    const staleHint = $('nodeInstallStaleHint');
    if (titleEl) titleEl.textContent = `一键安装 — ${node?.name || nodeId}`;
    if (subEl) subEl.textContent = '在目标服务器上以 root 执行以下命令完成安装；安装成功后本列表将显示为在线';
    if (rotNotice) rotNotice.hidden = !opts.rotated;
    // A cache-hit open (same tab, no rotation) may still hold a token another
    // tab has rotated away since; tell the operator what to do when the
    // command never brings the node online.
    if (staleHint) staleHint.hidden = !!opts.rotated || !opts.fromCache;
    mountNodeCommandPanel($('nodeInstallPanel'), {
      role,
      hubUrl: window.location.origin,
      nodeToken: material.node_token,
      clientKey: material.client_key,
      bootstrapEnv: material.bootstrap_env,
      adminPass: getStableNodeAdminPass(nodeId, role),
    });
    overlay.hidden = false;
    overlay.classList.remove('hidden');
    // Move focus into the overlay so Esc / the close button are reachable
    // without tabbing through the page behind it, and remember where to
    // return focus on close.
    nodeInstallReturnEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeBtn = $('btnCloseNodeInstall');
    if (closeBtn) closeBtn.focus();
  }

  function closeNodeInstallOverlay() {
    const overlay = $('nodeInstallOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.add('hidden');
    const back = nodeInstallReturnEl;
    nodeInstallReturnEl = null;
    if (back && document.contains(back)) back.focus();
  }

  async function handleNodeInstallClick(nodeId) {
    const cached = nodeTokenMem.get(nodeId);
    if (cached && cached.node_token) {
      openNodeInstallOverlay(nodeId, cached, { rotated: false, fromCache: true });
      return;
    }
    // No in-memory token (page was refreshed): the hub only stores the SHA-256
    // digest, so the only spec-compliant way back to a plaintext install command
    // is rotating the token. Confirm before invalidating the old credential.
    const node = (state.nodes || []).find((n) => n.id === nodeId);
    if (!confirm(`安装命令包含节点 Token，出于安全仅在签发时显示一次。\n现在重新获取将轮换 ${node?.name || nodeId} 的 Token（旧 Token 立即失效），继续吗？`)) {
      return;
    }
    try {
      const res = await window.HOST.getNodeInstallCommand(nodeId);
      if (res && res.ok && res.node_token) {
        nodeTokenMem.set(nodeId, res);
        openNodeInstallOverlay(nodeId, res, { rotated: true });
        await loadNodesData();
      } else {
        toast((res && res.error) || '获取安装命令失败', 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function renderNodesList() {
    const container = $('nodesList');
    if (!container) return;
    container.innerHTML = '';

    const nodes = state.nodes || [];
    if (nodes.length === 0) {
      const emptyRow = ce('div');
      emptyRow.className = 'row row--static text-muted';
      emptyRow.textContent = '暂无中转节点，点击上方「添加节点」创建';
      container.appendChild(emptyRow);
      return;
    }

    const table = ce('table');
    table.className = 'data-table';
    const thead = ce('thead');
    thead.innerHTML = '<tr><th>名称</th><th>IP</th><th>状态</th><th>操作</th></tr>';
    table.appendChild(thead);
    const tbody = ce('tbody');

    for (const node of nodes) {
      const tr = ce('tr');

      const nameTd = ce('td');
      const isExpanded = state.activeEditorKey === `node_${node.id}`;
      nameTd.innerHTML = `<strong>${eh(node.name || node.id)}</strong> <span class="pill pill--accent">${eh(node.role || 'full')}</span>${node.last_binary_version ? ` <span class="pill tabular">${eh(node.last_binary_version)}</span>` : ''}`;

      const ipTd = ce('td');
      ipTd.className = 'tabular';
      ipTd.textContent = node.last_ip || '—';

      const snap = getNodeSyncSnapshotStatus(node);
      // Two separate clocks by design: the table's "online" follows the hub
      // overview's liveness bar (15 min since last sync), while the lease state
      // (synced/grace/expired) keeps the lifetime semantics.
      const ONLINE_MS = 15 * 60 * 1000;
      const online = node.enabled !== false && Boolean(snap.syncMs) && (Date.now() - snap.syncMs) <= ONLINE_MS;
      let statusPill;
      if (node.enabled === false) statusPill = `<span class="pill ${snap.pillCls}">${eh(snap.label)}</span>`;
      else if (online) statusPill = '<span class="pill pill--green">在线</span>';
      else if (snap.syncMs) statusPill = `<span class="pill pill--amber">${snap.key === 'grace' ? '宽限期内' : '离线'}</span>`;
      else statusPill = '<span class="pill">未安装</span>';
      const statusTd = ce('td');
      statusTd.innerHTML = `${statusPill}<div class="text-sm text-muted">${snap.syncMs ? `最后同步 ${formatTime(snap.syncMs / 1000)}` : '尚未安装'}</div>`;

      const actionTd = ce('td');
      const installBtn = ce('button');
      installBtn.className = 'btn btn--sm';
      installBtn.type = 'button';
      installBtn.textContent = '安装';
      const editBtn = ce('button');
      editBtn.className = 'btn btn--sm';
      editBtn.type = 'button';
      editBtn.textContent = isExpanded ? '收起' : '编辑';
      actionTd.appendChild(installBtn);
      actionTd.appendChild(editBtn);
      actionTd.appendChild(document.createTextNode(' '));

      clk(installBtn, () => handleNodeInstallClick(node.id));
      clk(editBtn, () => {
        state.activeEditorKey = isExpanded ? null : `node_${node.id}`;
        renderNodesList();
      });

      tr.appendChild(nameTd);
      tr.appendChild(ipTd);
      tr.appendChild(statusTd);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);

      if (isExpanded) {
        const editorTr = ce('tr');
        const editorTd = ce('td');
        editorTd.colSpan = 4;
        const editor = ce('div');
        editor.className = 'editor';
        editor.appendChild(buildNodeEditor(node));
        editorTd.appendChild(editor);
        editorTr.appendChild(editorTd);
        tbody.appendChild(editorTr);
      }
    }

    table.appendChild(tbody);
    const wrap = ce('div');
    wrap.className = 'table-wrap';
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  // Node list auto-refresh: the promised UX is "install succeeds → the row turns
  // online", and a node's only signal is its periodic config sync (last_seen).
  // 15s mirrors the hub overview's online threshold granularity.
  function startNodesPolling() {
    if (state.nodesTimer) clearInterval(state.nodesTimer);
    if (!window.HOST.capabilities.nodeManager) return;
    state.nodesTimer = setInterval(async () => {
      if (document.visibilityState === 'hidden' || !window.HOST.getToken()) return;
      if (state.activeTab !== 'nodes') return;
      // Skip while the install overlay is open: re-rendering under it is fine,
      // but a failed refresh behind the modal silently resets the editor state.
      if (!$('nodeInstallOverlay')?.hidden) return;
      if (state.activeEditorKey && state.activeEditorKey.startsWith('node_')) return;
      try {
        const res = await window.HOST.getNodes();
        if (res && res.ok) {
          state.nodes = res.nodes || [];
          renderNodesList();
        }
      } catch (_) {}
    }, 15000);
  }

  function buildNodeShellCommands(opts) {
    const cleanHub = String(opts.hubUrl || window.location.origin).replace(/\/+$/, '');
    const role = opts.role === 'full' ? 'full' : 'lite';
    const port = Math.max(1, Math.min(65535, Number(opts.port) || 8787));
    const token = String(opts.nodeToken || '').trim();
    const clientKey = String(opts.clientKey || '').trim().replace(/["'$`\\\s]/g, '');
    const adminPass = String(opts.adminPass || '').trim().replace(/["'$`\\\s]/g, '');

    if (opts.mode === 'docker') {
      // Verified against a real container run: the data dir must be an absolute path
      // created before the run (Docker would otherwise create it as root), and the
      // image needs no --user for that to work.
      const vol = `-v "$(pwd)/llmproxy-data:/data"`;
      const common = `-p ${port}:8787`;
      const hubEnv = `-e LLMPROXY_HUB_URL="${cleanHub}" -e LLMPROXY_NODE_TOKEN="${token}"${clientKey ? ` -e LLMPROXY_CLIENT_KEY="${clientKey}"` : ''}`;
      if (role === 'full') {
        return `mkdir -p "$(pwd)/llmproxy-data" && docker run -d --name llmproxy-full --restart unless-stopped ${common} ${vol} -e LLMPROXY_ROLE=full -e CONFIG_DIR=/data -e ADMIN_PASSWORD="${adminPass}" ${hubEnv} ghcr.io/khc8655/ocrprox2:latest`;
      }
      // Lite is zero-disk by design: no volume needed at all.
      return `docker run -d --name llmproxy-lite --restart unless-stopped ${common} -e LLMPROXY_ROLE=lite ${hubEnv} ghcr.io/khc8655/ocrprox2:latest`;
    }

    if (opts.mode === 'binary') {
      // One-liner that actually works from a bare shell: detect arch, download the
      // matching release asset, verify nothing is required beyond the binary, run it.
      // Previously this assumed the binary was already in the current directory.
      const archDetect = `ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')`;
      const fetch = `mkdir -p ./llmproxy-data && cd ./llmproxy-data && curl -fL --retry 2 -o llmproxy "https://github.com/khc8655/ocrprox2/releases/latest/download/llmproxy-linux-\${ARCH}" && chmod +x ./llmproxy`;
      if (role === 'full') {
        return `${archDetect} && ${fetch} && ADMIN_PASSWORD="${adminPass}" CONFIG_DIR="$(pwd)/cfg" LLMPROXY_ROLE=full LLMPROXY_HUB_URL="${cleanHub}" LLMPROXY_NODE_TOKEN="${token}"${clientKey ? ` LLMPROXY_CLIENT_KEY="${clientKey}"` : ''} ./llmproxy --addr="[::]:${port}"`;
      }
      return `${archDetect} && ${fetch} && LLMPROXY_ROLE=lite LLMPROXY_HUB_URL="${cleanHub}" LLMPROXY_NODE_TOKEN="${token}"${clientKey ? ` LLMPROXY_CLIENT_KEY="${clientKey}"` : ''} ./llmproxy --addr="[::]:${port}"`;
    }

    let scriptUrl = `${cleanHub}/install.sh`;
    if (opts.scriptSource === 'ghraw') {
      scriptUrl = 'https://raw.githubusercontent.com/khc8655/ocrprox2/main/install.sh';
    } else if (opts.scriptSource === 'ghfast') {
      scriptUrl = 'https://ghfast.top/https://raw.githubusercontent.com/khc8655/ocrprox2/main/install.sh';
    }

    const flags = [
      `--role=${role}`,
      `--hub-url="${cleanHub}"`,
      `--node-token="${token}"`,
    ];
    if (role === 'full' && adminPass) flags.push(`--admin-password="${adminPass}"`);
    if (clientKey) flags.push(`--client-key="${clientKey}"`);
    flags.push(`-p ${port}`);
    if (opts.mirror === 'ghfast') flags.push('--mirror="https://ghfast.top"');
    if (opts.autoYes) flags.push('-y');
    return `curl -fsSL ${scriptUrl} | sudo bash -s -- ${flags.join(' ')}`;
  }

  function mountNodeCommandPanel(container, payload) {
    if (!container) return;
    const role = payload.role === 'full' ? 'full' : 'lite';
    const clientKey = payload.clientKey || (state.config?.settings?.client_key || state.config?.settings?.proxy_api_key || '');
    const hubUrl = payload.hubUrl || window.location.origin;
    // Full-node admin password: the caller passes a session-stable one (see
    // getStableNodeAdminPass); generate only when none was supplied (the
    // issuance/rotation inline panel mounts once, so a fresh value is right).
    const adminPass = role === 'full' ? (String(payload.adminPass || '').trim() || generateRandomAlphaNum(20)) : '';
    const panelState = {
      mode: 'install',
      port: 8787,
      scriptSource: 'hub',
      mirror: 'auto',
      autoYes: true,
      adminPass,
    };

    container.innerHTML = `<div class="snippet-box">
      <div class="snippet-header">
        <span class="form-label">节点快速部署与客户端接入指引</span>
        <div class="fields">
          <div class="seg" data-cmd-seg>
            <button class="seg-btn active" data-cmd-mode="install" type="button">一键安装 (systemd)</button>
            <button class="seg-btn" data-cmd-mode="docker" type="button">Docker 部署</button>
            <button class="seg-btn" data-cmd-mode="binary" type="button">单行直跑 (免安装)</button>
          </div>
          <button class="btn btn--sm" data-cmd-copy type="button">复制命令</button>
        </div>
      </div>
      ${role === 'full' ? `<div class="notice-strip notice-strip--warn mb-2">
        <span>Full 节点后台登录密码 (请妥善保存): <strong class="tabular">${eh(adminPass)}</strong></span>
        <button class="btn btn--sm" data-copy-admin-pass type="button">复制密码</button>
      </div>` : ''}
      <div class="notice-strip mb-2">
        <span>客户端接入信息 — <strong class="tabular" data-client-base-hint></strong> · API Key: <strong class="tabular">${eh(clientKey || '请先在系统设置配置主客户端密钥')}</strong></span>
        ${clientKey ? '<button class="btn btn--sm" data-copy-client-key type="button">复制 API Key</button>' : ''}
      </div>
      <div class="form-grid mb-2" data-cmd-opts>
        <div class="form-group">
          <label class="form-label">监听端口</label>
          <input class="input tabular" data-cmd-port type="number" min="1" max="65535" value="8787">
        </div>
        <div class="form-group" data-cmd-source-wrap>
          <label class="form-label">安装脚本源</label>
          <select class="select" data-cmd-source>
            <option value="hub">Hub 同域 /install.sh (推荐)</option>
            <option value="ghfast">ghfast.top 加速</option>
            <option value="ghraw">GitHub Raw 直连</option>
          </select>
        </div>
        <div class="form-group" data-cmd-mirror-wrap>
          <label class="form-label">二进制下载源</label>
          <select class="select" data-cmd-mirror>
            <option value="auto">GitHub 直连 + 国内自动回退</option>
            <option value="ghfast">优先走 ghfast.top 镜像</option>
          </select>
        </div>
        <div class="form-group" data-cmd-yes-wrap>
          <label class="form-label">交互方式</label>
          <label class="form-label form-label--check">
            <input type="checkbox" data-cmd-yes checked>
            <span>无人值守 (-y)，取消可交互确认</span>
          </label>
        </div>
      </div>
      <textarea class="textarea input--code" data-cmd-output readonly rows="3"></textarea>
    </div>`;

    const q = (sel) => container.querySelector(sel);
    const outEl = q('[data-cmd-output]');
    const portEl = q('[data-cmd-port]');
    const srcWrap = q('[data-cmd-source-wrap]');
    const mirrorWrap = q('[data-cmd-mirror-wrap]');
    const yesWrap = q('[data-cmd-yes-wrap]');
    const baseHintEl = q('[data-client-base-hint]');
    const srcEl = q('[data-cmd-source]');
    const mirrorEl = q('[data-cmd-mirror]');
    const yesEl = q('[data-cmd-yes]');

    const refresh = () => {
      const isInstall = panelState.mode === 'install';
      if (srcWrap) srcWrap.hidden = !isInstall;
      if (mirrorWrap) mirrorWrap.hidden = !isInstall;
      if (yesWrap) yesWrap.hidden = !isInstall;
      const port = Math.max(1, Math.min(65535, Number(panelState.port) || 8787));
      if (baseHintEl) {
        baseHintEl.textContent = `API Base URL: http://<VM_IP>:${port}/v1`;
      }
      if (outEl) {
        outEl.value = buildNodeShellCommands({
          ...panelState,
          role,
          hubUrl,
          nodeToken: payload.nodeToken,
          clientKey,
          bootstrapEnv: payload.bootstrapEnv,
        });
      }
    };

    container.querySelectorAll('[data-cmd-mode]').forEach((btn) => {
      clk(btn, () => {
        panelState.mode = btn.getAttribute('data-cmd-mode') || 'install';
        container.querySelectorAll('[data-cmd-mode]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        refresh();
      });
    });
    if (portEl) portEl.addEventListener('input', () => { panelState.port = portEl.value; refresh(); });
    if (srcEl) srcEl.addEventListener('change', () => { panelState.scriptSource = srcEl.value; refresh(); });
    if (mirrorEl) mirrorEl.addEventListener('change', () => { panelState.mirror = mirrorEl.value; refresh(); });
    if (yesEl) yesEl.addEventListener('change', () => { panelState.autoYes = yesEl.checked; refresh(); });
    const copyBtn = q('[data-cmd-copy]');
    if (copyBtn) clk(copyBtn, () => copyToClipboard(outEl?.value, '部署命令已复制'));
    const copyPassBtn = q('[data-copy-admin-pass]');
    if (copyPassBtn) clk(copyPassBtn, () => copyToClipboard(adminPass, '后台登录密码已复制'));
    const copyCkBtn = q('[data-copy-client-key]');
    if (copyCkBtn) clk(copyCkBtn, () => copyToClipboard(clientKey, '客户端 API Key 已复制'));
    refresh();
  }

  function buildNodeEditor(node) {
    const wrap = ce('div');
    const isEnabled = node.enabled;
    const id = node.id;
    const q = makeScopedQuery(wrap);

    wrap.innerHTML = `<div class="form-grid">${[
      fg('节点名称', `<input class="input" id="ed_node_name_${id}" value="${eh(node.name)}">`),
      fg('节点角色', `<select class="select" id="ed_node_role_${id}"><option value="full" ${node.role === 'full' ? 'selected' : ''}>Full (全功能代理网关)</option><option value="lite" ${node.role === 'lite' ? 'selected' : ''}>Lite (轻量本地代理)</option></select>`),
      fg('租约时长 (秒 lease_ttl)', `<input class="input tabular" id="ed_node_ttl_${id}" type="number" value="${node.lease_ttl || 86400}">`),
      fg('断网宽限期 (秒 grace_ttl)', `<input class="input tabular" id="ed_node_grace_${id}" type="number" value="${node.grace_ttl || 3600}">`),
      `<div class="form-group"><label class="form-label form-label--check"><input type="checkbox" id="ed_node_prov_all_${id}"><span>允许全部 LLM 供应商 (* 全量)</span></label><div class="mt-1" id="ed_node_provs_${id}"></div></div>`,
      `<div class="form-group"><label class="form-label form-label--check"><input type="checkbox" id="ed_node_model_all_${id}"><span>允许全部 LLM 模型 (* 全量)</span></label><div class="mt-1" id="ed_node_models_${id}"></div></div>`,
    ].join('')}</div><div class="form-actions form-actions--split"><div class="form-actions-group"><button class="btn btn--danger" id="btn_del_node_${id}" type="button">删除节点</button><button class="btn ${isEnabled ? 'btn--danger' : ''}" id="btn_toggle_node_${id}" type="button">${isEnabled ? '吊销/停用' : '恢复启用'}</button><button class="btn" id="btn_rotate_node_${id}" type="button">轮换 Token</button></div><div class="form-actions-group"><button class="btn btn--primary" id="btn_save_node_${id}" type="button">保存节点</button></div></div><div class="editor-section" id="node_token_display_box_${id}" hidden><div class="form-grid form-grid--2">${[
      fg('新 NODE_TOKEN (仅显示一次)', `<div class="input-row"><input class="input input--code" readonly id="node_new_token_val_${id}"><button class="btn" id="btn_copy_node_tok_${id}" type="button">复制</button></div>`),
      fg('启动环境变量', `<div class="input-row"><input class="input input--code" readonly id="node_new_env_val_${id}"><button class="btn" id="btn_copy_node_env_${id}" type="button">复制</button></div>`),
    ].join('')}</div><div class="mt-3" id="node_cmd_panel_${id}"></div></div>`;

    const tmplOpts = templateScopeOptions();
    // Scope entries that no longer match the current template options (providers/models
    // deleted on the hub since the node was scoped) have no checkbox to render. Preserve
    // them on save: dropping them silently would narrow the node's scope without the
    // operator seeing or choosing it.
    const staleScope = (scopeArr, options) =>
      [...new Set((Array.isArray(scopeArr) ? scopeArr : []).filter((v) => v !== '*' && !options.includes(v)))];
    const staleProviders = staleScope(node.scope?.providers, tmplOpts.providers);
    const staleModels = staleScope(node.scope?.models, tmplOpts.models);
    mountScopeControls(q(`#ed_node_prov_all_${id}`), q(`#ed_node_provs_${id}`), tmplOpts.providers, node.scope?.providers);
    mountScopeControls(q(`#ed_node_model_all_${id}`), q(`#ed_node_models_${id}`), tmplOpts.models, node.scope?.models);

    clk(q(`#btn_save_node_${id}`), async () => {
      const name = q(`#ed_node_name_${id}`).value.trim();
      const role = q(`#ed_node_role_${id}`)?.value || node.role;
      const leaseTtl = Number(q(`#ed_node_ttl_${id}`).value) || 86400;
      const graceTtl = Number(q(`#ed_node_grace_${id}`)?.value) || 3600;

      const scope = {
        providers: q(`#ed_node_prov_all_${id}`)?.checked
          ? ['*']
          : [...new Set([...staleProviders, ...collectScopeSelection(q(`#ed_node_provs_${id}`))])],
        models: q(`#ed_node_model_all_${id}`)?.checked
          ? ['*']
          : [...new Set([...staleModels, ...collectScopeSelection(q(`#ed_node_models_${id}`))])],
      };

      try {
        const res = await window.HOST.patchNode(id, { name, role, lease_ttl: leaseTtl, grace_ttl: graceTtl, scope });
        if (res && res.ok) { toast('节点配置更新成功', 'ok'); await loadNodesData(); }
        else toast(res.error || '更新失败', 'err');
      } catch (e) { toast(scrubUiText(e.message), 'err'); }
    });

    clk(q(`#btn_toggle_node_${id}`), async () => {
      try {
        const res = await window.HOST.patchNode(id, { enabled: !isEnabled });
        if (res && res.ok) { toast(isEnabled ? '节点已吊销' : '节点已恢复', 'ok'); await loadNodesData(); }
      } catch (e) { toast(e.message, 'err'); }
    });

    clk(q(`#btn_rotate_node_${id}`), async () => {
      if (!confirm('轮换 Token 会使旧 Token 立即失效，确定继续吗？')) return;
      try {
        const res = await window.HOST.rotateNode(id);
        if (res && res.ok) {
          toast('Token 轮换成功！', 'ok');
          if (res.node_token) nodeTokenMem.set(id, res);
          q(`#node_token_display_box_${id}`).hidden = false;
          q(`#node_new_token_val_${id}`).value = res.node_token;
          q(`#node_new_env_val_${id}`).value = res.bootstrap_env;
          mountNodeCommandPanel(q(`#node_cmd_panel_${id}`), {
            role: q(`#ed_node_role_${id}`)?.value || node.role || 'lite',
            hubUrl: window.location.origin,
            nodeToken: res.node_token,
            clientKey: res.client_key,
            bootstrapEnv: res.bootstrap_env,
          });
        }
      } catch (e) { toast(e.message, 'err'); }
    });

    clk(q(`#btn_copy_node_tok_${id}`), () => copyToClipboard(q(`#node_new_token_val_${id}`)?.value, 'NODE_TOKEN 已复制'));
    clk(q(`#btn_copy_node_env_${id}`), () => copyToClipboard(q(`#node_new_env_val_${id}`)?.value, '环境变量已复制'));

    clk(q(`#btn_del_node_${id}`), async () => {
      if (!confirm(`确认永久删除节点 ${node.name} 吗？`)) return;
      try {
        const res = await window.HOST.deleteNode(id);
        if (res && res.ok) {
          toast('节点已删除', 'ok');
          state.activeEditorKey = null;
          // Drop the in-memory token and admin password: the node is gone, and
          // its plaintext credential must not outlive it in this tab's memory.
          nodeTokenMem.delete(id);
          nodeAdminPassMem.delete(id);
          await loadNodesData();
        }
      } catch (e) { toast(e.message, 'err'); }
    });

    return wrap;
  }

  async function handleIssueNode() {
    const name = $('issueNodeName').value.trim();
    const role = $('issueNodeRole').value;
    // Collapsed advanced fields fall back to the server-side defaults (86400 /
    // 3600 / *): an empty input gives Number('') === 0, and 0 (like NaN) is
    // falsy, so the || default chain below handles both.
    const leaseTtl = Number($('issueNodeTTL').value) || 86400;
    const graceTtl = Number($('issueNodeGraceTTL')?.value) || 3600;

    if (!name) return toast('请输入节点名称', 'warn');

    // Master「全量 (*)」checked = ['*']; unchecked = explicit checkbox picks
    // (empty = [], i.e. nothing allowed).
    const scope = {
      providers: $('issueNodeProvAll')?.checked ? ['*'] : collectScopeSelection($('issueNodeProvs')),
      models: $('issueNodeModelAll')?.checked ? ['*'] : collectScopeSelection($('issueNodeModels')),
    };

    try {
      const res = await window.HOST.issueNode({ name, role, lease_ttl: leaseTtl, grace_ttl: graceTtl, scope });
      if (res && res.ok) {
        toast('节点已添加，请在一键安装弹窗中获取部署命令', 'ok');
        // Collapse the form back to the one-field add experience; the advanced
        // <details> keeps its own open state per browser, so reset it too.
        toggle('issueNodeForm', false);
        const adv = $('issueNodeForm').querySelector('details');
        if (adv) adv.open = false;
        $('issueNodeName').value = '';
        if (res.node_token) nodeTokenMem.set(res.node?.id, res);
        await loadNodesData();
        if (res.node?.id && res.node_token) {
          openNodeInstallOverlay(res.node.id, res, { rotated: false });
        }
      } else {
        toast(res.error || '添加失败', 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // --- View: Unified Model Routing (U1, U5, M16) ---
  function renderModelsList() {
    const container = $('modelsList');
    if (!container) return;
    container.innerHTML = '';

    const btnAddModel = $('btnAddModel');
    if (btnAddModel) {
      btnAddModel.hidden = false;
      btnAddModel.classList.remove('hidden');
    }

    const models = state.config?.agent_models || {};
    const q = state.modelQuery || '';

    // Every route renders as an ordinary entry, sorted alphabetically — on full and
    // hub hosts alike. Legacy KB fixed channels (chat/embedding/reranker/ocr) show
    // up only when actually configured: never rebuilt from kb_models, never hidden,
    // deletable like any other route.
    let orderedKeys = Object.keys(models).sort();

    orderedKeys = orderedKeys.filter((mName) => {
      if (!q) return true;
      const m = models[mName] || {};
      const cands = (m.candidates || []).map((c) => `${c.provider} ${c.target_model}`).join(' ');
      return `${mName} ${cands}`.toLowerCase().includes(q);
    });

    if (orderedKeys.length === 0) {
      const emptyRow = ce('div');
      emptyRow.className = 'row row--static text-muted';
      emptyRow.textContent = q ? '没有匹配的模型路由' : '暂无已配置模型路由，请点击右上角「添加模型」';
      container.appendChild(emptyRow);
      return;
    }

    const stratLabels = STRATEGY_LABELS;

    for (const mName of orderedKeys) {
      const m = models[mName];
      const cCount = (m.candidates || []).length;
      const isExpanded = state.activeEditorKey === `m_${mName}`;
      const brandIcon = window.renderBrandIcon ? window.renderBrandIcon(mName) : '';
      const strat = m.routing_strategy || 'sticky_failover';

      const row = ce('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = ce('span');
      dot.className = `dot ${m.enabled && cCount > 0 ? 'dot--ok' : 'dot--err'}`;

      const who = ce('div');
      who.className = 'who';
      const subDesc = `首选 Key: ${m.active_key || '自动多路粘性'} · 候选池: ${cCount} 个`;
      // Latest 测试路由 result: verdict + latency + which provider/key answered;
      // title carries the upstream snippet (testCandidate) or the upstream error.
      const t = m._lastTest;
      const testPill = !t ? '' : t.ok
        ? `<span class="pill pill--green tabular" title="${eh(t.text || '测试通过')}">测试 ${t.latency_ms || 0}ms · ${eh(t.provider)} · ${eh(t.key_label || '任一')}</span>`
        : `<span class="pill pill--red" title="${eh(t.error || '测试失败')}">测试失败 · ${eh(t.provider)} · ${eh(t.key_label || '任一')}</span>`;
      who.innerHTML = `
        <div class="name">
          ${brandIcon}
          <span>${eh(mName)}</span>
          <span class="pill pill--accent">${eh(stratLabels[strat] || strat)}</span>
          ${testPill}
        </div>
        <div class="sub">${eh(subDesc)}</div>
      `;

      const fields = ce('div');
      fields.className = 'fields';
      const canTest = window.HOST.capabilities.kbModels && cCount > 0;
      fields.innerHTML = `
        ${canTest ? `<button class="btn btn--sm btn_test_agent_m" data-model="${eh(mName)}" type="button">测试路由</button>` : ''}
        <span class="pill">${cCount} 候选</span>
        <span class="caret">▾</span>
      `;

      const testBtn = fields.querySelector('.btn_test_agent_m');
      if (testBtn) {
        clk(testBtn, async (e) => {
          e.stopPropagation();
          toast(`正在测试 ${mName} 路由（最小真实推理）...`, 'info');
          try {
            if (mName === 'embedding' || mName === 'reranker' || mName === 'ocr') {
              const first = (m.candidates || []).find((c) => c && c.enabled !== false) || m.candidates[0];
              if (!first) return toast('该路由没有候选', 'warn');
              const res = await window.HOST.testCandidate({ provider: first.provider, key_label: first.key_label, model: first.target_model || mName, type: mName });
              const ok = Boolean(res && res.ok);
              const text = String(res?.text || '').trim().slice(0, 40);
              m._lastTest = ok
                ? { ok: true, latency_ms: res?.latency_ms || res?.ms || 0, provider: first.provider, key_label: first.key_label, text }
                : { ok: false, provider: first.provider, key_label: first.key_label, error: scrubUiText(res?.error || '路由无响应') };
              toast(ok ? `测试通过！${m._lastTest.latency_ms}ms（详情见路由行）` : `测试失败: ${m._lastTest.error}`, ok ? 'ok' : 'err');
            } else {
              // Backend fires one minimal real inference per candidate; report the
              // fastest passing one (provider + key + latency).
              const res = await window.HOST.testAgentModel({ model: mName });
              const results = (res && Array.isArray(res.results) ? res.results : []).filter(Boolean);
              const best = results.filter((r) => r.ok).sort((a, b) => (a.latency_ms || 0) - (b.latency_ms || 0))[0] || null;
              const failed = results.find((r) => !r.ok) || results[0] || {};
              m._lastTest = best
                ? { ok: true, latency_ms: best.latency_ms || 0, provider: best.provider, key_label: best.key, text: '' }
                : { ok: false, provider: failed.provider || '', key_label: failed.key || '', error: scrubUiText(failed.error || res?.error || '路由无响应') };
              const ok = m._lastTest.ok;
              toast(ok ? `测试通过！${m._lastTest.latency_ms}ms（详情见路由行）` : `测试失败: ${m._lastTest.error}`, ok ? 'ok' : 'err');
            }
            renderModelsList();
          } catch (err) {
            toast(`测试异常: ${err.message}`, 'err');
          }
        });
      }

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);

      clk(row, (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `m_${mName}`;
        renderModelsList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = ce('div');
        editor.className = 'editor';
        editor.appendChild(buildModelEditor(mName, m));
        container.appendChild(editor);
      }
    }
  }

  function buildModelEditor(mName, m) {
    const wrap = ce('div');
    const q = makeScopedQuery(wrap);
    m.candidates = m.candidates || [];
    const candidates = m.candidates;
    let stratVal = m.routing_strategy || 'sticky_failover';

    // Only one route editor is open at a time (state.activeEditorKey), so every
    // element id below is static. Strategy pills are magpie-style flat tiles; the
    // live value rides in stratVal — save reads it, no hidden input needed.
    const stratPill = (k) => `<button class="probe-pill${stratVal === k ? ' probe-pill--managed' : ''}" data-strat="${k}">${eh(k === 'sticky_failover' ? '会话粘性优先（推荐）' : STRATEGY_LABELS[k] || k)}</button>`;

    wrap.innerHTML = `
      <div class="form-group"><label class="form-label">对外模型名</label><input class="input input--code" id="ed_m_name" value="${eh(mName)}"><span class="text-xs text-muted">Agent 客户端看到的模型名</span></div>
      <div class="section-bar mt-3"><span class="form-label">模型列表</span></div>
      <div class="card" id="m_cl"></div>
      <div class="form-actions"><button class="btn btn--sm" id="btn_add_cand" type="button">+ 添加模型</button></div>
      <div class="card mt-2 card-pad hidden" id="m_ac" hidden>
        <div class="fields"><input class="input input--code flex-1" id="m_ac_prov" list="datalistProviders" placeholder="选择供应商"></div>
        <div class="probe-pills-wrap" id="m_ac_models"></div>
        <div class="fields mt-2"><input class="input input--code flex-1" id="m_ac_target" placeholder="上游模型 ID（可手填）"><button class="btn btn--sm btn--primary" id="m_ac_ok" type="button">追加所选</button></div>
      </div>
      <div class="section-bar mt-3"><span class="form-label">Key 选择</span><span class="text-xs text-muted">默认任一=全部启用 Key</span></div>
      <div class="card card-pad" id="m_kw"></div>
      <details class="headers-details mt-3"><summary class="form-label">候选权重 / 并发上限</summary><div id="m_ca" class="mt-2"></div></details>
      <div class="form-group mt-4">
        <label class="form-label">路由策略</label>
        <div class="probe-pills-wrap">${['sticky_failover', 'round_robin', ...ADVANCED_STRATEGIES].map(stratPill).join('')}</div>
        <div class="text-xs text-muted mt-1"><span id="ed_m_strat_desc">${eh(STRATEGY_HINTS[stratVal] || '')}</span> · 默认值：${eh(STRATEGY_LABELS[state.config?.settings?.agent_routing_strategy || 'sticky_failover'])}</div>
      </div>
      <details class="headers-details mt-3"><summary class="form-label">高级（剥离思考 / 流式 / 指定 Key）</summary>
        <input class="input mt-2" id="ed_m_act" value="${eh(m.active_key || '')}" placeholder="首选/指定 Key (provider:key_label)">
        <label class="form-label form-label--check mt-2"><input type="checkbox" id="ed_m_noreas" ${m.no_reasoning ? 'checked' : ''}><span>剥离思考/推理参数 (RAG/KB 推荐)</span></label>
        <label class="form-label form-label--check mt-2"><input type="checkbox" id="ed_m_nonstream" ${m.force_non_stream ? 'checked' : ''}><span>强制非流式响应 (stream=false)</span></label>
        <label class="form-label form-label--check mt-2"><input type="checkbox" id="ed_m_keyfb" ${m.allow_key_fallback ? 'checked' : ''}><span>候选 Key 不可用时回退同供应商其它 Key</span></label>
      </details>
      <div class="form-actions form-actions--split mt-3">
        <div class="form-actions-group"><button class="btn btn--danger" id="btn_del_model" type="button">删除此模型</button></div>
        <div class="form-actions-group"><button class="btn btn--primary" id="btn_save_model" type="button">保存模型配置</button></div>
      </div>
    `;

    const stratDesc = q('#ed_m_strat_desc');
    const stratPills = wrap.querySelectorAll('button[data-strat]');
    stratPills.forEach((btn) => {
      clk(btn, () => {
        stratVal = btn.dataset.strat || '';
        stratPills.forEach((b) => b.classList.toggle('probe-pill--managed', b === btn));
        stratDesc.textContent = STRATEGY_HINTS[stratVal] || '';
      });
    });

    // ② 模型列表 rows (magpie style): 序号 + 目标模型 + 供应商 + 绑定 Key + 上移/下移/移除.
    // All draws are local so pool edits never collapse the editor via
    // renderModelsList; one delegated handler serves every row. The per-row Key
    // pill is what makes unchecked-but-listed keys visible: without it a checked
    // key beyond the candidate count silently never routes.
    const drawCands = () => {
      q('#m_cl').innerHTML = candidates.map((c, i) => `<div class="row row--static" data-i="${i}"><div class="who"><span class="pill tabular">${i + 1}</span><span class="input--code">${eh(c.target_model || mName)}</span><span class="pill">${eh(c.provider)}</span><span class="pill">${c.key_label ? `Key ${eh(c.key_label)}` : '任一 Key'}</span></div><div class="fields"><button class="btn btn--sm" data-a="u"${i ? '' : ' disabled'}>↑</button><button class="btn btn--sm" data-a="d"${i === candidates.length - 1 ? ' disabled' : ''}>↓</button><button class="btn btn--sm btn--danger" data-a="r">移除</button></div></div>`).join('') || '<div class="row row--static text-muted">暂无候选</div>';
    };
    const swapCand = (i, j) => {
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      drawCands();
      drawAdv();
    };
    clk(q('#m_cl'), (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('button[data-a]') : null;
      if (!btn) return;
      const i = Number(btn.closest('[data-i]').dataset.i);
      const a = btn.dataset.a;
      if (a === 'u' && i > 0) swapCand(i, i - 1);
      else if (a === 'd' && i < candidates.length - 1) swapCand(i, i + 1);
      else if (a === 'r') {
        candidates.splice(i, 1);
        drawCands();
        drawAdv();
        drawKeys();
      }
    });

    // ③ Key 选择: one row per provider in the pool.「任一」(empty selection) leaves
    // key_label '' = any enabled key; checking concrete labels re-binds that
    // provider's candidates cyclically (key[i % n]). When more keys are checked
    // than there are candidates, the surplus stays selected but binds nothing —
    // drawKeys badges those as 未绑定候选 so the state is visible, and binding
    // more candidates (「+ 添加模型」) puts them to work. Selection rides on
    // m._keySel: it survives the local redraws and dies with the config
    // round-trip on save (persistConfig strips it — on hub too, where the raw
    // KV save would otherwise persist and later replay stale selections).
    // The selection is seeded from the candidates as they exist: candidates
    // created by the add-model modal carry concrete key_label bindings, so their
    // pills show checked instead of the lying「任一」highlight.
    const keySel = m._keySel = m._keySel || {};
    for (const c of candidates) {
      if (c && c.provider && c.key_label) {
        const set = keySel[c.provider] || (keySel[c.provider] = []);
        if (!set.includes(c.key_label)) set.push(c.key_label);
      }
    }
    const applyKeySel = (pId) => {
      const sel = keySel[pId] || [];
      let ci = 0;
      for (const c of candidates) {
        if (c && c.provider === pId) c.key_label = sel.length ? sel[ci++ % sel.length] : '';
      }
    };
    const drawKeys = () => {
      const provs = state.config?.providers || {};
      const ids = [...new Set(candidates.map((c) => c && c.provider).filter(Boolean))];
      q('#m_kw').innerHTML = ids.map((pId) => {
        const sel = keySel[pId] || [];
        const labels = ((provs[pId] || {}).api_keys || []).filter((k) => k && k.enabled !== false)
          .map((k, i) => k.label || k.id || `key-${i}`);
        const used = new Set(candidates.filter((c) => c && c.provider === pId && c.key_label).map((c) => c.key_label));
        return `<div class="mb-2"><span class="form-label">${eh(provs[pId]?.name || pId)}</span><div class="probe-pills-wrap"><button class="probe-pill${sel.length ? '' : ' probe-pill--managed'}" data-p="${eh(pId)}" data-k="">任一</button>${labels.map((l) => {
          const checked = sel.includes(l);
          const badge = checked && !used.has(l) ? ' <span class="pill pill--amber">未绑定候选</span>' : '';
          return `<button class="probe-pill${checked ? ' probe-pill--managed' : ''}" data-p="${eh(pId)}" data-k="${eh(l)}">${eh(l)}${badge}</button>`;
        }).join('')}</div></div>`;
      }).join('') || '<div class="text-xs text-muted">暂无</div>';
    };
    clk(q('#m_kw'), (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('button[data-k]') : null;
      if (!btn) return;
      const pId = btn.dataset.p || '';
      const k = btn.dataset.k || '';
      if (!k) keySel[pId] = [];
      else {
        const cur = new Set(keySel[pId] || []);
        if (cur.has(k)) cur.delete(k); else cur.add(k);
        keySel[pId] = [...cur];
      }
      applyKeySel(pId);
      drawKeys();
      drawCands();
    });

    // 权重 / 并发上限 fold: per-candidate inputs keyed by 序号 (mirrors the rows);
    // one delegated change listener on the persistent container.
    const drawAdv = () => {
      q('#m_ca').innerHTML = candidates.map((c, i) => `<div class="fields mt-1"><span class="pill tabular">${i + 1}</span><span class="input--code">${eh(c.target_model || mName)}</span><input class="input input--compact tabular" data-w="${i}" type="number" min="1" value="${c.weight || 1}" title="权重"><input class="input input--compact tabular" data-x="${i}" type="number" min="0" value="${c.max_concurrency || 0}"></div>`).join('');
    };
    q('#m_ca')?.addEventListener('change', (e) => {
      const el = e.target;
      const c = candidates[Number(el.dataset.w || el.dataset.x)];
      if (!c) return;
      if (el.dataset.w) c.weight = Math.max(1, Number(el.value) || 1);
      else c.max_concurrency = Math.max(0, Number(el.value) || 0);
    });

    //「+ 添加模型」popup: provider (datalist) → check probed model pills → append
    // (manual input as fallback). Probe data shares the provider-editor cache
    // state.probedModelsByProvider — probe a provider there once and the pills
    // light up here too.
    const drawAddPills = () => {
      const models = state.probedModelsByProvider[(q('#m_ac_prov')?.value || '').trim()] || [];
      q('#m_ac_models').innerHTML = models.map((mo) => `<button class="probe-pill" data-mo="${eh(mo)}">${eh(mo)}</button>`).join('') || '<span class="text-xs text-muted">暂无探测数据</span>';
    };
    clk(q('#m_ac_models'), (ev) => {
      const pill = ev.target instanceof Element ? ev.target.closest('button[data-mo]') : null;
      if (pill) pill.classList.toggle('probe-pill--managed');
    });
    clk(q('#btn_add_cand'), () => {
      const box = q('#m_ac');
      box.hidden = !box.hidden;
      box.classList.toggle('hidden', box.hidden);
      drawAddPills();
    });
    // The provider input drives the pill pool: redraw on click, datalist pick
    // and every keystroke. Click alone misses keyboard/datalist switches, which
    // used to leave the previous provider's pills checked — appending them then
    // built candidates pairing the NEW provider with the OLD provider's models.
    // A committed switch (change) also clears the manual target, mirroring the
    // add-model modal's rule: switching providers invalidates the probe result.
    const addProvEl = q('#m_ac_prov');
    if (addProvEl) {
      clk(addProvEl, drawAddPills);
      addProvEl.addEventListener('input', drawAddPills);
      addProvEl.addEventListener('change', () => {
        drawAddPills();
        const t = q('#m_ac_target');
        if (t) t.value = '';
      });
    }
    clk(q('#m_ac_ok'), () => {
      const prov = (q('#m_ac_prov')?.value || '').trim();
      if (!state.config?.providers?.[prov]) return toast('供应商不存在', 'warn');
      const picked = [...q('#m_ac_models').querySelectorAll('.probe-pill--managed')].map((b) => b.dataset.mo);
      const manual = (q('#m_ac_target')?.value || '').trim();
      if (manual && !picked.includes(manual)) picked.push(manual);
      if (picked.length === 0) return toast('请勾选或手填上游模型', 'warn');
      const sel = keySel[prov] || [];
      let base = candidates.filter((c) => c && c.provider === prov).length;
      for (const t of picked) {
        const kl = sel.length ? sel[base++ % sel.length] : '';
        candidates.push({ provider: prov, key_label: kl, target_model: t, enabled: true, weight: 1, max_concurrency: 0 });
      }
      drawCands();
      drawAdv();
      drawKeys();
    });

    drawCands();
    drawKeys();
    drawAdv();

    clk(q('#btn_save_model'), async () => {
      // ① 名称 editable: renaming re-keys the route (agents request by this name),
      // and the editor stays open on the renamed route.
      const newName = (q('#ed_m_name')?.value || '').trim() || mName;
      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.agent_models = state.config.agent_models || {};
      if (newName !== mName && state.config.agent_models[newName]) return toast(`模型 ${newName} 已存在`, 'warn');
      m.enabled = true;
      m.routing_strategy = stratVal;
      m.active_key = (q('#ed_m_act')?.value || '').trim();
      m.no_reasoning = Boolean(q('#ed_m_noreas')?.checked);
      m.force_non_stream = Boolean(q('#ed_m_nonstream')?.checked);
      m.allow_key_fallback = Boolean(q('#ed_m_keyfb')?.checked);
      if (newName !== mName) {
        delete state.config.agent_models[mName];
        if (state.activeEditorKey === `m_${mName}`) state.activeEditorKey = `m_${newName}`;
      }
      state.config.agent_models[newName] = m;
      // Same-name legacy KB channels go (delete is a no-op if absent).
      if (state.config.kb_models) {
        delete state.config.kb_models[mName];
        delete state.config.kb_models[newName];
      }
      await persistConfig('模型配置保存成功');
    });

    clk(q('#btn_del_model'), async () => {
      if (!confirm(`确定删除模型 ${mName} 吗？`)) return;
      delete state.config.agent_models[mName];
      // Same-name legacy KB channel must go with it: leaving it behind would let
      // the KB fallback resurrect a ghost route on the next config round-trip.
      if (state.config.kb_models) delete state.config.kb_models[mName];
      state.activeEditorKey = null;
      await persistConfig('模型已删除');
    });

    return wrap;
  }

  // --- Template Route Import (Full, on-demand) ---
  // Local model routes are fully free; the hub template is only an optional
  // import source. Routes whose candidates reference a provider missing locally
  // are blocked until that provider is pulled.
  function openTemplateImportOverlay() {
    const overlay = $('templateImportOverlay');
    if (!overlay) return;
    overlay.hidden = false;
    overlay.classList.remove('hidden');
    renderTemplateImportList();
  }

  function closeTemplateImportOverlay() {
    const overlay = $('templateImportOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.add('hidden');
  }

  function templateRouteMissingProviders(mName, tpl, localProviders) {
    const cands = Array.isArray(tpl?.candidates) ? tpl.candidates : [];
    return [...new Set(cands.map((c) => c.provider).filter((pId) => pId && !localProviders[pId]))];
  }

  // Key labels a template binds its candidates to that are missing locally: importing
  // such a route yields a dead route (every candidate is skipped at dispatch time and
  // the request ends in 503), so it is validated like a missing provider.
  function templateRouteMissingKeyLabels(mName, tpl, localProviders) {
    const cands = Array.isArray(tpl?.candidates) ? tpl.candidates : [];
    const missing = new Set();
    for (const c of cands) {
      const lbl = String(c?.key_label || '').trim();
      if (!lbl) continue; // 空 = 展开该供应商全部启用 Key
      const keys = localProviders[c?.provider]?.api_keys || [];
      const hasKey = keys.some((k) => k && (k.label === lbl || k.id === lbl));
      if (!hasKey) missing.add(`${c.provider}:${lbl}`);
    }
    return [...missing];
  }

  function renderTemplateImportList() {
    const listEl = $('templateImportList');
    if (!listEl) return;
    listEl.innerHTML = '';
    const manifestModels = vaultManifestModels();
    const localModels = state.config?.agent_models || {};
    const localProviders = state.config?.providers || {};
    // Fixed-4-channel names are ordinary routes now: if an old hub manifest still
    // carries chat/embedding/reranker/ocr templates, they must stay importable —
    // building the same-name KB route is exactly the supported path since the
    // channels stopped being auto-generated.
    const entries = Object.entries(manifestModels).filter(
      ([mName, tpl]) => tpl && typeof tpl === 'object' && !localModels[mName]
    );
    if (entries.length === 0) {
      const empty = ce('div');
      empty.className = 'row row--static text-muted';
      if (!state.vaultManifest) {
        empty.textContent = '中枢清单未加载，无法导入模板路由';
      } else if (!state.vaultManifest.agent_models || typeof state.vaultManifest.agent_models !== 'object') {
        empty.textContent = '中枢清单未包含模板路由（中枢版本较旧或未发布任何模板）';
      } else {
        empty.textContent = '中枢模板中没有本地缺失的模型路由';
      }
      listEl.appendChild(empty);
      return;
    }
    for (const [mName, tpl] of entries) {
      const cands = Array.isArray(tpl.candidates) ? tpl.candidates : [];
      const missing = templateRouteMissingProviders(mName, tpl, localProviders);
      const missingKeys = templateRouteMissingKeyLabels(mName, tpl, localProviders);
      const candText = cands.map((c) => `${c.provider}:${c.key_label || '*'}→${c.target_model || mName}`).join(' · ');
      const row = ce('div');
      row.className = 'mb-2';
      row.innerHTML = `
        <label class="form-label form-label--check">
          <input type="checkbox" class="tpl_import_cb" data-model="${eh(mName)}" ${missing.length || missingKeys.length ? 'disabled' : ''}>
          <span><strong>${eh(mName)}</strong> <span class="pill pill--accent">${eh(STRATEGY_LABELS[tpl.routing_strategy] || tpl.routing_strategy || 'sticky_failover')}</span> <span class="pill tabular">${cands.length} 候选</span></span>
        </label>
        ${candText ? `<div class="text-xs text-muted">${eh(candText)}</div>` : ''}
        ${missing.length ? `<div class="text-xs"><span class="pill pill--red">需先拉取供应商 ${eh(missing.join(', '))}</span></div>` : ''}
        ${missingKeys.length ? `<div class="text-xs"><span class="pill pill--red">候选绑定的 Key 标签本地缺失：${eh(missingKeys.join(', '))}（请重新拉取对应供应商或调整模板）</span></div>` : ''}
      `;
      listEl.appendChild(row);
    }
  }

  async function handleConfirmImportRoutes() {
    const listEl = $('templateImportList');
    const picked = [...(listEl?.querySelectorAll('.tpl_import_cb:checked') || [])]
      .map((cb) => cb.getAttribute('data-model'))
      .filter(Boolean);
    if (picked.length === 0) return toast('请先勾选要导入的模型路由', 'warn');
    const manifestModels = vaultManifestModels();
    const localModels = state.config?.agent_models || {};
    const localProviders = state.config?.providers || {};
    let imported = 0;
    for (const mName of picked) {
      const tpl = manifestModels[mName];
      if (!tpl || localModels[mName]) continue;
      if (templateRouteMissingProviders(mName, tpl, localProviders).length > 0) continue;
      if (templateRouteMissingKeyLabels(mName, tpl, localProviders).length > 0) continue;
      const cands = Array.isArray(tpl.candidates) ? tpl.candidates : [];
      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.agent_models = state.config.agent_models || {};
      // Import the template verbatim (strategy, key pin, flags, per-candidate weight and
      // concurrency cap): the local model editor supports every one of these fields, and
      // silently degrading them would make the imported route behave differently from
      // what the hub operator configured.
      state.config.agent_models[mName] = {
        origin: 'local',
        routing_strategy: tpl.routing_strategy || 'sticky_failover',
        active_key: tpl.active_key || '',
        no_reasoning: Boolean(tpl.no_reasoning),
        force_non_stream: Boolean(tpl.force_non_stream),
        allow_key_fallback: Boolean(tpl.allow_key_fallback),
        enabled: true,
        candidates: cands.map((c) => ({
          provider: c.provider || '',
          key_label: c.key_label || '',
          target_model: c.target_model || mName,
          enabled: c.enabled !== false,
          weight: Number(c.weight) || 0,
          max_concurrency: Number(c.max_concurrency) || 0,
        })),
      };
      imported++;
    }
    if (imported === 0) return toast('没有可导入的路由（候选供应商或 Key 缺失，或路由已存在）', 'warn');
    closeTemplateImportOverlay();
    await persistConfig(`已从模板导入 ${imported} 条模型路由`);
  }

  // --- View: Activity & Traces (M7~M10, M12) ---
  function renderTracesList() {
    const container = $('tracesList');
    if (!container) return;
    container.innerHTML = '';

    const traces = state.traces || [];
    const q = state.traceQuery || '';
    const mFilter = state.traceModeFilter || 'all';
    const epFilter = state.traceEndpointFilter || 'all';

    const filtered = traces.filter((t) => {
      if (state.filterOnlyRetried) {
        const isRetried = t.status >= 400 || t.status === 0 || (t.tries && t.tries.length > 1) || (t.retried_ms || 0) > 0;
        if (!isRetried) return false;
      }
      if (mFilter !== 'all' && (t.mode || 'agent') !== mFilter) return false;
      if (epFilter !== 'all' && t.endpoint !== epFilter) return false;
      if (q) {
        const hay = `${t.req_model || ''} ${t.served_model || ''} ${t.winner_provider || ''} ${t.endpoint || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      const emptyRow = ce('div');
      emptyRow.className = 'row row--static text-muted';
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
      const modePill = (t.mode || 'agent') === 'kb'
        ? '<span class="pill pill--amber">KB</span>'
        : '<span class="pill pill--accent">AGENT</span>';
      const modelRoute = t.served_model && t.served_model !== t.req_model
        ? `${eh(t.req_model)} → ${eh(t.served_model)}`
        : eh(t.req_model || '-');
      const tokBrief = `${t.in_tokens || 0}→${t.out_tokens || 0}${t.cache_read_tokens ? ` (缓存:${t.cache_read_tokens})` : ''}`;

      const row = ce('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const dot = ce('span');
      dot.className = `dot ${!isOk ? 'dot--err' : hasRetries ? 'dot--warn' : 'dot--ok'}`;

      const who = ce('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name">
          ${brandIcon}
          ${modePill}
          <span class="tabular">${formatTime(t.ts)}</span>
          <span class="tabular">${modelRoute}</span>
          <span class="text-muted">→</span>
          <span class="pill">${eh(t.winner_provider || 'none')}${t.winner_key ? ` / ${eh(t.winner_key)}` : ''}</span>
          ${hasRetries ? `<span class="pill pill--amber">${triesCount}次尝试</span>` : ''}
        </div>
        <div class="sub tabular">${eh(t.endpoint)} · ${t.stream ? 'SSE' : 'JSON'} · Tok ${tokBrief} · ${t.total_ms || 0}ms (TTFT ${t.ttft_ms || 0}ms)</div>
      `;

      const fields = ce('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill ${isOk ? 'pill--green' : 'pill--red'} tabular">HTTP ${t.status || 0}</span>
        <span class="caret">▾</span>
      `;

      row.appendChild(dot);
      row.appendChild(who);
      row.appendChild(fields);

      clk(row, () => {
        state.activeEditorKey = isExpanded ? null : `tr_${t.id}`;
        renderTracesList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = ce('div');
        editor.className = 'editor';
        editor.appendChild(window.USAGE.buildTraceWaterfall(t));
        container.appendChild(editor);
      }
    }
  }

  // --- View: Settings (M16, U3, U4) ---
  function renderSettingsView() {
    state.config = state.config || {};
    state.config.settings = state.config.settings || {};
    const s = state.config.settings;
    const isFull = Boolean(window.HOST.capabilities.kbModels);

    const setVal = (id, val) => {
      const el = $(id);
      if (el) el.value = val !== undefined ? val : '';
    };
    const parseProxyKeys = (raw) => String(raw || '')
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    const isZeroVersion = state.config._version === 0;
    setVal('cfgRoutingStrategy', s.agent_routing_strategy || 'sticky_failover');
    setVal('cfgFirstByteTimeout', s.agent_first_byte_timeout_sec || 120);
    setVal('cfgCooldown429', isZeroVersion && !s.cooldown_rate_limit_sec ? 15 : (s.cooldown_rate_limit_sec ?? 15));
    setVal('cfgCooldown5xx', isZeroVersion && !s.cooldown_server_error_sec ? 30 : (s.cooldown_server_error_sec ?? 30));
    setVal('cfgCooldownNet', isZeroVersion && !s.cooldown_network_error_sec ? 15 : (s.cooldown_network_error_sec ?? 15));
    setVal('cfgCooldownAuth', isZeroVersion && !s.cooldown_auth_error_sec ? 86400 : (s.cooldown_auth_error_sec ?? 86400));
    setVal('cfgOcrInflight', s.ocr_max_inflight || 4);
    setVal('cfgKbConcurrency', s.kb_global_max_concurrency || 16);

    // Gateway Access Center: open on BOTH Hub (for Lite projection) and Full
    const gwBox = $('gatewayAccessCenter');
    const gwBaseUrlGroup = $('gwBaseUrlGroup');
    const gwLocalOnlyBox = $('gwLocalOnlyBox');
    const gwHubNotice = $('gwHubNotice');
    const gwSummaryPill = $('gwAccessSummaryPill');
    const guardBox = $('concurrencyGuardBox');
    const backupBox = $('configBackupBox');
    const sysBox = $('systemUpdateBox');

    if (gwBox) gwBox.hidden = false;
    if (gwBaseUrlGroup) gwBaseUrlGroup.hidden = !isFull;
    if (gwLocalOnlyBox) gwLocalOnlyBox.hidden = !isFull;
    if (gwHubNotice) gwHubNotice.hidden = isFull;
    if (guardBox) guardBox.hidden = false;
    if (backupBox) backupBox.hidden = false;
    if (sysBox) sysBox.hidden = !window.HOST.capabilities.systemUpdate;
    renumberSettingsSections();

    const baseOrigin = location.origin || 'http://127.0.0.1:3425';
    const localBase = `${baseOrigin}/v1`;
    const clientKey = s.client_key || s.proxy_api_key || '';
    const extraKeys = Array.isArray(s.proxy_keys) ? s.proxy_keys : [];

    if (gwSummaryPill) {
      gwSummaryPill.textContent = clientKey
        ? `主密钥已配置 · 附加 ${extraKeys.length} 把`
        : (isFull ? '主密钥未配置' : '待设置下发至节点');
    }

    const gwBaseUrl = $('gwBaseUrl');
    if (gwBaseUrl) gwBaseUrl.value = localBase;

    const gwClientKey = $('gwClientKey');
    if (gwClientKey) gwClientKey.value = clientKey;

    const gwProxyKeys = $('gwProxyKeys');
    if (gwProxyKeys) gwProxyKeys.value = extraKeys.join('\n');

    const snippetClaude = $('snippetClaude');
    const displayKey = clientKey || 'sk-llmproxy-key';
    if (snippetClaude) snippetClaude.textContent = `export ANTHROPIC_BASE_URL="${localBase}" ANTHROPIC_API_KEY="${displayKey}"`;

    const snippetCursor = $('snippetCursor');
    if (snippetCursor) snippetCursor.textContent = `OPENAI_BASE_URL="${localBase}" OPENAI_API_KEY="${displayKey}"`;

    const btnGen = $('btnGenClientKey');
    if (btnGen) {
      btnGen.onclick = () => {
        const rand = generateClientSecretKey();
        if (gwClientKey) gwClientKey.value = rand;
        if (snippetClaude) snippetClaude.textContent = `export ANTHROPIC_BASE_URL="${localBase}" ANTHROPIC_API_KEY="${rand}"`;
        if (snippetCursor) snippetCursor.textContent = `OPENAI_BASE_URL="${localBase}" OPENAI_API_KEY="${rand}"`;
      };
    }

    const btnSaveKey = $('btnSaveClientKey');
    if (btnSaveKey) {
      btnSaveKey.onclick = async () => {
        const k = (gwClientKey?.value || '').trim();
        const pk = parseProxyKeys(gwProxyKeys?.value);
        s.client_key = k;
        s.proxy_api_key = k;
        s.proxy_keys = pk;
        await persistConfig(isFull ? '客户端鉴权密钥已保存' : '已保存，将自动投影下发至节点');
      };
    }

    if (isFull) {
      const btnCopyClaude = $('btnCopyClaudeSnippet');
      if (btnCopyClaude) {
        btnCopyClaude.onclick = () => {
          navigator.clipboard.writeText(snippetClaude?.textContent || '');
          toast('已复制 Claude Code 配置', 'ok');
        };
      }

      const btnCopyCursor = $('btnCopyCursorSnippet');
      if (btnCopyCursor) {
        btnCopyCursor.onclick = () => {
          navigator.clipboard.writeText(snippetCursor?.textContent || '');
          toast('已复制 Cursor 配置', 'ok');
        };
      }

      const sysSub = $('sysCurrentVersionSub');
      if (sysSub && state.systemVersion) {
        const sv = state.systemVersion;
        sysSub.textContent = `当前版本: ${sv.current_version || '-'} (SemVer ${sv.semver || '-'} · ${sv.os || ''}/${sv.arch || ''} · ${sv.commit || ''})`;
      }

      const btnClearCd = $('btnClearAllCooldowns');
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

    const rawArea = $('rawConfigTextarea');
    if (rawArea && $('rawJsonDetails')?.open) {
      rawArea.value = JSON.stringify(state.config, null, 2);
    }

    const btnSave = $('btnSaveSettings');
    if (btnSave) {
      btnSave.onclick = async () => {
        const parseBoundedInt = (id, label, min, max, fallback) => {
          const raw = ($(id)?.value ?? '').trim();
          if (raw === '') return { val: fallback };
          const n = Number(raw);
          if (!Number.isFinite(n) || n < min || n > max) {
            return { error: `${label} 需在 ${min} ~ ${max} 之间` };
          }
          return { val: Math.floor(n) };
        };

        const fbTimeout = parseBoundedInt('cfgFirstByteTimeout', '首字超时', 5, 600, 120);
        if (fbTimeout.error) return toast(fbTimeout.error, 'err');
        const cd429 = parseBoundedInt('cfgCooldown429', '429 限流冷却', 0, 86400, 15);
        if (cd429.error) return toast(cd429.error, 'err');
        const cd5xx = parseBoundedInt('cfgCooldown5xx', '5xx 异常冷却', 0, 86400, 30);
        if (cd5xx.error) return toast(cd5xx.error, 'err');
        const cdNet = parseBoundedInt('cfgCooldownNet', '网络超时冷却', 0, 86400, 15);
        if (cdNet.error) return toast(cdNet.error, 'err');
        const cdAuth = parseBoundedInt('cfgCooldownAuth', '鉴权失败冷却', 0, 604800, 86400);
        if (cdAuth.error) return toast(cdAuth.error, 'err');
        const ocrInf = parseBoundedInt('cfgOcrInflight', 'OCR 预读并发上限', 1, 64, 4);
        if (ocrInf.error) return toast(ocrInf.error, 'err');
        const kbConc = parseBoundedInt('cfgKbConcurrency', '固定通道全局并发上限', 1, 256, 16);
        if (kbConc.error) return toast(kbConc.error, 'err');

        if (window.HOST.capabilities.vaultClient) {
          const prevUrl = (state.config?.vault?.url || '').trim();
          const vUrl = ($('cfgVaultUrl')?.value || '').trim();
          const vToken = ($('cfgVaultToken')?.value || '').trim();
          const maskedToken = isMaskedSecretVal(vToken);
          if (maskedToken && vUrl && vUrl !== prevUrl) {
            toast('更换 Vault 中枢地址时，请重新填写对应的 NODE_TOKEN', 'warn');
            return;
          }
          if (vUrl || vToken) {
            state.config.vault = {
              url: vUrl,
              node_token: maskedToken ? (vUrl === prevUrl ? vToken : '') : vToken,
            };
          } else if (state.config?.vault) {
            state.config.vault = { url: '', node_token: '' };
          }
        }

        const ck = (gwClientKey?.value || '').trim();
        s.client_key = ck;
        s.proxy_api_key = ck;
        s.proxy_keys = parseProxyKeys(gwProxyKeys?.value);
        s.agent_routing_strategy = $('cfgRoutingStrategy').value;
        s.agent_first_byte_timeout_sec = fbTimeout.val;
        s.cooldown_rate_limit_sec = cd429.val;
        s.cooldown_server_error_sec = cd5xx.val;
        s.cooldown_network_error_sec = cdNet.val;
        s.cooldown_auth_error_sec = cdAuth.val;
        s.ocr_max_inflight = ocrInf.val;
        s.kb_global_max_concurrency = kbConc.val;

        delete s.run_mode;
        delete s.mode_schedule_enabled;
        delete s.mode_schedule_agent_window;
        delete s.mode_schedule_timezone;
        delete s.mode_schedule_webhook_url;
        delete s.mode_schedule_webhook_secret;

        await persistConfig('设置保存成功');
        // Vault URL/token may have just changed: drop the stale manifest snapshot so the
        // add-provider and template-import flows talk to the newly configured hub.
        await loadVaultManifest({ force: true });
      };
    }
  }

  // --- Common Helper: Persist Config ---
  async function persistConfig(successMsg) {
    try {
      // m._keySel is editor-session state (checked-key pills), not config. The
      // full backend drops unknown route fields on the typed round-trip, but the
      // hub stores the payload verbatim in KV — strip it here so both hosts
      // honor the documented "dies with the config round-trip on save".
      for (const m of Object.values(state.config?.agent_models || {})) {
        if (m) delete m._keySel;
      }
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

      if (res?.status === 200 || data?.ok || data?._version !== undefined) {
        if (data.config) {
          state.config = data.config;
          if (data._version) state.config._version = data._version;
        } else if (data._version !== undefined || data.providers) {
          state.config = data;
        }
        const ver = state.config?._version || data._version;
        const verEl = $('configVersionDisplay');
        if (verEl && ver) verEl.textContent = `v${ver}`;
        toast(successMsg || '保存成功', 'ok');
        refreshDatalists();
        renderProvidersList();
        renderModelsList();
        renderSettingsView();
      } else {
        const errMsg = typeof data.error === 'string' ? data.error : data.error?.message || '保存失败';
        toast(scrubUiText(errMsg), 'err');
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
