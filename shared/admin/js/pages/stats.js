// stats.js — 统计页（Hub，#statsView：指标带 + 模型使用分布 / 节点分布）与
// Full 概览复用的最近请求表、失败分析与相关时间格式化助手
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
      // 空状态走 W1 的 listRow()（静态行）。
      container.appendChild(listRow({ title: '暂无请求记录', cls: 'text-muted' }));
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
      // 空状态走 W1 的 listRow()（静态行）。
      container.appendChild(listRow({ title: '当前窗口内没有失败记录', cls: 'text-muted' }));
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

  // ================================================================
  // 统计页（Hub，#statsView）：原节点页折叠的 #hubOverviewBox 展开为独立页签。
  // 顶部一条指标带（在线节点 / 节点累计调用与成功率 / 下发规模 / 配置同步）+
  // 「模型使用分布」「节点分布」两张表；数据只来自节点上报（node.usage），
  // 聚合口径与原 renderHubOverview 一致（15 分钟在线窗口、model_stats 优先、
  // models 计数回退）。原函数随 #hubKpiGrid / #hubModelUsageBody 一并退役，
  // 数据源不变；页头注明更新时间。
  // ================================================================

  let statsUpdatedAt = 0;

  // Token 量的紧凑展示（1.2M / 340K）。
  function fmtCompactTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return `${String(Math.round(v / 100000) / 10).replace(/\.0$/, '')}M`;
    if (v >= 1000) return `${Math.round(v / 1000)}K`;
    return String(v);
  }

  function fmtPct(x) {
    return `${Math.round(x * 10) / 10}%`;
  }

  // 占比条：纯 SVG（尺寸用 SVG 属性，颜色走既有 chart-rect 类，无内联样式）。
  function statsShareBarHtml(pct) {
    const w = Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
    const fillW = pct > 0 ? Math.max(1.5, w) : 0;
    return `<svg viewBox="0 0 100 8" preserveAspectRatio="none" width="100%" height="8" role="img" aria-label="占比 ${fmtPct(pct)}"><rect x="0" y="1" width="100" height="6" rx="3" class="chart-rect--out"></rect><rect x="0" y="1" width="${fillW}" height="6" rx="3" class="chart-rect--in"></rect></svg>`;
  }

  // 聚合：口径与原 renderHubOverview 相同，另加每节点的调用合计与最常用模型。
  function computeHubStats() {
    const cfg = state.config || {};
    const providers = cfg.providers || {};
    const agentModels = cfg.agent_models || {};
    const nodes = (state.nodes || []).slice();
    let onlineCount = 0;
    let pendingCount = 0;
    let revokedCount = 0;
    let totalSyncs = 0;
    let total304 = 0;
    let hasExactStats = false;
    const modelUsage = new Map(); // model -> { nodes:Set, requests, success, failed, inTok, outTok, exact }
    const nodeRows = [];

    for (const n of nodes) {
      totalSyncs += Number(n.sync_count) || 0;
      total304 += Number(n.hit_304_count) || 0;
      const st = nodeStatusWord(n);
      if (st.word === '在线') onlineCount++;
      else if (st.word === '待安装') pendingCount++;
      else if (st.word === '已吊销') revokedCount++;

      let nodeCalls = 0;
      let nodeSuccess = 0;
      let nodeFailed = 0;
      let topModel = '';
      let topCalls = 0;
      const u = n.usage;
      if (u && typeof u === 'object') {
        const statsMap = u.model_stats && typeof u.model_stats === 'object' ? u.model_stats : null;
        const fallback = !statsMap && u.models && typeof u.models === 'object' ? u.models : null;
        const entries = statsMap ? Object.entries(statsMap) : Object.entries(fallback || {});
        for (const [model, raw] of entries) {
          const calls = statsMap ? Number(raw?.calls ?? raw?.requests) || 0 : Number(raw) || 0;
          if (calls <= 0) continue;
          let agg = modelUsage.get(model);
          if (!agg) {
            agg = { nodes: new Set(), requests: 0, success: 0, failed: 0, inTok: 0, outTok: 0, exact: false };
            modelUsage.set(model, agg);
          }
          agg.nodes.add(n.name || n.id);
          agg.requests += calls;
          nodeCalls += calls;
          if (statsMap) {
            const s = Number(raw?.successes ?? raw?.success) || 0;
            const f = Number(raw?.failed) || 0;
            agg.success += s;
            agg.failed += f;
            agg.inTok += Number(raw?.in_tokens ?? raw?.input_tokens) || 0;
            agg.outTok += Number(raw?.out_tokens ?? raw?.output_tokens) || 0;
            agg.exact = true;
            hasExactStats = true;
            nodeSuccess += s;
            nodeFailed += f;
          }
          if (calls > topCalls) {
            topCalls = calls;
            topModel = model;
          }
        }
      }
      // 节点分布只看真实参与过同步的节点：待安装与已吊销不进表（与效果图一致）。
      if (st.word !== '待安装' && st.word !== '已吊销') {
        nodeRows.push({ node: n, status: st, calls: nodeCalls, success: nodeSuccess, failed: nodeFailed, topModel });
      }
    }

    const models = [...modelUsage.entries()].sort((a, b) => b[1].requests - a[1].requests);
    const totalCalls = models.reduce((a, [, m]) => a + m.requests, 0);
    const successCalls = models.reduce((a, [, m]) => a + m.success, 0);
    const failedCalls = models.reduce((a, [, m]) => a + m.failed, 0);
    nodeRows.sort((a, b) => b.calls - a.calls
      || String(a.node.name || a.node.id).localeCompare(String(b.node.name || b.node.id)));
    let totalKeys = 0;
    for (const p of Object.values(providers)) totalKeys += (p?.api_keys || []).length;

    return {
      nodes,
      onlineCount,
      pendingCount,
      revokedCount,
      totalSyncs,
      total304,
      totalCalls,
      successCalls,
      failedCalls,
      hasExactStats,
      providers: Object.keys(providers).length,
      totalKeys,
      modelsCount: Object.keys(agentModels).length,
      models,
      nodeRows,
    };
  }

  function renderStatsView() {
    const kpiGrid = $('statsKpiGrid');
    const modelBody = $('statsModelUsageBody');
    const nodeBody = $('statsNodeDistBody');
    if (!kpiGrid || !modelBody || !nodeBody) return;
    const agg = computeHubStats();

    // —— 指标带 ——
    const rateBase = agg.successCalls + agg.failedCalls;
    const kpis = [
      {
        label: '在线节点',
        value: `${agg.onlineCount} <span class="text-xs text-muted">/ ${agg.nodes.length}</span>`,
        sub: `${agg.pendingCount} 个待安装 · ${agg.revokedCount} 个已吊销`,
      },
      {
        label: '总调用（节点累计）',
        value: String(agg.totalCalls),
        sub: agg.hasExactStats && rateBase > 0 ? `成功率 ${fmtPct((agg.successCalls / rateBase) * 100)}` : '暂无上报',
      },
      {
        label: '下发规模',
        value: String(agg.providers),
        sub: `${agg.totalKeys} 把 Key · ${agg.modelsCount} 个模型`,
      },
      {
        label: '配置同步',
        value: String(agg.totalSyncs),
        sub: `304 命中 ${agg.total304} 次`,
      },
    ];
    kpiGrid.innerHTML = kpis.map((k) => `<div class="kpi-card"><span class="kpi-label">${eh(k.label)}</span><span class="kpi-value">${k.value}</span><span class="kpi-sub">${eh(k.sub)}</span></div>`).join('');

    // —— 模型使用分布 ——
    if (agg.models.length === 0) {
      modelBody.innerHTML = '<tr><td colspan="6" class="text-muted">暂无节点上报模型使用数据。节点在下一次配置同步时会自动上报。</td></tr>';
    } else {
      modelBody.innerHTML = agg.models.map(([model, m]) => {
        const pct = agg.totalCalls > 0 ? (m.requests / agg.totalCalls) * 100 : 0;
        const rateTxt = m.exact && (m.success + m.failed) > 0 ? fmtPct((m.success / (m.success + m.failed)) * 100) : '—';
        const tokTxt = m.exact ? `${fmtCompactTokens(m.inTok)} / ${fmtCompactTokens(m.outTok)}` : '—';
        return `<tr><td>${eh(model)}</td><td class="tabular">${m.nodes.size}</td><td class="tabular">${m.requests}</td><td class="tabular">${rateTxt}</td><td class="tabular">${tokTxt}</td><td>${statsShareBarHtml(pct)}</td></tr>`;
      }).join('');
    }

    // —— 节点分布 ——
    if (agg.nodeRows.length === 0) {
      nodeBody.innerHTML = '<tr><td colspan="5" class="text-muted">暂无已同步的节点。节点完成安装并首次同步后出现在这里。</td></tr>';
    } else {
      nodeBody.innerHTML = agg.nodeRows.map((r) => `<tr><td>${eh(r.node.name || r.node.id)}</td><td><span class="row-status"><span class="dot ${r.status.dot}" aria-hidden="true"></span><span>${eh(r.status.word)}</span></span></td><td class="tabular">${r.calls > 0 ? r.calls : '—'}</td><td>${r.topModel ? `<span class="tabular">${eh(r.topModel)}</span>` : '<span class="text-muted">未上报</span>'}</td><td class="tabular">${eh(fmtTime(r.node.last_seen))}</td></tr>`).join('');
    }

    // 页头注明更新时间（fmtTime 相对时间）。
    statsUpdatedAt = Date.now();
    const tEl = $('statsUpdatedAt');
    if (tEl) tEl.textContent = `数据来自节点同步时的上报 · 更新于 ${fmtTime(statsUpdatedAt)}`;
  }

  async function showStatsView() {
    const statsView = $('statsView');
    if (!statsView) return;
    // switchTab 的 views 表没有 stats 项，进统计页时把承载它的 viewActivity 打开
    // （Full 端 #navStats 保持隐藏，不会走到这里）。
    const activityView = $('viewActivity');
    statsView.hidden = false;
    if (activityView) activityView.hidden = false;
    renderStatsView();
    await loadNodesData();
    if (state.activeTab === 'stats') renderStatsView();
  }

  function setupStatsPage() {
    const statsView = $('statsView');
    if (!statsView) return;
    const navStats = $('navStats');
    if (navStats) navStats.hidden = !isHubMode();
    if (!isHubMode()) {
      statsView.hidden = true;
      return;
    }
    clk($('btnStatsRefresh'), async () => {
      await loadNodesData();
      if (state.activeTab === 'stats') renderStatsView();
    });
    const seg = $('navSeg');
    if (seg) {
      seg.addEventListener('click', () => {
        // switchTab 在 seg-btn 自己的监听器里执行；这里排一个宏任务，
        // 在本次事件分发结束后修正统计页可见性并收尾节点弹框。
        setTimeout(() => {
          // 节点弹框（详情 / 添加）是 fixed 定位，不能悬在别的页签上：
          // 离开节点页签（包括切到统计页）时静默关掉；创建草稿保留，重开时带回。
          if (state.activeTab !== 'nodes' && nodeDialogState.open) closeNodeEditDialog();
          if (state.activeTab === 'stats') {
            showStatsView();
            return;
          }
          if (!statsView.hidden) statsView.hidden = true;
        }, 0);
      });
    }
  }

  window.addEventListener('DOMContentLoaded', setupStatsPage);
