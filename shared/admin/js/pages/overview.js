// overview.js — 启动与全局接线：init、登录屏、主题/隐私遮罩/快捷键、导航页签、并发通道轮询，以及供应商预设目录、cURL 解析、工具条与配置备份接线（按原文件行序落位）
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
    // 设置页骨架：分组锚点 + 保存浮条（脏检查）。浮条元素挂在 #viewSettings 里，
    // 保存走 saveSettingsFromBar()（原页头「保存全部设置」的处理体）。
    setupSettingsChrome();
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
    // Hub 端「一键探活全部 Key」：逐把探活，不消耗推理额度。
    if (btnHubBatchVerifyAll) btnHubBatchVerifyAll.hidden = !isHub;
    const sysBox = $('systemUpdateBox');
    if (sysBox) sysBox.hidden = !caps.systemUpdate;
    // 「中枢连接与升级」分组（Vault 连接 + 版本与升级）只有 Full 有这两个能力；
    // Hub 端两个子块都隐藏，整组也隐藏，锚点清单同步少一组。
    const hubLinkGrp = $('settingsGrpHub');
    if (hubLinkGrp) hubLinkGrp.hidden = !(caps.vaultClient || caps.systemUpdate);
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
    if (modelsTitle) {
      modelsTitle.textContent = '模型';
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
          const row = cell.closest('.krow') || cell.closest('tr');
          const tbody = cell.closest('[id^="p_keys_tbody_"]');
          const pId = tbody && tbody.id && tbody.id.startsWith('p_keys_tbody_')
            ? tbody.id.slice('p_keys_tbody_'.length)
            : '';
          if (!pId) return;
          const idx = Number(row?.dataset.keyIdx);
          const k = state.config?.providers?.[pId]?.api_keys?.[idx];
          if (!k) return;
          const cd = findKeyCooldown(pId, k, idx);
          cell.innerHTML = keyStatusCellHtml(k, cd.sec, cd.target);
          if (row) {
            row.dataset.cdSec = String(cd.sec);
            row.dataset.cdTarget = cd.target || '';
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

  // 适配信息只出现在供应商编辑器的「高级」区（列表行不再堆标签）。

  function setupToolbars() {
    const provSearch = $('providerSearchInput');
    if (provSearch) {
      provSearch.addEventListener('input', (e) => {
        state.providerQuery = (e.target.value || '').trim().toLowerCase();
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

    // 节点页的「刷新」。
    clk($('btnHubRefreshOverview'), async () => {
      await loadNodesData();
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
            // 检测时间统一走 fmtTime()（v2 §4.3）；无效时间就不显示括号。
            const checkedAt = fmtTime(data?.checked_at);
            box.innerHTML = `<div class="text-sm text-ok">当前已是最新版本 <strong class="tabular">${eh(data?.current_version || '-')}</strong>${checkedAt ? ` (检测于 ${eh(checkedAt)})` : ''}</div>`;
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
    toggle('newProvVaultGroup', vaultMode);
    toggle('newProvApiKeyGroup', !vaultMode);
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
    const meta = matchPresetMeta($('newProvName')?.value, $('newProvBaseUrl')?.value);
    const baseEl = $('newProvBaseUrl');
    if (meta && baseEl && !baseEl.value.trim() && meta.base_url) baseEl.value = meta.base_url;
  }

  // --- 4b. 接入信息 view (its own tab) --------------------------------------
  // The gateway serves two entry points and the client's dialect decides which
  // one to paste. Neither depends on how an upstream provider is configured:
  // the protocol picker on a provider only says how we talk *to* the upstream.
