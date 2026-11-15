# 外部 MCP 数据面接入 `llmproxy2` 控制面指南

> **适用对象**：需要复用 `llmproxy2` EdgeOne Hub 统一纳管上游 API Key、配置下发与节点认证的独立 MCP 服务项目（例如 `khcsearch` 搜索 MCP、未来的 `Image MCP` 等）。
> **定位边界**：`llmproxy2` EdgeOne Hub 仅作为**控制面**（集中托管密钥、作用域隔离、按需配置投影、可选节点状态拨测），**绝不代理数据面业务流量**；所有上游请求执行、连接测试（如 `/admin/providers/:id/test`）、Key 轮询/冷却均由各 MCP 数据面自行实现。

---

## 一、 总体接入架构

```text
┌─────────────────────────────────────────────┐
│  llmproxy2 · EdgeOne Hub (控制面 SSOT)      │
│  1. 管理后台托管各域密钥池 (如 search_providers)│
│  2. 签发 NODE_TOKEN，配置节点 scope / status_url│
│  3. POST /api/node/config (按需投影 + ETag 304) │
│  4. GET  /api/admin/nodes/:id/status (按需代理) │
└──────────────────┬──────────────────────────┘
                   │  HTTPS (Bearer stk_node_...)
                   ▼
┌─────────────────────────────────────────────┐
│  外部 MCP 服务 (数据面 · 独立仓库 / 独立部署)  │
│  1. 按需拉取配置并仅常驻内存 (Zero-Disk)      │
│  2. 收到 401 立即清空内存凭据并停止服务        │
│  3. 暴露 GET /node/status 供 Hub 按需拨测    │
└─────────────────────────────────────────────┘
```

---

## 二、 在 Hub 中创建 MCP 专属节点

1. 登录 `llmproxy2` Hub 管理控制台，进入 **「中转节点」** → **「+ 签发新节点」**。
2. 建议配置如下：
   - **节点角色**：选择 `lite`（极简无盘运行语义，可填入任意语义化名称如 `khcsearch-mcp-01`）。
   - **允许 LLM 供应商 / 允许 LLM 模型**：若该 MCP 不使用大模型 Key，填入 `[]`（表示不投影任何 `providers` / `agent_models`）。
   - **允许搜索提供商**（`scope.search_providers`）：填入 `*`（全量共享）或白名单 ID（如 `brave,tavily,jina`）。
   - **状态回调地址**（`status_url`，可选）：填写 MCP 对外可达的基础地址（如 `https://mcp.example.com` 或 `https://mcp.example.com/node/status`，仅支持 `http://` / `https://`）。
3. 签发完成后妥善保存一次性显示的明文 `NODE_TOKEN`（格式为 `stk_node_<48hex>`），注入 MCP 运行时环境变量。

> **安全提示**：Hub 使用 `HUB_ENCRYPT_KEY`（未配置时自动回退使用 `ADMIN_PASSWORD` 派生的 SHA-256 AES-256-GCM 密钥）加密保存 `node_token_enc`，仅供服务端按需请求 `status_url` 时使用；浏览器的 `/api/admin/nodes` 响应永远不会包含 `node_token_enc` 或 `token_sha256`。

---

## 三、 配置按需拉取契约（`POST /api/node/config`）

### 3.1 请求格式

- **方法与路径**：`POST <HUB_URL>/api/node/config`
- **认证头**：`Authorization: Bearer <NODE_TOKEN>`
- **条件缓存头**（推荐在租约到期或收到异常触发刷新时携带）：`If-None-Match: <上次响应的 ETag>`
- **可选请求体**（上报聚合计数）：
  ```json
  {
    "telemetry": {
      "requests": 120,
      "success": 118,
      "tokens": 0
    }
  }
  ```

### 3.2 响应状态与节点标准行为

| HTTP 状态码 | 含义 | 响应头 / 响应体 | MCP 节点必须执行的动作 |
|:---:|---|---|---|
| **`200 OK`** | 首次激活或配置/作用域已变化 | 响应头：`ETag`、`X-Config-Version`、`X-Lease-Until`、`X-Grace-Until`；响应体见下 | 原子替换内存配置快照，记录新 `ETag` 与租约到期时间 |
| **`304 Not Modified`** | 配置无变化（零载荷） | 响应头含最新 `ETag`、`X-Config-Version`、`X-Lease-Until`、`X-Grace-Until`；响应体 0 字节 | **保持当前内存配置**，仅延长本地租约（Lease）有效期 |
| **`401 Unauthorized`** | 节点已被吊销/停用，或 Token 已轮换/无效 | `{ "ok": false, "error": "node_revoked_or_invalid" }` | **立即清零/清空内存中的所有上游 Key 并停止对外提供服务** |

