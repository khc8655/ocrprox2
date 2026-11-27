/**
 * app.js — Magpie Minimalist Admin UI Controller
 * Zero inline style, zero left-border stripes, inline row editors.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const ce = (t) => document.createElement(t);
  const clk = (el, fn) => el && el.addEventListener('click', fn);
  // 表单字段组：标签在上方（12px --khc-text-2），可选 ⓘ 悬停说明。
  // hint 会渲染成标签旁的 ⓘ 按钮（title 悬停提示）——字段说明不常驻占位。
  // --- 组件 2 · 字段说明不常驻：标签旁的 ⓘ 悬停提示 ---
  // 输入框/下拉框的说明文字默认进 placeholder；只有放不下的补充说明才用 ⓘ
  // 挂在标签右侧（title 悬停提示），校验错误才显示红字。
  const fieldHint = (text) => (text
    ? `<button class="field-hint" type="button" title="${escapeHtml(text)}" aria-label="字段说明">ⓘ</button>`
    : '');

  const fg = (lbl, ctrl, id = '', cls = '', hint = '') => `<div class="form-group${cls ? ' ' + cls : ''}"${id ? ` id="${id}"` : ''}><label class="form-label">${lbl}${fieldHint(hint)}</label>${ctrl}</div>`;
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
    // 「新增 X」在列表顶部插入一个空白编辑器（create 模式），与普通编辑互斥：
    // 用 activeEditorKey 的哨兵值表示（普通编辑是 p_<id> / m_<name>）。
    creatingProvider: false,
    creatingModel: false,
    // 「新增节点」= 列表顶部插入空白编辑器（create 模式），与普通展开态互斥。
    creatingNode: false,
    // 签发成功 / 重新获取后，列表顶部切换成「安装」视图的节点 id。
    nodeInstallFor: null,
    // 节点凭据（明文只留内存）：nodeId -> { node_token, client_key, admin_password }。
    nodeSecrets: {},
    // 「新增供应商」create 编辑器的草稿标记：操作者手动改过 ID / 预设 / 协议后，
    // 自动生成与自动匹配就不再覆盖他的手填值。
    newProvIdTouched: false,
    newProvPresetTouched: false,
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
    // Full 端 preset-status 的 has_update 集合（供应商 id → true）：列表行的
    // 「可更新」弱警告与设置页「预设与中枢同步」行共用一次查询的结果。
    presetUpdateFlags: {},
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
      return res._version;
    }
    return null;
  }

  // 刷新本页持有的配置版本号（不重绘任何视图）。
  //
  // 为什么需要它：Full 节点的「测试这个模型」/「测试 Key」会走
  // POST /api/admin/test-key，服务端把这次结论落盘到配置里
  // （PersistKeyTestState → saveConfigLocked），配置版本 +1。
  // 但 test-key 的响应里没有 _version，前端的 state.config._version
  // 就此落后一版 —— 紧接着的保存带着旧版本提交，被 CAS 判为冲突（409），
  // 用户的改动被整条丢弃。这是本页自己的请求造成的，不是「别人改了」，
  // 所以必须在测试后把版本号追平，否则「先测一下再保存」必丢。
  //
  // 只读版本号、不覆盖 state.config：整份配置由 GET /api/config 回读会
  // 把用户正在编辑的字段冲掉（编辑器里未保存的草稿就没了）。
  async function refreshConfigVersion() {
    if (!state.config || typeof window.HOST.getConfig !== 'function') return null;
    try {
      return syncVersionFromRes(await window.HOST.getConfig());
    } catch (_) {
      return null;
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

  // --- 组件 6 · 弹框 .dialog（docs/UI_DESIGN_SPEC.md §七） ---
  // 只用于 (a) 删除 / 吊销 / 轮换等确认 (b) 只显示一次的密钥、密码、安装命令
  // (c) 登录。统一 openDialog() / closeDialog()：Esc 与遮罩点击关闭，不嵌套。
  // 每个弹框可注册自己的关闭动作（有副作用的弹框必须注册：恢复焦点、
  // 取消进行中的批量拉取等），未注册的走默认关闭。
  const dialogClosers = {};

  function openDialog(target, opts = {}) {
    const dlg = typeof target === 'string' ? document.getElementById(target) : target;
    if (!dlg) return null;
    dlg.hidden = false;
    dlg.classList.remove('hidden');
    const focusEl = (opts.focus && document.getElementById(opts.focus)) || dlg.querySelector('.dialog-close');
    if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
    return dlg;
  }

  function closeDialog(target) {
    const dlg = typeof target === 'string' ? document.getElementById(target) : target;
    if (!dlg) return;
    dlg.hidden = true;
    dlg.classList.add('hidden');
  }

  // 注册弹框的关闭动作（有副作用的弹框必须注册：恢复焦点、取消进行中的
  // 批量拉取等），未注册的走默认关闭。
  function registerDialog(id, closer) {
    dialogClosers[id] = closer;
  }

  function closeDialogById(id) {
    const closer = dialogClosers[id];
    if (typeof closer === 'function') {
      closer();
      return;
    }
    closeDialog(id);
  }

  // 统一确认弹框：所有删除 / 吊销 / 轮换 / 覆盖类二次确认都走这里，行为等价于
  // 原来的 window.confirm()，但外观是 .dialog 组件。返回 Promise<boolean>。
  let confirmDialogSettle = null;

  function confirmDialog(opts = {}) {
    const {
      title = '确认操作',
      message = '',
      confirmText = '确定',
      cancelText = '取消',
      danger = true,
    } = opts;
    const dlg = $('confirmDialog');
    // 兜底：万一确认框被移除，退回浏览器原生确认，绝不静默放行。
    if (!dlg) return Promise.resolve(window.confirm(message));
    const titleEl = $('confirmDialogTitle');
    const textEl = $('confirmDialogText');
    const okBtn = $('btnConfirmDialogOk');
    const cancelBtn = $('btnConfirmDialogCancel');
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = message;
    if (okBtn) {
      okBtn.textContent = confirmText;
      okBtn.classList.toggle('btn--danger', danger);
      okBtn.classList.toggle('btn--primary', !danger);
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;
    openDialog(dlg);
    return new Promise((resolve) => { confirmDialogSettle = resolve; });
  }

  function settleConfirmDialog(result) {
    const settle = confirmDialogSettle;
    confirmDialogSettle = null;
    closeDialog('confirmDialog');
    if (settle) settle(result);
  }

  // --- 组件 7 · 菜单 .menu ---
  // 行内次要操作超过 2 个时收进「⋯」。浮层位置由类名控制（.menu-pop /
  // .menu-pop--left），无内联样式；点击菜单外部或按 Esc 关闭。
  const openMenus = [];

  // 菜单浮层会随列表重绘（innerHTML 重建）一起被从 DOM 上摘除。这种「死元素」
  // 若留在 openMenus 里，Esc 会先命中它并提前 return —— 弹框就关不掉，必须再按
  // 一次。所以每次读 openMenus 之前先剔除「已脱离 DOM / 已隐藏」的条目。
  function pruneOpenMenus() {
    for (let i = openMenus.length - 1; i >= 0; i--) {
      const p = openMenus[i];
      if (!p || !p.isConnected || p.hidden) openMenus.splice(i, 1);
    }
    return openMenus;
  }

  function closeMenuPop(pop) {
    if (!pop) return;
    pop.hidden = true;
    pop.classList.add('hidden');
    const idx = openMenus.indexOf(pop);
    if (idx >= 0) openMenus.splice(idx, 1);
  }

  function closeAllMenus() {
    pruneOpenMenus();
    openMenus.slice().forEach(closeMenuPop);
  }

  function toggleMenuPop(pop) {
    const wasOpen = !pop.hidden;
    closeAllMenus();
    if (wasOpen) return;
    pop.hidden = false;
    pop.classList.remove('hidden');
    if (!openMenus.includes(pop)) openMenus.push(pop);
  }

  // items: [{ label, title?, danger?, onClick }]; opts.align = 'left' 让浮层左对齐展开。
  function buildMenu(items, opts = {}) {
    const wrap = ce('span');
    wrap.className = 'menu';
    const btn = ce('button');
    btn.type = 'button';
    btn.className = 'menu-btn';
    btn.textContent = '⋯';
    btn.title = opts.label || '更多操作';
    btn.setAttribute('aria-label', opts.label || '更多操作');
    btn.setAttribute('aria-haspopup', 'true');
    const pop = ce('span');
    pop.className = `menu-pop${opts.align === 'left' ? ' menu-pop--left' : ''}`;
    pop.hidden = true;
    pop.classList.add('hidden');
    for (const item of items || []) {
      if (!item) continue;
      const mi = ce('button');
      mi.type = 'button';
      mi.className = `menu-item${item.danger ? ' menu-item--danger' : ''}${item.cls ? ' ' + item.cls : ''}`;
      mi.textContent = item.label;
      if (item.title) mi.title = item.title;
      clk(mi, () => {
        closeMenuPop(pop);
        if (typeof item.onClick === 'function') item.onClick();
      });
      pop.appendChild(mi);
    }
    clk(btn, (ev) => {
      ev.stopPropagation();
      toggleMenuPop(pop);
    });
    wrap.appendChild(btn);
    wrap.appendChild(pop);
    return wrap;
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

  // --- 弹框基础设施：确认框接线 + 遮罩点击 + 菜单外部点击 ---
  function setupDialogs() {
    const confirmDlg = $('confirmDialog');
    if (confirmDlg) {
      clk($('btnConfirmDialogOk'), () => settleConfirmDialog(true));
      clk($('btnConfirmDialogCancel'), () => settleConfirmDialog(false));
      clk($('btnConfirmDialogClose'), () => settleConfirmDialog(false));
      // 遮罩点击 = 取消（与 Esc 一致）。
      confirmDlg.addEventListener('click', (ev) => {
        if (ev.target === confirmDlg) settleConfirmDialog(false);
      });
    }
    // 业务弹框的遮罩点击关闭：统一走 closeDialogById，让注册过的关闭动作
    // （恢复焦点、取消批量拉取等）照常执行。
    document.querySelectorAll('.dialog').forEach((dlg) => {
      if (dlg.id === 'confirmDialog') return;
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) closeDialogById(dlg.id);
      });
    });
    // 点菜单外部关闭「⋯」浮层。
    document.addEventListener('click', (ev) => {
      if (!pruneOpenMenus().length) return;
      const inMenu = ev.target instanceof Element && ev.target.closest('.menu');
      if (!inMenu) closeAllMenus();
    });
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
    setupDialogs();
    setupNavigation();
    setupCreationForms();
    setupToolbars();
    // 设置行的 HTML 由 mountSettingRows() 运行时挂载，备份/导入的按钮就住在
    // 那些行里 —— 必须先挂载再绑定，否则 clk() 会拿到 null 而静默跳过
    // （这正是「导出 JSON」「选择文件导入」点了没反应的历史根因）。
    mountSettingRows();
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
    const fullOverviewBox = $('fullOverviewBox');
    const btnClearAllCooldowns = $('btnClearAllCooldowns');
    const btnImportFromTemplate = $('btnImportFromTemplate');
    const btnHubBatchVerifyAll = $('btnHubBatchVerifyAll');

    if (navModels) navModels.hidden = false;
    if (navNodes) navNodes.hidden = !caps.nodeManager;
    // 接入信息 only describes a gateway this console can answer for: the Hub is
    // a config plane with no data plane of its own.
    if (navAccess) navAccess.hidden = isHub;
    // Hub 没有独立概览页：导航只剩「节点 / 供应商 / 模型 / 设置」，
    // 登录后默认进「节点」；活跃节点信息由节点列表本身承担。
    if (navActivity) navActivity.hidden = isHub;
    if (topVersionBox) topVersionBox.hidden = !caps.vaultHub;
    if (cfgVaultLinkBox) cfgVaultLinkBox.hidden = !caps.vaultClient;
    if (fullOverviewBox) fullOverviewBox.hidden = isHub;
    if (btnClearAllCooldowns) btnClearAllCooldowns.hidden = !caps.kbModels;
    if (btnImportFromTemplate) btnImportFromTemplate.hidden = !caps.vaultClient;
    // Hub 端「一键探活全部 Key」：逐把探活，不消耗推理额度。
    if (btnHubBatchVerifyAll) btnHubBatchVerifyAll.hidden = !isHub;
    const guardBox = $('concurrencyGuardBox');
    if (guardBox) guardBox.hidden = false;
    const sysBox = $('systemUpdateBox');
    if (sysBox) sysBox.hidden = !caps.systemUpdate;
    // 预设与中枢同步：Full only（Hub 主机没有 preset-status / sync 能力）。
    const presetSyncBox = $('presetSyncBox');
    if (presetSyncBox) presetSyncBox.hidden = !caps.kbModels;

    const provSub = $('providersSubtitle');
    if (provSub) {
      provSub.textContent = isHub
        ? '统一维护共享供应商与密钥池，按节点权限范围安全下发至接入的 Full / Lite 节点'
        : '集中管理本地私有供应商；中枢托管供应商按需拉取（清单 → 整体拉取 → 按 Key 补拉）';
    }
    const modelsTitle = $('modelsTitle');
    const modelsSub = $('modelsSubtitle');
    if (modelsTitle) {
      modelsTitle.textContent = isHub ? '模型模板（下发编排）' : '模型';
    }
    if (modelsSub) {
      modelsSub.textContent = isHub
        ? '仅下发给 lite 节点；full 节点可选导入'
        : '每个模型由一个供应商提供；同一模型来自多个供应商时自动组成故障转移。';
    }
    // 「并发护栏」在 Hub 上只是下发默认值，Lite 节点会忽略 —— 一句话说清，不再铺标题 + 副标题。
    const cgTitle = $('concurrencyGuardTitle');
    if (cgTitle) {
      cgTitle.textContent = isHub ? '并发护栏（Lite 节点自动忽略）' : '并发护栏';
    }
    // Hub 登录后默认进「节点」（导航已无「概览」页）；Full 仍是「概览」。
    state.activeTab = isHub ? 'nodes' : 'activity';
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
        // 「⋯」菜单先于弹框关闭：菜单是最内层的浮层。但只有真正还挂在 DOM 上、
        // 且可见的菜单才算「开着」—— 列表重绘会摘除旧浮层，死条目不能吞掉本该
        // 关闭弹框的这一次 Esc。
        if (pruneOpenMenus().length) {
          closeAllMenus();
          return;
        }
        // 确认框：Esc = 取消，不执行任何动作。
        const confirmDlg = $('confirmDialog');
        if (confirmDlg && !confirmDlg.hidden) {
          settleConfirmDialog(false);
          return;
        }
        let closedSomething = false;
        // 「新增」编辑器（列表顶部的空白 .editor）：Esc 直接丢弃 —— 必须重绘它
        // 所属的列表，否则空白的 create 编辑器还留在 DOM 里（state 标志清了
        // 但视图没跟上）。create 编辑器可能属于当前页签之外的页签（切走过），
        // 所以按「归属页签」找，不按 state.activeTab 找。
        const createTab = anyCreateEditorTab();
        if (createTab) {
          closeCreateEditor(createTab);
          closedSomething = true;
        }
        const installOverlay = $('nodeInstallOverlay');
        if (installOverlay && !installOverlay.hidden) { closeNodeInstallOverlay(); closedSomething = true; }
        const tplImportOverlay = $('templateImportOverlay');
        if (tplImportOverlay && !tplImportOverlay.hidden) { closeTemplateImportOverlay(); closedSomething = true; }
        if (state.activeEditorKey) {
          state.activeEditorKey = null;
          state.nodeInstallFor = null;
          closedSomething = true;
          renderTabList(state.activeTab);
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
      // 刷新页面上已经渲染出来的 Key 状态列。冷却会自己到期、也可能被解除，
// 不回写的话用户得手动折叠再展开才看得到变化。
      const repaintKeyStatusCells = () => {
        document.querySelectorAll('.k-status-cell').forEach((cell) => {
          const tr = cell.closest('tr');
          const tbody = cell.closest('tbody');
          const pId = tbody && tbody.id && tbody.id.startsWith('p_keys_tbody_')
            ? tbody.id.slice('p_keys_tbody_'.length)
            : '';
          if (!pId) return;
          const idx = Number(tr?.dataset.keyIdx);
          const k = state.config?.providers?.[pId]?.api_keys?.[idx];
          if (!k) return;
          const cd = findKeyCooldown(pId, k, idx);
          cell.innerHTML = keyStatusCellHtml(k, cd.sec, cd.target);
          if (tr) {
            tr.dataset.cdSec = String(cd.sec);
            tr.dataset.cdTarget = cd.target || '';
          }
        });
      };
      state.repaintKeyStatusCells = repaintKeyStatusCells;
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
        if (state.activeTab === 'providers') repaintKeyStatusCells();
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

    // 「添加节点」= 在列表顶部插入一个空白编辑器（create 模式）。
    const btnIssueNode = $('btnIssueNode');
    if (btnIssueNode) {
      clk(btnIssueNode, () => {
        state.creatingNode = !state.creatingNode;
        state.activeEditorKey = null;
        renderNodesList();
      });
    }

    const btnCloseNodeInstall = $('btnCloseNodeInstall');
    if (btnCloseNodeInstall) {
      clk(btnCloseNodeInstall, closeNodeInstallOverlay);
    }

    // Esc already closes editors globally; also close the install overlay so the
    // keyboard story stays "Esc cancels whatever is open". Clicking the dimmed
    // backdrop does the same — the generic .dialog backdrop handler in
    // setupDialogs() routes it through closeDialogById(), which calls the
    // registered closer below.
    registerDialog('nodeInstallOverlay', closeNodeInstallOverlay);

    clk($('btnImportFromTemplate'), async () => {
      // Force a reload: the cached manifest is a snapshot, and template routes newly
      // published on the hub must be importable without a full page refresh.
      await loadVaultManifest({ force: true });
      openTemplateImportOverlay();
    });
    clk($('btnCloseTemplateImport'), closeTemplateImportOverlay);
    clk($('btnCloseTemplateImportFoot'), closeTemplateImportOverlay);
    clk($('btnConfirmImportRoutes'), handleConfirmImportRoutes);
    registerDialog('templateImportOverlay', closeTemplateImportOverlay);
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
        const ok = await confirmDialog({
          title: '清空内存请求轨迹',
          message: '确定清空内存中的请求轨迹吗？账本记录（最近请求与错误分析）会保留。',
          confirmText: '清空',
        });
        if (!ok) return;
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
    minimax: ['MiniMax', 'https://api.minimaxi.com/v1', 'openai-completions', '1.4.0', '2026-10-18', 'https://api.minimaxi.com/anthropic'],
    // minimax / minimax-cn 各有独立适配文件（shared/presets/minimax*.json），版本各自独立。
    'minimax-cn': ['MiniMax (国内)', 'https://api.minimaxi.com/v1', 'openai-completions', '1.5.0', '2026-11-23', 'https://api.minimaxi.com/anthropic'],
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
  // 长选项：值可以跟在后面（--header 'k: v'）、紧贴（--header'k: v'）或用 =（--header=k: v）。
  // 顺序敏感：--data-raw 必须排在 --data 前面，否则 --data 会先匹配上。
  const CURL_LONG_OPTS = ['--header', '--data-raw', '--data', '--json', '--url'];
  // 带参数的开关：值是下一个词，解析时必须跳过它（否则 POST 会被当成 URL）。
  const CURL_OPTS_WITH_VALUE = ['-X', '--request', '--proxy', '--user-agent', '-A', '-e', '--referer', '-o', '--output'];
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
      // 「-H 'k: v'」（分离写法）与「-H'k: v'」（连写）都要认。
      // 分离写法里 x 恰好是 "-H"，slice(2) 取到空串 —— 若不判断值是否为空，
      // 下一段文本（整条 header）会被当成 header 值，URL 则被漏掉。
      if (/^-[Hd]/.test(x)) {
        opt = x.slice(0, 2);
        val = x.length > 2 ? x.slice(2) : (words[++i] ?? '');
      }
      // 长选项同样有三种写法：「--header 'k: v'」/「--header'k: v'」/「--header=k: v」。
      else if (CURL_LONG_OPTS.some((o) => x === o || x.startsWith(o))) {
        // 长名先匹配：--data-raw 必须排在 --data 前面。
        opt = CURL_LONG_OPTS.find((o) => x === o || x.startsWith(o));
        if (x === opt) val = words[++i] ?? '';
        else if (x.startsWith(opt + '=')) val = x.slice(opt.length + 1);
        else val = x.slice(opt.length);
      }
      // 带参数的开关（-X POST / --request POST …）：值是下一个词，必须跳过，
      // 否则 POST 之类的方法名会被当成 URL。
      else if (CURL_OPTS_WITH_VALUE.some((o) => x === o)) {
        i++;
        continue;
      }
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

  // 适配信息只出现在供应商编辑器的「高级」区（列表行不再堆标签）。

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

    // 节点页的「刷新」：重拉节点 + 中枢概览。
    clk($('btnHubRefreshOverview'), async () => {
      await loadNodesData();
      renderHubOverview();
    });
    clk($('btnHubBatchVerifyAll'), verifyAllHubKeys);
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
        const ok = await confirmDialog({
          title: '应用原始 JSON 配置',
          message: '确认直接应用这段 JSON 配置吗？保存时会自动保留未修改的脱敏密钥。',
          confirmText: '应用',
        });
        if (!ok) return;
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
              const ok = await confirmDialog({
                title: '在线平滑升级',
                message: `确定下载并升级到 ${data.latest_version} 并自动重启服务吗？`,
                confirmText: '开始升级',
              });
              if (!ok) return;
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
      const ok = await confirmDialog({
        title: '平滑重启服务',
        message: '确定向服务发送平滑重启信号 (SIGTERM) 吗？(systemd 托管下约 2-3 秒自动恢复)',
        confirmText: '重启',
      });
      if (!ok) return;
      try {
        const res = await window.HOST.restartService();
        toast(res?.message || '已触发平滑重启', 'ok');
      } catch (e) {
        toast(`重启失败: ${e.message}`, 'err');
      }
    });
  }

  // --- Add Provider: source switch (custom vs vault on-demand) ---
  // Vault mode locks the hub-managed fields (the hub is authoritative) and only
  // lists manifest providers that are not configured locally yet. The hub console
  // itself hosts the vault, so the on-demand source only exists on Full nodes.
  function applyNewProvSourceMode() {
    const vaultMode = ($('newProvSource')?.value || 'custom') === 'vault';
    const srcToggle = $('btnProvSourceToggle');
    if (srcToggle) {
      // Hub hosts the vault itself: no「中枢托管」source on the hub console.
      srcToggle.hidden = isHubMode();
      srcToggle.textContent = vaultMode ? '改用自定义供应商' : '改用中枢托管供应商';
    }
    const setDisabled = (id, dis) => {
      const el = $(id);
      if (el) el.disabled = dis;
    };
    setDisabled('newProvName', vaultMode);
    setDisabled('newProvBaseUrl', vaultMode);
    setDisabled('newProvApiKey', vaultMode);
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
  }

  // 「从中枢添加」供应商数据表（组件 4 · .data-table）：名称 / 预设·版本 / Key 数 /
  // 状态（已添加 / 可添加）/ 操作（添加）。点「添加」整体拉取该供应商（与底部
  // 「保存供应商」走同一条 vault 一次性拉取路径）；已添加的行按钮禁用。
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
        ? '中枢清单未加载（请在系统设置配置 Vault 连接）'
        : Object.keys(manifestProvs).length === 0
          ? '中枢清单为空：中枢暂未托管任何可拉取的供应商'
          : '中枢清单中的供应商均已配置在本地';
      box.appendChild(empty);
      return;
    }

    const tableWrap = ce('div');
    tableWrap.className = 'table-wrap';
    tableWrap.innerHTML = `<table class="data-table"><thead><tr><th>名称</th><th>预设 · 版本</th><th>Key 数</th><th>状态</th><th>操作</th></tr></thead><tbody></tbody></table>`;
    const tbody = tableWrap.querySelector('tbody');
    for (const [pId, meta] of entries) {
      const keyCount = Array.isArray(meta.keys) ? meta.keys.length : 0;
      const tr = ce('tr');
      // 预设 · 版本：中枢 manifest 的 preset_id + 服务端预设库的版本（PRESETS_META；
      // Full 端 presets-extra 已把服务端版本并进表）。没有预设绑定时显示「自定义」。
      const pickMeta = matchPresetMeta(pId, meta.base_url) || PRESETS_META[meta.preset_id || ''] || null;
      const presetText = meta.preset_id
        ? `${meta.preset_id}${pickMeta?.version ? ` v${pickMeta.version}` : ''}`
        : '自定义';
      tr.innerHTML = `
        <td><div class="fields"><strong>${eh(meta.name || pId)}</strong><span class="text-xs text-muted">${eh(pId)}</span></div></td>
        <td><span class="text-xs text-muted">${eh(presetText)}</span></td>
        <td><span class="tabular text-xs text-muted">${keyCount}</span></td>
        <td><span class="pill pill--green">可添加</span></td>
        <td><button class="btn btn--sm btn--primary" type="button" data-vault-add="${eh(pId)}">添加</button></td>
      `;
      clk(tr.querySelector('button[data-vault-add]'), async (ev) => {
        const btn = ev.currentTarget;
        // 拉取前重查一遍：列表重绘后按钮不会自动消失，数据是最新的。
        if (state.config?.providers?.[pId]) return toast(`供应商 ${pId} 已存在`, 'warn');
        btn.disabled = true;
        btn.textContent = '拉取中…';
        toast(`正在从中枢拉取供应商 ${pId}（规则与全部 Key）...`, 'info');
        try {
          const res = await window.HOST.fetchVaultCredentials(pId);
          if (res && res.ok) {
            state.activeEditorKey = `p_${pId}`;
            state.creatingProvider = false;
            await loadData();
            toast(`已拉取中枢供应商 ${pId}`, 'ok');
          } else {
            toast(`从中枢拉取失败: ${scrubUiText(res?.error || '请求未成功')}`, 'err');
            btn.disabled = false;
            btn.textContent = '添加';
          }
        } catch (e) {
          toast(`从中枢拉取异常: ${e.message}`, 'err');
          btn.disabled = false;
          btn.textContent = '添加';
        }
      });
      tbody.appendChild(tr);
    }
    box.appendChild(tableWrap);
  }

  // --- Preset auto-match (custom source) — 规则 A（跨端约定，与中枢 JS / Full Go
  // 三处同序同结果）：custom 显式不绑 → 已有 preset_id 保留 → 主机名相等绑定 →
  // 供应商 id === 预设 id → 名称 === 预设名称/预设 id → 不绑。
  // 预设 base_url 含「{」占位符的跳过主机名匹配；同主机命中多个预设时交给
  // 4)/5) 在这几个里挑，挑不出就不绑。
  function presetHostname(baseUrl) {
    const raw = String(baseUrl || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
      return (u.hostname || '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  // 新增供应商时的自动匹配：规则 A（3 → 4 → 5 严格同序，与中枢 JS / Full Go
  // 一致）。输入 idOrName 在规则 4/5 里既当供应商 id 也当名称用（create 编辑器
  // 里两者都可能先敲）。
  function matchPresetMeta(idOrName, baseUrl) {
    return matchPresetRules({ id: idOrName, name: idOrName, base_url: baseUrl });
  }

  // 供应商对象（已有数据）按规则 A 解析预设 meta；供列表行 / 编辑器取
  // 「预设 · 版本」显示用。
  function resolveProviderPresetMeta(p, pId) {
    if (!p || String(p.preset_id || '').trim() === 'custom') return null; // 规则 1：显式不绑
    const bound = presetMetaForProvider(p, pId);
    if (bound) return bound; // 规则 2：已有绑定保留
    return matchPresetRules({ id: pId, name: p?.name, base_url: p?.base_url });
  }

  // 规则 A 主体：输入 {id, name, base_url}，返回预设 meta 或 null（不绑）。
  // 3) 主机名相等绑定（含「{」占位符的预设跳过）；唯一命中直接绑，多命中用
  //    4)/5) 在这几个里挑，挑不出就不绑（不落回全库匹配）。
  // 4) 供应商 id（小写）=== 预设 id；5) 名称（小写去空格）=== 预设名称或预设 id。
  function matchPresetRules(input = {}) {
    const idKey = String(input.id || '').trim().toLowerCase();
    const nameKey = String(input.name || '').trim().toLowerCase();
    const byId = (list) => list.find((m) => String(m.id || '').toLowerCase() === idKey || String(m.preset_id || m.id || '').toLowerCase() === idKey);
    const byName = (list) => list.find((m) => String(m.label || '').toLowerCase() === nameKey || String(m.preset_id || m.id || '').toLowerCase() === nameKey);
    const host = presetHostname(input.base_url);
    if (host) {
      const sameHost = Object.values(PRESETS_META).filter(
        (m) => !String(m.base_url || '').includes('{') && presetHostname(m.base_url) === host
      );
      if (sameHost.length === 1) return sameHost[0];
      if (sameHost.length > 1) return (idKey && byId(sameHost)) || (nameKey && byName(sameHost)) || null;
    }
    const all = Object.values(PRESETS_META);
    return (idKey && byId(all)) || (nameKey && byName(all)) || null;
  }

  // 预设匹配：按操作者在下拉里显式选的预设，或按输入的名称 / ID / Base URL 主机名
  // 自动匹配（规则 A）。只填 Base URL（还空着时）、预设下拉与供应商 ID；协议选择器
  // 不动 —— 「自动识别」是默认口径，保存时才定（见 detectProviderProtocol）。
  function applyPresetAutoMatch() {
    if (($('newProvSource')?.value || 'custom') !== 'custom') return;
    const hintEl = $('newProvPresetHint');
    const presetSel = $('newProvPreset');
    const explicit = state.newProvPresetTouched ? (presetSel?.value || '').trim() : '';
    const meta = (explicit && PRESETS_META[explicit])
      || matchPresetMeta($('newProvName')?.value, $('newProvBaseUrl')?.value)
      || matchPresetMeta($('newProvId')?.value, $('newProvBaseUrl')?.value);
    if (hintEl) {
      const rev = meta && meta.version ? `（适配 v${meta.version}${meta.updated_at ? ` · ${meta.updated_at}` : ''}）` : '';
      hintEl.textContent = meta ? `已按预设 ${meta.label}${rev} 自动匹配` : '';
      hintEl.hidden = !meta;
      hintEl.classList.toggle('hidden', !meta);
    }
    if (!meta) return;
    if (presetSel && presetSel.value !== meta.id) presetSel.value = meta.id;
    const baseEl = $('newProvBaseUrl');
    if (baseEl && !baseEl.value.trim() && meta.base_url) baseEl.value = meta.base_url;
    const idEl = $('newProvId');
    if (idEl && !state.newProvIdTouched && !idEl.value.trim()) idEl.value = meta.preset_id || meta.id;
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

  // 密钥状态与协议提示共用一行说明（字段说明不常驻，只在缺密钥时才占一行）。
  function paintAccessKeyState(clientKey) {
    const el = $('gwAccessKeyState');
    if (!el) return;
    if (!clientKey) {
      el.textContent = '尚未配置客户端密钥：去「系统设置 · 接入」生成一把，否则所有请求都会被 401';
      el.hidden = false;
      return;
    }
    el.hidden = true;
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
      box.innerHTML = '<div class="gw-model-empty">暂无可用模型：到「模型」添加并启用后，这里会列出 /v1/models 实际返回的全部模型 ID</div>';
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
    paintAccessKeyState(clientKey);
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
      paint('主客户端密钥还没配置：到「系统设置 · 接入」生成一把再来试。', 'err');
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


  function setupCreationForms() {
    // 「新增 X」不再用居中弹框：在列表顶部插入一个空白编辑器（create 模式），
    // 与编辑共用同一个构建函数。再次点击同一个按钮 = 收起。
    clk($('btnAddProvider'), async () => {
      if (state.creatingProvider) {
        closeCreateEditor('providers');
        return;
      }
      closeOtherCreateEditors('providers');
      state.creatingProvider = true;
      state.activeEditorKey = null;
      state.newProvIdTouched = false;
      state.newProvPresetTouched = false;
      renderProvidersList();
      // Force a reload so hub-side key/template changes since page load are visible.
      await loadVaultManifest({ force: true });
      if (($('newProvSource')?.value || '') === 'vault') renderVaultProviderPicks();
    });

    clk($('btnAddModel'), () => {
      if (state.creatingModel) {
        closeCreateEditor('models');
        return;
      }
      closeOtherCreateEditors('models');
      state.creatingModel = true;
      state.activeEditorKey = null;
      renderModelsList();
    });
  }

  // 「新增供应商」的空白编辑器 —— 与编辑共用一套字段语义的 create 模式。
  // 结构（组件 5 · .editor）：顶部文字链接（cURL 解析 / 来源切换）
  // → 基本字段（名称 / Base URL / API Key，两列网格）
  // → 「高级」折叠（ID / 协议 / 预设 / Key 标签 / RPM / UA / 配额 / 适配规则）
  // → 底部 .form-actions--split：左无删除（还没建），右「取消」+「保存供应商」。
  function buildProviderCreateEditor() {
    const wrap = ce('div');
    const apiTypeSel = `<select class="select" id="newProvApiType">
                <option value="auto">自动识别（推荐）</option>
                <option value="openai-completions">OpenAI 兼容 (/v1/chat/completions)</option>
                <option value="anthropic-messages">Anthropic 原生 (/v1/messages)</option>
                <option value="gemini">Gemini 兼容</option>
                <option value="ocr">原生 OCR 接口 (/v1/ocr)</option>
              </select>`;
    wrap.innerHTML = `
      <div class="section-bar">
        <span class="form-label">新增供应商</span>
        <div class="fields">
          <button type="button" class="text-link" id="btnToggleCurlPaste">从 cURL 解析</button>
          <button type="button" class="text-link" id="btnProvSourceToggle" hidden>改用中枢托管供应商</button>
          <button type="button" class="dialog-close" id="btnXProv" aria-label="关闭新增供应商">✕</button>
        </div>
        <input type="hidden" id="newProvSource" value="custom">
      </div>
      <div class="form-group mb-3 hidden" id="curlPasteWrap" hidden>
        <textarea class="textarea input--code" id="curlPasteInput" placeholder="粘贴 curl 命令，自动解析出 Base URL 与密钥"></textarea>
      </div>
      <div class="form-grid">
        ${fg('名称', `<input class="input" id="newProvName" placeholder="例如 DeepSeek 官方">`)}
        ${fg('Base URL', `<input class="input input--code" id="newProvBaseUrl" placeholder="https://api.example.com/v1">`)}
        ${fg('API Key', `<textarea class="textarea input--code privacy-mask" id="newProvApiKey" placeholder="sk-...&#10;sk-...（可多行 / 逗号分隔多把）"></textarea>`, 'newProvApiKeyGroup', 'form-group--full')}
      </div>
      <div class="form-group hidden mb-3" id="newProvVaultGroup" hidden>
        <label class="form-label">选择中枢托管供应商（仅列出本地缺失的）</label>
        <div class="probe-pills-wrap" id="newProvVaultPick"></div>
        <span class="text-xs text-muted" id="newProvVaultHint"></span>
      </div>
      <details class="headers-details mt-3">
        <summary class="form-label">高级（供应商 ID / 协议 / 预设 / 限流）</summary>
        <div class="form-grid mt-2">
          ${fg('供应商 ID', `<input class="input input--code" id="newProvId" placeholder="由名称自动生成">`)}
          ${fg('上游协议', `<div class="input-row">${apiTypeSel}<button class="btn" id="btnDetectProvider" type="button">探测协议</button></div>`)}
          ${fg('预设', `<select class="select" id="newProvPreset"></select><span class="text-xs text-muted hidden" id="newProvPresetHint" hidden></span>`)}
          ${fg('Key 标签前缀', `<input class="input" id="newProvKeyAlias" placeholder="pool-01（留空自动递增）">`, 'newProvKeyAliasGroup')}
          ${fg('RPM 上限', `<input class="input tabular" id="newProvRpm" type="number" placeholder="0 = 不限">`)}
          ${fg('每日重置时间', `<input class="input" id="newProvReset" placeholder="00:00+08:00">`)}
          ${fg('客户端 UA', `<label class="form-label form-label--check"><input type="checkbox" id="newProvHideUa"><span>隐藏客户端 User-Agent</span></label>`)}
          ${fg('声明式适配规则 (JSON)', `<textarea class="textarea textarea--json" id="newProvRules" placeholder='{}'></textarea>`, '', 'form-group--full')}
        </div>
      </details>
      <div class="form-actions form-actions--split">
        <div class="form-actions-group"></div>
        <div class="form-actions-group">
          <button class="btn" id="btnCancelAddProvider" type="button">取消</button>
          <button class="btn btn--primary" id="btnConfirmAddProvider" type="button">保存供应商</button>
        </div>
      </div>
    `;
    // 接线由调用方在元素挂进 DOM 之后做（wireProviderCreateEditor）——
    // applyNewProvSourceMode() 也在那里调：它用全局 $() 找控件，元素没接上时找不到。
    return wrap;
  }

  // --- 供应商「新增」编辑器（create 模式）的行为 ---
  // 元素在 create 模式下是动态生成的，接线必须发生在插入 DOM 之后。
  function wireProviderCreateEditor() {
    // 供应商来源：自定义 ↔ 中枢托管（Hub 端没有中枢托管这一路）。
    const srcToggle = $('btnProvSourceToggle');
    if (srcToggle) {
      clk(srcToggle, () => {
        const srcEl = $('newProvSource');
        if (!srcEl) return;
        srcEl.value = (srcEl.value || 'custom') === 'vault' ? 'custom' : 'vault';
        applyNewProvSourceMode();
        if (srcEl.value === 'vault') renderVaultProviderPicks();
      });
    }
    // 初始态按当前角色收敛（Hub 隐藏「中枢托管」）。
    applyNewProvSourceMode();
    populatePresetDropdown($('newProvPreset'));

    $('newProvName')?.addEventListener('input', () => {
      applyPresetAutoMatch();
      // 供应商 ID 由名称自动生成：只在操作者没手动改过 ID 时跟随。
      const idEl = $('newProvId');
      if (idEl && !state.newProvIdTouched) {
        const meta = matchPresetMeta($('newProvName')?.value);
        // 名称框输入时把能生成的 ID 先填进「高级」里的 ID 框，让想改的人有东西可改；
        // 纯中文名生成不出来就留空，保存时由 autoProviderId() 兜底。
        idEl.value = (meta && (meta.preset_id || meta.id)) || providerIdFromName($('newProvName')?.value);
      }
    });
    $('newProvId')?.addEventListener('input', () => {
      state.newProvIdTouched = true;
      applyPresetAutoMatch();
    });
    $('newProvPreset')?.addEventListener('change', () => {
      state.newProvPresetTouched = true;
      applyPresetAutoMatch();
    });

    // cURL 粘贴：解析出 Base URL / 密钥 / 协议。
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

    // 探测协议（高级区）：自动识别失败时的手动兜底。
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

    const cancelCreate = () => {
      state.creatingProvider = false;
      renderProvidersList();
    };
    clk($('btnCancelAddProvider'), cancelCreate);
    clk($('btnXProv'), cancelCreate);

    clk($('btnConfirmAddProvider'), async () => {
      const sourceVal = $('newProvSource')?.value || 'custom';

      // Vault on-demand path: one-shot fetch (rules + all keys). The gateway
      // merges the hub response server-side, so we only refresh afterwards.
      // 数据表里每行的「添加」直接拉取（renderVaultProviderPicks）——不再依赖
      // 先选中一枚胶囊，这里兜底提示即可。
      if (sourceVal === 'vault') {
        const pickId = state.addProvVaultPick;
        if (!pickId) return toast('请在上方列表里点「添加」拉取中枢托管供应商', 'warn');
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
            state.creatingProvider = false;
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
      const keyAlias = ($('newProvKeyAlias')?.value || '').trim() || 'k1';
      const apiKey = ($('newProvApiKey')?.value || '').trim();
      const matchedMeta = matchPresetMeta(name) || matchPresetMeta(id);
      const resolvedPresetId = matchedMeta
        ? (matchedMeta.preset_id || matchedMeta.id)
        : (PRESETS_META[id]?.preset_id || '');
      // 供应商 ID 自动生成：手填的「高级」ID 优先，其次预设，最后由名称生成
      // （纯中文名会退到随机短 ID）。ID 框收在「高级」里，默认看不到，
      // 所以绝不能因为没填而拦住保存。手填的撞上现有供应商时照旧提示去改，
      // 不自动改名 —— 撞上往往是想编辑已有供应商，擅自改名只会多出一个。
      const existing = (state.config && state.config.providers) || {};
      if (!id) id = resolvedPresetId || autoProviderId(name);
      if (existing[id]) return toast(`供应商 ID「${id}」已存在，请在「高级」里换一个`, 'warn');

      if (!name) return toast('请输入供应商名称', 'warn');
      if (!baseUrl) return toast('请输入 Base URL', 'warn');
      if (!apiKey) return toast('请输入 API Key', 'warn');

      // 协议默认自动识别：只在操作者没有手动选过时探测。
      const protoSel = $('newProvApiType');
      const protoRaw = (protoSel?.value || 'auto');
      const apiType = protoRaw === 'auto'
        ? await detectProviderProtocol(baseUrl, apiKey)
        : normalizeApiType(protoRaw);

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
      // 「高级」里的可选字段：留空就不写进配置（与旧行为一致）。
      const rpm = Number(($('newProvRpm')?.value || '').trim());
      if (rpm > 0) newProv.rpm_per_key = rpm;
      if ($('newProvHideUa')?.checked) newProv.hide_client_name = true;
      const resetAt = ($('newProvReset')?.value || '').trim();
      if (resetAt) newProv.quota_reset_at = resetAt;
      const rawRules = ($('newProvRules')?.value || '').trim();
      if (rawRules) {
        try {
          newProv.adapter_rules = JSON.parse(rawRules);
        } catch (err) {
          return toast(`adapter_rules JSON 格式有误: ${err.message}`, 'err');
        }
      }
      state.config.providers[id] = newProv;
      state.activeEditorKey = `p_${id}`;
      state.creatingProvider = false;
      state.newProvIdTouched = false;
      await persistConfig('供应商创建成功');
    });
  }



  // 某个页签的列表重绘：state 与 DOM 必须同步 —— state 标志清了但 DOM 没清
  // = 僵尸编辑器（Esc 判 state 关不掉，页头按钮文案停在「收起」）。
  function renderTabList(tab) {
    if (tab === 'providers') renderProvidersList();
    else if (tab === 'models') renderModelsList();
    else if (tab === 'nodes') renderNodesList();
    else if (tab === 'activity') renderRecentRequests();
  }

  // create 编辑器（列表顶部的空白 .editor）归哪个页签管：state 标志 → 页签。
  // Esc 要按「归属页签」重绘列表，不能按当前页签 —— create 编辑器可以属于
  // 当前页签之外的页签（切走再切回它还在，页头按钮仍是「收起」）。
  const CREATE_EDITOR_FLAGS = { providers: 'creatingProvider', models: 'creatingModel', nodes: 'creatingNode' };

  function anyCreateEditorTab() {
    for (const tab of Object.keys(CREATE_EDITOR_FLAGS)) {
      if (state[CREATE_EDITOR_FLAGS[tab]]) return tab;
    }
    return null;
  }

  // 关掉 create 编辑器：state 清零后必须重绘它所属的列表，否则 DOM 上留下僵尸。
  function closeCreateEditor(tab) {
    const t = tab || anyCreateEditorTab();
    if (!t) return false;
    const flag = CREATE_EDITOR_FLAGS[t];
    if (!flag || !state[flag]) return false;
    state[flag] = false;
    renderTabList(t);
    return true;
  }

  // 开新的 create 编辑器前，先关掉别处还开着的（同一时刻只有一个编辑器）。
  function closeOtherCreateEditors(keepTab) {
    for (const tab of Object.keys(CREATE_EDITOR_FLAGS)) {
      if (tab !== keepTab) closeCreateEditor(tab);
    }
  }

  function switchTab(tab) {
    stopOAuthPolling();
    // create 编辑器（列表顶部的空白 .editor）跟着它所属的页签走：切走再切回
    // 它还在、草稿也还在、页头按钮仍是「收起」—— state 与 DOM 一致，Esc 也能关。
    // 所以这里**不**清 creatingProvider / creatingModel / creatingNode。
    // 「点行展开」的编辑器随页签切换关闭（展开态的草稿不跨页签保留）——
    // 但 state 清了，DOM 上那一行也得摘掉，否则留下僵尸编辑器。
    const leaving = state.activeTab;
    const hadExpanded = Boolean(state.activeEditorKey || state.nodeInstallFor);
    state.activeTab = tab;
    state.activeEditorKey = null;
    state.nodeInstallFor = null;
    // state 清了，DOM 就必须跟上（否则又留下僵尸编辑器）。
    // leaving !== tab：切页签，孤儿在「离开的那个页签」里；
    // leaving === tab：点当前页签的导航，孤儿就在这个页签里。
    if (hadExpanded && leaving) renderTabList(leaving);

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
      if (window.HOST.capabilities.usageAndTraces) {
        loadActivityData();
      }
    }

    if (tab === 'nodes') {
      // 节点页自己就是 Hub 的落地页：进来就拉一次最新节点。
      loadNodesData();
    }

    if (tab === 'access') {
      // Re-read on every visit: routes and keys change on other tabs.
      renderAccessView();
    }

    if (tab === 'providers' && !isHubMode() && window.HOST.capabilities.vaultClient) {
      loadVaultManifest().then((manifest) => {
        const srcSel = $('newProvSource');
        if (manifest && srcSel && srcSel.value === 'vault' && state.creatingProvider) {
          renderVaultProviderPicks();
        }
      });
    }
  }

  // 给缺 preset_id 的供应商按规则 A 绑定一次预设并写回配置。
  // 为什么在控制台做而不是中枢读路径：中枢的每个文件都算一个边缘函数，
  // 加任何代码都会推高部署脚本体积（线上曾因此全站 545）；而控制台本来就有
  // 完整的预设库与规则 A 实现，绑定结果仍然是写进中枢 KV 的权威数据。
  async function bindMissingPresets() {
    const providers = state.config && state.config.providers;
    if (!providers || typeof providers !== 'object') return;
    const bound = [];
    for (const [pId, p] of Object.entries(providers)) {
      if (!p || typeof p !== 'object') continue;
      const cur = String(p.preset_id || '').trim();
      if (cur) continue; // 已绑定，或显式 'custom'
      const meta = matchPresetRules({ id: pId, name: p.name, base_url: p.base_url });
      if (!meta) continue;
      const id = String(meta.preset_id || meta.id || '').trim();
      if (!id) continue;
      p.preset_id = id;
      bound.push(`${pId} → ${id}`);
    }
    if (bound.length === 0) return;
    const ok = await persistConfig(`已自动绑定 ${bound.length} 个供应商的预设：${bound.join('，')}`);
    if (!ok) return; // 冲突等失败：下次加载再试，不阻塞界面
    renderProvidersList();
  }

  async function loadData() {
    try {
      const cfgResp = await window.HOST.getConfig();
      if (cfgResp && (cfgResp.ok || cfgResp.providers || cfgResp._version !== undefined)) {
        state.config = cfgResp;
        const verEl = $('configVersionDisplay');
        if (verEl) verEl.textContent = `v${cfgResp._version || 1}`;

        renderProvidersList();
        renderModelsList();
        renderSettingsView();
        // 预设绑定落盘：中枢（2.14.0 及更早）不会在读取时自动绑定，而绑定是中枢
        // 权威的元数据 —— 在这里补上并写回一次，之后列表行、Full 的「可更新」判断
        // 都能拿到 preset_id。只在缺绑定且有匹配时触发，写完就不会再跑。
        await bindMissingPresets();
      }

      if (window.HOST.capabilities.nodeManager) {
        await loadNodesData();
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

      // Full 端：preset-status 一次查询 → 列表行「可更新」标记 + 设置页同步行说明。
      if (!isHubMode() && window.HOST.capabilities.kbModels) {
        refreshPresetUpdateFlags();
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

      if (window.HOST.kind === 'hub' && state.activeTab === 'nodes') {
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
        if (window.HOST.kind === 'hub' && state.activeTab === 'nodes') {
          renderHubOverview();
        }
      }
    } catch (e) {
      toast(`节点加载失败: ${e.message}`, 'err');
    }
  }


  // 中枢概览（节点页底部折叠区）：下发规模 KPI + 全部节点的模型使用分布。
  // 「活跃 VM 节点」信息不再单独成表 —— 节点列表本身承担（状态点 + 最近同步时间）。
  function renderHubOverview() {
    const kpiGrid = $('hubKpiGrid');
    const usageBody = $('hubModelUsageBody');
    if (!kpiGrid || !usageBody) return;

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
      <div class="metric-box">
        <div class="metric-box-label">${eh(item.label)}</div>
        <div class="metric-box-val tabular">${eh(item.value)}</div>
        <div class="text-xs text-muted">${eh(item.sub)}</div>
      </div>
    `).join('');

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

  // Hub 端「一键探活全部 Key」：逐把跑探活（不消耗推理额度）。
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
          await verifyOneKey(pId, p, k, k.label || k.id || `key-${i}`, true);
          if (k.last_ok) ok++;
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
  // 列表行（组件 3 · .list > .row）：一行只允许 名称 / 一行次要信息 / 一个状态 /
  // 至多一个计数。适配版本、归属、正常数等次要标签整体挪进编辑器（点开行即见），
  // 列表不再堆 pill。

  // Full 端：问一次 preset-status，把 has_update 的供应商 id 记进 state（列表行
  // 「可更新」弱警告用）。静默失败：拿不到就不标，绝不阻塞列表本身。
  async function refreshPresetUpdateFlags() {
    if (isHubMode() || typeof window.HOST.getPresetStatus !== 'function') return;
    try {
      const res = await window.HOST.getPresetStatus();
      const flags = {};
      if (res && res.ok && Array.isArray(res.providers)) {
        for (const row of res.providers) {
          if (row && row.id && row.has_update) flags[row.id] = String(row.latest_version || '') || true;
        }
      }
      state.presetUpdateFlags = flags;
      renderProvidersList();
    } catch (_) {}
  }

  function renderProvidersList() {
    const container = $('providersList');
    if (!container) return;
    // 列表即将重建（innerHTML 替换）：挂在旧 DOM 上的菜单浮层会变成死元素，
    // 先关掉，别让它们留在 openMenus 里干扰 Esc。
    closeAllMenus();
    mountProviderAlphaBar();
    // create 编辑器的草稿必须在 innerHTML 替换**之前**抓 —— 旧 DOM 一被清空，
    // 控件就找不到了，抓到的永远是空值（列表因保存 / 探活重绘时草稿被冲掉）。
    const createDraft = state.creatingProvider ? captureProviderCreateDraft() : null;
    container.innerHTML = '';

    // 页面头的「新增供应商」按钮与 create 编辑器互斥：编辑器开着时它变成
    // 「收起」（普通按钮），避免同一屏出现两个主按钮。
    const addBtn = $('btnAddProvider');
    if (addBtn) {
      addBtn.classList.toggle('btn--primary', !state.creatingProvider);
      addBtn.textContent = state.creatingProvider ? '收起' : '新增供应商';
    }

    const providers = (state.config && state.config.providers) || {};
    const q = state.providerQuery || '';
    const f = state.providerFilter || 'all';

    const pKeys = Object.keys(providers).sort().filter((pId) => {
      const p = providers[pId] || {};
      if (q) {
        const hay = `${pId} ${p.name || ''} ${p.base_url || ''} ${p.preset_id || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // A–Z 筛选与 providerBucketOf() 共用一个分桶规则，计数与过滤永不打架。
      if (f !== 'all' && providerBucketOf(p, pId) !== f) return false;
      return true;
    });

    // 「新增供应商」= 在列表顶部插入一个空白编辑器（create 模式）。
    // 列表为空时也要有它 —— 否则空状态里点「新增供应商」什么都不会发生。
    if (state.creatingProvider) {
      // 列表可能因为别的原因重绘（保存 / 探活后都会重绘）：把已填的草稿带过去。
      const draft = createDraft;
      const createEditor = ce('div');
      createEditor.className = 'editor';
      createEditor.id = 'providerCreateEditor';
      const wrap = buildProviderCreateEditor();
      createEditor.appendChild(wrap);
      container.appendChild(createEditor);
      // 先挂进 DOM 再接线：wireProviderCreateEditor() 用全局 $() 找控件。
      wireProviderCreateEditor();
      restoreProviderCreateDraft(draft);
    }

    if (pKeys.length === 0) {
      const filtered = Boolean(q) || f !== 'all';
      const empty = ce('div');
      empty.className = 'card-pad';
      const msg = ce('p');
      msg.className = 'text-muted';
      msg.textContent = filtered
        ? '没有符合筛选条件的供应商'
        : '还没有供应商：填一个上游 API 地址与密钥，网关就能转发';
      empty.appendChild(msg);
      if (!filtered && !state.creatingProvider) {
        const btn = ce('button');
        btn.type = 'button';
        btn.className = 'btn btn--primary mt-3';
        btn.textContent = '新增供应商';
        clk(btn, () => {
          closeOtherCreateEditors('providers');
          state.creatingProvider = true;
          state.activeEditorKey = null;
          state.newProvIdTouched = false;
          renderProvidersList();
        });
        empty.appendChild(btn);
      }
      container.appendChild(empty);
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

      const isExpanded = state.activeEditorKey === `p_${pId}`;

      const row = ce('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      // 左：名称 + 一行次要信息（ID · 预设 · 来源 · 地址），左边缘永远对齐 ——
      // 不放首字母头像，状态也不放在最左（状态词长短不一，放左边会把整列名称推得参差不齐）。
      // 次要信息格式（docs §供应商行）：ID · 预设 amd v2026.10.19 · 中枢 · 地址；
      // 没绑预设显示「自定义」；Full 上 preset-status 报 has_update 时加弱化警告色「可更新」。
      const who = ce('div');
      who.className = 'who';
      const subBits = [];
      if (p.name && p.name !== pId) subBits.push(pId);
      const rowMeta = resolveProviderPresetMeta(p, pId);
      if (rowMeta) {
        // 版本显示供应商自己记录的 preset_version（它实际在用的规则版本），
        // 没记录时才退到预设库版本；有新版时「可更新」里写目标版本。
        const curVer = String(p.preset_version || rowMeta.version || '');
        subBits.push(`预设 ${eh(rowMeta.preset_id || rowMeta.id)}${curVer ? ` v${eh(curVer)}` : ''}`);
      } else {
        subBits.push('自定义');
      }
      // 来源词：中枢托管 / 中枢 / 本地。本地自建允许不写（自定义已能区分），但
      // vault 供应商一定要标出来。
      if (!isHubMode() && p.origin === 'vault') subBits.push('中枢');
      else if (isHubMode()) subBits.push('中枢托管');
      subBits.push(p.base_url || '未配置 Base URL');
      who.innerHTML = `
        <div class="name"><span>${eh(p.name || pId)}</span></div>
        <div class="sub">${subBits.join(' · ')}${state.presetUpdateFlags[pId] ? ` <span class="pill pill--warn">可更新${typeof state.presetUpdateFlags[pId] === 'string' ? ` → v${eh(state.presetUpdateFlags[pId])}` : ''}</span>` : ''}</div>
      `;

      // 右：状态（.dot + 一个词）· Key 数，固定宽度右对齐，几行之间上下对齐。
      const st = providerStatusWord(p, keyCount, okCount, failCount, busyCount, waitCount);
      const fields = ce('div');
      fields.className = 'fields';
      fields.innerHTML = `
        <span class="row-status"><span class="dot ${st.dot}"></span><span class="text-xs text-muted">${eh(st.word)}</span></span>
        <span class="row-count text-xs text-muted">${keyCount} 把 Key</span>
        <span class="caret">▾</span>
      `;

      row.appendChild(who);
      row.appendChild(fields);

      clk(row, (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `p_${pId}`;
        // 点行展开编辑时收起 create 编辑器（同一时刻只有一个编辑器）。
        state.creatingProvider = false;
        renderProvidersList();
      });


      container.appendChild(row);

      if (isExpanded) {
        const editor = ce('div');
        editor.className = 'editor';
        const wrap = buildProviderEditor(pId, p);
        editor.appendChild(wrap);
        container.appendChild(editor);
        wireProviderEditor(pId, p, wrap);
      }
    }
  }

  // 供应商状态：一个词 + 一个点。综合「停用 / 无 Key / Key 健康 / 运行中」，
  // 列表行只允许一个状态，所以运行中的并发数并进这个词里。
  function providerStatusWord(p, keyCount, okCount, failCount, busyCount, waitCount) {
    if (p.enabled === false) return { word: '停用', dot: 'dot--warn' };
    if (!keyCount) return { word: '无 Key', dot: 'dot--err' };
    if (failCount > 0 && okCount === 0) return { word: '异常', dot: 'dot--err' };
    if (busyCount > 0) return { word: `运行中 ${busyCount}${waitCount ? ` (排队 ${waitCount})` : ''}`, dot: failCount > 0 ? 'dot--warn' : 'dot--ok' };
    if (failCount > 0) return { word: '部分异常', dot: 'dot--warn' };
    if (okCount > 0) return { word: '正常', dot: 'dot--ok' };
    return { word: '未测', dot: 'dot--warn' };
  }

  // 供应商 ID 由名称自动生成（保存后不可再改，所以先在「高级」里生成好）。
  // 名称里有 ASCII 片段才用得上（「DeepSeek 官方」→ deepseek）；
  // 纯中文名没有 ASCII 片段，返回空串，由 autoProviderId() 兜底。
  function providerIdFromName(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  // ID 只是内部标识，不需要可读。纯中文名（如「验收供应商」）或者生成的 ID
  // 已被占用时，退到一个不与现有供应商冲突的随机短 ID，而不是拦住保存 ——
  // ID 框收在「高级」里，操作者默认根本看不到它。
  function autoProviderId(name) {
    const providers = (state.config && state.config.providers) || {};
    const fromName = providerIdFromName(name);
    if (fromName && !providers[fromName]) return fromName;
    for (let i = 0; i < 50; i++) {
      const id = `p-${generateRandomAlphaNum(6).toLowerCase()}`;
      if (!providers[id]) return id;
    }
    return `p-${generateRandomAlphaNum(12).toLowerCase()}`;
  }

  // 预设下拉：运行时从 PRESETS_META 渲染（HTML 里不硬编码 <option>）。
  function populatePresetDropdown(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    const none = ce('option');
    none.value = '';
    none.textContent = '（不绑定预设）';
    sel.appendChild(none);
    for (const meta of Object.values(PRESETS_META)) {
      const opt = ce('option');
      opt.value = meta.id;
      opt.textContent = meta.label;
      sel.appendChild(opt);
    }
  }

  // 协议默认自动识别：探测上游支持的第一种协议；探测不通就回落到 OpenAI 兼容
  // （与旧行为一致，不会因为自动识别失败而建不出供应商）。
  async function detectProviderProtocol(baseUrl, apiKey) {
    try {
      const res = isHubMode() ? null : await window.HOST.detectProvider({ base_url: baseUrl, api_key: apiKey });
      if (res && res.ok) {
        const protos = Array.isArray(res.protocols) ? res.protocols : (res.protocol ? [res.protocol] : []);
        const first = protos[0] || '';
        const mapped = first === 'openai' ? 'openai-completions'
          : first === 'anthropic' ? 'anthropic-messages'
            : first;
        if (['openai-completions', 'anthropic-messages', 'gemini', 'ocr'].includes(mapped)) return mapped;
      }
    } catch (_) {}
    return 'openai-completions';
  }

  // create 编辑器的草稿：列表可能因为别的原因重绘（保存 / 探活后都会重绘），
  // 把已填的值带过去，别让操作者刚敲的字被冲掉。
  const PROVIDER_CREATE_FIELDS = 'newProvName newProvBaseUrl newProvApiKey newProvId newProvApiType newProvPreset newProvKeyAlias newProvRpm newProvReset newProvRules newProvSource'.split(' ');

  function captureProviderCreateDraft() {
    const draft = {};
    for (const id of PROVIDER_CREATE_FIELDS) {
      const el = $(id);
      if (el) draft[id] = el.value;
    }
    return draft;
  }

  function restoreProviderCreateDraft(draft) {
    if (!draft) return;
    for (const id of PROVIDER_CREATE_FIELDS) {
      const el = $(id);
      if (el && typeof draft[id] === 'string') el.value = draft[id];
    }
    applyNewProvSourceMode();
    applyPresetAutoMatch();
  }

  // 供应商编辑器（组件 5 · .editor）：结构固定为
  // 基本字段（≤4，两列网格）→ Key 子表 → 「高级」折叠 → 底部 .form-actions--split。
  // 只负责出结构，所有事件在 wireProviderEditor() 里接。
  function buildProviderEditor(pId, p) {
    const wrap = ce('div');
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
    const versionText = presetVersionText(presetMetaForProvider(p, String(p?.preset_id || '').trim()))
      || (p.rule_hash ? `中枢规则指纹 ${String(p.rule_hash).slice(0, 8)}` : '自定义（无适配文件）');
    const presetVersionHint = `<span class="text-xs text-muted mt-1">${eh(versionText)}</span>`;

    const lockAttr = isVaultProv ? ' disabled' : '';
    // Two independent toggles. Each one names an upstream endpoint the gateway
    // will route to; having both enabled is the common case for vendors that
    // ship OpenAI and Anthropic front doors off the same account. "默认" pulls
    // the URL from the preset; "自定义" lets the operator override it.
    const meta = presetMetaForProvider(p, p.preset_id);
    const baseDefault = meta?.base_url || '';
    const antDefault = meta?.anthropic_base_url || '';
    const openaiEnabled = Boolean(p.base_url) || curApiType === 'openai-completions' || curApiType === 'gemini';
    const anthropicEnabled = Boolean(p.anthropic_base_url) || curApiType === 'anthropic-messages';
    const openaiRow = `<label class="form-label form-label--check"><input type="checkbox" id="ed_p_openai_on_${pId}" ${openaiEnabled ? 'checked' : ''}${lockAttr}><span>OpenAI 兼容端点（/v1/chat/completions）</span></label>`
      + `<div class="input-row mt-1"><input class="input input--code" id="ed_p_base_${pId}" value="${eh(p.base_url || baseDefault)}" placeholder="${eh(baseDefault || 'https://api.example.com/v1')}" ${openaiEnabled ? '' : 'disabled'}${lockAttr}><button class="btn btn--sm" id="btn_base_default_${pId}" type="button" title="重置为预设默认" ${baseDefault ? '' : 'disabled'}>默认</button><button class="btn" id="btn_detect_ed_${pId}" type="button" ${isHubMode() || isVaultProv ? 'hidden' : ''}>探测协议</button></div>`;
    const anthropicRow = `<label class="form-label form-label--check"><input type="checkbox" id="ed_p_ant_on_${pId}" ${anthropicEnabled ? 'checked' : ''}${lockAttr}><span>Anthropic Messages 端点（/v1/messages）</span></label>`
      + `<div class="input-row mt-1"><input class="input input--code" id="ed_p_ant_${pId}" value="${eh(p.anthropic_base_url || antDefault)}" placeholder="${eh(antDefault || 'https://api.example.com/anthropic')}" ${anthropicEnabled ? '' : 'disabled'}${lockAttr}><button class="btn btn--sm" id="btn_ant_default_${pId}" type="button" title="重置为预设默认" ${antDefault ? '' : 'disabled'}>默认</button></div>`;

    const vaultNotice = isVaultProv
      ? `<div class="notice-strip mb-3"><span>中枢托管供应商：名称、URL、协议与适配规则由中枢统一管理（只读）。如需修改请在中枢操作后点击「重新拉取」。</span></div>${ruleHashDrift ? '<div class="notice-strip notice-strip--warn mb-3"><span>中枢规则已更新：本地适配规则与中枢清单不一致，请点击「重新拉取」同步。</span></div>' : ''}`
      : '';
    // Key 添加行：中枢托管供应商也有本地「添加 Key」行（约定 C：中枢托管允许本地
    // Key 与中枢 Key 共存），再加一条「从中枢补拉缺失标签」；本地供应商只有前者。
    const vaultKeyPickHtml = isVaultProv
      ? `<div class="input-row mt-2"><input class="input" id="new_key_lbl_${pId}" placeholder="Key 标签 (如 pool-01，留空自动递增)"><input class="input input--code privacy-mask" id="new_key_val_${pId}" placeholder="粘贴完整 API Key（支持逗号分隔多把）"><button class="btn" id="btn_add_key_${pId}" type="button">添加 Key</button></div><div class="section-bar mt-3"><span class="form-label">从中枢添加 Key（本地缺失的标签）</span><div class="fields"><button class="btn btn--sm" id="btn_vault_add_keys_${pId}" type="button">从中枢添加</button></div></div><div class="probe-pills-wrap mb-2 hidden" id="vault_keys_pick_${pId}" hidden></div><div class="form-actions hidden" id="vault_keys_actions_${pId}" hidden><button class="btn btn--sm btn--primary" id="btn_vault_fetch_keys_${pId}" type="button">拉取所选 Key</button></div>`
      : `<div class="input-row mt-2"><input class="input" id="new_key_lbl_${pId}" placeholder="Key 标签 (如 pool-01，留空自动递增)"><input class="input input--code privacy-mask" id="new_key_val_${pId}" placeholder="粘贴完整 API Key（支持逗号分隔多把）"><button class="btn" id="btn_add_key_${pId}" type="button">添加 Key</button></div>`;
    const editorActionsHtml = `<div class="form-actions form-actions--split"><div class="form-actions-group"><button class="btn btn--danger" id="btn_del_prov_${pId}" type="button">删除供应商</button>${isVaultProv ? `<button class="btn" id="btn_refetch_prov_${pId}" type="button">重新拉取</button>` : ''}</div><div class="form-actions-group"><button class="btn" id="btn_cancel_prov_${pId}" type="button">取消</button>${isVaultProv ? '' : `<button class="btn btn--primary" id="btn_save_prov_${pId}" type="button">保存</button>`}</div></div>`;

    // Preset binding：Full 节点只读（网关按随包预设库解析，手填会漂移），用徽章
    // 展示；Hub 是预设的权威端，高级区允许改绑定（各预设 + 「自定义（不绑定）」
    // = preset_id "custom"，约定 A 规则 1）。中枢托管供应商在 Full 端同样只读。
    const hubPresetEditable = isHubMode() && !isVaultProv;
    const presetReadOnly = `<span class="pill">${eh(p.preset_id || '（未绑定预设）')}</span>${presetVersionHint}`;
    const presetBindingId = `ed_p_preset_${pId}`;
    let presetBindingHtml = presetReadOnly;
    if (hubPresetEditable) {
      const cur = String(p.preset_id || '').trim() || 'custom';
      const opts = ['<option value="custom">自定义（不绑定）</option>']
        .concat(Object.values(PRESETS_META).map((m2) => `<option value="${eh(m2.id)}"${cur === m2.id ? ' selected' : ''}>${eh(m2.label)}</option>`));
      presetBindingHtml = `<select class="select" id="${presetBindingId}">${opts.join('')}</select>${presetVersionHint}`;
    }

    wrap.innerHTML = `<div class="form-grid">${[
      fg('名称', `<input class="input" id="ed_p_name_${pId}" value="${eh(p.name || pId)}"${lockAttr}>`),
      fg('整体 RPM 上限', `<input class="input" id="ed_p_rpm_${pId}" type="number" value="${p.rpm_per_key || ''}" placeholder="0 = 不限"${lockAttr}>`, '', '', '所有 Key 共享的每分钟请求上限；0 = 不限'),
      `<div class="form-group form-group--full"><label class="form-label">请求地址（可同时启用两种，客户端按入口调用）</label><div class="mt-1">${openaiRow}</div><div class="mt-2">${anthropicRow}</div></div>`,
    ].join('')}</div><div class="section-bar mt-4"><span class="form-label">API 密钥池 (${keys.length})</span><div class="fields"><button class="btn btn--sm" id="btn_batch_test_keys_${pId}" type="button" title="用每把 Key 真发一句「你好」">${isHubMode() ? '逐把测 Key' : '一键测全部 Key'}</button><button class="btn btn--sm" id="btn_oauth_start_${pId}" type="button" ${showOAuth ? '' : 'hidden'}>OAuth 扫码登录</button></div></div><div class="snippet-box hidden mb-3" id="oauth_box_${pId}" hidden><div class="snippet-header"><span class="form-label">MiniMax OAuth 设备授权码:</span><span class="pill pill--amber" id="oauth_status_${pId}">等待扫码...</span></div><div class="text-sm mt-1">请点击访问：<a id="oauth_link_${pId}" target="_blank" rel="noopener noreferrer" class="tabular"></a> 并在页面中输入验证码：<strong class="tabular" id="oauth_code_${pId}"></strong></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>启用</th><th>标签</th><th>Key</th><th>状态</th><th>权重</th><th>操作</th></tr></thead><tbody id="p_keys_tbody_${pId}"></tbody></table></div>${vaultKeyPickHtml}<details class="headers-details mt-3"><summary class="form-label">高级（供应商 ID / 预设 / 客户端 UA / 配额重置 / 适配规则）</summary><div class="form-grid mt-2">${[
      fg('供应商 ID（保存后不可改）', `<input class="input input--code" value="${eh(pId)}" readonly>`),
      fg('预设', presetBindingHtml),
      `<div class="form-group"><label class="form-label form-label--check"><input type="checkbox" id="ed_p_hide_ua_${pId}" ${p.hide_client_name ? 'checked' : ''}${lockAttr}><span>隐藏客户端 User-Agent</span></label></div>`,
      // 空值就是空值：不在输入框里预填默认时刻。预填会被 syncDraftFields() 写进
      // 配置，于是一次普通 429 就把整个供应商的 Key 冷却到次日 0 点（2026-11-27 实测
      // 7h12m，24 请求里 12 个 502 no_candidate）。留空 = 不做按日重置。
      fg('每日重置时间 (quota_reset_at)', `<input class="input" id="ed_p_reset_${pId}" value="${eh(p.quota_reset_at || '')}" placeholder="如 00:00+08:00（留空 = 不按日重置）">`, '', '', '余额耗尽（402 或 429 明确说余额不足）时把 Key 冷却到这个时刻；普通限流不受影响'),
      fg('声明式适配规则 (adapter_rules JSON)', `<textarea class="textarea textarea--json" id="ed_p_rules_${pId}" placeholder='{"stream_only":false}'${lockAttr}>${eh(adapterText)}</textarea>`, '', '', '声明式适配规则 JSON；中枢托管的由中枢统一维护（只读）'),
    ].join('')}</div></details>${vaultNotice}${editorActionsHtml}`;

    const tbody = wrap.querySelector(`#p_keys_tbody_${pId}`);
    if (tbody) {
      if (!tbody.dataset.revealWired) {
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
      if (!tbody.dataset.cdWired) {
        tbody.dataset.cdWired = '1';
        tbody.addEventListener('click', (ev) => {
          const btn = ev.target instanceof Element ? ev.target.closest('.btn_clear_k_cd_inline') : null;
          if (!btn || !btn.dataset.cdTarget) return;
          ev.stopPropagation();
          clearSingleCooldown(btn.dataset.cdTarget);
        });
      }
      keys.forEach((k, idx) => tbody.appendChild(buildProviderKeyRow(pId, p, k, idx)));
    }
    return wrap;
  }

  // Key 行（组件 4 · .data-table）：启用 / 标签 / Key / 状态 / 操作。
  // 状态 = .dot + 一个词；「校验 / 解除冷却 / 删除」收进「⋯」菜单。
  function buildProviderKeyRow(pId, p, k, idx) {
    const tr = ce('tr');
    const keyLabel = k.label || k.id || `key-${idx}`;
    const cdInfo = findKeyCooldown(pId, k, idx);
    const cooldownSec = cdInfo.sec;
    const cdTarget = cdInfo.target;
    // 归属只看 **Key 自身的 origin**（缺失时回落到供应商 origin）：中枢托管供应商
    // 允许本地 Key 与中枢 Key 共存（约定 C），按供应商 origin 一刀切会把本地 Key
    // 误锁成「中枢」只读。Hub 控制台的 Key 一律是中枢的（且可编辑，Hub 是权威）。
    const keyOrigin = String(k.origin || '').trim().toLowerCase()
      || (isHubMode() || p.origin === 'vault' ? 'vault' : 'local');
    const vaultKey = !isHubMode() && keyOrigin === 'vault';
    const keyIsVault = isHubMode() || keyOrigin === 'vault';

    const statusHtml = keyStatusCellHtml(k, cooldownSec, cdTarget);

    tr.innerHTML = `
      <td><input type="checkbox" class="k_enable_cb" data-idx="${idx}" ${k.enabled !== false ? 'checked' : ''} ${vaultKey ? 'disabled title="中枢下发的 Key 不可在节点修改"' : ''}></td>
      <td><div class="fields"><strong>${eh(keyLabel)}</strong>${k.auth_type === 'oauth_device' ? ' <span class="pill pill--accent">OAuth</span>' : ''}<span class="text-xs text-muted">${keyIsVault ? '中枢' : '本地'}</span></div></td>
      <td>${renderKeyCell(k, vaultKey, idx)}</td>
      <td class="k-status-cell">${statusHtml}</td>
      <td><input class="input input--compact tabular k_weight_in" type="number" min="1" value="${k.weight || 1}" title="权重：数值越大分到的请求越多" ${vaultKey ? 'disabled' : ''}></td>
      <td>
        <div class="fields">
          <button class="btn btn--sm btn--ghost btn_test_k" data-idx="${idx}" type="button" title="用这把 Key 真发一句「你好」">测试</button>
          <span class="key-menu-slot"></span>
        </div>
      </td>
    `;
    tr.dataset.keyIdx = String(idx);
    tr.dataset.cdSec = String(cooldownSec);
    tr.dataset.cdTarget = cdTarget || '';
    return tr;
  }

  // Key 状态：.dot + 一个词 + title 里的完整说明。
  // 失败原因要说人话，并且分清「该改谁」：这几类在操作者眼里是三件完全不同的事，
// 都显示成「失败 · 404」的话没人分得清是 Key 坏了还是模型名写错了。
// reason 枚举与 internal/scheduler/failure_reason.go 的常量一致。
  const REASON_HUMAN = {
    model_not_found: '模型不存在（换模型，不是 Key 的问题）',
    model_unspecified: '未指定模型（先加一个路由或用模型页测试）',
    auth_invalid: 'Key 无效或已过期',
    quota_exhausted: '余额或配额耗尽',
    rate_limited: '被限流（稍后自动恢复）',
    context_too_long: '输入超出上下文长度',
    network: '网络不通',
    timeout: '超时无响应',
    upstream_error: '上游报错',
    bad_response: '上游返回异常格式',
    client_disconnected: '客户端提前断开',
  };
  function reasonWord(reason) {
    return REASON_HUMAN[reason] || reason || '未知原因';
  }

  // 一把 Key 的状态列 HTML。模块级，因为有两个调用方：展开时构建行，以及
// lanes/cooldowns 每 3 秒轮询后回写（不轮询回写的话，冷却中/冷却结束的
// 变化要等用户手动折叠再展开才看得到 —— 这就是「冷却 7h」一直挂着的原因之一）。
  function keyStatusCellHtml(k, cooldownSec, cdTarget) {
    const st = keyStatusView(k, cooldownSec);
    if (cooldownSec > 0) {
      // 冷却做成可直接点的按钮：看到「冷却 7m」的第一反应是「怎么立刻恢复」，
      // 不该再去「⋯」菜单里找「解除冷却」。
      return `<button class="btn btn--sm btn--ghost btn_clear_k_cd_inline" data-cd-target="${eh(cdTarget || '')}" type="button" title="${eh(st.title)} · 点击立即解除"><span class="dot ${st.dot}"></span><span class="text-xs">${eh(st.word)} · 解除</span></button>`;
    }
    return `<span class="fields" title="${eh(st.title)}"><span class="dot ${st.dot}"></span><span class="text-xs text-muted">${eh(st.word)}</span></span>`;
  }

  function keyStatusView(k, cooldownSec) {
    if (cooldownSec > 0) {
      return { dot: 'dot--warn', word: `冷却 ${formatCooldown(cooldownSec)}`, title: `冷却 ${formatCooldown(cooldownSec)}（到期后自动恢复）` };
    }
    const lt = k.last_test;
    if (lt && typeof lt === 'object') {
      if (lt.ok) {
        return { dot: 'dot--ok', word: `可用 · ${Number(lt.latency_ms) || 0}ms`, title: `${String(lt.reply_text || '').trim() || '上游返回 200（未抽到文本）'}${lt.at ? ` · ${lt.at}` : ''}` };
      }
      const status = Number(lt.status) || 0;
      const reason = String(lt.reason || 'unknown');
      const errType = String(lt.err_type || '');
      // 限流和余额耗尽不是「Key 坏了」：用警告色而不是错误色，避免操作者
      // 看到一片红点就去删 Key（2026-11-27 的实测就是这样误伤的）。
      const soft = reason === 'rate_limited' || reason === 'quota_exhausted' || reason === 'timeout';
      return {
        dot: soft ? 'dot--warn' : 'dot--err',
        word: `失败 · ${reasonWord(reason)}`,
        title: `${lt.error || '上游无响应'}${errType ? ` · ${errType}` : ''}${status ? ` · HTTP ${status}` : ''}${lt.at ? ` · ${lt.at}` : ''}`,
      };
    }
    if (k.last_ok === true) return { dot: 'dot--ok', word: `正常 · ${k.last_latency_ms || 0}ms`, title: '正常' };
    if (k.last_ok === false) return { dot: 'dot--err', word: `异常${k.last_status ? ` · ${k.last_status}` : ''}`, title: k.last_status ? `探活失败：${k.last_status}` : '探活失败' };
    return { dot: 'dot--warn', word: '就绪', title: '未测试' };
  }

  // 单把 Key 的真实推理测试：服务端按 key_id / key_label 解析已存的密钥，
  // 浏览器不传密钥本体。结论落在 key 对象上（由「保存」持久化）。
  //
  // quiet=true 用于批量测：服务端每次都把结论落盘（配置版本 +1），批量里
  // 逐把追平版本号就是 2N 次往返（6 把 Key = 12 次）。批量改在全部结束后
  // 追一次，中间那几版本页不再提交，冲突由 persistConfig 的 pendingEdit 处理。
  async function testKeyOnce(pId, k, keyLabel, quiet) {
    const payload = { provider: pId, key_id: k.id || '', key_label: keyLabel };
    const routeModel = firstRouteTargetModel(pId);
    if (routeModel) payload.model = routeModel;
    try {
      const res = await window.HOST.testKey(payload);
      // test-key 会把结论落盘（Full 节点配置版本 +1），本页持有的版本号就此
      // 落后一版。立刻追平，否则紧接着的保存必被 CAS 判为冲突、改动被丢弃。
      if (!quiet) await refreshConfigVersion();
      return applyKeyLastTest(k, res);
    } catch (err) {
      k.last_ok = false;
      return { ok: false, error: scrubUiText(err.message) };
    }
  }

  async function testOneKey(pId, k, keyLabel, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '测试中…';
    }
    toast(`正在测试 Key [${keyLabel}]（真实推理）...`, 'info');
    const lt = await testKeyOnce(pId, k, keyLabel);
    toast(
      lt.ok
        ? `Key [${keyLabel}] 可用 · ${lt.latency_ms}ms`
        : `Key [${keyLabel}] 测试失败: ${lt.status || 0} ${lt.reason || 'unknown'}${lt.err_type ? ` · ${lt.err_type}` : ''}`,
      lt.ok ? 'ok' : 'err'
    );
    renderProvidersList();
    if (window.HOST.kind === 'hub') renderHubOverview();
  }

  // 单把 Key 的探活（校验）：不消耗推理额度，只确认凭据是否有效。
  // quiet=true 用于批量探活：逐把跑时不必每次重绘整张列表。
  async function verifyOneKey(pId, p, k, keyLabel, quiet) {
    if (!quiet) toast(`正在校验 Key [${keyLabel}]...`, 'info');
    try {
      const res = await window.HOST.verifyKey({
        provider: pId,
        api_key: k.key,
        key: k.key,
        key_label: keyLabel,
        base_url: p.base_url || '',
        api_type: normalizeApiType(p.api_type),
      });
      syncVersionFromRes(res);
      const ok = res && (res.valid === true || (res.ok && res.valid !== false && res.latency_ms !== undefined));
      const lat = res?.latency_ms ?? res?.ms ?? 0;
      k.last_ok = Boolean(ok);
      k.last_latency_ms = lat;
      k.last_status = ok ? (res.status || 200) : (res?.status || 0);
      if (!quiet) {
        toast(ok ? `Key [${keyLabel}] 校验成功: 延迟 ${lat}ms` : `Key [${keyLabel}] 校验失败: ${res?.error || '无效凭据'}`, ok ? 'ok' : 'err');
      }
    } catch (e) {
      k.last_ok = false;
      if (!quiet) toast(`校验异常: ${e.message}`, 'err');
    }
    if (quiet) return;
    renderProvidersList();
    if (window.HOST.kind === 'hub') renderHubOverview();
  }

  // 供应商编辑器的事件接线（buildProviderEditor 只出结构）。
  function wireProviderEditor(pId, p, wrap) {
    const q = makeScopedQuery(wrap);
    const keys = p.api_keys || [];
    const isVaultProv = !isHubMode() && p.origin === 'vault';
    const meta = presetMetaForProvider(p, p.preset_id);
    const baseDefault = meta?.base_url || '';
    const antDefault = meta?.anthropic_base_url || '';
    // 中枢清单里该供应商的条目（「从中枢添加」按 Key 补拉时用来列缺失标签）。
    // buildProviderEditor 里也有同名局部变量，但那是另一个作用域 —— 这里必须
    // 自己取一次，否则「从中枢添加」在 Full 端会抛 ReferenceError。
    const manifestProv = isVaultProv ? vaultManifestProviders()[pId] || null : null;

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
      if (q(`#ed_p_hide_ua_${pId}`)) {
        if (q(`#ed_p_hide_ua_${pId}`).checked) p.hide_client_name = true;
        else delete p.hide_client_name;
      }
      // 空值必须真的写回「没有」：留着旧值会让一次误填的重置时刻永远生效。
      if (q(`#ed_p_reset_${pId}`)) {
        const resetAt = q(`#ed_p_reset_${pId}`).value.trim();
        if (resetAt) p.quota_reset_at = resetAt;
        else delete p.quota_reset_at;
      }
      if (q(`#ed_p_rpm_${pId}`)) {
        const rpm = Number(q(`#ed_p_rpm_${pId}`).value);
        if (rpm > 0) p.rpm_per_key = rpm;
        else delete p.rpm_per_key;
      }
    };

    // --- Key 表格的行内操作 ---
    const tbody = q(`#p_keys_tbody_${pId}`);
    if (tbody) {
      tbody.querySelectorAll('tr').forEach((tr) => {
        const idx = Number(tr.dataset.keyIdx);
        const k = keys[idx];
        if (!k) return;
        const keyLabel = k.label || k.id || `key-${idx}`;

        tr.querySelector('.k_weight_in')?.addEventListener('change', (e) => {
          k.weight = Math.max(1, Number(e.target.value) || 1);
          // 中枢托管供应商没有「保存」按钮：本地 Key 的权重改动必须立即落盘
          // （约定 C：本地 Key 可增删改）。中枢 Key 的权重框是 disabled，走不到这里。
          if (isVaultProv) persistConfig(`已更新 Key [${keyLabel}] 的权重`);
        });

        tr.querySelector('.k_enable_cb')?.addEventListener('change', async (e) => {
          if (!e.target.checked) {
            const refs = routesUsingKey(pId, keyLabel);
            if (refs.length > 0) {
              const ok = await confirmDialog({
                title: '禁用正在被引用的 Key',
                message: `Key [${keyLabel}] 正被以下路由引用：\n${refs.join('\n')}\n\n禁用后这些路由将没有可用 Key，请求可能返回 503。仍要禁用？`,
                confirmText: '仍要禁用',
              });
              if (!ok) {
                e.target.checked = true;
                return;
              }
            }
          }
          k.enabled = e.target.checked;
          // 同上：中枢托管供应商上的本地 Key 启用开关要立即落盘。
          if (isVaultProv) persistConfig(`已${k.enabled ? '启用' : '禁用'}本地 Key [${keyLabel}]`);
        });

        clk(tr.querySelector('.btn_test_k'), (e) => testOneKey(pId, k, keyLabel, e.currentTarget));

        // 「⋯」菜单：校验 / 显示 / 解除冷却 / 删除。测试留在行内（常用）。
        const menuSlot = tr.querySelector('.key-menu-slot');
        if (menuSlot) {
          const items = [
            {
              label: '校验（探活）',
              cls: 'btn_verify_k',
              title: '只探活，不消耗推理额度',
              onClick: () => verifyOneKey(pId, p, k, keyLabel),
            },
            {
              label: '解除冷却',
              cls: 'btn_clear_k_cd',
              title: '立即解除此 Key 的冷却',
              // 解除冷却是破坏性操作（规范 §6.3.2）：菜单项要带 .menu-item--danger。
              danger: true,
              onClick: () => clearSingleCooldown(tr.dataset.cdTarget),
            },
          ];
          const deleteThisKey = async () => {
            const refs = routesUsingKey(pId, keyLabel);
            if (refs.length > 0) {
              const ok = await confirmDialog({
                title: '删除正在被引用的 Key',
                message: `Key [${keyLabel}] 正被以下路由引用：\n${refs.join('\n')}\n\n删除后这些路由将没有可用 Key，请求可能返回 503。仍要删除？`,
                confirmText: '仍要删除',
              });
              if (!ok) return;
            }
            syncDraftFields();
            p.api_keys.splice(idx, 1);
            if (isVaultProv || (!isHubMode() && k.origin === 'vault')) {
              // Vault provider has no「保存」button: the deletion must land
              // immediately. The hub copy is untouched —「从中枢添加」or a
              // full refetch restores the key locally.
              await persistConfig(`本地已删除 Key [${keyLabel}]（中枢不受影响，可经「从中枢添加」或「重新拉取」恢复）`);
            } else {
              renderProvidersList();
            }
          };
          items.push({ label: '删除此 Key', cls: 'btn_del_k', danger: true, onClick: deleteThisKey });
          menuSlot.appendChild(buildMenu(items, { label: `Key ${keyLabel} 的更多操作` }));
        }
      });
    }

    // Batch test: every key gets the same real inference probe, one at a time,
    // so the verdict reflects inference quota — not just "can list models".
    //
    // Progress is the whole point: one key probe can block for 20 s (the server
    // side budget), so 6 keys used to leave the UI completely still for two
    // minutes — no disabled button, no changing text, no row updates — and the
    // operator concluded the click did nothing (2026-11-27). The button now
    // counts x/N and the table repaints after every verdict. The model page's
    // 「测试全部候选」 has always worked this way; this is the same contract.
    clk(q(`#btn_batch_test_keys_${pId}`), async () => {
      const btn = q(`#btn_batch_test_keys_${pId}`);
      if (!btn || btn.disabled) return;
      const label = btn.textContent;
      const total = keys.length;
      if (total === 0) {
        toast('这个供应商还没有 Key，先添加一把', 'warn');
        return;
      }
      btn.disabled = true;
      // 置灰的同时就把计数改掉：不然从一个没变化的按钮跳到「2/6」，
      // 操作者会以为第一把被跳过了。
      btn.textContent = `测试中 0/${total}…`;
      let succ = 0;
      let done = 0;
      let aborted = '';
      // 篇幅：批量测 Key 每把都要写盘（配置版本 +1），逐把重绘整张列表会打断
      // 用户正在编辑的字段。只重画状态列：值都来自同一个 p.api_keys 数组。
      const redrawKeyRows = () => {
        if (!wrap.isConnected) return;
        wrap.querySelectorAll(`#p_keys_tbody_${pId} tr`).forEach((tr) => {
          const idx = Number(tr.dataset.keyIdx);
          const k = keys[idx];
          const cell = tr.querySelector('.k-status-cell');
          if (!k || !cell) return;
          const cd = findKeyCooldown(pId, k, idx);
          const st = keyStatusView(k, cd.sec);
          cell.innerHTML = `<span class="fields" title="${eh(st.title)}"><span class="dot ${st.dot}"></span><span class="text-xs text-muted">${eh(st.word)}</span></span>`;
          tr.dataset.cdSec = String(cd.sec);
          tr.dataset.cdTarget = cd.target || '';
        });
      };
      // 串行测 6 把最坏 120 秒（每把 20 秒超时）。这里放到 3 路并发：
      // 一个供应商的 Key 通常是同一账号的不同小号，串行省不下什么；
      // 而连续 3 把都是 429 / 余额耗尽时，后面的 Key 结论早已注定 ——
      // 继续测只是把 90 秒浪费在同一个答案上。命中就直接停。
      const CONCURRENCY = 3;
      let streakLimited = 0;
      const okCount = new Map();
      const runOne = async (i) => {
        if (aborted) return;
        const k = keys[i];
        const keyLabel = k.label || k.id || `key-${i}`;
        const lt = await testKeyOnce(pId, k, keyLabel, true);
        if (lt.ok) {
          succ++;
          streakLimited = 0;
        } else {
          const r = String(lt.reason || '');
          streakLimited = r === 'rate_limited' || r === 'quota_exhausted' ? streakLimited + 1 : 0;
        }
        okCount.set(i, Boolean(lt.ok));
        done++;
        btn.textContent = `测试中 ${Math.min(done + 1, total)}/${total}…`;
        redrawKeyRows();
        if (streakLimited >= 3 && !aborted) {
          aborted = '连续 3 把被限流或余额不足，已提前结束';
        }
      };
      try {
        let next = 0;
        const worker = async () => {
          while (next < total && !aborted) {
            const i = next++;
            await runOne(i);
          }
        };
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
      } finally {
        // 只追一次版本号：中间每把落盘都会让版本前进，但本页此刻不再提交，
        // 全部结束后对齐到最新即可（原来逐把追平 = 2N 次往返）。
        await refreshConfigVersion();
        btn.disabled = false;
        btn.textContent = label;
      }
      const tested = okCount.size;
      if (tested === 0) {
        toast('没有测到任何 Key', 'warn');
      } else if (aborted) {
        toast(`${aborted}（测了 ${tested}/${total} 把，${succ} 把可用）`, 'warn');
      } else {
        toast(`逐把测试完成: ${succ}/${tested} 把 Key 可用`, succ === tested ? 'ok' : 'warn');
      }
      renderProvidersList();
    });

    // OAuth Device Flow (MiniMax only, non-vault provider)
    const oauthBtn = q(`#btn_oauth_start_${pId}`);
    if (oauthBtn) {
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
    if (addKeyBtn) {
      clk(addKeyBtn, () => {
        const lbl = q(`#new_key_lbl_${pId}`)?.value.trim() || '';
        const val = q(`#new_key_val_${pId}`)?.value.trim() || '';
        if (!val) return toast('请填写密钥内容', 'warn');
        // 中枢托管供应商上添加的一律是本地 Key（origin=local，可增删改）；
        // Hub 控制台加的 Key 归中枢（origin=vault）。
        const newOrigin = isVaultProv ? 'local' : (isHubMode() ? 'vault' : 'local');
        const parsed = parseMultiApiKeys(val, lbl, p.api_keys || [], newOrigin);
        if (parsed.error) return toast(parsed.error, 'warn');
        syncDraftFields();
        p.api_keys = p.api_keys || [];
        p.api_keys.push(...parsed.keys);
        // 中枢托管供应商没有「保存」按钮：本地 Key 的增改必须立即落盘。
        if (isVaultProv) {
          persistConfig(`已在供应商 ${pId} 添加本地 Key（与中枢 Key 共存，互不影响）`);
        } else {
          renderProvidersList();
        }
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
        const emptyMsg = (text) => {
          const empty = ce('span');
          empty.className = 'text-xs text-muted';
          empty.textContent = text;
          pickBox.appendChild(empty);
        };
        if (!manifestProv) {
          // 中枢清单加载失败最常见的原因是边缘接口偶发 545，不是 Vault 配错。
          // 只给一句话等于死路：重新加载必须就在这里能点。
          emptyMsg('中枢清单未加载（可能是中枢瞬时不可用）');
          const retry = ce('button');
          retry.type = 'button';
          retry.className = 'btn btn--sm';
          retry.textContent = '重新加载清单';
          clk(retry, async () => {
            retry.disabled = true;
            retry.textContent = '加载中…';
            try {
              await loadVaultManifest({ force: true });
              if (state.vaultManifest) {
                toast('中枢清单已加载', 'ok');
                renderProvidersList();
              } else {
                toast('仍然取不到中枢清单，请检查系统设置里的 Vault 连接', 'err');
                retry.disabled = false;
                retry.textContent = '重新加载清单';
              }
            } catch (e) {
              toast(`加载失败: ${scrubUiText(e.message)}`, 'err');
              retry.disabled = false;
              retry.textContent = '重新加载清单';
            }
          });
          pickBox.appendChild(retry);
          return;
        }
        const localLabels = new Set(keys.map((k) => k.label || k.id).filter(Boolean));
        const missing = (Array.isArray(manifestProv.keys) ? manifestProv.keys : []).filter((lbl) => !localLabels.has(lbl));
        if (missing.length === 0) {
          emptyMsg('中枢清单中没有本地缺失的 Key 标签');
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
        // Hub 端高级区的预设绑定下拉：custom（不绑定）/ 各预设 id。
        const presetSel = q(`#ed_p_preset_${pId}`);
        if (presetSel) {
          const v = String(presetSel.value || '').trim();
          if (v && v !== 'custom' && PRESETS_META[v]) p.preset_id = PRESETS_META[v].preset_id || v;
          else delete p.preset_id;
        }
      }

      // 冲突重试时把「这个供应商的新值」贴回服务端最新配置（见 persistConfig）。
      await persistConfig('供应商保存成功', { scope: 'providers', key: pId, value: p });
    });

    clk(q(`#btn_cancel_prov_${pId}`), () => {
      state.activeEditorKey = null;
      renderProvidersList();
    });

    clk(q(`#btn_del_prov_${pId}`), async () => {
      const ok = await confirmDialog({
        title: '删除供应商',
        message: `确定删除供应商 ${pId} 吗？`,
        confirmText: '删除',
      });
      if (!ok) return;
      delete state.config.providers[pId];
      delete state.probedModelsByProvider[pId];
      state.activeEditorKey = null;
      const saved = await persistConfig(isVaultProv ? `供应商 ${pId} 已从本地删除（中枢不受影响，可重新按需拉取）` : '供应商已删除');
      if (!saved) {
        // 没存上（中枢「空模板」守卫 / 版本冲突）→ 回读服务端配置：供应商还在，
        // 编辑器也留在原地，操作者看得见「没删掉」并能继续改。
        await loadData();
        state.activeEditorKey = `p_${pId}`;
        renderProvidersList();
      }
    });
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
    // Preserve uncommitted operator picks across re-mounts: the list re-renders on
    // login, config import and conflict rollbacks — none of them may reset an open
    // issue form back to「全量」. First mount (no checkboxes rendered yet) defaults
    // to ['*'].
    if (!listEl || !listEl.querySelector('input[type="checkbox"]')) return ['*'];
    if (masterEl?.checked) return ['*'];
    return collectScopeSelection(listEl);
  }

  // 「新增节点」编辑器的权限范围勾选组（列表顶部的 create 编辑器里）。
  // 草稿存在 nodeCreateDraft 里，重绘不丢操作者刚勾的内容。
  function mountIssueScopeLists() {
    if (!isHubMode()) return;
    const opts = templateScopeOptions();
    const provAll = $('issueNodeProvAll');
    const provList = $('issueNodeProvs');
    const modelAll = $('issueNodeModelAll');
    const modelList = $('issueNodeModels');
    if (!provAll || !provList || !modelAll || !modelList) return;
    const provSel = currentScopeSelection(provList, provAll);
    const modelSel = currentScopeSelection(modelList, modelAll);
    mountScopeControls(provAll, provList, opts.providers, provSel);
    mountScopeControls(modelAll, modelList, opts.models, modelSel);
    const saveDraft = () => {
      nodeCreateDraft.providers = provAll.checked ? ['*'] : collectScopeSelection(provList);
      nodeCreateDraft.models = modelAll.checked ? ['*'] : collectScopeSelection(modelList);
    };
    provAll.onchange = () => { saveDraft(); provList.hidden = provAll.checked; };
    modelAll.onchange = () => { saveDraft(); modelList.hidden = modelAll.checked; };
    provList.addEventListener('change', saveDraft);
    modelList.addEventListener('change', saveDraft);
  }

  // --- View: Nodes (Hub mode) ---
  // In-memory only (never sessionStorage/localStorage): the plaintext NODE_TOKEN
  // of the most recent issuance/rotation, so the install view can be re-opened
  // within the same session without forcing another rotation. A page refresh
  // forgets it, and re-opening the install view then falls back to rotate-and-show.
  const nodeTokenMem = new Map();
  // Full-node ADMIN_PASSWORDs now live in the Hub KV and ride back on the node
  // list payload (node.admin_password), so the install view reads the stored
  // value. This session map is only the legacy fallback for a hub old enough to
  // not store passwords: it keeps a generated value stable within the session so
  // re-opening the install view does not silently mint a different password.
  const nodeAdminPassMem = new Map();
  // 「新增节点」编辑器草稿：列表可能因为别的原因重绘（保存 / 轮换后都会重绘），
  // 把已填的值带过去，别让操作者刚敲的字被冲掉。
  const nodeCreateDraft = { name: '', role: 'full', leaseTtl: '', graceTtl: '', providers: ['*'], models: ['*'] };
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

  // --- Node install view (once-only credentials) ---
  // The install command carries the node token, so it is shown in a .dialog —
  // component 6 explicitly allows it for "只显示一次" material.
  function openNodeInstallOverlay(nodeId, material, opts = {}) {
    const overlay = $('nodeInstallOverlay');
    if (!overlay) return;
    const node = (state.nodes || []).find((n) => n.id === nodeId);
    const role = (material.node && material.node.role) || (node && node.role) || 'lite';
    const titleEl = $('nodeInstallTitle');
    const subEl = $('nodeInstallSub');
    const rotNotice = $('nodeInstallRotateNotice');
    const staleHint = $('nodeInstallStaleHint');
    if (titleEl) titleEl.textContent = `一次性安装命令 — ${node?.name || nodeId}`;
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
    // Move focus into the overlay so Esc / the close button are reachable
    // without tabbing through the page behind it, and remember where to
    // return focus on close.
    nodeInstallReturnEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openDialog(overlay, { focus: 'btnCloseNodeInstall' });
  }

  function closeNodeInstallOverlay() {
    const overlay = $('nodeInstallOverlay');
    if (!overlay) return;
    closeDialog(overlay);
    const back = nodeInstallReturnEl;
    nodeInstallReturnEl = null;
    if (back && document.contains(back)) back.focus();
  }

  // --- Node credentials (read-only GET: viewing must never rotate the token) ---
  const CRED_PASS_MASK = '●●●●●●●●●●●●';
  const NODE_DETAIL_SECRET_LABELS = { node_token: '节点 Token', client_key: '客户端密钥', admin_password: '后台登录密码' };

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
  function nodeDetailSecretRow(title, desc, key, credKey, emptyNote) {
    const shown = `<div class="tabular node-detail-secret" data-detail-secret="${key}" data-detail-empty="${eh(emptyNote || '未保存')}">${CRED_PASS_MASK}</div>`;
    return `<div class="setting-row" title="${eh(desc)}"><div class="setting-main"><div class="setting-title">${eh(title)}</div><div class="setting-desc">${eh(desc)}</div>${shown}</div><div class="setting-control"><button class="btn btn--sm" type="button" data-detail-eye="${key}" aria-label="显示${eh(title)}" aria-pressed="false">${window.uiIcon ? window.uiIcon('eye') : ''}<span data-detail-eye-label>显示</span></button><button class="btn btn--sm" type="button" data-detail-copy="${key}">复制</button></div></div>`;
  }

  async function fetchNodeCredentials(nodeId) {
    const res = await window.HOST.request(`/api/admin/nodes/${encodeURIComponent(nodeId)}/credentials`);
    const data = await res.json();
    if (!(res.ok && data && data.ok)) {
      toast((data && data.error) || '获取节点凭据失败', 'err');
      return null;
    }
    return data;
  }

  // 节点详情里的凭据：读一次 credentials 接口，缓存到 state（明文只留内存）。
  async function loadNodeSecrets(nodeId) {
    const data = await fetchNodeCredentials(nodeId);
    if (!data) return null;
    state.nodeSecrets[nodeId] = {
      node_token: String(data.node_token || ''),
      client_key: String(data.client_key || ''),
      admin_password: data.role === 'full' ? String(data.admin_password || '') : '',
      notes: {
        node_token: data.node_token_note || '',
        client_key: data.client_key_note || '',
        admin_password: data.admin_password_note || '',
      },
    };
    return state.nodeSecrets[nodeId];
  }

  // --- Node rows & editors ---
  // 一行只允许：名称 + 一行次要信息（12px 等宽）+ 一个状态（.dot + 一个词）+ 一个计数。
  function nodeStatusWord(node) {
    const snap = getNodeSyncSnapshotStatus(node);
    const ONLINE_MS = 15 * 60 * 1000;
    const online = node.enabled !== false && Boolean(snap.syncMs) && (Date.now() - snap.syncMs) <= ONLINE_MS;
    if (node.enabled === false) return { word: '已吊销', dot: 'dot--err' };
    if (online) return { word: '在线', dot: 'dot--ok' };
    if (snap.syncMs) return { word: snap.key === 'grace' ? '宽限期内' : '离线', dot: 'dot--warn' };
    return { word: '未安装', dot: 'dot--warn' };
  }

  // 节点行次要信息：角色 · 最近同步 · 最近 IP（等宽 12px，长串同列对齐）。
  function nodeSubText(node) {
    const parts = [node.role === 'lite' ? 'Lite' : 'Full'];
    const lastMs = node.last_seen ? new Date(node.last_seen).getTime() : 0;
    parts.push(lastMs ? `同步 ${formatTime(lastMs / 1000)}` : '从未同步');
    if (node.last_ip) parts.push(node.last_ip);
    return parts.join(' · ');
  }

  function renderNodesList() {
    const container = $('nodesList');
    if (!container) return;
    // 列表即将重建（innerHTML 替换）：挂在旧 DOM 上的菜单浮层会变成死元素，
    // 先关掉，别让它们留在 openMenus 里干扰 Esc。
    closeAllMenus();
    container.innerHTML = '';

    // 页头「添加节点」按钮与编辑器互斥：编辑器开着时它变成「收起」（普通按钮），
    // 避免同一屏出现两个主按钮（单区域单主 CTA）。
    const btnAddNode = $('btnIssueNode');
    if (btnAddNode) {
      const editorOpen = state.creatingNode || Boolean(state.activeEditorKey);
      btnAddNode.classList.toggle('btn--primary', !editorOpen);
      btnAddNode.textContent = state.creatingNode ? '收起' : '添加节点';
    }

    const nodes = state.nodes || [];

    // 「新增节点」= 在列表顶部插入一个空白编辑器（create 模式），
    // 与编辑共用同一个构建函数（buildNodeEditor）。
    if (state.creatingNode) {
      const createEditor = ce('div');
      createEditor.className = 'editor';
      createEditor.id = 'nodeCreateEditor';
      container.appendChild(createEditor);
      const built = buildNodeEditor(null, { create: true });
      createEditor.appendChild(built);
      // 先挂进 DOM 再接线：wireNodeEditor 用作用域查询找控件。
      wireNodeEditor(null, null, built);
    }

    if (nodes.length === 0) {
      const empty = ce('div');
      empty.className = 'card-pad';
      const msg = ce('p');
      msg.className = 'text-muted';
      msg.textContent = '还没有节点：签发一个节点，它就能从中枢拉取供应商与模型路由';
      empty.appendChild(msg);
      if (!state.creatingNode) {
        const btn = ce('button');
        btn.type = 'button';
        // 空状态里的引导按钮用次要样式：这一屏的主按钮是页头的「添加节点」，
        // 两个实心蓝按钮会抢同一个视线。
        btn.className = 'btn mt-3';
        btn.textContent = '添加节点';
        clk(btn, () => {
          state.creatingNode = true;
          state.activeEditorKey = null;
          renderNodesList();
        });
        empty.appendChild(btn);
      }
      container.appendChild(empty);
      return;
    }

    for (const node of nodes) {
      const isExpanded = state.activeEditorKey === `node_${node.id}`;
      const row = ce('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      const st = nodeStatusWord(node);
      const dot = ce('span');
      dot.className = `dot ${st.dot}`;

      const who = ce('div');
      who.className = 'who';
      who.innerHTML = `
        <div class="name"><span>${eh(node.name || node.id)}</span></div>
        <div class="sub">${eh(nodeSubText(node))}</div>
      `;

      const status = ce('span');
      status.className = 'fields';
      status.appendChild(dot);
      const statusWord = ce('span');
      statusWord.className = 'text-xs text-muted';
      statusWord.textContent = st.word;
      status.appendChild(statusWord);

      const fields = ce('div');
      fields.className = 'fields';
      const syncPill = ce('span');
      syncPill.className = 'pill tabular';
      syncPill.textContent = `${Number(node.sync_count || 0)} 次同步`;
      fields.appendChild(syncPill);
      const caret = ce('span');
      caret.className = 'caret';
      caret.textContent = '▾';
      fields.appendChild(caret);

      row.appendChild(status);
      row.appendChild(who);
      row.appendChild(fields);

      clk(row, (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `node_${node.id}`;
        // 点行展开编辑时收起 create 编辑器（同一时刻只有一个编辑器）。
        state.creatingNode = false;
        renderNodesList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = ce('div');
        editor.className = 'editor';
        const built = buildNodeEditor(node);
        editor.appendChild(built);
        container.appendChild(editor);
        wireNodeEditor(node, null, built);
      }
    }
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
      // Skip while the install dialog is open: re-rendering under it is fine,
      // but a failed refresh behind the modal silently resets the editor state.
      if (!$('nodeInstallOverlay')?.hidden) return;
      if (state.activeEditorKey && state.activeEditorKey.startsWith('node_')) return;
      if (state.creatingNode) return;
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

  // 安装命令面板：一条推荐命令 + 复制按钮；Docker / 单行直跑收进「其它安装方式」；
  // 端口、脚本源、下载源、监听范围、内网上游收进「安装选项」。
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
        <span class="form-label">推荐安装命令（一键安装 · systemd）</span>
        <div class="fields">
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
      <textarea class="textarea input--code" data-cmd-output readonly rows="3"></textarea>
      <details class="headers-details mt-2">
        <summary class="form-label">其它安装方式</summary>
        <div class="mt-2">
          <div class="seg" data-cmd-seg>
            <button class="seg-btn active" data-cmd-mode="install" type="button">一键安装 (systemd)</button>
            <button class="seg-btn" data-cmd-mode="docker" type="button">Docker 部署</button>
            <button class="seg-btn" data-cmd-mode="binary" type="button">单行直跑 (免安装)</button>
          </div>
          <textarea class="textarea input--code mt-2" data-cmd-alt readonly rows="2" hidden></textarea>
        </div>
      </details>
      <details class="headers-details mt-2">
        <summary class="form-label">安装选项</summary>
        <div class="form-grid mt-2" data-cmd-opts>
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
      </details>
    </div>`;

    const q = (sel) => container.querySelector(sel);
    const outEl = q('[data-cmd-output]');
    const altEl = q('[data-cmd-alt]');
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

    const build = (mode) => buildNodeShellCommands({
      ...panelState,
      mode,
      role,
      hubUrl,
      nodeToken: payload.nodeToken,
      clientKey,
      bootstrapEnv: payload.bootstrapEnv,
    });

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
      if (outEl) outEl.value = build('install');
      if (altEl) {
        // 「其它安装方式」里选中的方式；选了 systemd 就回到推荐命令本身。
        altEl.value = build(panelState.mode);
        altEl.hidden = panelState.mode === 'install';
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

  // --- Node editor (组件 5 · .editor) ---
  // 一个构建函数管完整个节点：新增（create）与编辑（edit）共用同一套字段 / id /
  // 保存逻辑，只有两处差别：新增时字段留空、无「删除」按钮。
  // 结构固定：基本字段（节点名称）→「高级」折叠（角色 / 租约 / 宽限 / 权限范围）
  //          → 底部 .form-actions--split：左删除（确认），右「取消」+「保存」。
  function buildNodeEditor(node, opts = {}) {
    const isCreate = Boolean(opts.create);
    const wrap = ce('div');
    const id = node?.id || '';
    const role = isCreate ? (nodeCreateDraft.role || 'full') : (node.role || 'full');
    const leaseTtl = isCreate ? nodeCreateDraft.leaseTtl : (node.lease_ttl || 86400);
    const graceTtl = isCreate ? nodeCreateDraft.graceTtl : (node.grace_ttl || 3600);
    const nameVal = isCreate ? (nodeCreateDraft.name || '') : (node.name || '');

    // 「安装」视图：签发成功 / 重新获取后，同一个编辑器切换成安装指引。
    const installFor = !isCreate && state.nodeInstallFor === id ? id : '';

    // create 模式用 issueNode* id（签发表单的旧 id，保持功能清单可追溯）；
    // edit 模式用 ed_node_*_{id}。
    const nameId = isCreate ? 'issueNodeName' : `ed_node_name_${id}`;
    const roleId = isCreate ? 'issueNodeRole' : `ed_node_role_${id}`;
    const ttlId = isCreate ? 'issueNodeTTL' : `ed_node_ttl_${id}`;
    const graceId = isCreate ? 'issueNodeGraceTTL' : `ed_node_grace_${id}`;
    const provAllId = isCreate ? 'issueNodeProvAll' : `ed_node_prov_all_${id}`;
    const provListId = isCreate ? 'issueNodeProvs' : `ed_node_provs_${id}`;
    const modelAllId = isCreate ? 'issueNodeModelAll' : `ed_node_model_all_${id}`;
    const modelListId = isCreate ? 'issueNodeModels' : `ed_node_models_${id}`;
    const cancelBtnId = isCreate ? 'btn_cancel_node_create' : `btn_cancel_node_${id}`;
    // create 模式的提交按钮沿用签发表单的旧 id（#btnDoIssue），保持功能清单可追溯。
    const saveBtnId = isCreate ? 'btnDoIssue' : `btn_save_node_${id}`;

    wrap.innerHTML = `<div class="form-grid">${[
      fg('节点名称', `<input class="input" id="${nameId}" value="${eh(nameVal)}" placeholder="例如 hk-edge-01">`),
    ].join('')}</div>
    ${installFor ? `<div class="editor-section" id="node_install_view_${id}"></div>` : ''}
    ${isCreate ? '' : nodeDetailSectionHtml(node)}
    <details class="headers-details mt-3">
      <summary class="form-label">高级（角色 / 租约 / 宽限期 / 权限范围）</summary>
      <div class="form-grid mt-2">${[
        fg('节点角色', `<select class="select" id="${roleId}"><option value="full" ${role === 'full' ? 'selected' : ''}>Full (全功能代理网关)</option><option value="lite" ${role === 'lite' ? 'selected' : ''}>Lite (轻量本地代理)</option></select>`),
        fg('租约时长 (秒 lease_ttl)', `<input class="input tabular" id="${ttlId}" type="number" value="${eh(String(leaseTtl))}" placeholder="86400">`, '', '', '节点配置的租约时长；超过此时长未同步即判离线'),
        fg('断网宽限期 (秒 grace_ttl)', `<input class="input tabular" id="${graceId}" type="number" value="${eh(String(graceTtl))}" placeholder="3600">`, '', '', '租约过期后的宽限时长；宽限期内节点仍可继续工作'),
        `<div class="form-group"><label class="form-label form-label--check"><input type="checkbox" id="${provAllId}"><span>允许全部 LLM 供应商 (* 全量)</span></label><div class="mt-1" id="${provListId}"></div></div>`,
        `<div class="form-group"><label class="form-label form-label--check"><input type="checkbox" id="${modelAllId}"><span>允许全部 LLM 模型 (* 全量)</span></label><div class="mt-1" id="${modelListId}"></div></div>`,
      ].join('')}</div>
    </details>
    <div class="form-actions form-actions--split">
      <div class="form-actions-group" id="node_left_actions_${id}">
        ${isCreate ? '' : `<button class="btn btn--danger" id="btn_toggle_node_${id}" type="button">${node.enabled === false ? '恢复节点' : '吊销节点'}</button>`}
      </div>
      <div class="form-actions-group">
        <button class="btn" id="${cancelBtnId}" type="button">取消</button>
        ${isCreate ? '' : `<button class="btn" id="btn_rotate_node_${id}" type="button">轮换 Token</button>`}
        ${isCreate ? '' : `<button class="btn" id="btn_reinstall_node_${id}" type="button">重新获取安装命令</button>`}
        <button class="btn btn--primary" id="${saveBtnId}" type="button">${isCreate ? '添加节点' : '保存节点'}</button>
      </div>
    </div>`;
    return wrap;
  }

  // 节点详情（组件 5 · 行内展开）：基本信息 + Token / 后台密码查看复制 + 模型使用。
  // 原来这块是 #nodeDetailOverlay 弹框；现在跟着节点行就地展开。
  function nodeDetailSectionHtml(node) {
    const id = node.id;
    const role = node.role === 'full' ? 'full' : 'lite';
    const heartbeat = node.last_seen ? formatDateTime(node.last_seen) : '尚未上报心跳';
    const ttlHint = `租约 ${Number(node.lease_ttl) || 86400}s / 宽限 ${Number(node.grace_ttl) || 3600}s 后判离线`;
    const providers = Array.isArray(node.scope?.providers) ? node.scope.providers : ['*'];
    const models = Array.isArray(node.scope?.models) ? node.scope.models : ['*'];
    const rows = [
      nodeDetailRow('节点 ID', 'Hub KV 中的主键，安装命令与鉴权都用它', `<span class="tabular node-detail-value">${eh(node.id)}</span>`),
      nodeDetailRow('角色', 'full 含管理控制台；lite 为极简代理', `<span class="text-xs">${eh(role === 'full' ? 'Full' : 'Lite')}</span>`),
      nodeDetailRow('创建时间', '节点签发时间', `<span class="tabular node-detail-value">${eh(formatDateTime(node.created_at) || '—')}</span>`),
      nodeDetailRow('最后心跳', ttlHint, `<span class="tabular node-detail-value">${eh(heartbeat)}</span>`),
      nodeDetailRow('配置版本', '节点最近一次拉取生效的配置版本号', `<span class="tabular node-detail-value">${node.last_config_version ? `#${eh(String(node.last_config_version))}` : '—'}</span>`),
      nodeDetailRow('同步次数', `其中 304 命中 ${Number(node.hit_304_count) || 0} 次`, `<span class="tabular node-detail-value">${Number(node.sync_count || 0)} 次</span>`),
      nodeDetailRow('最近 IP', '节点最近一次同步 / 心跳的来源地址', `<span class="tabular node-detail-value">${eh(node.last_ip || '—')}</span>`),
      nodeDetailRow('供应商范围', '节点可访问的上游供应商白名单', `<span class="node-detail-value">${eh(nodeScopeText(providers, '供应商'))}</span>`),
      nodeDetailRow('模型范围', '节点可路由的模型白名单', `<span class="node-detail-value">${eh(nodeScopeText(models, '模型'))}</span>`),
    ];
    // 秘密行：Token / 客户端密钥 / 后台密码（Full 才有后台密码）。
    const secretRows = [
      nodeDetailSecretRow('节点 Token', 'NODE_TOKEN：节点侧 LLMPROXY_NODE_TOKEN / 安装命令 --node-token', 'node_token', 'node_token', '未保存明文（旧版本节点，轮换后可回看）'),
      nodeDetailSecretRow('客户端密钥', 'client_key：节点侧 LLMPROXY_CLIENT_KEY，由 Hub 全局设置下发', 'client_key', 'client_key', 'Hub 未配置主客户端密钥'),
      nodeDetailSecretRow('后台密码', 'Full 节点管理控制台 (/admin) 的登录密码', 'admin_password', 'admin_password', role === 'full' ? '该节点未存有后台密码' : 'lite 无控制台密码'),
    ];
    return `<div class="editor-section">
      <div class="section-bar"><span class="form-label">节点详情</span></div>
      <div id="node_detail_rows_${id}">${rows.join('')}</div>
      <div id="node_detail_secrets_${id}">${secretRows.join('')}</div>
      <div class="section-bar mt-3"><span class="form-label">模型使用（节点上报）</span></div>
      <div id="node_model_usage_${id}"></div>
    </div>`;
  }

  // 节点编辑器的接线（buildNodeEditor 只出结构）。
  function wireNodeEditor(node, _unused, wrap) {
    const isCreate = !node;
    const id = node?.id || '';
    const q = makeScopedQuery(wrap);

    // 权限范围勾选组：新增用「issueNode*」那套 id（create 模式专属），
    // 编辑用「ed_node_*_{id}」。两套控件的挂载点不同，但取值逻辑一致。
    const tmplOpts = templateScopeOptions();
    const staleProviders = isCreate ? [] : staleScopeEntries(node.scope?.providers, tmplOpts.providers);
    const staleModels = isCreate ? [] : staleScopeEntries(node.scope?.models, tmplOpts.models);

    const nameId = isCreate ? 'issueNodeName' : `ed_node_name_${id}`;
    const roleId = isCreate ? 'issueNodeRole' : `ed_node_role_${id}`;
    const ttlId = isCreate ? 'issueNodeTTL' : `ed_node_ttl_${id}`;
    const graceId = isCreate ? 'issueNodeGraceTTL' : `ed_node_grace_${id}`;
    const provAllId = isCreate ? 'issueNodeProvAll' : `ed_node_prov_all_${id}`;
    const provListId = isCreate ? 'issueNodeProvs' : `ed_node_provs_${id}`;
    const modelAllId = isCreate ? 'issueNodeModelAll' : `ed_node_model_all_${id}`;
    const modelListId = isCreate ? 'issueNodeModels' : `ed_node_models_${id}`;
    const cancelBtnId = isCreate ? 'btn_cancel_node_create' : `btn_cancel_node_${id}`;
    const saveBtnId = isCreate ? 'btnDoIssue' : `btn_save_node_${id}`;

    mountScopeControls(q(`#${provAllId}`), q(`#${provListId}`), tmplOpts.providers,
      isCreate ? nodeCreateDraft.providers : node.scope?.providers);
    mountScopeControls(q(`#${modelAllId}`), q(`#${modelListId}`), tmplOpts.models,
      isCreate ? nodeCreateDraft.models : node.scope?.models);

    if (isCreate) {
      // create 模式的草稿：列表重绘（保存 / 探活后都会重绘）不能把操作者刚敲的字冲掉。
      const capture = () => {
        nodeCreateDraft.name = q(`#${nameId}`)?.value || '';
        nodeCreateDraft.role = q(`#${roleId}`)?.value || 'full';
        nodeCreateDraft.leaseTtl = q(`#${ttlId}`)?.value || '';
        nodeCreateDraft.graceTtl = q(`#${graceId}`)?.value || '';
        nodeCreateDraft.providers = q(`#${provAllId}`)?.checked ? ['*'] : collectScopeSelection(q(`#${provListId}`));
        nodeCreateDraft.models = q(`#${modelAllId}`)?.checked ? ['*'] : collectScopeSelection(q(`#${modelListId}`));
      };
      [nameId, ttlId, graceId].forEach((fid) => q(`#${fid}`)?.addEventListener('input', capture));
      [roleId].forEach((fid) => q(`#${fid}`)?.addEventListener('change', capture));
      [provAllId, modelAllId].forEach((fid) => q(`#${fid}`)?.addEventListener('change', capture));
      [provListId, modelListId].forEach((fid) => q(`#${fid}`)?.addEventListener('change', capture));
    } else {
      wireNodeDetailSection(node, wrap);
      wireNodeInstallSection(node, wrap);
    }

    clk(q(`#${cancelBtnId}`), () => {
      state.creatingNode = false;
      state.activeEditorKey = null;
      state.nodeInstallFor = null;
      renderNodesList();
    });

    clk(q(`#${saveBtnId}`), async () => {
      const nameEl = q(`#${nameId}`);
      const name = (nameEl?.value || '').trim();
      if (!name) return toast('请输入节点名称', 'warn');

      if (isCreate) {
        const role = q(`#${roleId}`)?.value || 'full';
        // 空值回落服务端默认（86400 / 3600 / *）：Number('') === 0 是 falsy。
        const leaseTtl = Number(q(`#${ttlId}`)?.value) || 86400;
        const graceTtl = Number(q(`#${graceId}`)?.value) || 3600;
        const scope = {
          providers: q(`#${provAllId}`)?.checked ? ['*'] : collectScopeSelection(q(`#${provListId}`)),
          models: q(`#${modelAllId}`)?.checked ? ['*'] : collectScopeSelection(q(`#${modelListId}`)),
        };
        try {
          const res = await window.HOST.issueNode({ name, role, lease_ttl: leaseTtl, grace_ttl: graceTtl, scope });
          if (!res || !res.ok) return toast((res && res.error) || '添加失败', 'err');
          toast('节点已添加，请在安装视图里完成部署', 'ok');
          state.creatingNode = false;
          nodeCreateDraft.name = '';
          nodeCreateDraft.role = 'full';
          nodeCreateDraft.leaseTtl = '';
          nodeCreateDraft.graceTtl = '';
          nodeCreateDraft.providers = ['*'];
          nodeCreateDraft.models = ['*'];
          if (res.node_token) nodeTokenMem.set(res.node?.id, res);
          await loadNodesData();
          // 保存后同一个编辑器切换为「安装」视图（安装视图在行内展开的编辑器里）。
          if (res.node?.id) {
            state.activeEditorKey = `node_${res.node.id}`;
            state.nodeInstallFor = res.node.id;
            renderNodesList();
          }
        } catch (e) {
          toast(scrubUiText(e.message), 'err');
        }
        return;
      }

      const role = q(`#${roleId}`)?.value || node.role;
      const leaseTtl = Number(q(`#${ttlId}`)?.value) || 86400;
      const graceTtl = Number(q(`#${graceId}`)?.value) || 3600;
      const scope = {
        providers: q(`#${provAllId}`)?.checked
          ? ['*']
          : [...new Set([...staleProviders, ...collectScopeSelection(q(`#${provListId}`))])],
        models: q(`#${modelAllId}`)?.checked
          ? ['*']
          : [...new Set([...staleModels, ...collectScopeSelection(q(`#${modelListId}`))])],
      };
      try {
        const res = await window.HOST.patchNode(id, { name, role, lease_ttl: leaseTtl, grace_ttl: graceTtl, scope });
        if (res && res.ok) { toast('节点配置更新成功', 'ok'); await loadNodesData(); }
        else toast(res.error || '更新失败', 'err');
      } catch (e) { toast(scrubUiText(e.message), 'err'); }
    });

    if (isCreate) return;

    // 吊销 / 恢复：危险操作走 confirmDialog。
    clk(q(`#btn_toggle_node_${id}`), async () => {
      const enable = node.enabled === false;
      const ask = enable
        ? `恢复 ${node.name || id}？恢复后节点在下一次心跳 / 同步时重新校验 Token 并继续工作。`
        : `吊销 ${node.name || id}？吊销后该节点立即无法同步配置，节点侧会在鉴权失败后停服。`;
      const ok = await confirmDialog({
        title: enable ? '恢复节点' : '吊销节点',
        message: ask,
        confirmText: enable ? '恢复' : '吊销',
      });
      if (!ok) return;
      try {
        const res = await window.HOST.patchNode(id, { enabled: enable });
        if (res && res.ok) {
          toast(enable ? '节点已恢复' : '节点已吊销', 'ok');
          await loadNodesData();
        } else {
          toast((res && res.error) || (enable ? '恢复节点失败' : '吊销节点失败'), 'err');
        }
      } catch (e) { toast(e.message, 'err'); }
    });

    // 轮换 Token：旧 Token 立即失效，确认后轮换；结果以一次性命令展示在弹框里。
    clk(q(`#btn_rotate_node_${id}`), async () => {
      const ok = await confirmDialog({
        title: '轮换节点 Token',
        message: `轮换 ${node.name || id} 的 Token？\n旧 Token 立即失效，节点在更新 NODE_TOKEN 并重新同步前会一直鉴权失败。`,
        confirmText: '轮换',
      });
      if (!ok) return;
      try {
        const res = await window.HOST.rotateNode(id);
        if (!res || !res.ok || !res.node_token) {
          toast((res && res.error) || '轮换 Token 失败', 'err');
          return;
        }
        nodeTokenMem.set(id, res);
        // 轮换后的一次性命令：用 .dialog 展示（组件 6 允许「只显示一次」的材料）。
        openNodeInstallOverlay(id, res, { rotated: true });
        await loadNodesData();
        toast('Token 已轮换', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    // 重新获取安装命令：Hub 只存 Token 摘要，重新获取 = 轮换一次。
    clk(q(`#btn_reinstall_node_${id}`), async () => {
      const cached = nodeTokenMem.get(id);
      if (cached && cached.node_token) {
        openNodeInstallOverlay(id, cached, { rotated: false, fromCache: true });
        return;
      }
      const ok = await confirmDialog({
        title: '重新获取安装命令',
        message: `安装命令包含节点 Token，出于安全仅在签发时显示一次。\n现在重新获取将轮换 ${node.name || id} 的 Token（旧 Token 立即失效），继续吗？`,
        confirmText: '重新获取',
      });
      if (!ok) return;
      try {
        const res = await window.HOST.getNodeInstallCommand(id);
        if (res && res.ok && res.node_token) {
          nodeTokenMem.set(id, res);
          openNodeInstallOverlay(id, res, { rotated: true });
          await loadNodesData();
        } else {
          toast((res && res.error) || '获取安装命令失败', 'err');
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    // 删除节点放在「⋯」菜单里（行内次要操作不超过 2 个）。
    const moreItems = [{
      label: '删除节点',
      danger: true,
      cls: `btn_del_node_${id}`,
      onClick: async () => {
        const ok = await confirmDialog({
          title: '删除节点',
          message: `确认永久删除节点 ${node.name} 吗？`,
          confirmText: '删除',
        });
        if (!ok) return;
        try {
          const res = await window.HOST.deleteNode(id);
          if (res && res.ok) {
            toast('节点已删除', 'ok');
            state.activeEditorKey = null;
            // Drop the in-memory token and admin password: the node is gone, and
            // its plaintext credential must not outlive it in this tab's memory.
            nodeTokenMem.delete(id);
            nodeAdminPassMem.delete(id);
            delete state.nodeSecrets[id];
            await loadNodesData();
          }
        } catch (e) { toast(e.message, 'err'); }
      },
    }];
    const actionHost = q(`#node_left_actions_${id}`);
    if (actionHost) {
      actionHost.appendChild(buildMenu(moreItems, { label: `${node.name || id} 的更多操作` }));
    }
  }

  // 节点详情接线：凭据查看/复制 + 模型使用表。
  // 「安装」视图接线：签发成功后，同一个编辑器里出现推荐命令 + 复制按钮 +
  // 后台密码（只此一次）。命令面板的其它选项在 mountNodeCommandPanel 里。
  function wireNodeInstallSection(node, wrap) {
    const id = node.id;
    const q = makeScopedQuery(wrap);
    const host = q(`#node_install_view_${id}`);
    if (!host) return;
    const material = nodeTokenMem.get(id);
    if (!material || !material.node_token) {
      host.innerHTML = '<div class="notice-strip"><span>安装命令只在签发或轮换时显示一次（Hub 只保存 Token 摘要）。点下方「重新获取安装命令」可再次获取（会轮换 Token）。</span></div>';
      return;
    }
    // 一次性材料：新 NODE_TOKEN 与启动环境变量（各自带复制按钮）。
    host.innerHTML = `<div class="form-grid form-grid--2">${[
      fg('新 NODE_TOKEN (仅显示一次)', `<div class="input-row"><input class="input input--code" readonly id="node_new_token_val_${id}" value="${eh(String(material.node_token || ''))}"><button class="btn" id="btn_copy_node_tok_${id}" type="button">复制</button></div>`),
      fg('启动环境变量', `<div class="input-row"><input class="input input--code" readonly id="node_new_env_val_${id}" value="${eh(String(material.bootstrap_env || ''))}"><button class="btn" id="btn_copy_node_env_${id}" type="button">复制</button></div>`),
    ].join('')}</div>`;
    clk(q(`#btn_copy_node_tok_${id}`), () => copyToClipboard(material.node_token, 'NODE_TOKEN 已复制'));
    clk(q(`#btn_copy_node_env_${id}`), () => copyToClipboard(material.bootstrap_env, '环境变量已复制'));
    const cmdHost = ce('div');
    cmdHost.className = 'mt-3';
    host.appendChild(cmdHost);
    mountNodeCommandPanel(cmdHost, {
      role: (material.node && material.node.role) || node.role || 'lite',
      hubUrl: window.location.origin,
      nodeToken: material.node_token,
      clientKey: material.client_key,
      bootstrapEnv: material.bootstrap_env,
      adminPass: node.admin_password || material.admin_password || getStableNodeAdminPass(id, node.role),
    });
  }

  function wireNodeDetailSection(node, wrap) {
    const id = node.id;
    const q = makeScopedQuery(wrap);

    renderNodeModelUsage(node, q(`#node_model_usage_${id}`));

    const secretsBox = q(`#node_detail_secrets_${id}`);
    if (!secretsBox) return;

    // 凭据只在展开时读一次（只读接口，绝不轮换 Token）。
    // 注意：applySecrets 只更新显示状态，绝不重复挂事件 —— 否则每次重绘都会
    // 多绑一次 click，「复制」会被立即触发。
    const applySecrets = (secrets) => {
      const notes = (secrets && secrets.notes) || {};
      secretsBox.querySelectorAll('[data-detail-secret]').forEach((el) => {
        const key = el.getAttribute('data-detail-secret');
        const val = secrets ? String(secrets[key] || '') : '';
        if (!val) {
          el.textContent = notes[key] || el.getAttribute('data-detail-empty') || '未保存';
          const eye = secretsBox.querySelector(`[data-detail-eye="${key}"]`);
          const copy = secretsBox.querySelector(`[data-detail-copy="${key}"]`);
          if (eye) eye.hidden = true;
          if (copy) copy.hidden = true;
          return;
        }
        const eye = secretsBox.querySelector(`[data-detail-eye="${key}"]`);
        const copy = secretsBox.querySelector(`[data-detail-copy="${key}"]`);
        if (eye) eye.hidden = false;
        if (copy) copy.hidden = false;
        el.textContent = CRED_PASS_MASK;
      });
    };

    // 事件只挂一次。
    secretsBox.querySelectorAll('[data-detail-eye]').forEach((btn) => {
      clk(btn, () => {
        const key = btn.getAttribute('data-detail-eye');
        const valEl = secretsBox.querySelector(`[data-detail-secret="${key}"]`);
        const revealed = btn.getAttribute('aria-pressed') === 'true';
        const secrets = state.nodeSecrets[id];
        const val = secrets ? String(secrets[key] || '') : '';
        if (!val) return toast('该凭据暂不可回看', 'warn');
        if (valEl) valEl.textContent = revealed ? CRED_PASS_MASK : val;
        btn.setAttribute('aria-pressed', revealed ? 'false' : 'true');
        btn.setAttribute('aria-label', `${revealed ? '显示' : '隐藏'}${NODE_DETAIL_SECRET_LABELS[key] || ''}`);
        if (window.uiIcon) {
          btn.innerHTML = `${window.uiIcon(revealed ? 'eye' : 'eyeOff')}<span data-detail-eye-label>${revealed ? '显示' : '隐藏'}</span>`;
        } else {
          btn.textContent = revealed ? '显示' : '隐藏';
        }
      });
    });
    secretsBox.querySelectorAll('[data-detail-copy]').forEach((btn) => {
      clk(btn, () => {
        const key = btn.getAttribute('data-detail-copy');
        const secrets = state.nodeSecrets[id];
        const val = secrets ? String(secrets[key] || '') : '';
        if (!val) return toast('该凭据暂不可回看', 'warn');
        copyToClipboard(val, `${NODE_DETAIL_SECRET_LABELS[key] || '凭据'} 已复制`);
      });
    });

    const cached = state.nodeSecrets[id];
    applySecrets(cached || null);
    if (!cached) {
      loadNodeSecrets(id).then((secrets) => {
        if (secrets && state.activeEditorKey === `node_${id}`) applySecrets(secrets);
      }).catch(() => {});
    }
  }

  // 节点上报的模型使用（按节点显示）。数据来自 node.usage.model_stats / node.usage.models。
  function renderNodeModelUsage(node, container) {
    if (!container) return;
    const u = node.usage && typeof node.usage === 'object' ? node.usage : null;
    const statsMap = u && u.model_stats && typeof u.model_stats === 'object' ? u.model_stats : null;
    const modelsMap = u && u.models && typeof u.models === 'object' ? u.models : null;
    const rows = [];
    if (statsMap) {
      for (const [model, st] of Object.entries(statsMap)) {
        if (!st || typeof st !== 'object') continue;
        const calls = Number(st.calls ?? st.requests) || 0;
        if (calls <= 0) continue;
        rows.push({
          model,
          calls,
          success: Number(st.successes ?? st.success) || 0,
          failed: Number(st.failed) || 0,
          inTok: Number(st.in_tokens ?? st.input_tokens) || 0,
          outTok: Number(st.out_tokens ?? st.output_tokens) || 0,
        });
      }
    } else if (modelsMap) {
      for (const [model, count] of Object.entries(modelsMap)) {
        const c = Number(count) || 0;
        if (c <= 0) continue;
        rows.push({ model, calls: c, success: 0, failed: 0, inTok: 0, outTok: 0 });
      }
    }
    if (rows.length === 0) {
      container.innerHTML = '<div class="text-muted text-xs">暂无上报：节点在下一次配置同步时会上报它实际用到的模型。</div>';
      return;
    }
    rows.sort((a, b) => b.calls - a.calls);
    container.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>模型</th><th>调用</th><th>成功 / 失败</th><th>输入 / 输出 Token</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td>${eh(r.model)}</td>
          <td class="tabular">${r.calls}</td>
          <td class="tabular">${statsMap ? `${r.success} / ${r.failed}` : '-'}</td>
          <td class="tabular">${statsMap ? `${r.inTok} / ${r.outTok}` : '-'}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
  }

  // Scope entries that no longer match the current template options (providers/models
  // deleted on the hub since the node was scoped) have no checkbox to render. Preserve
  // them on save: dropping them silently would narrow the node's scope without the
  // operator seeing or choosing it.
  function staleScopeEntries(scopeArr, options) {
    return [...new Set((Array.isArray(scopeArr) ? scopeArr : []).filter((v) => v !== '*' && !options.includes(v)))];
  }

  // --- View: Unified Model Routing (U1, U5, M16) ---
  function renderModelsList() {
    const container = $('modelsList');
    if (!container) return;
    // 列表即将重建（innerHTML 替换）：挂在旧 DOM 上的菜单浮层会变成死元素，
    // 先关掉，别让它们留在 openMenus 里干扰 Esc。
    closeAllMenus();
    container.innerHTML = '';

    // 页面头的「新增模型路由」按钮与 create 编辑器互斥：编辑器开着时它变成
    // 「收起」（普通按钮），避免同一屏出现两个主按钮。
    const btnAddModel = $('btnAddModel');
    if (btnAddModel) {
      btnAddModel.classList.toggle('btn--primary', !state.creatingModel);
      btnAddModel.textContent = state.creatingModel ? '收起' : '添加模型';
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

    // 「新增模型路由」= 在列表顶部插入一个空白编辑器（create 模式），
    // 与编辑共用同一个构建函数（buildModelEditor）。
    if (state.creatingModel) {
      const createEditor = ce('div');
      createEditor.className = 'editor';
      createEditor.id = 'modelCreateEditor';
      container.appendChild(createEditor);
      // 先挂进 DOM 再接线：wireModelEditor() 用作用域查询找控件，
      // 元素没接上时点击处理器就绑不上。
      const built = buildModelEditor('', null, { create: true });
      createEditor.appendChild(built.wrap);
      wireModelEditor('', null, built);
    }

    if (orderedKeys.length === 0) {
      const filtered = Boolean(q);
      const empty = ce('div');
      empty.className = 'card-pad';
      const msg = ce('p');
      msg.className = 'text-muted';
      msg.textContent = filtered
        ? '没有匹配的模型'
        : '还没有模型：选一个供应商，挑它下面的一个模型，网关就能对外提供它';
      empty.appendChild(msg);
      if (!filtered && !state.creatingModel) {
        const btn = ce('button');
        btn.type = 'button';
        btn.className = 'btn btn--primary mt-3';
        btn.textContent = '添加模型';
        clk(btn, () => {
          closeOtherCreateEditors('models');
          state.creatingModel = true;
          state.activeEditorKey = null;
          renderModelsList();
        });
        empty.appendChild(btn);
      }
      container.appendChild(empty);
      return;
    }

    for (const mName of orderedKeys) {
      const m = models[mName];
      const cands = m.candidates || [];
      const cCount = cands.length;
      const isExpanded = state.activeEditorKey === `m_${mName}`;

      const row = ce('div');
      row.className = `row ${isExpanded ? 'expanded' : ''}`;

      // 一行只放有用的信息：模型名 + 它走哪些供应商。不放状态点、不放首字母头像 ——
      // 路由本身没有「健康」可言（健康在 Key 上），首字母也不携带任何信息。
      const who = ce('div');
      who.className = 'who';
      const provs = [...new Set(cands.map((c) => c.provider).filter(Boolean))];
      const subDesc = cCount === 0
        ? '还没有候选：点开加一个'
        : cCount === 1
          ? `${cands[0].provider || ''} · ${cands[0].target_model || mName}`
          : provs.join(' · ');
      who.innerHTML = `
        <div class="name"><span>${eh(mName)}</span></div>
        <div class="sub">${eh(subDesc)}</div>
      `;

      // 右侧：候选数；有 2 个以上候选（= 路由组）时带上策略名；停用时标「停用」。
      const fields = ce('div');
      fields.className = 'fields';
      const meta = [];
      if (m.enabled === false) meta.push('停用');
      if (cCount >= 2) meta.push(STRATEGY_LABELS[m.routing_strategy || 'sticky_failover'] || m.routing_strategy);
      meta.push(`${cCount} 个来源`);
      fields.innerHTML = `
        <span class="text-xs text-muted">${eh(meta.join(' · '))}</span>
        <span class="caret">▾</span>
      `;

      row.appendChild(who);
      row.appendChild(fields);

      clk(row, (ev) => {
        if (ev.target.closest('button') || ev.target.closest('input')) return;
        state.activeEditorKey = isExpanded ? null : `m_${mName}`;
        // 点行展开编辑时收起 create 编辑器（同一时刻只有一个编辑器）。
        state.creatingModel = false;
        renderModelsList();
      });

      container.appendChild(row);

      if (isExpanded) {
        const editor = ce('div');
        editor.className = 'editor';
        const built = buildModelEditor(mName, m);
        editor.appendChild(built.wrap);
        container.appendChild(editor);
        wireModelEditor(mName, m, built);
      }
    }
  }

  // 模型路由编辑器（组件 5 · .editor）：一个构建函数管完整个模型。
  // 新增（create）与编辑（edit）共用同一套字段、id 与保存逻辑，只有两处差别：
  //   · 新增时字段留空、无「删除」按钮；
  //   · 新增时「对外模型名」可留空（默认取第一个候选的上游模型 ID）。
  // 结构固定：基本字段（对外模型名 + 路由策略，两列网格）
  //          → 候选子表（供应商 · 上游模型 · Key · 思考档位 · 状态 · 排序/移除）
  //          → 「测试这个模型」
  //          → 「高级」折叠（指定 Key / 剥离思考 / 非流式 / Key 回退 / 权重 / 并发上限）
  //          → 底部 .form-actions--split：左删除（确认），右「取消」+「保存」。
  //
  // 模型名可能含点号 / 空格（历史 bug：把它塞进 CSS 选择器就会炸）——
  // 这里所有 id 都是静态的，模型名只作为普通文本出现，从不进选择器。
  function buildModelEditor(mName, m, opts = {}) {
    const isCreate = Boolean(opts.create);
    const wrap = ce('div');
    // 编辑时直接改现有路由对象；新增时先在草稿对象上改，保存时再落到 config。
    const draft = isCreate
      ? { enabled: true, routing_strategy: 'sticky_failover', active_key: '', candidates: [] }
      : m;
    draft.candidates = draft.candidates || [];
    const stratVal = draft.routing_strategy || 'sticky_failover';

    // 策略胶囊：平铺一行，值存在 data-strat 上，保存时读被选中的那个。
    const stratPill = (k) => `<button class="probe-pill${stratVal === k ? ' probe-pill--managed' : ''}" type="button" data-strat="${k}">${eh(k === 'sticky_failover' ? '会话粘性优先（推荐）' : STRATEGY_LABELS[k] || k)}</button>`;

    // 新增 = 从某个供应商挑一个模型（默认路径）；编辑 = 该模型的供应商列表 + 高级。
    // 路由组（多个候选之间分流）只在同一个模型名被第二个供应商提供时才出现，
    // 不作为新增入口 —— 见 wireModelEditor 的合并逻辑。
    if (isCreate) {
      wrap.innerHTML = `
        <div class="form-grid form-grid--2">
          ${fg('供应商', `<select class="select" id="ed_m_provider"><option value="">选择供应商</option></select>`)}
          ${fg('模型', `<div class="input-row"><input class="input input--code" id="ed_m_upstream" placeholder="上游模型 ID"><button class="btn" id="btn_m_probe" type="button">拉取模型</button></div><div class="probe-pills-wrap mt-1" id="m_probe_list"></div>`)}
          ${fg('Key', `<select class="select" id="ed_m_key"><option value="">任一启用 Key</option></select>`, '', '', '默认用该供应商下任一启用 Key')}
          ${fg('对外模型名', `<input class="input input--code" id="ed_m_name" placeholder="默认与上面的模型 ID 相同">`)}
        </div>
        <div class="text-xs text-muted mt-3">同一个模型名如果已经由另一个供应商提供，添加时会自动并入那条模型，作为故障转移的第二个来源。</div>
        <div class="form-actions form-actions--split mt-4">
          <div class="form-actions-group"></div>
          <div class="form-actions-group">
            <button class="btn" id="btn_cancel_model" type="button">取消</button>
            <button class="btn btn--primary" id="btn_save_model" type="button">添加模型</button>
          </div>
        </div>
      `;
      return { wrap, draft, isCreate };
    }

    // 结构：对外模型名 → 候选表 → 路由组参数（≥2 个候选才出现）→ 测试 → 高级 → 底栏。
    // 一个对外模型名挂多个候选（不同供应商 / 同一供应商不同 Key）= 路由组；
    // 只有一个候选时没有「怎么分流」可选，策略区藏起来。
    wrap.innerHTML = `
      ${fg('对外模型名', `<input class="input input--code" id="ed_m_name" value="${eh(isCreate ? '' : mName)}" placeholder="留空则用第一个候选的上游模型 ID">`, '', '', '客户端调用时填的 model 名；新增和编辑都能改')}
      <div class="section-bar mt-4">
        <span class="form-label">供应商来源</span>
        <button class="btn btn--sm" id="btn_add_cand" type="button">＋ 再加一个供应商</button>
      </div>
      <div class="table-wrap"><table class="data-table m-cand-table">
        <thead><tr><th>供应商</th><th>上游模型</th><th>Key</th><th>状态</th><th>思考档位</th><th></th></tr></thead>
        <tbody id="m_cand_body"></tbody>
      </table></div>
      <div class="mt-3 hidden" id="m_add_cand_box" hidden></div>
      <div class="m-group mt-4" id="m_group_box" hidden>
        <div class="section-bar"><span class="form-label">多个供应商之间怎么分流</span></div>
        <div class="probe-pills-wrap">${['sticky_failover', 'round_robin', ...ADVANCED_STRATEGIES].map(stratPill).join('')}</div>
        <div class="text-xs text-muted mt-1" id="ed_m_strat_desc">${eh(STRATEGY_HINTS[stratVal] || '')}</div>
        <div id="m_ca" class="mt-2"></div>
      </div>
      <div class="section-bar mt-4"><span class="form-label">测试</span></div>
      <div class="input-row">
        <select class="select" id="m_test_cand" aria-label="测试哪个候选"></select>
        <select class="select" id="m_test_key" aria-label="用哪个 Key 测试"></select>
        <button class="btn" id="m_test_send" type="button">发送「你好」</button>
        <button class="btn" id="m_test_all" type="button" title="逐个测试候选列表里的每一个候选（真实推理），并刷新状态列">测试全部候选</button>
      </div>
      <div class="m-test-out" id="m_test_out" hidden></div>
      <details class="headers-details mt-4">
        <summary class="form-label">高级（钉死 Key / Key 回退 / 剥离思考 / 非流式）</summary>
        <div class="form-grid form-grid--2 mt-2">
          ${fg('钉死到某把 Key', `<input class="input input--code" id="ed_m_act" value="${eh(draft.active_key || '')}" placeholder="供应商:Key标签（留空 = 按策略选）">`)}
          <div class="form-group">
            <label class="form-label form-label--check"><input type="checkbox" id="ed_m_keyfb" ${draft.allow_key_fallback ? 'checked' : ''}><span>指定的 Key 不可用时回退同供应商其它 Key</span></label>
            <label class="form-label form-label--check"><input type="checkbox" id="ed_m_noreas" ${draft.no_reasoning ? 'checked' : ''}><span>剥离思考 / 推理参数</span></label>
            <label class="form-label form-label--check"><input type="checkbox" id="ed_m_nonstream" ${draft.force_non_stream ? 'checked' : ''}><span>强制非流式（stream=false）</span></label>
          </div>
        </div>
      </details>
      <div class="form-actions form-actions--split mt-4">
        <div class="form-actions-group">${isCreate ? '' : '<button class="btn btn--danger" id="btn_del_model" type="button">删除此模型</button>'}</div>
        <div class="form-actions-group">
          <button class="btn" id="btn_cancel_model" type="button">取消</button>
          <button class="btn btn--primary" id="btn_save_model" type="button">${isCreate ? '保存路由' : '保存'}</button>
        </div>
      </div>
    `;
    return { wrap, draft, isCreate };
  }

  // 「＋ 添加候选」：在编辑器里就地展开一行内联选择（不弹框、不进抽屉）。
  // 供应商下拉沿用 .np-combo / .np-panel 规范：浮层贴着输入框整行宽度浮起，
  // 搜索框钉在顶部、只有选项列表滚动。选好供应商后可「拉取上游模型」，
  // 勾选模型与 Key，再「添加候选」落进候选子表。
  function wireAddCandidatePanel(host, ctx) {
    const q = makeScopedQuery(host);
    const box = q('#m_add_cand_box');
    const addBtn = q('#btn_add_cand');
    if (!box || !addBtn) return;

    let provId = '';
    let pickedModels = new Set();
    let pickedKeys = new Set();

    box.innerHTML = `
      <div class="card card-pad">
        <div class="form-grid">
          <div class="form-group form-group--full">
            <label class="form-label" for="m_ac_prov">供应商${fieldHint('只能选已存在的供应商')}</label>
            <div class="np-combo">
              <input class="input input--code" id="m_ac_prov" role="combobox" autocomplete="off" placeholder="选择供应商">
              <div class="card np-panel hidden" id="m_ac_panel" hidden>
                <div class="np-panel-search"><input class="input" id="m_ac_search" placeholder="搜索供应商"></div>
                <div class="np-panel-options" id="m_ac_options" role="listbox"></div>
              </div>
            </div>
          </div>
          <div class="form-group form-group--full">
            <label class="form-label" for="m_ac_target">上游模型</label>
            <div class="fields">
              <button class="btn btn--sm" id="m_ac_probe" type="button" disabled>拉取上游模型</button>
              <input class="input input--code" id="m_ac_target" placeholder="上游模型 ID（可手填）">
              <input class="input input--code" id="m_ac_filter" placeholder="过滤已拉取的模型…">
            </div>
            <div class="probe-pills-wrap" id="m_ac_models"></div>
            <div class="text-xs text-muted mt-1 hidden" id="m_ac_cap" hidden></div>
          </div>
          <div class="form-group form-group--full">
            <label class="form-label">Key</label>
            <div class="probe-pills-wrap" id="m_ac_keys"></div>
          </div>
        </div>
        <div class="form-actions">
          <div class="form-actions-group"></div>
          <div class="form-actions-group">
            <button class="btn" id="m_ac_cancel" type="button">取消</button>
            <button class="btn" id="m_ac_ok" type="button">添加候选</button>
          </div>
        </div>
      </div>
    `;

    const provInput = q('#m_ac_prov');
    const panel = q('#m_ac_panel');
    const options = q('#m_ac_options');
    const search = q('#m_ac_search');
    const modelsBox = q('#m_ac_models');
    const keysBox = q('#m_ac_keys');
    const targetInput = q('#m_ac_target');
    const probeBtn = q('#m_ac_probe');

    const closePanel = () => toggle(panel, false);

    const syncOptions = () => {
      if (!options) return;
      const f = String(search?.value || '').trim().toLowerCase();
      const provs = state.config?.providers || {};
      const ids = Object.keys(provs).sort().filter((pId) => {
        if (!f) return true;
        const p = provs[pId] || {};
        return `${pId} ${p.name || ''} ${p.base_url || ''}`.toLowerCase().includes(f);
      });
      options.innerHTML = '';
      if (ids.length === 0) {
        options.innerHTML = '<div class="row row--static text-xs text-muted">无匹配供应商（请先在供应商页添加）</div>';
        return;
      }
      ids.forEach((pId) => {
        const p = provs[pId] || {};
        const rowBtn = ce('button');
        rowBtn.type = 'button';
        rowBtn.className = 'row';
        rowBtn.setAttribute('role', 'option');
        rowBtn.innerHTML = `<div class="who"><div class="name">${eh(p.name || pId)}</div><div class="text-xs text-muted">${eh(p.base_url || '')}</div></div>`;
        // mousedown 阻止默认：焦点不从搜索框跳走，点击才会落到这一行上。
        rowBtn.addEventListener('mousedown', (e) => e.preventDefault());
        clk(rowBtn, () => {
          provId = pId;
          if (provInput) provInput.value = pId;
          closePanel();
          // 换供应商 = 换一整套候选池：已选的模型与 Key 都作废。
          pickedModels = new Set();
          pickedKeys = new Set();
          if (targetInput) targetInput.value = '';
          const filterEl = q('#m_ac_filter');
          if (filterEl) filterEl.value = '';
          drawKeys();
          drawModels();
          updateCandCapability();
          if (probeBtn) probeBtn.disabled = false;
        });
        options.appendChild(rowBtn);
      });
    };

    const showPanel = () => {
      syncOptions();
      toggle(panel, true);
      search?.focus();
    };

    provInput?.addEventListener('focus', () => { if (panel.hidden) showPanel(); });
    provInput?.addEventListener('click', () => { if (panel.hidden) showPanel(); });
    search?.addEventListener('input', syncOptions);
    provInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        e.stopPropagation();
        closePanel();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (panel.hidden) showPanel();
        panel.querySelector('button.row')?.focus();
      }
    });
    panel?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        e.stopPropagation();
        closePanel();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = [...panel.querySelectorAll('button.row')];
      if (rows.length === 0) return;
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement);
      (e.key === 'ArrowDown' ? rows[idx + 1] || rows[0] : rows[idx - 1] || rows[rows.length - 1])?.focus();
    });
    // 点浮层外面收起。面板在 .np-combo 里，落在 combo 内的点击不关。
    document.addEventListener('pointerdown', (e) => {
      if (!panel || panel.hidden) return;
      const combo = panel.closest('.np-combo');
      if (combo && !combo.contains(e.target)) closePanel();
    });

    // 已拉取的模型列表：按「过滤」框缩小范围，再点胶囊多选。
    // 函数声明（不是 const 箭头）：syncOptions 的点击回调里会用到它，
    // 函数声明会被提升，不存在 TDZ 陷阱。
    function drawModels() {
      if (!modelsBox) return;
      const all = state.probedModelsByProvider[provId] || [];
      const f = String(q('#m_ac_filter')?.value || '').trim().toLowerCase();
      const models = f ? all.filter((mo) => String(mo).toLowerCase().includes(f)) : all;
      if (all.length === 0) {
        modelsBox.innerHTML = '<span class="text-xs text-muted">还没有探测数据：点「拉取上游模型」，或直接手填上游模型 ID</span>';
        return;
      }
      if (models.length === 0) {
        modelsBox.innerHTML = `<span class="text-xs text-muted">没有匹配「${eh(f)}」的上游模型</span>`;
        return;
      }
      modelsBox.innerHTML = models.map((mo) => `<button class="probe-pill${pickedModels.has(mo) ? ' probe-pill--managed' : ''}" type="button" data-mo="${eh(mo)}">${eh(mo)}</button>`).join('');
    }
    clk(modelsBox, (ev) => {
      const pill = ev.target instanceof Element ? ev.target.closest('button[data-mo]') : null;
      if (!pill) return;
      const mo = pill.dataset.mo;
      if (pickedModels.has(mo)) pickedModels.delete(mo);
      else pickedModels.add(mo);
      pill.classList.toggle('probe-pill--managed', pickedModels.has(mo));
      // 勾选模型时把它带进「上游模型 ID」输入框（可直接改）。
      if (targetInput && !targetInput.value) targetInput.value = mo;
    });
    // 过滤框输入只重画胶囊，不动已勾选的模型。
    q('#m_ac_filter')?.addEventListener('input', drawModels);

    // 上游模型能力摘要（上下文 / 最大输出 / 思考档位）。Hub 没有推理引擎，
    // 目录也没有意义 —— 那里直接不显示。
    function updateCandCapability() {
      const box = q('#m_ac_cap');
      if (!box) return;
      if (window.HOST.kind === 'hub') {
        box.hidden = true;
        box.classList.add('hidden');
        box.textContent = '';
        return;
      }
      const target = String(targetInput?.value || '').trim();
      if (!provId || !target) {
        box.hidden = true;
        box.classList.add('hidden');
        box.textContent = '';
        return;
      }
      fetchModelInfo(presetIdForProvider(provId), target).then((info) => {
        if (!box.isConnected) return;
        if (String(targetInput?.value || '').trim() !== target) return;
        box.textContent = capabilitySummary(info);
        box.hidden = false;
        box.classList.remove('hidden');
      });
    }
    targetInput?.addEventListener('input', updateCandCapability);

    function drawKeys() {
      if (!keysBox) return;
      const prov = state.config?.providers?.[provId] || {};
      const keys = (prov.api_keys || []).filter((k) => k && k.enabled !== false);
      if (!provId || keys.length === 0) {
        keysBox.innerHTML = `<span class="text-xs text-muted">${provId ? '该供应商没有已启用的 Key' : '请先选择供应商'}</span>`;
        return;
      }
      const anyBtn = ce('button');
      anyBtn.type = 'button';
      anyBtn.className = `probe-pill${pickedKeys.size === 0 ? ' probe-pill--managed' : ''}`;
      anyBtn.textContent = '任一 Key';
      clk(anyBtn, () => {
        pickedKeys = new Set();
        drawKeys();
      });
      keysBox.innerHTML = '';
      keysBox.appendChild(anyBtn);
      keys.forEach((k, idx) => {
        const label = k.label || k.id || `key-${idx}`;
        const pill = ce('button');
        pill.type = 'button';
        pill.dataset.key = label;
        pill.className = `probe-pill${pickedKeys.has(label) ? ' probe-pill--managed' : ''}`;
        pill.textContent = label;
        clk(pill, () => {
          if (pickedKeys.has(label)) pickedKeys.delete(label);
          else pickedKeys.add(label);
          pill.classList.toggle('probe-pill--managed', pickedKeys.has(label));
          anyBtn.classList.toggle('probe-pill--managed', pickedKeys.size === 0);
        });
        keysBox.appendChild(pill);
      });
    }

    clk(probeBtn, async () => {
      if (!provId) return toast('请先选择供应商', 'warn');
      const p = state.config?.providers?.[provId] || {};
      probeBtn.disabled = true;
      const old = probeBtn.textContent;
      probeBtn.textContent = '拉取中…';
      try {
        const res = await window.HOST.probeModels({
          provider: provId,
          base_url: p.base_url || '',
          api_type: normalizeApiType(p.api_type),
        });
        const models = Array.isArray(res?.models) ? res.models : [];
        if (models.length > 0) {
          state.probedModelsByProvider[provId] = models;
          drawModels();
          toast(`拉取到 ${models.length} 个上游模型`, 'ok');
        } else {
          const msg = res?.error ? `未拉取到模型: ${scrubUiText(res.error)}` : '未拉取到可用模型，可手填上游模型 ID';
          toast(msg, 'warn');
        }
      } catch (e) {
        toast(`拉取异常: ${scrubUiText(e.message)}`, 'err');
      } finally {
        probeBtn.disabled = false;
        probeBtn.textContent = old;
      }
    });

    const closeBox = () => {
      toggle(box, false);
      closePanel();
    };

    clk(addBtn, () => {
      const willOpen = box.hidden;
      toggle(box, willOpen);
      if (willOpen) {
        provId = '';
        pickedModels = new Set();
        pickedKeys = new Set();
        if (provInput) provInput.value = '';
        if (targetInput) targetInput.value = '';
        const filterEl = q('#m_ac_filter');
        if (filterEl) filterEl.value = '';
        const capBox = q('#m_ac_cap');
        if (capBox) {
          capBox.hidden = true;
          capBox.classList.add('hidden');
          capBox.textContent = '';
        }
        if (probeBtn) probeBtn.disabled = true;
        drawModels();
        drawKeys();
      }
    });
    clk(q('#m_ac_cancel'), closeBox);

    clk(q('#m_ac_ok'), () => {
      if (!provId) return toast('请选择供应商', 'warn');
      if (!state.config?.providers?.[provId]) return toast(`供应商 ${provId} 不存在，请先在供应商页创建`, 'warn');
      const manual = String(targetInput?.value || '').trim();
      const models = [...pickedModels];
      if (manual && !models.includes(manual)) models.push(manual);
      if (models.length === 0) return toast('请勾选或手填上游模型', 'warn');
      // 勾了多把 Key 就「每个模型 × 每把 Key」生成一个候选；没勾 = 任一 Key（一个候选）。
      const keyLabels = [...pickedKeys];
      for (const model of models) {
        if (keyLabels.length === 0) {
          ctx.candidates.push({ provider: provId, key_label: '', target_model: model, enabled: true, weight: 1, max_concurrency: 0 });
          continue;
        }
        for (const kl of keyLabels) {
          ctx.candidates.push({ provider: provId, key_label: kl, target_model: model, enabled: true, weight: 1, max_concurrency: 0 });
        }
      }
      closeBox();
      ctx.redraw();
    });
  }

  // 模型路由编辑器的事件接线（buildModelEditor 只出结构）。
  // 新增与编辑共用同一套接线：保存读的是同一批静态 id，字段与后端契约一一对应。
  function wireModelEditor(mName, m, built) {
    const { wrap, draft, isCreate } = built;
    const q = makeScopedQuery(wrap);
    const candidates = draft.candidates;

    // 新增：只做「供应商 → 模型 → Key」三件事。保存时把它折成一个候选，
    // 后面与编辑路径共用同一段保存逻辑（同名且不同供应商会自动并入）。
    if (isCreate) {
      const provSel = q('#ed_m_provider');
      const keySel = q('#ed_m_key');
      const upInput = q('#ed_m_upstream');
      const probeList = q('#m_probe_list');
      const provs = Object.entries(state.config?.providers || {})
        .filter(([, p]) => p && p.enabled !== false)
        .sort((a, b) => a[0].localeCompare(b[0]));
      if (provSel) {
        provSel.innerHTML = ['<option value="">选择供应商</option>']
          .concat(provs.map(([id, p]) => `<option value="${eh(id)}">${eh(p.name || id)}</option>`))
          .join('');
      }
      const fillKeys = () => {
        if (!keySel) return;
        const prov = state.config?.providers?.[provSel?.value || ''] || {};
        const keys = (prov.api_keys || []).filter((k) => k && (k.label || k.id));
        keySel.innerHTML = ['<option value="">任一启用 Key</option>']
          .concat(keys.map((k) => {
            const lbl = String(k.label || k.id);
            const off = k.enabled === false ? '（已禁用）' : '';
            return `<option value="${eh(lbl)}">${eh(lbl)}${off}</option>`;
          })).join('');
      };
      provSel?.addEventListener('change', () => { fillKeys(); if (probeList) probeList.innerHTML = ''; });
      fillKeys();
      q('#btn_m_probe')?.addEventListener('click', async () => {
        const pId = provSel?.value || '';
        if (!pId) return toast('请先选择供应商', 'warn');
        const p = state.config?.providers?.[pId] || {};
        const btn = q('#btn_m_probe');
        const old = btn.textContent;
        btn.disabled = true; btn.textContent = '拉取中…';
        try {
          const res = await window.HOST.probeModels({ provider: pId, base_url: p.base_url || '', api_type: normalizeApiType(p.api_type) });
          const models = Array.isArray(res?.models) ? res.models : [];
          if (!models.length) {
            toast(res?.error ? `未拉取到模型：${scrubUiText(res.error)}` : '未拉取到模型，可直接手填模型 ID', 'warn');
            return;
          }
          if (probeList) {
            probeList.innerHTML = models.map((mo) => `<button class="probe-pill" type="button" data-mo="${eh(mo)}">${eh(mo)}</button>`).join('');
          }
          toast(`拉取到 ${models.length} 个模型`, 'ok');
        } catch (e) {
          toast(`拉取异常：${scrubUiText(e.message)}`, 'err');
        } finally {
          btn.disabled = false; btn.textContent = old;
        }
      });
      probeList?.addEventListener('click', (ev) => {
        const pill = ev.target instanceof Element ? ev.target.closest('button[data-mo]') : null;
        if (!pill || !upInput) return;
        upInput.value = pill.dataset.mo || '';
        [...probeList.querySelectorAll('button[data-mo]')].forEach((b) => b.classList.toggle('probe-pill--managed', b === pill));
      });
      clk(q('#btn_cancel_model'), () => {
        state.creatingModel = false;
        renderModelsList();
      });
    }

    // 路由策略胶囊：平铺一行，点一下换选中项，说明行同步换成这个策略的
    // 「它做什么 / 什么时候用」。选中值靠 .probe-pill--managed 标记，
    // 保存时读被标记的那一个。
    const stratDesc = q('#ed_m_strat_desc');
    const stratPills = [...wrap.querySelectorAll('button[data-strat]')];
    stratPills.forEach((btn) => {
      clk(btn, () => {
        stratPills.forEach((b) => b.classList.toggle('probe-pill--managed', b === btn));
        // 同时写进草稿：DOM 上的 --managed 只是渲染态，drawAdv() 重绘参数表、
        // addCandidate 重建候选行之后都可能丢失；保存时读草稿就不会存成旧策略
        // （2026-11-27 实测：设成 weighted + 3/7 + 5/0，存进去却是 sticky/1/1/0）。
        draft.routing_strategy = btn.dataset.strat || 'sticky_failover';
        if (stratDesc) stratDesc.textContent = STRATEGY_HINTS[btn.dataset.strat || ''] || '';
        // 切到 / 切离「按权重比例分摊」时权重列要出现 / 消失。
        drawAdv();
      });
    });

    // 每个候选的 Key 绑定：下拉里第一项是「任一」（= 展开该供应商全部启用 Key），
    // 其后是这个供应商真实存在的 Key 标签。候选自带的具体绑定会被选中。
    const candKeyOptions = (c) => {
      const prov = state.config?.providers?.[c.provider] || {};
      const keys = (prov.api_keys || []).filter((k) => k && (k.label || k.id));
      const wanted = String(c.key_label || '');
      const opts = [`<option value=""${wanted ? '' : ' selected'}>任一</option>`];
      for (const k of keys) {
        const label = String(k.label || k.id);
        const off = k.enabled === false ? '（已禁用）' : '';
        opts.push(`<option value="${eh(label)}"${label === wanted ? ' selected' : ''}>${eh(label)}${off}</option>`);
      }
      // 已绑定但本地已没有的 Key 标签：仍然显示出来，别静默改成「任一」。
      if (wanted && !keys.some((k) => String(k.label || k.id) === wanted)) {
        opts.push(`<option value="${eh(wanted)}" selected>${eh(wanted)}（本地缺失）</option>`);
      }
      return opts.join('');
    };

    // 候选状态（加回的「状态」列）：取该候选 供应商:Key 的冷却状态
    // （state.cooldownsAll，条目 target = p:<provider>:k:<key>[:m:<model>]）与
    // Key 的 last_test：冷却 Xs / 可用 · 120ms / 失败 · … / 未测。
    // 「任一 Key」（key_label 空）取该供应商 Key 里最好的一个（有可用取最快可用，
    // 否则取第一个非冷却的，再退到第一把）。
    const candCooldownSec = (pId, keyLabel) => {
      let best = 0;
      const prefix = `p:${pId}:k:${keyLabel}`;
      for (const entry of state.cooldownsAll || []) {
        const t = String(entry?.target || '');
        if ((t === prefix || t.startsWith(`${prefix}:`)) && (entry.remaining_sec || 0) > best) {
          best = entry.remaining_sec || 0;
        }
      }
      return best;
    };
    const pickBestKey = (prov) => {
      const keys = (prov.api_keys || []).filter((k) => k && k.enabled !== false);
      if (keys.length === 0) return null;
      const usable = keys.filter((k) => candCooldownSec(prov.id || '', k.label || k.id || '') === 0 && keyHealthFlag(k) !== false);
      const pool = usable.length ? usable : keys.filter((k) => candCooldownSec(prov.id || '', k.label || k.id || '') === 0);
      const src = pool.length ? pool : keys;
      return src.reduce((bestK, k) => {
        if (!bestK) return k;
        const a = Number(k.last_test?.latency_ms) || Infinity;
        const b = Number(bestK.last_test?.latency_ms) || Infinity;
        return a < b ? k : bestK;
      }, null);
    };
    const candStatusHtml = (c) => {
      const prov = state.config?.providers?.[c.provider];
      if (!prov) return '<span class="text-xs text-muted">供应商不存在</span>';
      const keyLabel = String(c.key_label || '');
      const k = keyLabel
        ? (prov.api_keys || []).find((x) => x && (x.label || x.id) === keyLabel) || null
        : pickBestKey(prov);
      if (!k) return '<span class="text-xs text-muted">无可用 Key</span>';
      const cd = candCooldownSec(c.provider, k.label || k.id || '');
      if (cd > 0) {
        return `<span class="fields" title="候选绑定 Key 正在冷却"><span class="dot dot--warn"></span><span class="text-xs text-muted">冷却 ${eh(formatCooldown(cd))}</span></span>`;
      }
      const lt = k.last_test;
      if (lt && typeof lt === 'object') {
        if (lt.ok) {
          return `<span class="fields" title="${eh(String(lt.reply_text || '').trim() || '上游返回 200')}"><span class="dot dot--ok"></span><span class="text-xs text-muted">可用 · ${eh(String(Number(lt.latency_ms) || 0))}ms</span></span>`;
        }
        return `<span class="fields" title="${eh(String(lt.error || '上游无响应'))}"><span class="dot dot--err"></span><span class="text-xs text-muted">失败${Number(lt.status) ? ` · ${eh(String(lt.status))}` : ''}</span></span>`;
      }
      if (keyHealthFlag(k) === true) return '<span class="fields"><span class="dot dot--ok"></span><span class="text-xs text-muted">正常</span></span>';
      if (keyHealthFlag(k) === false) return '<span class="fields"><span class="dot dot--err"></span><span class="text-xs text-muted">异常</span></span>';
      return '<span class="fields"><span class="dot dot--warn"></span><span class="text-xs text-muted">未测</span></span>';
    };

    const drawCands = () => {
      const body = q('#m_cand_body');
      if (!body) return;
      if (candidates.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="text-muted">还没有候选：点「＋ 添加候选」挑一个供应商与上游模型</td></tr>';
        return;
      }
      const multi = candidates.length > 1;
      body.innerHTML = candidates.map((c, i) => `<tr data-i="${i}">
          <td>${eh(c.provider || '')}</td>
          <td><span class="input--code">${eh(c.target_model || mName)}</span></td>
          <td><select class="select select--compact" data-key aria-label="这个候选用哪把 Key">${candKeyOptions(c)}</select></td>
          <td id="m_cand_st_${i}">${candStatusHtml(c)}</td>
          <td><span class="m-cand-eff" id="m_cand_eff_${i}"></span></td>
          <td>
            <div class="fields m-cand-ops">
              ${multi ? `<button class="btn btn--sm btn--ghost" data-a="u" type="button" title="上移"${i ? '' : ' disabled'}>↑</button><button class="btn btn--sm btn--ghost" data-a="d" type="button" title="下移"${i === candidates.length - 1 ? ' disabled' : ''}>↓</button>` : ''}
              <button class="btn btn--sm btn--ghost btn--danger" data-a="r" type="button" title="移除此候选">移除</button>
            </div>
          </td>
        </tr>`).join('');
      candidates.forEach((c, i) => fillCandEffort(i, c));
    };

    // 「测试全部候选」：逐个用现有测试接口（POST /api/admin/test-key，同
    // 「发送「你好」」一条路）测每个候选，每把候选测完立刻更新状态列。
    // 逐把串行：与「一键测全部 Key」一致，避免并发把上游打挂。
    const refreshCandStatusCell = (i) => {
      const cell = q(`#m_cand_st_${i}`);
      const c = candidates[i];
      if (cell && c) cell.innerHTML = candStatusHtml(c);
    };
    clk(q('#m_test_all'), async () => {
      const btn = q('#m_test_all');
      const out = q('#m_test_out');
      if (!btn || btn.disabled) return;
      if (candidates.length === 0) {
        if (out) {
          out.hidden = false;
          out.className = 'm-test-out m-test-out--err';
          out.textContent = '先在候选列表里加一个候选，再测试。';
        }
        return;
      }
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = `测试中 0/${candidates.length}`;
      // 与「发送「你好」」同样的竞态保护：test-key 落盘会让本页版本号落后，
      // 期间禁掉「保存路由」。
      const saveBtn = q('#btn_save_model');
      if (saveBtn) saveBtn.disabled = true;
      let okCount = 0;
      try {
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          if (!c || !c.provider) continue;
          btn.textContent = `测试中 ${i + 1}/${candidates.length}`;
          if (out) {
            out.hidden = false;
            out.className = 'm-test-out';
            out.innerHTML = `<div class="gw-test-meta">[${i + 1}/${candidates.length}] 正在测试 ${eh(c.provider)} / ${eh(c.target_model || mName)} …</div>`;
          }
          try {
            const res = await window.HOST.testKey({
              provider: c.provider,
              key_label: String(c.key_label || ''),
              model: String(c.target_model || mName).trim(),
            });
            await refreshConfigVersion();
            // 结论落到 Key 上（「保存」持久化），状态列立刻反映。
            const provKeys = state.config?.providers?.[c.provider]?.api_keys || [];
            const verdictKey = provKeys.find((k) => k && (k.label || k.id) === (c.key_label || res?.key_label))
              || (c.key_label ? null : pickBestKey(state.config?.providers?.[c.provider] || {}));
            if (verdictKey) applyKeyLastTest(verdictKey, res);
            if (res && res.valid === true) okCount++;
          } catch (err) {
            toast(`候选 ${c.provider} 测试异常: ${scrubUiText(err?.message || String(err))}`, 'err');
          }
          refreshCandStatusCell(i);
          drawTestCandidates();
        }
        if (out && out.isConnected) {
          out.className = `m-test-out${okCount === candidates.length ? ' m-test-out--ok' : ' m-test-out--err'}`;
          out.innerHTML = `<div class="gw-test-meta">全部候选测试完成：${okCount}/${candidates.length} 可用</div>`;
        }
      } finally {
        btn.disabled = false;
        btn.textContent = label;
        if (saveBtn) saveBtn.disabled = false;
        redraw();
      }
    });

    // 思考档位是 per-candidate 的：模型目录的档位阶梯是模型级的，答案来自
    // models.dev 目录（异步），没到之前这一格留空，而不是显示可能被误认成真值的占位符。
    const effortControlHtml = (c, info) => {
      const current = String(c.reasoning_effort || '');
      const follow = '<option value="">跟随客户端</option>';
      // 目录里查不到这个模型（中转商自定义名常见）：只给「跟随客户端」，不写「能力信息未知」——
      // 这一列是「能不能选档位」，查不到就是没得选，不需要一句提示占位。
      if (!info || info.ok === false || !info.found) {
        return '<span class="text-xs text-muted">—</span>';
      }
      const efforts = Array.isArray(info.efforts) ? info.efforts.filter(Boolean) : [];
      if (efforts.length > 0) {
        // 旧目录里存过的档位即使目录不再提供也保留可见：改动必须是显式的，不能静默改写。
        const extra = current && !efforts.includes(current) && current !== 'on' && current !== 'off'
          ? `<option value="${eh(current)}" selected>${eh(current)}（当前已保存）</option>`
          : '';
        const opts = efforts.map((lv) => `<option value="${eh(lv)}"${lv === current ? ' selected' : ''}>${eh(lv)}</option>`).join('');
        return `<select class="select select--compact" data-eff aria-label="思考档位">${follow}${extra}${opts}</select>`;
      }
      if (info.supports_toggle || info.toggle) {
        // 只有开关没有阶梯的模型：可选项就是 强制开 / 强制关 / 跟随客户端。
        return `<select class="select select--compact" data-eff aria-label="思考开关">${follow}`
          + `<option value="on"${current === 'on' ? ' selected' : ''}>强制开启</option>`
          + `<option value="off"${current === 'off' ? ' selected' : ''}>强制关闭</option></select>`;
      }
      return '<span class="text-xs text-muted">该模型无思考档位</span>';
    };

    const fillCandEffort = (i, c) => {
      const box = q(`#m_cand_eff_${i}`);
      if (!box || !c) return;
      const preset = presetIdForProvider(c.provider);
      const model = String(c.target_model || '').trim();
      if (!preset || !model) {
        box.innerHTML = '';
        return;
      }
      fetchModelInfo(preset, model).then((info) => {
        // 候选表可能已重排 / 重绘：过期的查询结果不能写进别人的格子。
        if (!box.isConnected || candidates[i] !== c) return;
        box.innerHTML = effortControlHtml(c, info);
      });
    };

    // 路由组参数：≥2 个候选才有意义（一个候选没有「分给谁」可选）。
    // 权重只在「按权重比例分摊」下生效，并发上限任何策略都生效。
    const drawAdv = () => {
      const group = q('#m_group_box');
      const box = q('#m_ca');
      const multi = candidates.length > 1;
      if (group) group.hidden = !multi;
      if (!box || !multi) return;
      const strat = wrap.querySelector('button[data-strat].probe-pill--managed')?.dataset.strat || draft.routing_strategy || 'sticky_failover';
      const showWeight = strat === 'weighted';
      box.innerHTML = `<table class="data-table m-group-table"><thead><tr><th>候选</th>${showWeight ? '<th>权重</th>' : ''}<th>并发上限</th></tr></thead><tbody>${candidates.map((c, i) => `<tr><td>${eh(c.provider || '')} · <span class="input--code">${eh(c.target_model || mName)}</span>${c.key_label ? ` · ${eh(c.key_label)}` : ''}</td>${showWeight ? `<td><input class="input input--compact tabular" data-w="${i}" type="number" min="1" value="${c.weight || 1}" aria-label="权重"></td>` : ''}<td><input class="input input--compact tabular" data-x="${i}" type="number" min="0" value="${c.max_concurrency || 0}" aria-label="并发上限（0 = 不限）"></td></tr>`).join('')}</tbody></table><div class="text-xs text-muted mt-1">并发上限 0 = 不限${showWeight ? '；权重越大分到的请求越多' : ''}</div>`;
    };

    // 测试面板：换候选 → 换 Key 清单。
    // 操作者选「哪个候选（供应商 + 上游模型）」与「用哪把 Key」，然后拿到上游真实回复。
    // 这是供应商页 per-key 测试的模型级对应物：那边问「这把 Key 活着吗」，
    // 这边问「这个模型在这把 Key 上答不答得上」—— 正是会承载流量的那个三元组。
    const drawTestCandidates = () => {
      const sel = q('#m_test_cand');
      const keySel = q('#m_test_key');
      if (!sel) return;
      // 重绘必须保留当前选中的候选。以前每次重建 option 都把 value 丢回 0，
      // 于是「选中第二个候选 → 换 Key 清单 → 点发送」实际打的是第一个候选
      // （2026-11-27 实测连试 4 次都被重置成 0）。
      const prevSel = String(sel.value ?? '');
      sel.innerHTML = candidates.length
        ? candidates.map((c, i) => `<option value="${i}">${eh(`${c.provider} / ${c.target_model || mName}`)}</option>`).join('')
        : '<option value="0">（还没有候选）</option>';
      if (candidates.length && prevSel !== '' && Number(prevSel) < candidates.length) {
        sel.value = prevSel;
      }
      if (!keySel) return;
      const c = candidates[Number(sel.value) || 0];
      if (!c || !c.provider) {
        keySel.innerHTML = '';
        return;
      }
      const prov = state.config?.providers?.[c.provider] || {};
      const keys = (prov.api_keys || []).filter((k) => k && (k.label || k.id));
      const wanted = String(c.key_label || '');
      keySel.innerHTML = ['<option value="">任一启用 Key</option>'].concat(
        keys.map((k) => {
          const label = String(k.label || k.id);
          const off = k.enabled === false ? '（已禁用）' : '';
          return `<option value="${eh(label)}"${label === wanted ? ' selected' : ''}>${eh(label)}${off}</option>`;
        })
      ).join('');
      // 候选没有指定 Key 时：预选第一把启用的 Key，让操作者看得见这次会花哪把凭据。
      if (!wanted) {
        const firstEnabled = keys.find((k) => k.enabled !== false);
        if (firstEnabled) keySel.value = String(firstEnabled.label || firstEnabled.id);
      }
    };

    const redraw = () => {
      drawCands();
      drawAdv();
      drawTestCandidates();
    };
    redraw();

    // 候选行的事件：上移 / 下移 / 移除（委托，子表重绘后仍有效）。
    clk(q('#m_cand_body'), (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('button[data-a]') : null;
      if (!btn) return;
      const i = Number(btn.closest('[data-i]')?.dataset.i);
      const a = btn.dataset.a;
      if (a === 'u' && i > 0) {
        [candidates[i], candidates[i - 1]] = [candidates[i - 1], candidates[i]];
        redraw();
      } else if (a === 'd' && i < candidates.length - 1) {
        [candidates[i], candidates[i + 1]] = [candidates[i + 1], candidates[i]];
        redraw();
      } else if (a === 'r') {
        candidates.splice(i, 1);
        redraw();
      }
    });
    // 思考档位直接写在候选上：'' = 跟随客户端（保存时省略该字段）。
    // "on"/"off" 是只有开关的模型。调度侧如何把它变成请求体不在本阶段范围内 ——
    // 值已存储，是否真正下发由后端契约决定。
    // 同一委托还处理 Key 绑定：'' = 任一 Key（展开该供应商全部启用 Key）。
    q('#m_cand_body')?.addEventListener('change', (ev) => {
      const el = ev.target instanceof Element ? ev.target.closest('select[data-eff], select[data-key]') : null;
      if (!el) return;
      const row = el.closest('[data-i]');
      const c = candidates[Number(row?.dataset.i)];
      if (!c) return;
      if (el.dataset.key !== undefined) {
        const v = String(el.value || '');
        if (v) c.key_label = v;
        else delete c.key_label;
        // Key 变了，测试面板里这把候选的 Key 清单也要跟着变。
        drawTestCandidates();
        return;
      }
      const v = String(el.value || '');
      if (v) c.reasoning_effort = v;
      else delete c.reasoning_effort;
    });
    // 权重 / 并发上限
    q('#m_ca')?.addEventListener('change', (e) => {
      const el = e.target;
      const c = candidates[Number(el.dataset.w ?? el.dataset.x)];
      if (!c) return;
      if (el.dataset.w) c.weight = Math.max(1, Number(el.value) || 1);
      else c.max_concurrency = Math.max(0, Number(el.value) || 0);
    });
    // 测试面板：换候选 → 换 Key 清单。
    q('#m_test_cand')?.addEventListener('change', drawTestCandidates);
    // 「测试这个模型」：真发一句「你好」，把上游回复显示出来。
    clk(q('#m_test_send'), async () => {
      const btn = q('#m_test_send');
      const out = q('#m_test_out');
      if (!btn || btn.disabled) return;
      const sel = q('#m_test_cand');
      const keySel = q('#m_test_key');
      const c = candidates[Number(sel?.value) || 0];
      if (!c || !c.provider) {
        if (out) {
          out.hidden = false;
          out.className = 'm-test-out m-test-out--err';
          out.textContent = '先在候选列表里加一个候选，再测试。';
        }
        return;
      }
      const keyLabel = String(keySel?.value || '');
      // 上游模型为空时用路由名：调度器也是这么回退的（候选 → 别名 → 路由名）。
      const model = String(c.target_model || mName).trim();
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '请求中…';
      // 测试期间禁用「保存」：test-key 会把结论落盘（配置版本 +1），测试还在
      // 飞的时候按下保存，提交的版本号必然是旧的 —— 保存必被 CAS 判为冲突、
      // 用户的改动被整条丢弃。禁掉这一个按钮，竞态根本不会发生。
      const saveBtn = q('#btn_save_model');
      if (saveBtn) saveBtn.disabled = true;
      if (out) {
        out.hidden = false;
        out.className = 'm-test-out';
        out.innerHTML = `<div class="gw-test-meta">正在用 ${eh(c.provider)}${keyLabel ? ` / ${eh(keyLabel)}` : ''} 请求 ${eh(model)} …</div>`;
      }
      const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      try {
        const res = await window.HOST.testKey({ provider: c.provider, key_label: keyLabel, model });
        const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
        // test-key 会把结论落盘（Full 节点配置版本 +1），本页持有的版本号就此
        // 落后一版。立刻追平，否则紧接着的保存必被 CAS 判为冲突、改动被丢弃。
        await refreshConfigVersion();
        // 服务端把结论写到了那把 Key 上，本地这份配置也得跟上：否则接下来的
        // 保存（整份提交 state.config）会把服务端刚写下的结论用旧值覆盖掉。
        const provKeys = state.config?.providers?.[c.provider]?.api_keys || [];
        const verdictKey = provKeys.find((k) => k && (k.label || k.id) === (keyLabel || res?.key_label));
        if (verdictKey) applyKeyLastTest(verdictKey, res);
        if (!out || !out.isConnected) return;
        const ok = Boolean(res && res.valid === true);
        const meta = [
          ok ? '可用' : '失败',
          res && res.status ? `HTTP ${res.status}` : '',
          `${(res && res.latency_ms) || ms}ms`,
          `${res && res.provider ? res.provider : c.provider}${res && res.key_label ? ` / ${res.key_label}` : ''}`,
          `${res && res.model ? res.model : model}`,
          res && res.model_source ? `(${res.model_source})` : '',
        ].filter(Boolean).join(' · ');
        out.className = `m-test-out${ok ? ' m-test-out--ok' : ' m-test-out--err'}`;
        if (ok) {
          const reply = String((res && res.reply_text) || '').trim();
          out.innerHTML = `<div class="gw-test-meta">${eh(meta)}</div>`
            + `<pre class="gw-test-reply">${eh(reply || '（上游返回成功，但没有可显示的文本）')}</pre>`;
        } else {
          const bits = [meta];
          if (res && res.reason) bits.push(`reason=${res.reason}`);
          if (res && res.err_type) bits.push(`err_type=${res.err_type}`);
          const errText = res && res.error ? scrubUiText(String(res.error)) : '';
          out.innerHTML = `<div class="gw-test-meta">${eh(bits.join(' · '))}</div>`
            + (errText ? `<div class="gw-test-error">${eh(errText)}</div>` : '');
        }
      } catch (err) {
        if (out && out.isConnected) {
          out.className = 'm-test-out m-test-out--err';
          out.textContent = `测试异常：${scrubUiText(err && err.message ? err.message : String(err))}`;
        }
      } finally {
        btn.disabled = false;
        btn.textContent = label;
        // 测试结束（无论成败）把「保存」放回来：版本号已在上面追平。
        const sb = q('#btn_save_model');
        if (sb) sb.disabled = false;
      }
    });

    // 「＋ 添加候选」内联面板。
    wireAddCandidatePanel(wrap, { candidates, redraw });

    clk(q('#btn_cancel_model'), () => {
      if (isCreate) {
        state.creatingModel = false;
      } else {
        state.activeEditorKey = null;
      }
      renderModelsList();
    });

    clk(q('#btn_save_model'), async () => {
      // 新增路径：把「供应商 + 模型 + Key」折成一个候选，再走下面的公共保存逻辑。
      if (isCreate && candidates.length === 0) {
        const prov = q('#ed_m_provider')?.value || '';
        const up = (q('#ed_m_upstream')?.value || '').trim();
        if (!prov) return toast('请选择供应商', 'warn');
        if (!state.config?.providers?.[prov]) return toast(`供应商 ${prov} 不存在，请先在供应商页创建`, 'warn');
        if (!up) return toast('请拉取或填写一个模型 ID', 'warn');
        candidates.push({
          provider: prov, target_model: up, key_label: q('#ed_m_key')?.value || '',
          enabled: true, weight: 1, max_concurrency: 0,
        });
      }
      const typedName = (q('#ed_m_name')?.value || '').trim();
      // 对外模型名可留空：默认取第一个候选的上游模型 ID（单供应商模型的常见情形）。
      const fallbackName = String(candidates[0]?.target_model || '').trim();
      const finalName = typedName || fallbackName;
      if (!finalName) return toast('请填写对外模型名，或先添加一个候选', 'warn');
      if (candidates.length === 0) return toast('请至少添加一个候选', 'warn');

      state.config = state.config || { providers: {}, agent_models: {} };
      state.config.agent_models = state.config.agent_models || {};

      // 同一个对外模型名 = 同一个路由组。新增时撞上已有的同名路由（典型场景：
      // 另一家供应商也有这个模型 ID），就把新候选并进那个组，而不是拒绝；
      // 并完展开那个组，让操作者看到并调整分流策略。
      // 比较「实际向上游要的模型」：上游模型为空 = 用路由名。
      const upstream = (c) => String(c.target_model || '').trim() || finalName;
      const sameCand = (a, b) => a.provider === b.provider && upstream(a) === upstream(b) && (a.key_label || '') === (b.key_label || '');
      if (isCreate && state.config.agent_models[finalName]) {
        const group = state.config.agent_models[finalName];
        group.candidates = group.candidates || [];
        const added = candidates.filter((c) => !group.candidates.some((g) => sameCand(g, c)));
        if (added.length === 0) {
          state.creatingModel = false;
          state.activeEditorKey = `m_${finalName}`;
          renderModelsList();
          return toast(`${finalName} 已经有这些供应商了`, 'info');
        }
        for (const c of added) group.candidates.push({ ...c, enabled: c.enabled !== false, weight: Math.max(1, Number(c.weight) || 1), max_concurrency: Math.max(0, Number(c.max_concurrency) || 0) });
        state.creatingModel = false;
        state.activeEditorKey = `m_${finalName}`;
        await persistConfig(`已并入 ${finalName}（现有 ${group.candidates.length} 个供应商来源），可设置分流方式`, { scope: 'agent_models', key: finalName, value: group });
        return;
      }
      if (!isCreate && finalName !== mName && state.config.agent_models[finalName]) {
        return toast(`路由 ${finalName} 已存在：要合并请删掉这一条，再把候选加到 ${finalName} 里`, 'warn');
      }

      const stratEl = wrap.querySelector('button[data-strat].probe-pill--managed');
      draft.enabled = true;
      // 策略以草稿为准；只有草稿里没有时才看 DOM（草稿在点胶囊时就写好了，
      // 重绘不会动它）。
      draft.routing_strategy = draft.routing_strategy || stratEl?.dataset.strat || 'sticky_failover';
      draft.active_key = (q('#ed_m_act')?.value || '').trim();
      draft.no_reasoning = Boolean(q('#ed_m_noreas')?.checked);
      draft.force_non_stream = Boolean(q('#ed_m_nonstream')?.checked);
      draft.allow_key_fallback = Boolean(q('#ed_m_keyfb')?.checked);
      // 每个候选都补齐后端契约里的字段：weight 缺省 1、max_concurrency 缺省 0、
      // enabled 缺省 true（后端读的就是这三个字段）。
      for (const c of draft.candidates) {
        c.enabled = c.enabled !== false;
        c.weight = Math.max(1, Number(c.weight) || 1);
        c.max_concurrency = Math.max(0, Number(c.max_concurrency) || 0);
      }

      if (!isCreate && finalName !== mName) {
        // 上游模型为空的候选，调度器拿路由名当上游模型。改名只改「客户端叫它什么」，
        // 不能顺带改掉「向上游要哪个模型」—— 先把旧名字钉进这些候选。
        for (const c of draft.candidates) {
          if (!String(c.target_model || '').trim()) c.target_model = mName;
        }
        // 改名 = 换路由键：老键删掉，新键挂上去，编辑器跟着新名字继续开着。
        delete state.config.agent_models[mName];
        if (state.activeEditorKey === `m_${mName}`) state.activeEditorKey = `m_${finalName}`;
      }
      state.config.agent_models[finalName] = draft;
      // 同名旧 KB 通道一起删（不存在时是空操作）。
      if (state.config.kb_models) {
        delete state.config.kb_models[mName];
        delete state.config.kb_models[finalName];
      }
      state.creatingModel = false;
      state.activeEditorKey = `m_${finalName}`;
      // 冲突重试时把「这条路由的新值」贴回服务端最新配置。改名的话旧键
      // 也要一起处理，所以把改名信息一并带出去。
      const pendingEdit = {
        scope: 'agent_models',
        key: finalName,
        value: draft,
        // 改名：冲突重试时服务端那份配置里旧键还在，要一并删掉。
        removeKey: (!isCreate && finalName !== mName) ? mName : null,
      };
      await persistConfig(isCreate ? '模型添加成功' : '模型配置保存成功', pendingEdit);
    });

    clk(q('#btn_del_model'), async () => {
      const ok = await confirmDialog({
        title: '删除路由',
        message: `确定删除路由 ${mName} 吗？`,
        confirmText: '删除',
      });
      if (!ok) return;
      delete state.config.agent_models[mName];
      // 同名旧 KB 通道必须一起走：留着它会让 KB 回退在下一次配置往返时复活幽灵路由。
      if (state.config.kb_models) delete state.config.kb_models[mName];
      state.activeEditorKey = null;
      const saved = await persistConfig('路由已删除');
      if (!saved) {
        // 没存上 → 回读服务端配置：路由还在，编辑器也留在原地。
        await loadData();
        state.activeEditorKey = `m_${mName}`;
        renderModelsList();
      }
    });
  }

  // --- Template Route Import (Full, on-demand) ---
  // Local model routes are fully free; the hub template is only an optional
  // import source. Routes whose candidates reference a provider missing locally
  // are blocked until that provider is pulled.
  function openTemplateImportOverlay() {
    const overlay = $('templateImportOverlay');
    if (!overlay) return;
    openDialog(overlay, { focus: 'btnCloseTemplateImport' });
    renderTemplateImportList();
  }

  function closeTemplateImportOverlay() {
    const overlay = $('templateImportOverlay');
    if (!overlay) return;
    // Cancel any in-flight batched pull: the button may be mid-loop, and the
    // operator closing the dialog means "do not land these routes".
    state.importRunId++;
    closeDialog(overlay);
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
      empty.className = 'card-pad text-muted';
      if (!state.vaultManifest) {
        empty.textContent = '中枢清单未加载，无法导入模板路由';
      } else if (!state.vaultManifest.agent_models || typeof state.vaultManifest.agent_models !== 'object') {
        empty.textContent = '中枢清单未包含模板路由（中枢版本较旧或未发布任何模板）';
      } else {
        empty.textContent = '中枢模板中没有本地缺失的模型';
      }
      listEl.appendChild(empty);
      return;
    }
    // 统一列表样式（组件 3 · .list > .row）：一行 = 勾选框 + 路由名 +
    // 一行次要信息（候选摘要）+ 一个状态 + 一个计数。
    const list = ce('div');
    list.className = 'list';
    listEl.appendChild(list);
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
      const blocked = keyGapPairs.length > 0 || localGapProvs.length > 0;
      const candText = cands.map((c) => `${c.provider}:${c.key_label || '*'}→${c.target_model || mName}`).join(' · ');

      const row = ce('div');
      row.className = 'row';
      const who = ce('div');
      who.className = 'who';
      // 名字 + 一行次要信息（候选摘要 / 缺依赖提示）。缺依赖的说明不进 .sub
      // （那行只放等宽的候选串），另起一行小字说清为什么这一行不可选。
      const notes = [];
      if (missing.length) notes.push(`导入时自动拉取 ${missing.length} 个缺失供应商：${missing.join('、')}`);
      if (keyGapPairs.length) notes.push(`Key 标签本地缺失：${keyGapPairs.join('、')}`);
      if (localGapProvs.length) notes.push(`${localGapProvs.join('、')} 为本地自建供应商，不能从中枢补拉 Key`);
      who.innerHTML = `
        <div class="name">${eh(mName)}</div>
        <div class="sub">${eh(candText || '（中枢模板没有候选）')}</div>
        ${notes.length ? `<div class="text-xs text-muted mt-1">${eh(notes.join(' · '))}</div>` : ''}
      `;

      // 勾选框（行内第一个元素）+ 状态 + 计数。
      const pick = ce('label');
      pick.className = 'fields';
      const cb = ce('input');
      cb.type = 'checkbox';
      cb.className = 'tpl_import_cb';
      cb.setAttribute('data-model', mName);
      if (blocked) cb.disabled = true;
      pick.appendChild(cb);

      const status = ce('span');
      status.className = 'fields';
      const dot = ce('span');
      dot.className = `dot ${blocked ? 'dot--warn' : 'dot--ok'}`;
      status.appendChild(dot);
      const word = ce('span');
      word.className = 'text-xs text-muted';
      word.textContent = blocked ? '缺依赖' : '可导入';
      status.appendChild(word);

      const count = ce('span');
      count.className = 'pill tabular';
      count.textContent = `${cands.length} 候选`;

      row.appendChild(pick);
      row.appendChild(who);
      row.appendChild(status);
      row.appendChild(count);

      // 「点此补拉」：中枢托管供应商缺的 Key 标签可以就地拉回来。
      if (keyGapPairs.length) {
        const act = ce('div');
        act.className = 'fields';
        for (const [pId, labels] of Object.entries(keyGapsByProv)) {
          const btn = ce('button');
          btn.type = 'button';
          btn.className = 'btn btn--sm';
          btn.setAttribute('data-tpl-fetch-keys', pId);
          btn.setAttribute('data-labels', JSON.stringify(labels));
          btn.textContent = `补拉 ${pId}`;
          act.appendChild(btn);
        }
        row.appendChild(act);
      }

      list.appendChild(row);
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
    if (picked.length === 0) return toast('请先勾选要导入的模型', 'warn');
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
      await persistConfig(`已从模板导入 ${imported} 个模型`);
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
    // 预设与中枢同步（Full only，约定 C/D）：preset-status 的可更新数放说明里，
    // 「一键更新」调 POST /api/admin/providers/sync；只有操作者点击才执行。
    const syncRows = $('presetSyncRows');
    if (syncRows && !syncRows.childElementCount) {
      syncRows.innerHTML = settingRow('预设与中枢同步',
        '检查各供应商的预设适配规则是否有新版本；一键更新会重新拉取中枢托管供应商，并把未手动改过规则的本地供应商换到最新预设规则',
        `<div class="input-row"><span class="text-xs text-muted tabular" id="presetSyncMeta">检查中…</span><button class="btn btn--sm" id="btnSyncProviders" type="button">一键更新</button></div>`);
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

  // --- 预设与中枢同步（Full only, 约定 C/D） ---
  // 说明位显示「N 个供应商有新版本」（GET /api/admin/providers/preset-status）；
  // 「一键更新」POST /api/admin/providers/sync，完成后在这行下方给一个简短
  // 结果清单（更新了谁、从哪个版本到哪个版本、Key 增减、跳过及原因）并刷新配置。
  // 与 state.presetUpdateFlags（供应商列表行「可更新」）共用同一次 status 查询。
  function renderPresetSyncRow() {
    const box = $('presetSyncBox');
    if (!box) return;
    const isFull = Boolean(window.HOST.capabilities.kbModels) && !isHubMode();
    box.hidden = !isFull;
    if (!isFull) return;

    const metaEl = $('presetSyncMeta');
    const btn = $('btnSyncProviders');
    const applyStatus = (res) => {
      if (metaEl) {
        if (res && res.ok) {
          const n = Number(res.update_count) || 0;
          metaEl.textContent = n > 0 ? `${n} 个供应商有新版本` : '全部为最新版本';
        } else {
          metaEl.textContent = '状态获取失败（节点或中枢不可达）';
        }
      }
    };

    // 每次进设置页都取一次：版本比较是服务端算的，前端不缓存。
    if (typeof window.HOST.getPresetStatus === 'function') {
      window.HOST.getPresetStatus().then((res) => {
        applyStatus(res);
        if (res && res.ok) {
          const flags = {};
          for (const row of Array.isArray(res.providers) ? res.providers : []) {
            if (row && row.id && row.has_update) flags[row.id] = String(row.latest_version || '') || true;
          }
          state.presetUpdateFlags = flags;
          renderProvidersList();
        }
      }).catch(() => applyStatus(null));
    }

    if (btn) {
      btn.onclick = async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = '更新中…';
        const out = $('presetSyncResult');
        try {
          const res = await window.HOST.syncProviders();
          if (!res || res.ok !== true) {
            toast(`一键更新失败: ${scrubUiText(res?.error || '请求未成功')}`, 'err');
            return;
          }
          const updated = Array.isArray(res.updated) ? res.updated : [];
          const skipped = Array.isArray(res.skipped) ? res.skipped : [];
          const errors = Array.isArray(res.errors) ? res.errors : [];
          toast(updated.length
            ? `已更新 ${updated.length} 个供应商`
            : (errors.length ? `更新完成，${errors.length} 个失败` : '没有需要更新的供应商'),
            errors.length ? 'warn' : 'ok');
          // 简短结果清单：更新（版本 A → B · Key +n/-n）/ 跳过（原因）/ 失败（错误）。
          if (out) {
            const lines = [];
            for (const u of updated) {
              const keyBits = [];
              const ka = Number(u.keys_added) || 0;
              const kr = Number(u.keys_removed) || 0;
              if (ka) keyBits.push(`+${ka} Key`);
              if (kr) keyBits.push(`-${kr} Key`);
              lines.push(`✓ ${u.id}：${u.from_version || '（未绑定）'} → ${u.to_version || '?'}${keyBits.length ? `（${keyBits.join('，')}）` : ''}`);
            }
            for (const sp of skipped) lines.push(`− ${sp.id}：跳过（${sp.reason || '未说明'}）`);
            for (const er of errors) lines.push(`✗ ${er.id}：失败（${scrubUiText(er.error || '未知错误')}）`);
            out.hidden = lines.length === 0;
            out.classList.toggle('hidden', lines.length === 0);
            out.innerHTML = lines.map((l) => `<div class="text-xs">${eh(l)}</div>`).join('');
          }
          // 同步改了供应商的规则与 preset_version：重拉配置并让列表行重绘。
          await loadData();
        } catch (e) {
          toast(`一键更新异常: ${scrubUiText(e.message)}`, 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = '一键更新';
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
    if (isHubMode()) renderModelCatalogCard();
    // 预设与中枢同步：Full only（Hub 没有这两个接口，不显示入口，约定 D）。
    renderPresetSyncRow();

    const baseOrigin = location.origin || 'http://127.0.0.1:3425';
    const localBase = `${baseOrigin}/v1`;
    const clientKey = s.client_key || s.proxy_api_key || '';

    if (gwSummaryPill) {
      gwSummaryPill.textContent = clientKey
        ? '主密钥已配置'
        : (isFull ? '主密钥未配置' : '待设置下发至节点');
      gwSummaryPill.className = clientKey ? 'pill' : 'pill pill--amber';
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
          const ok = await confirmDialog({
            title: '解除全部冷却',
            message: '确定解除所有模型与密钥的当前冷却限制吗？',
            confirmText: '解除',
          });
          if (!ok) return;
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

  // 把「待保存的改动」贴到服务端刚回读的配置上。
  //
  // 冲突重试时不能拿本地的过期快照硬覆盖：服务端在冲突发生前可能刚写下
  // 别的内容（本页的 test-key 结论就是最常见的一种），整份覆盖会把那份
  // 内容冲掉。所以这里只把「用户正在改的那一项」搬到服务端最新配置上，
  // 其余部分原样保留。
  //
  // edit: { scope: 'agent_models' | 'providers', key, value, removeKey? }
  function applyPendingEdit(freshCfg, edit) {
    if (!freshCfg || !edit || !edit.key) return null;
    const bag = edit.scope === 'agent_models' ? 'agent_models' : edit.scope === 'providers' ? 'providers' : null;
    if (!bag) return null;
    const cfg = Object.assign({}, freshCfg);
    const section = Object.assign({}, freshCfg[bag] || {});
    const serverProv = section[edit.key];
    section[edit.key] = edit.value;
    // 改名：服务端那份配置里的旧键也要删掉，否则两条路由并存。
    if (edit.removeKey && edit.removeKey !== edit.key) delete section[edit.removeKey];
    // 服务端在冲突发生前可能刚给某把 Key 写下了测试结论（test-key 会落盘
    // last_test）。整份替换供应商会把那份结论冲掉，所以按 Key 标签把它
    // 捞回来 —— 密钥本体与其它属性仍以用户这份为准。
    if (bag === 'providers' && serverProv?.api_keys && edit.value?.api_keys) {
      for (const sk of serverProv.api_keys) {
        const mine = sk?.last_test && edit.value.api_keys.find((k) => k && (k.label || k.id) === (sk.label || sk.id));
        if (mine && !mine.last_test) mine.last_test = sk.last_test;
      }
    }
    cfg[bag] = section;
    return cfg;
  }

  // --- Common Helper: Persist Config ---
  //
  // pendingEdit: 可选的「待保存的改动」。冲突重试时用它把用户的改动重新
  // 贴到服务端最新的配置上（而不是拿一份过期快照硬覆盖）。
  // 返回 true = 落盘成功；false = 没保存成（调用方要负责回读 state.config）。
  async function persistConfig(successMsg, pendingEdit) {
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

      if (isSaveConflict(res, data)) {
        // 冲突时服务端会带回 current_version / submitted_version。
        // 落后一两版 = 本页自己的 test-key 请求把结论落盘导致的（不是
        // 「别人改了」）；落后更多 = 真的有人在别处改了配置。
        const curVer = Number(data?.current_version ?? data?.data?.current_version);
        const subVer = Number(data?.submitted_version ?? data?.data?.submitted_version);
        const drift = curVer - subVer;
        // 版本只差一两版：多半是本页的测试请求把配置落盘了。回读服务端最新
        // 的配置，把用户正在改的那一项贴上去再保存 —— 用户的改动保住了，
        // 服务端刚写下的测试结论也不会被过期快照冲掉。
        if (pendingEdit && drift > 0 && drift <= 2) {
          const fresh = await window.HOST.getConfig?.();
          const merged = fresh && fresh._version === curVer ? applyPendingEdit(fresh, pendingEdit) : null;
          if (merged) {
            toast('配置版本已对齐，正在重试保存…', 'info');
            if (applySaveResponse(await window.HOST.saveConfig(merged), successMsg)) return true;
          }
        }
        // 真冲突：明确告诉操作者「改动没有保存」，而不是含糊地说「被人改了」。
        toast('保存未成功：配置已被改动，本次修改没有保存。请刷新后重试。', 'err');
        await loadData();
        return false;
      }

      if (!applySaveResponse(res, successMsg)) {
        const errMsg = typeof data.error === 'string' ? data.error : data.error?.message || '保存失败';
        if (isEmptyTemplateGuard(res, data)) {
          // 中枢的模板守卫（edgeone-hub/lib/config.js）：保存后一个「启用且有启用 Key」
          // 的供应商都不剩，节点下一次拉配置就会全断，守卫直接拒收。透传后端的英文
          // 报错对操作者没用 —— 要给可执行的补救指引。
          toast('保存未生效：中枢要求至少保留一个「已启用且有启用 Key」的供应商，否则节点下一次拉配置会全断。请先给某个供应商添加一把启用的 Key，再重试。', 'err');
          return false;
        }
        // 约定 C：本地 Key 与中枢 Key 同标签 → Full 节点返回
        // 400 {"ok":false,"error":"key_label_conflict","label":"…"}。译成可执行的话。
        if (res?.status === 400 && (data.error === 'key_label_conflict' || data.error?.code === 'key_label_conflict')) {
          toast(`保存未生效：标签「${data.label || '?'}」已被该供应商的中枢 Key 占用，请换一个标签`, 'err');
          return false;
        }
        toast(scrubUiText(errMsg), 'err');
        return false;
      }
      return true;
    } catch (e) {
      toast(`保存异常: ${scrubUiText(e.message)}`, 'err');
      return false;
    }
  }

  // 中枢的「空模板」守卫：保存的配置里一个可用供应商都不剩。
  // edgeone-hub/lib/config.js 抛 ConfigValidationError → HTTP 400。
  function isEmptyTemplateGuard(res, data) {
    const msg = typeof data?.error === 'string' ? data.error : data?.error?.message || '';
    return res?.status === 400 && /empty template|at least one enabled provider/i.test(msg);
  }

  // 保存请求是不是撞上了 CAS 冲突（409 config_version_conflict）。
  function isSaveConflict(res, data) {
    return res?.status === 409 ||
      data?.error === 'config_version_conflict' ||
      res?.error === 'config_version_conflict' ||
      data?.code === 'cas_version_conflict' ||
      data?.error?.code === 'cas_version_conflict' ||
      (typeof data?.error === 'string' && data.error.includes('conflict'));
  }

  // 把一次保存的响应落到 state.config 并重绘。成功返回 true。
  function applySaveResponse(res, successMsg) {
    const data = res?.data || res || {};
    if (isSaveConflict(res, data)) return false;
    if (!(res?.status === 200 || data?.ok || data?._version !== undefined)) return false;
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
    renderProvidersList();
    renderModelsList();
    renderSettingsView();
    return true;
  }

  function formatTime(isoOrSec) {
    if (!isoOrSec) return '';
    const d = typeof isoOrSec === 'number' ? new Date(isoOrSec * 1000) : new Date(isoOrSec);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
