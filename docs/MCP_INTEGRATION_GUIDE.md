# 外部 MCP 数据面接入 `llmproxy2` 控制面指南

> **适用对象**：需要复用 `llmproxy2` EdgeOne Hub 统一纳管上游 API Key、作用域配置与节点认证的独立 MCP 服务项目（例如运行 Playwright + Search 的 `khcsearch` Hugging Face Space、未来的 `Image MCP` 等）。
> **方案原则（严格单向 · 零心跳 · 零反向回调）**：`llmproxy2` EdgeOne Hub 作为唯一可写控制面后台，对外仅暴露 **`POST /api/node/config`** 供各 MCP 按需拉取配置；MCP 端无需暴露任何 UI、管理接口或反向状态回调端口，**双方均不跑后台定时心跳**。

---

## 一、 总体接入架构（严格单向拉取）

```text
┌──────────────────────────────────────────────────────────┐
│  llmproxy2 · EdgeOne Hub (唯一控制面 + Web UI)           │
│  1. 管理后台托管 search_providers 密钥池与选用策略        │
│  2. 控制台直接校验搜索 Key 连通性 (verify-search-key)    │
│  3. 签发 NODE_TOKEN，配置节点作用域 (scope)               │
│  4. POST /api/node/config (按需投影 + ETag 304 + Telemetry)│
└──────────────────────────▲───────────────────────────────┘
                           │  HTTPS 严格单向按需请求
                           │  (Bearer stk_node_... + optional telemetry)
┌──────────────────────────┴───────────────────────────────┐
│  外部 MCP 服务 (独立仓库 · 如 16G HF Space / Playwright)  │
│  1. 无后台定时心跳：仅在启动首用 / 租约到期时拉取配置      │
│  2. 拉取时顺便捎带脱敏 telemetry 快照                      │
│  3. 仅常驻内存 (Zero-Disk)，401 立即清空内存并停服         │
│  4. 零管理端、零反向回调端口（只保留 MCP 工具接入入口）    │
└──────────────────────────────────────────────────────────┘
```

---

## 二、 在 Hub 中创建 MCP 专属节点

1. 登录 `llmproxy2` Hub 管理控制台，进入 **「中转节点」** → **「签发新节点」**（扩展服务 Key 统一在 **「扩展服务」** 页签集中录入，LLM 模型提供商则在 **「模型供应商」** 独立管理）。
2. 建议配置如下：
   - **节点类型（`kind`）**：选择 **`MCP 扩展服务 (mcp)`**（UI 自动隐藏 LLM 角色/供应商/模型字段，并将 `scope.providers` / `scope.models` 锁为 `[]`，防止误把大模型 Key 下发给外部 Hugging Face Space）。
   - **服务类型（`service_type`）**：默认 `khc-search`（支持自定义小写字母/数字/连字符标识，方便后续扩展 `image-mcp` 等其它 MCP 服务）。
   - **租约时长（`lease_ttl`）**：选中 `mcp` 后默认 `600` 秒（推荐 `300`~`900` 秒；仍只在真实请求触发时按需续租、无后台心跳，可兼顾 telemetry 快照时效与 `304` 低开销）。
   - **搜索提供商**（`scope.search_providers`）：默认 `*`（全量共享）或填写白名单 ID（如 `brave,tavily,jina`）。
   - **MCP 接入地址（`mcp_url`，可选）**：填入 MCP 节点对外提供的 HTTP/HTTPS 地址（例如 `https://your-space.hf.space/mcp`，不含 URL 凭据）。填写后，控制台 **「扩展服务」** 页签会自动展示服务地址、暴露工具与 `mcpServers` 客户端配置示例。
   - **无 `status_url`**：单向架构下无需填写或暴露节点回调 URL；Hub「概览」中的节点状态严格按 `last_seen` 与 `lease_ttl`/`grace_ttl` 计算快照状态（`已同步` / `宽限期内` / `过期 / 离线` / `从未同步` / `已吊销`）。
3. 签发完成后复制 **「节点启动环境变量」**（`HUB_URL=... NODE_TOKEN=...`）或一次性明文 `NODE_TOKEN`（`stk_node_<48hex>`），写入外部 MCP 运行时 Secret / 环境变量（如 Hugging Face Space Secrets）。

