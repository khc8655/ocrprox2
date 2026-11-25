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
    // Ledger-backed recent request window (GET /api/admin/recent-requests).
    // Kept here so the request table and the failure analysis aggregate share one
    // snapshot: both cards must describe the same 50 records at all times.
    recentRequests: [],
    recentSource: '',
    recentTruncated: false,
    recentFailedOnly: false,
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
    currentPeriod: 'today',
    lanesTimer: null,
    oauthPollTimer: null,
    oauthExpireTimer: null,
    nodesTimer: null,
    batchVerifying: false,
    probedModelsByProvider: {},
    vaultManifest: null,
    addProvVaultPick: '',
    addModelProbed: null,
    // Model catalog meta: the settings card fetches it once per page load; the
    // config snapshot's copy goes stale the moment an update lands.
    modelCatalogMetaLoaded: false,
    // Session memo of per-model capability answers (preset/model -> lookup
    // response), so the add-model summary and the candidate dropdowns agree and
    // repeat queries cost nothing. Failed queries are never stored.
    modelInfoCache: {},
    // Bumped by closeTemplateImportOverlay(): the batched provider pulls run for
    // seconds, and Esc / backdrop click during them must actually cancel instead of
    // letting the loop finish and persist routes the operator just dismissed.
    importRunId: 0,
    importing: false,
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

  // Model hint for the per-key test: the first enabled candidate of the first
  // agent_models route that names this provider. Passing it makes the probe use
  // the same upstream model the gateway would send; when no route exists the
  // field is omitted and the backend falls back (route -> preset -> common model).
  function firstRouteTargetModel(providerId) {
    const agentModels = (state.config && state.config.agent_models) || {};
    const names = Object.keys(agentModels).sort();
    const pick = (requireEnabled) => {
      for (const name of names) {
        const route = agentModels[name];
        for (const c of (route && route.candidates) || []) {
          if (!c || c.provider !== providerId) continue;
          if (requireEnabled && c.enabled === false) continue;
          const m = String(c.target_model || '').trim();
          if (m) return m;
        }
      }
      return '';
    };
    return pick(true) || pick(false);
  }

  // Turn a POST /api/admin/test-key response into the KeyEntry.last_test shape.
  // Stored on the key object and persisted by「保存供应商」so the pill survives a
  // page reload; it never carries the secret itself.
  function applyKeyLastTest(k, res) {
    const lt = {
      ok: Boolean(res && res.valid === true),
      status: Number(res?.status) || 0,
      latency_ms: Number(res?.latency_ms) || 0,
      reason: String(res?.reason || ''),
      err_type: String(res?.err_type || ''),
      error: scrubUiText(String(res?.error || '')),
      reply_text: scrubUiText(String(res?.reply_text || '')),
      at: new Date().toISOString(),
    };
    k.last_test = lt;
    // Keep the legacy health fields (provider card counters, status pill) in
    // step: a real inference test is the strongest health signal we have.
    k.last_ok = lt.ok;
    k.last_status = lt.status;
    k.last_latency_ms = lt.latency_ms;
    return lt;
  }

  // The in-row verdict pill. Success: 可用 · {latency}ms · {reply first 40};
  // failure spells out the reason and upstream code instead of just the
  // provider name — that was the operator complaint this replaces.
  function keyLastTestPill(lt) {
    if (!lt || typeof lt !== 'object') return '';
    if (lt.ok) {
      const reply = String(lt.reply_text || '').trim().slice(0, 40);
      const title = `${String(lt.reply_text || '').trim() || '上游返回 200（未抽到文本）'}${lt.at ? ` · ${lt.at}` : ''}`;
      return `<span class="pill pill--green pill--test" title="${eh(title)}">可用 · ${Number(lt.latency_ms) || 0}ms${reply ? ` · ${eh(reply)}` : ''}</span>`;
    }
    const status = Number(lt.status) || 0;
    const reason = String(lt.reason || 'unknown');
    const errType = String(lt.err_type || '');
    const title = `${lt.error || '上游无响应'}${lt.at ? ` · ${lt.at}` : ''}`;
    return `<span class="pill pill--red pill--test" title="${eh(title)}">测试失败 · ${status} ${eh(reason)}${errType ? ` · ${eh(errType)}` : ''}</span>`;
  }

  // Live health for provider card counters. last_ok wins while the page is open
  // (校验 / 批量探活 set it); once the config round-trips, only last_test is
  // persisted, so the verdict falls back to that.
  function keyHealthFlag(k) {
    if (!k || typeof k !== 'object') return undefined;
    if (typeof k.last_ok === 'boolean') return k.last_ok;
    if (k.last_test && typeof k.last_test.ok === 'boolean') return k.last_test.ok;
    return undefined;
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

  // Number inputs must not change value on wheel: a stray scroll over a focused
  // field silently rewrote weights / TTLs. Delegated because the inputs are both
  // static and re-rendered. blur() (not preventDefault) keeps page scrolling
  // working — the wheel is never consumed here.
  function setupNumberWheelGuard() {
    document.addEventListener('wheel', (e) => {
      const t = e.target;
      if (t && t.type === 'number') t.blur();
    }, { passive: true });
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
    setupNumberWheelGuard();
    setupLoginScreen();
    setupCapabilities();
    setupTheme();
    setupPrivacyMask();
    setupKeyboardShortcuts();
    setupNavigation();
    setupCreationForms();
    setupToolbars();
    setupConfigBackup();
    mountSettingRows();
    // Only fetch data when a credential is already present. An unauthenticated
    // page load must not issue /api/* requests: every one of those is a 401 and
    // would otherwise burn the anti-bruteforce budget (5 hits = 10 min lockout).
      if (window.HOST.getToken()) {
        await loadData();
      }
    startLanesPolling();
    startNodesPolling();
  }

  // --- URL direct-login helpers (?key= / ?token= / ?password=) ---
  // User-requested convenience for this private deployment: one-click console access
  // from a bookmarked URL on the full console. The backend (VerifyAdminAuth) accepts
  // the query-string credential; here we scrub the parameter from the address bar the
  // moment it is read — regardless of host kind and of the login outcome (wrong
  // password, 429 lockout, network error) — so the credential never lingers in the
  // URL (re-sharing / refresh replay). Auto-fill + submit through the normal login
  // path happens on the full console only; the hub console rejects query-string
  // credentials server-side and just gets the scrub.
  function readUrlAdminCredential() {
    try {
      const q = new URLSearchParams(location.search);
      for (const name of ['key', 'token', 'password']) {
        const v = (q.get(name) || '').trim();
        if (v) return v;
      }
    } catch (_) {}
    return '';
  }

  function scrubUrlAdminCredential() {
    if (!/[?&](key|token|password)=/.test(location.search)) return;
    try {
      const url = new URL(location.href);
      url.searchParams.delete('key');
      url.searchParams.delete('token');
      url.searchParams.delete('password');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (_) {}
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

    // URL direct-login (?key= / ?token= / ?password=): scrub the credential from
    // the address bar as soon as it is read, whatever the host kind and whatever
    // the login outcome — a failed auto-submit (rotated password, 429 lockout,
    // network error) must not leave the credential lingering in the URL/history.
    // Auto-fill once and submit through the normal login path on the full console
    // only; the hub console does not accept query-string credentials (header-only
    // server auth) and only gets the scrub.
    const urlCredential = readUrlAdminCredential();
    if (urlCredential) {
      scrubUrlAdminCredential();
      if (window.HOST.kind === 'full' && !window.HOST.getToken() && loginForm && pwdInput) {
        pwdInput.value = urlCredential;
        if (typeof loginForm.requestSubmit === 'function') {
          loginForm.requestSubmit();
        } else {
          loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
        }
      }
    }
  }

  // Brand pill version: shows the gateway's build version (e.g. v20261123-02)
  // next to the role badge. Full reads GET /api/admin/system/version; the hub has
  // no such endpoint, so the span simply stays empty there (no error surfaced).
  function setBrandVersion(v) {
    const el = $('brandVersion');
    if (el && v && v.ok && v.current_version) el.textContent = String(v.current_version);
  }

  function setupCapabilities() {
    const caps = window.HOST.capabilities;
    const isHub = window.HOST.kind === 'hub';

    const brandRole = $('brandRole');
    if (brandRole) brandRole.textContent = isHub ? 'Hub' : 'Full';

    const navModels = $('navModels');
    const navNodes = $('navNodes');
    const navAccess = $('navAccess');
    const navActivity = $('navActivity');
    const topVersionBox = $('topVersionBox');
    const cfgVaultLinkBox = $('cfgVaultLinkBox');
    const hubOverviewBox = $('hubOverviewBox');
    const fullOverviewBox = $('fullOverviewBox');
    const btnClearAllCooldowns = $('btnClearAllCooldowns');
    const btnImportFromTemplate = $('btnImportFromTemplate');

    if (navModels) navModels.hidden = false;
    if (navNodes) navNodes.hidden = !caps.nodeManager;
    // 接入信息 only describes a gateway this console can answer for: the Hub is
    // a config plane with no data plane of its own.
    if (navAccess) navAccess.hidden = isHub;
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
        const credOverlay = $('nodeCredOverlay');
        if (credOverlay && !credOverlay.hidden) { closeNodeCredOverlay(); closedSomething = true; }
        const detailOverlay = $('nodeDetailOverlay');
        if (detailOverlay && !detailOverlay.hidden) { closeNodeDetailOverlay(); closedSomething = true; }
        const tplImportOverlay = $('templateImportOverlay');
        if (tplImportOverlay && !tplImportOverlay.hidden) { closeTemplateImportOverlay(); closedSomething = true; }
        if (state.activeEditorKey) {
          state.activeEditorKey = null;
          closedSomething = true;
          if (state.activeTab === 'providers') renderProvidersList();
          else if (state.activeTab === 'models') renderModelsList();
          else if (state.activeTab === 'nodes') renderNodesList();
          else if (state.activeTab === 'activity') renderRecentRequests();
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

    const btnCloseNodeCred = $('btnCloseNodeCred');
    if (btnCloseNodeCred) {
      clk(btnCloseNodeCred, closeNodeCredOverlay);
    }
    const nodeCredOverlay = $('nodeCredOverlay');
    if (nodeCredOverlay) {
      nodeCredOverlay.addEventListener('click', (ev) => {
        if (ev.target === nodeCredOverlay) closeNodeCredOverlay();
      });
    }

    const btnCloseNodeDetail = $('btnCloseNodeDetail');
    if (btnCloseNodeDetail) clk(btnCloseNodeDetail, closeNodeDetailOverlay);
    const btnCloseNodeDetailFoot = $('btnCloseNodeDetailFoot');
    if (btnCloseNodeDetailFoot) clk(btnCloseNodeDetailFoot, closeNodeDetailOverlay);
    const nodeDetailOverlay = $('nodeDetailOverlay');
    if (nodeDetailOverlay) {
      nodeDetailOverlay.addEventListener('click', (ev) => {
        if (ev.target === nodeDetailOverlay) closeNodeDetailOverlay();
      });
    }
    clk($('btnNodeDetailRotate'), handleNodeDetailRotate);
    clk($('btnNodeDetailToggle'), handleNodeDetailToggle);

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
    // Template import「缺依赖」action: re-pull the missing key labels of a provider
    // that already exists locally (a missing provider is pulled by the import
    // button itself). One delegated listener on the static list element survives
    // the per-render innerHTML swaps; a successful pull reloads config and redraws
    // the list, so the resolved rows re-enable their import checkboxes.
    const templateImportList = $('templateImportList');
    if (templateImportList) {
      templateImportList.addEventListener('click', async (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('button[data-tpl-fetch-keys]') : null;
        if (!btn || btn.disabled) return;
        const prov = btn.getAttribute('data-tpl-fetch-keys') || '';
        if (!prov) return;
        const labels = JSON.parse(btn.getAttribute('data-labels') || '[]');
        if (!labels || labels.length === 0) return;
        btn.disabled = true;
        toast(`正在补拉供应商 ${prov} 的 ${labels.length} 个 Key 标签...`, 'info');
        try {
          // key_label must stay undefined (matching the 补拉 flow in the provider
          // editor): HOST only omits it from the payload when it is undefined.
          const res = await window.HOST.fetchVaultCredentials(prov, undefined, undefined, undefined, labels);
          if (res && res.ok) {
            toast(`已补拉供应商 ${prov} 的 ${labels.length} 个 Key 标签`, 'ok');
            await loadData();
            renderTemplateImportList();
          } else {
            const err = String(res?.error || '');
            const msg = err === 'provider_exists_local'
              ? `${prov} 是本地自建供应商，不能从中枢补拉；请在供应商页补齐 Key 标签`
              : `拉取失败: ${scrubUiText(err || '请求未成功')}`;
            toast(msg, 'err');
            btn.disabled = false;
          }
        } catch (e) {
          toast(`拉取异常: ${e.message}`, 'err');
          btn.disabled = false;
        }
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
        // The endpoint only empties the in-memory trace ring; the usage ledger
        // behind「最近请求」/「错误分析」is untouched, so the wording must not
        // promise more than it does.
        if (!confirm('确定清空内存中的请求轨迹吗？账本记录（最近请求与错误分析）会保留。')) return;
        try {
          const res = await window.HOST.clearTraces();
          if (res && res.ok) {
            toast('内存轨迹已清空', 'ok');
            await loadActivityData();
          }
        } catch (e) {
          toast(scrubUiText(e.message), 'err');
        }
      });
    }

    const recentSeg = $('recentReqSeg');
    if (recentSeg) {
      recentSeg.querySelectorAll('.seg-btn').forEach((btn) => {
        clk(btn, async () => {
          const failed = btn.getAttribute('data-failed') === '1';
          if (failed === state.recentFailedOnly) return;
          state.recentFailedOnly = failed;
          // An expanded row keyed to the previous window would outlive its record.
          state.activeEditorKey = null;
          recentSeg.querySelectorAll('.seg-btn').forEach((b) => {
            b.classList.toggle('active', b === btn);
          });
          await loadRecentRequests();
        });
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

    // A–Z index bar: delegated on the container because mountProviderAlphaBar()
    // rebuilds the chips whenever the provider buckets change.
    const alphaBar = $('providerAlphaBar');
    if (alphaBar) {
      alphaBar.addEventListener('click', (e) => {
        const chip = e.target.closest('.alpha-chip');
        if (!chip) return;
        const next = chip.getAttribute('data-alpha') || 'all';
        if (next === state.providerFilter) return;
        state.providerFilter = next;
        syncProviderAlphaActive();
        renderProvidersList();
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
              const uBox = $('systemUpdateResult');
              if (uBtn) uBtn.disabled = true;
              const uMsg = (html) => { if (uBox) uBox.innerHTML = html; };
              uMsg('<div class="text-sm"><span class="pill pill--amber">正在升级...</span></div>');
              toast('正在下载校验最新二进制并平滑替换...', 'info');
              const beforeVer = data.current_version || '';
              let uRes = null;
              try {
                uRes = await window.HOST.upgradeSystem();
              } catch (uErr) {
                uRes = { ok: false, error: uErr.message };
              }
              if (!uRes || !uRes.ok) {
                toast(`在线升级失败: ${uRes?.error || '未知错误'}`, 'err');
                uMsg(`<div class="text-sm text-muted">在线升级失败: ${eh(uRes?.error || '未知错误')}，请重试</div>`);
                if (uBtn) uBtn.disabled = false;
                return;
              }
              toast(uRes.message || '升级替换成功，服务正在重启...', 'ok');
              // Poll /api/admin/system/version every 2s (max 60s): reload only
              // once current_version actually flips, which is the definitive
              // proof the new build is serving. A single failed poll is a
              // network blip, not evidence of a restart — treating it as such
              // used to reload (and claim success) while the old process still
              // served. The 60s fallback below covers a hung restart.
              const pollDeadline = Date.now() + 60000;
              const pollTimer = setInterval(async () => {
                if (Date.now() > pollDeadline) {
                  clearInterval(pollTimer);
                  uMsg('<div class="section-bar"><span class="text-sm text-muted">升级可能未完成，请手动刷新页面确认版本</span><button class="btn btn--sm" id="btnReloadAfterUpgrade" type="button">刷新页面</button></div>');
                  clk($('btnReloadAfterUpgrade'), () => location.reload());
                  return;
                }
                let v = null;
                try {
                  v = await window.HOST.getSystemVersion();
                } catch (_) {
                  return; // transient: the process may still be restarting
                }
                const cv = (v && v.current_version) || '';
                if (v && v.ok && beforeVer && cv && cv !== beforeVer) {
                  clearInterval(pollTimer);
                  uMsg('<div class="text-sm text-ok">升级成功，正在刷新...</div>');
                  location.reload();
                }
              }, 2000);
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
      // Surface the adapter revision right here: picking a brand must tell the
      // operator which built-in adaptation is about to be applied.
      const rev = meta && meta.version ? `（适配 v${meta.version}${meta.updated_at ? ` · ${meta.updated_at}` : ''}）` : '';
      hintEl.textContent = meta ? `已按预设 ${meta.label}${rev} 自动填充` : '';
      hintEl.hidden = !meta;
      hintEl.classList.toggle('hidden', !meta);
    }
    if (!meta) return;
    const apiSel = $('newProvApiType');
    const apiType = normalizeApiType(meta.api_type);
    if (apiSel && [...apiSel.options].some((o) => o.value === apiType)) apiSel.value = apiType;
    const baseEl = $('newProvBaseUrl');
    if (baseEl && !baseEl.value.trim() && meta.base_url) baseEl.value = meta.base_url;
    // Typing the brand name is enough: the ID is a machine handle nobody wants
    // to invent twice, so derive it from the matched preset while it is still
    // empty. It stays editable for anyone who wants a custom handle.
    const idEl = $('newProvId');
    if (idEl && !idEl.value.trim()) idEl.value = meta.preset_id || meta.id;
  }

  // --- 4b. 接入信息 view (its own tab) --------------------------------------
  // The gateway serves two entry points and the client's dialect decides which
  // one to paste. Neither depends on how an upstream provider is configured:
  // the protocol picker on a provider only says how we talk *to* the upstream.
  function gatewayOrigin() {
    return location.origin || 'http://127.0.0.1:3425';
  }

  function gatewayClientKind() {
    return state.gwClient === 'anthropic' ? 'anthropic' : 'openai';
  }

  // OpenAI SDKs want base_url ending in /v1 (they append /chat/completions);
  // Anthropic SDKs and Claude Code want ANTHROPIC_BASE_URL without /v1 (they
  // append /v1/messages themselves).
  function gatewayClientValues() {
    const origin = gatewayOrigin();
    return gatewayClientKind() === 'anthropic'
      ? { label: 'ANTHROPIC_BASE_URL', base: origin, endpoint: `${origin}/v1/messages` }
      : { label: 'base_url', base: `${origin}/v1`, endpoint: `${origin}/v1/chat/completions` };
  }

  function paintGatewayClientValues() {
    const v = gatewayClientValues();
    if ($('chipBaseLabel')) $('chipBaseLabel').textContent = v.label;
    if ($('chipBaseValue')) $('chipBaseValue').textContent = v.base;
    if ($('chipEndpointValue')) $('chipEndpointValue').textContent = v.endpoint;
    if ($('gwAccessNote')) {
      $('gwAccessNote').textContent = gatewayClientKind() === 'anthropic'
        ? 'Claude Code / Anthropic SDK：把 ANTHROPIC_BASE_URL 填上面的基址（结尾不要带 /v1），SDK 会自己拼 /v1/messages；密钥填 ANTHROPIC_AUTH_TOKEN。'
        : 'OpenAI SDK / Cursor / Cherry Studio 等：base_url 填上面的基址（含 /v1），SDK 会自己拼 /chat/completions；密钥填 API Key。';
    }
    const seg = $('gwClientSeg');
    if (seg) seg.querySelectorAll('[data-gw-client]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-gw-client') === gatewayClientKind()));
  }

  // Model → the providers its route candidates point at, resolved to display
  // names. A route can bind many candidates; the card shows the first two and
  // folds the rest into +N so a heavily-routed model never stretches the row.
  function modelProviderNames(modelId) {
    const cfg = state.config || {};
    const ids = [];
    const push = (pid) => {
      if (pid && !ids.includes(pid)) ids.push(pid);
    };
    const route = (cfg.agent_models || {})[modelId];
    if (route && Array.isArray(route.candidates)) route.candidates.forEach((c) => push(c && c.provider));
    // Fixed KB slots are addressed by their category name.
    const kb = cfg.kb_models || {};
    if (Array.isArray(kb[modelId])) kb[modelId].forEach((c) => push(c && c.provider));
    const providers = cfg.providers || {};
    return ids.map((pid) => {
      const p = providers[pid];
      return (p && (p.name || p.id)) || pid;
    });
  }

  const MODEL_PROVIDER_PREVIEW = 2;

  function formatProviderNames(names) {
    if (!names.length) return '未绑定供应商';
    const shown = names.slice(0, MODEL_PROVIDER_PREVIEW);
    const rest = names.length - shown.length;
    return rest > 0 ? `${shown.join(' · ')} +${rest}` : shown.join(' · ');
  }

  // Model ids come from /api/admin/access-info, which shares its predicate with
  // the public GET /v1/models (types.ProxyConfig.AvailableModelIDs): enabled
  // agent routes plus the legacy KB slots still backed by an enabled candidate.
  // Rendering every one of them is the point — the old single chip showed only
  // the alphabetically first enabled route and silently dropped the rest.
  function renderGatewayModels() {
    const box = $('gwModelChips');
    const countPill = $('gwModelCount');
    const btnAll = $('btnCopyAllModels');
    const models = Array.isArray(state.gwModels) ? state.gwModels : [];
    if (countPill) countPill.textContent = String(models.length);
    if (btnAll) btnAll.hidden = models.length < 2;
    if (!box) return;
    if (!models.length) {
      box.innerHTML = '<div class="gw-model-empty">暂无可用模型：到「模型路由」添加并启用路由后，这里会列出 /v1/models 实际返回的全部模型 ID</div>';
      return;
    }
    box.innerHTML = models.map((m) => {
      const names = modelProviderNames(m);
      const provText = formatProviderNames(names);
      const full = names.length ? names.join(' · ') : '';
      const cap = modelCatalogTarget(m);
      // The catalog line is filled asynchronously (one cached lookup per
      // (preset, target) pair) — this is the page an operator reads model ids
      // from, so it is also where context/output/reasoning belongs.
      const capAttrs = cap
        ? ` data-cap-preset="${eh(cap.preset)}" data-cap-model="${eh(cap.target)}"`
        : '';
      return `<button class="gw-model-item" type="button" data-copy="model" data-model="${eh(m)}" title="复制 Model ID: ${eh(m)}${full ? `&#10;供应商: ${eh(full)}` : ''}">`
        + `<span class="gw-model-item-id">${eh(m)}</span>`
        + `<span class="gw-model-item-prov" title="${eh(full)}">${eh(provText)}</span>`
        + (cap ? `<span class="gw-model-item-cap"${capAttrs}></span>` : '')
        + '</button>';
    }).join('');
    fillGatewayModelCaps(box);
  }

  // Resolve the (preset, upstream model) the catalog should be asked about: the
  // first enabled candidate that names a known provider. An exposed model id can
  // differ from the upstream id (aliases), which is why the card cannot just use
  // the displayed name.
  function modelCatalogTarget(modelId) {
    const cfg = state.config || {};
    const providers = cfg.providers || {};
    const candidates = [];
    const route = (cfg.agent_models || {})[modelId];
    if (route && Array.isArray(route.candidates)) candidates.push(...route.candidates);
    const kb = cfg.kb_models || {};
    if (Array.isArray(kb[modelId])) candidates.push(...kb[modelId]);
    const ordered = candidates.filter((c) => c && c.enabled !== false).concat(candidates.filter((c) => c && c.enabled === false));
    for (const c of ordered) {
      if (!c || !c.provider) continue;
      const prov = providers[c.provider];
      if (!prov) continue;
      const preset = String(prov.preset_id || c.provider || '').trim();
      const target = String(c.target_model || modelId).trim();
      if (preset && target) return { preset, target };
    }
    return null;
  }

  function fillGatewayModelCaps(box) {
    if (!box) return;
    box.querySelectorAll('.gw-model-item-cap[data-cap-preset]').forEach((el) => {
      const preset = el.getAttribute('data-cap-preset');
      const model = el.getAttribute('data-cap-model');
      fetchModelInfo(preset, model).then((info) => {
        if (!el.isConnected) return;
        if (!info || info.ok === false) {
          // A transient lookup failure must not print a verdict the catalog
          // never gave; leave the line out and let the next render retry.
          el.textContent = '';
          return;
        }
        el.textContent = info.found ? capabilitySummary(info) : '能力目录未收录';
        el.classList.toggle('gw-model-item-cap--unknown', !info.found);
        el.title = info.found
          ? capabilitySummary(info)
          : 'models.dev 未收录该模型（常见于中转商自建别名）。可在 shared/model-catalog/overrides.json 补充上下文/输出/思考档位后重建。';
      });
    });
  }

  function renderGatewayEndpoints() {
    const box = $('gwEndpointChips');
    if (!box) return;
    const eps = Array.isArray(state.gwEndpoints) && state.gwEndpoints.length ? state.gwEndpoints : [];
    if (!eps.length) {
      box.innerHTML = '<span class="text-xs text-muted">接口清单暂不可用</span>';
      return;
    }
    box.innerHTML = eps.map((p) => `<button class="btn copy-chip" type="button" data-copy="endpoint-path" data-path="${eh(p)}" title="复制 ${eh(p)}"><span class="copy-chip-value">${eh(p)}</span></button>`).join('');
  }

  function renderAccessView() {
    const cfg = state.config || {};
    const settings = cfg.settings || {};
    const clientKey = settings.client_key || settings.proxy_api_key || '';
    paintGatewayClientValues();
    if ($('chipKeyValue')) $('chipKeyValue').textContent = clientKey || '未配置';
    if ($('accessKeyState')) {
      $('accessKeyState').textContent = clientKey
        ? '密钥在「系统设置 ①」里修改或随机生成'
        : '尚未配置客户端密钥：去「系统设置 ①」生成一把，否则所有请求都会被 401';
    }
    const keyChipBtn = $('gwCopyChips')?.querySelector('[data-copy="key"]');
    if (keyChipBtn) keyChipBtn.title = clientKey ? '复制主客户端密钥' : '主密钥未配置';
    renderGatewayModels();
    renderGatewayTestPanel();
    renderGatewayEndpoints();
    loadAccessInfo();
    bindGatewayClientSeg();
    bindGatewayCopyChips();
  }

  // --- 模拟请求：用主密钥走一遍真实 /v1 链路 --------------------------------
  // The key-row 「测试」 probes one key through the admin API; this panel answers
  // the other question — "does my *client* setup actually work end to end" — by
  // POSTing to this gateway's own /v1 endpoint with the configured client key,
  // exactly like Cursor or a curl would. No new backend endpoint: the gateway
  // already is the thing under test.
  let gwTestProto = 'openai';

  function renderGatewayTestPanel() {
    const models = Array.isArray(state.gwModels) ? state.gwModels : [];
    const list = $('gwTestModelList');
    if (list) list.innerHTML = models.map((m) => `<option value="${eh(m)}"></option>`).join('');
    const input = $('gwTestModel');
    if (input && !input.value && models.length) input.value = models[0];
    document.querySelectorAll('#gwTestProto .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-gw-proto') === gwTestProto);
      b.onclick = () => {
        gwTestProto = b.getAttribute('data-gw-proto') || 'openai';
        renderGatewayTestPanel();
      };
    });
    const btn = $('btnGwTestSend');
    if (btn) btn.onclick = runGatewayTest;
  }

  function extractTestReply(data) {
    if (!data || typeof data !== 'object') return '';
    // Anthropic: content[] text blocks. OpenAI: choices[0].message.content
    // (string, or an array of text parts in newer shapes).
    const collect = (content) => {
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return content.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('').trim();
      }
      return '';
    };
    if (Array.isArray(data.content)) return collect(data.content);
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice && choice.message) return collect(choice.message.content);
    return '';
  }

  async function runGatewayTest() {
    const box = $('gwTestResult');
    const btn = $('btnGwTestSend');
    if (!box || !btn || btn.disabled) return;
    const paint = (html, tone) => {
      box.hidden = false;
      box.className = `gw-test-result${tone ? ` gw-test-result--${tone}` : ''}`;
      box.innerHTML = html;
    };
    const key = String(state.config?.settings?.client_key || state.config?.settings?.proxy_api_key || '').trim();
    const model = String($('gwTestModel')?.value || '').trim();
    const prompt = String($('gwTestPrompt')?.value || '').trim() || '你好';
    if (!key) {
      paint('主客户端密钥还没配置：到「系统设置 ①」生成一把再来试。', 'err');
      return;
    }
    if (!model) {
      paint('先选一个模型 ID（下拉里就是 /v1/models 返回的清单）。', 'err');
      return;
    }

    const isAnthropic = gwTestProto === 'anthropic';
    const path = isAnthropic ? '/v1/messages' : '/v1/chat/completions';
    const headers = { 'content-type': 'application/json' };
    if (isAnthropic) {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.authorization = `Bearer ${key}`;
    }

    btn.disabled = true;
    btn.textContent = '发送中…';
    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 64,
          stream: false,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
      const raw = await res.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
      const meta = `HTTP ${res.status} · ${ms}ms · ${eh(model)} · ${isAnthropic ? 'Anthropic' : 'OpenAI'} 方言`;
      if (res.ok) {
        const reply = extractTestReply(data);
        paint(`<div class="gw-test-meta">${meta}</div>`
          + `<pre class="gw-test-reply">${eh(reply || '（上游返回成功，但没有可显示的文本）')}</pre>`, 'ok');
      } else {
        const message = (data && data.error && (data.error.message || data.error.type))
          || (data && data.message)
          || raw.slice(0, 400)
          || '(空响应)';
        paint(`<div class="gw-test-meta">${meta}</div>`
          + `<div class="gw-test-error">${eh(scrubUiText(String(message)))}</div>`, 'err');
      }
    } catch (err) {
      paint(`请求没发出去：${eh(scrubUiText(err && err.message ? err.message : String(err)))}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '发送';
    }
  }

  let gwAccessInFlight = false;
  async function loadAccessInfo() {
    if (gwAccessInFlight || !window.HOST || typeof window.HOST.getAccessInfo !== 'function') return;
    gwAccessInFlight = true;
    try {
      const info = await window.HOST.getAccessInfo();
      if (info) {
        if (Array.isArray(info.models)) state.gwModels = info.models;
        if (Array.isArray(info.endpoints)) state.gwEndpoints = info.endpoints;
        renderGatewayModels();
        renderGatewayTestPanel();
        renderGatewayEndpoints();
      }
    } catch (_) {
      // Informational view: keep whatever was last rendered rather than blanking it.
    } finally {
      gwAccessInFlight = false;
    }
  }

  function bindGatewayClientSeg() {
    const seg = $('gwClientSeg');
    if (!seg || seg.dataset.bound) return;
    seg.dataset.bound = '1';
    seg.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('[data-gw-client]') : null;
      if (!btn) return;
      state.gwClient = btn.getAttribute('data-gw-client') === 'anthropic' ? 'anthropic' : 'openai';
      paintGatewayClientValues();
    });
  }

  function bindGatewayCopyChips() {
    const chipValue = (kind, chip) => {
      if (kind === 'model') return chip.getAttribute('data-model') || '';
      if (kind === 'endpoint-path') return chip.getAttribute('data-path') || '';
      const v = gatewayClientValues();
      if (kind === 'base') return v.base;
      if (kind === 'endpoint') return v.endpoint;
      if (kind === 'key') {
        const cfg = state.config || {};
        const settings = cfg.settings || {};
        return String(settings.client_key || settings.proxy_api_key || '').trim();
      }
      return '';
    };

    for (const [boxId, selector, label] of [
      ['gwCopyChips', '.copy-chip[data-copy]', (k) => (k === 'base' ? '基址' : k === 'key' ? '客户端密钥' : '请求地址')],
      ['gwEndpointChips', '.copy-chip[data-copy]', (k) => (k === 'endpoint-path' ? '接口路径' : '')],
      ['gwModelChips', '.gw-model-item[data-copy="model"]', (k) => 'Model ID'],
    ]) {
      const box = $(boxId);
      if (!box || box.dataset.bound) continue;
      box.dataset.bound = '1';
      box.addEventListener('click', (ev) => {
        const chip = ev.target instanceof Element ? ev.target.closest(selector) : null;
        if (!chip || chip.disabled) return;
        const kind = chip.getAttribute('data-copy') || '';
        const value = chipValue(kind, chip);
        if (!value) return toast(kind === 'key' ? '主密钥尚未配置' : '该值尚未配置', 'warn');
        // Same helper as the other copy actions: awaits, catches a rejected write
        // (insecure http origin / no clipboard permission) and says「请手动复制」
        // instead of claiming a copy that never happened.
        copyToClipboard(value, `已复制 ${label(kind)}`);
      });
    }

    const btnAll = $('btnCopyAllModels');
    if (btnAll && !btnAll.dataset.bound) {
      btnAll.dataset.bound = '1';
      btnAll.onclick = () => {
        const models = Array.isArray(state.gwModels) ? state.gwModels : [];
        if (!models.length) return;
        copyToClipboard(models.join(', '), `已复制全部 ${models.length} 个模型 ID`);
      };
    }
  }

  // Closes the provider combobox panel of the add-model modal. Assigned by
  // setupProvCombo once the static panel markup exists; the noop
  // default keeps the modal-cancel closures safe before that.
  let closeProvPanel = () => {};

  // --- Per-model capability (model catalog) ---
  // One (preset, model) query via window.HOST.modelInfo — the node answers from
  // its store (Full) and the Hub from KV. The console never keeps a model table
  // of its own: a copy here would drift from the catalog the gateway ships.
  // Last answer per pair is memoized for the session, so moving between
  // candidates does not re-ask the same question.
  function modelInfoKey(presetId, modelId) {
    return `${String(presetId || '').trim()}/${String(modelId || '').trim()}`;
  }

  function fetchModelInfo(presetId, modelId) {
    const preset = String(presetId || '').trim();
    const model = String(modelId || '').trim();
    if (!preset || !model) return Promise.resolve(null);
    const key = modelInfoKey(preset, model);
    const cache = state.modelInfoCache;
    if (cache[key]) return Promise.resolve(cache[key]);
    if (typeof window.HOST.modelInfo !== 'function') return Promise.resolve(null);
    return window.HOST.modelInfo(preset, model).then((res) => {
      // A failed query is not cached: a transient 503 must not freeze the
      // "unknown" answer for the rest of the session.
      if (res && res.ok !== false) cache[key] = res;
      return res || null;
    }).catch(() => null);
  }

  // The upstream preset a candidate actually resolves against: the provider's
  // preset_id when bound (minimax-cn -> minimax), else the provider id itself.
  function presetIdForProvider(pId) {
    const prov = state.config?.providers?.[pId] || {};
    return String(prov.preset_id || pId || '').trim();
  }

  // Summary line for the add-model form. Mirrors the catalog contract:
  //   "上下文 200K · 最大输出 64K · 思考 low / medium / high"    (effort ladder)
  //   "上下文 128K · 最大输出 16K · 思考：仅开关"                  (toggle)
  //   "上下文 128K · 思考：不支持"                                (reasoning=false)
  //   "能力信息未知（models.dev 未收录）"                          (found=false)
  function capabilitySummary(info) {
    if (!info || info.ok === false || !info.found) return '能力信息未知（models.dev 未收录）';
    const parts = [];
    const ctx = fmtTokens(info.context_tokens);
    if (ctx) parts.push(`上下文 ${ctx}`);
    const out = fmtTokens(info.output_tokens);
    if (out) parts.push(`最大输出 ${out}`);
    const efforts = Array.isArray(info.efforts) ? info.efforts : [];
    if (efforts.length > 0) parts.push(`思考 ${efforts.join(' / ')}`);
    else if (info.supports_toggle || info.toggle) parts.push('思考：仅开关');
    else if (info.has_budget || info.budget) {
      const b = info.budget || { min: info.budget_min, max: info.budget_max };
      const min = fmtTokens(b.min);
      const max = fmtTokens(b.max);
      parts.push(`思考：token 预算${min || max ? ` ${min || '?'}~${max || '不限'}` : ''}`);
    } else if (info.reasoning) parts.push('思考：支持（档位未知）');
    else parts.push('思考：不支持');
    // The numbers came from same-named entries under other providers (the
    // operator's reseller has no preset binding): say so instead of implying an
    // exact match.
    if (info.matched_by === 'model_id') parts.push('按同名模型');
    return parts.join(' · ');
  }

  let capSeq = 0;

  // Add-model modal: one debounced query per typed/picked upstream id. Full only
  // — the Hub ships templates and has no engine to describe, so the container
  // stays hidden there instead of lingering as an empty box.
  function updateNewModelCapability() {
    const box = $('newModelCapability');
    if (!box) return;
    if (window.HOST.kind === 'hub') {
      box.hidden = true;
      box.classList.add('hidden');
      box.textContent = '';
      return;
    }
    const pId = ($('newModelProvider')?.value || '').trim();
    const target = ($('newModelTarget')?.value || '').trim();
    const seq = ++capSeq;
    if (!pId || !target) {
      box.hidden = true;
      box.classList.add('hidden');
      box.textContent = '';
      return;
    }
    fetchModelInfo(presetIdForProvider(pId), target).then((info) => {
      // A slower earlier query must not overwrite the newest answer.
      if (seq !== capSeq) return;
      box.textContent = capabilitySummary(info);
      box.hidden = false;
      box.classList.remove('hidden');
    });
  }

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

      let id = ($('newProvId')?.value || '').trim();
      const name = ($('newProvName')?.value || '').trim() || id;
      const baseUrl = ($('newProvBaseUrl')?.value || '').trim();
      const apiType = normalizeApiType($('newProvApiType')?.value);
      const keyAlias = ($('newProvKeyAlias')?.value || '').trim() || 'k1';
      const apiKey = ($('newProvApiKey')?.value || '').trim();
      const matchedMeta = matchPresetMeta(name) || matchPresetMeta(id);
      const resolvedPresetId = matchedMeta
        ? (matchedMeta.preset_id || matchedMeta.id)
        : (PRESETS_META[id]?.preset_id || '');
      // Last-resort handle: the ID field is auto-filled by the preset match, but
      // a custom provider named purely in Chinese still needs an ASCII id.
      if (!id) id = resolvedPresetId || name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

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
        if (nameInput) {
          nameInput.value = '';
          nameInput.readOnly = true;
        }
        renderKeyPills();
      }
    });
    // 对外模型名 defaults to the upstream model ID: read-only until the operator
    // explicitly opts into a custom name (only multi-candidate routes need one).
    clk($('btnCustomModelName'), () => {
      const nameInput = $('newModelName');
      if (!nameInput) return;
      nameInput.readOnly = false;
      nameInput.focus();
    });
    // Keep the read-only name in sync with the upstream target while the operator
    // has not opted into a custom name: what the client calls it is what it is.
    $('newModelTarget')?.addEventListener('input', () => {
      const targetVal = ($('newModelTarget')?.value || '').trim();
      const nameInput = $('newModelName');
      if (nameInput && nameInput.readOnly) nameInput.value = targetVal;
      // A pill may only look picked while it IS the current target: erasing or
      // rewriting the field by hand must clear the highlight, otherwise the
      // confirm step would silently bind the stale pill's model id.
      document.querySelectorAll('#npbPills .probe-pill--managed').forEach((b) => {
        if ((b.textContent || '').trim() !== targetVal) b.classList.remove('probe-pill--managed');
      });
      updateNewModelCapability();
    });
    clk($('btnCancelAddModel'), cancelAddModel);

    // Switching the provider invalidates the previous probe results, the picked
    // keys (they belong to the old provider's key pool), the picked upstream
    // target (it belongs to the old provider's model list) and any custom
    // 对外模型名 typed for the old provider — resetProbe covers all.
    $('newModelProvider')?.addEventListener('change', () => {
      resetProbe({ resetName: true });
      renderKeyPills();
      updateNewModelCapability();
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
          // Shared with the route editor's「+ 添加候选」popup.
          state.probedModelsByProvider[prov] = models;
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
      // 对外模型名 is optional now: fall back to the upstream target model ID,
      // then to the probed model picked in the pill list.
      const nameVal = ($('newModelName')?.value || '').trim();
      const targetVal = ($('newModelTarget')?.value || '').trim();
      const pickedPill = document.querySelector('#npbPills .probe-pill--managed');
      const mName = nameVal || targetVal || (pickedPill?.textContent || '').trim();
      const prov = ($('newModelProvider')?.value || '').trim();
      const target = targetVal || mName;
      const pickedLabels = [...document.querySelectorAll('#nmKeys .probe-pill--managed')]
        .map((b) => b.dataset.key)
        .filter(Boolean);

      if (!mName) return toast('请先选择或填写模型', 'warn');

      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.agent_models = state.config.agent_models || {};

      if (state.config.agent_models[mName]) {
        state.activeEditorKey = `m_${mName}`;
        toggle(mForm, false);
        renderModelsList();
        return toast('路由已存在', 'info');
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
      await persistConfig('路由添加成功');
    });
  }

  // --- Provider combobox (searchable dropdown for「首选供应商」) ---
  // Replaces the bare <select>: an input plus the floating #npPanel (.np-panel,
  // absolutely positioned under the input by CSS inside the .np-combo wrapper)
  // whose rows show the provider name plus a small Base URL line and a pinned top
  // search filter. Rows reuse .row/.who/.name from the provider list; the panel
  // itself is a .card. Only existing providers are listed (a route cannot be
  // created against a provider that does not exist yet). Keyboard semantics mirror
  // a native select: ArrowDown/ArrowUp walk the options, Esc closes the panel first
  // and only then lets the global handler close the modal.
  function setupProvCombo() {
    const input = $('newModelProvider');
    const panel = $('npPanel');
    if (!input || !panel) return;

    const showPanel = () => {
      syncProvOptions();
      toggle(panel, true);
      $('npSearch')?.focus();
    };
    closeProvPanel = () => toggle(panel, false);

    input.addEventListener('focus', () => { if (panel.hidden) showPanel(); });
    // Clicking an already-focused input fires no focus event; without this an
    // Esc-closed panel could never be reopened without blurring the input first.
    input.addEventListener('click', () => { if (panel.hidden) showPanel(); });
    // A pointerdown outside the combo (input + floating panel) dismisses the panel.
    // The panel is never closed from an input event: the operator is typing in
    // #npSearch when they click a row, and any close keyed to that input would
    // fire before the row's click lands. Rows are inside .np-combo, so this
    // handler leaves them alone.
    document.addEventListener('pointerdown', (e) => {
      if (panel.hidden) return;
      const combo = input.closest('.np-combo');
      if (combo && !combo.contains(e.target)) closeProvPanel();
    });
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
      box.innerHTML = '<div class="row row--static text-xs text-muted">无匹配供应商（请先在供应商页添加）</div>';
      return;
    }
    ids.forEach((pId) => {
      const p = provs[pId] || {};
      const rowBtn = ce('button');
      rowBtn.className = 'row';
      rowBtn.setAttribute('role', 'option');
      rowBtn.innerHTML = `<div class="who"><div class="name">${eh(p.name || pId)}</div><div class="text-xs text-muted">${eh(p.base_url || '')}</div></div>`;
      // mousedown is prevented so focus never leaves #npSearch mid-click: the click
      // lands on the row instead of being consumed by a focus transfer (this is a
      // focus guard, not a close-guard — no input listener closes the panel).
      rowBtn.addEventListener('mousedown', (e) => e.preventDefault());
      clk(rowBtn, () => pickProv(pId));
      box.appendChild(rowBtn);
    });
  }

  // Commit the picked provider: fill the combobox input, close the panel, move
  // focus to the next field and refresh everything that depends on the provider
  // (probe results + key pills). Setting .value programmatically fires no change
  // event, so the reset that the change handler does for typed input must happen
  // here too — including the custom 对外模型名, which belongs to the old provider.
  function pickProv(pId) {
    const input = $('newModelProvider');
    if (input) input.value = pId;
    closeProvPanel();
    resetProbe({ resetName: true });
    renderKeyPills();
    updateNewModelCapability();
    $('newModelTarget')?.focus();
  }

  // --- Add-model form: key picking + upstream model probe ---
  // Clears everything the previous probe session produced, including「上游目标模型
  // ID」: a target picked (or typed) against one provider must never survive a
  // provider switch — confirm would otherwise persist the old provider's model id
  // into the new provider's candidates as a silent broken route.
  // opts.resetName also wipes an operator-typed 对外模型名 and folds it back to
  // read-only: a provider switch is a fresh route, so the previous provider's
  // custom name must not become the new provider's target_model through the
  // `targetVal || mName` fallback. A probe re-run on the same provider keeps it.
  function resetProbe(opts = {}) {
    state.addModelProbed = null;
    const filterEl = $('npbFilter');
    if (filterEl) filterEl.value = '';
    toggle('npbBox', false);
    const pills = $('npbPills');
    if (pills) pills.innerHTML = '';
    const targetEl = $('newModelTarget');
    if (targetEl) targetEl.value = '';
    // The capability line describes the cleared target, so it goes with it.
    capSeq++;
    const capBox = $('newModelCapability');
    if (capBox) {
      capBox.hidden = true;
      capBox.classList.add('hidden');
      capBox.textContent = '';
    }
    const nameEl = $('newModelName');
    if (nameEl && (nameEl.readOnly || opts.resetName)) {
      nameEl.value = '';
      if (opts.resetName) nameEl.readOnly = true;
    }
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
      toggle('nmKeysVaultHint', false);
      return;
    }
    // Capsules show the key label only: the vault/local distinction is a single
    // line above the pill group (#nmKeysVaultHint), not a badge repeated per pill.
    // Not on the hub console itself: there every key is hub-issued, so the
    //「删除会本地移除、可重新拉取」wording would be wrong.
    const prov = state.config?.providers?.[provId] || {};
    const hasVaultKey = !isHubMode() && (prov.origin === 'vault' || keys.some((k) => k?.origin === 'vault'));
    toggle('nmKeysVaultHint', hasVaultKey);
    keys.forEach((k, idx) => {
      const label = k?.label || k?.id || `key-${idx}`;
      const pill = ce('button');
      pill.type = 'button';
      pill.dataset.key = label;
      pill.className = 'probe-pill';
      pill.textContent = label;
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
          if (targetInput) {
            targetInput.value = modelName;
            // Reuse the same sync path as typing (read-only name mirrors it).
            targetInput.dispatchEvent(new Event('input'));
          }
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
      access: $('viewAccess'),
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

    if (tab === 'access') {
      // Re-read on every visit: routes and keys change on other tabs.
      renderAccessView();
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
          setBrandVersion(v);
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

        // “未上报” here always meant USAGE (which models the node actually served),
        // not the delivered template — reading it as “config didn't land” was a
        // real support case in the lite E2E. Name it for what it is.
        const usageModels = n.usage && n.usage.models ? Object.keys(n.usage.models) : [];
        const modelText = usageModels.length
          ? usageModels.slice(0, 3).map((m) => eh(m)).join(', ') + (usageModels.length > 3 ? ` +${usageModels.length - 3}` : '')
          : '<span class="text-muted">用量未上报</span>';

        const binBadge = n.last_binary_version
          ? ` <span class="pill tabular">${eh(n.last_binary_version)}</span>`
          : '';
        const tr = ce('tr');
        tr.innerHTML = `
          <td><strong>${eh(n.name || n.id)}</strong></td>
          <td><span class="pill pill--accent">${eh(n.role || 'full')}</span>${binBadge}</td>
          <td>${statusHtml}</td>
          <td class="text-sm">${modelText}</td>
          <td class="tabular">配置 #${n.last_config_version || 1} · ${n.sync_count || 0} 次</td>
          <td class="tabular">${eh(lastMs ? formatTime(lastMs / 1000) : '从未同步')}</td>
          <td class="tabular">${eh(n.last_ip || '未上报')}</td>
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

  // One snapshot feeds both overview cards (recent requests + error analysis), so
  // the aggregate can never describe a different window than the table above it.
  function applyRecentRequests(res) {
    state.recentRequests = Array.isArray(res.requests) ? res.requests : [];
    state.recentSource = typeof res.source === 'string' ? res.source : '';
    state.recentTruncated = Boolean(res.truncated);
    renderRecentRequests();
    renderErrorAnalysis();
  }

  // The overview's only request-history source. Used by the regular refresh path
  // (loadActivityData) and by the 全部 / 仅失败与重试 segment — never by a timer of
  // its own: the page keeps the existing refresh cadence.
  async function loadRecentRequests() {
    try {
      const res = await window.HOST.getRecentRequests(50, state.recentFailedOnly);
      if (res && res.ok) applyRecentRequests(res);
      return res;
    } catch (e) {
      toast(`请求记录加载失败: ${scrubUiText(e.message)}`, 'err');
      return null;
    }
  }

  async function loadActivityData() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      const [usageRes, recentRes, lanesRes, cdRes] = await Promise.all([
        window.HOST.getUsage(state.currentPeriod, tz),
        window.HOST.getRecentRequests(50, state.recentFailedOnly).catch(() => null),
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
      if (recentRes && recentRes.ok) {
        applyRecentRequests(recentRes);
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

  // --- Provider A–Z index bar (全部 + A–Z + #) ---
  // Bucket rule shared with renderProvidersList(): first character of the display
  // name, [a-zA-Z] folded to upper case, anything else filed under '#'. Sharing
  // one helper is what keeps a chip from ever filtering down to an empty list.
  function providerBucketOf(p, pId) {
    const label = String(p?.name || pId || '').trim();
    const first = label[0] || '';
    return /[a-zA-Z]/.test(first) ? first.toUpperCase() : '#';
  }

  // Selection is a class flip, not a rebuild: rebuilding would drop keyboard
  // focus from the chip the operator just activated.
  function syncProviderAlphaActive() {
    const bar = $('providerAlphaBar');
    if (!bar) return;
    const active = state.providerFilter || 'all';
    bar.querySelectorAll('.alpha-chip').forEach((btn) => {
      const on = btn.getAttribute('data-alpha') === active;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  // Mirrors state.config.providers into the bar. Every config mutation (loadData /
  // persistConfig / raw-JSON save) funnels through renderProvidersList(), which
  // calls this; the signature guard keeps per-keystroke search re-renders from
  // churning the DOM.
  function mountProviderAlphaBar() {
    const bar = $('providerAlphaBar');
    if (!bar) return;
    const providers = (state.config && state.config.providers) || {};
    const counts = {};
    let total = 0;
    for (const [pId, p] of Object.entries(providers)) {
      const bucket = providerBucketOf(p, pId);
      counts[bucket] = (counts[bucket] || 0) + 1;
      total += 1;
    }
    // A filter left pointing at a bucket that no longer exists (provider renamed
    // or removed) would strand the list on the empty state with no chip left to
    // click back, so fall through to 全部.
    if (state.providerFilter !== 'all' && !counts[state.providerFilter]) {
      state.providerFilter = 'all';
    }
    if (total === 0) {
      bar.innerHTML = '';
      bar.dataset.sig = 'empty';
      bar.hidden = true;
      return;
    }
    const chips = [{ key: 'all', label: '全部', hint: '全部供应商', count: total }];
    for (const letter of Object.keys(counts).filter((k) => k !== '#').sort()) {
      chips.push({ key: letter, label: letter, hint: `${letter} 开头`, count: counts[letter] });
    }
    if (counts['#']) chips.push({ key: '#', label: '#', hint: '非 A–Z 开头', count: counts['#'] });
    bar.hidden = false;
    const sig = chips.map((c) => `${c.key}:${c.count}`).join('|');
    if (bar.dataset.sig === sig) {
      syncProviderAlphaActive();
      return;
    }
    bar.dataset.sig = sig;
    bar.innerHTML = '';
    for (const c of chips) {
      const btn = ce('button');
      btn.type = 'button';
      btn.className = 'alpha-chip';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-alpha', c.key);
      btn.setAttribute('aria-label', `${c.hint}，${c.count} 个供应商`);
      btn.title = `${c.hint} · ${c.count} 个`;
      const keyEl = ce('span');
      keyEl.className = 'alpha-chip-key';
      keyEl.textContent = c.label;
      const cntEl = ce('span');
      cntEl.className = 'alpha-chip-count tabular';
      cntEl.textContent = String(c.count);
      btn.appendChild(keyEl);
      btn.appendChild(cntEl);
      bar.appendChild(btn);
    }
    syncProviderAlphaActive();
  }

  // --- View: Providers (M1~M6, U2, U4) ---
  function renderProvidersList() {
    const container = $('providersList');
    if (!container) return;
    // Every config mutation ends in this render, so this is the one place the
    // index bar needs to re-sync with state.config.providers.
    mountProviderAlphaBar();
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
      // Alphabetical bucket: the only filter that earns its slot. Status pills on
      // the card already say enabled/healthy; the only question an operator has
      // is "where in the list is <brand>", and A–Z answers it directly. Bucketing
      // goes through providerBucketOf() so the chip counts and this filter can
      // never disagree.
      if (f !== 'all' && providerBucketOf(p, pId) !== f) return false;
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
      // last_ok is the legacy live field (校验/批量探活 write it); the typed
      // config only persists last_test, so after a reload the card counters fall
      // back to the per-key test verdict instead of showing "0 正常".
      const okCount = keys.filter((k) => keyHealthFlag(k) === true).length;
      const failCount = keys.filter((k) => keyHealthFlag(k) === false).length;
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
      // Adapter version wins whenever we can resolve it — including vault-pulled
      // providers, whose preset_id arrives in the hub manifest and resolves against
      // the local preset catalog. The rule_hash fingerprint is only the fallback for
      // vault rules we cannot map to a shipped adapter file.
      const isVaultCard = !isHubMode() && p.origin === 'vault';
      const adaptedPill = presetVersionPillHtml(p);
      const versionPill = adaptedPill
        ? adaptedPill
        : (isVaultCard && p.rule_hash
          ? `<span class="pill tabular" title="中枢规则指纹 (rule_hash 前 8 位；未匹配到内置适配文件)">指纹 ${eh(String(p.rule_hash).slice(0, 8))}</span>`
          : '');
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

    const adapterText = p.adapter_rules && Object.keys(p.adapter_rules).length > 0
      ? JSON.stringify(p.adapter_rules, null, 2)
      : '';
    // Adapter-file version/date note under the preset binding input; rendered for
    // vault providers too (the input itself is locked, the note stays read-only).
    // Same precedence as the card badge: resolved adapter file → version, hub
    // rules we cannot map to a shipped file → 指纹, otherwise 自定义（无适配文件）.
    const versionText = presetVersionText(presetMetaForProvider(p, String(p?.preset_id || '').trim()))
      || (p.rule_hash ? `中枢规则指纹 ${String(p.rule_hash).slice(0, 8)}` : '自定义（无适配文件）');
    const presetVersionHint = `<span class="text-xs text-muted mt-1">${eh(versionText)}</span>`;

    const lockAttr = isVaultProv ? ' disabled' : '';
    // Two independent toggles. Each one names an upstream endpoint the gateway
    // will route to; having both enabled is the common case for vendors that
    // ship OpenAI and Anthropic front doors off the same account. "默认" pulls
    // the URL from the preset; "自定义" lets the operator override it (a
    // proxy, a regional endpoint, a different plan).
    const baseIsCustom = Boolean(p.base_url && presetMetaForProvider(p, p.preset_id)?.base_url && p.base_url !== presetMetaForProvider(p, p.preset_id).base_url);
    const antIsCustom = Boolean(p.anthropic_base_url && presetMetaForProvider(p, p.preset_id)?.anthropic_base_url && p.anthropic_base_url !== presetMetaForProvider(p, p.preset_id).anthropic_base_url);
    const openaiEnabled = Boolean(p.base_url) || curApiType === 'openai-completions' || curApiType === 'gemini';
    const anthropicEnabled = Boolean(p.anthropic_base_url) || curApiType === 'anthropic-messages';
    const meta = presetMetaForProvider(p, p.preset_id);
    const baseDefault = meta?.base_url || '';
    const antDefault = meta?.anthropic_base_url || '';
    const openaiRow = `<label class="form-label form-label--check"><input type="checkbox" id="ed_p_openai_on_${pId}" ${openaiEnabled ? 'checked' : ''}${lockAttr}><span>OpenAI 兼容端点（/v1/chat/completions）</span></label>`
      + `<div class="input-row mt-1"><input class="input input--code" id="ed_p_base_${pId}" value="${eh(p.base_url || baseDefault)}" placeholder="${eh(baseDefault || 'https://api.example.com/v1')}" ${openaiEnabled ? '' : 'disabled'}${lockAttr}><button class="btn btn--sm" id="btn_base_default_${pId}" type="button" title="重置为预设默认" ${baseDefault ? '' : 'disabled'}>默认</button><button class="btn" id="btn_detect_ed_${pId}" type="button" ${isHubMode() || isVaultProv ? 'hidden' : ''}>自动探测</button></div>`;
    const anthropicRow = `<label class="form-label form-label--check"><input type="checkbox" id="ed_p_ant_on_${pId}" ${anthropicEnabled ? 'checked' : ''}${lockAttr}><span>Anthropic Messages 端点（/v1/messages）</span></label>`
      + `<div class="input-row mt-1"><input class="input input--code" id="ed_p_ant_${pId}" value="${eh(p.anthropic_base_url || antDefault)}" placeholder="${eh(antDefault || 'https://api.example.com/anthropic')}" ${anthropicEnabled ? '' : 'disabled'}${lockAttr}><button class="btn btn--sm" id="btn_ant_default_${pId}" type="button" title="重置为预设默认" ${antDefault ? '' : 'disabled'}>默认</button></div>`;

    const syncDraftFields = () => {
      if (q(`#ed_p_name_${pId}`)) p.name = q(`#ed_p_name_${pId}`).value.trim();
      // OpenAI endpoint: presence of the checkbox decides whether this provider
      // serves OpenAI clients at all; api_type tracks which one is primary.
      const openaiOn = q(`#ed_p_openai_on_${pId}`)?.checked !== false;
      const anthOn = q(`#ed_p_ant_on_${pId}`)?.checked === true;
      if (openaiOn && q(`#ed_p_base_${pId}`)) p.base_url = q(`#ed_p_base_${pId}`).value.trim();
      else if (!openaiOn) delete p.base_url;
      if (anthOn && q(`#ed_p_ant_${pId}`)) p.anthropic_base_url = q(`#ed_p_ant_${pId}`).value.trim();
      else if (!anthOn) delete p.anthropic_base_url;
      if (q(`#ed_p_preset_${pId}`)) p.preset_id = q(`#ed_p_preset_${pId}`).value.trim();
      // api_type drives the gateway's primary dispatch. Anthropic-only providers
      // route /v1/messages; everything else routes /v1/chat/completions.
      p.api_type = anthOn && !openaiOn ? 'anthropic-messages' : (anthOn && p.api_type === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions');
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

    // Preset binding is read-only: the gateway resolves it against the shipped
    // preset library, so letting the operator type a different id here would
    // drift from the adapter file that actually runs. Show it as a badge.
    const presetReadOnly = `<span class="pill">${eh(p.preset_id || '（未绑定预设）')}</span>${presetVersionHint}`;

    wrap.innerHTML = `<div class="form-grid">${[
      fg('供应商标识 / 名称', `<input class="input" id="ed_p_name_${pId}" value="${eh(p.name || pId)}"${lockAttr}>`),
      `<div class="form-group"><label class="form-label">请求地址（可同时启用两种，客户端按入口调用）</label><div class="mt-1">${openaiRow}</div><div class="mt-2">${anthropicRow}</div></div>`,
      fg('该供应商整体 RPM 上限', `<input class="input" id="ed_p_rpm_${pId}" type="number" value="${p.rpm_per_key || ''}" placeholder="0 = 不限"${lockAttr}>`),
      fg('预设', presetReadOnly),
      `<div class="form-group"><label class="form-label form-label--check"><input type="checkbox" id="ed_p_hide_ua_${pId}" ${p.hide_client_name ? 'checked' : ''}${lockAttr}><span>隐藏客户端 User-Agent</span></label></div>`,
    ].join('')}</div><details class="headers-details mt-3"><summary class="form-label">高级 (配额重置 / 适配规则)</summary><div class="form-grid mt-2">${[
      fg('每日重置时间 (quota_reset_at)', `<input class="input" id="ed_p_reset_${pId}" value="${eh(p.quota_reset_at || '00:00+08:00')}">`),
      fg('声明式适配规则 (adapter_rules JSON，中枢托管时只读)', `<textarea class="textarea textarea--json" id="ed_p_rules_${pId}" placeholder='{"stream_only":false}'${lockAttr}>${eh(adapterText)}</textarea>`),
    ].join('')}</div></details>${vaultNotice}<div class="section-bar mt-4"><span class="form-label">API 密钥池 (${keys.length})</span><div class="fields"><button class="btn btn--sm" id="btn_batch_test_keys_${pId}" type="button" title="用每把 Key 真发一句「你好」，验证推理额度而不只是能列模型">${isHubMode() ? '逐把测 Key' : '一键测全部 Key'}</button><button class="btn btn--sm" id="btn_oauth_start_${pId}" type="button" ${showOAuth ? '' : 'hidden'}>OAuth 扫码登录</button></div></div><div class="snippet-box hidden mb-3" id="oauth_box_${pId}" hidden><div class="snippet-header"><span class="form-label">MiniMax OAuth 设备授权码:</span><span class="pill pill--amber" id="oauth_status_${pId}">等待扫码...</span></div><div class="text-sm mt-1">请点击访问：<a id="oauth_link_${pId}" target="_blank" rel="noopener noreferrer" class="tabular"></a> 并在页面中输入验证码：<strong class="tabular" id="oauth_code_${pId}"></strong></div></div><div class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>启用</th><th>标签</th><th>Key 密文</th><th>权重</th>${isHubMode() ? '' : '<th>归属</th>'}<th>状态</th><th>操作</th></tr></thead><tbody id="p_keys_tbody_${pId}"></tbody></table></div></div>${vaultKeyPickHtml}${editorActionsHtml}`;

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
      // The most recent per-key real-inference test outranks the legacy
      // last_ok/last_status pill: it is the verdict the operator asked for, with
      // the failure reason and the actual reply. A live cooldown stays visible.
      let statusHtml = cooldownSec > 0
        ? `<button class="btn btn--sm btn--danger btn_clear_k_cd tabular" type="button" title="点击解除此 Key 冷却">冷却 ${formatCooldown(cooldownSec)} · 解除</button>`
        : '';
      const lastTestPill = keyLastTestPill(k.last_test);
      if (lastTestPill) {
        statusHtml = `${statusHtml}${statusHtml ? ' ' : ''}${lastTestPill}`;
      } else if (cooldownSec <= 0) {
        if (k.last_ok === true) {
          statusHtml = `<span class="pill pill--green tabular">正常 ${k.last_latency_ms || 0}ms</span>`;
        } else if (k.last_ok === false) {
          statusHtml = `<span class="pill pill--red">异常${k.last_status ? ` (${k.last_status})` : ''}</span>`;
        } else {
          statusHtml = '<span class="pill pill--green">就绪</span>';
        }
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
            <button class="btn btn--sm btn_test_k" data-idx="${idx}" type="button" title="用这把 Key 真发一句「你好」，验证推理额度而不只是能列模型">测试</button>
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

      // Per-key real inference test. The server resolves the stored secret from
      // key_id/key_label, so nothing secret crosses the wire in this call. The
      // verdict lands on the key object (persisted by「保存供应商」) and shows in
      // the status cell immediately.
      clk(tr.querySelector('.btn_test_k'), async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '测试中…';
        const routeModel = firstRouteTargetModel(pId);
        const payload = { provider: pId, key_id: k.id || '', key_label: keyLabel };
        if (routeModel) payload.model = routeModel;
        toast(`正在测试 Key [${keyLabel}]（真实推理）...`, 'info');
        try {
          const res = await window.HOST.testKey(payload);
          const lt = applyKeyLastTest(k, res);
          toast(
            lt.ok
              ? `Key [${keyLabel}] 可用 · ${lt.latency_ms}ms`
              : `Key [${keyLabel}] 测试失败: ${lt.status || 0} ${lt.reason || 'unknown'}${lt.err_type ? ` · ${lt.err_type}` : ''}`,
            lt.ok ? 'ok' : 'err'
          );
          renderProvidersList();
          if (window.HOST.kind === 'hub') renderHubOverview();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '测试';
          toast(`测试异常: ${scrubUiText(err.message)}`, 'err');
        }
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

    // Batch test: every key gets the same real inference probe, one at a time,
    // so the verdict reflects inference quota — not just "can list models".
    clk(q(`#btn_batch_test_keys_${pId}`), async () => {
      const routeModel = firstRouteTargetModel(pId);
      toast(`正在逐把测试 ${keys.length} 把 Key（真实推理）...`, 'info');
      let succ = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const keyLabel = k.label || k.id || `key-${i}`;
        try {
          const payload = { provider: pId, key_id: k.id || '', key_label: keyLabel };
          if (routeModel) payload.model = routeModel;
          const r = await window.HOST.testKey(payload);
          if (applyKeyLastTest(k, r).ok) succ++;
        } catch (_) {
          k.last_ok = false;
        }
      }
      toast(`逐把测试完成: ${succ}/${keys.length} 把 Key 可用`, succ === keys.length ? 'ok' : 'warn');
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

    // Toggle an endpoint: enabling it seeds the input with the preset's default
    // URL if it was empty; disabling it clears the saved URL on save (see
    // syncDraftFields). The two endpoints are independent — most vendors serve
    // both, and that's exactly when an operator wants them both on.
    clk(q(`#ed_p_openai_on_${pId}`), () => {
      const on = q(`#ed_p_openai_on_${pId}`).checked;
      const inp = q(`#ed_p_base_${pId}`);
      if (inp) {
        inp.disabled = !on;
        if (on && !inp.value.trim() && baseDefault) inp.value = baseDefault;
      }
    });
    clk(q(`#ed_p_ant_on_${pId}`), () => {
      const on = q(`#ed_p_ant_on_${pId}`).checked;
      const inp = q(`#ed_p_ant_${pId}`);
      if (inp) {
        inp.disabled = !on;
        if (on && !inp.value.trim() && antDefault) inp.value = antDefault;
      }
    });
    clk(q(`#btn_base_default_${pId}`), () => {
      const inp = q(`#ed_p_base_${pId}`);
      if (inp && baseDefault) inp.value = baseDefault;
    });
    clk(q(`#btn_ant_default_${pId}`), () => {
      const inp = q(`#ed_p_ant_${pId}`);
      if (inp && antDefault) inp.value = antDefault;
    });

    clk(q(`#btn_save_prov_${pId}`), async () => {
      syncDraftFields();
      delete p.refresh_every;
      delete p.auto_include;
      // Model alias mapping lives on the route (模型路由页), not on the
      // provider — the field is no longer edited here, so preserve whatever the
      // provider already carries and stop trying to read a control we removed.

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
  // Full-node ADMIN_PASSWORDs now live in the Hub KV and ride back on the node
  // list payload (node.admin_password), so the install overlay reads the stored
  // value. This session map is only the legacy fallback for a hub old enough to
  // not store passwords: it keeps a generated value stable within the session so
  // re-opening the overlay does not silently mint a different password.
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
      // Password priority: the KV-stored value on the node list record, then the
      // issuance/rotation payload, then the session-stable legacy fallback (see
      // nodeAdminPassMem above) for hubs that do not store passwords yet.
      adminPass:
        node?.admin_password || material.admin_password || material.node?.admin_password || getStableNodeAdminPass(nodeId, role),
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

  // --- Node credentials overlay (re-view the stored admin password) ---
  const CRED_PASS_MASK = '●●●●●●●●●●●●';
  let nodeCredReturnEl = null;

  async function handleNodeCredClick(nodeId) {
    try {
      // Read-only GET: the credentials endpoint never rotates the token.
      const res = await window.HOST.request(`/api/admin/nodes/${encodeURIComponent(nodeId)}/credentials`);
      const data = await res.json();
      if (res.ok && data && data.ok) {
        openNodeCredOverlay(nodeId, data);
      } else {
        toast((data && data.error) || '获取节点密码失败', 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function openNodeCredOverlay(nodeId, data) {
    const overlay = $('nodeCredOverlay');
    if (!overlay) return;
    const node = (state.nodes || []).find((n) => n.id === nodeId);
    const titleEl = $('nodeCredTitle');
    const subEl = $('nodeCredSub');
    if (titleEl) titleEl.textContent = `后台密码 — ${node?.name || nodeId}`;
    if (subEl) subEl.textContent = 'Full 节点管理控制台 (/admin) 的登录密码，明文保存在 Hub，可随时回看';
    const body = $('nodeCredBody');
    if (body) {
      if (!data || data.role !== 'full') {
        body.innerHTML = '<div class="notice-strip mb-2"><span>lite 节点无后台密码（Lite 部署没有管理控制台）。</span></div>';
      } else if (!data.admin_password) {
        body.innerHTML = `<div class="notice-strip notice-strip--warn mb-2"><span>${eh(
          data.admin_password_note || '该节点未存有后台密码；重新获取安装命令（将轮换 Token）时会生成新密码并保存。'
        )}</span></div>`;
      } else {
        const ck = String(data.client_key || '');
        const passStrip = `<div class="notice-strip notice-strip--warn mb-2">
          <span>后台登录密码: <strong class="tabular" data-cred-pass>${CRED_PASS_MASK}</strong></span>
          <button class="btn btn--sm" data-cred-reveal type="button">显示</button>
          <button class="btn btn--sm" data-cred-copy type="button">复制密码</button>
        </div>`;
        const ckStrip = ck
          ? `<div class="notice-strip mb-2"><span>客户端 API Key: <strong class="tabular">${eh(ck)}</strong></span><button class="btn btn--sm" data-cred-copy-ck type="button">复制 API Key</button></div>`
          : `<div class="notice-strip mb-2"><span>${eh(data.client_key_note || 'Hub 未存有该节点的客户端密钥。')}</span></div>`;
        body.innerHTML = passStrip + ckStrip;

        // Masked by default; the reveal toggle swaps text content only (no style
        // writes, per the zero-inline-style gate).
        const passEl = body.querySelector('[data-cred-pass]');
        const revealBtn = body.querySelector('[data-cred-reveal]');
        let revealed = false;
        if (revealBtn && passEl) {
          clk(revealBtn, () => {
            revealed = !revealed;
            passEl.textContent = revealed ? data.admin_password : CRED_PASS_MASK;
            revealBtn.textContent = revealed ? '隐藏' : '显示';
          });
        }
        const copyBtn = body.querySelector('[data-cred-copy]');
        if (copyBtn) clk(copyBtn, () => copyToClipboard(data.admin_password, '后台登录密码已复制'));
        const ckBtn = body.querySelector('[data-cred-copy-ck]');
        if (ckBtn) clk(ckBtn, () => copyToClipboard(ck, '客户端 API Key 已复制'));
      }
    }
    overlay.hidden = false;
    overlay.classList.remove('hidden');
    nodeCredReturnEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeBtn = $('btnCloseNodeCred');
    if (closeBtn) closeBtn.focus();
  }

  function closeNodeCredOverlay() {
    const overlay = $('nodeCredOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.add('hidden');
    const back = nodeCredReturnEl;
    nodeCredReturnEl = null;
    if (back && document.contains(back)) back.focus();
  }

  // --- Node detail overlay (identity + credentials + runtime state) ---
  // The detail view is read-only on open: it only GETs the credentials endpoint,
  // so looking at a node never rotates its token. Rotation and revoke/restore are
  // explicit footer actions, each behind its own confirmation.
  const NODE_DETAIL_MASK = '●●●●●●●●●●●●';
  const NODE_DETAIL_SECRET_LABELS = { token: '节点 Token', client_key: '客户端密钥', admin_password: '后台登录密码' };
  let nodeDetailReturnEl = null;
  let nodeDetailNodeId = null;

  function formatDateTime(val) {
    if (!val) return '';
    const d = typeof val === 'number' ? new Date(val * 1000) : new Date(val);
    return Number.isNaN(d.getTime()) ? String(val) : d.toLocaleString();
  }

  function nodeScopeText(list, label) {
    const arr = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!arr.length || arr.includes('*')) return `全部${label} (*)`;
    return arr.join('、');
  }

  // Same one-row-per-item layout as the settings page (docs §6.4). `desc` is
  // mirrored into title= for hover, and the value goes in the control column.
  function nodeDetailRow(title, desc, valueHtml) {
    return `<div class="setting-row" title="${eh(desc)}"><div class="setting-main"><div class="setting-title">${eh(title)}</div><div class="setting-desc">${eh(desc)}</div></div><div class="setting-control">${valueHtml}</div></div>`;
  }

  // A credential row: masked by default, eye toggle reveals in place, copy button
  // works on the stored plaintext regardless of the mask state.
  function nodeDetailSecretRow(title, desc, key, value, emptyNote) {
    const shown = value
      ? `<div class="tabular node-detail-secret" data-detail-secret="${key}">${NODE_DETAIL_MASK}</div>`
      : `<div class="node-detail-secret text-muted">${eh(emptyNote || '未保存')}</div>`;
    const buttons = value
      ? `<button class="btn btn--sm" type="button" data-detail-eye="${key}" aria-label="显示${eh(title)}" aria-pressed="false">${window.uiIcon ? window.uiIcon('eye') : ''}<span data-detail-eye-label>显示</span></button>`
        + `<button class="btn btn--sm" type="button" data-detail-copy="${key}">复制</button>`
      : '';
    return `<div class="setting-row" title="${eh(desc)}"><div class="setting-main"><div class="setting-title">${eh(title)}</div><div class="setting-desc">${eh(desc)}</div>${shown}</div><div class="setting-control">${buttons}</div></div>`;
  }

  async function handleNodeDetailClick(nodeId) {
    try {
      // Read-only GET: like 密码, viewing 详情 must never rotate the token.
      const res = await window.HOST.request(`/api/admin/nodes/${encodeURIComponent(nodeId)}/credentials`);
      const data = await res.json();
      if (res.ok && data && data.ok) {
        openNodeDetailOverlay(nodeId, data);
      } else {
        toast((data && data.error) || '获取节点详情失败', 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function openNodeDetailOverlay(nodeId, data) {
    const overlay = $('nodeDetailOverlay');
    if (!overlay) return;
    nodeDetailNodeId = nodeId;
    const node = (state.nodes || []).find((n) => n.id === nodeId) || {};
    const role = node.role === 'full' || data.role === 'full' ? 'full' : 'lite';
    const secrets = {
      token: String(data.node_token || ''),
      client_key: String(data.client_key || ''),
      admin_password: role === 'full' ? String(data.admin_password || '') : '',
    };

    const titleEl = $('nodeDetailTitle');
    if (titleEl) titleEl.textContent = `节点详情 — ${node.name || nodeId}`;
    const subEl = $('nodeDetailSub');
    if (subEl) subEl.textContent = '节点凭据与运行状态；Token / 密钥默认遮住，点「显示」展开';

    const body = $('nodeDetailBody');
    if (body) {
      const providers = Array.isArray(node.scope?.providers) ? node.scope.providers : ['*'];
      const models = Array.isArray(node.scope?.models) ? node.scope.models : ['*'];
      const heartbeat = node.last_seen ? formatDateTime(node.last_seen) : '尚未上报心跳';
      const ttlHint = `租约 ${Number(node.lease_ttl) || 86400}s / 宽限 ${Number(node.grace_ttl) || 3600}s 后判离线`;
      const rows = [
        nodeDetailRow('节点 ID', 'Hub KV 中的主键，安装命令与鉴权都用它', `<span class="tabular node-detail-value">${eh(node.id || nodeId)}</span>`),
        nodeDetailRow('名称', '运营者备注名，仅显示用', `<span class="node-detail-value">${eh(node.name || '（未命名）')}</span>`),
        nodeDetailRow('角色', 'full 含管理控制台；lite 为极简代理', `<span class="pill pill--accent">${eh(role)}</span>`),
        nodeDetailRow('创建时间', '节点签发时间', `<span class="tabular node-detail-value">${eh(formatDateTime(node.created_at) || '—')}</span>`),
        nodeDetailSecretRow(
          '节点 Token',
          'NODE_TOKEN：节点侧 LLMPROXY_NODE_TOKEN / 安装命令 --node-token',
          'token',
          secrets.token,
          data.node_token_note || '未保存明文（旧版本节点，轮换后可回看）'
        ),
        nodeDetailSecretRow(
          '客户端密钥',
          'client_key：节点侧 LLMPROXY_CLIENT_KEY，由 Hub 全局设置下发',
          'client_key',
          secrets.client_key,
          data.client_key_note || 'Hub 未配置主客户端密钥'
        ),
        nodeDetailSecretRow(
          '后台密码',
          'Full 节点管理控制台 (/admin) 的登录密码',
          'admin_password',
          secrets.admin_password,
          role === 'full' ? (data.admin_password_note || '该节点未存有后台密码') : 'lite 无控制台密码'
        ),
        nodeDetailRow('最后心跳', ttlHint, `<span class="tabular node-detail-value">${eh(heartbeat)}</span>`),
        nodeDetailRow('配置版本', '节点最近一次拉取生效的配置版本号', `<span class="tabular node-detail-value">${node.last_config_version ? `#${eh(String(node.last_config_version))}` : '—'}</span>`),
        nodeDetailRow('同步次数', `其中 304 命中 ${Number(node.hit_304_count) || 0} 次`, `<span class="tabular node-detail-value">${Number(node.sync_count) || 0} 次</span>`),
        nodeDetailRow('最近 IP', '节点最近一次同步 / 心跳的来源地址', `<span class="tabular node-detail-value">${eh(node.last_ip || '—')}</span>`),
        nodeDetailRow('供应商范围', '节点可访问的上游供应商白名单', `<span class="node-detail-value">${eh(nodeScopeText(providers, '供应商'))}</span>`),
        nodeDetailRow('模型范围', '节点可路由的模型白名单', `<span class="node-detail-value">${eh(nodeScopeText(models, '模型'))}</span>`),
      ];
      body.innerHTML = rows.join('');

      // Masked by default; the toggle swaps text/icon only (zero inline style).
      body.querySelectorAll('[data-detail-eye]').forEach((btn) => {
        clk(btn, () => {
          const key = btn.getAttribute('data-detail-eye');
          const valEl = body.querySelector(`[data-detail-secret="${key}"]`);
          const revealed = btn.getAttribute('aria-pressed') === 'true';
          if (valEl) valEl.textContent = revealed ? NODE_DETAIL_MASK : secrets[key];
          btn.setAttribute('aria-pressed', revealed ? 'false' : 'true');
          btn.setAttribute('aria-label', `${revealed ? '显示' : '隐藏'}${NODE_DETAIL_SECRET_LABELS[key] || ''}`);
          if (window.uiIcon) {
            btn.innerHTML = `${window.uiIcon(revealed ? 'eye' : 'eyeOff')}<span data-detail-eye-label>${revealed ? '显示' : '隐藏'}</span>`;
          } else {
            btn.textContent = revealed ? '显示' : '隐藏';
          }
        });
      });
      body.querySelectorAll('[data-detail-copy]').forEach((btn) => {
        clk(btn, () => {
          const key = btn.getAttribute('data-detail-copy');
          copyToClipboard(secrets[key], `${NODE_DETAIL_SECRET_LABELS[key] || '凭据'} 已复制`);
        });
      });
    }

    // Footer state follows the node: an active node offers 吊销 (danger), a
    // revoked one offers 恢复 (normal).
    const toggleBtn = $('btnNodeDetailToggle');
    if (toggleBtn) {
      const revoked = node.enabled === false;
      toggleBtn.textContent = revoked ? '恢复节点' : '吊销节点';
      toggleBtn.classList.toggle('btn--danger', !revoked);
    }

    // Only capture the opener on a fresh open: rotate / revoke re-renders this
    // overlay in place, and focus must return to the list's 详情 button.
    if (overlay.hidden) {
      nodeDetailReturnEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    overlay.hidden = false;
    overlay.classList.remove('hidden');
    const closeBtn = $('btnCloseNodeDetail');
    if (closeBtn) closeBtn.focus();
  }

  function closeNodeDetailOverlay() {
    const overlay = $('nodeDetailOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.add('hidden');
    nodeDetailNodeId = null;
    const back = nodeDetailReturnEl;
    nodeDetailReturnEl = null;
    if (back && document.contains(back)) back.focus();
  }

  async function handleNodeDetailRotate() {
    const nodeId = nodeDetailNodeId;
    if (!nodeId) return;
    const node = (state.nodes || []).find((n) => n.id === nodeId) || {};
    if (!confirm(`轮换 ${node.name || nodeId} 的 Token？\n旧 Token 立即失效，节点在更新 NODE_TOKEN 并重新同步前会一直鉴权失败。`)) {
      return;
    }
    try {
      const res = await window.HOST.rotateNode(nodeId);
      if (!res || !res.ok || !res.node_token) {
        toast((res && res.error) || '轮换 Token 失败', 'err');
        return;
      }
      // The install overlay caches the latest deploy material; this rotation is
      // exactly that, so the cache must not keep serving the dead token.
      nodeTokenMem.set(nodeId, res);
      await loadNodesData();
      await handleNodeDetailClick(nodeId);
      toast('Token 已轮换', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function handleNodeDetailToggle() {
    const nodeId = nodeDetailNodeId;
    if (!nodeId) return;
    const node = (state.nodes || []).find((n) => n.id === nodeId) || {};
    const enable = node.enabled === false;
    const ask = enable
      ? `恢复 ${node.name || nodeId}？恢复后节点在下一次心跳 / 同步时重新校验 Token 并继续工作。`
      : `吊销 ${node.name || nodeId}？吊销后该节点立即无法同步配置，节点侧会在鉴权失败后停服。`;
    if (!confirm(ask)) return;
    try {
      const res = await window.HOST.patchNode(nodeId, { enabled: enable });
      if (!res || !res.ok) {
        toast((res && res.error) || (enable ? '恢复节点失败' : '吊销节点失败'), 'err');
        return;
      }
      await loadNodesData();
      await handleNodeDetailClick(nodeId);
      toast(enable ? '节点已恢复' : '节点已吊销', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
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
      // A node that never reported an IP (local/direct install: no proxy header,
      // no EdgeOne eo.clientIp) gets a word, not a dash — "—" reads like "the
      // column is unimplemented" rather than "nothing reported yet".
      ipTd.textContent = node.last_ip || '未上报';

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
      // Two different clocks, two different words. `last_seen` is the heartbeat
      // (600s), while the config version is what the node actually pulled — the
      // old single “最后同步” label made operators think a config change had
      // already landed when only a heartbeat had.
      const statusTd = ce('td');
      const hbText = snap.syncMs ? `心跳 ${formatTime(snap.syncMs / 1000)}` : '尚未安装';
      const cfgText = node.last_config_version ? `配置 #${node.last_config_version}` : '';
      statusTd.innerHTML = `${statusPill}<div class="text-sm text-muted">${eh(hbText)}${cfgText ? ` · ${eh(cfgText)}` : ''}</div>`;

      const actionTd = ce('td');
      const installBtn = ce('button');
      installBtn.className = 'btn btn--sm';
      installBtn.type = 'button';
      installBtn.textContent = '安装';
      const editBtn = ce('button');
      editBtn.className = 'btn btn--sm';
      editBtn.type = 'button';
      editBtn.textContent = isExpanded ? '收起' : '编辑';
      const credBtn = ce('button');
      credBtn.className = 'btn btn--sm';
      credBtn.type = 'button';
      credBtn.textContent = '密码';
      const detailBtn = ce('button');
      detailBtn.className = 'btn btn--sm';
      detailBtn.type = 'button';
      detailBtn.textContent = '详情';
      actionTd.appendChild(installBtn);
      actionTd.appendChild(document.createTextNode(' '));
      actionTd.appendChild(editBtn);
      actionTd.appendChild(document.createTextNode(' '));
      // A lite node has no console at all, so offering 密码 only to answer
      // 「lite 节点无后台密码」 wastes a click. The button is full-only; the
      // endpoint still explains itself if hit directly. 详情 is for every node:
      // it carries the token, client key, heartbeat and scope in one place.
      if (node.role !== 'lite') {
        actionTd.appendChild(credBtn);
        actionTd.appendChild(document.createTextNode(' '));
      }
      actionTd.appendChild(detailBtn);

      clk(installBtn, () => handleNodeInstallClick(node.id));
      clk(credBtn, () => handleNodeCredClick(node.id));
      clk(detailBtn, () => handleNodeDetailClick(node.id));
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
        return `mkdir -p "$(pwd)/llmproxy-data" && docker run -d --name llmproxy-full --restart unless-stopped ${common} ${vol} -e LLMPROXY_ROLE=full -e CONFIG_DIR=/data -e LLMPROXY_ADDR=[::]:8787 -e ADMIN_PASSWORD="${adminPass}"${opts.allowPrivate ? ' -e ALLOW_PRIVATE_IPS=true' : ''} ${hubEnv} ghcr.io/khc8655/ocrprox2:latest`;
      }
      // The image listens on LLMPROXY_ADDR: without it the process binds
      // 127.0.0.1 inside the container and `-p port:8787` publishes nothing that
      // answers. Both roles therefore set the wildcard address explicitly.
      const addrEnv = '-e LLMPROXY_ADDR=[::]:8787';
      const privEnv = opts.allowPrivate ? ' -e ALLOW_PRIVATE_IPS=true' : '';
      // Lite is zero-disk by design: no volume needed at all.
      return `docker run -d --name llmproxy-lite --restart unless-stopped ${common} -e LLMPROXY_ROLE=lite ${addrEnv}${privEnv} ${hubEnv} ghcr.io/khc8655/ocrprox2:latest`;
    }

    if (opts.mode === 'binary') {
      // One-liner that actually works from a bare shell: detect arch, download the
      // matching release asset, verify nothing is required beyond the binary, run it.
      // Previously this assumed the binary was already in the current directory.
      const archDetect = `ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')`;
      const fetch = `mkdir -p ./llmproxy-data && cd ./llmproxy-data && curl -fL --retry 2 -o llmproxy "https://github.com/khc8655/ocrprox2/releases/latest/download/llmproxy-linux-\${ARCH}" && chmod +x ./llmproxy`;
      if (role === 'full') {
        const fullAddr = opts.bind === 'public' ? `[::]:${port}` : `127.0.0.1:${port}`;
        return `${archDetect} && ${fetch} && ADMIN_PASSWORD="${adminPass}" CONFIG_DIR="$(pwd)/cfg" LLMPROXY_ROLE=full LLMPROXY_HUB_URL="${cleanHub}" LLMPROXY_NODE_TOKEN="${token}"${clientKey ? ` LLMPROXY_CLIENT_KEY="${clientKey}"` : ''}${opts.allowPrivate ? ' ALLOW_PRIVATE_IPS=true' : ''} ./llmproxy --addr="${fullAddr}"`;
      }
      const binAddr = opts.bind === 'public' ? `[::]:${port}` : `127.0.0.1:${port}`;
      const privEnv = opts.allowPrivate ? ' ALLOW_PRIVATE_IPS=true' : '';
      return `${archDetect} && ${fetch} && LLMPROXY_ROLE=lite LLMPROXY_HUB_URL="${cleanHub}" LLMPROXY_NODE_TOKEN="${token}"${clientKey ? ` LLMPROXY_CLIENT_KEY="${clientKey}"` : ''}${privEnv} ./llmproxy --addr="${binAddr}"`;
    }

    // `--bind` and `--allow-private` are what decide whether the pasted command
    // actually connects: the installer defaults to a loopback bind, and lite
    // refuses LAN upstreams unless told otherwise.
    const bindFlag = opts.bind === 'public' ? '--bind=public' : '--bind=local';
    const privateFlag = opts.allowPrivate ? '--allow-private' : '';

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
    flags.push(bindFlag);
    if (privateFlag) flags.push(privateFlag);
    if (opts.mirror === 'ghfast') flags.push('--mirror="https://ghfast.top"');
    if (opts.autoYes) flags.push('-y');
    return `curl -fsSL ${scriptUrl} | sudo bash -s -- ${flags.join(' ')}`;
  }

  function mountNodeCommandPanel(container, payload) {
    if (!container) return;
    const role = payload.role === 'full' ? 'full' : 'lite';
    const clientKey = payload.clientKey || (state.config?.settings?.client_key || state.config?.settings?.proxy_api_key || '');
    const hubUrl = payload.hubUrl || window.location.origin;
    // Full-node admin password: callers pass the KV-stored value (node payload or
    // rotation response). The random fallback only fires when the hub did not
    // supply one (legacy hub that does not store passwords).
    const adminPass = role === 'full' ? (String(payload.adminPass || '').trim() || generateRandomAlphaNum(20)) : '';
    const panelState = {
      mode: 'install',
      port: 8787,
      scriptSource: 'hub',
      mirror: 'auto',
      autoYes: true,
      adminPass,
      // Listen scope and private-upstream access are the two settings that
      // decide whether the pasted command actually works: the installer defaults
      // to 127.0.0.1 (so `<VM_IP>:port` never answered) and lite blocks LAN
      // upstreams without an explicit opt-in.
      bind: 'local',
      allowPrivate: false,
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
        <div class="form-group" data-cmd-bind-wrap>
          <label class="form-label">监听范围</label>
          <select class="select" data-cmd-bind>
            <option value="local">仅本机 127.0.0.1（需 ssh -L / 反代）</option>
            <option value="public">对外 0.0.0.0（需自行做鉴权与防火墙）</option>
          </select>
        </div>
        <div class="form-group" data-cmd-private-wrap>
          <label class="form-label">内网上游</label>
          <label class="form-label form-label--check">
            <input type="checkbox" data-cmd-private>
            <span>允许内网 / 本机上上游地址</span>
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
    const bindEl = q('[data-cmd-bind]');
    const privEl = q('[data-cmd-private]');

    const refresh = () => {
      const isInstall = panelState.mode === 'install';
      if (srcWrap) srcWrap.hidden = !isInstall;
      if (mirrorWrap) mirrorWrap.hidden = !isInstall;
      if (yesWrap) yesWrap.hidden = !isInstall;
      const port = Math.max(1, Math.min(65535, Number(panelState.port) || 8787));
      if (baseHintEl) {
        // Match what the command actually installs. A local bind is reachable
        // only from the VM itself, so advertising `<VM_IP>:port` sent operators
        // chasing a connection that could never work.
        baseHintEl.textContent = panelState.bind === 'public'
          ? `API Base URL: http://<VM_IP>:${port}/v1`
          : `API Base URL: http://127.0.0.1:${port}/v1（仅本机可达：ssh -L ${port}:127.0.0.1:${port} 或反代）`;
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
    if (bindEl) bindEl.addEventListener('change', () => { panelState.bind = bindEl.value === 'public' ? 'public' : 'local'; refresh(); });
    if (privEl) privEl.addEventListener('change', () => { panelState.allowPrivate = privEl.checked; refresh(); });
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
          // The Hub reuses the stored admin password across rotations (see
          // reissueNodeToken), so say so instead of implying a fresh one.
          toast(res.admin_password ? 'Token 轮换成功，后台密码保持不变' : 'Token 轮换成功！', 'ok');
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
            adminPass: res.admin_password,
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
      emptyRow.textContent = q ? '没有匹配的模型路由' : '暂无已配置模型路由，请点击右上角「新增模型路由」';
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
      // The route row is informational only: per-key testing moved to the key
      // table (供应商 → Key 行「测试」), where the verdict can name the key and
      // the failure reason instead of "which of N candidates answered".
      who.innerHTML = `
        <div class="name">
          ${brandIcon}
          <span>${eh(mName)}</span>
          <span class="pill pill--accent">${eh(stratLabels[strat] || strat)}</span>
        </div>
        <div class="sub">${eh(subDesc)}</div>
      `;

      const fields = ce('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="pill">${cCount} 候选</span>
        <span class="caret">▾</span>
      `;

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
      <div class="form-group"><label class="form-label">对外模型名</label><input class="input input--code" id="ed_m_name" value="${eh(mName)}"><span class="text-xs text-muted">这就是一个路由：Agent 客户端用这个名字调用</span></div>
      <div class="section-bar mt-3"><span class="form-label">候选池（该路由可用的 供应商×Key 组合）</span><button class="btn btn--sm" id="btn_add_cand" type="button">+ 添加候选</button></div>
      <div class="text-xs text-muted mb-2">按策略从这里挑一个来发请求；排第一的是首选</div>
      <div class="card" id="m_cl"></div>
      <div class="card mt-2 card-pad hidden" id="m_ac" hidden>
        <div class="fields"><input class="input input--code flex-1" id="m_ac_prov" list="datalistProviders" placeholder="选择供应商"></div>
        <div class="probe-pills-wrap" id="m_ac_models"></div>
        <div class="fields mt-2"><input class="input input--code flex-1" id="m_ac_target" placeholder="上游模型 ID（可手填）"><button class="btn btn--sm btn--primary" id="m_ac_ok" type="button">追加所选</button></div>
      </div>
      <div class="card card-pad mt-2" id="m_test">
        <div class="section-bar">
          <div>
            <span class="form-label">测试这个模型</span>
            <div class="text-xs text-muted">真实发一句「你好」，用下面选中的 Key 请求当前模型，并把上游的实际回复显示出来</div>
          </div>
        </div>
        <div class="input-row">
          <select class="select" id="m_test_cand" aria-label="测试哪个候选"></select>
          <select class="select" id="m_test_key" aria-label="用哪个 Key 测试"></select>
          <button class="btn btn--primary" id="m_test_send" type="button">发送「你好」</button>
        </div>
        <div class="m-test-out" id="m_test_out" hidden></div>
      </div>

      <div class="section-bar mt-3"><span class="form-label">Key 选择</span><span class="text-xs text-muted">默认任一=全部启用 Key</span></div>
      <div class="card card-pad" id="m_kw"></div>
      <details class="headers-details mt-3"><summary class="form-label">高级 (候选权重 / 并发上限)</summary><div id="m_ca" class="mt-2"></div></details>
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
        <div class="form-actions-group"><button class="btn btn--danger" id="btn_del_model" type="button">删除此路由</button></div>
        <div class="form-actions-group"><button class="btn btn--primary" id="btn_save_model" type="button">保存路由配置</button></div>
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

    // ② 候选池 rows (magpie style): 序号 + 目标模型 + 供应商 + 绑定 Key + 思考档位 + 上移/下移/移除.
    // All draws are local so pool edits never collapse the editor via
    // renderModelsList; one delegated handler serves every row. The per-row Key
    // pill is what makes unchecked-but-listed keys visible: without it a checked
    // key beyond the candidate count silently never routes.
    //
    // The 思考档位 control is per candidate, not per provider: the catalog's ladder
    // is model-level (deepseek-v4-pro accepts low/high/max while the preset file
    // advertises none/low/medium/high). It is filled asynchronously because the
    // answer comes from the catalog API; until it lands the slot is empty rather
    // than showing a placeholder that could be mistaken for a real answer.
    const effortControlHtml = (c, info) => {
      const current = String(c.reasoning_effort || '');
      const follow = '<option value="">跟随客户端</option>';
      if (!info || info.ok === false || !info.found) {
        return '<span class="text-xs text-muted">能力信息未知</span>';
      }
      const efforts = Array.isArray(info.efforts) ? info.efforts.filter(Boolean) : [];
      if (efforts.length > 0) {
        // A value saved against an older catalog that no longer offers that level
        // stays visible so the change is explicit, never a silent rewrite.
        const extra = current && !efforts.includes(current) && current !== 'on' && current !== 'off'
          ? `<option value="${eh(current)}" selected>${eh(current)}（当前已保存）</option>`
          : '';
        const opts = efforts.map((lv) => `<option value="${eh(lv)}"${lv === current ? ' selected' : ''}>${eh(lv)}</option>`).join('');
        return `<select class="select select--compact" data-eff aria-label="思考档位">${follow}${extra}${opts}</select>`;
      }
      if (info.supports_toggle || info.toggle) {
        // Toggle-only models have no ladder: the only meaningful choices are
        // force-on / force-off / leave the client alone.
        return `<select class="select select--compact" data-eff aria-label="思考开关">${follow}` +
          `<option value="on"${current === 'on' ? ' selected' : ''}>强制开启</option>` +
          `<option value="off"${current === 'off' ? ' selected' : ''}>强制关闭</option></select>`;
      }
      return '<span class="text-xs text-muted">该模型无思考档位</span>';
    };

    const fillCandEffort = (i) => {
      const box = q(`#m_cand_eff_${i}`);
      const c = candidates[i];
      if (!box || !c) return;
      const preset = presetIdForProvider(c.provider);
      const model = String(c.target_model || mName).trim();
      if (!preset || !model) {
        box.innerHTML = '';
        return;
      }
      fetchModelInfo(preset, model).then((info) => {
        // The pool may have been reordered/redrawn while the query was in flight.
        if (!box.isConnected || candidates[i] !== c) return;
        box.innerHTML = effortControlHtml(c, info);
      });
    };

    const drawCands = () => {
      q('#m_cl').innerHTML = candidates.map((c, i) => `<div class="row row--static" data-i="${i}"><div class="who"><span class="pill tabular">${i + 1}</span><span class="input--code">${eh(c.target_model || mName)}</span><span class="pill">${eh(c.provider)}</span><span class="pill">${c.key_label ? `Key ${eh(c.key_label)}` : '任一 Key'}</span></div><div class="fields"><span class="m-cand-eff" id="m_cand_eff_${i}"></span><button class="btn btn--sm" data-a="u"${i ? '' : ' disabled'}>↑</button><button class="btn btn--sm" data-a="d"${i === candidates.length - 1 ? ' disabled' : ''}>↓</button><button class="btn btn--sm btn--danger" data-a="r">移除</button></div></div>`).join('') || '<div class="row row--static text-muted">暂无候选</div>';
      candidates.forEach((_, i) => fillCandEffort(i));
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
    // 思考档位 is written straight onto the candidate; '' = 跟随客户端 (the field is
    // omitted on save). "on"/"off" are the toggle-only pair. The scheduler side
    // that turns this into a request body is out of this phase's scope — until
    // it lands the value is stored but not yet consumed (see contractNotes).
    q('#m_cl').addEventListener('change', (ev) => {
      const sel = ev.target instanceof Element ? ev.target.closest('select[data-eff]') : null;
      if (!sel) return;
      const row = sel.closest('[data-i]');
      const c = candidates[Number(row?.dataset.i)];
      if (!c) return;
      const v = String(sel.value || '');
      if (v) c.reasoning_effort = v;
      else delete c.reasoning_effort;
    });

    // ③ Key 选择: one row per provider in the pool.「任一」(empty selection) leaves
    // key_label '' = any enabled key; checking concrete labels re-binds that
    // provider's candidates cyclically (key[i % n]). When more keys are checked
    // than there are candidates, the surplus stays selected but binds nothing —
    // drawKeys badges those as 未绑定候选 so the state is visible, and binding
    // more candidates (「+ 添加候选」) puts them to work. Selection rides on
    // m._keySel: it survives the local redraws and dies with the config
    // round-trip on save (persistConfig strips it — on hub too, where the raw
    // KV save would otherwise persist and later replay stale selections).
    // The selection is seeded from the candidates as they exist: candidates
    // created by the add-model modal carry concrete key_label bindings, so their
    // pills show checked instead of the lying「任一」highlight.
    // 测试这个模型: the operator picks which candidate (provider + upstream model)
    // and which key to spend, then gets the real reply text back. This is the
    // model-level counterpart of the provider page's per-key test: there the
    // question is "is this key alive", here it is "does THIS model answer on
    // THIS key" — the same triple that will serve traffic.
    const testCandSel = q('#m_test_cand');
    const testKeySel = q('#m_test_key');
    const testOut = q('#m_test_out');
    const testBtn = q('#m_test_send');

    const providerKeys = (pId) => {
      const prov = state.config?.providers?.[pId] || {};
      return Array.isArray(prov.api_keys) ? prov.api_keys.filter((k) => k && (k.label || k.id)) : [];
    };

    const drawTestKeys = () => {
      if (!testCandSel || !testKeySel) return;
      const idx = Number(testCandSel.value) || 0;
      const c = candidates[idx];
      if (!c || !c.provider) {
        testKeySel.innerHTML = '';
        return;
      }
      const keys = providerKeys(c.provider);
      const wanted = String(c.key_label || '');
      const opts = ['<option value="">任一启用 Key</option>'];
      for (const k of keys) {
        const label = String(k.label || k.id);
        const off = k.enabled === false ? '（已禁用）' : '';
        const sel = label === wanted ? ' selected' : '';
        opts.push(`<option value="${eh(label)}"${sel}>${eh(label)}${off}</option>`);
      }
      testKeySel.innerHTML = opts.join('');
      // No explicit binding on the candidate: preselect the first enabled key so
      // the operator sees exactly which credential the test will spend.
      if (!wanted) {
        const firstEnabled = keys.find((k) => k.enabled !== false);
        if (firstEnabled) testKeySel.value = String(firstEnabled.label || firstEnabled.id);
      }
    };

    const drawTestCandidates = () => {
      if (!testCandSel) return;
      testCandSel.innerHTML = candidates.length
        ? candidates.map((c, i) => `<option value="${i}">${eh(`${c.provider} / ${c.target_model || mName}`)}</option>`).join('')
        : '<option value="0">（还没有候选）</option>';
      drawTestKeys();
    };
    drawTestCandidates();
    if (testCandSel) testCandSel.addEventListener('change', drawTestKeys);

    if (testBtn) {
      clk(testBtn, async () => {
        if (testBtn.disabled) return;
        const idx = Number(testCandSel?.value) || 0;
        const c = candidates[idx];
        if (!c || !c.provider) {
          if (testOut) {
            testOut.hidden = false;
            testOut.className = 'm-test-out m-test-out--err';
            testOut.textContent = '先在候选池里加一个候选，再测试。';
          }
          return;
        }
        const keyLabel = String(testKeySel?.value || '');
        const model = String(c.target_model || mName).trim();
        const label = testBtn.textContent;
        testBtn.disabled = true;
        testBtn.textContent = '请求中…';
        if (testOut) {
          testOut.hidden = false;
          testOut.className = 'm-test-out';
          testOut.innerHTML = `<div class="gw-test-meta">正在用 ${eh(c.provider)}${keyLabel ? ` / ${eh(keyLabel)}` : ''} 请求 ${eh(model)} …</div>`;
        }
        const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        try {
          const res = await window.HOST.testKey({ provider: c.provider, key_label: keyLabel, model });
          const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
          if (!testOut || !testOut.isConnected) return;
          const ok = Boolean(res && res.valid === true);
          const meta = [
            ok ? '可用' : '失败',
            res && res.status ? `HTTP ${res.status}` : '',
            `${(res && res.latency_ms) || ms}ms`,
            `${res && res.provider ? res.provider : c.provider}${res && res.key_label ? ` / ${res.key_label}` : ''}`,
            `${res && res.model ? res.model : model}`,
            res && res.model_source ? `(${res.model_source})` : '',
          ].filter(Boolean).join(' · ');
          testOut.className = `m-test-out${ok ? ' m-test-out--ok' : ' m-test-out--err'}`;
          if (ok) {
            const reply = String((res && res.reply_text) || '').trim();
            testOut.innerHTML = `<div class="gw-test-meta">${eh(meta)}</div>`
              + `<pre class="gw-test-reply">${eh(reply || '（上游返回成功，但没有可显示的文本）')}</pre>`;
          } else {
            const bits = [meta];
            if (res && res.reason) bits.push(`reason=${res.reason}`);
            if (res && res.err_type) bits.push(`err_type=${res.err_type}`);
            const errText = res && res.error ? scrubUiText(String(res.error)) : '';
            testOut.innerHTML = `<div class="gw-test-meta">${eh(bits.join(' · '))}</div>`
              + (errText ? `<div class="gw-test-error">${eh(errText)}</div>` : '');
          }
        } catch (err) {
          if (testOut && testOut.isConnected) {
            testOut.className = 'm-test-out m-test-out--err';
            testOut.textContent = `测试异常：${scrubUiText(err && err.message ? err.message : String(err))}`;
          }
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = label;
        }
      });
    }

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

    //「+ 添加候选」popup: provider (datalist) → check probed model pills → append
    // (manual input as fallback). Probes are only run in the add-model form; its
    // results are cached in state.probedModelsByProvider so the pills light up here.
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
      if (newName !== mName && state.config.agent_models[newName]) return toast(`路由 ${newName} 已存在`, 'warn');
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
      await persistConfig('路由配置保存成功');
    });

    clk(q('#btn_del_model'), async () => {
      if (!confirm(`确定删除路由 ${mName} 吗？`)) return;
      delete state.config.agent_models[mName];
      // Same-name legacy KB channel must go with it: leaving it behind would let
      // the KB fallback resurrect a ghost route on the next config round-trip.
      if (state.config.kb_models) delete state.config.kb_models[mName];
      state.activeEditorKey = null;
      await persistConfig('路由已删除');
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
    // Cancel any in-flight batched pull: the button may be mid-loop, and the
    // operator closing the dialog means "do not land these routes".
    state.importRunId++;
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
      // A provider missing wholesale is pulled automatically at import time, so its
      // row stays selectable; only a locally existing provider lacking bound key
      // labels (which cannot be auto-resolved) keeps the row disabled.
      // A local-origin provider cannot be re-pulled from the hub (Go returns
      // provider_exists_local); for those, show guidance instead of a button
      // that can only fail. Vault-origin providers get a working 补拉 action.
      const keyGapsByProv = {};
      const localGapProvs = [];
      for (const pair of missingKeys) {
        const idx = pair.indexOf(':');
        const pId = pair.slice(0, idx);
        if (missing.includes(pId)) continue;
        if ((localProviders[pId]?.origin || '') !== 'vault') {
          if (!localGapProvs.includes(pId)) localGapProvs.push(pId);
          continue;
        }
        (keyGapsByProv[pId] = keyGapsByProv[pId] || []).push(pair.slice(idx + 1));
      }
      const keyGapPairs = Object.entries(keyGapsByProv).flatMap(([pId, labels]) => labels.map((l) => `${pId}:${l}`));
      const candText = cands.map((c) => `${c.provider}:${c.key_label || '*'}→${c.target_model || mName}`).join(' · ');
      const row = ce('div');
      row.className = 'mb-2';
      row.innerHTML = `
        <label class="form-label form-label--check">
          <input type="checkbox" class="tpl_import_cb" data-model="${eh(mName)}" ${keyGapPairs.length || localGapProvs.length ? 'disabled' : ''}>
          <span><strong>${eh(mName)}</strong> <span class="pill pill--accent">${eh(STRATEGY_LABELS[tpl.routing_strategy] || tpl.routing_strategy || 'sticky_failover')}</span> <span class="pill tabular">${cands.length} 候选</span></span>
        </label>
        ${candText ? `<div class="text-xs text-muted">${eh(candText)}</div>` : ''}
        ${missing.length ? `<div class="text-xs"><span class="pill pill--amber">缺依赖</span> 导入时自动拉取 ${missing.length} 个缺失供应商：${eh(missing.join('、'))}</div>` : ''}
        ${keyGapPairs.length ? `<div class="text-xs"><span class="pill pill--amber">缺依赖</span> Key 标签本地缺失（该供应商已有但缺这些 Key）：${eh(keyGapPairs.join('、'))} → ${Object.entries(keyGapsByProv).map(([pId, labels]) => `<button class="btn btn--sm" type="button" data-tpl-fetch-keys="${eh(pId)}" data-labels="${eh(JSON.stringify(labels))}">点此补拉 ${eh(pId)}</button>`).join(' ')}</div>` : ''}
        ${localGapProvs.length ? `<div class="text-xs text-muted">${eh(localGapProvs.join('、'))} 为本地自建供应商，不能从中枢补拉 Key；请在供应商页补齐对应 Key 标签，或改用中枢同名供应商。</div>` : ''}
      `;
      listEl.appendChild(row);
    }
  }

  // Import flow: pull every missing provider the picked routes depend on (in one
  // sequential pass), then land the routes whose dependencies are satisfied. A
  // failing provider never blocks the others; failures are summarised at the end.
  // Config is reloaded after the pulls because each fetch merges server-side.
  // Closing the overlay (Esc / backdrop / 关闭) bumps state.importRunId, which the
  // loop checks between awaits: a cancelled import must not persist anything.
  async function handleConfirmImportRoutes() {
    if (state.importing) return;
    state.importing = true;
    const btn = $('btnConfirmImportRoutes');
    try {
      await runTemplateImport(btn);
    } finally {
      state.importing = false;
    }
  }

  async function runTemplateImport(btn) {
    const listEl = $('templateImportList');
    const picked = [...(listEl?.querySelectorAll('.tpl_import_cb:checked') || [])]
      .map((cb) => cb.getAttribute('data-model'))
      .filter(Boolean);
    if (picked.length === 0) return toast('请先勾选要导入的模型路由', 'warn');
    const runId = state.importRunId;
    const cancelled = () => state.importRunId !== runId;
    const manifestModels = vaultManifestModels();

    // Dedupe the missing providers across every picked route: one fetch per
    // provider even when several routes bind it.
    const missingProvs = [...new Set(picked.flatMap(
      (mName) => templateRouteMissingProviders(mName, manifestModels[mName], state.config?.providers || {})
    ))];
    const failedProvs = [];
    // A cancelled run must still hand the button back: it stays in the DOM after the
    // overlay closes, and leaving it disabled+relabelled would make every later
    // import a no-op.
    const restoreBtn = (label) => {
      if (!btn) return;
      btn.disabled = false;
      btn.textContent = label;
    };
    if (missingProvs.length > 0) {
      const label = btn?.textContent || '';
      if (btn) btn.disabled = true;
      try {
        for (let i = 0; i < missingProvs.length; i++) {
          if (cancelled()) return;
          const pId = missingProvs[i];
          if (btn) btn.textContent = `正在拉取供应商…（${i + 1}/${missingProvs.length}）`;
          try {
            const res = await window.HOST.fetchVaultCredentials(pId);
            if (!res || !res.ok) failedProvs.push(pId);
          } catch (_) {
            failedProvs.push(pId);
          }
        }
      } finally {
        restoreBtn(label);
      }
      if (cancelled()) return;
      if (missingProvs.length > failedProvs.length) {
        // New providers merged server-side; refresh before evaluating deps.
        await loadData();
        if (cancelled()) return;
      }
    }

    const localModels = state.config?.agent_models || {};
    const localProviders = state.config?.providers || {};
    // Every pick that does not land is named in the summary: a route whose key
    // label the pulled provider did not actually carry used to be dropped silently
    // as long as some other route imported.
    const skipped = [];
    for (const mName of picked) {
      const tpl = manifestModels[mName];
      if (!tpl) { skipped.push(`${mName}（中枢清单已无该模板）`); continue; }
      if (localModels[mName]) { skipped.push(`${mName}（本地已有同名路由）`); continue; }
      if (templateRouteMissingProviders(mName, tpl, localProviders).length > 0) {
        skipped.push(`${mName}（供应商未拉取成功）`);
        continue;
      }
      const gapLabels = templateRouteMissingKeyLabels(mName, tpl, localProviders);
      if (gapLabels.length > 0) {
        skipped.push(`${mName}（拉回的 Key 缺标签 ${gapLabels.join('、')}）`);
        continue;
      }
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
          // The Hub operator may have picked a thinking ladder per candidate;
          // dropping it would silently change how the imported route behaves.
          ...(c.reasoning_effort ? { reasoning_effort: String(c.reasoning_effort) } : {}),
        })),
      };
    }
    const imported = picked.length - skipped.length;

    // Provider pulls always report a summary: X succeeded / Y failed (with names).
    if (missingProvs.length > 0) {
      toast(
        failedProvs.length > 0
          ? `供应商拉取：成功 ${missingProvs.length - failedProvs.length} / 失败 ${failedProvs.length}（${failedProvs.join('、')}）`
          : `供应商拉取：成功 ${missingProvs.length} / 失败 0`,
        failedProvs.length > 0 ? 'warn' : 'ok'
      );
    }
    if (imported === 0) {
      toast(skipped.length > 0 ? `未导入任何路由：${skipped.join('；')}` : '没有可导入的路由', 'warn');
      // Pulled providers changed the dependency picture: redraw so the rows and
      // their checkboxes reflect the current config before the next attempt.
      renderTemplateImportList();
      return;
    }
    if (skipped.length > 0) {
      // Keep the overlay open: the un-imported rows stay visible (and can be fixed
      // via their 补拉 buttons) while the imported ones disappear from the list.
      toast(`已导入 ${imported} 条，未导入：${skipped.join('；')}`, 'warn');
      renderTemplateImportList();
      await persistConfig(`已从模板导入 ${imported} 条模型路由`);
      return;
    }
    closeTemplateImportOverlay();
    await persistConfig(`已从模板导入 ${imported} 条模型路由`);
  }

  // --- View: Activity — recent requests + failure analysis (ledger-backed) ---

  // Closed failure taxonomy (v3.11). An unknown or empty reason falls back to the
  // raw English code / — rather than inventing a label the backend never emitted.
  const FAILURE_REASON_LABELS = {
    auth_invalid: 'Key 无效或无权限',
    quota_exhausted: '额度/余额耗尽',
    rate_limited: '被限流',
    model_not_found: '模型不存在',
    context_too_long: '上下文超长',
    upstream_error: '上游服务错误',
    timeout: '超时',
    network: '网络错误',
    client_disconnected: '客户端断开',
    bad_response: '上游响应异常',
    protocol_mismatch: '协议不匹配',
    no_candidate: '无可用 Key',
    config_unavailable: '配置不可用',
    unknown: '未知',
  };

  function reasonLabel(reason) {
    const r = String(reason || '');
    return FAILURE_REASON_LABELS[r] || r;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  // Ledger timestamps are whole unix seconds, so the table shows a fixed HH:MM:SS
  // clock and keeps the full date in title=.
  function clockOf(unixSec) {
    const sec = Number(unixSec) || 0;
    if (!sec) return '-';
    const d = new Date(sec * 1000);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function fullTimeOf(unixSec) {
    const sec = Number(unixSec) || 0;
    if (!sec) return '';
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clockOf(sec)}`;
  }

  // Console probes carry RequestTrace.Source=="probe" and never reach the usage
  // ledger, so a probe row should not normally appear in this window. UsageRecord
  // has no source field today; if one is added later it is honoured, otherwise the
  // endpoint the probe trace is stamped with identifies it. Both paths covered.
  function isProbeRecord(rec) {
    return Boolean(rec) && (rec.source === 'probe' || rec.ep === '/admin/test-key');
  }

  function statusPillHtml(status) {
    const code = Number(status) || 0;
    if (code === 0) return '<span class="pill">无响应</span>';
    if (code >= 200 && code < 300) return `<span class="pill pill--green tabular">HTTP ${code}</span>`;
    return `<span class="pill pill--red tabular">HTTP ${code}</span>`;
  }

  // A successful row shows no reason — failover failures that still ended in a
  // 2xx are the「尝试」column's job. A failed row is attributed to its final
  // failed attempt (try_failed is chronological); a local early-exit has none.
  function finalFailure(rec) {
    const code = Number(rec.status) || 0;
    if (code >= 200 && code < 300) return null;
    const tries = Array.isArray(rec.try_failed) ? rec.try_failed : [];
    if (tries.length) return tries[tries.length - 1];
    // Local rejections (protocol mismatch, model not configured, every key
    // cooling down) never reach a key, so the reason lives on the record.
    if (rec.reason || rec.err_type || rec.err) {
      return {
        provider: String(rec.provider || ''),
        key_id: String(rec.key_id || ''),
        status: code,
        reason: String(rec.reason || ''),
        err_type: String(rec.err_type || ''),
        err: String(rec.err || ''),
        rid: String(rec.rid || ''),
      };
    }
    return null;
  }

  function renderRecentRequests() {
    const container = $('recentReqList');
    if (!container) return;
    container.innerHTML = '';

    const sub = $('recentReqSub');
    if (sub) {
      sub.textContent = state.recentSource === 'memory'
        ? '当前无账本文件，记录来自内存窗口（重启后清空）；点击任意行展开失败尝试明细'
        : '来自账本，重启后仍保留；点击任意行展开失败尝试明细';
    }

    // The endpoint returns the window oldest first; newest first is what an
    // operator reads and keeps「最近发生」aligned with the error analysis.
    const records = (state.recentRequests || []).slice().reverse();

    if (records.length === 0) {
      const emptyRow = ce('div');
      emptyRow.className = 'row row--static text-muted';
      emptyRow.textContent = '暂无请求记录';
      container.appendChild(emptyRow);
      return;
    }

    const wrap = ce('div');
    wrap.className = 'table-wrap';
    const table = ce('table');
    // Fixed layout is what keeps a long upstream error from stretching the table:
    // in auto layout the colspan expansion row sizes to the text's max-content and
    // no wrap property can shrink it.
    table.className = 'data-table reqlog-table';
    table.innerHTML = '<thead><tr><th>时间</th><th>模型</th><th>供应商 / Key</th><th>状态</th><th>耗时</th><th>尝试</th><th>原因</th></tr></thead>';
    const tbody = ce('tbody');
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    records.forEach((rec, idx) => {
      const rowKey = `rq_${Number(rec.t) || 0}_${idx}`;
      const isExpanded = state.activeEditorKey === rowKey;
      const tries = Array.isArray(rec.try_failed) ? rec.try_failed : [];
      const final = finalFailure(rec);
      const triesCount = Number(rec.tries) || tries.length;
      const reqModel = String(rec.req || '');
      const served = String(rec.served || '');
      const provider = String(rec.provider || '');
      const keyId = String(rec.key_id || '');
      const modelTitle = served && served !== reqModel ? `实际服务模型: ${served}` : '';

      const tr = ce('tr');
      tr.className = `reqlog-row${isExpanded ? ' expanded' : ''}`;
      tr.innerHTML = `
        <td class="tabular" title="${eh(fullTimeOf(rec.t))}">${isProbeRecord(rec) ? '<span class="pill pill--amber">测试</span> ' : ''}${clockOf(rec.t)}</td>
        <td class="reqlog-model"${modelTitle ? ` title="${eh(modelTitle)}"` : ''}>${eh(reqModel || '-')}</td>
        <td class="reqlog-target">${eh(provider || '-')}${keyId ? ` / ${eh(keyId)}` : ''}</td>
        <td>${statusPillHtml(rec.status)}</td>
        <td class="tabular">${Number(rec.ms) || 0}ms</td>
        <td>${triesCount > 1 ? `<span class="pill pill--amber tabular">${triesCount} 次</span>` : '<span class="text-muted">-</span>'}</td>
        <td>${final && final.reason
          ? `<span class="reqlog-reason" title="${eh(final.reason)}">${eh(reasonLabel(final.reason))}</span>`
          : '<span class="text-muted">—</span>'}</td>
      `;
      clk(tr, () => {
        state.activeEditorKey = isExpanded ? null : rowKey;
        renderRecentRequests();
      });
      tbody.appendChild(tr);

      if (!isExpanded) return;

      // Inline expansion (.editor inside a full-width row), never an overlay.
      const expTr = ce('tr');
      expTr.className = 'reqlog-expand-row';
      const expTd = ce('td');
      expTd.className = 'reqlog-expand-td';
      expTd.colSpan = 7;
      const editor = ce('div');
      editor.className = 'editor';
      const head = ce('div');
      head.className = 'reqlog-expand-head';
      head.innerHTML = `<span class="form-label">失败尝试明细</span>
        <span class="text-muted text-xs tabular">${eh(rec.ep || '')}${rec.mode ? ` · ${eh(String(rec.mode).toUpperCase())}` : ''} · Tok ${Number(rec.in) || 0}→${Number(rec.out) || 0} · 总耗时 ${Number(rec.ms) || 0}ms</span>`;
      editor.appendChild(head);

      if (tries.length === 0) {
        const none = ce('div');
        none.className = 'text-muted text-sm mt-1';
        if (final && (final.reason || final.err)) {
          // A local rejection: no upstream was dialed, but the gateway can still
          // say why it refused (model not configured / protocol mismatch / …).
          none.innerHTML = `未发出上游请求 · <span class="reqlog-reason">${eh(reasonLabel(final.reason) || '-')}</span>`
            + (final.err_type ? ` <span class="reqlog-errtype tabular">${eh(final.err_type)}</span>` : '');
        } else {
          // A failed request with zero tries never reached an upstream: the
          // gateway rejected it locally (config unusable / model not configured /
          // no candidate) — the reason column is empty for exactly this case.
          none.textContent = Number(rec.status) === 0 || Number(rec.status) >= 400
            ? '无上游尝试记录（本地早退或未发出请求）'
            : '无失败尝试';
        }
        editor.appendChild(none);
        if (final && final.err) {
          const errEl = ce('div');
          errEl.className = 'reqlog-err';
          errEl.textContent = scrubUiText(String(final.err));
          editor.appendChild(errEl);
        }
      } else {
        tries.forEach((f, ti) => {
          const item = ce('div');
          item.className = 'reqlog-try';
          const ms = Number(f.ms) || 0;
          const line = [
            `<span class="reqlog-try-head tabular">#${ti + 1}</span>`,
            `<span class="pill">${eh(f.provider || '-')}${f.key_id ? ` / ${eh(f.key_id)}` : ''}</span>`,
            statusPillHtml(f.status),
            f.reason ? `<span class="reqlog-reason">${eh(reasonLabel(f.reason))}</span>` : '',
            f.err_type ? `<span class="reqlog-errtype tabular">${eh(f.err_type)}</span>` : '',
            ms > 0 ? `<span class="tabular text-muted">${ms}ms</span>` : '',
          ].filter(Boolean).join(' ');
          item.innerHTML = `<div class="reqlog-try-line">${line}</div>`;
          if (f.err) {
            const errEl = ce('div');
            errEl.className = 'reqlog-err';
            // Server-side the text is already ScrubStringWithSecrets'd; the UI
            // scrubber is a second net so a secret can never reach the DOM.
            errEl.textContent = scrubUiText(String(f.err));
            item.appendChild(errEl);
          }
          if (f.rid) {
            const ridEl = ce('div');
            ridEl.className = 'reqlog-rid tabular';
            ridEl.textContent = `rid: ${f.rid}`;
            item.appendChild(ridEl);
          }
          editor.appendChild(item);
        });
      }
      expTd.appendChild(editor);
      expTr.appendChild(expTd);
      tbody.appendChild(expTr);
    });

    if (state.recentTruncated) {
      const foot = ce('div');
      foot.className = 'reqlog-foot text-muted';
      foot.textContent = `账本中仅 ${records.length} 条`;
      container.appendChild(foot);
    }
  }

  // Aggregates the failed attempts inside the current window by
  // (reason, provider, key_id). The window is whatever the table shows — 50
  // records or the failed-only segment — never the whole day.
  function aggregateFailures(records) {
    const map = new Map();
    const add = (reason, provider, keyId, err, errType, ts) => {
      const k = `${reason}\u0000${provider}\u0000${keyId}`;
      let item = map.get(k);
      if (!item) {
        item = { reason, provider, keyId, count: 0, lastTs: 0, lastErr: '', lastErrType: '' };
        map.set(k, item);
      }
      item.count += 1;
      // >= keeps the later record when two share a second: the ledger appends in
      // order, and「最近一次」must not point at the older of the two.
      if (ts >= item.lastTs) {
        item.lastTs = ts;
        item.lastErr = err;
        item.lastErrType = errType;
      }
    };
    for (const rec of records) {
      const ts = Number(rec.t) || 0;
      const tries = Array.isArray(rec.try_failed) ? rec.try_failed : [];
      for (const f of tries) {
        add(String(f.reason || ''), String(f.provider || ''), String(f.key_id || ''),
          String(f.err || ''), String(f.err_type || ''), ts);
      }
      // Local rejections (model not configured, protocol mismatch, every key
      // cooling down) never reach a key and therefore have no try_failed entry;
      // their reason lives on the record. Without this they would be missing
      // from the analysis even though the request table shows them.
      const failed = Number(rec.status) >= 400 || Number(rec.status) === 0;
      if (failed && tries.length === 0 && (rec.reason || rec.err_type || rec.err)) {
        add(String(rec.reason || ''), String(rec.provider || ''), String(rec.key_id || ''),
          String(rec.err || ''), String(rec.err_type || ''), ts);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  }

  function renderErrorAnalysis() {
    const container = $('errorAnalysisList');
    if (!container) return;
    container.innerHTML = '';

    // The scope sentence must match the window actually loaded: the failed-only
    // segment is narrower than「最近 50 条请求」and must say so.
    const sub = $('errorAnalysisSub');
    if (sub) {
      sub.textContent = state.recentFailedOnly
        ? '基于当前「仅失败与重试」窗口的失败记录统计'
        : '基于最近 50 条请求中的失败记录统计';
    }

    const agg = aggregateFailures(state.recentRequests || []);
    if (agg.length === 0) {
      const emptyRow = ce('div');
      emptyRow.className = 'row row--static text-muted';
      emptyRow.textContent = '当前窗口内没有失败记录';
      container.appendChild(emptyRow);
      return;
    }

    const shown = agg.slice(0, 10);
    const wrap = ce('div');
    wrap.className = 'table-wrap';
    const table = ce('table');
    table.className = 'data-table';
    table.innerHTML = '<thead><tr><th>原因</th><th>供应商 / Key</th><th>次数</th><th>最近发生</th><th>错误类型</th><th>最近一条原文</th></tr></thead>';
    const tbody = ce('tbody');
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    for (const item of shown) {
      const chars = Array.from(item.lastErr || '');
      const short = chars.slice(0, 80).join('');
      const tr = ce('tr');
      tr.innerHTML = `
        <td><span class="reqlog-reason" title="${eh(item.reason || '')}">${eh(item.reason ? reasonLabel(item.reason) : '—')}</span></td>
        <td class="reqlog-target">${eh(item.provider || '—')}${item.keyId ? ` / ${eh(item.keyId)}` : ''}</td>
        <td class="tabular">${item.count}</td>
        <td class="tabular" title="${eh(fullTimeOf(item.lastTs))}">${clockOf(item.lastTs)}</td>
        <td class="tabular">${eh(item.lastErrType || '—')}</td>
        <td class="reqlog-err-cell" title="${eh(item.lastErr || '')}">${eh(short || '—')}${chars.length > short.length ? '…' : ''}</td>
      `;
      tbody.appendChild(tr);
    }

    if (agg.length > shown.length) {
      const foot = ce('div');
      foot.className = 'reqlog-foot text-muted';
      foot.textContent = `还有 ${agg.length - shown.length} 类`;
      container.appendChild(foot);
    }
  }

  // --- Unified settings row (#1): one item per line — title + desc on the left,
  // control on the right; desc doubles as the hover tooltip via the title attr.
  // `id` is optional: some rows are toggled by capability (e.g. the Base URL row is
  // Full-only), and those selectors look the container up by id.
  function settingRow(title, desc, controlHtml, id = '') {
    return `<div class="setting-row"${id ? ` id="${id}"` : ''} title="${eh(desc)}"><div class="setting-main"><div class="setting-title">${eh(title)}</div><div class="setting-desc">${eh(desc)}</div></div><div class="setting-control">${controlHtml}</div></div>`;
  }

  // Mounts the routing-policy and concurrency-guard rows once at init; the inputs
  // keep the same ids, so renderSettingsView keeps filling values by id afterwards.
  function mountSettingRows() {
    const routingRows = $('routingPolicyRows');
    if (routingRows && !routingRows.childElementCount) {
      routingRows.innerHTML = [
        settingRow('默认路由策略', '候选 Key 间的调度方式；粘性优先可保住上下文缓存', `<select class="select" id="cfgRoutingStrategy">
          <option value="sticky_failover">多路会话粘性优先</option>
          <option value="round_robin">空闲优先轮询</option>
          <option value="weighted">按权重比例分摊</option>
          <option value="least_busy">最少并发优先</option>
          <option value="fast">动态低延迟优先</option>
          <option value="manual">手动直通</option>
        </select>`),
        settingRow('首字超时 (秒)', '5~600；等上游吐出首个字片的时限，超时换下一候选', `<input class="input tabular" id="cfgFirstByteTimeout" type="number" min="5" max="600" placeholder="120">`),
        settingRow('429 限流冷却 (秒)', '命中上游限流后该 Key 暂停调度的时长', `<input class="input tabular" id="cfgCooldown429" type="number" min="0" placeholder="15">`),
        settingRow('5xx 服务端异常冷却 (秒)', '上游 5xx 后该 Key 暂停调度的时长', `<input class="input tabular" id="cfgCooldown5xx" type="number" min="0" placeholder="30">`),
        settingRow('网络超时冷却 (秒)', '网络超时等异常后该 Key 暂停调度的时长', `<input class="input tabular" id="cfgCooldownNet" type="number" min="0" placeholder="15">`),
        settingRow('401/403 鉴权失败冷却 (秒)', '鉴权失败封禁该 Key 的时长；0 不封禁', `<input class="input tabular" id="cfgCooldownAuth" type="number" min="0" placeholder="86400">`),
      ].join('');
    }
    const guardRows = $('concurrencyGuardRows');
    if (guardRows && !guardRows.childElementCount) {
      guardRows.innerHTML = [
        settingRow('OCR 预读并发上限', '1~64；大图预读并发上限，防止内存溢出', `<input class="input tabular" id="cfgOcrInflight" type="number" min="1" max="64" placeholder="4">`),
        settingRow('固定通道全局并发上限', '1~256；固定通道整体最大并发请求数', `<input class="input tabular" id="cfgKbConcurrency" type="number" min="1" max="256" placeholder="16">`),
      ].join('');
    }
    // Gateway access: the three fields were a plain form-grid; they now follow the
    // same row规范. Input ids are unchanged so renderSettingsView keeps filling them.
    const gwRows = $('gatewayAccessRows');
    if (gwRows && !gwRows.childElementCount) {
      gwRows.innerHTML = [
        settingRow('网关入口地址 (Base URL)',
          '客户端实际调用用的完整地址，供复制到 Cursor / Claude Code 等客户端；只读，由当前访问地址推导',
          `<input class="input input--code" id="gwBaseUrl" readonly>`, 'gwBaseUrlGroup'),
        settingRow('主客户端鉴权密钥 (client_key)',
          '调用 /v1/* 的主密钥；所有客户端至少需要这一把。修改后旧密钥立即失效',
          `<div class="input-row"><input class="input input--code privacy-mask" id="gwClientKey" placeholder="输入或生成客户端 API Key"><button class="btn" id="btnGenClientKey">随机生成</button><button class="btn" id="btnSaveClientKey">保存密钥</button></div>`),
      ].join('');
    }
    // Vault link (Full only): URL + node token.
    const vaultRows = $('vaultLinkRows');
    if (vaultRows && !vaultRows.childElementCount) {
      vaultRows.innerHTML = [
        settingRow('Vault 中枢地址',
          '中枢（Hub）的根地址；改地址必须重新输入 Token',
          `<input class="input input--code" id="cfgVaultUrl" placeholder="https://key.example.com">`),
        settingRow('节点同步 Token',
          '该节点专属的 stk_node_* 令牌，仅用于向中枢拉取配置与供应商；丢失请在中枢轮换',
          `<input class="input input--code privacy-mask" id="cfgVaultToken" placeholder="输入 NODE_TOKEN">`),
      ].join('');
    }
    // Config backup: export / import.
    const backupRows = $('configBackupRows');
    if (backupRows && !backupRows.childElementCount) {
      backupRows.innerHTML = [
        settingRow('导出当前完整配置 (JSON)',
          '下载一份包含提供商、路由与设置的完整配置，可用于备份或迁移到另一台节点',
          `<button class="btn" id="btnExportConfig">导出 JSON 配置文件</button>`),
        settingRow('导入 v1 / v2 配置文件',
          '从备份恢复：增量合并保留现有内容，全量覆盖会替换全部配置；密钥类字段按脱敏规则处理',
          `<div class="input-row"><select class="select" id="importConfigMode"><option value="merge">增量合并 (保留现有)</option><option value="overwrite">全量覆盖</option></select><input type="file" id="importConfigFile" accept=".json,application/json" hidden><button class="btn" id="btnTriggerImport">选择文件导入</button></div>`),
      ].join('');
    }
    // Model catalog (Hub only — the Hub owns the KV catalog a Full node pulls,
    // and it is the only side that may reach models.dev). No .btn--primary here:
    // updating a cache is maintenance, not the card's primary save action.
    const catalogRows = $('modelCatalogRows');
    if (catalogRows && !catalogRows.childElementCount) {
      catalogRows.innerHTML = [
        settingRow('上次更新',
          '当前目录的抓取时间（本地时区）与收录的模型数量；尚未更新时节点各自使用内嵌目录',
          `<span class="text-xs text-muted tabular" id="modelCatalogMeta">尚未更新</span>`),
        settingRow('手动更新',
          '从 models.dev 拉取最新目录并在中枢侧瘦身后写入 KV；失败不会影响现有目录',
          `<div class="input-row"><a class="text-xs text-link" id="modelCatalogSourceLink" href="https://models.dev" target="_blank" rel="noopener noreferrer" title="数据来源 models.dev">数据来源</a><button class="btn" id="btnUpdateModelCatalog">立即从 models.dev 更新</button></div>`),
      ].join('');
    }
  }

  // --- View: Settings (M16, U3, U4) ---
  // Model catalog card (Hub only). The catalog itself never rides on /api/config
  // (1.6 MB): the page gets meta only, and this card is the single place that
  // asks for a refresh — no background polling, no automatic network call.
  // Backend error codes (edgeone-hub/api/admin/model-catalog.js) are dotted for the
// upstream failures — match them verbatim, or the card would print a raw code.
  const MODEL_CATALOG_ERROR_TEXT = {
    'models.dev_unreachable': '连不上 models.dev（20 秒超时），已保留现有目录；节点仍使用内嵌目录',
    'models.dev_invalid': 'models.dev 返回的不是合法 JSON，已保留现有目录',
    catalog_invalid: '拉取到的目录校验不通过，已保留现有目录',
    catalog_not_found: '中枢还没有模型目录',
    method_not_allowed: '当前接口不接受该操作',
  };

  function formatLocalDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // ≥1000 -> K, exactly 1000000 -> M (the ask's formatting rule). Values that are
  // not published stay absent rather than printing a misleading 0.
  function fmtTokens(n) {
    const v = Math.floor(Number(n) || 0);
    if (v <= 0) return '';
    if (v === 1000000) return '1M';
    if (v >= 1000) return `${Math.round(v / 1000)}K`;
    return String(v);
  }

  function modelCatalogMetaText(m) {
    if (!m || !m.present) return '尚未更新';
    const when = formatLocalDateTime(m.fetched_at);
    const count = Number(m.model_count) || 0;
    return `${when || '时间未知'} · ${count.toLocaleString('en-US')} 个模型`;
  }

  function renderModelCatalogCard(refresh) {
    const metaEl = $('modelCatalogMeta');
    const btn = $('btnUpdateModelCatalog');
    if (!metaEl && !btn) return;
    const apply = (m) => {
      if (m && typeof m === 'object' && m.ok !== false) {
        state.config = state.config || {};
        state.config.model_catalog_meta = {
          present: Boolean(m.present),
          fetched_at: m.fetched_at || '',
          model_count: Number(m.model_count) || 0,
        };
      }
      if (metaEl) metaEl.textContent = modelCatalogMetaText(state.config?.model_catalog_meta);
    };
    apply(state.config?.model_catalog_meta);
    // The config snapshot may predate a previous update (or a different tab's
    // update), so the authoritative meta is fetched once per page.
    if (refresh || !state.modelCatalogMetaLoaded) {
      state.modelCatalogMetaLoaded = true;
      window.HOST.getModelCatalogMeta().then(apply).catch(() => {});
    }
    if (btn) {
      btn.onclick = async () => {
        if (btn.disabled) return;
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = '更新中…';
        try {
          const res = await window.HOST.updateModelCatalog();
          if (res && res.ok) {
            apply({ present: true, fetched_at: res.fetched_at, model_count: res.model_count });
            // A new catalog can change a model's ladder/toggle answer: drop the
            // session memo so the next dropdown/summary asks again.
            state.modelInfoCache = {};
            toast(`模型目录已更新：${Number(res.model_count || 0).toLocaleString('en-US')} 个模型`, 'ok');
          } else {
            const code = String(res?.error || '');
            toast(MODEL_CATALOG_ERROR_TEXT[code] || `更新失败：${scrubUiText(code || '未知错误')}`, 'err');
            // detail is bounded server-side and carries no key material.
            console.warn('[model-catalog] update failed', code, String(res?.detail || ''));
          }
        } catch (e) {
          toast(`更新失败：${scrubUiText(e.message)}`, 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = label;
        }
      };
    }
  }

  function renderSettingsView() {
    state.config = state.config || {};
    state.config.settings = state.config.settings || {};
    const s = state.config.settings;
    const isFull = Boolean(window.HOST.capabilities.kbModels);

    const setVal = (id, val) => {
      const el = $(id);
      if (el) el.value = val !== undefined ? val : '';
    };

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
    const gwHubNotice = $('gwHubNotice');
    const gwSummaryPill = $('gwAccessSummaryPill');
    const guardBox = $('concurrencyGuardBox');
    const backupBox = $('configBackupBox');
    const sysBox = $('systemUpdateBox');

    if (gwBox) gwBox.hidden = false;
    if (gwBaseUrlGroup) gwBaseUrlGroup.hidden = !isFull;
    if (gwHubNotice) gwHubNotice.hidden = isFull;
    if (guardBox) guardBox.hidden = false;
    if (backupBox) backupBox.hidden = false;
    if (sysBox) sysBox.hidden = !window.HOST.capabilities.systemUpdate;
    // 模型目录 exists only on the Hub: it is the side that stores the catalog in
    // KV and may reach models.dev. A Full node pulls the artifact instead.
    const catalogBox = $('modelCatalogBox');
    if (catalogBox) catalogBox.hidden = !isHubMode();
    renumberSettingsSections();
    if (isHubMode()) renderModelCatalogCard();

    const baseOrigin = location.origin || 'http://127.0.0.1:3425';
    const localBase = `${baseOrigin}/v1`;
    const clientKey = s.client_key || s.proxy_api_key || '';

    if (gwSummaryPill) {
      gwSummaryPill.textContent = clientKey
        ? '主密钥已配置'
        : (isFull ? '主密钥未配置' : '待设置下发至节点');
    }

    const gwBaseUrl = $('gwBaseUrl');
    if (gwBaseUrl) gwBaseUrl.value = localBase;

    const gwClientKey = $('gwClientKey');
    if (gwClientKey) gwClientKey.value = clientKey;

    const btnGen = $('btnGenClientKey');
    if (btnGen) {
      btnGen.onclick = () => {
        const rand = generateClientSecretKey();
        if (gwClientKey) gwClientKey.value = rand;
      };
    }

    const btnSaveKey = $('btnSaveClientKey');
    if (btnSaveKey) {
      btnSaveKey.onclick = async () => {
        const k = (gwClientKey?.value || '').trim();
        s.client_key = k;
        s.proxy_api_key = k;
        await persistConfig(isFull ? '客户端鉴权密钥已保存' : '已保存，将自动投影下发至节点');
      };
    }

    // Delegated once: the chips survive re-renders because the containers are
    // static, and every value is read at click time (the key from the live input,
    // a model id from the chip's own data-model), so a just-typed key or a
    // freshly enabled route is what copies.
    bindGatewayCopyChips();

    if (isFull) {
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
