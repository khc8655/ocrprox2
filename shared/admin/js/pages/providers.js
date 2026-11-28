// providers.js — 供应商页（v2）：列表分组 + 筛选芯片 + Key 健康条，编辑与新增
// 都走弹框（详情 = 宽弹框，新增 = 预设网格弹框）；另含页签切换、启动数据加载、
// 中枢概览、最近请求汇总等跨页接驳（按原文件行序落位）。
  function setupCreationForms() {
    // 页头「添加供应商」：开新增弹框；弹框开着时按钮变「收起」= 再次点击关闭
    // （有改动先确认）。详情弹框开着时先关它，同一时刻只有一个弹框。
    clk($('btnAddProvider'), async () => {
      if (state.creatingProvider) {
        await requestCloseAddProviderDialog();
        return;
      }
      const pd = $('providerDialog');
      if (pd && !pd.hidden) {
        const closed = await requestCloseProviderDialog();
        if (!closed) return;
      }
      closeOtherCreateEditors('providers');
      state.creatingProvider = true;
      state.activeEditorKey = null;
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

    // 两个弹框的右上角 ✕ 与遮罩点击都走注册的关闭动作（closeDialogById 会调它）：
    // 有改动先 confirmDialog 确认，不直接丢。
    clk($('btnCloseProviderDialog'), () => { requestCloseProviderDialog(); });
    registerDialog('providerDialog', () => { requestCloseProviderDialog(); });
    clk($('btnCloseAddProvider'), () => { requestCloseAddProviderDialog(); });
    registerDialog('addProviderDialog', () => { requestCloseAddProviderDialog(); });
  }

  // 页头「添加供应商」按钮与新增弹框互斥：弹框开着时变「收起」且去掉主按钮样式
  // （单区域单主 CTA）。renderProvidersList 与弹框同步路径都调它。
  function syncAddButton() {
    const addBtn = $('btnAddProvider');
    if (!addBtn) return;
    addBtn.classList.toggle('btn--primary', !state.creatingProvider);
    addBtn.textContent = state.creatingProvider ? '收起' : '添加供应商';
  }

  // =====================================================================
  // 供应商详情弹框（组件 6 · 宽弹框 --dialog-w-wide）
  // state.activeEditorKey = 'p_<id>' 仍然表示「详情弹框为谁开着」：Esc / 切页签
  // 的全局接线不用改，renderProvidersList 末尾的 syncProviderDialogs() 负责把
  // state 与弹框 DOM 对齐。
  // =====================================================================

  // 脏检查：弹框打开时抓一份「表单值 + Key 结构」快照，关闭前对比。
  // last_test 等测试结论不算改动（测试不是编辑）；Key 增删 / 开关 / 权重算。
  function providerDialogSnapJson(pId, p) {
    const g = (id) => { const el = $(id); return el ? String(el.value ?? '') : ''; };
    const c = (id) => { const el = $(id); return el ? String(!!el.checked) : ''; };
    return JSON.stringify([
      g(`ed_p_name_${pId}`),
      g(`ed_p_base_${pId}`),
      g(`ed_p_preset_${pId}`),
      c(`ed_p_ant_on_${pId}`),
      g(`ed_p_ant_${pId}`),
      g(`ed_p_rpm_${pId}`),
      g(`ed_p_reset_${pId}`),
      c(`ed_p_hide_ua_${pId}`),
      g(`ed_p_rules_${pId}`),
      String(p.enabled !== false),
      (p.api_keys || []).map((k) => [k.label || '', k.enabled !== false, k.weight || 1].join('~')).join('|'),
    ]);
  }

  let providerDialogSnapVal = '';
  // 打开弹框时的供应商深拷贝：「放弃修改」时还原内存里的对象，否则被否决的
  // 改动（如 Key 开关）还留在 state.config 上，下一次保存会被一起带出去。
  let providerDialogBackup = null;
  let providerCloseConfirming = false;
  let addCloseConfirming = false;

  // 放弃修改：把打开时的快照还原回 state.config（保存失败后重开也用它兜底）。
  function restoreProviderDialogBackup() {
    if (!providerDialogBackup) return;
    const cur = state.config?.providers?.[providerDialogBackup.pId];
    if (cur) Object.assign(cur, JSON.parse(JSON.stringify(providerDialogBackup.data)));
    providerDialogBackup = null;
    providerDialogSnapVal = '';
  }

  function providerDialogDirty() {
    const dlg = $('providerDialog');
    const pId = dlg && !dlg.hidden ? (dlg.dataset.providerId || '') : '';
    if (!pId) return false;
    const p = state.config?.providers?.[pId];
    if (!p) return false;
    return providerDialogSnapJson(pId, p) !== providerDialogSnapVal;
  }

  function storeProviderDialogSnap() {
    const dlg = $('providerDialog');
    const pId = dlg && !dlg.hidden ? (dlg.dataset.providerId || '') : '';
    const p = pId ? state.config?.providers?.[pId] : null;
    providerDialogSnapVal = pId && p ? providerDialogSnapJson(pId, p) : '';
  }

  // 关闭详情弹框（✕ / 遮罩 / 取消 / 页头「收起」共用）：有改动先确认。
  // 返回 Promise<boolean>：true = 已关闭。
  function requestCloseProviderDialog() {
    const dlg = $('providerDialog');
    if (!dlg || dlg.hidden) return Promise.resolve(true);
    const pId = dlg.dataset.providerId || '';
    const finish = (discardChanges) => {
      if (discardChanges) restoreProviderDialogBackup();
      providerDialogBackup = null;
      state.activeEditorKey = null;
      dlg.dataset.providerId = '';
      closeDialog(dlg);
      renderProvidersList();
      return true;
    };
    if (!providerDialogDirty()) return Promise.resolve(finish(false));
    if (providerCloseConfirming) return Promise.resolve(false);
    providerCloseConfirming = true;
    return confirmDialog({
      title: '放弃未保存的修改？',
      message: `供应商 ${pId} 的弹框里有未保存的修改，关闭后将一起丢弃。`,
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      danger: true,
    }).then((ok) => {
      providerCloseConfirming = false;
      return ok ? finish(true) : false;
    });
  }

  // 详情弹框与 state 对齐（renderProvidersList 末尾调用）：
  //  - activeEditorKey 指向某供应商 → 没开就构建打开，开着就只刷新 Key 表；
  //  - activeEditorKey 已清但弹框还开着（Esc / 切页签走的全局接线）→ 本页签上
  //    有改动先确认；不在本页签（切走了）按旧行为静默收掉。
  function syncDetailDialog() {
    const dlg = $('providerDialog');
    if (!dlg) return;
    const key = String(state.activeEditorKey || '');
    const wantId = key.startsWith('p_') ? key.slice(2) : '';
    const openId = !dlg.hidden ? (dlg.dataset.providerId || '') : '';
    if (wantId && wantId === openId) { refreshProviderDialogKeys(wantId); return; }
    if (wantId) { buildProviderDialog(wantId); return; }
    if (!openId) return;
    if (providerCloseConfirming) return;
    if (state.activeTab !== 'providers' || !providerDialogDirty()) {
      dlg.dataset.providerId = '';
      closeDialog(dlg);
      return;
    }
    providerCloseConfirming = true;
    state.activeEditorKey = `p_${openId}`;
    confirmDialog({
      title: '放弃未保存的修改？',
      message: `供应商 ${openId} 的弹框里有未保存的修改，关闭后将一起丢弃。`,
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      danger: true,
    }).then((ok) => {
      providerCloseConfirming = false;
      if (ok && state.activeEditorKey === `p_${openId}`) {
        restoreProviderDialogBackup();
        providerDialogBackup = null;
        state.activeEditorKey = null;
        dlg.dataset.providerId = '';
        closeDialog(dlg);
        renderProvidersList();
      }
    });
  }

  // 新增弹框与 state.creatingProvider 对齐（同上）。
  function syncAddDialog() {
    const dlg = $('addProviderDialog');
    if (!dlg) return;
    if (state.creatingProvider) {
      if (dlg.hidden) buildAddProviderDialog();
      return;
    }
    if (dlg.hidden) return;
    if (addCloseConfirming) return;
    if (state.activeTab !== 'providers' || !addProviderDialogDirty()) {
      closeDialog(dlg);
      return;
    }
    addCloseConfirming = true;
    state.creatingProvider = true;
    syncAddButton();
    confirmDialog({
      title: '放弃未保存的内容？',
      message: '添加供应商弹框里已经填了内容，关闭后将一起丢弃。',
      confirmText: '放弃',
      cancelText: '继续填写',
      danger: true,
    }).then((ok) => {
      addCloseConfirming = false;
      if (ok) {
        state.creatingProvider = false;
        closeDialog(dlg);
        renderProvidersList();
      }
    });
  }

  function addProviderDialogDirty() {
    const dlg = $('addProviderDialog');
    if (!dlg || dlg.hidden) return false;
    const g = (id) => ($(id)?.value || '').trim();
    // cURL 粘贴框是临时材料（解析成功的值已进字段），不算未保存的改动。
    return Boolean(g('newProvName') || g('newProvBaseUrl') || g('newProvApiKey'));
  }

  function requestCloseAddProviderDialog() {
    const dlg = $('addProviderDialog');
    if (!dlg || dlg.hidden) return Promise.resolve(true);
    const finish = () => {
      state.creatingProvider = false;
      closeDialog(dlg);
      renderProvidersList();
      return true;
    };
    if (!addProviderDialogDirty()) return Promise.resolve(finish());
    if (addCloseConfirming) return Promise.resolve(false);
    addCloseConfirming = true;
    return confirmDialog({
      title: '放弃未保存的内容？',
      message: '添加供应商弹框里已经填了内容，关闭后将一起丢弃。',
      confirmText: '放弃',
      cancelText: '继续填写',
      danger: true,
    }).then((ok) => {
      addCloseConfirming = false;
      return ok ? finish() : false;
    });
  }

  function syncProviderDialogs() {
    syncDetailDialog();
    syncAddDialog();
  }

  // 构建详情弹框（宽弹框）：头 = logo + 名称 + 地址；体 = 启用 / 预设 / 接口地址
  // → Key 池表格 → 粘贴行 → （中枢补拉 / OAuth）→「高级设置」折叠；
  // 尾 = 左「删除供应商」（中枢托管另有「重新拉取」），右「取消 / 保存」。
  function buildProviderDialog(pId) {
    const p = state.config?.providers?.[pId];
    const dlg = $('providerDialog');
    if (!dlg) return;
    if (!p || typeof p !== 'object') {
      // 供应商已不存在（被别处删除 / 配置回读）：直接收掉，别留空壳。
      state.activeEditorKey = null;
      dlg.dataset.providerId = '';
      providerDialogBackup = null;
      closeDialog(dlg);
      return;
    }
    dlg.dataset.providerId = pId;
    // 深拷贝留作「放弃修改」的还原底片（见 restoreProviderDialogBackup）。
    providerDialogBackup = { pId, data: JSON.parse(JSON.stringify(p)) };
    const isVaultProv = !isHubMode() && p.origin === 'vault';
    const meta = presetMetaForProvider(p, p.preset_id);
    const head = $('providerDialogHead');
    if (head) {
      head.innerHTML = `${window.renderBrandIcon ? window.renderBrandIcon(p.name || pId, { off: p.enabled === false }) : ''}`
        + `<h2 class="dialog-title">${eh(p.name || pId)}</h2>`
        + `<span class="text-xs text-muted">${eh(hostOfBaseUrl(p.base_url || p.anthropic_base_url || '')) || '未配置接口地址'}</span>`;
    }
    const body = $('providerDialogBody');
    if (!body) return;

    // Hub 是预设的权威端：详情弹框里可改绑定（含「自定义（不绑定）」）；Full 只读。
    const hubPresetEditable = isHubMode() && !isVaultProv;
    const baseDefault = meta?.base_url || '';
    const antDefault = meta?.anthropic_base_url || '';
    const antEnabled = Boolean(p.anthropic_base_url) || normalizeApiType(p.api_type) === 'anthropic-messages';
    const adapterText = p.adapter_rules && Object.keys(p.adapter_rules).length > 0
      ? JSON.stringify(p.adapter_rules, null, 2)
      : '';
    // 中枢清单里的规则指纹与本地不一致 → 提示重新拉取。
    const manifestProv = isVaultProv ? vaultManifestProviders()[pId] || null : null;
    const ruleHashDrift = Boolean(
      manifestProv && manifestProv.rule_hash && p.rule_hash && manifestProv.rule_hash !== p.rule_hash
    );
    const showOAuth = Boolean(window.HOST.capabilities.oauthLogin && !isVaultProv
      && String(p.preset_id || pId || '').toLowerCase().startsWith('minimax'));
    const lockAttr = isVaultProv ? ' disabled' : '';

    body.innerHTML = `
      ${isVaultProv ? `<div class="notice-strip mb-2"><span>中枢托管供应商：名称、接口地址与适配规则由中枢统一管理（只读）。如需修改请在中枢操作后点「重新拉取」。</span></div>${ruleHashDrift ? '<div class="notice-strip notice-strip--warn mb-2"><span>中枢规则已更新：本地与中枢清单不一致，请点「重新拉取」同步。</span></div>' : ''}` : ''}
      <div class="form-2col">
        <label>启用</label><div id="ed_p_enable_slot"></div>
        <label>预设</label><div id="ed_p_preset_slot_${pId}"></div>
        <label>接口地址</label><div class="input-row"><input class="input input--code" id="ed_p_base_${pId}" value="${eh(p.base_url || '')}" placeholder="${eh(baseDefault || 'https://api.example.com/v1')}"${lockAttr}><button class="btn btn--sm" id="btn_base_default_${pId}" type="button" title="重置为预设默认"${baseDefault ? '' : ' disabled'}${lockAttr}>默认</button></div>
        <div class="dlg-secline"><span id="pKeysSectionHead">Key 池</span><span class="fields"><button class="btn btn--sm" id="btn_batch_test_keys_${pId}" type="button" title="用每把 Key 真发一句「你好」">${isHubMode() ? '逐把测 Key' : '全部测试'}</button><button class="btn btn--sm" id="btn_oauth_start_${pId}" type="button" ${showOAuth ? '' : 'hidden'}>OAuth 扫码登录</button></span></div>
        <div class="col-full">
          <div class="klist">
            <div id="p_keys_tbody_${pId}"></div>
            <div class="kadd">
              <input class="input kadd-lbl" id="new_key_lbl_${pId}" placeholder="标签（可选）">
              <input class="input kadd-val input--code privacy-mask" id="new_key_val_${pId}" placeholder="粘贴一把或多把 Key，换行分隔">
              <button class="btn" id="btn_add_key_${pId}" type="button">添加</button>
            </div>
          </div>
        </div>
        ${isVaultProv ? `
        <div class="col-full">
          <div class="section-bar"><span class="form-label">从中枢添加 Key（本地缺失的标签）</span><div class="fields"><button class="btn btn--sm" id="btn_vault_add_keys_${pId}" type="button">从中枢添加</button></div></div>
          <div class="probe-pills-wrap hidden" id="vault_keys_pick_${pId}" hidden></div>
          <div class="form-actions hidden" id="vault_keys_actions_${pId}" hidden><button class="btn btn--sm btn--primary" id="btn_vault_fetch_keys_${pId}" type="button">拉取所选 Key</button></div>
        </div>` : ''}
        <div class="col-full snippet-box hidden" id="oauth_box_${pId}" hidden>
          <div class="snippet-header"><span class="form-label">MiniMax OAuth 设备授权码:</span><span class="pill pill--amber" id="oauth_status_${pId}">等待扫码...</span></div>
          <div class="text-sm mt-1">请点击访问：<a id="oauth_link_${pId}" target="_blank" rel="noopener noreferrer" class="tabular"></a> 并在页面中输入验证码：<strong class="tabular" id="oauth_code_${pId}"></strong></div>
        </div>
        <div class="dlg-secline">限流与适配</div>
        <label>RPM 上限</label><div id="ed_p_rpm_slot_${pId}"></div>
        <label>每日重置</label><div><input class="input input--short" id="ed_p_reset_${pId}" value="${eh(p.quota_reset_at || '')}" placeholder="00:00"${lockAttr}></div>
        <label>客户端标识</label><div><label class="form-label form-label--check"><input type="checkbox" id="ed_p_hide_ua_${pId}" ${p.hide_client_name ? 'checked' : ''}${lockAttr}><span>不向上游透传客户端 UA</span></label></div>
        <label>供应商 ID</label><div class="fields"><span class="tabular text-sm">${eh(pId)}</span><span class="text-xs text-muted">· 保存后不可修改</span></div>
        <details class="adv-details">
          <summary>高级设置</summary>
          <div class="adv-body"><div class="form-2col">
            <label>名称</label><div><input class="input" id="ed_p_name_${pId}" value="${eh(p.name || pId)}"${lockAttr}></div>
            <label>Anthropic 端点</label><div><label class="form-label form-label--check"><input type="checkbox" id="ed_p_ant_on_${pId}" ${antEnabled ? 'checked' : ''}${lockAttr}><span>同时启用 /v1/messages 入口</span></label><div class="input-row mt-1"><input class="input input--code" id="ed_p_ant_${pId}" value="${eh(p.anthropic_base_url || antDefault)}" placeholder="${eh(antDefault || 'https://api.example.com/anthropic')}"${antEnabled ? '' : ' disabled'}${lockAttr}><button class="btn btn--sm" id="btn_ant_default_${pId}" type="button" title="重置为预设默认"${antDefault ? '' : ' disabled'}${lockAttr}>默认</button></div></div>
            <label>适配规则 JSON</label><div><textarea class="textarea textarea--json" id="ed_p_rules_${pId}" placeholder='{"stream_only":false}'${lockAttr}>${eh(adapterText)}</textarea></div>
          </div></div>
        </details>
      </div>`;

    const presetSlot = $(`ed_p_preset_slot_${pId}`);
    if (presetSlot) {
      const curPreset = String(p.preset_id || '').trim() || 'custom';
      const presetOpts = hubPresetEditable
        ? [{ value: 'custom', label: '自定义（不绑定）' }].concat(
          Object.values(PRESETS_META).map((m) => ({
            value: m.id,
            label: `${m.label} · ${m.preset_id || m.id}${m.version ? ` v${m.version}` : ''}`,
          }))
        )
        : [{
          value: curPreset,
          label: meta
            ? `${meta.label} · ${meta.preset_id || meta.id}${meta.version ? ` v${meta.version}` : ''}`
            : (p.preset_id || '自定义（未绑定预设）'),
        }];
      const ps = makePillSelect({
        id: `ed_p_preset_${pId}`,
        options: presetOpts,
        value: curPreset,
        disabled: !hubPresetEditable,
        ariaLabel: '预设',
      });
      presetSlot.appendChild(ps.el);
    }

    const rpmSlot = $(`ed_p_rpm_slot_${pId}`);
    if (rpmSlot) {
      const rpmSeg = makeSegPicker({
        id: `ed_p_rpm_${pId}`,
        presets: [
          { value: '', label: '不限' },
          { value: '60', label: '60' },
          { value: '300', label: '300' },
          { value: '1000', label: '1000' },
        ],
        value: p.rpm_per_key ? String(p.rpm_per_key) : '',
        allowEmpty: true,
        min: 1,
        disabled: isVaultProv,
      });
      rpmSlot.appendChild(rpmSeg.el);
    }

    const footLeft = $('providerDialogFootLeft');
    if (footLeft) {
      footLeft.innerHTML = `<button class="btn btn--ghost btn--danger" id="btn_del_prov_${pId}" type="button">删除供应商</button>${isVaultProv ? `<button class="btn" id="btn_refetch_prov_${pId}" type="button">重新拉取</button>` : ''}`;
    }
    const footRight = $('providerDialogFootRight');
    if (footRight) {
      // 中枢托管供应商没有「保存」（中枢是权威），本地 Key 的增删改即时落盘。
      footRight.innerHTML = `<button class="btn btn--ghost" id="btn_cancel_prov_${pId}" type="button">取消</button>${isVaultProv ? '' : `<button class="btn btn--primary" id="btn_save_prov_${pId}" type="button">保存</button>`}`;
    }

    // 顶部「启用」开关：关掉 = enabled:false，重新打开删掉字段（与旧配置形状一致）。
    const enableSlot = $('ed_p_enable_slot');
    if (enableSlot) {
      enableSlot.appendChild(makeSwitch({
        on: p.enabled !== false,
        disabled: isVaultProv,
        label: '启用这个供应商',
        onChange: (next) => {
          if (next) delete p.enabled;
          else p.enabled = false;
        },
      }));
    }

    // 先开弹框再填 Key 表 / 抓快照：两处都以「弹框可见」为前置（dataset 对上、
    // hidden 为假），关着的时候调用会被守卫直接跳过。
    openDialog(dlg, { focus: 'btnCloseProviderDialog' });
    buildProviderKeyTable(pId, p);
    wireProviderDialog(pId, p, { isVaultProv, baseDefault, antDefault, showOAuth });
    storeProviderDialogSnap();
  }

  // Key 池表格：行 + 节标题计数。只重建 tbody 与标题，表单字段与「全部测试」
  // 按钮不动（批量测试的进度不被重绘冲掉）。
  function buildProviderKeyTable(pId, p) {
    const dlg = $('providerDialog');
    if (!dlg || dlg.hidden || dlg.dataset.providerId !== pId) return;
    const keys = p.api_keys || [];
    const okCount = keys.filter((k) => keyHealthFlag(k) === true).length;
    const headEl = $('pKeysSectionHead');
    if (headEl) {
      headEl.textContent = `Key 池 · ${keys.length} 把${keys.length ? `，${okCount} 把可用` : ''}`;
    }
    const tbody = $(`p_keys_tbody_${pId}`);
    if (!tbody) return;
    const isVaultProv = !isHubMode() && p.origin === 'vault';
    tbody.innerHTML = '';
    keys.forEach((k, idx) => tbody.appendChild(buildProviderKeyRow(pId, p, k, idx, isVaultProv)));
  }

  // 刷新打开中的详情弹框（列表因保存 / 测试 / 冷却变化重绘时调用）。
  function refreshProviderDialogKeys(pId) {
    const dlg = $('providerDialog');
    if (!dlg || dlg.hidden || dlg.dataset.providerId !== pId) return;
    const p = state.config?.providers?.[pId];
    if (!p) {
      state.activeEditorKey = null;
      dlg.dataset.providerId = '';
      closeDialog(dlg);
      return;
    }
    buildProviderKeyTable(pId, p);
  }

  // Key 行（.krow）：启用开关 / 标签+掩码+被引用数（无权重框，v2.1 §1.8）/
  // 状态+最近测试时间（冷却中在状态下方给「立即解除」）/ 测试 +「⋯」菜单。
  function buildProviderKeyRow(pId, p, k, idx, isVaultProv) {
    const row = ce('div');
    row.className = 'krow';
    const keyLabel = k.label || k.id || `key-${idx}`;
    const cdInfo = findKeyCooldown(pId, k, idx);
    // 归属只看 Key 自身的 origin（缺失时回落到供应商 origin）：中枢托管供应商
    // 允许本地 Key 与中枢 Key 共存（约定 C）。Hub 控制台的 Key 一律是中枢的。
    const keyOrigin = String(k.origin || '').trim().toLowerCase()
      || (isHubMode() || p.origin === 'vault' ? 'vault' : 'local');
    const vaultKey = !isHubMode() && keyOrigin === 'vault';
    const keyIsVault = isHubMode() || keyOrigin === 'vault';
    const refs = routesUsingKey(pId, keyLabel);

    row.innerHTML = `
      <span class="k-enable-cell"></span>
      <div>
        <div class="krow-n">
          <span>${eh(keyLabel)}</span>
          ${k.auth_type === 'oauth_device' ? '<span class="pill pill--accent">OAuth</span>' : ''}
          ${!isHubMode() ? `<span class="text-xs text-muted">${keyIsVault ? '中枢' : '本地'}</span>` : ''}
        </div>
        <div class="krow-s">
          ${renderKeyCell(k, vaultKey, idx)}
          <span>· ${refs.length ? `用于 ${refs.length} 个模型` : '未被引用'}</span>
        </div>
      </div>
      <div class="krow-st k-status-cell">${keyStatusCellHtml(k, cdInfo.sec, cdInfo.target)}</div>
      <div class="krow-a">
        <button class="btn btn--sm btn--ghost btn_test_k" type="button" title="用这把 Key 真发一句「你好」">测试</button>
        <span class="key-menu-slot"></span>
      </div>
    `;
    row.dataset.keyIdx = String(idx);
    row.dataset.cdSec = String(cdInfo.sec);
    row.dataset.cdTarget = cdInfo.target || '';

    // 启用开关：中枢下发的 Key 只读；禁用被引用的 Key 前先确认（旧约定保留）。
    const sw = makeSwitch({
      on: k.enabled !== false,
      disabled: vaultKey,
      label: `启用 Key ${keyLabel}`,
      onChange: async (next) => {
        if (!next) {
          const refsNow = routesUsingKey(pId, keyLabel);
          if (refsNow.length > 0) {
            const ok = await confirmDialog({
              title: '禁用正在被引用的 Key',
              message: `Key [${keyLabel}] 正被以下路由引用：\n${refsNow.join('\n')}\n\n禁用后这些路由将没有可用 Key，请求可能返回 503。仍要禁用？`,
              confirmText: '仍要禁用',
            });
            if (!ok) {
              sw.setAttribute('aria-checked', 'true');
              return;
            }
          }
        }
        k.enabled = next;
        // 中枢托管供应商没有「保存」按钮：本地 Key 的开关要立即落盘（约定 C）。
        if (isVaultProv) persistConfig(`已${next ? '启用' : '禁用'}本地 Key [${keyLabel}]`).then(() => storeProviderDialogSnap());
        else renderProvidersList();
      },
    });
    row.querySelector('.k-enable-cell')?.appendChild(sw);

    clk(row.querySelector('.btn_test_k'), (e) => testOneKey(pId, k, keyLabel, e.currentTarget));

    // 「⋯」菜单：校验 / 解除冷却 / 删除此 Key。测试留在行内（常用）。
    const menuSlot = row.querySelector('.key-menu-slot');
    if (menuSlot) {
      menuSlot.appendChild(buildMenu([
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
          danger: true,
          onClick: () => clearSingleCooldown(cdInfo.target),
        },
        {
          label: '删除此 Key',
          cls: 'btn_del_k',
          danger: true,
          onClick: async () => {
            const refsNow = routesUsingKey(pId, keyLabel);
            if (refsNow.length > 0) {
              const ok = await confirmDialog({
                title: '删除正在被引用的 Key',
                message: `Key [${keyLabel}] 正被以下路由引用：\n${refsNow.join('\n')}\n\n删除后这些路由将没有可用 Key，请求可能返回 503。仍要删除？`,
                confirmText: '仍要删除',
              });
              if (!ok) return;
            }
            p.api_keys.splice(idx, 1);
            if (isVaultProv || (!isHubMode() && k.origin === 'vault')) {
              // Vault 供应商没有「保存」：删除必须立即落盘。中枢副本不受影响。
              const saved = await persistConfig(`本地已删除 Key [${keyLabel}]（中枢不受影响，可经「从中枢添加」或「重新拉取」恢复）`);
              if (saved) storeProviderDialogSnap();
            } else {
              renderProvidersList();
            }
          },
        },
      ], { label: `Key ${keyLabel} 的更多操作` }));
    }
    return row;
  }

  // 一把 Key 的状态列 HTML。冷却中的 Key 在时间旁给「立即解除」链接；有最近测试结论时给一行相对时间。
  function keyStatusCellHtml(k, cooldownSec, cdTarget) {
    const st = keyStatusView(k, cooldownSec);
    let html = `<span class="fields" title="${eh(st.title)}"><span class="dot ${st.dot}"></span><span class="text-xs">${eh(st.word)}</span></span>`;
    if (cooldownSec > 0) {
      html += `<div class="krow-s"><span>${eh(formatCooldown(cooldownSec))}后恢复 · </span><button class="text-link btn_clear_k_cd_inline" data-cd-target="${eh(cdTarget || '')}" type="button" title="到期前手动恢复调度">立即解除</button></div>`;
    } else {
      const testedAt = k && k.last_test && k.last_test.at ? fmtTime(k.last_test.at) : '';
      if (testedAt) {
        html += `<div class="krow-s">${eh(testedAt)}测试</div>`;
      }
    }
    return html;
  }

  // Key 状态：.dot + 一个词 + title 里的完整说明。
  // 失败原因要说人话，并且分清「该改谁」（REASON_HUMAN）。
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

  function keyStatusView(k, cooldownSec) {
    if (cooldownSec > 0) {
      return { dot: 'dot--warn', word: `冷却 ${formatCooldown(cooldownSec)}`, title: `冷却 ${formatCooldown(cooldownSec)}（到期后自动恢复）` };
    }
    const lt = k.last_test;
    if (lt && typeof lt === 'object') {
      if (lt.ok) {
        return { dot: 'dot--ok', word: `可用 · ${Number(lt.latency_ms) || 0}ms`, title: `${String(lt.reply_text || '').trim() || '上游返回 200（未抽到文本）'}${lt.at ? ` · ${fmtTime(lt.at)}` : ''}` };
      }
      const status = Number(lt.status) || 0;
      const reason = String(lt.reason || 'unknown');
      const errType = String(lt.err_type || '');
      // 限流和余额耗尽不是「Key 坏了」：用警告色而不是错误色，避免操作者
      // 看到一片红点就去删 Key。
      const soft = reason === 'rate_limited' || reason === 'quota_exhausted' || reason === 'timeout';
      return {
        dot: soft ? 'dot--warn' : 'dot--err',
        word: `失败 · ${reasonWord(reason)}`,
        title: `${lt.error || '上游无响应'}${errType ? ` · ${errType}` : ''}${status ? ` · HTTP ${status}` : ''}${lt.at ? ` · ${fmtTime(lt.at)}` : ''}`,
      };
    }
    if (k.last_ok === true) return { dot: 'dot--ok', word: `正常 · ${k.last_latency_ms || 0}ms`, title: '正常' };
    if (k.last_ok === false) return { dot: 'dot--err', word: `异常${k.last_status ? ` · ${k.last_status}` : ''}`, title: k.last_status ? `探活失败：${k.last_status}` : '探活失败' };
    return { dot: 'dot--warn', word: '就绪', title: '未测试' };
  }

  // 详情弹框的事件接线（buildProviderDialog 只出结构）。
  function wireProviderDialog(pId, p, ctx) {
    const isVaultProv = ctx.isVaultProv;
    const body = $('providerDialogBody');
    if (!body) return;
    const q = makeScopedQuery(body);

    const syncDraftFields = (target) => {
      const t = target || p;
      if (q(`#ed_p_name_${pId}`)) t.name = q(`#ed_p_name_${pId}`).value.trim();
      // 接口地址非空 = 有 OpenAI 兼容端点；清空 = 不再走这个端点。
      if (q(`#ed_p_base_${pId}`)) {
        const base = q(`#ed_p_base_${pId}`).value.trim();
        if (base) t.base_url = base;
        else delete t.base_url;
      }
      const anthOn = q(`#ed_p_ant_on_${pId}`)?.checked === true;
      if (anthOn && q(`#ed_p_ant_${pId}`)) t.anthropic_base_url = q(`#ed_p_ant_${pId}`).value.trim();
      else if (!anthOn) delete t.anthropic_base_url;
      if (q(`#ed_p_hide_ua_${pId}`)) {
        if (q(`#ed_p_hide_ua_${pId}`).checked) t.hide_client_name = true;
        else delete t.hide_client_name;
      }
      // 空值必须真的写回「没有」：留着旧值会让一次误填的重置时刻永远生效。
      if (q(`#ed_p_reset_${pId}`)) {
        const resetAt = q(`#ed_p_reset_${pId}`).value.trim();
        if (resetAt) t.quota_reset_at = resetAt;
        else delete t.quota_reset_at;
      }
      if (q(`#ed_p_rpm_${pId}`)) {
        const rpm = Number(q(`#ed_p_rpm_${pId}`).value);
        if (rpm > 0) t.rpm_per_key = rpm;
        else delete t.rpm_per_key;
      }
    };

    // --- Key 表格的行内委托：掩码显隐 + 冷却「立即解除」 ---
    const tbody = q(`#p_keys_tbody_${pId}`);
    if (tbody) {
      tbody.addEventListener('click', (ev) => {
        const reveal = ev.target instanceof Element ? ev.target.closest('.btn_reveal_key') : null;
        if (reveal) {
          ev.stopPropagation();
          const code = byIdIn(tbody, reveal.dataset.target);
          if (!code) return;
          const masked = code.dataset.masked === '1';
          if (masked) {
            code.textContent = code.dataset.full || code.textContent;
            code.dataset.masked = '0';
            reveal.textContent = '隐藏';
          } else {
            code.textContent = code.dataset.mask || code.textContent;
            code.dataset.masked = '1';
            reveal.textContent = '显示';
          }
          return;
        }
        const cdBtn = ev.target instanceof Element ? ev.target.closest('.btn_clear_k_cd_inline') : null;
        if (cdBtn && cdBtn.dataset.cdTarget) {
          ev.stopPropagation();
          clearSingleCooldown(cdBtn.dataset.cdTarget);
        }
      });
    }

    // 批量测试：进度写进按钮 + 每把结论落盘后重画状态列（详见 batchTestProviderKeys）。
    clk(q(`#btn_batch_test_keys_${pId}`), (e) => {
      batchTestProviderKeys(pId, e.currentTarget);
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
                  const cur = state.config?.providers?.[pId] || p;
                  cur.api_keys = cur.api_keys || [];
                  const expIn = Number(tok.expires_in) || 0;
                  cur.api_keys.push({
                    id: `k_oauth_${Date.now().toString(36)}`,
                    label: nextKeyLabel(cur.api_keys, 'oauth'),
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
                  const saved = await persistConfig('OAuth 授权成功，密钥已保存');
                  if (saved) storeProviderDialogSnap();
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

    // 添加 Key：一行粘贴框，可一次多把（换行分隔）。
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
        p.api_keys = p.api_keys || [];
        p.api_keys.push(...parsed.keys);
        if (isVaultProv) {
          persistConfig(`已在供应商 ${pId} 添加本地 Key（与中枢 Key 共存，互不影响）`).then((saved) => {
            if (saved) storeProviderDialogSnap();
          });
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
        const manifestProv = vaultManifestProviders()[pId] || null;
        if (!manifestProv) {
          // 中枢清单加载失败最常见的原因是边缘接口偶发 545：重新加载必须就地可点。
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
                renderKeyPick();
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
        const localLabels = new Set((p.api_keys || []).map((k) => k.label || k.id).filter(Boolean));
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
    // （按钮在弹框 foot 区，不在 body 里，用全局 $() 找。）
    const refetchBtn = $(`btn_refetch_prov_${pId}`);
    if (refetchBtn) {
      clk(refetchBtn, async () => {
        refetchBtn.disabled = true;
        toast(`正在重新拉取供应商 ${pId}（规则与全部 Key）...`, 'info');
        try {
          const res = await window.HOST.fetchVaultCredentials(pId);
          if (res && res.ok) {
            await loadData();
            // The refetch replaces the vault key list wholesale: flag routes whose
            // candidates now bind to missing key labels.
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

    // Toggle an endpoint: enabling the Anthropic endpoint seeds the input with the
    // preset's default URL if it was empty; disabling clears it on save.
    clk(q(`#ed_p_ant_on_${pId}`), () => {
      const on = q(`#ed_p_ant_on_${pId}`).checked;
      const inp = q(`#ed_p_ant_${pId}`);
      if (inp) {
        inp.disabled = !on || isVaultProv;
        if (on && !inp.value.trim() && ctx.antDefault) inp.value = ctx.antDefault;
      }
    });
    clk(q(`#btn_base_default_${pId}`), () => {
      const inp = q(`#ed_p_base_${pId}`);
      if (inp && ctx.baseDefault) inp.value = ctx.baseDefault;
    });
    clk(q(`#btn_ant_default_${pId}`), () => {
      const inp = q(`#ed_p_ant_${pId}`);
      if (inp && ctx.antDefault) inp.value = ctx.antDefault;
    });

    // 底部按钮在弹框的 foot 区，不在 body 里：用全局 $() 找（弹框同级只有一个）。
    const saveBtn = $(`btn_save_prov_${pId}`);
    if (saveBtn) {
      clk(saveBtn, async () => {
        // 弹框开着期间 state.config 可能被整体替换过：把编辑过的对象并回当前配置。
        const cur = state.config?.providers?.[pId] || p;
        if (cur !== p) Object.assign(cur, p);
        syncDraftFields(cur);
        delete cur.refresh_every;
        delete cur.auto_include;

        const rawRules = (q(`#ed_p_rules_${pId}`)?.value || '').trim();
        if (rawRules) {
          try {
            cur.adapter_rules = JSON.parse(rawRules);
          } catch (err) {
            return toast(`adapter_rules JSON 格式有误: ${err.message}`, 'err');
          }
        } else {
          delete cur.adapter_rules;
        }

        if (isHubMode()) {
          cur.origin = 'vault';
          (cur.api_keys || []).forEach((k) => { if (k) k.origin = 'vault'; });
          // Hub 端预设绑定下拉：custom（不绑定）/ 各预设 id。
          const presetSel = q(`#ed_p_preset_${pId}`);
          if (presetSel) {
            const v = String(presetSel.value || '').trim();
            if (v && v !== 'custom' && PRESETS_META[v]) cur.preset_id = PRESETS_META[v].preset_id || v;
            else delete cur.preset_id;
          }
        }

        const saved = await persistConfig('供应商保存成功', { scope: 'providers', key: pId, value: cur });
        if (saved) {
          state.activeEditorKey = null;
          dlgCloseProviderDialog();
          renderProvidersList();
        }
      });
    }

    const cancelBtn = $(`btn_cancel_prov_${pId}`);
    if (cancelBtn) {
      clk(cancelBtn, () => { requestCloseProviderDialog(); });
    }

    const delBtn = $(`btn_del_prov_${pId}`);
    if (delBtn) {
      clk(delBtn, async () => {
        const ok = await confirmDialog({
          title: '删除供应商',
          message: `确定删除供应商 ${pId} 吗？`,
          confirmText: '删除',
        });
        if (!ok) return;
        delete state.config.providers[pId];
        delete state.probedModelsByProvider[pId];
        // 先收弹框再保存：保存失败时由下方重新打开。
        state.activeEditorKey = null;
        dlgCloseProviderDialog();
        const saved = await persistConfig(isVaultProv ? `供应商 ${pId} 已从本地删除（中枢不受影响，可重新按需拉取）` : '供应商已删除');
        if (!saved) {
          // 没存上（中枢「空模板」守卫 / 版本冲突）→ 回读服务端配置并重新打开弹框，
          // 操作者看得见「没删掉」并能继续改。
          await loadData();
          state.activeEditorKey = `p_${pId}`;
          renderProvidersList();
        } else {
          renderProvidersList();
        }
      });
    }
  }

  // 关闭详情弹框的 DOM（不动 state；state 由调用方管）。保存 / 删除后的正常
  // 关闭走这里：打开时的还原底片一并清掉。
  function dlgCloseProviderDialog() {
    const dlg = $('providerDialog');
    if (!dlg) return;
    dlg.dataset.providerId = '';
    providerDialogBackup = null;
    providerDialogSnapVal = '';
    closeDialog(dlg);
  }

  // 单把 Key 的真实推理测试：服务端按 key_id / key_label 解析已存的密钥，
  // 浏览器不传密钥本体。结论落在 key 对象上（由「保存」持久化）。
  //
  // quiet=true 用于批量测：服务端每次都把结论落盘（配置版本 +1），批量里
  // 逐把追平版本号就是 2N 次往返。批量改在全部结束后追一次。
  async function testKeyOnce(pId, k, keyLabel, quiet) {
    const payload = { provider: pId, key_id: k.id || '', key_label: keyLabel };
    const routeModel = firstRouteTargetModel(pId);
    if (routeModel) payload.model = routeModel;
    try {
      const res = await window.HOST.testKey(payload);
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
  }

  // 单把 Key 的探活（校验）：不消耗推理额度，只确认凭据是否有效。
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
  }

  // 批量测一个供应商的全部 Key：3 路并发、逐把真实推理、结论即时重画到
  // Key 表格；连续 3 把被限流 / 余额不足就提前停。弹框里的「全部测试」与
  // 「添加并测试」共用这一条路径；btn 为空时进度只体现在 Key 表格上。
  async function batchTestProviderKeys(pId, btn) {
    const keys = state.config?.providers?.[pId]?.api_keys || [];
    const total = keys.length;
    if (total === 0) {
      toast('这个供应商还没有 Key，先添加一把', 'warn');
      return;
    }
    const label = btn ? btn.textContent : '';
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      // 置灰的同时就把计数改掉：不然从一个没变化的按钮跳到「2/6」，
      // 操作者会以为第一把被跳过了。
      btn.textContent = `测试中 0/${total}…`;
    }
    let succ = 0;
    let done = 0;
    let aborted = '';
    const redrawKeyRows = () => {
      const tbody = $(`p_keys_tbody_${pId}`);
      if (!tbody || !tbody.isConnected) return;
      tbody.querySelectorAll('.krow').forEach((row) => {
        const idx = Number(row.dataset.keyIdx);
        const k = keys[idx];
        const cell = row.querySelector('.k-status-cell');
        if (!k || !cell) return;
        const cd = findKeyCooldown(pId, k, idx);
        cell.innerHTML = keyStatusCellHtml(k, cd.sec, cd.target);
        row.dataset.cdSec = String(cd.sec);
        row.dataset.cdTarget = cd.target || '';
      });
    };
    // 串行测 6 把最坏 120 秒（每把 20 秒超时）。这里放到 3 路并发；
    // 连续 3 把都是 429 / 余额耗尽时，后面的 Key 结论早已注定。
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
      if (btn) btn.textContent = `测试中 ${Math.min(done + 1, total)}/${total}…`;
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
      // 先让出一拍，让按钮的「测试中 0/N」先画出来再开始发请求。用 setTimeout
      // 而不是 requestAnimationFrame：后台标签页的 rAF 永远不触发，整批会挂起。
      await new Promise((r) => setTimeout(r, 30));
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    } finally {
      // 只追一次版本号：中间每把落盘都会让版本前进，但本页此刻不再提交。
      await refreshConfigVersion();
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
      renderProvidersList();
    }
    const tested = okCount.size;
    if (tested === 0) {
      toast('没有测到任何 Key', 'warn');
    } else if (aborted) {
      toast(`${aborted}（测了 ${tested}/${total} 把，${succ} 把可用）`, 'warn');
    } else {
      toast(`逐把测试完成: ${succ}/${tested} 把 Key 可用`, succ === tested ? 'ok' : 'warn');
    }
  }

  // 某个页签的列表重绘：state 与 DOM 必须同步 —— state 标志清了但 DOM 没清
  // = 僵尸弹框（Esc 判 state 关不掉）。
  function renderTabList(tab) {
    if (tab === 'providers') renderProvidersList();
    else if (tab === 'models') renderModelsList();
    else if (tab === 'nodes') renderNodesList();
    else if (tab === 'activity') renderRecentRequests();
  }

  // create 弹框归哪个页签管：state 标志 → 页签。
  const CREATE_EDITOR_FLAGS = { providers: 'creatingProvider', models: 'creatingModel', nodes: 'creatingNode' };

  function anyCreateEditorTab() {
    for (const tab of Object.keys(CREATE_EDITOR_FLAGS)) {
      if (state[CREATE_EDITOR_FLAGS[tab]]) return tab;
    }
    return null;
  }

  // 关掉 create 弹框：state 清零后必须重绘它所属的列表，否则 DOM 上留下僵尸。
  function closeCreateEditor(tab) {
    const t = tab || anyCreateEditorTab();
    if (!t) return false;
    const flag = CREATE_EDITOR_FLAGS[t];
    if (!flag || !state[flag]) return false;
    state[flag] = false;
    renderTabList(t);
    return true;
  }

  // 开新的 create 弹框前，先关掉别处还开着的（同一时刻只有一个）。
  function closeOtherCreateEditors(keepTab) {
    for (const tab of Object.keys(CREATE_EDITOR_FLAGS)) {
      if (tab !== keepTab) closeCreateEditor(tab);
    }
  }

  function switchTab(tab) {
    stopOAuthPolling();
    // 弹框跟着它所属的页签走：切走再切回它还在、草稿也还在。
    // 所以这里**不**清 creatingProvider / creatingModel / creatingNode。
    const leaving = state.activeTab;
    const hadExpanded = Boolean(state.activeEditorKey || state.nodeInstallFor);
    state.activeTab = tab;
    state.activeEditorKey = null;
    state.nodeInstallFor = null;
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
        if (verEl) verEl.textContent = `配置 v${cfgResp._version || 1}`;

        renderProvidersList();
        renderModelsList();
        renderSettingsView();
        // 预设绑定落盘：中枢（2.14.0 及更早）不会在读取时自动绑定，而绑定是中枢
        // 权威的元数据 —— 在这里补上并写回一次。
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
            // version text reflects the server-refreshed adapter metadata.
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

      if (window.HOST.kind === 'hub' && state.activeTab === 'stats') {
        renderStatsView();
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
        if (window.HOST.kind === 'hub' && state.activeTab === 'stats') {
          renderStatsView();
        }
      }
    } catch (e) {
      toast(`节点加载失败: ${e.message}`, 'err');
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

  // =====================================================================
  // 供应商列表（组件 3 · listRow）：分组「需要处理 / 正常 / 已停用」问题优先，
  // 行 = logo + 名称 | 次要信息（预设版本 · 地址；出问题改为原因，红字）|
  // 状态 | Key 健康条 + N/M 可用 | 被 N 个模型使用。
  // =====================================================================

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

  // 去掉协议前缀的地址展示（api.siliconflow.cn/v1）。
  function hostOfBaseUrl(raw) {
    return String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }

  // 这个供应商被多少个模型路由引用（启用中的候选）。
  function countModelsUsingProvider(pId) {
    const agentModels = (state.config && state.config.agent_models) || {};
    let n = 0;
    for (const route of Object.values(agentModels)) {
      if ((route?.candidates || []).some((c) => c && c.provider === pId && c.enabled !== false)) n++;
    }
    return n;
  }

  // 供应商状态：一个词 + 一个点。综合「停用 / 无 Key / Key 健康 / 冷却 / 运行中」。
  function providerStatusWord(p, keyCount, okCount, failCount, coolingCount, busyCount, waitCount) {
    if (p.enabled === false) return { word: '已停用', dot: 'off' };
    if (!keyCount) return { word: '无 Key', dot: 'err' };
    if (failCount > 0 && okCount === 0) return { word: '异常', dot: 'err' };
    if (busyCount > 0) return { word: `运行中 ${busyCount}${waitCount ? ` (排队 ${waitCount})` : ''}`, dot: (failCount > 0 || coolingCount > 0) ? 'warn' : 'ok' };
    if (failCount > 0 || coolingCount > 0) return { word: '部分异常', dot: 'warn' };
    if (okCount > 0) return { word: '正常', dot: 'ok' };
    return { word: '未测', dot: 'warn' };
  }

  // 需要处理的行，次要信息直接写原因（说人话，红字由 subError 控制）。
  function providerProblemText(pId, p, keys, cooling) {
    if (!keys.length) return '还没有 Key，引用它的模型不会生效';
    for (const k of keys) {
      if (keyHealthFlag(k) === false) {
        const lt = k.last_test;
        const reason = lt && lt.reason ? reasonWord(lt.reason) : (k.last_status ? `探活失败 ${k.last_status}` : '测试失败');
        return `${k.label || k.id || 'Key'} · ${reason}`;
      }
    }
    if (cooling) return `${cooling.label} 冷却中，${formatCooldown(cooling.sec)}后恢复`;
    return '需要处理';
  }

  // 正常行的次要信息：精简地址（Full 中枢托管加「中枢」标记）。
  function providerPresetUrlText(p, pId) {
    const host = hostOfBaseUrl(p.base_url || p.anthropic_base_url || '') || '未配置接口地址';
    if (!isHubMode() && p.origin === 'vault') return `${eh(host)} · 中枢`;
    return eh(host);
  }

  // Key 健康条（v2.1 §2）：14x6 横条，颜色同状态色；超过 10 把省略后由旁边的 N/M 文本承载。
  function keyHealthDotsHtml(pId, keys, providerEnabled = true) {
    const parts = [];
    const shown = keys.slice(0, 10);
    if (!shown.length) {
      parts.push('<i class="kdots-bar" aria-hidden="true"></i>');
    } else {
      for (let i = 0; i < shown.length; i++) {
        const k = shown[i];
        let cls = 'kdots-bar';
        if (providerEnabled && k && k.enabled !== false) {
          if (findKeyCooldown(pId, k, i).sec > 0) cls = 'kdots-bar kdots-bar--warn';
          else if (keyHealthFlag(k) === true) cls = 'kdots-bar kdots-bar--ok';
          else if (keyHealthFlag(k) === false) cls = 'kdots-bar kdots-bar--err';
          else cls = 'kdots-bar kdots-bar--warn';
        }
        parts.push(`<i class="${cls}" aria-hidden="true"></i>`);
      }
    }
    if (keys.length > shown.length) parts.push('<span class="text-xs text-muted">…</span>');
    return `<span class="kdots">${parts.join('')}</span>`;
  }

  // 一个供应商的列表视图数据（分组 / 状态 / 次要信息 / 健康计数）。
  function providerView(pId, p) {
    const keys = p.api_keys || [];
    const okCount = keys.filter((k) => keyHealthFlag(k) === true).length;
    const failCount = keys.filter((k) => keyHealthFlag(k) === false).length;
    let cooling = null;
    let coolingCount = 0;
    keys.forEach((k, i) => {
      const cd = findKeyCooldown(pId, k, i);
      if (cd.sec > 0) {
        coolingCount++;
        if (!cooling || cd.sec > cooling.sec) cooling = { label: k.label || k.id || `key-${i}`, sec: cd.sec };
      }
    });
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
    const status = providerStatusWord(p, keys.length, okCount, failCount, coolingCount, busyCount, waitCount);
    let group = 'normal';
    if (p.enabled === false) group = 'disabled';
    else if (!keys.length || failCount > 0 || coolingCount > 0) group = 'attention';
    const usedBy = countModelsUsingProvider(pId);
    let sub = '';
    let subError = false;
    if (group === 'attention') {
      sub = eh(providerProblemText(pId, p, keys, cooling));
      subError = true;
    } else {
      sub = providerPresetUrlText(p, pId);
    }
    return { pId, p, keys, okCount, failCount, cooling, coolingCount, busyCount, waitCount, status, group, usedBy, sub, subError };
  }

  // 筛选分段（全部 / 需要处理 / 已停用，带数量，01-providers.png）。
  const PROVIDER_FILTER_DEFS = [['all', '全部'], ['attention', '需要处理'], ['disabled', '已停用']];

  function mountProviderFilterChips(counts) {
    const box = $('providerFilterChips');
    if (!box) return;
    if (!['all', 'attention', 'disabled'].includes(state.providerFilter)) state.providerFilter = 'all';
    const sig = `${counts.all}|${counts.attention}|${counts.disabled}`;
    if (box.dataset.sig === sig && box.firstElementChild) {
      box.querySelectorAll('.segp-btn').forEach((btn, i) => {
        btn.classList.toggle('on', state.providerFilter === PROVIDER_FILTER_DEFS[i][0]);
      });
      return;
    }
    box.dataset.sig = sig;
    box.innerHTML = '';
    const seg = ce('div');
    seg.className = 'segp';
    for (const [key, label] of PROVIDER_FILTER_DEFS) {
      const b = ce('button');
      b.type = 'button';
      b.className = `segp-btn${state.providerFilter === key ? ' on' : ''}`;
      b.textContent = `${label} ${counts[key]}`;
      b.title = `只看${label}的供应商`;
      clk(b, () => {
        state.providerFilter = key;
        renderProvidersList();
      });
      seg.appendChild(b);
    }
    box.appendChild(seg);
  }

  function buildProviderListRow(v) {
    const updateFlag = state.presetUpdateFlags[v.pId];
    const title = `<span>${eh(v.p.name || v.pId)}</span>${updateFlag
      ? ` <span class="pill pill--warn">可更新${typeof updateFlag === 'string' ? ` → v${eh(updateFlag)}` : ''}</span>`
      : ''}`;
    const isOff = v.group === 'disabled';
    // 健康条 + N/M 可用（停用 / 无 Key 显示「N 把」）。
    const extra = isOff || !v.keys.length
      ? `${keyHealthDotsHtml(v.pId, v.keys, !isOff)}<span class="tabular">${v.keys.length} 把</span>`
      : `${keyHealthDotsHtml(v.pId, v.keys, true)}<span class="tabular">${v.okCount}/${v.keys.length} 可用</span>`;
    return listRow({
      logo: { name: v.p.name || v.pId, off: isOff },
      off: isOff,
      title,
      sub: v.sub,
      subError: v.subError,
      extra,
      status: { dot: v.status.dot, label: v.status.word },
      count: `${v.usedBy} 个模型`,
      onOpen: () => {
        state.activeEditorKey = `p_${v.pId}`;
        state.creatingProvider = false;
        renderProvidersList();
      },
    });
  }

  function renderProvidersList() {
    const container = $('providersList');
    if (!container) return;
    // 列表即将重建（innerHTML 替换）：挂在旧 DOM 上的菜单浮层会变成死元素，
    // 先关掉，别让它们留在 openMenus 里干扰 Esc。
    closeAllMenus();
    syncAddButton();
    container.innerHTML = '';

    const providers = (state.config && state.config.providers) || {};
    const q = state.providerQuery || '';
    const f = state.providerFilter || 'all';
    if (!['all', 'attention', 'disabled'].includes(f)) state.providerFilter = 'all';

    // 全量视图（计数、健康条都以全量为准）+ 全局统计。
    const allViews = [];
    let gKeys = 0;
    let gOk = 0;
    let gAttention = 0;
    let gDisabled = 0;
    for (const pId of Object.keys(providers).sort()) {
      const v = providerView(pId, providers[pId] || {});
      allViews.push(v);
      gKeys += v.keys.length;
      gOk += v.okCount;
      if (v.group === 'attention') gAttention++;
      if (v.group === 'disabled') gDisabled++;
    }

    mountProviderFilterChips({ all: allViews.length, attention: gAttention, disabled: gDisabled });
    const countEl = $('providersCount');
    if (countEl) {
      countEl.textContent = allViews.length
        ? `${allViews.length} 个 · ${gKeys} 把 Key · ${gOk} 把可用`
        : '';
    }

    const views = allViews.filter((v) => {
      if (f === 'attention' && v.group !== 'attention') return false;
      if (f === 'disabled' && v.group !== 'disabled') return false;
      if (q) {
        const keyLabels = v.keys.map((k) => k.label || k.id || '').join(' ');
        const hay = `${v.pId} ${v.p.name || ''} ${v.p.base_url || ''} ${v.p.preset_id || ''} ${keyLabels}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (views.length === 0) {
      const filtered = Boolean(q) || f !== 'all';
      const card = ce('div');
      card.className = 'gcard card-pad';
      const msg = ce('p');
      msg.className = 'text-muted';
      msg.textContent = filtered
        ? '没有符合筛选条件的供应商'
        : '还没有供应商：选一个预设、填上游地址与密钥，网关就能转发';
      card.appendChild(msg);
      if (!filtered) {
        const btn = ce('button');
        btn.type = 'button';
        btn.className = 'btn mt-3';
        btn.textContent = '添加供应商';
        clk(btn, () => {
          state.creatingProvider = true;
          state.activeEditorKey = null;
          renderProvidersList();
        });
        card.appendChild(btn);
      }
      container.appendChild(card);
      syncProviderDialogs();
      return;
    }

    // 分组卡片（01-providers.png）：组标题在卡片外（.glabel），行在卡片内（.gcard）。
    const GROUP_DEFS = [['attention', '需要处理'], ['normal', '正常'], ['disabled', '已停用']];
    for (const [gkey, glabel] of GROUP_DEFS) {
      const items = views.filter((v) => v.group === gkey);
      if (!items.length) continue;
      if (f === 'all') {
        const gl = ce('div');
        gl.className = 'glabel';
        gl.textContent = `${glabel} · ${items.length}`;
        container.appendChild(gl);
      }
      const card = ce('div');
      card.className = 'gcard';
      for (const v of items) card.appendChild(buildProviderListRow(v));
      container.appendChild(card);
    }

    syncProviderDialogs();
  }

  // 供应商 ID 由名称自动生成（保存后不可再改）。
  function providerIdFromName(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  // ID 只是内部标识，不需要可读。纯中文名或生成的 ID 已被占用时，退到一个
  // 不与现有供应商冲突的随机短 ID，而不是拦住保存。
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

  // 协议默认自动识别：探测上游支持的第一种协议；探测不通就回落到 OpenAI 兼容。
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

  // =====================================================================
  // 添加供应商弹框：搜索 + 预设网格（末尾「自定义」）→ 名称 / 地址 / Key；
  // 尾部左「粘贴 cURL」（Full 另有「改用中枢托管供应商」），右「取消 / 添加并测试」。
  // =====================================================================

  function protoLabel(apiType) {
    const t = normalizeApiType(apiType);
    if (t === 'anthropic-messages') return 'Anthropic';
    if (t === 'gemini') return 'Gemini';
    if (t === 'ocr') return 'OCR';
    return 'OpenAI 兼容';
  }

  function renderAddProvTiles() {
    const box = $('addProvTiles');
    if (!box) return;
    const qStr = ($('addProvSearch')?.value || '').trim().toLowerCase();
    box.innerHTML = '';
    const entries = Object.values(PRESETS_META)
      .filter((m) => !qStr || `${m.id} ${m.label}`.toLowerCase().includes(qStr));
    for (const m of entries) {
      const tile = ce('button');
      tile.type = 'button';
      tile.className = `tile${state.addProvPresetId === m.id ? ' on' : ''}`;
      tile.title = m.base_url || '';
      tile.innerHTML = `${window.renderBrandIcon ? window.renderBrandIcon(m.label, { sm: true }) : ''}`
        + `<div class="tile-meta"><div class="tile-name">${eh(m.label)}</div><small class="tile-proto">${eh(protoLabel(m.api_type))}${m.version ? ` · v${eh(m.version)}` : ''}</small></div>`;
      clk(tile, () => {
        state.addProvPresetId = m.id;
        fillAddProvFromPreset(m);
        renderAddProvTiles();
      });
      box.appendChild(tile);
    }
    // 末尾「自定义」：任意兼容接口。不预设任何东西，保存时按名称 / 地址自动匹配。
    const customTile = ce('button');
    customTile.type = 'button';
    customTile.className = `tile dash${state.addProvPresetId === 'custom' ? ' on' : ''}`;
    customTile.innerHTML = '<span class="av av--sm av--dash" aria-hidden="true">+</span>'
      + '<div class="tile-meta"><div class="tile-name">自定义</div><small class="tile-proto">任意兼容接口</small></div>';
    clk(customTile, () => {
      state.addProvPresetId = 'custom';
      const titleEl = $('addProvSectionTitle');
      if (titleEl) titleEl.textContent = '自定义供应商';
      const hintEl = $('addProvPresetHint');
      if (hintEl) hintEl.textContent = '';
      renderAddProvTiles();
    });
    box.appendChild(customTile);
    const emptyEl = $('addProvTilesEmpty');
    if (emptyEl) {
      emptyEl.hidden = entries.length > 0;
      emptyEl.classList.toggle('hidden', entries.length > 0);
    }
  }

  // 点预设块：名称与地址自动填好（地址来自预设库）。
  function fillAddProvFromPreset(m) {
    const titleEl = $('addProvSectionTitle');
    if (titleEl) titleEl.textContent = m.label;
    const hintEl = $('addProvPresetHint');
    if (hintEl) hintEl.textContent = m.version ? `适配 v${m.version}${m.updated_at ? ` · ${m.updated_at}` : ''}` : '';
    const nameEl = $('newProvName');
    if (nameEl) nameEl.value = m.label;
    const baseEl = $('newProvBaseUrl');
    if (baseEl && m.base_url) baseEl.value = m.base_url;
  }

  function buildAddProviderDialog() {
    const dlg = $('addProviderDialog');
    const body = $('addProviderDialogBody');
    if (!dlg || !body) return;
    body.innerHTML = `
      <div class="search-box">
        <span class="search-ico">${window.uiIcon ? window.uiIcon('search') : ''}</span>
        <input class="input search-input" id="addProvSearch" placeholder="搜索 ${Object.keys(PRESETS_META).length} 个预设" aria-label="搜索预设">
      </div>
      <div class="tiles mt-2" id="addProvTiles"></div>
      <div class="text-xs text-muted mt-2" id="addProvTilesEmpty" hidden>没有匹配的预设</div>
      <div class="mt-3" id="newProvVaultGroup" hidden>
        <div class="section-bar"><span class="form-label">选择中枢托管供应商（仅列出本地缺失的）</span></div>
        <div class="probe-pills-wrap" id="newProvVaultPick"></div>
        <span class="text-xs text-muted" id="newProvVaultHint"></span>
      </div>
      <div class="dlg-secline mt-3">
        <span id="addProvSectionTitle">自定义供应商</span>
        <span class="text-xs text-muted" id="addProvPresetHint"></span>
      </div>
      <div class="form-grid mt-2">
        ${fg('名称', `<input class="input" id="newProvName" placeholder="例如 DeepSeek 官方">`)}
        ${fg('接口地址', `<input class="input input--code" id="newProvBaseUrl" placeholder="https://api.example.com/v1">`)}
        ${fg('API Key', `<textarea class="textarea input--code privacy-mask" id="newProvApiKey" placeholder="粘贴一把或多把 Key，换行分隔；添加后会逐把测试"></textarea>`, 'newProvApiKeyGroup', 'form-group--full')}
      </div>
      <div class="form-group mt-2${isHubMode() ? ' hidden' : ''}" id="addProvProbeGroup"${isHubMode() ? ' hidden' : ''}>
        <label class="form-label form-label--check"><input type="checkbox" id="addProvProbeModels" checked><span>添加后从上游拉取模型列表，方便在模型页挑选</span></label>
      </div>
      <div class="form-group mt-2 hidden" id="curlPasteWrap" hidden>
        <textarea class="textarea input--code" id="curlPasteInput" placeholder="粘贴 curl 命令，自动解析出接口地址与密钥"></textarea>
      </div>
      <input type="hidden" id="newProvSource" value="custom">
    `;
    const footLeft = $('addProviderFootLeft');
    if (footLeft) {
      footLeft.innerHTML = `<span class="text-xs text-muted">也可以 <button type="button" class="text-link" id="btnToggleCurlPaste">粘贴 cURL</button> 自动识别</span>`
        + `<button type="button" class="text-link ml-2" id="btnProvSourceToggle" hidden>改用中枢托管供应商</button>`;
    }
    const footRight = $('addProviderFootRight');
    if (footRight) {
      footRight.innerHTML = `<button class="btn btn--ghost" id="btnCancelAddProvider" type="button">取消</button>`
        + `<button class="btn btn--primary" id="btnConfirmAddProvider" type="button">添加并测试</button>`;
    }
    state.addProvPresetId = 'custom';
    renderAddProvTiles();
    wireAddProviderDialog();
    // 按当前角色收敛（Hub 隐藏「中枢托管」，并把表单置到 custom 模式）。
    applyNewProvSourceMode();
    openDialog(dlg, { focus: 'addProvSearch' });
  }

  function wireAddProviderDialog() {
    $('addProvSearch')?.addEventListener('input', () => renderAddProvTiles());

    // 名称输入：自动匹配预设并填空着的地址（规则 A，overview.js）。
    $('newProvName')?.addEventListener('input', () => {
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
          toast('已从 cURL 自动解析填充接口地址与密钥！', 'ok');
        }
      });
    }

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

    clk($('btnCancelAddProvider'), () => { requestCloseAddProviderDialog(); });
    clk($('btnConfirmAddProvider'), () => { submitAddProvider(); });
  }

  // 「添加并测试」：中枢托管走一次性拉取；自定义 / 预设走创建 → 落盘 →
  // 打开详情弹框 → 逐把测试 →（可选）拉取上游模型列表。
  async function submitAddProvider() {
    const sourceVal = $('newProvSource')?.value || 'custom';

    if (sourceVal === 'vault') {
      const pickId = state.addProvVaultPick;
      if (!pickId) return toast('请在上方列表里点「添加」拉取中枢托管供应商', 'warn');
      if (state.config?.providers?.[pickId]) {
        return toast(`供应商 ${pickId} 已存在：中枢托管供应商可在其详情弹框中「重新拉取」，本地创建的供应商请先删除或改名`, 'warn');
      }
      const btn = $('btnConfirmAddProvider');
      if (btn) btn.disabled = true;
      toast(`正在从中枢拉取供应商 ${pickId}（规则与全部 Key）...`, 'info');
      try {
        const res = await window.HOST.fetchVaultCredentials(pickId);
        if (res && res.ok) {
          state.activeEditorKey = `p_${pickId}`;
          state.creatingProvider = false;
          // 先收添加弹框再 loadData：走 sync 会把它当「有改动未保存」拦下来确认。
          closeDialog($('addProviderDialog'));
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

    const name = ($('newProvName')?.value || '').trim();
    const baseUrl = ($('newProvBaseUrl')?.value || '').trim();
    const apiKey = ($('newProvApiKey')?.value || '').trim();
    if (!name) return toast('请输入供应商名称', 'warn');
    if (!baseUrl) return toast('请输入接口地址', 'warn');
    if (!apiKey) return toast('请输入 API Key', 'warn');

    // 预设块选中 → 直接用该预设；「自定义」→ 按名称 / 地址主机自动匹配（规则 A）。
    let resolvedPresetId = '';
    let matchedMeta = null;
    if (state.addProvPresetId && state.addProvPresetId !== 'custom' && PRESETS_META[state.addProvPresetId]) {
      resolvedPresetId = PRESETS_META[state.addProvPresetId].preset_id || state.addProvPresetId;
      matchedMeta = PRESETS_META[state.addProvPresetId];
    } else {
      matchedMeta = matchPresetMeta(name, baseUrl);
      if (matchedMeta) resolvedPresetId = matchedMeta.preset_id || matchedMeta.id || '';
    }

    const id = resolvedPresetId || autoProviderId(name);
    const existing = (state.config && state.config.providers) || {};
    if (existing[id]) return toast(`供应商 ID「${id}」已存在，请换一个名称或预设`, 'warn');

    // 协议：预设块已选 → 用预设库里的协议（可信）；自定义 → 探测上游，失败回落
    // OpenAI 兼容（与旧行为一致）。
    const apiType = matchedMeta && matchedMeta.api_type
      ? normalizeApiType(matchedMeta.api_type)
      : await detectProviderProtocol(baseUrl, apiKey);

    state.config = state.config || { providers: {}, agent_models: {} };
    state.config.providers = state.config.providers || {};

    const defOrigin = isHubMode() ? 'vault' : 'local';
    const parsed = parseMultiApiKeys(apiKey, 'k1', [], defOrigin);
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

    const saved = await persistConfig('供应商创建成功');
    if (!saved) return; // 创建失败：弹框留在原地，已填内容不丢
    state.creatingProvider = false;
    // 先收添加弹框（绕过 sync 的脏检查确认），再打开新供应商的详情弹框。
    closeDialog($('addProviderDialog'));
    state.activeEditorKey = `p_${id}`;
    renderProvidersList();

    // 逐把测试（真实推理），结论即时反映到详情弹框的 Key 表格。
    await batchTestProviderKeys(id, null);

    // 可选：从上游拉取模型列表（Full 端才有探测能力），缓存给模型页挑选。
    if ($('addProvProbeModels')?.checked && !isHubMode() && window.HOST.probeModels) {
      try {
        const probe = await window.HOST.probeModels({ base_url: baseUrl, api_key: apiKey });
        if (probe && (probe.ok || probe.count)) {
          state.probedModelsByProvider[id] = probe.models || [];
          toast(`已拉取 ${probe.count || probe.models?.length || 0} 个上游模型，可在模型页挑选`, 'ok');
        }
      } catch (_) {}
    }
  }
