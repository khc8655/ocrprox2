// core.js — 控制台底座：state、$ 等通用帮助函数、toast、dialog/menu、Key 单元格与 escapeHtml（原 app.js 通用层）
  const $ = (id) => document.getElementById(id);
  const ce = (t) => document.createElement(t);
  const clk = (el, fn) => el && el.addEventListener('click', fn);
  // 字段说明不常驻（v2.1 §2）：标签旁「?」，悬停 / 聚焦显示白色浮层，离开消失；点击不跳转。
  const fieldHint = (text, title = '') => {
    if (!text) return '';
    return `<span class="tipwrap"><button class="qi" type="button" aria-label="说明">?</button><span class="tip" role="tooltip">${title ? `<b>${escapeHtml(title)}</b>` : ''}${escapeHtml(text)}</span></span>`;
  };

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
      if (verEl) verEl.textContent = `配置 v${res._version}`;
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
    const lease = Number(n.lease_ttl) || 86400;
    const grace = (n.grace_ttl !== undefined && n.grace_ttl !== null) ? Number(n.grace_ttl) : 3600;
    const age = Math.max(0, Math.floor((Date.now() - syncMs) / 1000));
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

  // --- 组件 3 · 列表行 listRow（docs/UI_DESIGN_SPEC.md v2 §4.1：全站唯一的列表行生成函数）---
  // 列固定：名称 + 次要信息 | 状态 | 计数 | 右箭头；状态与计数列宽由
  // --row-status-w / --row-count-w 决定，所有页面对齐。行可点（onOpen），
  // 悬停 --hover，没有展开态。没有 onOpen 就是不带交互的静态行（空状态提示用）。
  // 返回 DOM 元素；title / sub / count / note 是 HTML（调用方负责 escapeHtml，
  // 与现有页面拼 innerHTML 的习惯一致）。
  // opts:
  //   title     名称（HTML）
  //   sub       一行次要信息（HTML，超长省略）；出问题的行传 subError: true，
  //             次要信息直接写原因、用 --err 色文字（v2 §4.1）
  //   status    { dot: 'ok'|'warn'|'err'|'off', label: '一个词' }，或直接一个词
  //   count     计数（HTML，右对齐，tabular-nums）
  //   logo      首字母（字符串，渲成 .avatar-initial）或现成 DOM 元素
  //   note      次要信息下的一行补充说明（灰字）
  //   leading / trailing  例外插槽：多选行的勾选框 / 行内动作按钮（模板导入
  //             这类带子项操作的行）；常规列表行不要用
  //   tag       'button'：下拉选项这类要参与键盘焦点循环的行
  //   cls       附加类名（如空状态行的 text-muted）
  //   onOpen    点击行的回调；点击行内的按钮 / 输入框 / 链接等控件不触发
  function listRow(opts = {}) {
    const {
      title = '',
      sub = '',
      subError = false,
      extra = '',
      status = '',
      count = '',
      logo = null,
      off = false,
      note = '',
      leading = null,
      trailing = null,
      tag = '',
      cls = '',
      onOpen = null,
    } = opts;
    const row = ce(tag === 'button' ? 'button' : 'div');
    if (row.tagName === 'BUTTON') row.type = 'button';
    row.className = `row${off ? ' row--off' : ''}${cls ? ` ${cls}` : ''}${typeof onOpen !== 'function' ? ' row--static' : ''}`;
    if (leading && leading.nodeType === 1) row.appendChild(leading);
    if (logo) {
      let logoEl;
      if (logo.nodeType === 1) {
        logoEl = logo;
      } else if (window.renderBrandIcon) {
        const tmp = ce('span');
        const label = typeof logo === 'object' ? (logo.name || logo.letter || '') : String(logo);
        tmp.innerHTML = window.renderBrandIcon(label, { off: Boolean(off || logo?.off) });
        logoEl = tmp.firstElementChild;
      } else {
        logoEl = ce('span');
        logoEl.className = 'avatar-initial';
        logoEl.setAttribute('aria-hidden', 'true');
        logoEl.textContent = String(logo);
      }
      if (logoEl) row.appendChild(logoEl);
    }
    const who = ce('div');
    who.className = 'who';
    if (title) {
      const name = ce('div');
      name.className = 'name';
      name.innerHTML = title;
      who.appendChild(name);
    }
    if (sub) {
      const subEl = ce('div');
      subEl.className = `sub${subError ? ' sub--err' : ''}`;
      subEl.innerHTML = sub;
      who.appendChild(subEl);
    }
    if (note) {
      const noteEl = ce('div');
      noteEl.className = 'row-note';
      noteEl.innerHTML = note;
      who.appendChild(noteEl);
    }
    row.appendChild(who);
    if (extra) {
      const extraEl = ce('span');
      extraEl.className = 'row-extra';
      if (extra.nodeType === 1) extraEl.appendChild(extra);
      else extraEl.innerHTML = extra;
      row.appendChild(extraEl);
    }
    if (status) {
      const stEl = ce('span');
      stEl.className = 'row-status';
      if (typeof status === 'string') {
        stEl.textContent = status;
      } else {
        const dotVal = String(status.dot || 'off');
        const dot = ce('span');
        dot.className = `dot ${dotVal.startsWith('dot--') ? dotVal : `dot--${dotVal}`}`;
        dot.setAttribute('aria-hidden', 'true');
        const word = ce('span');
        word.textContent = status.label != null ? String(status.label) : '';
        stEl.appendChild(dot);
        stEl.appendChild(word);
      }
      row.appendChild(stEl);
    }
    if (count) {
      const cntEl = ce('span');
      cntEl.className = 'row-count';
      cntEl.innerHTML = count;
      row.appendChild(cntEl);
    }
    if (trailing && trailing.nodeType === 1) row.appendChild(trailing);
    if (typeof onOpen === 'function') {
      const chev = ce('span');
      chev.className = 'row-chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.textContent = '›';
      row.appendChild(chev);
      clk(row, (ev) => {
        const hit = ev.target instanceof Element
          ? ev.target.closest('button, input, select, textarea, a, label')
          : null;
        if (hit && hit !== row) return;
        onOpen(ev);
      });
    }
    return row;
  }
  // usage.js 是独立 IIFE（先于 core.js 加载），拿不到本作用域：把组件挂到
  // window 上给它用。页面包（js/pages/*，与 core.js 同一 IIFE）直接用裸名。
  window.listRow = listRow;

  // --- 组件 6 · 弹框 .dialog（docs/UI_DESIGN_SPEC.md v2 §4.2） ---
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

  // --- 时间格式化 fmtTime（v2 §4.3）：一分钟内「刚刚」，七天内「N 分钟/小时/天前」，
  // 更早显示日期。禁止浏览器默认格式。参数接受 ISO 字符串、毫秒或秒级时间戳
  // （< 1e12 的数字按秒处理，与节点 last_seen 的约定一致）。无效输入返回空串。
  function fmtTime(value) {
    if (value === undefined || value === null || value === '') return '';
    let ms = typeof value === 'number' ? value : new Date(String(value)).getTime();
    if (!Number.isFinite(ms) || Number.isNaN(ms)) return '';
    if (ms > 0 && ms < 1e12) ms *= 1000;
    const diff = Date.now() - ms;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
    if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`;
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }
  window.fmtTime = fmtTime;

  // --- 开关（v2 §4.3）：启用/停用用开关，不用复选框。aria-checked 驱动开合，
  // onChange 收到切换后的布尔值；页面自己的状态由它自己维护。
  function makeSwitch(opts = {}) {
    const { on = false, label = '', disabled = false, onChange = null } = opts;
    const el = ce('button');
    el.type = 'button';
    el.className = 'switch';
    el.setAttribute('role', 'switch');
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    if (disabled) el.disabled = true;
    if (label) {
      el.setAttribute('aria-label', label);
      el.title = label;
    }
    clk(el, () => {
      if (el.disabled) return;
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', next ? 'true' : 'false');
      if (typeof onChange === 'function') onChange(next);
    });
    return el;
  }

  // --- 芯片（v2 §4.3）：多选或筛选；选中态 = --accent-soft 底 + --accent 字。
  // 点击后组件自己翻转选中态，onClick 收到翻转后的布尔值，页面据此改数据并
  // 重渲染（筛选类芯片重渲染即可，无需手动同步类名）。
  function buildChip(opts = {}) {
    const { label = '', on = false, title = '', disabled = false, onClick = null } = opts;
    const el = ce('button');
    el.type = 'button';
    el.className = `chip${on ? ' chip--on' : ''}`;
    el.textContent = String(label);
    if (title) el.title = title;
    if (disabled) el.disabled = true;
    clk(el, () => {
      const next = !el.classList.contains('chip--on');
      el.classList.toggle('chip--on', next);
      if (typeof onClick === 'function') onClick(next);
    });
    return el;
  }

  // --- 设置页保存浮条（v2 §4.3）：有改动时底部浮出「N 项未保存 · 放弃 · 保存」。
  // W5 接脏检查：update(0) 收起，update(n) 显示。调用方自行把 el 挂到页面。
  function createSaveBar(opts = {}) {
    const { onDiscard = null, onSave = null } = opts;
    const bar = ce('div');
    bar.className = 'save-bar';
    bar.hidden = true;
    const txt = ce('span');
    txt.className = 'save-bar-text';
    const discard = ce('button');
    discard.type = 'button';
    discard.className = 'btn';
    discard.textContent = '放弃';
    const save = ce('button');
    save.type = 'button';
    save.className = 'btn btn--primary';
    save.textContent = '保存';
    clk(discard, () => { if (typeof onDiscard === 'function') onDiscard(); });
    clk(save, () => { if (typeof onSave === 'function') onSave(); });
    bar.appendChild(txt);
    bar.appendChild(discard);
    bar.appendChild(save);
    return {
      el: bar,
      update(n) {
        const count = Number(n) || 0;
        if (count <= 0) {
          bar.hidden = true;
          return;
        }
        txt.textContent = `${count} 项未保存`;
        bar.hidden = false;
      },
    };
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

  // --- 分段选择 + 「自定义…」（v2.1 §2）：灰色轨道 + 白色选中块 ---
  // presets: [{ value, label }]；custom=true 时末尾带「自定义…」段（点开变成输入框，
  // 回车或失焦确认；当前值不在预设里时自定义段直接显示该值并高亮）。
  function makeSegPicker(opts = {}) {
    const {
      id = '',
      presets = [],
      value = '',
      custom = true,
      customLabel = '自定义…',
      customUnit = '',
      customPlaceholder = '输入数值',
      customType = 'number',
      min = null,
      max = null,
      step = null,
      allowEmpty = false,
      disabled = false,
      onChange = null,
    } = opts;

    const wrap = ce('div');
    wrap.className = 'segp';
    const hiddenIn = ce('input');
    hiddenIn.type = 'hidden';
    if (id) hiddenIn.id = id;
    wrap.appendChild(hiddenIn);

    let curVal = value !== undefined && value !== null ? String(value) : '';
    hiddenIn.value = curVal;

    const btns = [];
    for (const p of presets) {
      const b = ce('button');
      b.type = 'button';
      b.className = 'segp-btn';
      b.textContent = p.label;
      b.dataset.segVal = String(p.value);
      if (disabled) b.disabled = true;
      clk(b, () => {
        if (disabled) return;
        setValue(String(p.value), true);
      });
      btns.push(b);
      wrap.appendChild(b);
    }

    let cusBtn = null;
    let cusIn = null;
    if (custom) {
      cusBtn = ce('button');
      cusBtn.type = 'button';
      cusBtn.className = 'segp-btn cus';
      if (disabled) cusBtn.disabled = true;
      cusIn = ce('input');
      cusIn.type = customType;
      cusIn.className = 'segp-input';
      cusIn.placeholder = customPlaceholder;
      if (min !== null && min !== undefined) cusIn.min = String(min);
      if (max !== null && max !== undefined) cusIn.max = String(max);
      if (step !== null && step !== undefined) cusIn.step = String(step);
      cusIn.hidden = true;

      clk(cusBtn, () => {
        if (disabled) return;
        cusBtn.hidden = true;
        cusIn.hidden = false;
        const isPreset = presets.some((p) => String(p.value) === curVal);
        cusIn.value = isPreset ? '' : curVal;
        cusIn.focus();
        cusIn.select();
      });

      let cancelling = false;
      const commit = () => {
        if (cancelling) { cancelling = false; return; }
        const raw = String(cusIn.value ?? '').trim();
        cusIn.hidden = true;
        cusBtn.hidden = false;
        if (!raw) {
          if (allowEmpty) setValue('', true);
          else syncUi();
          return;
        }
        if (customType === 'number') {
          const n = Number(raw);
          if (!Number.isFinite(n) || (min !== null && n < min) || (max !== null && n > max)) {
            toast(min !== null && max !== null ? `请输入 ${min} ~ ${max} 之间的数值` : '请输入有效数值', 'warn');
            syncUi();
            return;
          }
          setValue(String(n), true);
        } else {
          setValue(raw, true);
        }
      };
      cusIn.addEventListener('blur', commit);
      cusIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          cusIn.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancelling = true;
          cusIn.hidden = true;
          cusBtn.hidden = false;
        }
      });
      wrap.appendChild(cusBtn);
      wrap.appendChild(cusIn);
    }

    function syncUi() {
      const matched = presets.find((p) => String(p.value) === curVal);
      for (const b of btns) {
        b.classList.toggle('on', Boolean(matched) && b.dataset.segVal === String(matched.value));
      }
      if (cusBtn) {
        const isCustomActive = !matched && curVal !== '';
        cusBtn.classList.toggle('on', isCustomActive);
        cusBtn.textContent = isCustomActive
          ? `${curVal}${customUnit ? ` ${customUnit}` : ''}`
          : customLabel;
      }
    }

    function setValue(next, emit = false) {
      const s = next !== undefined && next !== null ? String(next) : '';
      const changed = s !== curVal;
      curVal = s;
      hiddenIn.value = curVal;
      syncUi();
      if (emit) {
        if (typeof onChange === 'function') onChange(curVal, changed);
        hiddenIn.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    syncUi();
    hiddenIn._syncPicker = (v) => setValue(v, false);
    return { el: wrap, input: hiddenIn, getValue: () => curVal, setValue };
  }

  // --- 胶囊下拉（v2.1 §2）：浅灰底圆角 + 右侧小箭头，禁止原生 <select> 外观 ---
  const openPillSelects = [];

  function pruneOpenPillSelects() {
    for (let i = openPillSelects.length - 1; i >= 0; i--) {
      const p = openPillSelects[i];
      if (!p || !p.isConnected || p.hidden) openPillSelects.splice(i, 1);
    }
    return openPillSelects;
  }

  function closePillPop(pop) {
    if (!pop) return;
    pop.hidden = true;
    pop.classList.add('hidden');
    const idx = openPillSelects.indexOf(pop);
    if (idx >= 0) openPillSelects.splice(idx, 1);
  }

  function closeAllPillSelects() {
    pruneOpenPillSelects();
    openPillSelects.slice().forEach(closePillPop);
  }

  function makePillSelect(opts = {}) {
    const {
      id = '',
      options = [],
      value = '',
      placeholder = '请选择',
      full = false,
      sm = false,
      disabled = false,
      ariaLabel = '',
      onChange = null,
    } = opts;

    const wrap = ce('div');
    wrap.className = `pillsel-wrap${full ? ' pillsel-wrap--full' : ''}`;
    const hiddenIn = ce('input');
    hiddenIn.type = 'hidden';
    if (id) hiddenIn.id = id;
    wrap.appendChild(hiddenIn);

    const btn = ce('button');
    btn.type = 'button';
    btn.className = `pillsel${sm ? ' pillsel--sm' : ''}`;
    btn.setAttribute('aria-haspopup', 'listbox');
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
    if (disabled) btn.disabled = true;

    const valSpan = ce('span');
    valSpan.className = 'pillsel-val';
    const caret = ce('span');
    caret.className = 'pillsel-caret';
    caret.setAttribute('aria-hidden', 'true');
    btn.appendChild(valSpan);
    btn.appendChild(caret);

    const pop = ce('div');
    pop.className = 'pillsel-pop hidden';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;

    wrap.appendChild(btn);
    wrap.appendChild(pop);

    let list = Array.isArray(options) ? options.slice() : [];
    let curVal = value !== undefined && value !== null ? String(value) : '';
    let isDisabled = Boolean(disabled);
    hiddenIn.value = curVal;

    function renderOptionInner(target, opt) {
      target.innerHTML = '';
      if (opt.avatar && window.renderBrandIcon) {
        const tmp = ce('span');
        const avName = typeof opt.avatar === 'object' ? (opt.avatar.name || opt.label) : String(opt.avatar);
        tmp.innerHTML = window.renderBrandIcon(avName, { sm: true, off: Boolean(opt.avatar?.off) });
        if (tmp.firstElementChild) target.appendChild(tmp.firstElementChild);
      }
      const lbl = ce('span');
      lbl.textContent = String(opt.label ?? opt.value ?? '');
      target.appendChild(lbl);
      if (opt.meta) {
        const m = ce('span');
        m.className = 'pillsel-meta';
        m.textContent = String(opt.meta);
        target.appendChild(m);
      }
    }

    function paintValue() {
      const opt = list.find((o) => String(o.value) === curVal) || null;
      if (opt) {
        renderOptionInner(valSpan, opt);
      } else {
        valSpan.innerHTML = '';
        const ph = ce('span');
        ph.className = 'text-muted';
        ph.textContent = placeholder;
        valSpan.appendChild(ph);
      }
      pop.querySelectorAll('.pillsel-opt').forEach((item) => {
        item.classList.toggle('on', item.dataset.optVal === curVal);
      });
    }

    function buildMenuItems() {
      pop.innerHTML = '';
      for (const opt of list) {
        const item = ce('button');
        item.type = 'button';
        item.className = `pillsel-opt${String(opt.value) === curVal ? ' on' : ''}`;
        item.setAttribute('role', 'option');
        item.dataset.optVal = String(opt.value);
        if (opt.disabled) item.disabled = true;
        renderOptionInner(item, opt);
        clk(item, (ev) => {
          ev.stopPropagation();
          closePillPop(pop);
          setValue(String(opt.value), true);
        });
        pop.appendChild(item);
      }
      paintValue();
    }

    function setValue(next, emit = false) {
      const s = next !== undefined && next !== null ? String(next) : '';
      const changed = s !== curVal;
      curVal = s;
      hiddenIn.value = curVal;
      paintValue();
      if (emit) {
        const opt = list.find((o) => String(o.value) === curVal) || null;
        if (typeof onChange === 'function') onChange(curVal, opt, changed);
        hiddenIn.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function setOptions(nextOpts, nextVal) {
      list = Array.isArray(nextOpts) ? nextOpts.slice() : [];
      if (nextVal !== undefined) curVal = String(nextVal);
      hiddenIn.value = curVal;
      buildMenuItems();
    }

    function setDisabled(d) {
      isDisabled = Boolean(d);
      btn.disabled = isDisabled;
      if (isDisabled) closePillPop(pop);
    }

    clk(btn, (ev) => {
      ev.stopPropagation();
      if (isDisabled) return;
      const wasOpen = !pop.hidden;
      closeAllMenus();
      closeAllPillSelects();
      if (wasOpen) return;
      pop.hidden = false;
      pop.classList.remove('hidden');
      if (!openPillSelects.includes(pop)) openPillSelects.push(pop);
    });

    buildMenuItems();
    hiddenIn._syncPicker = (v) => setValue(v, false);
    return { el: wrap, input: hiddenIn, btn, getValue: () => curVal, setValue, setOptions, setDisabled };
  }

  function setupStaticIcons() {
    const setIcon = (id, name) => {
      const el = $(id);
      if (el && window.uiIcon) el.innerHTML = window.uiIcon(name);
    };
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
    // 点菜单外部关闭「⋯」浮层与胶囊下拉浮层。
    document.addEventListener('click', (ev) => {
      if (pruneOpenMenus().length) {
        const inMenu = ev.target instanceof Element && ev.target.closest('.menu');
        if (!inMenu) closeAllMenus();
      }
      if (pruneOpenPillSelects().length) {
        const inPill = ev.target instanceof Element && ev.target.closest('.pillsel-wrap');
        if (!inPill) closeAllPillSelects();
      }
    });
  }

  // --- Initializer ---
