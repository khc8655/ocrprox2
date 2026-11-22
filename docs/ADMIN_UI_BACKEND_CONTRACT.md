# 前后端与节点通信契约规范 (Admin UI & Node Contract)

> **核心原则**：前端只有一份源码（`shared/admin/`），全面采用 [`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md) 定义的 **Magpie 极简列表+行内展开（Inline Editor）设计规范**；配置只有一份 Schema（`shared/config/settings.schema.json`），所有跨端接口由可执行契约文件（`shared/contracts/*.json`）与门禁测试 G3/G4 强力约束。

---

## 一、 三角色宿主适配器契约（`HOST.capabilities`）

`shared/admin/js/host.js` 将运行环境归纳为三种标准角色（`window.__HOST_KIND__`），前端严禁通过 URL 猜测环境，一律通过 `HOST.capabilities` 控制 UI 模块显隐（`data-cap="<capName>"`）：

| 能力位 (`HOST.capabilities`) | `hub` (EdgeOne Makers 中枢) | `full` (Go 完整节点) | `lite` (Go 极简节点 — 无 UI) | 说明 |
|---|:---:|:---:|:---:|---|
| `vaultHub` | `true` | `false` | — | 供应商与 Key 中枢管理、区分 `origin: vault/local` |
| `nodeManager` | `true` | `false` | — | **2代新增**：VM 节点的 Token 签发、Scope 配置、注销与 `last_seen` 状态查看 |
| `vaultClient` | `false` | `true` | — | Full 节点按需从 EdgeOne 中枢拉取供应商（整体拉取 / 按 Key 标签补拉）与路由模板；中枢托管字段不可本地改 |
| `kbModels` | `false` | `true` | — | KB 模式的 `chat`/`embedding`/`reranker`/`ocr` 四分类候选池管理 |
| `oauthLogin` | `false` | `true` | — | MiniMax Code Plan 等 OAuth 2.0 Device Flow 扫码授权与保活状态 |
| `usageAndTraces` | `false` | `true` | — | **借鉴 Magpie**：本地 `usage.jsonl` 周期统计聚合与最近 60 次请求 `Tries[]` 故障转移轨迹回放（EdgeOne 中枢不走流量，零统计负担） |
| `systemUpdate` | `false` | `true` | — | Full 节点二进制版本检查与平滑升级/重启 |

---

## 二、 EdgeOne 中枢节点管理 API 契约（`/api/admin/nodes`）

全部接口受 `ADMIN_PASSWORD` 保护：

### 2.1 获取节点列表 `GET /api/admin/nodes`
```json
{
  "ok": true,
  "nodes": [
    {
      "id": "node_hk_nat_01",
      "name": "香港 NAT 小鸡 01",
      "role": "lite",
      "enabled": true,
      "token_prefix": "stk_node_9f8e...",
      "lease_ttl": 86400,
      "grace_ttl": 3600,
      "scope": {
        "models": ["*"],
        "providers": ["minimax", "deepseek", "openrouter"]
      },
      "created_at": "2026-11-08T08:00:00Z",
      "last_seen": "2026-11-08T08:30:12Z",
      "last_ip": "203.0.113.77",
      "last_config_version": 137,
      "last_binary_version": "v20261108-01"
    }
  ]
}
```

### 2.2 签发新节点 `POST /api/admin/nodes`
- **Request**:
```json
{
  "name": "日本 NAT 极简节点",
  "role": "lite",
  "lease_ttl": 86400,
  "grace_ttl": 3600,
  "scope": {
    "models": ["claude-sonnet-4-20250514", "MiniMax-M2.5"],
    "providers": ["minimax", "openrouter"]
  }
}
```
- **Response (`200 OK`)**：返回一次性明文 `node_token`（后续查询不再返回明文，KV 仅存 `token_sha256`）、节点当前生效的客户端鉴权密钥 `client_key`、启动环境变量模板 `bootstrap_env` 以及直接可执行的一键安装命令 `install_command`：
```json
{
  "ok": true,
  "node": { "id": "node_jp_02", "name": "日本 NAT 极简节点", "enabled": true },
  "node_token": "stk_node_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a",
  "client_key": "sk-llmproxy-...",
  "bootstrap_env": "LLMPROXY_ROLE=lite LLMPROXY_HUB_URL=https://hub.example.com LLMPROXY_NODE_TOKEN=stk_node_9f8e... LLMPROXY_CLIENT_KEY=sk-llmproxy-...",
  "install_command": "curl -fsSL https://hub.example.com/install.sh | sudo bash -s -- --role=lite --hub-url=\"https://hub.example.com\" --node-token=\"stk_node_9f8e...\" --client-key=\"sk-llmproxy-...\" -p 8787 -y"
}
```

### 2.3 注销/吊销、恢复、轮换与删除节点
- **吊销/启用**：`PATCH /api/admin/nodes/:id` `{ "enabled": false, "scope": {...}, "lease_ttl": 3600 }`
- **轮换 Token**：`POST /api/admin/nodes/:id/rotate` → 生成新 `node_token`、`bootstrap_env` 与 `install_command`，旧 Token 立即失效。
- **重新获取安装命令**：`GET /api/admin/nodes/:id/install-command` → 返回与签发/轮换同构的部署材料（`node`（已脱敏）、`node_token`、`client_key`、`bootstrap_env`、`install_command`）；因 KV 仅存 `token_sha256`，内部即执行一次轮换，旧 Token 立即失效（响应带 `Cache-Control: no-store`；节点不存在返回 `404 {ok:false, error:"node_not_found"}`）。节点列表页每行的「安装」按钮即此契约：同一会话内复用内存缓存的 Token 免轮换，跨会话（页面刷新后）调用本端点轮换取新。路径匹配为精确三段（`/:id/install-command`），`/:id/rotate/install-command` 等畸形路径不触发轮换。
- **删除节点**：`DELETE /api/admin/nodes/:id` → 物理移除 KV 中的节点记录。

---

## 三、 节点按需配置投影契约（`POST /api/node/config`）

受 `NODE_TOKEN`（`Authorization: Bearer <NODE_TOKEN>`）保护，遵循零轮询、零心跳、严格单向被动响应原则：

| 场景 | 请求头 / 参数 | HTTP 状态码 | 响应头 | 响应体 | 节点侧标准动作 |
|---|---|---:|---|---|---|
| **首次激活拉取** | 无 `If-None-Match` | `200 OK` | `ETag`, `X-Config-Version`, `X-Lease-Until`, `X-Grace-Until` | `{ ok: true, config_version, lease_ttl, grace_ttl, lease_until, payload: { providers, agent_models, settings, adapter_rules } }` | 原子构建内存 `RuntimeSnapshot` 并开始服务 |
| **租约到期续租（配置未变）** | `If-None-Match: "<etag>"` 与当前版本一致 | `304 Not Modified` | `ETag`, `X-Config-Version`, `X-Lease-Until`, `X-Grace-Until` | **空（0 字节）** | 零反序列化开销，直接更新内存 `lease_until` 与 `grace_until` |
| **租约到期续租（配置已变）** | `If-None-Match: "<old_etag>"` | `200 OK` | 新 `ETag`, `X-Config-Version`, `X-Lease-Until` | 最新投影 JSON | 原子替换 `RuntimeSnapshot`，旧快照由 GC 回收 |
| **节点已注销 / Token 无效** | 任意 | `401 Unauthorized` | — | `{ ok: false, error: "node_revoked_or_invalid" }` | **立即调用 `PurgeMemory()` 清空内存 Key**，置为 `revoked`，对客户端回 `503` |

**中枢侧投影缓存契约**：
- 中枢按 `(node_id, config._version, node.scope_hash)` 缓存投影结果与对应的 `ETag`；
- 当节点携带 `If-None-Match` 命中当前 `ETag` 时，中枢**无需读取预设库或重新计算投影**，仅順带更新节点 `last_seen`（节流：同一节点 5 分钟内最多写一次 `last_seen` 到 KV，进一步归零 KV 写成本）并直接返回 `304`。

---

## 四、 数据面与健康检查契约（Go Lite & Full 节点）

| 路由 | `lite` 角色 | `full` 角色 (`agent` 模式) | `full` 角色 (`kb` 模式) | 鉴权要求 |
|---|:---:|:---:|:---:|---|
| `GET /healthz` (及 `/health`) | ✓ (脱敏状态) | ✓ | ✓ | 免鉴权（绝不含任何敏感信息或模型/Key 列表） |
| `GET /v1/models` | ✓ | ✓ (真实模型列表) | ✓ (`chat`, `embedding`, `reranker`, `ocr`) | `CLIENT_KEY` 强制 |
| `POST /v1/chat/completions` | ✓ | ✓ | ✓ (仅 `model="chat"`, `stream=false`) | `CLIENT_KEY` 强制 |
| `POST /v1/messages` | ✓ | ✓ | `404` (模式门禁) | `CLIENT_KEY` 强制 |
| `POST /v1/responses` | ✓ | ✓ | `404` (模式门禁) | `CLIENT_KEY` 强制 |
| `POST /v1/embeddings` | `404` | `404` | ✓ | `CLIENT_KEY` 强制 |
| `POST /v1/rerank` | `404` | `404` | ✓ | `CLIENT_KEY` 强制 |
| `POST /v1/ocr` | `404` | `404` | ✓ (预读信号量 + 零拷贝流式) | `CLIENT_KEY` 强制 |
| `GET/POST /admin*`, `/api/admin/*` | **不注册 (`404`/`403`)** | ✓ | ✓ | `ADMIN_PASSWORD` 强制 |

> 注：所有 `/v1/*` 路由同时兼容挂载在 `/api/v1/*` 下，以无缝兼容各类第三方客户端的 Base URL 习惯。

---

## 五、 Full 节点统计账本与请求轨迹回放契约（借鉴 Magpie `usageapi` + `trace`）

受 `ADMIN_PASSWORD` 保护（仅 `full` 角色挂载，彻底取代 1 代割裂的 `/api/admin/stats` 与 `/api/admin/errors`）：

### 5.1 周期统计聚合 `GET /api/admin/usage?period=today|7d|30d|all&tz=Asia/Shanghai`
```json
{
  "ok": true,
  "period": "today",
  "totals": {
    "requests": 1428,
    "success": 1419,
    "failed": 9,
    "retried_requests": 42,
    "input_tokens": 14200000,
    "output_tokens": 4200000,
    "cache_read_tokens": 8800000,
    "reasoning_tokens": 650000,
    "avg_ttft_ms": 380,
    "avg_total_ms": 1620
  },
  "models": [
    {
      "model": "claude-sonnet-4-20250514",
      "requests": 860,
      "success_rate": 0.998,
      "input_tokens": 9500000,
      "output_tokens": 2600000,
      "cache_read_tokens": 6460000,
      "avg_ttft_ms": 410
    }
  ],
  "keys": [
    {
      "provider": "minimax",
      "key_id": "hk-pool-01",
      "requests": 520,
      "failed": 3,
      "avg_ttft_ms": 290,
      "cooldown_until": 0
    }
  ]
}
```

### 5.2 最近 60 次请求轨迹与多跳故障转移回放 `GET /api/admin/traces`
直接对应 `magpie/internal/gateway/trace.go` 的 `RequestTrace` + `Tries []Try` 结构：
```json
{
  "ok": true,
  "traces": [
    {
      "id": "tr_01j9x8k2m",
      "ts": 1762566065,
      "mode": "agent",
      "endpoint": "/v1/chat/completions",
      "req_model": "claude-sonnet-4-20250514",
      "served_model": "MiniMax-M2.5",
      "winner_provider": "minimax",
      "winner_key": "hk-pool-02",
      "status": 200,
      "stream": true,
      "in_tokens": 1420,
      "out_tokens": 380,
      "cache_read_tokens": 1024,
      "ttft_ms": 420,
      "total_ms": 1840,
      "retried_ms": 310,
      "tries": [
        {
          "attempt": 1,
          "provider": "minimax",
          "key_id": "hk-pool-01",
          "model": "MiniMax-M2.5",
          "status": 429,
          "ms": 310,
          "reason": "rate_limit",
          "cooldown_applied_sec": 15,
          "error_snippet": "Upstream rate limit exceeded: RPM quota reached"
        },
        {
          "attempt": 2,
          "provider": "minimax",
          "key_id": "hk-pool-02",
          "model": "MiniMax-M2.5",
          "status": 200,
          "ms": 1530,
          "ttft_ms": 420
        }
      ]
    }
  ]
}
```

---

## 六、 Full 节点供应商引擎扩展 API 契约 (Round 3/4)

全部接口受 `ADMIN_PASSWORD` 或有效 Session Cookie 保护：

### 6.1 多协议探测与基准地址规范化 `POST /api/admin/detect-provider`
- **Request**:
```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-...",
  "provider": "openai"
}
```
> 若提供 `provider` 且 `api_key` 为空或脱敏占位符，自动从 `LocalSource` 读取已保存的明文 Key。
- **Response (`200 OK`)**:
```json
{
  "ok": true,
  "base_url": "https://api.openai.com/v1",
  "normalized_base_url": "https://api.openai.com/v1",
  "protocols": ["chat", "responses"],
  "results": {
    "chat": { "protocol": "chat", "endpoint": "https://api.openai.com/v1/chat/completions", "ok": true, "status": 200, "ms": 234 },
    "responses": { "protocol": "responses", "endpoint": "https://api.openai.com/v1/responses", "ok": true, "status": 200, "ms": 210 }
  }
}
```

### 6.2 实时余额与额度查询 `POST /api/admin/balance`
- **Request**:
```json
{
  "provider": "deepseek",
  "key_label": "hk-key-01",
  "api_key": "sk-...",
  "base_url": "https://api.deepseek.com/v1",
  "balance_url": "https://api.deepseek.com/user/balance",
  "balance_path": "",
  "preset_id": "deepseek"
}
```
- **Response (`200 OK`)**:
```json
{
  "ok": true,
  "balance": {
    "amount": "¥128.50",
    "currency": "CNY",
    "total": 128.5,
    "granted": 28.5,
    "topped_up": 100.0,
    "account_wide": true
  }
}
```

### 6.3 探活与多 Key 并行健康检测 `POST /api/admin/test-provider`
- **Request**:
```json
{
  "provider": "openai",
  "key_label": "main",
  "model": "gpt-4o-mini",
  "protocol": "chat",
  "batch": true
}
```
> 若 `batch: true`，对该供应商所有 Key 并行检测并返回每把 Key 的延迟与状态；检测成功的 Key 会自动通过 `CooldownManager` 清除冷却封禁。
- **Response (`200 OK`)**:
```json
{
  "ok": true,
  "results": [
    { "key_id": "k1", "key_label": "main", "masked": "sk-...1234", "ok": true, "status": 200, "ms": 180, "model": "gpt-4o-mini" }
  ]
}
```

### 6.4 模型自动拉取与通配符筛选同步 `POST /api/admin/autolist-sync`
- **Request**:
```json
{
  "provider": "deepseek",
  "auto_include": "deepseek-*",
  "apply": true
}
```
> 若 `apply: true`，将过滤出的缺失模型自动添加至 `agent_models` 并持久化到 `LocalSource`。
- **Response (`200 OK`)**:
```json
{
  "ok": true,
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "matched": ["deepseek-chat", "deepseek-reasoner"],
  "added": ["deepseek-chat"]
}
```

### 6.5 预设库全量模板查询 `GET /api/admin/presets-extra`
- **Response (`200 OK`)**:
```json
{
  "ok": true,
  "presets": [
    { "id": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1", "protocols": ["chat", "responses"] }
  ]
}
```

### 6.6 节点访问信息与 API 凭据管理
- **获取节点接入信息 `GET /api/admin/access-info`**:
```json
{
  "ok": true,
  "mode": "agent",
  "client_key_configured": true,
  "client_key_masked": "sk-...9876",
  "proxy_keys_count": 2,
  "endpoints": ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/models"],
  "models": ["claude-3-7-sonnet", "deepseek-chat", "gpt-4o-mini"]
}
```
- **配置或自动生成访问凭据 `POST /api/admin/access-key`**（别名 `POST /api/admin/client-key`）:
```json
{
  "client_key": "",
  "generate": true
}
```
返回 `{ "ok": true, "client_key": "sk-llmproxy-...", "masked": "sk-...abcd" }`，并实时热更新 `authMgr`。

---

## 七、 Magpie 无头 Web 安全认证契约 (`M14`)

基于 `magpie/internal/gui/web.go` 设计原则，支持 Cookie 与 HTTP Bearer 双轨鉴权，既无缝支持前后端脚本调用，又保障现代浏览器无感会话安全：

### 7.1 Web 登录 `POST /api/admin/auth/login`
- **免鉴权**，使用请求体中的密码进行防暴力破解恒定时间 SHA-256 对比：
- **Request**:
```json
{
  "password": "your_admin_password"
}
```
- **Response (`200 OK`)**:
  - `Set-Cookie: llmproxy_admin_session=<hmac_token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`
```json
{
  "ok": true
}
```

### 7.2 Web 登出 `POST /api/admin/auth/logout`
- **Response (`200 OK`)**:
  - `Set-Cookie: llmproxy_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=-1`
```json
{
  "ok": true
}
```

### 7.3 `isAdminAuthorized(r)` 双轨校验逻辑
1. 优先检查请求头 `Authorization: Bearer <password>`（保持 100% 脚本兼容）。
2. 若无请求头或校验未通过，检查是否携带合法 `llmproxy_admin_session` Cookie（HMAC 密钥绑定当前管理员密码，密码修改自动全端失效）。
3. **防暴力破解只统计"携带了错误凭据"的尝试**：完全无凭据的请求（浏览器首屏加载、健康探针、未登录脚本）不消耗失败额度，避免正常用户刷新页面即自锁。
4. 失败阶梯：10 分钟内连续 5 次错误凭据 → 封禁该 IP 10 分钟。
5. **状态码契约**：被封禁期间，任何管理端点（含 `POST /api/admin/auth/login`）返回 `429 Too Many Requests` 并携带 `Retry-After: <秒>`；未被封禁时的失败返回 `401 Unauthorized`。前端据此区分"密码错误"与"临时锁定"。
```json
{
  "ok": false,
  "error": { "message": "too many failed admin attempts, retry later", "type": "rate_limit_error", "retry_after_sec": 600 }
}
```

### 7.3.1 Vault 按需拉取契约（`/api/vault/manifest`、`/api/vault/fetch`）

> **v3 契约变更**：全量同步端点 `POST /api/vault/sync` 已移除——中枢托管内容不再一键整批落地，一律按需拉取。`hub` 与 `full` 两个角色都暴露这两条端点：hub 上是中枢本体，full 上是 Go 节点的透传代理（`ADMIN_PASSWORD` 保护）。
>
> **v3.1 安全收紧**：`POST /api/vault/fetch` **不再接受调用方传入的 `hub_url` / `node_token`**——拉取目标永远是节点已配置的 Vault（存储配置或 CLI 默认值）。这是防外送的关键：即便管理密码泄露，攻击者也无法把「自动导入 base_url」的拉取指向恶意中枢。清单端点的覆盖参数仅用于「测试连接」（只读元数据、绝不导入），且 `POST` 请求体传 token（不再进 URL 查询串）。

- 同时接受两种凭据：Hub **管理员密码**（控制台/人工拉取）与节点 **`NODE_TOKEN`**（full 节点自助拉取）。
- 节点 Token 只读，且只暴露 `origin="vault"` 的供应商与 Key；`origin="local"` 一律物理阻断。
- 禁止把 Hub 管理员密码写入节点配置：节点只需要自己的 `NODE_TOKEN`（最小权限）。

#### 7.3.1.1 清单 `GET | POST /api/vault/manifest`（元数据 + Key 标签，绝无明文）
```json
{
  "ok": true,
  "_version": 137,
  "providers": {
    "minimax": {
      "name": "MiniMax",
      "preset_id": "minimax",
      "base_url": "https://api.minimax.chat/v1",
      "anthropic_base_url": "",
      "keys": ["hk-pool-01", "hk-pool-02"],
      "rule_hash": "a1b2c3d4e5f6",
      "adapter_rules": {}
    }
  },
  "agent_models": {
    "claude-sonnet-4-20250514": {
      "routing_strategy": "sticky_failover",
      "active_key": "minimax:hk-pool-01",
      "no_reasoning": false,
      "force_non_stream": false,
      "allow_key_fallback": false,
      "candidates": [
        { "provider": "minimax", "key_label": "hk-pool-01", "target_model": "MiniMax-M2.5", "enabled": true, "weight": 3, "max_concurrency": 8 }
      ]
    }
  }
}
```
- `providers` 只收录 vault 供应商（`origin="local"` 物理阻断），`keys` 为启用且有 Key 材料（与运行时投影同口径）的**标签**数组；节点 Token 额外受 `scope.providers` 过滤。
- `rule_hash` 由中枢按解析后的 `adapter_rules` 内容实时计算（与 `/api/vault/fetch` 下发的同一哈希）：节点存储拉取时的哈希，清单哈希与之不一致即规则漂移，控制台出现「中枢规则已更新」提示。
- `agent_models` 为**按需路由模板**：仅收录 `enabled` 的路由；按调用方模型 scope（节点 Token 的 `scope.models`，管理员视为 `["*"]`）过滤；候选必须引用在本清单 `providers` 段**存活**的供应商——已禁用或已死亡的候选被剔除，候选清零的路由整条丢弃。
- 候选携带 Key 标签（`key_label`）与单候选并发上限 `max_concurrency`（与运行时投影、节点 `RouteCandidate` 字段名一致），绝不携带明文 Key 材料。
- full 节点支持 `POST`（`hub_url`/`node_token` 走请求体，token 不进 URL 日志）；`GET` + 查询串为兼容形态。

#### 7.3.1.2 单供应商按需拉取 `POST /api/vault/fetch`
- **Request**（`key_label` / `keys` 可选——按 Key 标签补拉；**不含** `hub_url`/`node_token`，拉取目标恒为节点已配置的 Vault）:
```json
{ "provider": "minimax", "key_label": "hk-pool-01" }
```
- **Response (`200 OK`)**：`provider_config` 携带中枢托管字段（`name`/`preset_id`/`api_type`/`base_url`/`anthropic_base_url`/`hide_client_name`/`adapter_rules`/`rule_hash`）与 `keys`（标签→Key材料 映射；hub 本体返回明文供中枢控制台管理，full 节点自动导入并在回显前掩码）；`imported_keys` 为本次落地的 vault Key 标签数组（full 节点附加）。**不下发 `enabled`**——供应商与 Key 的启停是节点本地运维开关。
- **`409 Conflict`（仅 full 节点）**：目标供应商本地已存在且 `origin=local`（或历史空 origin）—— 本地新建的供应商不可再从中枢拉取，须先删除/改名：
```json
{ "ok": false, "error": "provider_exists_local", "provider": "minimax" }
```
该冲突在导入时于配置锁内复核（合并前快照与落地之间同 ID 被并发改为本地供应商也会失败，不会把 vault Key 静默并入本地供应商）。
- **替换语义**：整体拉取（不带 `key_label`/`keys`）时，full 节点对已存在的 vault 供应商**整体替换中枢托管字段**（`name`/`base_url`/`anthropic_base_url`/`adapter_rules`/`preset_id`/`api_type`/`hide_client_name`/`rule_hash`）与 vault Key 列表——本地删过的 Key 重新拉取即恢复，中枢删掉的 Key 本地随之消失；本地仍存在的 Key 保留其启用开关。按 Key 标签补拉则为增量合并，不影响其它 vault Key，也不改动已存 Key 的启用开关。`origin="local"`（及历史空 origin）的供应商与本地 Key 永不被覆盖。
- **其它错误**：`400 invalid_json` / `400 provider_required` / `400 vault hub url not configured`、`403 provider_out_of_node_scope`（hub、节点越权）、`404 provider_not_found_or_local`（hub）、`502`（中枢不可达，或 200 响应体非 JSON 对象——该形态绝不原样回显给管理端）。

### 7.3.2 `GET /healthz`（Hub）版本可观测
- 返回 `version` / `semver` / `release_date`，用于判断线上 Hub 部署是否落后于仓库/节点版本。

### 7.3.3 模型路由 `allow_key_fallback`
- `agent_models.<model>.allow_key_fallback`（默认 `false`）：当候选引用的 `key_label` 被禁用或删除时，允许回退到**同供应商**其它启用 Key。
- 默认关闭以保持「候选按 provider+key_label 精确绑定」的语义；控制台模型编辑器可勾选开启。

### 7.4 管理端可见的凭据范围
- `GET /api/config` 对上游供应商 `api_keys[].key` 一律掩码（`sk-●●●●●●xxxx`）。
- `settings.client_key`（网关客户端 Key）**按设计明文返回**：管理员需要该值配置 Cursor/Claude 等客户端，控制台"网关接入中心"直接展示。该接口本身受管理员鉴权保护，不得在未鉴权响应、日志或 traces 中出现。

---

## 八、 前端单文件构建预算与门禁规范

- 前端控制台源码统一位于 `shared/admin/`，通过 `node shared/admin/build.mjs` 构建为内嵌单一单页 HTML（输出至 `shared/admin/dist/index.html` 与 `internal/admin/assets/index.html`）。
- 打包体积硬门禁：**`≤ 240 KB`（`245,760 bytes`）**（执行 G4 门禁校验与 T1 合同测试）。
- 零内联样式（严禁 `style="` 与 `.style.xxx`）、零 Drawer 抽屉（全部行内展开 `.editor`）、零彩色左边框条、原生 `[hidden]` 显隐控制。

