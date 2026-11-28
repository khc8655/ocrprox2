// settings.js — 系统设置页：setting-row 挂载、模型目录、预设同步、设置视图，及 persistConfig/applyPendingEdit 等保存配套与启动注册行（按原文件行序落位）
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
          `<div class="input-row"><input class="input input--code privacy-mask" id="gwClientKey" placeholder="输入或生成客户端 API Key"><button class="btn" id="btnGenClientKey">随机生成</button></div>`),
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

  // --- 设置页骨架：分组锚点 + 保存浮条（效果图 11-settings） ------------------
  // 锚点：分组按端能力动态增减（Hub 5 组、Full 6 组），分段控件点击滚动到分组，
  // 窗口滚动时同步选中态。保存：底部浮条（core.js createSaveBar），有改动才浮出，
  // 「保存」走与旧页头「保存全部设置」完全相同的校验与 persistConfig 路径。

  // 锚点清单。分组 id 与 admin.html page:settings 里的 .block 一一对应：
  // Hub = 接入 / 路由与冷却 / 并发护栏 / 模型目录 / 备份与迁移（效果图顺序）；
  // Full 没有 models.dev 目录，第 4 组换成「预设与中枢同步」，末尾多一组
  // 「中枢连接与升级」（Vault 连接 + 版本与升级）。
  function settingsAnchorTargets() {
    const caps = window.HOST.capabilities || {};
    const isFull = Boolean(caps.kbModels) && !isHubMode();
    const items = [
      { id: 'settingsGrpAccess', label: '接入' },
      { id: 'settingsGrpRouting', label: '路由与冷却' },
      { id: 'settingsGrpGuards', label: '并发护栏' },
      { id: 'settingsGrpCatalog', label: isFull ? '预设与中枢同步' : '模型目录' },
      { id: 'settingsGrpBackup', label: '备份与迁移' },
    ];
    if (isFull) items.push({ id: 'settingsGrpHub', label: '中枢连接与升级' });
    return items;
  }

  function renderSettingsAnchorNav() {
    const seg = $('settingsAnchorSeg');
    if (!seg) return;
    seg.innerHTML = '';
    for (const it of settingsAnchorTargets()) {
      const b = ce('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = it.label;
      b.setAttribute('data-grp', it.id);
      seg.appendChild(b);
    }
    syncSettingsAnchor();
  }

  // 滚动同步：取「视口顶部以上最近的可见分组」为当前锚点；一个都没过线时回退
  // 第一个可见分组。页签没显示时读不到有效位置（rect 全是 0），先点亮第一个
  // 分组，进入页签后由滚动事件校正。
  function syncSettingsAnchor() {
    const seg = $('settingsAnchorSeg');
    const section = $('viewSettings');
    if (!seg || !section) return;
    if (section.hidden) {
      const first = settingsAnchorTargets().find((it) => $(it.id) && !$(it.id).hidden);
      seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', Boolean(first) && b.getAttribute('data-grp') === first.id));
      return;
    }
    let cur = '';
    for (const it of settingsAnchorTargets()) {
      const el = $(it.id);
      if (el && !el.hidden && el.getBoundingClientRect().top <= 140) cur = it.id;
    }
    if (!cur) {
      const first = settingsAnchorTargets().find((it) => $(it.id) && !$(it.id).hidden);
      cur = first ? first.id : '';
    }
    seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-grp') === cur));
  }

  // 脏检查：可编辑字段集合是固定的（与 renderSettingsView 按 id 填值的清单一致）；
  // 基线在每次回填后重取。Vault 两行只存在于 Full，缺失的元素不计入。
  const SETTINGS_DIRTY_IDS = [
    'cfgRoutingStrategy', 'cfgFirstByteTimeout', 'cfgCooldown429', 'cfgCooldown5xx',
    'cfgCooldownNet', 'cfgCooldownAuth', 'cfgOcrInflight', 'cfgKbConcurrency',
    'gwClientKey', 'cfgVaultUrl', 'cfgVaultToken',
  ];
  const settingsBaseline = {};
  let settingsSaveBar = null;

  function settingsSnapshot() {
    const snap = {};
    for (const id of SETTINGS_DIRTY_IDS) {
      const el = $(id);
      if (el) snap[id] = String(el.value ?? '');
    }
    return snap;
  }

  function markSettingsBaseline() {
    for (const k of Object.keys(settingsBaseline)) delete settingsBaseline[k];
    Object.assign(settingsBaseline, settingsSnapshot());
  }

  function settingsDirtyCount() {
    const cur = settingsSnapshot();
    return SETTINGS_DIRTY_IDS.reduce((n, id) => (id in cur && cur[id] !== settingsBaseline[id] ? n + 1 : n), 0);
  }

  function settingsSaveBarUpdate() {
    if (settingsSaveBar) settingsSaveBar.update(settingsDirtyCount());
  }

  // 放弃：二次确认后把所有可编辑字段回填成当前已保存的值。
  async function discardSettingsEdits() {
    const n = settingsDirtyCount();
    if (!n) return;
    const ok = await confirmDialog({
      title: '放弃未保存的修改',
      message: `确定放弃这 ${n} 项未保存的修改吗？输入框会恢复为当前已保存的值。`,
      confirmText: '放弃',
    });
    if (!ok) return;
    fillSettingsValues();
    markSettingsBaseline();
    settingsSaveBarUpdate();
    toast('已放弃未保存的修改', 'info');
  }

  function setupSettingsChrome() {
    const section = $('viewSettings');
    if (!section) return;
    if (!settingsSaveBar) {
      settingsSaveBar = createSaveBar({ onDiscard: discardSettingsEdits, onSave: saveSettingsFromBar });
      section.appendChild(settingsSaveBar.el);
    }
    // 脏检查挂在 section 上：输入框敲字（input）与下拉切换（change）都算改动；
    // 程序赋值（如「随机生成」）不触发事件，由触发方手动 settingsSaveBarUpdate()。
    section.addEventListener('input', settingsSaveBarUpdate);
    section.addEventListener('change', settingsSaveBarUpdate);
    renderSettingsAnchorNav();
    const seg = $('settingsAnchorSeg');
    if (seg && !seg.dataset.bound) {
      seg.dataset.bound = '1';
      seg.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-grp]') : null;
        if (!btn) return;
        const grp = $(btn.getAttribute('data-grp') || '');
        if (!grp || grp.hidden) return;
        seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
        grp.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    if (!setupSettingsChrome.scrollBound) {
      setupSettingsChrome.scrollBound = true;
      window.addEventListener('scroll', syncSettingsAnchor, { passive: true });
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

  // 目录抓取时间的展示统一走 fmtTime()（v2 §4.3：一分钟内「刚刚」、七天内
  // 相对时间、更早显示日期）。

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
    const when = fmtTime(m.fetched_at);
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

  // 按当前 state.config 回填所有可编辑字段（id 与 mountSettingRows 挂载的行一致）。
  // 分组显隐也在这里按端能力设置。每次回填后由 renderSettingsView 重取脏检查基线。
  function fillSettingsValues() {
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

    // 分组显隐：Base URL 行与 Hub 投影提示按端互换；模型目录只有 Hub 有。
    const gwBaseUrlGroup = $('gwBaseUrlGroup');
    const gwHubNotice = $('gwHubNotice');
    const gwSummaryPill = $('gwAccessSummaryPill');
    const sysBox = $('systemUpdateBox');

    if (gwBaseUrlGroup) gwBaseUrlGroup.hidden = !isFull;
    if (gwHubNotice) gwHubNotice.hidden = isFull;
    if (sysBox) sysBox.hidden = !window.HOST.capabilities.systemUpdate;
    // 模型目录 exists only on the Hub: it is the side that stores the catalog in
    // KV and may reach models.dev. A Full node pulls the artifact instead.
    const catalogBox = $('modelCatalogBox');
    if (catalogBox) catalogBox.hidden = !isHubMode();
    // 第 4 组的标题跟端走：Hub 是 models.dev 目录，Full 是预设与中枢同步。
    const grpCatalogTitle = $('grpCatalogTitle');
    if (grpCatalogTitle) grpCatalogTitle.textContent = isFull ? '预设与中枢同步' : '模型目录';

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

    if (window.HOST.capabilities.vaultClient) {
      const v = state.config?.vault || {};
      setVal('cfgVaultUrl', v.url || '');
      setVal('cfgVaultToken', v.node_token || '');
    }

    const rawArea = $('rawConfigTextarea');
    if (rawArea && $('rawJsonDetails')?.open) {
      rawArea.value = JSON.stringify(state.config, null, 2);
    }
  }

  function renderSettingsView() {
    state.config = state.config || {};
    state.config.settings = state.config.settings || {};
    const isFull = Boolean(window.HOST.capabilities.kbModels);

    fillSettingsValues();
    if (isHubMode()) renderModelCatalogCard();
    // 预设与中枢同步：Full only（Hub 没有这两个接口，不显示入口，约定 D）。
    renderPresetSyncRow();

    // 锚点计数摘要（Hub 5 组 / Full 6 组）。
    const countEl = $('settingsCount');
    if (countEl) countEl.textContent = `${settingsAnchorTargets().length} 组`;

    const gwClientKey = $('gwClientKey');
    const btnGen = $('btnGenClientKey');
    if (btnGen) {
      btnGen.onclick = () => {
        const rand = generateClientSecretKey();
        if (gwClientKey) gwClientKey.value = rand;
        // 程序赋值不触发 input 事件：手动刷新一次浮条。
        settingsSaveBarUpdate();
      };
    }

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

    // 回填完成 → 重取基线并刷新浮条（配置被外部改动/保存成功时浮条自动收起）。
    markSettingsBaseline();
    settingsSaveBarUpdate();
    syncSettingsAnchor();
  }

  // 保存浮条上的「保存」：与旧页头「保存全部设置」按钮完全相同的校验与落盘路径
  // （原 #btnSaveSettings 的处理体，按钮本身已由浮条取代）。
  async function saveSettingsFromBar() {
    state.config = state.config || {};
    state.config.settings = state.config.settings || {};
    const s = state.config.settings;

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

    const ck = ($('gwClientKey')?.value || '').trim();
    s.client_key = ck;
    s.proxy_api_key = ck;
    s.agent_routing_strategy = $('cfgRoutingStrategy')?.value || 'sticky_failover';
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

    const saved = await persistConfig('设置保存成功');
    if (saved) {
      markSettingsBaseline();
      settingsSaveBarUpdate();
    }
    // Vault URL/token may have just changed: drop the stale manifest snapshot so the
    // add-provider and template-import flows talk to the newly configured hub.
    await loadVaultManifest({ force: true });
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
