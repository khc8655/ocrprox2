// access.js — 接入信息页（#viewAccess）：网关地址与密钥、复制芯片、模拟请求、可用模型卡片，及模型目录信息助手
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
    // 复制项是只读输入框（效果图：普通输入框 + 复制按钮），值写进 .value。
    const baseInput = $('chipBaseValue');
    if (baseInput) baseInput.value = v.base;
    const epInput = $('chipEndpointValue');
    if (epInput) epInput.value = v.endpoint;
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
      // 空状态 = 一句话 + 一个主按钮（v2 §7.9）：去模型页添加。
      box.innerHTML = '';
      const goBtn = ce('button');
      goBtn.type = 'button';
      goBtn.className = 'btn btn--primary';
      goBtn.textContent = '去模型页添加';
      clk(goBtn, () => switchTab('models'));
      box.appendChild(listRow({
        title: '暂无可用模型',
        sub: '添加并启用模型后，这里会列出 /v1/models 实际返回的全部模型 ID',
        trailing: goBtn,
      }));
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
      // 空状态：一行说明（没有可跳转的动作，不给主按钮）。
      box.innerHTML = '';
      box.appendChild(listRow({ title: '接口清单暂不可用', cls: 'text-muted' }));
      return;
    }
    // 复制项 = 只读输入框 + 复制按钮（与「客户端接入」同一行式样）。
    box.innerHTML = eps.map((p) => settingRow(p, '',
      `<div class="input-row"><input class="input input--code" readonly value="${eh(p)}"><button class="btn" type="button" data-copy="endpoint-path" data-path="${eh(p)}" title="复制 ${eh(p)}">复制</button></div>`
    )).join('');
  }

  function renderAccessView() {
    const cfg = state.config || {};
    const settings = cfg.settings || {};
    const clientKey = settings.client_key || settings.proxy_api_key || '';
    paintGatewayClientValues();
    // 复制项是只读输入框：密钥写 .value，没配就不写值（placeholder 说明缺什么）。
    const keyInput = $('chipKeyValue');
    if (keyInput) keyInput.value = clientKey;
    paintAccessKeyState(clientKey);
    const keyBtn = $('gwCopyChips')?.querySelector('[data-copy="key"]');
    if (keyBtn) keyBtn.disabled = !clientKey;
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
      // 复制按钮（基址 / 密钥 / 请求地址 / 接口路径）与模型卡片都用 data-copy 标记，
      // 委托在各自的静态容器上；值在点击时现读，改完密钥立刻复制到的是新值。
      ['gwCopyChips', '[data-copy]', (k) => (k === 'base' ? '基址' : k === 'key' ? '客户端密钥' : '请求地址')],
      ['gwEndpointChips', '[data-copy]', (k) => (k === 'endpoint-path' ? '接口路径' : '')],
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
