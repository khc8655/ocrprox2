/**
 * usage.js — High-Fidelity Analytics, Pure SVG Stacked Bar Charts, Heatmap & Trace Waterfall
 * Zero inline style, inline row inspection, zero left-border stripes compliant.
 */

(function () {
  const usageState = {
    subTab: 'models', // 'models' | 'providers' | 'keys'
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

  function renderKPIs(usage) {
    const totals = usage?.totals || {};
    const reqs = totals.requests || 0;
    const succ = totals.success !== undefined ? totals.success : (reqs - (totals.failed || 0));
    const succRate = reqs > 0 ? (succ / reqs) * 100 : 0;
    const inT = totals.input_tokens || 0;
    const outT = totals.output_tokens || 0;
    const cRead = totals.cache_read_tokens || 0;
    const totalT = inT + outT + cRead;
    const hitRate = totals.cache_hit_rate !== undefined ? totals.cache_hit_rate * 100 : ((inT + cRead > 0) ? (cRead / (inT + cRead)) * 100 : 0);
    const avgTtft = totals.avg_ttft_ms || 0;
    const tps = totals.tps || totals.tok_per_sec || 0;
    const upBytes = totals.up_bytes || 0;
    const downBytes = totals.down_bytes || 0;

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setVal('statRequests', Number(reqs).toLocaleString());
    setVal('statSuccess', reqs > 0 ? succRate.toFixed(1) + '%' : '-');
    setVal('statTokens', fmtN(totalT));
    setVal('statCacheHit', hitRate > 0 ? hitRate.toFixed(1) + '%' : '0%');
    setVal('statTTFT', avgTtft > 0 ? Math.round(avgTtft) + 'ms' : '-');
    setVal('statTPS', tps > 0 ? tps.toFixed(1) + ' tok/s' : '-');
    setVal('statBandwidth', `${fmtBytes(upBytes)} ↑ / ${fmtBytes(downBytes)} ↓`);

    const modelCount = Array.isArray(usage?.models)
      ? usage.models.length
      : Object.keys(usage?.models || {}).length;
    const provCount = Object.keys(usage?.providers || {}).length;
    setVal('statActiveScope', `${modelCount} 模型 / ${provCount} 供应商`);
  }

  // Pure SVG Dual-Tone Stacked Bar Histogram (M9)
  function renderStackedBarChart(usage) {
    const container = document.getElementById('usageChartBox');
    if (!container) return;
    container.innerHTML = '';

    const series = usage?.series || [];
    if (series.length === 0) {
      container.classList.add('hidden');
      container.hidden = true;
      return;
    }
    container.classList.remove('hidden');
    container.hidden = false;

    const width = 720;
    const height = 140;
    const padL = 36;
    const padR = 16;
    const padT = 12;
    const padB = 28;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;
    const baselineY = padT + chartH;

    let peak = 1;
    series.forEach((p) => {
      const inp = (p.input_tokens || p.in_tokens || 0) + (p.cache_read_tokens || 0);
      const out = p.output_tokens || p.out_tokens || 0;
      const sum = inp + out;
      if (sum > peak) peak = sum;
    });

    const n = series.length;
    const step = chartW / n;
    const barW = Math.max(3, Math.min(24, Math.floor(step * 0.72)));

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'chart-svg');

    // Baseline axis
    const axis = document.createElementNS(svgNs, 'line');
    axis.setAttribute('x1', String(padL));
    axis.setAttribute('y1', String(baselineY));
    axis.setAttribute('x2', String(width - padR));
    axis.setAttribute('y2', String(baselineY));
    axis.setAttribute('class', 'chart-axis');
    svg.appendChild(axis);

    let lastLabelX = -100;
    const minLabelGap = 46;

    series.forEach((p, idx) => {
      const inp = (p.input_tokens || p.in_tokens || 0) + (p.cache_read_tokens || 0);
      const out = p.output_tokens || p.out_tokens || 0;
      const totalTokens = inp + out;
      const reqCount = p.requests || p.calls || 0;

      const totalBarH = Math.round((totalTokens / peak) * chartH);
      const inH = Math.round((inp / peak) * chartH);
      const outH = Math.max(0, totalBarH - inH);

      const x = padL + idx * step + (step - barW) / 2;

      // Group for hover title
      const g = document.createElementNS(svgNs, 'g');
      g.setAttribute('class', 'chart-bar-group');

      const title = document.createElementNS(svgNs, 'title');
      const timeLabel = p.label || (p.timestamp ? new Date(p.timestamp * 1000).toLocaleDateString() : `#${idx + 1}`);
      title.textContent = `${timeLabel}\n总计: ${fmtN(totalTokens)} tok (输入+缓存: ${fmtN(inp)}, 输出: ${fmtN(out)})\n请求数: ${reqCount}${p.avg_ttft_ms ? ` · TTFT: ${Math.round(p.avg_ttft_ms)}ms` : ''}${p.tps ? ` · TPS: ${p.tps} tok/s` : ''}`;
      g.appendChild(title);

      // Input Rect (Bottom)
      if (inH > 0) {
        const inRect = document.createElementNS(svgNs, 'rect');
        inRect.setAttribute('x', String(x));
        inRect.setAttribute('y', String(baselineY - inH));
        inRect.setAttribute('width', String(barW));
        inRect.setAttribute('height', String(inH));
        inRect.setAttribute('rx', '2');
        inRect.setAttribute('class', 'chart-rect chart-rect--in');
        g.appendChild(inRect);
      }

      // Output Rect (Stacked on top)
      if (outH > 0) {
        const outRect = document.createElementNS(svgNs, 'rect');
        outRect.setAttribute('x', String(x));
        outRect.setAttribute('y', String(baselineY - inH - outH));
        outRect.setAttribute('width', String(barW));
        outRect.setAttribute('height', String(outH));
        outRect.setAttribute('rx', '2');
        outRect.setAttribute('class', 'chart-rect chart-rect--out');
        g.appendChild(outRect);
      }

      // Axis text label with pixel collision guard
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

  // 53-Week Contribution Heatmap (M9)
  function renderHeatmap(usage) {
    const container = document.getElementById('usageHeatmapBox');
    const wrapper = document.getElementById('usageHeatmapWrapper');
    if (!container) return;
    container.innerHTML = '';

    const heatmap = usage?.heatmap;
    if (!heatmap || !heatmap.days || heatmap.days.length === 0) {
      if (wrapper) {
        wrapper.classList.add('hidden');
        wrapper.hidden = true;
      }
      container.classList.add('hidden');
      container.hidden = true;
      return;
    }
    if (wrapper) {
      wrapper.classList.remove('hidden');
      wrapper.hidden = false;
    }
    container.classList.remove('hidden');
    container.hidden = false;

    const dayMap = new Map();
    let maxTokens = 1;
    heatmap.days.forEach((d) => {
      const t = d.tokens || d.Tokens || 0;
      const c = d.calls || d.Calls || 0;
      dayMap.set(d.date || d.Date, { tokens: t, calls: c });
      if (t > maxTokens) maxTokens = t;
    });

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 636 84');
    svg.setAttribute('class', 'heatmap-svg');

    const startDate = new Date(heatmap.from || heatmap.From || Date.now() - 52 * 7 * 86400000);
    const cellSize = 10;
    const gap = 2;

    for (let w = 0; w < 53; w++) {
      for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
        const offsetDays = w * 7 + dayOfWeek;
        const curDate = new Date(startDate.getTime() + offsetDays * 86400000);
        const y = curDate.getFullYear();
        const m = String(curDate.getMonth() + 1).padStart(2, '0');
        const d = String(curDate.getDate()).padStart(2, '0');
        const dateKey = `${y}-${m}-${d}`;

        const info = dayMap.get(dateKey) || { tokens: 0, calls: 0 };
        const tokens = info.tokens;
        const calls = info.calls;

        let level = 0;
        if (tokens > 0) {
          const ratio = tokens / maxTokens;
          if (ratio > 0.6) level = 4;
          else if (ratio > 0.3) level = 3;
          else if (ratio > 0.1) level = 2;
          else level = 1;
        }

        const rect = document.createElementNS(svgNs, 'rect');
        rect.setAttribute('x', String(w * (cellSize + gap)));
        rect.setAttribute('y', String(dayOfWeek * (cellSize + gap)));
        rect.setAttribute('width', String(cellSize));
        rect.setAttribute('height', String(cellSize));
        rect.setAttribute('rx', '2');
        rect.setAttribute('class', `heat-cell heat-l${level}`);

        const title = document.createElementNS(svgNs, 'title');
        title.textContent = `${dateKey}: ${calls} 请求 · ${fmtN(tokens)} tok`;
        rect.appendChild(title);

        svg.appendChild(rect);
      }
    }

    container.appendChild(svg);
  }

  // 3-Dimension Breakdown Table: Models, Providers, Keys (M10)
  function renderBreakdown(usage) {
    const container = document.getElementById('usageBreakdownList');
    if (!container) return;
    container.innerHTML = '';

    const subTab = usageState.subTab;

    if (subTab === 'models') {
      renderBreakdownModels(container, usage);
    } else if (subTab === 'providers') {
      renderBreakdownProviders(container, usage);
    } else if (subTab === 'keys') {
      renderBreakdownKeys(container, usage);
    }
  }

  function renderBreakdownModels(container, usage) {
    const raw = usage?.models;
    let list = [];
    if (Array.isArray(raw)) {
      list = raw.map((m) => ({
        name: m.model || m.name || 'unknown',
        requests: m.requests || 0,
        successes: m.successes || (m.requests - (m.failed || 0)),
        inTokens: m.in_tokens || m.input_tokens || 0,
        outTokens: m.out_tokens || m.output_tokens || 0,
        cacheRead: m.cache_read_tokens || 0,
        cacheHitRate: m.cache_hit_rate || 0,
        avgTtft: m.avg_ttft_ms || 0,
        tps: m.tps || 0,
      }));
    } else if (raw && typeof raw === 'object') {
      list = Object.entries(raw).map(([k, s]) => ({
        name: k,
        requests: s.requests || 0,
        successes: s.successes || (s.requests - (s.failed || 0)),
        inTokens: s.in_tokens || s.input_tokens || 0,
        outTokens: s.out_tokens || s.output_tokens || 0,
        cacheRead: s.cache_read_tokens || 0,
        cacheHitRate: s.cache_hit_rate || 0,
        avgTtft: s.avg_ttft_ms || 0,
        tps: s.tps || 0,
      }));
    }

    if (list.length === 0) {
      renderEmptyRow(container, '当前周期暂无模型用量记录');
      return;
    }

    list.sort((a, b) => b.requests - a.requests);

    list.forEach((m) => {
      const totalT = m.inTokens + m.outTokens + m.cacheRead;
      const rate = m.requests > 0 ? (m.successes / m.requests) * 100 : 0;
      const icoHtml = window.renderBrandIcon ? window.renderBrandIcon(m.name) : '';

      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="dot ${rate >= 99 ? 'dot--ok' : rate >= 90 ? 'dot--warn' : 'dot--err'}"></span>
        ${icoHtml}
        <div class="who">
          <div class="name">
            <span>${escapeHtml(m.name)}</span>
            <span class="pill">${m.requests.toLocaleString()} 次</span>
            <span class="pill pill--accent">${fmtN(totalT)} tok</span>
          </div>
          <div class="sub">成功率: ${rate.toFixed(1)}% · 缓存: ${fmtN(m.cacheRead)}${m.avgTtft ? ' · TTFT ' + Math.round(m.avgTtft) + 'ms' : ''}${m.tps ? ' · ' + m.tps.toFixed(1) + ' tok/s' : ''}</div>
        </div>
        <div class="fields">
          <span class="pill tabular">${rate.toFixed(1)}%</span>
        </div>
      `;
      container.appendChild(row);
    });
  }

  function renderBreakdownProviders(container, usage) {
    const raw = usage?.providers;
    let list = [];
    if (raw && typeof raw === 'object') {
      list = Object.entries(raw).map(([k, s]) => ({
        name: k,
        requests: s.requests || 0,
        successes: s.successes || (s.requests - (s.failed || 0)),
        inTokens: s.in_tokens || 0,
        outTokens: s.out_tokens || 0,
        cacheRead: s.cache_read_tokens || 0,
        cacheHitRate: s.cache_hit_rate || 0,
        avgTtft: s.avg_ttft_ms || 0,
        tps: s.tps || 0,
      }));
    }

    if (list.length === 0) {
      renderEmptyRow(container, '当前周期暂无供应商用量记录');
      return;
    }

    list.sort((a, b) => b.requests - a.requests);

    list.forEach((p) => {
      const totalT = p.inTokens + p.outTokens + p.cacheRead;
      const rate = p.requests > 0 ? (p.successes / p.requests) * 100 : 0;
      const icoHtml = window.renderBrandIcon ? window.renderBrandIcon(p.name) : '';

      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="dot ${rate >= 99 ? 'dot--ok' : rate >= 90 ? 'dot--warn' : 'dot--err'}"></span>
        ${icoHtml}
        <div class="who">
          <div class="name">
            <span>${escapeHtml(p.name)}</span>
            <span class="pill">${p.requests.toLocaleString()} 次</span>
            <span class="pill pill--accent">${fmtN(totalT)} tok</span>
          </div>
          <div class="sub">成功率: ${rate.toFixed(1)}% · 缓存命中: ${(p.cacheHitRate * 100).toFixed(1)}%${p.avgTtft ? ' · TTFT ' + Math.round(p.avgTtft) + 'ms' : ''}${p.tps ? ' · ' + p.tps.toFixed(1) + ' tok/s' : ''}</div>
        </div>
        <div class="fields">
          <span class="pill tabular">${rate.toFixed(1)}%</span>
        </div>
      `;
      container.appendChild(row);
    });
  }

  function renderBreakdownKeys(container, usage) {
    const list = usage?.keys || [];
    if (list.length === 0) {
      renderEmptyRow(container, '当前周期暂无密钥用量记录');
      return;
    }

    list.sort((a, b) => b.requests - a.requests);

    list.forEach((k) => {
      const totalT = (k.in_tokens || 0) + (k.out_tokens || 0) + (k.cache_read_tokens || 0);
      const reqs = k.requests || 0;
      const succ = k.successes || (reqs - (k.failed || 0));
      const rate = reqs > 0 ? (succ / reqs) * 100 : 0;
      const icoHtml = window.renderBrandIcon ? window.renderBrandIcon(k.provider) : '';

      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="dot ${rate >= 99 ? 'dot--ok' : rate >= 90 ? 'dot--warn' : 'dot--err'}"></span>
        ${icoHtml}
        <div class="who">
          <div class="name">
            <span>${escapeHtml(k.provider)} / ${escapeHtml(k.key_id)}</span>
            <span class="pill">${reqs.toLocaleString()} 次</span>
            <span class="pill pill--accent">${fmtN(totalT)} tok</span>
          </div>
          <div class="sub">成功率: ${rate.toFixed(1)}%${k.avg_ttft_ms ? ' · TTFT ' + Math.round(k.avg_ttft_ms) + 'ms' : ''}${k.tps ? ' · ' + k.tps.toFixed(1) + ' tok/s' : ''}</div>
        </div>
        <div class="fields">
          <span class="pill tabular">${rate.toFixed(1)}%</span>
        </div>
      `;
      container.appendChild(row);
    });
  }

  function renderEmptyRow(container, text) {
    const emptyRow = document.createElement('div');
    emptyRow.className = 'row text-muted';
    emptyRow.textContent = text;
    container.appendChild(emptyRow);
  }

  // Waterfall and Trace Details Inspector (M8, M12)
  function buildTraceWaterfall(trace) {
    const wrap = document.createElement('div');
    wrap.className = 'trace-waterfall-wrap';

    const ownMs = trace.own_ms || 0;
    const queuedMs = trace.queued_ms || 0;
    const sentMs = trace.sent_ms || 0;
    const ttftMs = trace.ttft_ms || 0;
    const flowMs = trace.flow_ms || 0;
    const retriedMs = trace.retried_ms || 0;
    const totalMs = trace.total_ms || (ownMs + queuedMs + sentMs + ttftMs + flowMs + retriedMs);

    wrap.innerHTML = `
      <div class="waterfall-metrics">
        <div class="wf-item"><span class="wf-label">网关内部开销:</span> <span class="tabular">${ownMs}ms</span></div>
        <div class="wf-item"><span class="wf-label">并发排队:</span> <span class="tabular">${queuedMs}ms</span></div>
        <div class="wf-item"><span class="wf-label">上游建连:</span> <span class="tabular">${sentMs}ms</span></div>
        <div class="wf-item"><span class="wf-label">首字到达 (TTFT):</span> <span class="tabular">${ttftMs}ms</span></div>
        <div class="wf-item"><span class="wf-label">流生成 (Flow):</span> <span class="tabular">${flowMs}ms</span></div>
        ${retriedMs > 0 ? `<div class="wf-item"><span class="wf-label text-danger">重试耗时:</span> <span class="tabular text-danger">${retriedMs}ms</span></div>` : ''}
        <div class="wf-item wf-item--total"><span class="wf-label">总延迟:</span> <span class="tabular"><strong>${totalMs}ms</strong></span></div>
      </div>

      <div class="mt-3">
        <div class="form-label mb-1">上游重试与路由跳跃 (Tries / Hops):</div>
        <div class="tries-list" id="trace_tries_${trace.id}"></div>
      </div>

      <div class="mt-3 trace-headers-grid">
        ${renderScrubbedHeaders('客户端脱敏请求头 (Request Headers)', trace.req_headers)}
        ${renderScrubbedHeaders('上游响应头 (Response Headers)', trace.tries?.[0]?.resp_headers)}
      </div>
    `;

    const triesList = wrap.querySelector(`#trace_tries_${trace.id}`);
    const tries = trace.tries || [];
    if (tries.length === 0) {
      const none = document.createElement('div');
      none.className = 'text-muted text-sm';
      none.textContent = '单次直连成功，无重试记录';
      triesList.appendChild(none);
    } else {
      tries.forEach((tr) => {
        const trRow = document.createElement('div');
        trRow.className = 'try-row';
        const isOk = tr.status >= 200 && tr.status < 300;
        const brandIco = window.renderBrandIcon ? window.renderBrandIcon(tr.provider) : '';
        trRow.innerHTML = `
          <span class="dot ${isOk ? 'dot--ok' : 'dot--err'}"></span>
          ${brandIco}
          <div class="flex-1">
            <div>
              <strong>Hop #${tr.attempt}</strong>:
              <span>${escapeHtml(tr.provider)} / ${escapeHtml(tr.key_id)}</span>
              <span class="pill ${isOk ? 'pill--green' : 'pill--red'}">HTTP ${tr.status}</span>
              <span class="tabular">(${tr.ms}ms${tr.ttft_ms ? ', TTFT ' + tr.ttft_ms + 'ms' : ''})</span>
              ${tr.cooldown_applied_sec ? `<span class="pill pill--amber">触发冷却 ${tr.cooldown_applied_sec}s</span>` : ''}
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
    renderStackedBarChart,
    renderHeatmap,
    renderBreakdown,
    buildTraceWaterfall,
  };
})();
