// models.js — 模型页 v2：listRow 列表 + 「添加模型」「编辑模型」两个弹框 + 模板导入。
// 列表行只能来自 core.js 的 listRow()（v2 §4.1）；折叠只出现在弹框内的
// <details class="adv-details">；时间统一走 fmtTime()。
// 模型名可能含点号 / 空格 / 斜杠（历史 bug）：所有 id 都是静态的，
// 模型名只作为普通文本与 data-* 值出现，从不进 CSS 选择器。

  // ============ 候选 / 路由的公共读法（列表行与两个弹框共用） ============

  // 候选（供应商:Key）的剩余冷却秒数：state.cooldownsAll 条目
  // target = p:<provider>:k:<key>[:m:<model>]。
  function candCooldownSec(pId, keyLabel) {
    let best = 0;
    const prefix = `p:${pId}:k:${keyLabel}`;
    for (const entry of state.cooldownsAll || []) {
      const t = String(entry?.target || '');
      if ((t === prefix || t.startsWith(`${prefix}:`)) && (entry.remaining_sec || 0) > best) {
        best = entry.remaining_sec || 0;
      }
    }
    return best;
  }

  function providerNameOf(pId) {
    return String(state.config?.providers?.[pId]?.name || pId || '');
  }

  // 「任一 Key」的来源取该供应商里最好的一把：有可用取最快可用，
  // 否则第一个非冷却的，再退到第一把。
  function pickBestKeyFor(pId, prov) {
    const keys = (prov?.api_keys || []).filter((k) => k && k.enabled !== false);
    if (keys.length === 0) return null;
    const usable = keys.filter((k) => candCooldownSec(pId, k.label || k.id || '') === 0 && keyHealthFlag(k) !== false);
    const pool = usable.length ? usable : keys.filter((k) => candCooldownSec(pId, k.label || k.id || '') === 0);
    const src = pool.length ? pool : keys;
    return src.reduce((bestK, k) => {
      if (!bestK) return k;
      const a = Number(k.last_test?.latency_ms) || Infinity;
      const b = Number(bestK.last_test?.latency_ms) || Infinity;
      return a < b ? k : bestK;
    }, null);
  }

  // 单个候选现在能不能真正跑起来：供应商在、Key 在且启用、不在冷却、
  // 没有失败的测试结论（未测也算可用——只是还没证据）。
  function candUsable(c) {
    const pId = String(c.provider || '');
    const prov = state.config?.providers?.[pId];
    if (!prov || c.enabled === false) return false;
    const keyLabel = String(c.key_label || '');
    const keys = (prov.api_keys || []).filter((k) => k && k.enabled !== false);
    const k = keyLabel ? keys.find((x) => (x.label || x.id) === keyLabel) || null : pickBestKeyFor(pId, prov);
    if (!k) return false;
    if (candCooldownSec(pId, k.label || k.id || '') > 0) return false;
    return keyHealthFlag(k) !== false;
  }

  // 列表行 / 弹框头的状态词：无来源 / 停用 / 可用 / 部分可用 / 不可用。
  function routeStatusOf(m) {
    const cands = (m?.candidates || []).filter(Boolean);
    if (cands.length === 0) return { dot: 'off', word: '无来源' };
    if (m.enabled === false) return { dot: 'off', word: '停用' };
    const usable = cands.filter((c) => candUsable(c)).length;
    if (usable === cands.length) return { dot: 'ok', word: '可用' };
    if (usable > 0) return { dot: 'warn', word: '部分可用' };
    return { dot: 'err', word: '不可用' };
  }

  // 高级折叠里的复选行（两处弹框共用一段骨架）。
  function checkRow(id, checked, text) {
    return `<div class="col-full"><label class="form-label--check"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span>${text}</span></label></div>`;
  }

  // 状态格统一画法：.dot + 一个词（列表、候选表、弹框头共用）。
  function dotWord(dot, word, title) {
    return `<span class="fields"${title ? ` title="${eh(title)}"` : ''}><span class="dot dot--${dot}"></span><span class="text-xs text-muted">${eh(word)}</span></span>`;
  }

  // 候选状态格：冷却 Xs / 可用 · 120ms / 失败 · 503 / 未测。
  // title 里带上测试时间（fmtTime）与上游回复摘要。
  function candStatusHtml(c) {
    const pId = String(c.provider || '');
    const prov = state.config?.providers?.[pId];
    if (!prov) return '<span class="text-xs text-muted">供应商不存在</span>';
    const keyLabel = String(c.key_label || '');
    const keys = (prov.api_keys || []).filter((k) => k && (k.label || k.id));
    const k = keyLabel ? keys.find((x) => (x.label || x.id) === keyLabel) || null : pickBestKeyFor(pId, prov);
    if (!k) return '<span class="text-xs text-muted">无可用 Key</span>';
    const cd = candCooldownSec(pId, k.label || k.id || '');
    if (cd > 0) return dotWord('warn', `冷却 ${formatCooldown(cd)}`, '候选绑定 Key 正在冷却');
    const lt = k.last_test;
    if (lt && typeof lt === 'object') {
      const when = fmtTime(lt.at);
      const at = `${when ? `${when}测试 · ` : ''}`;
      if (lt.ok) return dotWord('ok', `可用 · ${Number(lt.latency_ms) || 0}ms`, `${at}${String(lt.reply_text || '').trim() || '上游返回 200'}`);
      return dotWord('err', `失败${Number(lt.status) ? ` · ${lt.status}` : ''}`, `${at}${String(lt.error || '上游无响应')}`);
    }
    if (keyHealthFlag(k) === true) return dotWord('ok', '正常');
    if (keyHealthFlag(k) === false) return dotWord('err', '异常');
    return dotWord('warn', '未测');
  }

  // 每候选 Key 下拉：第一项「任一」（= 展开该供应商全部启用 Key），其后是
  // 真实存在的 Key 标签；已绑定但本地缺失的标签照样显示，不静默改成「任一」。
  function keyOptsHtml(c) {
    const prov = state.config?.providers?.[c.provider] || {};
    const keys = (prov.api_keys || []).filter((k) => k && (k.label || k.id));
    const wanted = String(c.key_label || '');
    const opts = [`<option value=""${wanted ? '' : ' selected'}>任一</option>`];
    for (const k of keys) {
      const label = String(k.label || k.id);
      const off = k.enabled === false ? '（已禁用）' : '';
      opts.push(`<option value="${eh(label)}"${label === wanted ? ' selected' : ''}>${eh(label)}${off}</option>`);
    }
    if (wanted && !keys.some((k) => String(k.label || k.id) === wanted)) {
      opts.push(`<option value="${eh(wanted)}" selected>${eh(wanted)}（本地缺失）</option>`);
    }
    return opts.join('');
  }

  // 候选去重键：供应商 ‡ 上游模型（空 = 路由名，调度器同序回退）‡ Key 标签。
  function candKeyOf(c, routeName) {
    return `${c.provider}‡${String(c.target_model || '').trim() || routeName}‡${c.key_label || ''}`;
  }

  // 落盘前把每个候选补齐后端契约缺省：enabled 缺省 true、weight ≥1、
  // max_concurrency ≥0（后端读的就是这三个字段）。
  function normCands(cands) {
    for (const c of cands) {
      c.enabled = c.enabled !== false;
      c.weight = Math.max(1, Number(c.weight) || 1);
      c.max_concurrency = Math.max(0, Number(c.max_concurrency) || 0);
    }
  }

  // 「已添加」判定：这个供应商下哪些上游模型已经是任何路由的来源。
  function existingTargets(pId) {
    const set = new Set();
    for (const [name, route] of Object.entries(state.config?.agent_models || {})) {
      for (const c of (route?.candidates || [])) {
        if (c && c.provider === pId) set.add(String(c.target_model || '').trim() || String(name));
      }
    }
    return set;
  }

  // 思考档位下拉（per 候选 / per 添加流程）：档位阶梯来自 models.dev 目录
  //（异步），没到之前留空——不显示可能被误认成真值的占位符。
  function effortControlHtml(current, info) {
    const follow = '<option value="">跟随客户端</option>';
    if (!info || info.ok === false || !info.found) {
      return '<span class="text-xs text-muted">—</span>';
    }
    const efforts = Array.isArray(info.efforts) ? info.efforts.filter(Boolean) : [];
    if (efforts.length > 0) {
      // 旧目录里存过的档位即使目录不再提供也保留可见：改动必须是显式的。
      const extra = current && !efforts.includes(current) && current !== 'on' && current !== 'off'
        ? `<option value="${eh(current)}" selected>${eh(current)}（当前已保存）</option>`
        : '';
      const opts = efforts.map((lv) => `<option value="${eh(lv)}"${lv === current ? ' selected' : ''}>${eh(lv)}</option>`).join('');
      return `<select class="select select--compact" data-eff aria-label="思考档位">${follow}${extra}${opts}</select>`;
    }
    if (info.supports_toggle || info.toggle) {
      return `<select class="select select--compact" data-eff aria-label="思考开关">${follow}`
        + `<option value="on"${current === 'on' ? ' selected' : ''}>强制开启</option>`
        + `<option value="off"${current === 'off' ? ' selected' : ''}>强制关闭</option></select>`;
    }
    return '<span class="text-xs text-muted">该模型无思考档位</span>';
  }

  // 模型在 models.dev 目录里是否支持思考（决定「思考档位」行是否出现）。
  function thinkCap(info) {
    if (!info || info.ok === false || !info.found) return false;
    const efforts = Array.isArray(info.efforts) ? info.efforts.filter(Boolean) : [];
    return efforts.length > 0 || Boolean(info.supports_toggle || info.toggle);
  }

  // ============ models.dev 目录能力（添加弹框与添加来源共用） ============

  // 每个供应商最近一次成功拉取的时间（fmtTime 显示「刚刚 / N 分钟前拉取」）。
  const probeTimes = {};
  // 能力缓存：capKey(provId, model) -> info 或 null（查询失败也记下，
  // 一个会话内不重复问）。
  const modelCapCache = {};

  function capKey(provId, model) {
    return JSON.stringify([String(provId || ''), String(model || '')]);
  }

  function capPills(provId, model) {
    const info = modelCapCache[capKey(provId, model)];
    if (!info || info.ok === false || !info.found) return '';
    let html = '';
    if (thinkCap(info)) html += '<span class="pill">思考</span>';
    const ctx = fmtTokens(info.context_tokens);
    if (ctx) html += `<span class="pill tabular">${eh(ctx)}</span>`;
    return html;
  }

  function capSub(provId, model) {
    const info = modelCapCache[capKey(provId, model)];
    if (!info || info.ok === false || !info.found) return '';
    return capabilitySummary(info);
  }

  // 行内异步补能力徽标：结果回来时只改这一行的 .name / .sub。
  function paintRowCap(rowEl, provId, model) {
    if (!rowEl || !rowEl.isConnected) return;
    const nameEl = rowEl.querySelector('.name');
    if (nameEl) nameEl.innerHTML = `${eh(model)}${capPills(provId, model)}`;
    const subEl = rowEl.querySelector('.sub');
    if (subEl) subEl.textContent = capSub(provId, model);
  }

  function resolveCap(provId, model, rowEl, onCap) {
    const key = capKey(provId, model);
    if (modelCapCache[key] !== undefined) {
      paintRowCap(rowEl, provId, model);
      return;
    }
    const preset = presetIdForProvider(provId);
    if (!preset || !model) return;
    fetchModelInfo(preset, model).then((info) => {
      modelCapCache[key] = info && info.ok !== false ? info : null;
      paintRowCap(rowEl, provId, model);
      if (typeof onCap === 'function') onCap();
    });
  }

  // ============ 测试（真实发一句「你好」；三个入口共用同一套画法） ============

  function resetTestOut(id) {
    const out = $(id);
    if (!out) return;
    out.hidden = true;
    out.className = 'm-test-out';
    out.innerHTML = '';
  }

  function busyTest(out, text) {
    if (!out) return;
    out.hidden = false;
    out.className = 'm-test-out';
    out.innerHTML = `<div class="gw-test-meta">${eh(text)}</div>`;
  }

  // 测试输出卡（.m-test-out）：meta 行 + 成功给回复 / 失败给原因。
  function paintTest(out, res, ms, provider, keyLabel, model) {
    if (!out) return;
    const ok = Boolean(res && res.valid === true);
    const meta = [
      ok ? '可用' : '失败',
      res && res.status ? `HTTP ${res.status}` : '',
      `${(res && res.latency_ms) || ms}ms`,
      `${provider || ''}${keyLabel ? ` / ${keyLabel}` : ''}`,
      `${model || ''}`,
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
  }

  // 真发一次「你好」：test-key 会把结论落盘（配置版本 +1），所以测完立刻
  // refreshConfigVersion() 并把结论写回本地那把 Key（applyKeyLastTest），
  // 否则紧接着的保存必被 CAS 判为冲突。
  async function testOnce({ provider, keyLabel, model }) {
    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const res = await window.HOST.testKey({
      provider,
      key_label: String(keyLabel || ''),
      model: String(model || '').trim(),
    });
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
    await refreshConfigVersion();
    const provKeys = state.config?.providers?.[provider]?.api_keys || [];
    const verdictKey = provKeys.find((k) => k && (k.label || k.id) === (keyLabel || res?.key_label))
      || (keyLabel ? null : pickBestKeyFor(provider, state.config?.providers?.[provider] || {}));
    if (verdictKey) applyKeyLastTest(verdictKey, res);
    return { res, ms };
  }

  // 带界面状态的测试入口：测试期间禁用「保存」（CAS 竞态），结果卡统一画。
  async function testWithUi({ btn, saveBtnId, outId, provider, keyLabel, model }) {
    const out = $(outId);
    const saveBtn = $(saveBtnId);
    if (saveBtn) saveBtn.disabled = true;
    const old = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '测试中…';
    }
    busyTest(out, `正在用 ${providerNameOf(provider)}${keyLabel ? ` / ${keyLabel}` : ''} 请求 ${model} …`);
    try {
      const { res, ms } = await testOnce({ provider, keyLabel, model });
      if (out && out.isConnected) paintTest(out, res, ms, provider, keyLabel, model);
      return res;
    } catch (err) {
      if (out && out.isConnected) {
        out.hidden = false;
        out.className = 'm-test-out m-test-out--err';
        out.textContent = `测试异常：${scrubUiText(err && err.message ? err.message : String(err))}`;
      }
      return null;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = old;
      }
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function probeUpstream(provId, noteEl) {
    const setNote = (t) => { if (noteEl) noteEl.textContent = t; };
    const p = state.config?.providers?.[provId] || {};
    setNote('正在拉取上游模型…');
    try {
      const res = await window.HOST.probeModels({
        provider: provId,
        base_url: p.base_url || '',
        api_type: normalizeApiType(p.api_type),
      });
      const models = Array.isArray(res?.models) ? res.models : [];
      if (models.length > 0) {
        state.probedModelsByProvider[provId] = models;
        probeTimes[provId] = Date.now();
        setNote('');
        return { ok: true, count: models.length };
      }
      // 拉取失败只显示一句原因，引导「手动填写」。
      const reason = res?.error ? scrubUiText(String(res.error)) : '上游没有返回任何模型';
      setNote(`拉取失败：${reason}。可用「手动填写」直接填模型 ID`);
      return { ok: false, reason };
    } catch (e) {
      const reason = scrubUiText(e?.message || String(e));
      setNote(`拉取失败：${reason}。可用「手动填写」直接填模型 ID`);
      return { ok: false, reason };
    }
  }

  // ============ 来源选择器（「添加模型」弹框与「添加来源」面板共用） ============
  // 状态放在调用方的 st 对象里（字段同名：provId / anyKey / pickedKeys /
  // pickedModels / manualOpen / probingFor）；这里只画、只接线。

  // 只列「启用且有 Key」的供应商（不能在这里新建供应商）；选项文案带可用 Key 数。
  function fillUsableProviderSelect(sel) {
    if (!sel) return;
    const provs = Object.entries(state.config?.providers || {})
      .filter(([, p]) => {
        if (!p || p.enabled === false) return false;
        return (p.api_keys || []).some((k) => k && k.enabled !== false);
      })
      .sort((a, b) => String(a[1]?.name || a[0]).localeCompare(String(b[1]?.name || b[0])));
    sel.innerHTML = ['<option value="">选择供应商</option>']
      .concat(provs.map(([id, p]) => {
        const n = (p.api_keys || []).filter((k) => k && k.enabled !== false).length;
        return `<option value="${eh(id)}">${eh(p.name || id)}（${n} 把 Key 可用）</option>`;
      })).join('');
  }

  // Key 芯片组：第一颗「任一可用」；点具体 Key 取消「任一可用」并显示点选
  // 序号；全取消回到「任一可用」。停用的 Key 不出现；冷却中的标黄（.dot）可选。
  function drawKeyChips(box, st, onChange) {
    if (!box) return;
    box.innerHTML = '';
    const prov = state.config?.providers?.[st.provId] || {};
    const keys = (prov.api_keys || []).filter((k) => k && k.enabled !== false);
    if (!st.provId || keys.length === 0) {
      const span = ce('span');
      span.className = 'text-xs text-muted';
      span.textContent = st.provId ? '该供应商没有启用的 Key' : '请先选择供应商';
      box.appendChild(span);
      return;
    }
    box.appendChild(buildChip({
      label: '任一可用',
      on: st.anyKey,
      title: '不选具体 Key：每个模型生成 1 个来源，网关在该供应商的启用 Key 里自动挑',
      onClick: () => {
        st.anyKey = true;
        st.pickedKeys.length = 0;
        onChange();
      },
    }));
    keys.forEach((k, idx) => {
      const label = String(k.label || k.id || `key-${idx}`);
      const cooling = candCooldownSec(st.provId, label) > 0;
      const ord = st.pickedKeys.indexOf(label);
      const chip = buildChip({
        label: ord >= 0 ? `${ord + 1} · ${label}` : label,
        on: ord >= 0,
        title: cooling ? `${label}：冷却中，仍可选择` : label,
        onClick: (next) => {
          if (next) {
            st.anyKey = false;
            if (ord < 0) st.pickedKeys.push(label);
          } else {
            const i = st.pickedKeys.indexOf(label);
            if (i >= 0) st.pickedKeys.splice(i, 1);
          }
          if (st.pickedKeys.length === 0) st.anyKey = true;
          onChange();
        },
      });
      if (cooling) {
        const dot = ce('span');
        dot.className = 'dot dot--warn';
        dot.setAttribute('aria-hidden', 'true');
        chip.appendChild(dot);
      }
      box.appendChild(chip);
    });
  }

  function modelCb(mo, picked, disabled) {
    const label = ce('label');
    label.className = 'fields';
    const cb = ce('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(picked);
    cb.disabled = Boolean(disabled);
    cb.setAttribute('data-mo', mo);
    cb.setAttribute('aria-label', `选择上游模型 ${mo}`);
    label.appendChild(cb);
    return label;
  }

  // 上游模型多选列表：筛选、复选、能力徽标；已存在的标「已添加」并禁用。
  // 手填的模型（不在拉取结果里）也列出来，保证「已选」看得见。
  function drawModelRows(box, ctx) {
    if (!box) return;
    box.innerHTML = '';
    if (!ctx.provId) {
      box.appendChild(listRow({ title: '请先选择供应商', cls: 'text-muted' }));
      return;
    }
    const cached = state.probedModelsByProvider[ctx.provId] || [];
    const f = String(ctx.filter || '').trim().toLowerCase();
    const hit = (mo) => !f || String(mo).toLowerCase().includes(f);
    const pickedManual = [...ctx.picked].filter((mo) => !cached.includes(mo) && hit(mo));
    const models = cached.filter(hit).concat(pickedManual);
    if (models.length === 0) {
      const hint = cached.length === 0
        ? '还没有拉取到上游模型：点「重新拉取」，或用「手动填写」直接填 ID'
        : `没有匹配「${eh(f)}」的上游模型`;
      box.appendChild(listRow({ title: hint, cls: 'text-muted' }));
      return;
    }
    for (const mo of models) {
      const exists = ctx.existing.has(mo);
      const picked = ctx.picked.has(mo);
      const row = listRow({
        tag: 'button',
        leading: modelCb(mo, picked, exists),
        title: `${eh(mo)}${capPills(ctx.provId, mo)}`,
        sub: eh(capSub(ctx.provId, mo)),
        status: exists ? { dot: 'off', label: '已添加' } : '',
        onOpen: exists ? null : () => ctx.onToggle(mo, !picked),
      });
      row.dataset.mo = mo;
      box.appendChild(row);
      if (!exists) resolveCap(ctx.provId, mo, row, ctx.onCap || null);
    }
  }

  // 「模型」段骨架：筛选 / 重新拉取 / 手动填写 / 列表 / 手填框 / 拉取说明。
  function pickerTpl(prefix) {
    return `
      <div class="dlg-secline">模型</div>
      <div class="col-full">
        <div class="input-row">
          <input class="input" id="${prefix}_filter" placeholder="选择供应商后筛选上游模型" aria-label="筛选上游模型">
          <button class="btn" id="${prefix}_reprobe" type="button">重新拉取</button>
          <button class="btn" id="${prefix}_manual" type="button">手动填写</button>
        </div>
        <div class="list mt-2" id="${prefix}_models"></div>
        <div class="mt-2" id="${prefix}_manual_box" hidden>
          <textarea class="textarea" id="${prefix}_manual_text" placeholder="每行一个上游模型 ID，多个模型用换行分隔"></textarea>
          <div class="fields mt-1">
            <button class="btn" id="${prefix}_manual_ok" type="button">填入所选</button>
            <span class="text-xs text-muted">换行分隔的每个模型都会被勾选</span>
          </div>
        </div>
        <div class="text-xs text-muted mt-1" id="${prefix}_probe_note"></div>
      </div>`;
  }

  // 勾选模型的统一入口（行点击与勾选框 change 都走这里）。
  function togglePickerModel(st, mo, next, hooks) {
    if (next) st.pickedModels.add(mo);
    else st.pickedModels.delete(mo);
    if (hooks.onDirty) hooks.onDirty();
    hooks.draw();
    if (hooks.onPicked) hooks.onPicked();
  }

  // 「模型」段接线：筛选、重新拉取、手动填写、勾选。st.probingFor 记录正在
  // 拉取的供应商，换供应商时旧拉取不打断新状态。
  function wirePicker(prefix, st, hooks) {
    $(`${prefix}_filter`)?.addEventListener('input', () => hooks.draw());
    clk($(`${prefix}_reprobe`), () => hooks.probe());
    clk($(`${prefix}_manual`), () => {
      st.manualOpen = !st.manualOpen;
      if (hooks.onDirty) hooks.onDirty();
      hooks.draw();
      if (st.manualOpen) $(`${prefix}_manual_text`)?.focus();
    });
    clk($(`${prefix}_manual_ok`), () => {
      const lines = String($(`${prefix}_manual_text`)?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return toast('请先填写至少一个模型 ID', 'warn');
      const existing = existingTargets(st.provId);
      let added = 0;
      let skipped = 0;
      for (const m of lines) {
        if (existing.has(m)) { skipped++; continue; }
        st.pickedModels.add(m);
        added++;
      }
      if (hooks.onDirty) hooks.onDirty();
      const ta = $(`${prefix}_manual_text`);
      if (ta) ta.value = '';
      hooks.draw();
      if (hooks.onPicked) hooks.onPicked();
      toast(added ? (skipped ? `已勾选 ${added} 个；${skipped} 个已是现有来源，跳过` : `已勾选 ${added} 个模型`) : '这些模型都已是现有来源', added ? 'ok' : 'warn');
    });
    // 勾选框自己的 change（行点击走 listRow 的 onOpen，两者都进 togglePickerModel）。
    $(`${prefix}_models`)?.addEventListener('change', (e) => {
      const cb = e.target instanceof Element ? e.target.closest('input[type="checkbox"][data-mo]') : null;
      if (!cb || cb.disabled) return;
      const mo = cb.getAttribute('data-mo') || '';
      if (mo) togglePickerModel(st, mo, cb.checked, hooks);
    });
  }

  async function probePicker(st, noteId, draw, opts = {}) {
    const provId = st.provId;
    if (!provId || st.probingFor === provId) return;
    st.probingFor = provId;
    if ('probeError' in st) st.probeError = '';
    draw();
    const r = await probeUpstream(provId, $(noteId));
    if (st.probingFor === provId) st.probingFor = '';
    if ('probeError' in st) st.probeError = r.ok ? '' : (r.reason || '拉取失败');
    if (opts.toast && r.ok) toast(`拉取到 ${r.count} 个上游模型`, 'ok');
    if (st.provId === provId) draw();
  }

  // 「模型」段重绘：列表 + 筛选框占位 + 手填框显隐 +（添加弹框独有）拉取说明。
  function drawPickerModels(prefix, st, hooks, existing) {
    drawModelRows($(`${prefix}_models`), {
      provId: st.provId,
      filter: $(`${prefix}_filter`)?.value || '',
      picked: st.pickedModels,
      existing,
      onCap: hooks.onCap || null,
      onToggle: (mo, next) => togglePickerModel(st, mo, next, hooks),
    });
    const filter = $(`${prefix}_filter`);
    if (filter) {
      const n = (state.probedModelsByProvider[st.provId] || []).length;
      filter.placeholder = st.provId
        ? `筛选该供应商的 ${n || '?'} 个上游模型`
        : '选择供应商后筛选上游模型';
    }
    const manualBox = $(`${prefix}_manual_box`);
    if (manualBox) {
      manualBox.hidden = !st.manualOpen;
      manualBox.classList.toggle('hidden', !st.manualOpen);
    }
    if ('probeError' in st) {
      const note = $(`${prefix}_probe_note`);
      if (note) {
        if (st.probingFor && st.probingFor === st.provId) {
          note.textContent = '正在拉取上游模型…';
        } else if (st.probeError) {
          note.textContent = st.probeError;
        } else {
          const ts = probeTimes[st.provId];
          const n = (state.probedModelsByProvider[st.provId] || []).length;
          note.textContent = ts && n ? `${fmtTime(ts)}拉取 · ${n} 个上游模型` : (st.provId ? '还没拉取过上游模型' : '');
        }
      }
    }
  }

  // 换供应商：已选了模型先确认；确认后清空 Key 与模型并重画（有缓存直接用，
  // 没有就自动拉一次）。
  async function changePickerProv(st, nextId, hooks, noteId) {
    if (st.pickedModels.size > 0) {
      const ok = await confirmDialog({
        title: '更换供应商？',
        message: '已选的 Key 与上游模型会被清空。',
        danger: false,
        confirmText: '更换',
      });
      if (!ok) {
        const sel = $(hooks.provSelId);
        if (sel) sel.value = st.provId;
        return;
      }
    }
    resetPickerState(st);
    st.provId = nextId;
    if (hooks.afterChange) hooks.afterChange();
    if (nextId && !(state.probedModelsByProvider[nextId] || []).length) {
      await probePicker(st, noteId, hooks.draw, { toast: Boolean(optsToastOf(st)) });
    } else {
      hooks.draw();
      if (hooks.afterDraw) hooks.afterDraw();
    }
  }

  function optsToastOf(st) {
    return st === amState;
  }

  function resetPickerState(st) {
    st.provId = '';
    st.anyKey = true;
    st.pickedKeys = [];
    st.pickedModels = new Set();
    st.manualOpen = false;
    st.probingFor = '';
    if ('probeError' in st) st.probeError = '';
  }

  // ============ 模型列表（v2 §7.12.1：一行 = 名称 + 首选来源 + 状态 + 来源数） ============

  function renderModelsList() {
    const container = $('modelsList');
    if (!container) return;
    // 列表即将重建：挂在旧 DOM 上的「⋯」浮层会变成死元素，先关掉。
    closeAllMenus();
    container.innerHTML = '';

    const models = state.config?.agent_models || {};
    const countEl = $('modelsCount');
    if (countEl) countEl.textContent = `${Object.keys(models).length} 个`;

    const q = state.modelQuery || '';
    const orderedKeys = Object.keys(models).sort().filter((mName) => {
      if (!q) return true;
      const m = models[mName] || {};
      const cands = (m.candidates || []).map((c) => `${c.provider} ${c.target_model}`).join(' ');
      return `${mName} ${cands}`.toLowerCase().includes(q);
    });

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
      if (!filtered) {
        const btn = ce('button');
        btn.type = 'button';
        // 页头已有唯一的「添加模型」主按钮；空状态这里用普通按钮（v2 §4.3）。
        btn.className = 'btn mt-3';
        btn.textContent = '添加模型';
        clk(btn, () => openAddModelDialog());
        empty.appendChild(btn);
      }
      container.appendChild(empty);
      return;
    }

    for (const mName of orderedKeys) {
      const m = models[mName];
      const cands = m.candidates || [];
      const first = cands[0];
      // 次要信息 = 首选来源（排第一的候选：供应商 · 上游模型）；多来源时
      // 加「另有 N 个备用」。上游模型为空显示路由名（调度器同序回退）。
      const sub = cands.length === 0
        ? '还没有来源：点开添加'
        : `${eh(providerNameOf(first.provider))} · ${eh(String(first.target_model || '').trim() || mName)}${cands.length > 1 ? `，另有 ${cands.length - 1} 个备用` : ''}`;
      const st = routeStatusOf(m);
      const row = listRow({
        title: `<span>${eh(mName)}</span>`,
        sub,
        status: { dot: st.dot, label: st.word },
        count: `${cands.length} 个来源`,
        onOpen: () => openModelEditDialog(mName),
      });
      container.appendChild(row);
    }
  }

  // 保存 / 删除成功后：列表滚到那一行并短暂高亮（借 .expanded 的悬停底色）。
  function flashModelRow(mName) {
    renderModelsList();
    const container = $('modelsList');
    if (!container) return;
    const target = [...container.querySelectorAll('.row .name')]
      .find((el) => el.textContent === mName);
    const rowEl = target ? target.closest('.row') : null;
    if (!rowEl) return;
    rowEl.scrollIntoView({ block: 'center' });
    rowEl.classList.add('expanded');
    setTimeout(() => rowEl.classList.remove('expanded'), 1600);
  }

  // ============ 添加模型弹框（一个窗口，不分步） ============

  const amState = {
    provId: '',
    anyKey: true,        // true = 任一可用；点具体 Key 后变 false
    pickedKeys: [],      // 点选顺序的 Key 标签
    strategy: 'sticky_failover',  // 主备 = sticky_failover，轮询 = round_robin
    pickedModels: new Set(),
    names: {},           // 上游模型 → 对外模型名草稿（'' = 跟随上游）
    effort: '',          // 思考档位（应用到支持思考的所选模型）
    dirty: false,
    manualOpen: false,
    probingFor: '',
    probeError: '',
  };

  function amPickerHooks() {
    return {
      draw: drawAddModels,
      probe: () => probePicker(amState, 'am_probe_note', drawAddModels, { toast: true }),
      onDirty: () => { amState.dirty = true; },
      onPicked: () => {
        drawAddNames();
        drawEffortRow();
        drawAddSummary();
      },
    };
  }

  function amProvChanged() {
    amState.anyKey = true;
    amState.pickedKeys = [];
    amState.pickedModels = new Set();
    amState.names = {};
    amState.effort = '';
    amState.manualOpen = false;
    amState.probeError = '';
    amState.dirty = true;
    drawAddKeySection();
    drawAddModels();
    drawAddNames();
    drawEffortRow();
    // 有缓存就直接用；没有就自动拉一次。
    if (amState.provId && !(state.probedModelsByProvider[amState.provId] || []).length) {
      probePicker(amState, 'am_probe_note', drawAddModels, { toast: true });
    }
  }

  function onAddProvChange(nextId) {
    return changePickerProv(amState, nextId, {
      provSelId: 'am_prov',
      draw: drawAddModels,
      afterChange: () => amProvChanged(),
      afterDraw: () => amProvChanged(),
    }, 'am_probe_note');
  }

  function drawAddKeySection() {
    drawKeyChips($('am_key_chips'), amState, () => {
      amState.dirty = true;
      drawAddKeySection();
    });
    // 选 2 把以上出现「主备 / 轮询」分段。
    const seg = $('am_strat_seg');
    if (seg) {
      const show = !amState.anyKey && amState.pickedKeys.length >= 2;
      seg.hidden = !show;
      seg.classList.toggle('hidden', !show);
      seg.querySelectorAll('button[data-amstrat]').forEach((b) => {
        b.classList.toggle('active', b.dataset.amstrat === amState.strategy);
      });
    }
    // Key 回退只在指定了具体 Key 时出现（对应 allow_key_fallback）；
    // 权重只在轮询时出现。
    const kfRow = $('am_kf_row');
    if (kfRow) {
      kfRow.hidden = amState.anyKey;
      kfRow.classList.toggle('hidden', amState.anyKey);
    }
    const wLabel = $('am_weight_label');
    if (wLabel) wLabel.hidden = amState.strategy !== 'round_robin';
    const wRow = $('am_weight_row');
    if (wRow) wRow.hidden = amState.strategy !== 'round_robin';
    const help = $('am_key_help');
    if (help) {
      help.textContent = amState.anyKey
        ? '不选具体 Key：每个模型生成 1 个来源，网关在该供应商的启用 Key 里自动挑一把'
        : amState.strategy === 'round_robin'
          ? `按点选顺序生成 ${amState.pickedKeys.length} 个来源；请求轮流分给各把 Key`
          : `按点选顺序生成 ${amState.pickedKeys.length} 个来源；第 1 把冷却或失败时切到下一把`;
    }
    drawAddSummary();
  }

  function drawAddModels() {
    drawPickerModels('am', amState, amPickerHooks(), existingTargets(amState.provId));
  }

  function addNameOf(model) {
    return String(amState.names[model] || '').trim() || String(model || '').trim();
  }

  function updateAddNameHint() {
    const hint = $('am_name_hint');
    if (!hint) return;
    const models = [...amState.pickedModels];
    if (models.length !== 1) return;
    const name = addNameOf(models[0]);
    if (state.config?.agent_models?.[name]) {
      hint.textContent = `${name} 已经是现有模型：这次添加的来源将并作它的备用来源，不另建一条`;
    } else {
      hint.textContent = '';
    }
  }

  function drawAddNames() {
    const box = $('am_name_box');
    if (!box) return;
    const models = [...amState.pickedModels];
    if (models.length === 0) {
      box.innerHTML = '<div class="text-xs text-muted">先在上面的模型列表里勾选至少一个上游模型</div>';
      return;
    }
    if (models.length === 1) {
      const m = models[0];
      box.innerHTML = `<input class="input input--code" id="am_name_one" value="${eh(amState.names[m] || '')}" placeholder="默认与上游一致：${eh(m)}">`
        + '<div class="text-xs text-muted mt-1" id="am_name_hint"></div>';
      const inp = $('am_name_one');
      inp?.addEventListener('input', () => {
        amState.names[m] = inp.value;
        amState.dirty = true;
        updateAddNameHint();
      });
    } else {
      // 多个模型：每模型一行，默认与上游一致。
      box.innerHTML = models.map((m) => `<div class="input-row mt-1"><span class="text-xs text-muted">${eh(m)}</span><input class="input input--code" data-amname="${eh(m)}" value="${eh(amState.names[m] || '')}" placeholder="默认与上游一致" aria-label="${eh(m)} 的对外模型名"></div>`).join('')
        + '<div class="text-xs text-muted mt-1" id="am_name_hint">与已有模型同名时会并作它的备用来源，不另建一条</div>';
      box.querySelectorAll('input[data-amname]').forEach((inp) => {
        inp.addEventListener('input', () => {
          amState.names[inp.getAttribute('data-amname')] = inp.value;
          amState.dirty = true;
        });
      });
    }
    updateAddNameHint();
  }

  // 思考档位：只在目录标记支持思考时出现，默认「跟随客户端」。
  function drawEffortRow() {
    const label = $('am_effort_label');
    const ctrl = $('am_effort_box');
    if (!label || !ctrl) return;
    const ladders = new Set();
    let toggleOnly = false;
    let anyCapable = false;
    for (const m of amState.pickedModels) {
      const info = modelCapCache[capKey(amState.provId, m)];
      if (!thinkCap(info)) continue;
      anyCapable = true;
      const efforts = Array.isArray(info.efforts) ? info.efforts.filter(Boolean) : [];
      if (efforts.length) efforts.forEach((v) => ladders.add(v));
      else toggleOnly = true;
    }
    if (!anyCapable) {
      label.hidden = true;
      ctrl.hidden = true;
      ctrl.innerHTML = '';
      amState.effort = '';
      return;
    }
    label.hidden = false;
    ctrl.hidden = false;
    const prev = amState.effort;
    const opts = ['<option value="">跟随客户端</option>'];
    for (const v of [...ladders]) {
      opts.push(`<option value="${eh(v)}"${v === prev ? ' selected' : ''}>${eh(v)}</option>`);
    }
    if (toggleOnly) {
      opts.push(`<option value="on"${prev === 'on' ? ' selected' : ''}>强制开启</option>`);
      opts.push(`<option value="off"${prev === 'off' ? ' selected' : ''}>强制关闭</option>`);
    }
    ctrl.innerHTML = `<select class="select" id="am_effort" aria-label="思考档位">${opts.join('')}</select>`
      + '<div class="text-xs text-muted mt-1">只应用到支持思考的所选模型；不支持的保持跟随客户端</div>';
    const sel = $('am_effort');
    if (sel) {
      sel.value = prev;
      sel.addEventListener('change', () => {
        amState.effort = String(sel.value || '');
        amState.dirty = true;
      });
    }
  }

  function drawAddSummary() {
    const el = $('am_summary');
    if (!el) return;
    const n = amState.pickedModels.size;
    if (!n) {
      el.textContent = '还没有选择模型';
      return;
    }
    const per = amState.anyKey ? 1 : Math.max(1, amState.pickedKeys.length);
    el.textContent = `已选 ${n} 个模型 · 将生成 ${n * per} 个来源`;
  }

  function buildAddForm() {
    const box = $('am_form');
    if (!box) return;
    box.innerHTML = `
      <div class="dlg-secline">来源</div>
      <label>供应商</label>
      <div><select class="select" id="am_prov" aria-label="选择供应商"></select></div>
      <label>Key</label>
      <div>
        <div class="copy-chips" id="am_key_chips"></div>
        <div class="seg mt-2" id="am_strat_seg" hidden>
          <button class="seg-btn" data-amstrat="sticky_failover" type="button">主备</button>
          <button class="seg-btn" data-amstrat="round_robin" type="button">轮询</button>
        </div>
        <div class="text-xs text-muted mt-1" id="am_key_help"></div>
      </div>
      ${pickerTpl('am')}
      <label>对外模型名</label>
      <div id="am_name_box"></div>
      <label id="am_effort_label" hidden>思考档位</label>
      <div id="am_effort_box" hidden></div>
      <details class="adv-details">
        <summary>高级设置</summary>
        <div class="form-2col adv-body">
          <div class="col-full" id="am_kf_row" hidden><label class="form-label--check"><input type="checkbox" id="am_keyfb"><span>指定的 Key 不可用时，改用同供应商其它启用的 Key</span></label></div>
          ${checkRow('am_noreas', false, '剥离思考 / 推理参数')}
          ${checkRow('am_nonstream', false, '强制非流式（stream=false）')}
          <label>并发上限</label>
          <div class="input-row"><input class="input tabular" id="am_maxc" type="number" min="0" placeholder="不限" aria-label="并发上限"><span class="text-xs text-muted">每个来源同时处理的请求数，0 = 不限</span></div>
          <label id="am_weight_label" hidden>权重</label>
          <div class="input-row" id="am_weight_row" hidden><input class="input tabular" id="am_weight" type="number" min="1" value="1" aria-label="权重"><span class="text-xs text-muted">数值越大分到的请求越多</span></div>
        </div>
      </details>
    `;

    fillUsableProviderSelect($('am_prov'));

    $('am_prov')?.addEventListener('change', (e) => onAddProvChange(String(e.target.value || '')));
    $('am_strat_seg')?.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('button[data-amstrat]') : null;
      if (!b) return;
      amState.strategy = b.dataset.amstrat || 'sticky_failover';
      amState.dirty = true;
      drawAddKeySection();
    });
    wirePicker('am', amState, amPickerHooks());
    // 高级折叠里的输入只标 dirty，保存时统一读值。
    for (const id of ['am_keyfb', 'am_noreas', 'am_nonstream', 'am_maxc', 'am_weight']) {
      $(id)?.addEventListener('change', () => { amState.dirty = true; });
      $(id)?.addEventListener('input', () => { amState.dirty = true; });
    }

    drawAddKeySection();
    drawAddModels();
    drawAddNames();
    drawEffortRow();
    drawAddSummary();
  }

  function openAddModelDialog() {
    resetPickerState(amState);
    amState.strategy = 'sticky_failover';
    amState.names = {};
    amState.effort = '';
    amState.dirty = false;
    resetTestOut('am_test_out');
    buildAddForm();
    openDialog('addModelDialog', { focus: 'am_prov' });
  }

  async function requestCloseAddDialog() {
    if (amState.dirty) {
      const ok = await confirmDialog({
        title: '放弃添加模型？',
        message: '已选的供应商、Key 与上游模型不会被保存。',
        danger: false,
        confirmText: '放弃修改',
      });
      if (!ok) return;
    }
    closeDialog('addModelDialog');
  }

  // 尾部「测试」：用第一个来源（第一个所选模型 × 第一把所选 Key）真实发「你好」。
  async function testAddModel() {
    const btn = $('am_test');
    if (!btn || btn.disabled) return;
    const model = [...amState.pickedModels][0];
    if (!amState.provId || !model) {
      const out = $('am_test_out');
      if (out) {
        out.hidden = false;
        out.className = 'm-test-out m-test-out--err';
        out.textContent = '先选好供应商并勾选一个上游模型，再测试。';
      }
      return;
    }
    const keyLabel = amState.anyKey ? '' : String(amState.pickedKeys[0] || '');
    await testWithUi({ btn, saveBtnId: 'btnSaveAddModel', outId: 'am_test_out', provider: amState.provId, keyLabel, model });
  }

  // 保存：每个所选模型生成一条路由（多 Key 时按点选顺序一 Key 一来源）；
  // 与现有模型同名 → 并作它的备用来源（同名合并）。逐条 persistConfig，
  // 每条带上自己的 pendingEdit，冲突重试才不会丢其它新路由。
  async function saveAddModel() {
    const models = [...amState.pickedModels];
    if (!amState.provId) return toast('请选择供应商', 'warn');
    if (!state.config?.providers?.[amState.provId]) return toast('供应商不存在，请先在供应商页创建', 'warn');
    if (models.length === 0) return toast('请勾选或手动填写至少一个上游模型', 'warn');

    const keyLabels = amState.anyKey ? [''] : [...amState.pickedKeys];
    const routeFlags = {
      enabled: true,
      routing_strategy: keyLabels.length >= 2 ? amState.strategy : 'sticky_failover',
      active_key: '',
      no_reasoning: Boolean($('am_noreas')?.checked),
      force_non_stream: Boolean($('am_nonstream')?.checked),
      allow_key_fallback: !amState.anyKey && Boolean($('am_keyfb')?.checked),
    };
    const maxConcurrency = Math.max(0, Number($('am_maxc')?.value) || 0);
    const weight = amState.strategy === 'round_robin' ? Math.max(1, Number($('am_weight')?.value) || 1) : 1;

    state.config = state.config || { providers: {}, agent_models: {} };
    state.config.agent_models = state.config.agent_models || {};

    const savedNames = [];
    for (const model of models) {
      const routeName = addNameOf(model);
      if (!routeName) return toast('对外模型名不能为空', 'warn');
      const mk = (keyLabel) => {
        const c = {
          provider: amState.provId,
          target_model: model,
          key_label: keyLabel || '',
          enabled: true,
          weight,
          max_concurrency: maxConcurrency,
        };
        // 思考档位只写给目录标记支持的模型。
        const info = modelCapCache[capKey(amState.provId, model)];
        if (amState.effort && thinkCap(info)) {
          const efforts = Array.isArray(info.efforts) ? info.efforts.filter(Boolean) : [];
          if (efforts.length ? efforts.includes(amState.effort) : (amState.effort === 'on' || amState.effort === 'off')) {
            c.reasoning_effort = amState.effort;
          }
        }
        return c;
      };
      const fresh = keyLabels.map(mk);

      const existingRoute = state.config.agent_models[routeName];
      if (existingRoute) {
        // 同名合并：新来源并作它的备用来源；路由自身的分流策略保持原样。
        existingRoute.candidates = existingRoute.candidates || [];
        for (const c of fresh) {
          if (!existingRoute.candidates.some((g) => candKeyOf(g, routeName) === candKeyOf(c, routeName))) {
            existingRoute.candidates.push(c);
          }
        }
        savedNames.push(routeName);
        continue;
      }

      state.config.agent_models[routeName] = {
        origin: 'local',
        ...routeFlags,
        candidates: fresh,
      };
      // 同名旧 KB 通道一起删（不存在时是空操作）。
      if (state.config.kb_models) delete state.config.kb_models[routeName];
      savedNames.push(routeName);
    }

    if (savedNames.length === 0) return;
    let failed = false;
    for (const name of savedNames) {
      const route = state.config.agent_models[name];
      const ok = await persistConfig(`已添加模型 ${name}`, { scope: 'agent_models', key: name, value: route });
      if (!ok) { failed = true; break; }
    }
    if (failed) {
      // 没存上：保留弹框让操作者重试（保存每次都从弹框状态重建路由）。
      await loadData();
      return;
    }
    amState.dirty = false;
    closeDialog('addModelDialog');
    flashModelRow(savedNames[0]);
  }

  // ============ 编辑模型弹框 ============

  let edDlg = { orig: '', draft: null, snapshot: '' };
  let edDragIdx = -1;

  // 「添加来源」内嵌面板的会话状态（复用添加模型的来源与模型控件）。
  const edAdd = {
    provId: '',
    anyKey: true,
    pickedKeys: [],
    pickedModels: new Set(),
    manualOpen: false,
    probingFor: '',
  };

  function edPickerHooks() {
    return {
      draw: drawEdAddModels,
      probe: () => probePicker(edAdd, 'me_ac_note', drawEdAddModels),
      onDirty: () => {},
      onPicked: () => {},
    };
  }

  function edUpstreamOf(c) {
    return String(c.target_model || '').trim() || String(edDlg.orig || '');
  }

  function isEdDirty() {
    if (!edDlg.draft) return false;
    const nameVal = String($('ed_m_name')?.value ?? '').trim();
    return JSON.stringify({ name: nameVal, draft: edDlg.draft }) !== edDlg.snapshot;
  }

  async function requestCloseEditDialog() {
    if (isEdDirty()) {
      const ok = await confirmDialog({
        title: '放弃修改？',
        message: `${edDlg.orig} 的修改还没有保存，放弃后这些改动会丢失。`,
        danger: false,
        confirmText: '放弃修改',
      });
      if (!ok) return;
    }
    closeDialog('modelEditDialog');
  }

  function drawEdHeader() {
    const t = $('me_title');
    if (t) t.textContent = edDlg.orig;
    const st = routeStatusOf(edDlg.draft);
    const sub = $('me_sub');
    if (sub) sub.textContent = `${st.word} · ${edDlg.draft.candidates.length} 个来源`;
    // 分流策略只在 ≥2 个来源时有意义（一个来源没有「分给谁」可选）。
    const showStrat = edDlg.draft.candidates.length >= 2;
    const l = $('ed_strat_label');
    const c = $('ed_strat_ctrl');
    if (l) {
      l.hidden = !showStrat;
      l.classList.toggle('hidden', !showStrat);
    }
    if (c) {
      c.hidden = !showStrat;
      c.classList.toggle('hidden', !showStrat);
    }
  }

  function drawEdCands() {
    const body = $('me_cand_body');
    if (!body) return;
    const cands = edDlg.draft.candidates;
    if (cands.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="text-muted">还没有来源：点「添加来源」挑一个供应商与上游模型</td></tr>';
      return;
    }
    body.innerHTML = cands.map((c, i) => `<tr data-i="${i}" draggable="true">
        <td class="text-muted" title="按住 ⋮⋮ 拖动调整顺序"><span aria-hidden="true">⋮⋮</span> ${i + 1}</td>
        <td>${eh(providerNameOf(c.provider))}</td>
        <td><span class="input--code">${eh(edUpstreamOf(c))}</span></td>
        <td><select class="select select--compact" data-key aria-label="这个来源用哪把 Key">${keyOptsHtml(c)}</select></td>
        <td id="me_cand_st_${i}">${candStatusHtml(c)}</td>
        <td><span class="m-cand-eff" id="me_cand_eff_${i}"></span></td>
        <td><div class="fields m-cand-ops"><button class="btn btn--sm btn--ghost" data-a="t" type="button" title="用这个来源真实发一句「你好」">测试</button></div></td>
      </tr>`).join('');
    cands.forEach((c, i) => {
      const tr = body.querySelector(`tr[data-i="${i}"]`);
      const opsSlot = tr ? (tr.querySelector('.m-cand-ops') || tr.querySelector('td:last-child')) : null;
      if (opsSlot) {
        opsSlot.appendChild(buildMenu([
          { label: '上移', title: i === 0 ? '已经在最前' : '', onClick: () => moveEdCand(i, -1) },
          { label: '下移', title: i === cands.length - 1 ? '已经在最后' : '', onClick: () => moveEdCand(i, 1) },
          { label: '移除来源', danger: true, onClick: () => removeEdCand(i) },
        ], { label: `来源 ${i + 1} 的更多操作` }));
      }
      fillEdCandEffort(i, c);
    });
  }

  function moveEdCand(i, dir) {
    const cands = edDlg.draft.candidates;
    const j = i + dir;
    if (j < 0 || j >= cands.length) return;
    [cands[i], cands[j]] = [cands[j], cands[i]];
    drawEdCands();
  }

  function removeEdCand(i) {
    edDlg.draft.candidates.splice(i, 1);
    drawEdCands();
    drawEdAdv();
    drawEdHeader();
  }

  // 拖动把手排序：dragstart 记下起点行，drop 落到目标行上。
  function wireEdCandBody(body) {
    body.addEventListener('dragstart', (e) => {
      const tr = e.target instanceof Element ? e.target.closest('tr[data-i]') : null;
      edDragIdx = tr ? Number(tr.dataset.i) : -1;
      if (tr && e.dataTransfer) e.dataTransfer.setData('text/plain', String(edDragIdx));
    });
    body.addEventListener('dragover', (e) => {
      if (edDragIdx >= 0) e.preventDefault();
    });
    body.addEventListener('drop', (e) => {
      if (edDragIdx < 0) return;
      e.preventDefault();
      const tr = e.target instanceof Element ? e.target.closest('tr[data-i]') : null;
      const to = tr ? Number(tr.dataset.i) : -1;
      const cands = edDlg.draft.candidates;
      if (Number.isFinite(to) && to >= 0 && to < cands.length && to !== edDragIdx) {
        const [moved] = cands.splice(edDragIdx, 1);
        cands.splice(to, 0, moved);
        drawEdCands();
        drawEdAdv();
      }
      edDragIdx = -1;
    });
    body.addEventListener('dragend', () => { edDragIdx = -1; });
    // 行内按钮：测试（⋯ 菜单里的上移 / 下移 / 移除由 buildMenu 自带接线）。
    body.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button[data-a="t"]') : null;
      if (!btn) return;
      testEdCandidate(Number(btn.closest('[data-i]')?.dataset.i));
    });
    // Key 下拉与思考档位直接写进草稿。
    body.addEventListener('change', (e) => {
      const el = e.target instanceof Element ? e.target.closest('select[data-eff], select[data-key]') : null;
      if (!el) return;
      const c = edDlg.draft.candidates[Number(el.closest('[data-i]')?.dataset.i)];
      if (!c) return;
      if (el.dataset.key !== undefined) {
        const v = String(el.value || '');
        if (v) c.key_label = v;
        else delete c.key_label;
        drawEdCands();
        drawEdHeader();
        return;
      }
      const v = String(el.value || '');
      if (v) c.reasoning_effort = v;
      else delete c.reasoning_effort;
    });
  }

  function fillEdCandEffort(i, c) {
    const box = $(`me_cand_eff_${i}`);
    if (!box || !c) return;
    const preset = presetIdForProvider(c.provider);
    const model = String(c.target_model || '').trim();
    if (!preset || !model) {
      box.innerHTML = '';
      return;
    }
    fetchModelInfo(preset, model).then((info) => {
      // 候选表可能已重排：过期的查询结果不能写进别人的格子。
      if (!box.isConnected || edDlg.draft.candidates[i] !== c) return;
      box.innerHTML = effortControlHtml(String(c.reasoning_effort || ''), info);
    });
  }

  function drawEdAdv() {
    const box = $('me_ca');
    if (!box) return;
    const cands = edDlg.draft.candidates;
    if (cands.length === 0) {
      box.innerHTML = '';
      return;
    }
    const showWeight = (edDlg.draft.routing_strategy || 'sticky_failover') === 'weighted';
    box.innerHTML = `<table class="data-table"><thead><tr><th>来源</th>${showWeight ? '<th>权重</th>' : ''}<th>并发上限</th></tr></thead><tbody>`
      + cands.map((c, i) => `<tr><td>${eh(providerNameOf(c.provider))} · <span class="input--code">${eh(edUpstreamOf(c))}</span>${c.key_label ? ` · ${eh(c.key_label)}` : ''}</td>`
        + `${showWeight ? `<td><input class="input input--compact tabular" data-w="${i}" type="number" min="1" value="${Number(c.weight) || 1}" aria-label="权重"></td>` : ''}`
        + `<td><input class="input input--compact tabular" data-x="${i}" type="number" min="0" value="${Number(c.max_concurrency) || 0}" aria-label="并发上限（0 = 不限）"></td></tr>`).join('')
      + '</tbody></table>';
  }

  // 单个来源测试（来源行上的「测试」）：用候选自己的 Key 绑定真实发「你好」。
  async function testEdCandidate(i) {
    const c = edDlg.draft.candidates[i];
    if (!c || !c.provider) return;
    const testBtn = $('me_cand_body')?.querySelector(`tr[data-i="${i}"] button[data-a="t"]`);
    const res = await testWithUi({
      btn: testBtn,
      saveBtnId: 'btnSaveEditModel',
      outId: 'me_test_out',
      provider: c.provider,
      keyLabel: String(c.key_label || ''),
      model: edUpstreamOf(c),
    });
    if (res) {
      const cell = $(`me_cand_st_${i}`);
      if (cell && edDlg.draft.candidates[i] === c) cell.innerHTML = candStatusHtml(c);
      drawEdHeader();
    }
  }

  // 测试全部候选：逐个串行（与「一键测全部 Key」一致），每把测完立刻刷新
  // 状态列，最后给 N/M 可用汇总。测试期间禁用保存（CAS 竞态）。
  async function testAllEdCandidates() {
    const btn = $('me_test_all');
    const out = $('me_test_out');
    const saveBtn = $('btnSaveEditModel');
    if (!btn || btn.disabled) return;
    const cands = edDlg.draft.candidates.filter((c) => c && c.provider);
    if (cands.length === 0) {
      if (out) {
        out.hidden = false;
        out.className = 'm-test-out m-test-out--err';
        out.textContent = '先在来源列表里加一个来源，再测试。';
      }
      return;
    }
    const label = btn.textContent;
    btn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;
    let okCount = 0;
    try {
      for (let i = 0; i < edDlg.draft.candidates.length; i++) {
        const c = edDlg.draft.candidates[i];
        if (!c || !c.provider) continue;
        btn.textContent = `测试中 ${i + 1}/${cands.length}`;
        busyTest(out, `[${i + 1}/${cands.length}] 正在测试 ${providerNameOf(c.provider)} / ${edUpstreamOf(c)} …`);
        try {
          const { res } = await testOnce({ provider: c.provider, keyLabel: String(c.key_label || ''), model: edUpstreamOf(c) });
          if (res && res.valid === true) okCount++;
        } catch (err) {
          toast(`来源 ${c.provider} 测试异常: ${scrubUiText(err?.message || String(err))}`, 'err');
        }
        const cell = $(`me_cand_st_${i}`);
        if (cell && edDlg.draft.candidates[i] === c) cell.innerHTML = candStatusHtml(c);
      }
      if (out && out.isConnected) {
        out.hidden = false;
        out.className = `m-test-out${okCount === cands.length ? ' m-test-out--ok' : ' m-test-out--err'}`;
        out.innerHTML = `<div class="gw-test-meta">全部来源测试完成：${okCount}/${cands.length} 可用</div>`;
      }
      drawEdHeader();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function buildEditForm() {
    const box = $('me_form');
    if (!box) return;
    const draft = edDlg.draft;
    const stratVal = draft.routing_strategy || 'sticky_failover';
    box.innerHTML = `
      <label>对外模型名</label>
      <div><input class="input input--code" id="ed_m_name" value="${eh(edDlg.orig)}" placeholder="留空则用第一个来源的上游模型 ID"></div>
      <label id="ed_strat_label" hidden>分流</label>
      <div id="ed_strat_ctrl" hidden>
        <select class="select" id="ed_m_strat" aria-label="分流策略">${['sticky_failover', 'round_robin', ...ADVANCED_STRATEGIES].map((k) => `<option value="${eh(k)}"${k === stratVal ? ' selected' : ''}>${eh(STRATEGY_LABELS[k] || k)}</option>`).join('')}</select>
        <div class="text-xs text-muted mt-1" id="ed_m_strat_desc">${eh(STRATEGY_HINTS[stratVal] || '')}</div>
      </div>
      <div class="dlg-secline">来源 · 按顺序尝试</div>
      <div class="col-full">
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>顺序</th><th>供应商</th><th>上游模型</th><th>Key</th><th>状态</th><th>思考档位</th><th></th></tr></thead>
          <tbody id="me_cand_body"></tbody>
        </table></div>
        <div class="fields mt-2">
          <button class="btn" id="me_add_src" type="button">添加来源</button>
          <button class="btn" id="me_test_all" type="button" title="逐个真实测试来源列表里的每一个来源，并刷新状态列">测试全部</button>
        </div>
        <div class="mt-2" id="me_add_box" hidden></div>
      </div>
      <details class="adv-details">
        <summary>高级设置</summary>
        <div class="form-2col adv-body">
          <label>钉死到某把 Key</label>
          <div><input class="input input--code" id="ed_m_act" value="${eh(draft.active_key || '')}" placeholder="供应商:Key标签（留空 = 按策略选）"></div>
          ${checkRow('ed_m_keyfb', draft.allow_key_fallback, '指定的 Key 不可用时，改用同供应商其它启用的 Key')}
          ${checkRow('ed_m_noreas', draft.no_reasoning, '剥离思考 / 推理参数')}
          ${checkRow('ed_m_nonstream', draft.force_non_stream, '强制非流式（stream=false）')}
          <div class="col-full" id="me_ca"></div>
          <div class="col-full text-xs text-muted">并发上限 0 = 不限；权重越大分到的请求越多（仅按权重比例分流时生效）</div>
        </div>
      </details>
    `;
    wireEdCandBody($('me_cand_body'));
    $('ed_m_strat')?.addEventListener('change', (e) => {
      edDlg.draft.routing_strategy = String(e.target.value || 'sticky_failover');
      const desc = $('ed_m_strat_desc');
      if (desc) desc.textContent = STRATEGY_HINTS[edDlg.draft.routing_strategy] || '';
      drawEdAdv();
    });
    clk($('me_add_src'), () => openEdAddSourcePanel());
    clk($('me_test_all'), () => testAllEdCandidates());
    $('me_ca')?.addEventListener('change', (e) => {
      const el = e.target;
      const c = edDlg.draft.candidates[Number(el.dataset.w ?? el.dataset.x)];
      if (!c) return;
      if (el.dataset.w !== undefined) c.weight = Math.max(1, Number(el.value) || 1);
      else c.max_concurrency = Math.max(0, Number(el.value) || 0);
    });
  }

  function openModelEditDialog(mName) {
    const m = state.config?.agent_models?.[mName];
    if (!m) return;
    // 草稿是深拷贝：取消 / 放弃不碰 state.config，保存时才整体落回去。
    const clone = JSON.parse(JSON.stringify(m));
    clone.candidates = Array.isArray(clone.candidates) ? clone.candidates : [];
    edDlg = { orig: mName, draft: clone, snapshot: '' };
    resetTestOut('me_test_out');
    buildEditForm();
    edDlg.snapshot = JSON.stringify({ name: mName, draft: edDlg.draft });
    drawEdHeader();
    drawEdCands();
    drawEdAdv();
    openDialog('modelEditDialog', { focus: 'ed_m_name' });
  }

  // ----「添加来源」内嵌面板（复用添加模型的来源与模型控件）----

  function drawEdAddKeys() {
    drawKeyChips($('me_ac_keys'), edAdd, () => drawEdAddKeys());
    const help = $('me_ac_key_help');
    if (help) {
      help.textContent = edAdd.anyKey
        ? '每个勾选的模型生成 1 个来源（任一可用 Key）；顺序之后可用拖动把手调整'
        : `每个勾选的模型 × ${edAdd.pickedKeys.length} 把 Key 各生成一个来源；分流方式用上方的「分流」`;
    }
  }

  function drawEdAddModels() {
    drawPickerModels('me_ac', edAdd, edPickerHooks(), existingTargets(edAdd.provId));
  }

  function onEdAddProvChange(nextId) {
    return changePickerProv(edAdd, nextId, {
      provSelId: 'me_ac_prov',
      draw: drawEdAddModels,
    }, 'me_ac_note');
  }

  function buildEdAddSourcePanel() {
    const boxEl = $('me_add_box');
    if (!boxEl) return;
    boxEl.innerHTML = `
      <div class="card card-pad">
        <div class="form-2col">
          <div class="dlg-secline">来源</div>
          <label>供应商</label>
          <div><select class="select" id="me_ac_prov" aria-label="选择供应商"></select></div>
          <label>Key</label>
          <div>
            <div class="copy-chips" id="me_ac_keys"></div>
            <div class="text-xs text-muted mt-1" id="me_ac_key_help"></div>
          </div>
          ${pickerTpl('me_ac')}
        </div>
        <div class="fields mt-3">
          <button class="btn" id="me_ac_cancel" type="button">取消</button>
          <button class="btn" id="me_ac_ok" type="button">添加来源</button>
        </div>
      </div>
    `;
    fillUsableProviderSelect($('me_ac_prov'));
    $('me_ac_prov')?.addEventListener('change', (e) => onEdAddProvChange(String(e.target.value || '')));
    wirePicker('me_ac', edAdd, edPickerHooks());
    clk($('me_ac_cancel'), closeEdAddSourcePanel);
    clk($('me_ac_ok'), confirmEdAddSource);
    drawEdAddKeys();
    drawEdAddModels();
    if (edAdd.provId && !(state.probedModelsByProvider[edAdd.provId] || []).length) {
      probePicker(edAdd, 'me_ac_note', drawEdAddModels);
    }
  }

  function openEdAddSourcePanel() {
    resetPickerState(edAdd);
    const boxEl = $('me_add_box');
    if (boxEl) {
      boxEl.hidden = false;
      boxEl.classList.remove('hidden');
    }
    buildEdAddSourcePanel();
  }

  function closeEdAddSourcePanel() {
    const boxEl = $('me_add_box');
    if (boxEl) {
      boxEl.hidden = true;
      boxEl.classList.add('hidden');
      boxEl.innerHTML = '';
    }
  }

  function confirmEdAddSource() {
    if (!edAdd.provId) return toast('请选择供应商', 'warn');
    if (!state.config?.providers?.[edAdd.provId]) return toast('供应商不存在，请先在供应商页创建', 'warn');
    const models = [...edAdd.pickedModels];
    if (models.length === 0) return toast('请勾选或手动填写上游模型', 'warn');
    const mk = (m, kl) => ({
      provider: edAdd.provId,
      target_model: m,
      key_label: kl || '',
      enabled: true,
      weight: 1,
      max_concurrency: 0,
    });
    const fresh = [];
    for (const m of models) {
      const list = edAdd.anyKey ? [mk(m, '')] : edAdd.pickedKeys.map((kl) => mk(m, kl));
      for (const c of list) {
        if (!edDlg.draft.candidates.some((g) => candKeyOf(g, edDlg.orig) === candKeyOf(c, edDlg.orig))) {
          fresh.push(c);
        }
      }
    }
    if (fresh.length === 0) return toast('这些来源已经存在', 'warn');
    edDlg.draft.candidates.push(...fresh);
    closeEdAddSourcePanel();
    drawEdCands();
    drawEdAdv();
    drawEdHeader();
  }

  // ---- 编辑弹框的保存 / 删除 ----

  async function saveEditModel() {
    const draft = edDlg.draft;
    const orig = edDlg.orig;
    if (!draft) return;
    const typedName = String($('ed_m_name')?.value ?? '').trim();
    const fallbackName = String(draft.candidates[0]?.target_model || '').trim();
    const finalName = typedName || fallbackName;
    if (!finalName) return toast('请填写对外模型名，或先添加一个来源', 'warn');
    if (draft.candidates.length === 0) return toast('请至少添加一个来源', 'warn');

    state.config = state.config || { providers: {}, agent_models: {} };
    state.config.agent_models = state.config.agent_models || {};

    draft.enabled = draft.enabled !== false;
    draft.routing_strategy = draft.routing_strategy || String($('ed_m_strat')?.value || 'sticky_failover');
    draft.active_key = String($('ed_m_act')?.value || '').trim();
    draft.no_reasoning = Boolean($('ed_m_noreas')?.checked);
    draft.force_non_stream = Boolean($('ed_m_nonstream')?.checked);
    draft.allow_key_fallback = Boolean($('ed_m_keyfb')?.checked);
    normCands(draft.candidates);

    const renameToExisting = finalName !== orig && Boolean(state.config.agent_models[finalName]);
    if (renameToExisting) {
      // 同名合并：把这一条的来源并进已有那条（去重），老键删除。
      const group = state.config.agent_models[finalName];
      group.candidates = group.candidates || [];
      const added = draft.candidates.filter((c) => !group.candidates.some((g) => candKeyOf(g, finalName) === candKeyOf(c, finalName)));
      if (added.length === 0) {
        return toast(`${finalName} 已包含这些来源，没有新增`, 'warn');
      }
      for (const c of added) group.candidates.push(c);
      if (orig !== finalName) {
        delete state.config.agent_models[orig];
        if (state.config.kb_models) delete state.config.kb_models[orig];
      }
      const ok = await persistConfig(`已并入 ${finalName}（现有 ${group.candidates.length} 个来源）`, {
        scope: 'agent_models',
        key: finalName,
        value: group,
        removeKey: orig !== finalName ? orig : null,
      });
      if (ok) {
        closeDialog('modelEditDialog');
        flashModelRow(finalName);
      }
      return;
    }

    if (finalName !== orig) {
      // 上游模型为空的来源，调度器拿路由名当上游模型；改名只改「客户端叫它
      // 什么」，先把旧名字钉进这些来源。
      for (const c of draft.candidates) {
        if (!String(c.target_model || '').trim()) c.target_model = orig;
      }
      delete state.config.agent_models[orig];
    }
    state.config.agent_models[finalName] = draft;
    if (state.config.kb_models) {
      delete state.config.kb_models[orig];
      delete state.config.kb_models[finalName];
    }
    const ok = await persistConfig('模型配置保存成功', {
      scope: 'agent_models',
      key: finalName,
      value: draft,
      removeKey: finalName !== orig ? orig : null,
    });
    if (ok) {
      closeDialog('modelEditDialog');
      flashModelRow(finalName);
    } else {
      // 没存上（冲突等）：回读服务端配置，弹框留着让操作者重试。
      await loadData();
    }
  }

  async function deleteEditModel() {
    const orig = edDlg.orig;
    if (!orig) return;
    const ok = await confirmDialog({
      title: '删除模型',
      message: `确定删除模型 ${orig} 吗？它的所有来源都会一起删除。`,
      confirmText: '删除',
    });
    if (!ok) return;
    delete state.config.agent_models[orig];
    // 同名旧 KB 通道必须一起走：留着它会在下一次配置往返时复活幽灵路由。
    if (state.config.kb_models) delete state.config.kb_models[orig];
    const saved = await persistConfig('模型已删除');
    if (saved) {
      closeDialog('modelEditDialog');
      renderModelsList();
    } else {
      // 没删成 → 回读服务端配置（路由还在），弹框留在原地。
      await loadData();
    }
  }

  // ============ 页面接线 ============

  function setupModelsPage() {
    // 有副作用的弹框统一注册关闭动作：Esc / 遮罩 / ✕ 都走同一入口，
    // 有改动先确认。
    registerDialog('addModelDialog', () => requestCloseAddDialog());
    registerDialog('modelEditDialog', () => requestCloseEditDialog());
    clk($('btnCloseAddModel'), () => requestCloseAddDialog());
    clk($('btnCancelAddModel'), () => requestCloseAddDialog());
    clk($('btnSaveAddModel'), () => saveAddModel());
    clk($('am_test'), () => testAddModel());
    clk($('btnCloseEditModel'), () => requestCloseEditDialog());
    clk($('btnCancelEditModel'), () => requestCloseEditDialog());
    clk($('btnSaveEditModel'), () => saveEditModel());
    clk($('btnDelModel'), () => deleteEditModel());

    // 旧的拆包遗留：providers.js 的 setupCreationForms() 还给 #btnAddModel
    // 挂着列表内联 create 编辑器的接线。添加模型已经迁进弹框，用捕获阶段
    // 监听把点击接过来，旧的 target 阶段监听不再触发。
    document.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('#btnAddModel') : null;
      if (!btn) return;
      ev.stopPropagation();
      state.creatingModel = false;
      state.activeEditorKey = null;
      openAddModelDialog();
    }, true);

    // Esc 关弹框（有改动先确认）。统一确认框开着时不动，让 overview 的
    // 全局 Esc 处理它。np-panel 等内层浮层自带 stopPropagation。
    // 本监听先于 overview 的全局 Esc 注册执行：确认框必须在同一个事件
    // 处理完之后再开（setTimeout 0），否则它刚打开就被全局处理器按「取消」
    // settle 掉，Esc 永远关不掉有改动的弹框。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const confirmDlg = $('confirmDialog');
      if (confirmDlg && !confirmDlg.hidden) return;
      const edDlgEl = $('modelEditDialog');
      const addDlgEl = $('addModelDialog');
      if (edDlgEl && !edDlgEl.hidden) {
        setTimeout(() => requestCloseEditDialog(), 0);
        return;
      }
      if (addDlgEl && !addDlgEl.hidden) setTimeout(() => requestCloseAddDialog(), 0);
    });
  }

  window.addEventListener('DOMContentLoaded', setupModelsPage);

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