### 3.3 `200 OK` 响应体结构与 `search_*` 投影语义

```json
{
  "ok": true,
  "config_version": 12,
  "lease_ttl": 86400,
  "grace_ttl": 3600,
  "lease_until": 1763294400,
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
        "timeout_ms": 15000,
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
> 1. **忽略未知顶层字段**：未来接入新的业务域（如 `image_providers`）时，`payload` 会向后兼容增量新增字段；各 MCP 只读取自己所属域，必须忽略未知键。
> 2. **零泄露保证**：Hub 已在序列化前剔除所有 `origin === "local"` 的提供商与 Key、停用项（`enabled === false`）、无可用 Key 的草稿项（`api_keys: []`），以及不在 `node.scope.search_providers` 白名单内的项；`search_selection` 也已同步裁剪为仅保留实际下发的提供商（`fetch` 不符合条件时为空字符串 `""`）。
> 3. **声明式扩展字段**：若某 `search_providers` 条目配置了自定义 `quirks`、`request`、`response`、`fetch`（JSON 对象），Hub 会原样包含在对应条目中下发。

---

## 四、 节点状态按需回调契约（`GET <status_url>/node/status`）

当管理端需要查看 MCP 节点实时状态时，Hub 仅在管理员打开概览或点击「刷新」时发起**按需服务端代理请求**（KV 缓存 `15s`，请求超时 `4.5s`）：

1. **Hub 出站请求**：
   - 目标地址：`<status_url>/node/status`（若 `status_url` 已以 `/node/status` 结尾则直接请求该地址）
   - 请求头：`Authorization: Bearer <NODE_TOKEN>`、`Accept: application/json`
2. **MCP 端鉴权校验**：
   - 使用常量时间比较校验 `Bearer Token` 是否等于当前内存/环境变量持有的 `NODE_TOKEN`；不匹配返回 HTTP `401`。
3. **推荐返回 JSON 字段**（HTTP `200 OK`）：
   ```json
   {
     "version": "1.2.0",
     "uptime_sec": 3600,
     "search_count": 128,
     "crawl_count": 19,
     "resting_keys": [],
     "last_error": ""
   }
   ```
   - `uptime_sec`：进程运行时长（秒）
   - `search_count` / `requests_search`：搜索累计请求数
   - `crawl_count` / `requests_fetch`：抓取累计请求数
   - `resting_keys` / `resting_keys_count`：当前冷却/休眠中的 Key 列表或数量
   - `last_error`：最近一次异常摘要（**必须已脱敏，严禁包含任何 API Key 或 `NODE_TOKEN`**）

---

## 五、 运行时安全与合规红线

1. **禁止明文落盘**：不得将 `POST /api/node/config` 下发的 `api_keys` 写入本地配置文件、SQLite 或临时文件。
2. **禁止日志泄露**：所有异常栈、HTTP 报错日志必须对 `api_key`、`NODE_TOKEN`、`Authorization` 与 `?key=` 参数打码。
3. **测试能力隔离**：单 Key 连通性测试（如 `/admin/providers/:id/test`）由 MCP 数据面本地提供，不得请求 Hub 代发上游查询。

---

## 六、 跨项目需求与迭代协作方式

为保证 `llmproxy2` 控制面的 EdgeOne 产物体积门禁（静态产物 `<= 245,760` B、`edge-functions/` gzip `<= 45,000` B）、Web Standard 纯净度及 G1~G6 发布门禁稳定，**跨项目采用“契约/需求先行，各仓库独立实现发版”**：

1. **提出新需求（如后续接入 Image MCP）**：
   - 由业务 MCP 侧在 `llmproxy2` 提交 **GitHub Issue**（或仅包含需求文档的 **Docs-only PR**），明确：
     1. 新增顶层配置域名称、字段 Schema 与校验规则；
     2. 是否需要全局 selection 策略及过滤逻辑；
     3. `node.scope` 权限字段名；
     4. 若复用 `/node/status`，需补充的运行时状态字段。
2. **控制面落地**：
   - `llmproxy2` 侧更新 [`shared/contracts/`](../shared/contracts/)、EdgeOne Hub 校验/投影/UI 与 `MCP_INTEGRATION_GUIDE.md`，并通过 `npm run verify:release`（G1~G6）全量门禁。
3. **独立发版**：
   - 控制面坚持向后兼容的增量字段演进，各 MCP 仓库按新契约独立开发与上线，双方无需锁步发版。
