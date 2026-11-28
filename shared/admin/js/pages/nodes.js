// nodes.js — 节点页（Hub 落地页）：节点列表（listRow）+ 节点详情 / 添加节点弹框 +
// 一次性安装命令弹框 + 节点轮询。原「行内展开编辑器」迁移为弹框（v2 §4.2）：
// 列表行只由 listRow() 生成、没有展开态；一次性材料（安装命令 / 轮换后的
// Token / 后台密码）只在独立弹框里显示一次。签发表单的 scope 勾选组支撑函数
// （mountIssueScopeLists 一族）按工作包要求原样保留。

  // —— 权限范围选项 ——
  // 签发表单的「权限范围勾选组」支撑函数（renderScopeCheckboxGroup 一族）随行内
  // 展开编辑器一并退役：v2 里节点表单迁入弹框，范围用芯片（buildChip）呈现，
  // 草稿持久化改由 nodeCreateDraft + mountNodeScopeChips 承担。
  function templateScopeOptions() {
    return {
      providers: Object.keys(state.config?.providers || {}).sort(),
      models: Object.keys(state.config?.agent_models || {}).sort(),
    };
  }

  // --- 会话内存 ---
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
  // 「添加节点」弹框草稿：关闭（取消 / Esc / 遮罩）不清草稿，重开时带回 ——
  // 操作者刚敲的字不因为误关而丢（保存成功后才清空）。
  const nodeCreateDraft = { name: '', role: 'full', leaseHours: '', graceHours: '', providers: ['*'], models: ['*'] };
  // 节点弹框状态：create（添加节点）与 edit（节点详情）共用同一个 .dialog。
  // suspended = 安装命令弹框临时盖在详情弹框上（hide 不重建，关闭后原样恢复）。
  const nodeDialogState = { open: false, mode: '', nodeId: '', dirty: false, suspended: false };
  // 弹框内的范围芯片草稿：全部（*）或具体清单；保存时写回 scope。
  const nodeScopeDraft = { role: 'full', provAll: true, provs: [], modelAll: true, models: [] };
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

  // --- 一次性安装命令弹框 ---
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
    // 签发 / 轮换响应里的一次性材料（新 Token、环境变量）放在命令面板上方。
    mountNodeOnceMaterial($('nodeInstallOnceMaterial'), material);
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
    // 节点详情弹框还开着时先挂起（hidden，不重建内容）：弹框不嵌套，安装命令
    // 弹框关掉后原样恢复，未保存的修改也不丢。
    if (nodeDialogState.open && !nodeDialogState.suspended) {
      nodeDialogState.suspended = true;
      const editDlg = $('nodeEditDialog');
      if (editDlg) closeDialog(editDlg);
    }
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
    // 恢复被挂起的节点详情弹框（内容与未保存修改都还在 DOM 上）。
    if (nodeDialogState.suspended) {
      nodeDialogState.suspended = false;
      const editDlg = $('nodeEditDialog');
      if (editDlg) openDialog(editDlg);
    }
  }

  // 签发 / 轮换响应里的一次性材料：新 NODE_TOKEN 与启动环境变量（各自可复制）。
  function mountNodeOnceMaterial(host, material) {
    if (!host) return;
    const token = String(material?.node_token || '');
    const env = String(material?.bootstrap_env || '');
    if (!token && !env) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = `<div class="form-2col">${[
      token ? `<label>新 NODE_TOKEN</label><div class="input-row"><input class="input input--code" readonly value="${eh(token)}"><button class="btn btn--sm" type="button" data-once-copy="token">复制</button></div>` : '',
      env ? `<label>启动环境变量</label><div class="input-row"><input class="input input--code" readonly value="${eh(env)}"><button class="btn btn--sm" type="button" data-once-copy="env">复制</button></div>` : '',
    ].filter(Boolean).join('')}</div>`;
    host.querySelectorAll('[data-once-copy]').forEach((btn) => {
      clk(btn, () => copyToClipboard(btn.getAttribute('data-once-copy') === 'token' ? token : env, '已复制'));
    });
  }

  // --- Node credentials (read-only GET: viewing must never rotate the token) ---
  const CRED_PASS_MASK = '●●●●●●●●●●●●';
  const NODE_DETAIL_SECRET_LABELS = { node_token: '节点 Token', client_key: '客户端密钥', admin_password: '后台登录密码' };

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

  // --- 节点列表 ---
  // 状态词与圆点（v2 列表行：状态 = .dot + 一个词）：
  // 在线 / 离线 / 宽限期内 / 待安装 / 已吊销。在线窗口与中枢概览一致（15 分钟）。
  function nodeStatusWord(node) {
    if (!node || node.enabled === false) return { word: '已吊销', dot: 'err' };
    const snap = getNodeSyncSnapshotStatus(node);
    const ONLINE_MS = 15 * 60 * 1000;
    if (!snap.syncMs) return { word: '待安装', dot: 'off' };
    if (Date.now() - snap.syncMs <= ONLINE_MS) return { word: '在线', dot: 'ok' };
    if (snap.key === 'grace') return { word: '宽限期内', dot: 'warn' };
    return { word: '离线', dot: 'warn' };
  }

  // 行次要信息：角色 · 最近 IP · 最近同步（相对时间，全部经 fmtTime）。
  // 已吊销行以「<日期> 已吊销」收尾，不再堆 IP。
  function nodeSubText(node) {
    const parts = [node.role === 'lite' ? 'Lite' : 'Full'];
    if (node.enabled === false) {
      const t = fmtTime(node.last_seen);
      parts.push(t ? `${t} 已吊销` : '已吊销');
      return parts.join(' · ');
    }
    if (node.last_ip) parts.push(node.last_ip);
    const t = fmtTime(node.last_seen);
    parts.push(t ? `${t}同步` : '从未同步');
    return parts.join(' · ');
  }

  function renderNodesList() {
    const container = $('nodesList');
    if (!container) return;
    container.innerHTML = '';
    const nodes = state.nodes || [];

    // 页头灰色计数摘要（「4 个 · 2 在线」）。
    let onlineCount = 0;
    for (const n of nodes) {
      if (nodeStatusWord(n).word === '在线') onlineCount++;
    }
    const countEl = $('nodesCount');
    if (countEl) countEl.textContent = nodes.length ? `${nodes.length} 个 · ${onlineCount} 在线` : '';

    if (nodes.length === 0) {
      // 空状态 = 一句话 + 一个主按钮（v2 §4.4）。
      const empty = ce('div');
      empty.className = 'card-pad';
      const msg = ce('p');
      msg.className = 'text-muted';
      msg.textContent = '还没有节点：添加一个节点，它会从中枢拉取供应商与模型路由，并在同步时上报用量';
      empty.appendChild(msg);
      if (!state.creatingNode) {
        const btn = ce('button');
        btn.type = 'button';
        // 页头已有唯一的「添加节点」主按钮；空状态这里用普通按钮（v2 §4.3）。
        btn.className = 'btn mt-3';
        btn.textContent = '添加节点';
        clk(btn, () => {
          state.creatingNode = true;
          renderNodesList();
        });
        empty.appendChild(btn);
      }
      container.appendChild(empty);
    } else {
      for (const node of nodes) {
        const st = nodeStatusWord(node);
        const syncCount = Number(node.sync_count || 0);
        container.appendChild(listRow({
          title: eh(node.name || node.id),
          sub: eh(nodeSubText(node)),
          status: { dot: st.dot, label: st.word },
          count: syncCount > 0 ? `${syncCount} 次同步` : '—',
          onOpen: () => openNodeDetail(node.id),
        }));
      }
    }

    // 页头「添加节点」（overview.js 全局接线：翻转 state.creatingNode 后重绘列表）
    // 与创建弹框互相同步：flag 开 → 弹框开；flag 关 → 弹框关（有改动先确认）。
    syncNodeCreateDialog();
  }

  // Node list auto-refresh: the promised UX is "install succeeds → the row turns
  // online", and a node's only signal is its periodic config sync (last_seen).
  // 15s mirrors the hub overview's online threshold granularity. 统计页（stats）
  // 与节点列表共用这一路轮询：节点上报变了，两处一起刷新。
  function startNodesPolling() {
    if (state.nodesTimer) clearInterval(state.nodesTimer);
    if (!window.HOST.capabilities.nodeManager) return;
    state.nodesTimer = setInterval(async () => {
      if (document.visibilityState === 'hidden' || !window.HOST.getToken()) return;
      if (state.activeTab !== 'nodes' && state.activeTab !== 'stats') return;
      // Skip while the install dialog is open: re-rendering under it is fine,
      // but a failed refresh behind the modal silently resets the editor state.
      if (!$('nodeInstallOverlay')?.hidden) return;
      // 节点弹框（详情 / 添加）开着时不动列表：改到一半的数据不能被轮询冲掉。
      if (nodeDialogState.open) return;
      try {
        const res = await window.HOST.getNodes();
        if (res && res.ok) {
          state.nodes = res.nodes || [];
          renderNodesList();
          if (state.activeTab === 'stats') renderStatsView();
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

  // --- 节点详情 / 添加节点弹框（组件 6 · .dialog） ---
  // 租约以小时呈现（效果图口径），下发到节点的配置仍以秒存储。
  function nodeHoursFromSeconds(sec) {
    const s = Number(sec) || 0;
    if (!s) return '';
    return String(Math.round((s / 3600) * 10) / 10);
  }

  function nodeHoursToSeconds(val, defHours) {
    const n = Number(String(val ?? '').trim());
    const h = n > 0 ? n : defHours;
    return Math.max(1, Math.round(h * 3600));
  }

  function scopeToDraft(list) {
    const arr = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!arr.length || arr.includes('*')) return { all: true, items: [] };
    return { all: false, items: arr.slice() };
  }

  function initNodeScopeDraft(node, mode) {
    const d = mode === 'create'
      ? { prov: scopeToDraft(nodeCreateDraft.providers), model: scopeToDraft(nodeCreateDraft.models), role: nodeCreateDraft.role || 'full' }
      : { prov: scopeToDraft(node?.scope?.providers), model: scopeToDraft(node?.scope?.models), role: node?.role === 'lite' ? 'lite' : 'full' };
    nodeScopeDraft.role = d.role;
    nodeScopeDraft.provAll = d.prov.all;
    nodeScopeDraft.provs = d.prov.items;
    nodeScopeDraft.modelAll = d.model.all;
    nodeScopeDraft.models = d.model.items;
  }

  function collectNodeScope(kind) {
    const isProv = kind === 'providers';
    const allOn = isProv ? nodeScopeDraft.provAll : nodeScopeDraft.modelAll;
    if (allOn) return ['*'];
    return (isProv ? nodeScopeDraft.provs : nodeScopeDraft.models).slice();
  }

  // 范围芯片（组件 · 芯片）：「全部」= * 全量；点具体项即从「全部」切到指定清单。
  function mountNodeScopeChips(hostId, kind) {
    const host = $(hostId);
    if (!host) return;
    const isProv = kind === 'providers';
    const allOn = isProv ? nodeScopeDraft.provAll : nodeScopeDraft.modelAll;
    const items = isProv ? nodeScopeDraft.provs : nodeScopeDraft.models;
    host.innerHTML = '';
    host.appendChild(buildChip({
      label: '全部',
      on: allOn,
      title: `允许全部${isProv ? '供应商' : '模型'}（* 全量下发）`,
      onClick: (next) => {
        if (isProv) nodeScopeDraft.provAll = next;
        else nodeScopeDraft.modelAll = next;
        mountNodeScopeChips(hostId, kind);
        markNodeDialogDirty();
      },
    }));
    const options = isProv ? templateScopeOptions().providers : templateScopeOptions().models;
    for (const opt of options) {
      host.appendChild(buildChip({
        label: opt,
        on: !allOn && items.includes(opt),
        onClick: (next) => {
          if (next && allOn) {
            // 「全部」亮着时点具体项 = 切到指定范围，点中的这一项作为起点。
            if (isProv) {
              nodeScopeDraft.provAll = false;
              nodeScopeDraft.provs = [opt];
            } else {
              nodeScopeDraft.modelAll = false;
              nodeScopeDraft.models = [opt];
            }
          } else if (isProv) {
            nodeScopeDraft.provs = next
              ? [...new Set([...nodeScopeDraft.provs, opt])]
              : nodeScopeDraft.provs.filter((v) => v !== opt);
          } else {
            nodeScopeDraft.models = next
              ? [...new Set([...nodeScopeDraft.models, opt])]
              : nodeScopeDraft.models.filter((v) => v !== opt);
          }
          mountNodeScopeChips(hostId, kind);
          markNodeDialogDirty();
        },
      }));
    }
  }

  // 节点最近生效的配置版本 vs 中枢当前版本（都是后端已有字段）。
  function nodeConfigVersionText(node) {
    const v = Number(node?.last_config_version) || 0;
    if (!v) return '—';
    const hubV = Number(state.config?._version) || 0;
    return hubV && v >= hubV ? `#${v}（最新）` : `#${v}（中枢 #${hubV}）`;
  }

  function markNodeDialogDirty() {
    nodeDialogState.dirty = true;
  }

  function currentNodeFromDialog() {
    return (state.nodes || []).find((n) => n.id === nodeDialogState.nodeId) || null;
  }

  // 弹框主体：create = 表单字段；edit = 表单字段 + 运行状态只读区。
  function buildNodeDialogBody(node, mode) {
    const body = $('nodeEditBody');
    if (!body) return;
    const isCreate = mode === 'create';
    const id = node?.id || '';
    const role = nodeScopeDraft.role;

    const titleEl = $('nodeEditTitle');
    const statusEl = $('nodeEditStatus');
    if (titleEl) titleEl.textContent = isCreate ? '添加节点' : (node.name || node.id);
    if (statusEl) {
      if (isCreate) {
        statusEl.hidden = true;
        statusEl.innerHTML = '';
      } else {
        const st = nodeStatusWord(node);
        statusEl.hidden = false;
        statusEl.innerHTML = `<span class="dot ${st.dot}" aria-hidden="true"></span><span>${eh(st.word)}</span>`;
      }
    }
    const saveBtn = $('btnNodeEditSave');
    if (saveBtn) saveBtn.textContent = isCreate ? '添加节点' : '保存';
    const installBtn = $('btnNodeInstallCmd');
    const rotateBtn = $('btnNodeRotateTok');
    if (installBtn) installBtn.hidden = isCreate;
    if (rotateBtn) rotateBtn.hidden = isCreate;

    const leaseHours = isCreate ? (nodeCreateDraft.leaseHours || '') : nodeHoursFromSeconds(node.lease_ttl);
    const graceHours = isCreate ? (nodeCreateDraft.graceHours || '') : nodeHoursFromSeconds(node.grace_ttl);
    const nameVal = isCreate ? (nodeCreateDraft.name || '') : (node.name || '');

    const rows = [
      `<label>名称</label><div><input class="input" id="nodeEditName" value="${eh(nameVal)}" placeholder="例如 hk-edge-01"></div>`,
      `<label>角色</label><div class="seg" data-node-role-seg>${[
        ['lite', 'Lite · 纯内存代理'],
        ['full', 'Full · 带控制台'],
      ].map(([v, lbl]) => `<button class="seg-btn${role === v ? ' active' : ''}" data-node-role="${v}" type="button">${lbl}</button>`).join('')}</div>`,
      `<label>租约${fieldHint('单位小时；节点配置里仍以秒存储（24 小时 = 86400 秒）')}</label><div class="input-row"><input class="input tabular" id="nodeEditLease" type="number" min="0.5" step="any" value="${eh(leaseHours)}" placeholder="24"><span class="text-xs text-muted">小时，宽限</span><input class="input tabular" id="nodeEditGrace" type="number" min="0.5" step="any" value="${eh(graceHours)}" placeholder="1"><span class="text-xs text-muted">小时</span></div>`,
      `<label>供应商范围</label><div class="fields" id="nodeEditProvChips"></div>`,
      `<label>模型范围</label><div class="fields" id="nodeEditModelChips"></div>`,
    ];

    if (isCreate) {
      body.innerHTML = rows.join('');
    } else {
      // 凭据行：掩码默认，显示 / 复制走只读凭据接口的内存缓存。
      const secretRow = (key, label, emptyNote) => `<label>${label}</label><div class="input-row"><span class="who sub tabular" data-detail-secret="${key}" data-detail-empty="${eh(emptyNote)}">${CRED_PASS_MASK}</span><button class="btn btn--sm" type="button" data-detail-eye="${key}" aria-pressed="false">显示</button><button class="btn btn--sm" type="button" data-detail-copy="${key}">复制</button></div>`;
      const syncAgo = node.last_seen ? fmtTime(node.last_seen) : '';
      const syncWord = syncAgo ? `${syncAgo}同步` : '从未同步';
      rows.push(
        `<div class="dlg-secline section-bar"><span>运行状态</span><span class="text-xs text-muted">${eh(syncWord)}</span></div>`,
        `<label>节点 ID</label><div><span class="tabular">${eh(node.id)}</span></div>`,
        `<label>同步</label><div><span class="tabular">${Number(node.sync_count || 0)} 次 · ${eh(syncWord)}</span></div>`,
        `<label>配置版本</label><div><span class="tabular">${eh(nodeConfigVersionText(node))}</span></div>`,
        `<label>最近 IP</label><div><span class="tabular">${eh(node.last_ip || '—')}</span></div>`,
        secretRow('node_token', '节点 Token', '未保存明文（旧版本节点，轮换后可回看）'),
        secretRow('client_key', '客户端密钥', 'Hub 未配置主客户端密钥'),
      );
      if ((node.role || 'lite') !== 'lite') {
        rows.push(secretRow('admin_password', '后台密码', '该节点未存有后台密码'));
      }
      rows.push(`<label>常用模型</label><div id="node_model_usage_${eh(id)}"></div>`);
      body.innerHTML = rows.join('');
    }

    mountNodeScopeChips('nodeEditProvChips', 'providers');
    mountNodeScopeChips('nodeEditModelChips', 'models');

    body.querySelectorAll('[data-node-role]').forEach((btn) => {
      clk(btn, () => {
        nodeScopeDraft.role = btn.getAttribute('data-node-role') || 'full';
        body.querySelectorAll('[data-node-role]').forEach((b) => b.classList.toggle('active', b === btn));
        markNodeDialogDirty();
      });
    });

    // 底部左侧的危险动作（仅编辑态）：吊销 / 恢复 + 删除。
    const footLeft = $('nodeEditFootLeft');
    if (footLeft) {
      footLeft.innerHTML = '';
      if (!isCreate) {
        const revoked = node.enabled === false;
        const toggleBtn = ce('button');
        toggleBtn.type = 'button';
        toggleBtn.className = revoked ? 'btn' : 'btn btn--danger';
        toggleBtn.textContent = revoked ? '恢复' : '吊销';
        clk(toggleBtn, () => toggleNodeEnabled(node));
        footLeft.appendChild(toggleBtn);
        const delBtn = ce('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn--danger';
        delBtn.textContent = '删除';
        clk(delBtn, () => deleteNodeFromDialog(node));
        footLeft.appendChild(delBtn);
      }
    }

    if (!isCreate) {
      wireNodeDialogSecrets(node);
      renderNodeModelUsage(node, $(`node_model_usage_${id}`));
    }
  }

  // 弹框里的凭据行：凭据只在打开时读一次（只读接口，绝不轮换 Token），
  // 明文只留内存（state.nodeSecrets）；事件只在每次重建弹框主体时挂一次。
  function wireNodeDialogSecrets(node) {
    const id = node.id;
    const body = $('nodeEditBody');
    if (!body) return;
    const applySecrets = (secrets) => {
      const notes = (secrets && secrets.notes) || {};
      body.querySelectorAll('[data-detail-secret]').forEach((el) => {
        const key = el.getAttribute('data-detail-secret');
        const val = secrets ? String(secrets[key] || '') : '';
        const eye = body.querySelector(`[data-detail-eye="${key}"]`);
        const copy = body.querySelector(`[data-detail-copy="${key}"]`);
        if (!val) {
          el.textContent = notes[key] || el.getAttribute('data-detail-empty') || '未保存';
          if (eye) eye.hidden = true;
          if (copy) copy.hidden = true;
          return;
        }
        if (eye) eye.hidden = false;
        if (copy) copy.hidden = false;
        el.textContent = CRED_PASS_MASK;
      });
    };
    body.querySelectorAll('[data-detail-eye]').forEach((btn) => {
      clk(btn, () => {
        const key = btn.getAttribute('data-detail-eye');
        const valEl = body.querySelector(`[data-detail-secret="${key}"]`);
        const revealed = btn.getAttribute('aria-pressed') === 'true';
        const secrets = state.nodeSecrets[id];
        const val = secrets ? String(secrets[key] || '') : '';
        if (!val) return toast('该凭据暂不可回看', 'warn');
        if (valEl) valEl.textContent = revealed ? CRED_PASS_MASK : val;
        btn.setAttribute('aria-pressed', revealed ? 'false' : 'true');
        btn.innerHTML = `${window.uiIcon ? window.uiIcon(revealed ? 'eye' : 'eyeOff') : ''}<span>${revealed ? '显示' : '隐藏'}</span>`;
      });
    });
    body.querySelectorAll('[data-detail-copy]').forEach((btn) => {
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
        if (nodeDialogState.open && nodeDialogState.nodeId === id) applySecrets(secrets);
      }).catch(() => {});
    }
  }

  function openNodeEditDialog(mode, node) {
    const dlg = $('nodeEditDialog');
    if (!dlg) return;
    nodeDialogState.open = true;
    nodeDialogState.mode = mode;
    nodeDialogState.nodeId = node?.id || '';
    nodeDialogState.dirty = false;
    nodeDialogState.suspended = false;
    initNodeScopeDraft(node, mode);
    buildNodeDialogBody(node, mode);
    openDialog(dlg, { focus: 'nodeEditName' });
  }

  // 点列表行 → 详情弹框；同一时刻只允许一个节点弹框（创建开着就先关）。
  function openNodeDetail(nodeId) {
    const node = (state.nodes || []).find((n) => n.id === nodeId);
    if (!node) return;
    if (nodeDialogState.open) closeNodeEditDialog();
    state.creatingNode = false;
    openNodeEditDialog('edit', node);
  }

  async function requestCloseNodeEditDialog() {
    if (!nodeDialogState.open || nodeDialogState.suspended) return;
    if (nodeDialogState.dirty) {
      const ok = await confirmDialog({
        title: '放弃未保存的更改？',
        message: '当前弹框里有尚未保存的修改，关闭后将丢弃。',
        confirmText: '放弃更改',
        cancelText: '继续编辑',
        danger: false,
      });
      if (!ok) {
        // 用户选择继续编辑：把页头按钮的创建状态拨回来，保持 flag 与弹框一致。
        if (nodeDialogState.mode === 'create') state.creatingNode = true;
        return;
      }
    }
    closeNodeEditDialog();
  }

  function closeNodeEditDialog() {
    const dlg = $('nodeEditDialog');
    nodeDialogState.open = false;
    nodeDialogState.suspended = false;
    if (nodeDialogState.mode === 'create') state.creatingNode = false;
    nodeDialogState.mode = '';
    nodeDialogState.nodeId = '';
    nodeDialogState.dirty = false;
    if (dlg) closeDialog(dlg);
    renderNodesList();
  }

  // 「添加节点」弹框与 state.creatingNode 的同步（页头按钮 / 空状态按钮都汇到这里）。
  function syncNodeCreateDialog() {
    const wantOpen = Boolean(state.creatingNode);
    const isOpen = nodeDialogState.open && nodeDialogState.mode === 'create';
    if (wantOpen && !isOpen) openNodeEditDialog('create', null);
    else if (!wantOpen && isOpen) requestCloseNodeEditDialog();
  }

  async function saveNodeEditDialog() {
    if (!nodeDialogState.open || nodeDialogState.suspended) return;
    const isCreate = nodeDialogState.mode === 'create';
    const nameEl = $('nodeEditName');
    const name = (nameEl?.value || '').trim();
    if (!name) {
      if (nameEl) nameEl.setAttribute('aria-invalid', 'true');
      return toast('请输入节点名称', 'warn');
    }
    if (nameEl) nameEl.removeAttribute('aria-invalid');

    const scope = {
      providers: collectNodeScope('providers'),
      models: collectNodeScope('models'),
    };
    const leaseTtl = nodeHoursToSeconds($('nodeEditLease')?.value, 24);
    const graceTtl = nodeHoursToSeconds($('nodeEditGrace')?.value, 1);

    if (isCreate) {
      try {
        const res = await window.HOST.issueNode({ name, role: nodeScopeDraft.role, lease_ttl: leaseTtl, grace_ttl: graceTtl, scope });
        if (!res || !res.ok) return toast((res && res.error) || '添加失败', 'err');
        toast('节点已添加，请在安装命令弹框里完成部署', 'ok');
        nodeCreateDraft.name = '';
        nodeCreateDraft.role = 'full';
        nodeCreateDraft.leaseHours = '';
        nodeCreateDraft.graceHours = '';
        nodeCreateDraft.providers = ['*'];
        nodeCreateDraft.models = ['*'];
        const newId = res.node?.id || '';
        if (newId && res.node_token) nodeTokenMem.set(newId, res);
        closeNodeEditDialog();
        await loadNodesData();
        // 一次性材料（安装命令 / 新 Token / 后台密码）只此一次：独立弹框显示。
        if (newId) openNodeInstallOverlay(newId, res, {});
      } catch (e) {
        toast(scrubUiText(e.message), 'err');
      }
      return;
    }

    const id = nodeDialogState.nodeId;
    const node = currentNodeFromDialog();
    const tmplOpts = templateScopeOptions();
    if (node) {
      // 已不在当前选项里的旧 scope 项（供应商 / 模型被删）不能悄悄丢：原样保留。
      if (!nodeScopeDraft.provAll) {
        scope.providers = [...new Set([...staleScopeEntries(node.scope?.providers, tmplOpts.providers), ...scope.providers])];
      }
      if (!nodeScopeDraft.modelAll) {
        scope.models = [...new Set([...staleScopeEntries(node.scope?.models, tmplOpts.models), ...scope.models])];
      }
    }
    try {
      const res = await window.HOST.patchNode(id, { name, role: nodeScopeDraft.role, lease_ttl: leaseTtl, grace_ttl: graceTtl, scope });
      if (res && res.ok) {
        toast('节点配置更新成功', 'ok');
        closeNodeEditDialog();
        await loadNodesData();
      } else {
        toast((res && res.error) || '更新失败', 'err');
      }
    } catch (e) {
      toast(scrubUiText(e.message), 'err');
    }
  }

  // 吊销 / 恢复：确认后 patchNode，弹框就地在新状态上重绘。
  async function toggleNodeEnabled(node) {
    const enable = node.enabled === false;
    const ask = enable
      ? `恢复 ${node.name || node.id}？恢复后节点在下一次心跳 / 同步时重新校验 Token 并继续工作。`
      : `吊销 ${node.name || node.id}？吊销后该节点立即无法同步配置，节点侧会在鉴权失败后停服。`;
    const ok = await confirmDialog({
      title: enable ? '恢复节点' : '吊销节点',
      message: ask,
      confirmText: enable ? '恢复' : '吊销',
    });
    if (!ok) return;
    try {
      const res = await window.HOST.patchNode(node.id, { enabled: enable });
      if (res && res.ok) {
        toast(enable ? '节点已恢复' : '节点已吊销', 'ok');
        await loadNodesData();
        const fresh = (state.nodes || []).find((n) => n.id === node.id);
        if (fresh && nodeDialogState.open && nodeDialogState.nodeId === node.id && !nodeDialogState.suspended) {
          nodeDialogState.dirty = false;
          initNodeScopeDraft(fresh, 'edit');
          buildNodeDialogBody(fresh, 'edit');
        }
      } else {
        toast((res && res.error) || (enable ? '恢复节点失败' : '吊销节点失败'), 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function deleteNodeFromDialog(node) {
    const ok = await confirmDialog({
      title: '删除节点',
      message: `确认永久删除节点 ${node.name || node.id} 吗？`,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      const res = await window.HOST.deleteNode(node.id);
      if (res && res.ok) {
        toast('节点已删除', 'ok');
        // 明文凭据不比节点活得久：内存里的 Token / 后台密码一并清掉。
        nodeTokenMem.delete(node.id);
        nodeAdminPassMem.delete(node.id);
        delete state.nodeSecrets[node.id];
        closeNodeEditDialog();
        await loadNodesData();
      } else {
        toast((res && res.error) || '删除失败', 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // 安装命令：本页签缓存里还有 Token 就直接展示（不轮换）；没有则确认后轮换获取。
  async function reinstallNodeFromDialog(node) {
    const id = node.id;
    const cached = nodeTokenMem.get(id);
    if (cached && cached.node_token) {
      openNodeInstallOverlay(id, cached, { rotated: false, fromCache: true });
      return;
    }
    const ok = await confirmDialog({
      title: '重新获取安装命令',
      message: `安装命令包含节点 Token，出于安全仅在签发时显示一次。\n现在重新获取将轮换 ${node.name || node.id} 的 Token（旧 Token 立即失效），继续吗？`,
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
  }

  // 轮换 Token：旧 Token 立即失效，确认后轮换；结果以一次性命令展示在弹框里。
  async function rotateNodeFromDialog(node) {
    const ok = await confirmDialog({
      title: '轮换节点 Token',
      message: `轮换 ${node.name || node.id} 的 Token？\n旧 Token 立即失效，节点在更新 NODE_TOKEN 并重新同步前会一直鉴权失败。`,
      confirmText: '轮换',
    });
    if (!ok) return;
    try {
      const res = await window.HOST.rotateNode(node.id);
      if (!res || !res.ok || !res.node_token) {
        toast((res && res.error) || '轮换 Token 失败', 'err');
        return;
      }
      nodeTokenMem.set(node.id, res);
      openNodeInstallOverlay(node.id, res, { rotated: true });
      await loadNodesData();
      toast('Token 已轮换', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // Scope entries that no longer match the current template options (providers/models
  // deleted on the hub since the node was scoped) have no chip to render. Preserve
  // them on save: dropping them silently would narrow the node's scope without the
  // operator seeing or choosing it.
  function staleScopeEntries(scopeArr, options) {
    return [...new Set((Array.isArray(scopeArr) ? scopeArr : []).filter((v) => v !== '*' && !options.includes(v)))];
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

  // --- 弹框接线（静态按钮一次接好；主体每次打开重建） ---
  function setupNodeDialogs() {
    clk($('btnCloseNodeEdit'), () => requestCloseNodeEditDialog());
    clk($('btnNodeEditCancel'), () => requestCloseNodeEditDialog());
    clk($('btnNodeEditSave'), () => saveNodeEditDialog());
    clk($('btnNodeInstallCmd'), () => {
      const node = currentNodeFromDialog();
      if (node) reinstallNodeFromDialog(node);
    });
    clk($('btnNodeRotateTok'), () => {
      const node = currentNodeFromDialog();
      if (node) rotateNodeFromDialog(node);
    });
    clk($('btnCloseNodeInstallFoot'), () => closeNodeInstallOverlay());
    // 文本输入的脏检查走委托（弹框主体每次打开都重建，监听器挂在容器上）；
    // 芯片 / 分段的点击在各自 handler 里标脏。
    const body = $('nodeEditBody');
    if (body) {
      body.addEventListener('input', () => {
        nodeDialogState.dirty = true;
      });
    }
    // 遮罩点击走 closeDialogById → 这个 closer；Esc 在下面统一接管（有改动先确认）。
    registerDialog('nodeEditDialog', () => requestCloseNodeEditDialog());
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // 安装命令弹框开着：交给全局 Esc（closeNodeInstallOverlay 会恢复被挂起的详情弹框）。
      const install = $('nodeInstallOverlay');
      if (install && !install.hidden) return;
      // 确认框开着：全局 Esc 会把它当「取消」结掉，这里不抢。
      const confirmDlg = $('confirmDialog');
      if (confirmDlg && !confirmDlg.hidden) return;
      if (!nodeDialogState.open || nodeDialogState.suspended) return;
      e.preventDefault();
      e.stopPropagation();
      requestCloseNodeEditDialog();
    }, true);
  }

  window.addEventListener('DOMContentLoaded', setupNodeDialogs);