> **凭据隔离说明**：Hub KV 仅保存 `NODE_TOKEN` 的单向 SHA-256 摘要（`token_sha256`）及前缀，浏览器与服务端均不保存也不反向解密任何 `node_token_enc`。

---

## 三、 按需拉取与顺带遥测契约（`POST /api/node/config`）

规范化 Schema 与标准样例见可执行契约文件：[`shared/contracts/mcp-node-contract.json`](../shared/contracts/mcp-node-contract.json)（G3 门禁测试强校验该文件与真实投影输出一致）。

### 3.1 何时调用（零心跳原则）

MCP 端 **禁止启动 `setInterval` / 后台轮询心跳**，仅在以下 3 类真实业务时机按需请求：

1. **冷启动 / 首次真实请求**（Lazy-once 加载内存快照）；
2. **收到真实业务请求且距离上次同步超过 `lease_ttl`**（携带 `If-None-Match` 续租：配置未变返回 `304`，零反序列化成本）；
3. **上游请求连续遇到鉴权失败**（怀疑管理员刚在 Hub 轮换过 Key，强制刷新一次，可加短冷却防抖如 `60s`）。

### 3.2 请求格式与 `telemetry` 顺带快照

- **方法与路径**：`POST <HUB_URL>/api/node/config`
- **认证头**：`Authorization: Bearer <NODE_TOKEN>`
- **条件缓存头**（续租时必带）：`If-None-Match: <上次 200/304 响应头 ETag>`
- **可选请求体**（每次发 `POST /api/node/config` 时顺便上报自上次同步以来的累计运行快照）：
  ```json
  {
    "telemetry": {
      "version": "1.2.0",
      "uptime_sec": 3600,
      "playwright_ready": true,
      "search_count": 42,
      "crawl_count": 7,
      "resting_keys": ["tavily:k2"],
      "resting_keys_count": 1,
      "last_error": ""
    }
  }
  ```
  - **严格脱敏**：`telemetry` 仅允许传状态摘要（版本号、运行时长、Playwright 就绪状态、累计 search/crawl 次数、休眠 Key 标签、脱敏错因），严禁附带任何明文 API Key 或 `NODE_TOKEN`。Hub 写入 KV 前也会自动经过 `scrubSecrets` 二次清洗。
  - **展示位置**：Hub 管理控制台「概览」页签直接渲染最近一次同步留下的 **「MCP 节点同步快照 (Telemetry)」**。

### 3.3 响应状态与节点标准动作

| HTTP 状态码 | 含义 | 响应头 / 响应体 | MCP 节点必须执行的动作 |
|:---:|---|---|---|
| **`200 OK`** | 首次激活或配置/作用域已变化 | 响应头：`ETag`、`X-Config-Version`、`X-Lease-Ttl`、`X-Grace-Ttl`、`Cache-Control`（兼容保留 `X-Lease-Until`、`X-Grace-Until`）；响应体含 `_version`、`etag`、`lease_ttl`、`grace_ttl`、`issued_at`、`payload`（兼容保留 `config_version`、`lease_until`） | 原子替换内存配置快照，记录 `etag` 与 `lease_ttl` |
| **`304 Not Modified`** | 配置无变化（零载荷） | 响应头含 `ETag`、`X-Config-Version`、`X-Lease-Ttl`、`X-Grace-Ttl`、`Cache-Control`（兼容保留 `X-Lease-Until`、`X-Grace-Until`）；响应体 0 字节 | 保持当前内存快照，仅依据 `X-Lease-Ttl`（或回退 `X-Lease-Until`）延长租约；所带 `telemetry` 若满足间隔将被记录 |
| **`401 Unauthorized`** | 节点已被吊销/停用，或 Token 已轮换 | `{ "ok": false, "error": "node_revoked_or_invalid" }` | **立即清空内存中的所有上游 Key 并拒绝后续工具调用** |

### 3.4 `200 OK` 响应体结构示例

