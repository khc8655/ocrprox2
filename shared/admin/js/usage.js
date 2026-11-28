/**
 * usage.js — Magpie-Style High-Fidelity Analytics, Multi-Metric SVG Charts,
 * 53-Week Contribution Heatmap, 4D Breakdown Inspector & Visual Waterfall Traces.
 * Zero inline style, inline row inspection, zero left-border stripes compliant.
 */

(function () {
  const usageState = {
    subTab: 'providers', // 'providers' | 'models' | 'keys' | 'endpoints'
    chartMetric: 'tokens', // 'tokens' | 'requests'
    expandedKey: null,
  };

  function fmtN(n) {
    if (n === undefined || n === null || isNaN(n)) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return Number(n).toLocaleString();
  }

  function fmtBytes(b) {
    if (!b) return '0 B';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  }

  function fmtPct(num, den) {
    if (!den || den <= 0) return '0.0%';
    return ((num / den) * 100).toFixed(1) + '%';
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // Guard non-stream / ultra-short flow TPS calculation so (total_ms - ttft_ms < 20)
  // uses total_ms instead of a 1ms denominator.
  function resolveSafeTps(reportedTps, outTokens, totalMs, ttftMs) {
    const out = Number(outTokens) || 0;
    const tot = Number(totalMs) || 0;
    const ttft = Number(ttftMs) || 0;
    const raw = Number(reportedTps) || 0;
    if (out > 0 && tot > 0 && (tot - ttft) < 20) {
      const safe = (out * 1000) / tot;
      if (raw <= 0 || raw > safe * 4) return safe;
    }
    if (raw > 0) return raw;
    if (out > 0 && tot > 0) {
      const genMs = (tot - ttft) < 20 ? tot : (tot - ttft);
      return genMs > 0 ? (out * 1000) / genMs : 0;
    }
    return 0;
  }

  function renderKPIs(usage, meta = {}) {
    const totals = usage?.totals || {};
    const reqs = totals.requests || 0;
    const succ = totals.success !== undefined ? totals.success : Math.max(0, reqs - (totals.failed || 0));
    const failed = totals.failed !== undefined ? totals.failed : Math.max(0, reqs - succ);
    const retried = totals.retried_requests || 0;
    const succRate = reqs > 0 ? (succ / reqs) * 100 : 0;

    const inT = totals.input_tokens || 0;
    const outT = totals.output_tokens || 0;
    const cRead = totals.cache_read_tokens || 0;
    const cWrite = totals.cache_write_tokens || 0;
    const cWrite1h = totals.cache_write_1h_tokens || 0;
    const reasoning = totals.reasoning_tokens || 0;
    const totalT = inT + outT + cRead;

    const hitRate = totals.cache_hit_rate !== undefined
      ? totals.cache_hit_rate * 100
      : (inT + cRead > 0 ? (cRead / (inT + cRead)) * 100 : 0);

    const avgTtft = totals.avg_ttft_ms || 0;
    const avgTotal = totals.avg_total_ms || 0;
    const avgQueued = totals.avg_queued_ms || 0;
    const avgOwn = totals.avg_own_ms || 0;
    const avgSent = totals.avg_sent_ms || 0;
    const tps = resolveSafeTps(totals.tps || totals.tok_per_sec || 0, outT, avgTotal, avgTtft);
    const upBytes = totals.up_bytes || 0;
    const downBytes = totals.down_bytes || 0;

    const channels = totals.channels || {};
    const agentReqs = channels.agent || 0;
    const kbReqs = channels.kb || 0;
    const sc = totals.status_counts || {};

    setText('statRequests', Number(reqs).toLocaleString());
    setText('statRequestsSub', reqs > 0
      ? `Agent ${agentReqs} · KB ${kbReqs} · 重试 ${retried}`
      : 'Agent 0 · KB 0 · 重试 0');

    setText('statSuccess', reqs > 0 ? succRate.toFixed(1) + '%' : '-');
    setText('statSuccessSub', `成功 ${succ} · 失败 ${failed}`);

    setText('statTokens', fmtN(totalT));
    setText('statTokensSub', `输入 ${fmtN(inT)} · 输出 ${fmtN(outT)}${reasoning > 0 ? ` · 思考 ${fmtN(reasoning)}` : ''}`);

    setText('statCacheHit', (inT + cRead) > 0 ? hitRate.toFixed(1) + '%' : '0%');
    setText('statCacheHitSub', `读取 ${fmtN(cRead)} · 写入 ${fmtN(cWrite)}${cWrite1h > 0 ? ` (1h ${fmtN(cWrite1h)})` : ''}`);

    setText('statTTFT', avgTtft > 0 ? Math.round(avgTtft) + 'ms' : '-');
    setText('statTTFTSub', avgTotal > 0
      ? `均总 ${Math.round(avgTotal)}ms · 排队 ${Math.round(avgQueued)}ms · 内部 ${Math.round(avgOwn)}ms`
      : '暂无延迟采样');

    setText('statTPS', tps > 0 ? tps.toFixed(1) + ' tok/s' : '-');
    setText('statTPSSub', avgSent > 0 ? `建连发送 ${Math.round(avgSent)}ms` : '流式生成速率');

    setText('statBandwidth', `${fmtBytes(upBytes)} ↑ / ${fmtBytes(downBytes)} ↓`);
    setText('statBandwidthSub', `2xx:${sc['2xx'] || 0} · 429:${sc['429'] || 0} · 4xx:${sc['4xx'] || 0} · 5xx:${sc['5xx'] || 0}`);

    const modelCount = Array.isArray(usage?.models)
      ? usage.models.length
      : Object.keys(usage?.models || {}).length;
    const provCount = Object.keys(usage?.providers || {}).length;
    const activeLanes = Object.values(meta.lanes || {}).reduce((acc, v) => acc + (v?.busy ?? v?.Busy ?? 0), 0);
    const waitingLanes = Object.values(meta.lanes || {}).reduce((acc, v) => acc + (v?.waiting ?? v?.Waiting ?? 0), 0);
    const cooldownCount = (meta.cooldowns || []).length;

    setText('statActiveScope', `${modelCount} 模型 / ${provCount} 供应商`);
    setText('statActiveScopeSub', `运行中 ${activeLanes} · 排队 ${waitingLanes} · 冷却 ${cooldownCount}`);
  }

  function renderLiveStrip(lanes = {}, cooldowns = [], onClearCooldown = null) {
    const card = document.getElementById('liveRuntimeStripCard');
    const strip = document.getElementById('liveRuntimeStrip');
    if (!card || !strip) return;

    const busyEntries = Object.entries(lanes || {}).filter(([, v]) => (v?.busy ?? v?.Busy ?? 0) > 0 || (v?.waiting ?? v?.Waiting ?? 0) > 0);
    const cdList = Array.isArray(cooldowns) ? cooldowns : [];

    if (busyEntries.length === 0 && cdList.length === 0) {
      card.hidden = true;
      card.classList.add('hidden');
      strip.innerHTML = '';
      return;
    }

    card.hidden = false;
    card.classList.remove('hidden');
    strip.innerHTML = '';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'live-strip-group';
    const laneTitle = document.createElement('span');
    laneTitle.className = 'form-label';
    laneTitle.textContent = '实时并发通道:';
    leftGroup.appendChild(laneTitle);

    if (busyEntries.length === 0) {
      const idlePill = document.createElement('span');
      idlePill.className = 'pill';
      idlePill.textContent = '当前空闲';
      leftGroup.appendChild(idlePill);
    } else {
      busyEntries.forEach(([name, v]) => {
        const busy = v?.busy ?? v?.Busy ?? 0;
        const waiting = v?.waiting ?? v?.Waiting ?? 0;
        const limit = v?.limit ?? v?.Limit ?? 0;
        const pill = document.createElement('span');
        pill.className = 'pill pill--accent tabular';
        const limitText = limit > 0 ? `/${limit}` : '';
        const waitText = waiting > 0 ? ` 排队:${waiting}` : '';
        pill.textContent = `${name}: ${busy}${limitText}${waitText}`;
        leftGroup.appendChild(pill);
      });
    }
    strip.appendChild(leftGroup);

    if (cdList.length > 0) {
      const rightGroup = document.createElement('div');
      rightGroup.className = 'live-strip-group';
      const cdTitle = document.createElement('span');
      cdTitle.className = 'form-label';
      cdTitle.textContent = `异常冷却 (${cdList.length}):`;
      rightGroup.appendChild(cdTitle);

      cdList.slice(0, 8).forEach((entry) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--sm btn--danger tabular';
        btn.title = `点击解除冷却 (${entry.reason || 'cooldown'})`;
        btn.textContent = `${entry.target} (${entry.remaining_sec || 0}s) · 解除`;
        btn.addEventListener('click', () => {
          if (typeof onClearCooldown === 'function') {
            onClearCooldown(entry.target);
          }
        });
        rightGroup.appendChild(btn);
      });
      strip.appendChild(rightGroup);
    }
  }

  function renderChartLegend(metric) {
    const legend = document.getElementById('usageChartLegend');
    if (!legend) return;
    if (metric === 'requests') {
      legend.innerHTML = [
        '<span class="legend-item"><span class="legend-swatch legend-swatch--in"></span>成功请求</span>',
        '<span class="legend-item"><span class="legend-swatch legend-swatch--fail"></span>异常失败</span>',
      ].join('');
    } else {
      legend.innerHTML = [
        '<span class="legend-item"><span class="legend-swatch legend-swatch--in"></span>常规输入</span>',
        '<span class="legend-item"><span class="legend-swatch legend-swatch--cache"></span>缓存读取</span>',
        '<span class="legend-item"><span class="legend-swatch legend-swatch--write"></span>缓存写入</span>',
        '<span class="legend-item"><span class="legend-swatch legend-swatch--out"></span>模型输出</span>',
      ].join('');
    }
  }

  // Multi-Metric Stacked SVG Bar Chart (Magpie style)
  function renderStackedBarChart(usage) {
    const container = document.getElementById('usageChartBox');
    if (!container) return;
    container.innerHTML = '';

    const metric = usageState.chartMetric || 'tokens';
    renderChartLegend(metric);

    const series = usage?.series || [];
    if (series.length === 0) {
      container.innerHTML = '<div class="chart-empty">当前周期暂无流量趋势数据</div>';
      return;
    }

    const width = 760;
    const height = 164;
    const padL = 44;
    const padR = 14;
    const padT = 14;
    const padB = 28;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;
    const baselineY = padT + chartH;

    let peak = 1;
    let hasAnyValue = false;
    series.forEach((p) => {
      let val = 0;
      if (metric === 'requests') {
        val = (p.successes || 0) + (p.failed || 0);
        if (!val) val = p.requests || p.calls || 0;
      } else {
        val = (p.input_tokens || p.in_tokens || 0) +
          (p.cache_read_tokens || 0) +
          (p.cache_write_tokens || 0) +
          (p.output_tokens || p.out_tokens || 0);
      }
      if (val > 0) hasAnyValue = true;
      if (val > peak) peak = val;
    });

    if (!hasAnyValue) {
      container.innerHTML = '<div class="chart-empty">当前所选周期暂无请求采样</div>';
      return;
    }

    const n = series.length;
    const step = chartW / n;
    const barW = Math.max(3, Math.min(24, Math.floor(step * 0.72)));

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'chart-svg');

    // Gridlines + Y-axis labels (0, 50%, 100%)
    [0.5, 1.0].forEach((ratio) => {
      const y = baselineY - Math.round(chartH * ratio);
      const grid = document.createElementNS(svgNs, 'line');
      grid.setAttribute('x1', String(padL));
      grid.setAttribute('y1', String(y));
      grid.setAttribute('x2', String(width - padR));
      grid.setAttribute('y2', String(y));
      grid.setAttribute('class', 'chart-gridline');
      svg.appendChild(grid);

      const yLbl = document.createElementNS(svgNs, 'text');
      yLbl.setAttribute('x', String(padL - 6));
      yLbl.setAttribute('y', String(y + 3));
      yLbl.setAttribute('text-anchor', 'end');
      yLbl.setAttribute('class', 'chart-label');
      yLbl.textContent = fmtN(Math.round(peak * ratio));
      svg.appendChild(yLbl);
    });

    const axis = document.createElementNS(svgNs, 'line');
    axis.setAttribute('x1', String(padL));
    axis.setAttribute('y1', String(baselineY));
    axis.setAttribute('x2', String(width - padR));
    axis.setAttribute('y2', String(baselineY));
    axis.setAttribute('class', 'chart-axis');
    svg.appendChild(axis);

    let lastLabelX = -100;
    const minLabelGap = 46;

    const addSeg = (g, x, yBottom, h, cls) => {
      if (h <= 0) return 0;
      const rect = document.createElementNS(svgNs, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(yBottom - h));
      rect.setAttribute('width', String(barW));
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '1.5');
      rect.setAttribute('class', `chart-rect ${cls}`);
      g.appendChild(rect);
      return h;
    };

    series.forEach((p, idx) => {
      const x = padL + idx * step + (step - barW) / 2;
      const g = document.createElementNS(svgNs, 'g');
      g.setAttribute('class', 'chart-bar-group');

      const inTok = p.input_tokens || p.in_tokens || 0;
      const cRead = p.cache_read_tokens || 0;
      const cWrite = p.cache_write_tokens || 0;
      const outTok = p.output_tokens || p.out_tokens || 0;
      const reqCount = p.requests || p.calls || 0;
      const succCount = p.successes || Math.max(0, reqCount - (p.failed || 0));
      const failCount = p.failed || 0;

      const timeLabel = p.label || (p.timestamp ? new Date(p.timestamp * 1000).toLocaleDateString() : `#${idx + 1}`);
      const safeBarTps = resolveSafeTps(p.tps || 0, outTok, p.avg_total_ms || 0, p.avg_ttft_ms || 0);
      const title = document.createElementNS(svgNs, 'title');
      title.textContent = [
        timeLabel,
        `请求: ${reqCount} (成功 ${succCount}, 失败 ${failCount})`,
        `Tokens: 输入 ${fmtN(inTok)} · 缓存读 ${fmtN(cRead)} · 缓存写 ${fmtN(cWrite)} · 输出 ${fmtN(outTok)}`,
        p.avg_ttft_ms ? `平均 TTFT: ${Math.round(p.avg_ttft_ms)}ms` : '',
        safeBarTps > 0 ? `平均 TPS: ${safeBarTps.toFixed(1)} tok/s` : '',
      ].filter(Boolean).join('\n');
      g.appendChild(title);

      if (metric === 'requests') {
        const succH = Math.round((succCount / peak) * chartH);
        const failH = Math.round((failCount / peak) * chartH);
        let curY = baselineY;
        curY -= addSeg(g, x, curY, succH, 'chart-rect--req');
        addSeg(g, x, curY, failH, 'chart-rect--fail');
      } else {
        const inH = Math.round((inTok / peak) * chartH);
        const crH = Math.round((cRead / peak) * chartH);
        const cwH = Math.round((cWrite / peak) * chartH);
        const outH = Math.round((outTok / peak) * chartH);
        let curY = baselineY;
        curY -= addSeg(g, x, curY, inH, 'chart-rect--in');
        curY -= addSeg(g, x, curY, crH, 'chart-rect--cache');
        curY -= addSeg(g, x, curY, cwH, 'chart-rect--write');
        addSeg(g, x, curY, outH, 'chart-rect--out');
      }

      const centerX = x + barW / 2;
      const isLast = idx === n - 1;
      if ((centerX - lastLabelX >= minLabelGap && (!isLast || centerX - lastLabelX >= minLabelGap)) || idx === 0) {
        const text = document.createElementNS(svgNs, 'text');
        text.setAttribute('x', String(centerX));
        text.setAttribute('y', String(baselineY + 16));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'chart-label');
        let shortLabel = String(p.label || '');
        if (shortLabel.includes('-')) {
          const parts = shortLabel.split('-');
          shortLabel = parts.slice(1).join('/');
        }
        text.textContent = shortLabel;
        g.appendChild(text);
        lastLabelX = centerX;
      }

      svg.appendChild(g);
    });

    container.appendChild(svg);
  }

  function buildMetricDetailEditor(boxes, extraHtml = '') {
    const ed = document.createElement('div');
    ed.className = 'editor';
    const grid = boxes.map((b) => `
      <div class="metric-box">
        <div class="metric-box-label">${escapeHtml(b.label)}</div>
        <div class="metric-box-val tabular">${escapeHtml(b.value)}</div>
      </div>
    `).join('');
    ed.innerHTML = `<div class="metric-grid">${grid}</div>${extraHtml}`;
    return ed;
  }

  function normalizeBreakdownRow(name, s) {
    const reqs = s.requests || 0;
    const succ = s.successes !== undefined ? s.successes : Math.max(0, reqs - (s.failed || 0));
    const failed = s.failed !== undefined ? s.failed : Math.max(0, reqs - succ);
    const inTokens = s.in_tokens || s.input_tokens || 0;
    const outTokens = s.out_tokens || s.output_tokens || 0;
    const cacheRead = s.cache_read_tokens || 0;
    const cacheWrite = s.cache_write_tokens || 0;
    const reasoning = s.reasoning_tokens || 0;
    const retried = s.retried || 0;
    const avgTtft = s.avg_ttft_ms || 0;
    const avgTotal = s.avg_total_ms || (reqs > 0 && s.total_ms ? Math.round(s.total_ms / reqs) : 0);
    const tps = resolveSafeTps(s.tps || 0, outTokens, avgTotal, avgTtft);
    const cacheHitRate = s.cache_hit_rate !== undefined
      ? s.cache_hit_rate
      : (inTokens + cacheRead > 0 ? cacheRead / (inTokens + cacheRead) : 0);

    return {
      name,
      mode: s.mode || '',
      requests: reqs,
      successes: succ,
      failed,
      retried,
      inTokens,
      outTokens,
      cacheRead,
      cacheWrite,
      reasoning,
      cacheHitRate,
      avgTtft,
      avgTotal,
      tps,
      upBytes: s.up_bytes || 0,
      downBytes: s.down_bytes || 0,
      keys: s.keys || null,
    };
  }

  // 4-Dimension Breakdown Table: Models, Providers, Keys, Endpoints
  function renderBreakdown(usage) {
    const container = document.getElementById('usageBreakdownList');
    if (!container) return;
    container.innerHTML = '';

    const subTab = usageState.subTab;
    let items = [];

    if (subTab === 'models') {
      const raw = usage?.models;
      if (Array.isArray(raw)) {
        items = raw.map((m) => normalizeBreakdownRow(m.model || m.name || 'unknown', m));
      } else if (raw && typeof raw === 'object') {
        items = Object.entries(raw).map(([k, s]) => normalizeBreakdownRow(k, s));
      }
      if (items.length === 0) return renderEmptyRow(container, '当前周期暂无模型用量记录');
    } else if (subTab === 'providers') {
      const raw = usage?.providers;
      if (raw && typeof raw === 'object') {
        items = Object.entries(raw).map(([k, s]) => normalizeBreakdownRow(k, s));
      }
      if (items.length === 0) return renderEmptyRow(container, '当前周期暂无供应商用量记录');
    } else if (subTab === 'keys') {
      const raw = usage?.keys || [];
      items = raw.map((k) => ({
        ...normalizeBreakdownRow(`${k.provider} / ${k.key_id}`, k),
        iconHint: k.provider,
      }));
      if (items.length === 0) return renderEmptyRow(container, '当前周期暂无密钥用量记录');
    } else if (subTab === 'endpoints') {
      const raw = usage?.endpoints || [];
      items = raw.map((ep) => ({
        ...normalizeBreakdownRow(ep.endpoint || 'unknown', ep),
        iconHint: ep.mode === 'kb' ? 'kb' : 'agent',
      }));
      if (items.length === 0) return renderEmptyRow(container, '当前周期暂无接口通道记录');
    }

    items.sort((a, b) => b.requests - a.requests);

    items.forEach((item) => {
      const rowKey = `${subTab}:${item.name}`;
      const isExpanded = usageState.expandedKey === rowKey;
      const totalT = item.inTokens + item.outTokens + item.cacheRead;
      const rate = item.requests > 0 ? (item.successes / item.requests) * 100 : 0;
      const icoHtml = subTab !== 'endpoints' && window.renderBrandIcon
        ? window.renderBrandIcon(item.iconHint || item.name)
        : '';

      // 行结构走 W1 的 listRow()（v2 §4.1 全站唯一写法）。usage.js 是独立 IIFE，
      // 拿不到 core.js 的作用域，所以经 window.listRow 调用。
      // 组件 3：一行只允许「名称 + 一行次要信息 + 一个状态 + 至多一个计数」。
      // 模式 / Token / 重试率这些次要标签全部并进 .sub，不再一行堆 pill。
      const subBits = [
        item.mode ? item.mode.toUpperCase() : null,
        `${fmtN(totalT)} tok`,
        item.retried > 0 ? `重试 ${item.retried}` : null,
        `成功率 ${rate.toFixed(1)}% (失败 ${item.failed})`,
        `缓存命中 ${(item.cacheHitRate * 100).toFixed(1)}% (${fmtN(item.cacheRead)})`,
        item.avgTtft ? `TTFT ${Math.round(item.avgTtft)}ms` : null,
        item.avgTotal ? `均耗 ${Math.round(item.avgTotal)}ms` : null,
        item.tps ? `${item.tps.toFixed(1)} tok/s` : null,
      ].filter(Boolean).join(' · ');
      let logoEl = null;
      if (icoHtml) {
        const holder = document.createElement('span');
        holder.innerHTML = icoHtml;
        logoEl = holder.firstElementChild;
      }
      const row = window.listRow({
        logo: logoEl,
        title: `<span class="${subTab === 'endpoints' ? 'tabular' : ''}">${escapeHtml(item.name)}</span>`,
        sub: escapeHtml(subBits),
        status: { dot: rate >= 99 ? 'dot--ok' : rate >= 90 ? 'dot--warn' : 'dot--err', label: rate >= 99 ? '正常' : rate >= 90 ? '波动' : '异常' },
        count: `<span class="pill tabular">${item.requests.toLocaleString()} 次</span>`,
        onOpen: () => {
          usageState.expandedKey = isExpanded ? null : rowKey;
          renderBreakdown(usage);
        },
      });
      // 展开态高亮是过渡行为（v2 列表行没有展开态，编辑迁到弹框后删）。
      if (isExpanded) row.classList.add('expanded');
      container.appendChild(row);

      if (isExpanded) {
        const boxes = [
          { label: '请求 / 成功 / 失败', value: `${item.requests} / ${item.successes} / ${item.failed}` },
          { label: '重试次数', value: String(item.retried) },
          { label: '输入 / 输出 Token', value: `${fmtN(item.inTokens)} / ${fmtN(item.outTokens)}` },
          { label: '缓存读取 / 写入', value: `${fmtN(item.cacheRead)} / ${fmtN(item.cacheWrite)}` },
          { label: '推理思考 Token', value: fmtN(item.reasoning) },
          { label: '平均 TTFT / 总耗时', value: `${item.avgTtft ? Math.round(item.avgTtft) + 'ms' : '-'} / ${item.avgTotal ? Math.round(item.avgTotal) + 'ms' : '-'}` },
          { label: '生成速率 (TPS)', value: item.tps ? `${item.tps.toFixed(1)} tok/s` : '-' },
          { label: '上下行流量', value: `${fmtBytes(item.upBytes)} / ${fmtBytes(item.downBytes)}` },
        ];

        let extraHtml = '';
        if (item.keys && Object.keys(item.keys).length > 0) {
          const pills = Object.entries(item.keys)
            .sort(([, a], [, b]) => b - a)
            .map(([kId, cnt]) => `<span class="pill tabular">${escapeHtml(kId)}: ${cnt} 次 (${fmtPct(cnt, item.requests)})</span>`)
            .join('');
          extraHtml = `<div class="mt-3"><div class="form-label mb-1">Key 调用分布</div><div class="fields">${pills}</div></div>`;
        }
        container.appendChild(buildMetricDetailEditor(boxes, extraHtml));
      }
    });
  }

  function renderEmptyRow(container, text) {
    // 空状态走 W1 的 listRow()（静态行）；usage.js 是独立 IIFE，经 window.listRow 调用。
    container.appendChild(window.listRow({ title: text, cls: 'text-muted' }));
  }

  // Visual Stacked SVG Waterfall & Trace Details Inspector (Magpie style)
  function buildTraceWaterfall(trace) {
    const wrap = document.createElement('div');
    wrap.className = 'trace-waterfall-wrap';

    const ownMs = trace.own_ms || 0;
    const queuedMs = trace.queued_ms || 0;
    const sentMs = trace.sent_ms || 0;
    const ttftMs = trace.ttft_ms || 0;
    const flowMs = trace.flow_ms || 0;
    const retriedMs = trace.retried_ms || 0;
    const segSum = ownMs + queuedMs + sentMs + ttftMs + flowMs + retriedMs;
    const totalMs = Math.max(trace.total_ms || 0, segSum, 1);

    const segments = [
      { key: 'own', label: '网关内部', ms: ownMs, cls: 'wf-seg--own', swatch: 'legend-swatch--own' },
      { key: 'queued', label: '并发排队', ms: queuedMs, cls: 'wf-seg--queued', swatch: 'legend-swatch--queued' },
      { key: 'sent', label: '建连发送', ms: sentMs, cls: 'wf-seg--sent', swatch: 'legend-swatch--sent' },
      { key: 'ttft', label: '首字等待', ms: ttftMs, cls: 'wf-seg--ttft', swatch: 'legend-swatch--ttft' },
      { key: 'flow', label: '流生成', ms: flowMs, cls: 'wf-seg--flow', swatch: 'legend-swatch--flow' },
      { key: 'retried', label: '重试耗时', ms: retriedMs, cls: 'wf-seg--retried', swatch: 'legend-swatch--retried' },
    ];

    const svgNs = 'http://www.w3.org/2000/svg';
    const barSvg = document.createElementNS(svgNs, 'svg');
    barSvg.setAttribute('viewBox', '0 0 600 14');
    barSvg.setAttribute('preserveAspectRatio', 'none');
    barSvg.setAttribute('class', 'wf-bar-svg');

    let curX = 0;
    segments.forEach((seg) => {
      if (seg.ms <= 0) return;
      const segW = Math.max(2, (seg.ms / totalMs) * 600);
      const rect = document.createElementNS(svgNs, 'rect');
      rect.setAttribute('x', String(curX));
      rect.setAttribute('y', '0');
      rect.setAttribute('width', String(Math.min(600 - curX, segW)));
      rect.setAttribute('height', '14');
      rect.setAttribute('class', seg.cls);
      const t = document.createElementNS(svgNs, 'title');
      t.textContent = `${seg.label}: ${seg.ms}ms (${((seg.ms / totalMs) * 100).toFixed(1)}%)`;
      rect.appendChild(t);
      barSvg.appendChild(rect);
      curX += segW;
    });

    const legendHtml = segments
      .filter((s) => s.ms > 0)
      .map((s) => `<span class="legend-item"><span class="legend-swatch ${s.swatch}"></span>${s.label} <strong class="tabular">${s.ms}ms</strong></span>`)
      .join('');

    const tokenBoxes = [
      { label: '实际命中模型', value: trace.served_model || trace.req_model || '-' },
      { label: '模式 / 协议', value: `${(trace.mode || 'agent').toUpperCase()} · ${trace.stream ? 'SSE 流' : '非流式'}` },
      { label: 'Token (入/出/思)', value: `${trace.in_tokens || 0} / ${trace.out_tokens || 0} / ${trace.reasoning_tokens || 0}` },
      { label: '缓存 (读/写)', value: `${trace.cache_read_tokens || 0} / ${trace.cache_write_tokens || 0}` },
      { label: '上下行流量', value: `${fmtBytes(trace.up_bytes || 0)} / ${fmtBytes(trace.down_bytes || 0)}` },
      { label: '结束原因 / 总耗时', value: `${trace.stop_reason || '-'} · ${trace.total_ms || totalMs}ms` },
    ];
    const tokenGridHtml = tokenBoxes.map((b) => `
      <div class="metric-box">
        <div class="metric-box-label">${escapeHtml(b.label)}</div>
        <div class="metric-box-val tabular">${escapeHtml(b.value)}</div>
      </div>
    `).join('');

    wrap.innerHTML = `
      <div class="waterfall-metrics">
        <div class="section-bar flex-1 mb-1">
          <span class="form-label">全链路耗时瀑布 (${totalMs}ms)</span>
          <div class="chart-legend">${legendHtml || `<span class="text-muted text-xs">总耗时 ${totalMs}ms</span>`}</div>
        </div>
        <div class="flex-1" id="wf_bar_slot_${trace.id}"></div>
      </div>

      <div class="metric-grid mt-3">${tokenGridHtml}</div>

      <div class="mt-3">
        <div class="form-label mb-1">上游重试与路由跳跃 (Tries / Hops):</div>
        <div class="tries-list" id="trace_tries_${trace.id}"></div>
      </div>

      <div class="mt-3 trace-headers-grid">
        ${renderScrubbedHeaders('客户端脱敏请求头 (Request Headers)', trace.req_headers)}
        ${renderScrubbedHeaders('上游响应头 (Response Headers)', trace.tries?.[trace.tries.length - 1]?.resp_headers || trace.tries?.[0]?.resp_headers)}
      </div>
    `;

    const slot = wrap.querySelector(`#wf_bar_slot_${trace.id}`);
    if (slot) slot.appendChild(barSvg);

    const triesList = wrap.querySelector(`#trace_tries_${trace.id}`);
    const tries = trace.tries || [];
    if (tries.length === 0) {
      const none = document.createElement('div');
      none.className = 'text-muted text-sm';
      none.textContent = '单次直连，无尝试记录';
      triesList.appendChild(none);
    } else {
      tries.forEach((tr) => {
        const trRow = document.createElement('div');
        trRow.className = 'try-row';
        const isOk = tr.status >= 200 && tr.status < 300;
        const brandIco = window.renderBrandIcon ? window.renderBrandIcon(tr.provider) : '';
        trRow.innerHTML = `
          <div class="flex-1">
            <div class="name">
              <span class="dot ${isOk ? 'dot--ok' : 'dot--err'}"></span>
              ${brandIco}
              <strong>Hop #${tr.attempt}</strong>
              <span class="tabular">${escapeHtml(tr.provider)} / ${escapeHtml(tr.key_id)}</span>
              <span class="pill ${isOk ? 'pill--green' : 'pill--red'} tabular">HTTP ${tr.status}</span>
            </div>
            <div class="sub">
              ${tr.model ? `${escapeHtml(tr.model)} · ` : ''}${tr.ms}ms${tr.ttft_ms ? ` · TTFT ${tr.ttft_ms}ms` : ''}${tr.reason ? ` · ${escapeHtml(tr.reason)}` : ''}${tr.cooldown_applied_sec ? ` · 触发冷却 ${tr.cooldown_applied_sec}s` : ''}
            </div>
            ${tr.error_snippet ? `<div class="text-danger text-sm mt-1">${escapeHtml(tr.error_snippet)}</div>` : ''}
          </div>
        `;
        triesList.appendChild(trRow);
      });
    }

    return wrap;
  }

  function renderScrubbedHeaders(title, headers) {
    if (!headers || Object.keys(headers).length === 0) {
      return '';
    }
    const lines = Object.entries(headers)
      .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
      .join('\n');
    return `
      <details class="headers-details mt-2">
        <summary class="form-label">${escapeHtml(title)}</summary>
        <pre class="headers-pre"><code class="input--code">${lines}</code></pre>
      </details>
    `;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.USAGE = {
    state: usageState,
    renderKPIs,
    renderLiveStrip,
    renderStackedBarChart,
    renderBreakdown,
    buildTraceWaterfall,
  };
})();