```json
{
  "ok": true,
  "_version": 12,
  "config_version": 12,
  "etag": "\"abc123def456\"",
  "lease_ttl": 600,
  "grace_ttl": 3600,
  "lease_until": 1763294400,
  "issued_at": "2026-11-15T12:00:00.000Z",
  "payload": {
    "providers": {},
    "agent_models": {},
    "settings": {},
    "adapter_rules": {},
    "search_providers": {
      "brave": {
        "id": "brave",
        "name": "Brave Search",
        "enabled": true,
        "origin": "vault",
        "base_url": "https://api.search.brave.com",
        "capabilities": ["search"],
        "timeout_ms": 10000,
        "adapter": "brave",
        "api_keys": [
          {
            "id": "k1",
            "label": "k1",
            "key": "<真实明文 API Key>",
            "enabled": true,
            "origin": "vault"
          }
        ]
      }
    },
    "search_selection": {
      "search": ["brave"],
      "fetch": ""
    }
  }
}
```

> **消费端必须遵守的投影约定**：
> 1. **忽略未知字段**：未来接入新的业务域时 `payload` 只做增量追加；各 MCP 只消费所需域，必须忽略未知键。
> 2. **零泄露过滤**：Hub 序列化前已物理剔除 `origin === "local"` 的提供商与 Key、停用项（`enabled === false`）、无有效 Key 的草稿项，以及 `node.scope.search_providers` 白名单之外的条目；`search_selection` 同步裁剪至当前节点有权看到的可用条目。
> 3. **声明式扩展字段**：配置在 `search_providers` 下的 `quirks`、`request`、`response`、`fetch` 会随条目原样投影下发。

---

## 四、 Hub 侧搜索 Key 连通性测试（`POST /api/admin/verify-search-key`）

纯 HTTP 搜索服务（Brave / Tavily / Jina / Serper / Firecrawl / Exa 及自定义 `request`/`fetch` 声明式配置）的 Key 连通性校验**直接由 Hub 管理后台完成**，MCP 端无需暴露任何 `/admin/providers/:id/test` 接口：

- **鉴权**：仅接受管理员 `ADMIN_PASSWORD`，严禁节点 Token 调用；
- **SSRF 防护与最小探活**：内置适配器及自定义声明式 `request`/`fetch`（支持 `{{api_key}}` 与别名 `{{key}}`、`{{query}}`、`{{max_results}}`、`{{url}}` 模板插值）均强制经 `isSafePublicHttpUrl` 拦截私有网段、环回地址、链路本地与云厂商元数据 IP 后，仅发固定极小探测请求（如 `q=ping&count=1`），超时 `5000ms`；
- **脱敏与健康落库**：响应错误文本经 `scrubSecrets` 清洗，测试结果 (`valid`, `status`, `latency_ms`) 同步回写 KV `search_providers.<id>.api_keys`。

---

## 五、 跨项目协作机制与契约对齐

为避免双仓库锁定发布并确保 EdgeOne 体积与安全门禁长期受控，跨项目按以下流程协作：

1. **契约先行（Contract-as-Code）**：
   - 节点交互协议与 Schema 单一真值保存在 [`shared/contracts/mcp-node-contract.json`](../shared/contracts/mcp-node-contract.json)（含 `contract_version`、请求/响应字段约束与标准 Fixture 样例）。
   - 下游 MCP 仓库可直接消费或镜像校验该契约文件中的 `contract_version` 与 `sample_200_response`。
2. **变更提需求流程**：
   - 如未来新增业务域（例如 `image_providers`）或 `telemetry` 字段，MCP 侧在 `llmproxy2` 提交 **GitHub Issue**（或仅改文档的 **Docs-only PR**）列明字段名、投影过滤条件与 `scope` 权限字段；
   - `llmproxy2` 侧保持向后兼容的**纯增量演进**，更新契约 JSON、Hub 校验/投影/UI，并跑通 `npm run build:admin && npm run verify:release`（G1~G6 全绿）；只有存在破坏性变更时才递增 `contract_version`。
3. **双仓独立发版**：
   - `llmproxy2` 控制面领先上线新字段（旧版本 MCP 自动忽略未知键）；各 MCP 仓库在各自节奏下独立测试与部署即可，全程无需反向回调或人工对表。
