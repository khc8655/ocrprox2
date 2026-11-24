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

> **`admin_password` 字段（v3.4 契约，仅 `role: "full"`）**：Full 节点对象额外携带 `admin_password`——Full 节点管理控制台（`/admin`）的登录密码，**以明文存于中枢 KV**（运营者明确选择方案 A，私有部署，风险已知悉），签发时生成、列表/详情随节点对象返回，控制台可随时回看与复制。Lite 节点没有管理控制台，**从不含该字段**（full→lite 改角色时中枢会主动删除残留值；lite→full 改角色时中枢会立即补生成并持久化一份，节点即刻可在凭据端点回看）。**`node_token` 字段（v3.10 契约）**：与 `admin_password` 同一决策——运营者选择 Token 也明文存 KV（`node_token_plaintext`），签发时写入、轮换时同步更新。`sanitizeNode` 在列表/安装载荷中剥离该字段，仅 `credentials` 端点按需返回；`token_sha256` 仍是唯一鉴权依据。列表响应与凭据端点一样带 `Cache-Control: no-store`。

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
- **Response (`200 OK`)**：返回明文 `node_token`（v3.10 起 KV 同时存 `token_sha256` 与 `node_token_plaintext`，可在「节点详情」中回看）、节点当前生效的客户端鉴权密钥 `client_key`、启动环境变量模板 `bootstrap_env` 以及直接可执行的一键安装命令 `install_command`；Full 节点另附 `admin_password`（顶层与 `node` 对象内各一份，见 §2.1 的字段说明）：
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
- **轮换 Token**：`POST /api/admin/nodes/:id/rotate` → 生成新 `node_token`、`bootstrap_env` 与 `install_command`，旧 Token 立即失效。**后台密码不轮换**：KV 明文存有的 `admin_password` 原样复用（运营者可能已另行保存），仅「未存过密码的历史版本节点」在此刻补生成一次并持久化，保证后续查看稳定；Lite 节点响应不含该字段。
- **重新获取安装命令**：`GET /api/admin/nodes/:id/install-command` → 返回与签发/轮换同构的部署材料（`node`（已脱敏，Full 节点含 `admin_password`）、`node_token`、`client_key`、`admin_password`、`bootstrap_env`、`install_command`）；因 KV 仅存 `token_sha256`，内部即执行一次轮换，旧 Token 立即失效（响应带 `Cache-Control: no-store`；节点不存在返回 `404 {ok:false, error:"node_not_found"}`）。节点列表页每行的「安装」按钮即此契约：同一会话内复用内存缓存的 Token 免轮换，跨会话（页面刷新后）调用本端点轮换取新。路径匹配为精确三段（`/:id/install-command`），`/:id/rotate/install-command` 等畸形路径不触发轮换。
- **删除节点**：`DELETE /api/admin/nodes/:id` → 物理移除 KV 中的节点记录。

### 2.4 回看节点后台密码 `GET /api/admin/nodes/:id/credentials`（v3.4 契约）
节点列表每行的「密码」按钮即此契约：**只读**回看已安装节点的后台凭据，**绝不轮换 Token**。响应带 `Cache-Control: no-store`（载荷含明文凭据，任何中间层不得缓存）；节点不存在返回 `404 {ok:false, error:"node_not_found"}`。
```json
{
  "ok": true,
  "id": "node_hk_full_01",
  "role": "full",
  "admin_password": "xxxxxxxxxxxxxxxxxxxx",
  "client_key": "sk-llmproxy-...",
  "node_token": "stk_node_<48hex>"
}
```
- `node_token`（v3.10 契约）：KV 明文存于 `node_token_plaintext`，签发时写入、轮换时同步更新；旧节点若无此字段返回 `null` 并附轮换提示。Lite 节点同样返回。
- `admin_password`：Full 节点返回 KV 存储的明文密码；Lite 节点为 `null` 并附 `admin_password_note`（「lite 节点无后台密码」）；签发于「未存储密码」旧版本的历史 Full 节点为 `null` 并附指引 note（重新获取安装命令——将轮换 Token——时补生成并持久化）。
- `client_key`：非节点私有字段——签发时内嵌的是中枢全局 `settings.client_key`（所有节点同一把）。中枢已配置全局密钥时返回该值；未配置（节点装的是一次性随机密钥、中枢从未存储）返回 `null` 并附 `client_key_note` 指引。
- 控制台密码弹层默认掩码显示（`●●●●●●●●●●●●`），「显示」切换、「复制密码 / 复制 API Key」一键复制。

---

## 三、 节点按需配置投影契约（`POST /api/node/config`）

受 `NODE_TOKEN`（`Authorization: Bearer <NODE_TOKEN>`）保护，遵循零轮询、零心跳、严格单向被动响应原则：

| 场景 | 请求头 / 参数 | HTTP 状态码 | 响应头 | 响应体 | 节点侧标准动作 |
|---|---|---:|---|---|---|
| **首次激活拉取** | 无 `If-None-Match` | `200 OK` | `ETag`, `X-Config-Version`, `X-Lease-Until`, `X-Grace-Until` | `{ ok: true, config_version, lease_ttl, grace_ttl, lease_until, payload: { providers, agent_models, settings, adapter_rules } }` | 原子构建内存 `RuntimeSnapshot` 并开始服务 |
| **租约到期续租（配置未变）** | `If-None-Match: "<etag>"` 与当前版本一致 | `304 Not Modified` | `ETag`, `X-Config-Version`, `X-Lease-Until`, `X-Grace-Until` | **空（0 字节）** | 零反序列化开销，直接更新内存 `lease_until` 与 `grace_until` |
| **租约到期续租（配置已变）** | `If-None-Match: "<old_etag>"` | `200 OK` | 新 `ETag`, `X-Config-Version`, `X-Lease-Until` | 最新投影 JSON | 原子替换 `RuntimeSnapshot`，旧快照由 GC 回收 |
| **节点已注销 / Token 无效** | 任意 | `401 Unauthorized` | — | `{ ok: false, error: "node_revoked_or_invalid" }` | **立即调用 `PurgeMemory()` 清空内存 Key**，置为 `revoked`，对客户端回 `503`。**v3.9 补**：心跳同样返回 401，节点据此在租约到期前就停服；且 `nodeToken` **不再被清除**——Hub 侧恢复 `enabled: true` 后节点在 60s 重试窗口内自行复验并恢复，无需重启进程 |

**中枢侧投影缓存契约**：
- 中枢按 `(node_id, config._version, node.scope_hash)` 缓存投影结果与对应的 `ETag`；
- 当节点携带 `If-None-Match` 命中当前 `ETag` 时，中枢**无需读取预设库或重新计算投影**，仅順带更新节点 `last_seen`（节流：同一节点 5 分钟内最多写一次 `last_seen` 到 KV，进一步归零 KV 写成本）并直接返回 `304`。

---

## 三·补 节点心跳契约（`POST /api/node/heartbeat`，v3.5）

> **动机**：full 节点原本只在手动 `/api/vault/fetch`、`/api/vault/manifest` 时上报 `X-Node-Version`，不拉配置就一直显示「离线」（15 分钟口径），升级后中枢仍显示旧版本。心跳以极低成本补上在线与版本信号——EdgeOne Makers 免费额度**同时限制调用次数与 KV 写入数**，故端点与客户端都按「压到最低」设计。

- **鉴权**：`Authorization: Bearer stk_node_<48hex>`（`NODE_TOKEN`，复用 `findNodeByToken`）；**`lite` 与 `full` 令牌均可调用**。未知/吊销/禁用令牌返回 `401 { ok:false, error:"node_revoked_or_invalid" }`；非 POST 返回 `405 method_not_allowed`。
- **请求头**：`X-Node-Version` 可选（如 `v20261123-03`）；缺省时保留节点既有的 `last_binary_version`，不清空。客户端 IP 解析沿用 `/api/node/config` 的头优先级（`eo-connecting-ip` > `cf-connecting-ip` > `x-forwarded-for`）。
- **响应（v3.9 变更）**：`200 OK` + `{"ok": true, "config_version": <N>}`。不拉配置、不做投影、不返回 payload、不回显遥测——只带一个版本号。
  - **为什么改**：节点只有在租约到期（默认 24h）才复验 Hub，所以此前「运营者改了模板」和「运营者吊销了节点」都要等一天才生效。心跳是唯一周期性触达 Hub 的通道，一个整数就能解决两件事。
  - **节点的两个动作**：版本号与本地不一致 → 拉取模板（一次 304/200）；`401/403` → 立即清空内存配置并停服（吊销语义）。
  - **代价**：每次非去抖心跳恰好一次 config 读取（KV 的 `get`，不是写入）。去抖路径（<60s）仍然零读取、零写入。
  - **兼容**：老节点收到 200 会忽略 body；老 Hub 返回 204 时新节点安全跳过版本解析。
- **服务端去抖**：用节点既有 `last_seen` 自身做依据（不新增 KV 字段）；距上次心跳 **< 60 秒** 直接返回 204 且**不写 KV**（不读整个节点数组、不 `saveNodes`）——KV 写入是免费额度里更贵的一项。只有去抖窗口外才更新 `last_seen` / `last_ip` / `last_binary_version`。touch 失败静默吞掉，绝不影响调用方。
- **客户端间隔**：`LLMPROXY_HEARTBEAT_INTERVAL` 环境变量 / `--heartbeat-interval` CLI 标志（秒）：**默认 600 秒**（每节点每天 144 次），**最小 60 秒**（小于 60 按 60 处理），`0` / `off` 关闭。**full 角色默认启用**，**lite 角色默认关闭**（保持零轮询）；lite 显式配置非 off 值时按该间隔发送（lite 节点令牌同样有效）。启动后延迟 5 秒发首次心跳、不阻塞启动——升级重启即自动上报新二进制版本，无需用户操作；失败只记 debug 日志，绝不重试风暴、绝不阻塞数据面、绝不影响启动。

---

## 四、 数据面与健康检查契约（Go Lite & Full 节点）

| 路由 | `lite` 角色 | `full` 角色 (`agent` 模式) | `full` 角色 (`kb` 模式) | 鉴权要求 |
|---|:---:|:---:|:---:|---|
| `GET /healthz` (及 `/health`) | ✓ (脱敏状态) | ✓ | ✓ | 免鉴权（绝不含任何敏感信息或模型/Key 列表） |
| `GET /v1/models` | ✓ | ✓ (真实模型列表) | ✓ (仅列已配置类别：agent_models 路由 + 存留的 `chat`/`embedding`/`reranker`/`ocr`) | `CLIENT_KEY` 强制 |
| `POST /v1/chat/completions` | ✓ | ✓ | ✓ (仅 `model="chat"`, `stream=false`；`chat` 未配置时 `404`) | `CLIENT_KEY` 强制 |
| `POST /v1/messages` | ✓ | ✓ | `404` (模式门禁) | `CLIENT_KEY` 强制 |
| `POST /v1/responses` | ✓ | ✓ | `404` (模式门禁) | `CLIENT_KEY` 强制 |
| `POST /v1/embeddings` | `404` | `404` | ✓ (需已配置 `embedding` 同名路由，否则 `404`) | `CLIENT_KEY` 强制 |
| `POST /v1/rerank` | `404` | `404` | ✓ (需已配置 `reranker` 同名路由，否则 `404`) | `CLIENT_KEY` 强制 |
| `POST /v1/ocr` | `404` | `404` | ✓ (预读信号量 + 零拷贝流式；需已配置 `ocr` 同名路由，否则 `404`) | `CLIENT_KEY` 强制 |
| `GET/POST /admin*`, `/api/admin/*` | **不注册 (`404`/`403`)** | ✓ | ✓ | `ADMIN_PASSWORD` 强制 |

> 注：所有 `/v1/*` 路由同时兼容挂载在 `/api/v1/*` 下，以无缝兼容各类第三方客户端的 Base URL 习惯。
>
> 注：kb 模式的四通道端点**不再无条件可用**——前端已停止默认生成 chat/embedding/reranker/ocr 路由（可手动删除），端点仅在配置了同名路由（agent_models）或残留 legacy `kb_models` 时可达，否则统一回 `404 model "…" not configured or disabled`（`internal/scheduler/scheduler.go`）。要用 KB 就自行建同名路由。

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
    { "id": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1", "protocols": ["chat", "responses"], "version": "1.2.1", "updated_at": "2026-10-19" }
  ]
}
```
> preset 对象为后端 `PresetDef` 的完整 JSON 序列化（`internal/provider/presets.go`）。其中 `version` / `updated_at` 镜像该供应商适配文件（`shared/presets/<id>.json`，与 `shared/presets/catalog.json` 汇总目录同源）的版本与日期，控制台用于在供应商卡片渲染「适配 `<id>` · v`<version>` · `<updated_at>`」标签；无对应适配文件的预设（如 `anthropic`、`minimax-cn` 等）两字段带 `omitempty`，响应中直接省略。

### 6.6 节点访问信息与 API 凭据管理
- **获取节点接入信息 `GET /api/admin/access-info`**:
```json
{
  "ok": true,
  "mode": "agent",
  "client_key_configured": true,
  "client_key_masked": "sk-...9876",
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
- **单密钥口径（v3.7 契约）**：多客户端密钥（`proxy_keys`）已前后端整体移除。`access-info` 响应不再含 `proxy_keys_count`；`access-key` 请求不再接受 `proxy_keys`（请求体里带该字段会被忽略），响应也不回显。`/v1/*` 数据面 `VerifyClientKey` 只认单个 `settings.client_key`（1 代别名 `proxy_api_key` 仍解析为该值），不再比对任何额外密钥；旧配置或中枢载荷中残留的 `proxy_keys` 数组按未知字段忽略，其中的密钥不再具备鉴权能力。中枢侧同样丢弃该字段：`loadConfig` 读出旧 KV 时剔除、`saveConfigWithCAS` 不写回、`projectConfigForNode` 不下发。
- **单密钥槽位与 Lite 的 `--client-key`（v3.7 行为变更）**：`syncAuthKeysForRole` 不再按角色分支，两个角色都是同一优先级链「`Settings.client_key` → `Settings.proxy_api_key` → CLI/`.env` key」，且**只有一个槽位**。对 Lite 意味着：中枢投影的 `settings.client_key` 一到（首次 `POST /api/node/config` 即发生），安装时传入的 `--client-key` 立刻失效，两者不能并存。要给 Lite 客户端固定一把密钥，就在中枢设置该 `client_key`；`bootstrap_env` / `install_command` 里的 `--client-key` 只是首次投影前的过渡值。Full 语义不变（中枢/Web 设置的密钥始终覆盖 CLI key）。

### 6.7 添加模型：上游模型探测 `POST /api/admin/probe-models`（hub + full）
- **Request**:
```json
{
  "provider": "minimax",
  "base_url": "https://api.minimax.chat/v1",
  "api_key": "可选：空或脱敏占位符时自动取该供应商第一把启用的已存 Key（中枢侧另接受 key_label 指定某把已存 Key）",
  "api_type": "可选：anthropic-messages 时改用 x-api-key + anthropic-version 头探测"
}
```
- **Response (`200 OK`)**:
```json
{ "ok": true, "models": ["MiniMax-M2.5", "MiniMax-Text-01"] }
```
- **语义**：添加模型流程（选供应商 → 探测上游模型 → 点选/手填「上游目标模型 ID」）的后端支柱，只读不落库。探测上游 `GET {base_url}/models`：OpenAI 形态 `{data:[{id}]}` 与 Google 形态 `{models:[{name}]}`（自动剥 `models/` 前缀）均可解析。**full 节点**：`api_key` 为空/脱敏时自动解析供应商第一把启用 Key；vault 托管 Key 禁止用 `base_url` 覆盖探测目标（`403 cannot override base_url when using a vault-managed key`）；上游非 2xx 状态码原样透传并附 `ok:false`。**中枢**：同一端点由 `edgeone-hub/api/admin/probe-models.js` 实现（`400 api_key_required` / `base_url_required` / `unsafe_upstream_url`、`502` 上游不可达）。

### 6.8 路由行「测试路由」：`POST /api/admin/test-agent-model` 与 `POST /api/admin/test-candidate`（仅 full）
- **`POST /api/admin/test-agent-model`** —— chat 类路由的行级测试：对该路由每条启用候选（全被禁用时回退全部候选）各发**一次最小真实推理**——OpenAI 兼容供应商 `POST {base_url}/chat/completions`，请求体 `{model: target_model||model, messages:[{role:"user",content:"你好"}], max_tokens:16, stream:false}`；`anthropic-messages` 供应商改发 `{base_url}/messages`（不带 stream）。最多 5 路并发、15s 超时；某候选探测成功即清除该 Key 的冷却封禁。
```json
{
  "ok": true, "success": true, "model": "claude-sonnet-4-20250514",
  "total": 2, "passed": 2, "checked_at": "2026-11-22 12:00:00",
  "results": [
    { "provider": "minimax", "key": "hk-pool-01", "model": "MiniMax-M2.5", "ok": true, "status": 200, "latency_ms": 380 },
    { "provider": "minimax", "key": "hk-pool-02", "model": "MiniMax-M2.5", "ok": true, "status": 200, "latency_ms": 412 }
  ]
}
```
- **`POST /api/admin/test-candidate`** —— 单候选探测，embedding/reranker/ocr 路由的「测试路由」走它（取第一条候选）：`type` 取 `chat|embedding|reranker|ocr`（缺省 `chat`，别名 `category`）。各类型载荷：embedding → `POST {base}/embeddings` `{model, input:"test"}`；reranker → `POST {base}/rerank` `{model, query:"test", documents:["a"]}`；ocr → `chat/completions` 携带 1×1 PNG + "Extract text"、`max_tokens:64`；chat → 与 test-agent-model 相同的最小推理。`model` 缺省时依序从 `kb_models[type]`（本供应商条目）→ 供应商模型别名 → 类型名解析；`key_label` 缺省时取第一把启用 Key。响应 `{ok, success, status, ms, latency_ms, model, text(答案片段：chat 取 message.content，形态不识别时取响应体前 100 字节), error?}`，探测成功同样清冷却。
- 控制台路由行展示判定胶囊：成功显示「测试 `<latency>ms · <provider> · <key_label>`」（chat 路由取最快通过的候选），失败显示错误摘录。

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

### 7.3.4 供应商 `rpm_per_key` 整体限流语义（v3.3 起）
- `providers.<id>.rpm_per_key` 是**该供应商整体 RPM 上限（调度器按供应商维度限流），0=不限**——不再是 Key 级限流的回退值。`>0` 时调度器在派发前先对整个供应商做一次滑动窗口检查（独立 `RPMLimiter` 实例 `providerRPMLimiter` 的桶 `provider:<provider_id>`，与 Key 级桶 `provider:key_label` 分属两个实例，命名空间不相交由构造保证，见 `internal/scheduler/rpm.go` 的 `providerRPMKey()`）：窗口满则该供应商**全部 Key** 一律不再派发——排序期 `isCandidateHealthy` 判不健康（不占通道槽）、`Dispatch` 与 `ExecuteEndpoint` 的候选遍历两处 `TryAcquire` 显式跳过，跳过原因记 `<provider_id> (provider RPM limit)`（同一供应商多个候选去重，不重复追加）。
- 拨号前失败回滚：供应商令牌先取、随后 Key 级拒绝（`max_rpm` 打满）、OAuth 刷新失败或请求构建失败时，已取的供应商令牌（及 Key 令牌）经 `TryAcquireToken` 返回的 release 退回——滑动窗口只统计真实发出的请求，幽灵尝试不虚耗供应商额度。
- Key 级限流 `api_keys[].max_rpm` 语义不变、独立生效：仅约束该 Key 自身的滑动窗口，0=不限；调度顺序为先查供应商窗口、再查 Key 窗口。旧「`RPMPerKey` 作为 Key 级回退」行为已移除——N 把 Key 不会各拿一份整供应商额度（守卫测试 `internal/scheduler/rpm_provider_test.go`）。
- 中枢托管同步：`rpm_per_key` 属中枢托管字段，vault 供应商重拉（`MergeVaultConfig`）时**全量跟随**中枢值——中枢清 0（放开限制）后节点重拉即恢复不限，不单向只增不减。
- **载荷必须携带**：`GET /api/vault/manifest` 的 `providers.<id>` 与 `POST /api/vault/fetch` 的 `provider_config` 都必须包含 `rpm_per_key`（数值，缺省 0）——否则中枢配置的限流到不了节点，且任何一次 vault 重拉都会把节点本地已设的值静默重置为 0（full 节点 replace 路径整体采纳载荷）。回归守卫：`edgeone-hub/test/hub.test.mjs` 的 vault manifest/fetch 用例同时断言两侧该字段等值。lite 路径同理经 `lib/projection.js` 的 `projectedProvider.rpm_per_key` 下发。

### 7.3.5 URL 查询串凭据直登（`?key=` / `?token=` / `?password=`，v3.4 契约）
- **Full 节点管理面（Go）**：`VerifyAdminAuth`（`internal/auth/auth.go`）在请求头之外**接受 URL 查询串凭据**，优先级 **请求头 > `?key` > `?token` > `?password`**——Full 控制台支持书签式一键直登（与 magpie 一致的便利性），如 `https://node.example.com/admin?key=<admin_password>`。
- **`/v1/*` 数据面（`VerifyClientKey`）并非 header-only**：它取凭据走的 `ExtractToken`（`internal/auth/auth.go`）**在本契约变更之前**就会在无请求头凭据时回退读取 `?key=` / `?token=` 查询串（优先级 请求头 > `?key` > `?token`）——客户端用 `https://node.example.com/v1/chat/completions?key=<client_key>` 调数据面本就是有效形态。v3.4 的放宽只触碰管理面，数据面行为与改动前逐字节一致：**不读取 `?password=`**，且 `adminPassword` 在数据面永不被接受（`VerifyClientKey` 只比对单个 `client_key`，v3.7 起不再有 `extraKeys`）。
- **Hub 中枢（EdgeOne）**：HTTP API **未放宽**——`checkAdminAuth`（`edgeone-hub/lib/config.js`）仍只接受 `Authorization: Bearer` / `x-admin-key` 请求头。`?key=` 直登（读取 URL 参数自动填充登录表单并经正常登录路径提交）**只在 Full 控制台实现**（`shared/admin/js/app.js` 仅对 `kind === 'full'` 自动填充/提交）；Hub 控制台**不支持**查询串直登，前端只在页面加载时把 URL 中的 `?key= / ?token= / ?password=` 参数**读取后立即无条件抹除**（`history.replaceState`，无论后续登录成败），防止误留参数长期驻留地址栏。
- **已接受的取舍与风险（运营者明确选择）**：凭据出现在 URL 中可能进入**浏览器历史、Referrer 头、反向代理访问日志**。本系统为私有部署，运营者已知悉并接受该风险换取一键直登便利。前端「读取后立即抹除（无论登录成败）」只降低驻留时间，不能消除上述三个通道的泄露面。
- **防暴力破解口径不变**：携带**错误**查询串凭据与错误请求头同等对待——失败并消耗防暴力额度（10 分钟内 5 次错误 → 封禁 IP 10 分钟，守卫测试 `internal/auth/auth_test.go` 的 `TestVerifyAdminAuth_WrongQueryKeyCountsTowardLockout`）；完全无凭据的请求（首屏加载、探针）依旧不消耗额度。凭据校验、优先级与锁定逻辑全部在服务端。
- **已接受的放大面（v3.4 新增，运营者知悉）**：Full 控制台读到 `?key=` 会**页面加载即自动提交**——旧版无凭据的 `?key=` 首屏不耗额度，现在每个带错误参数的加载都计一次失败。诱导运营者浏览器打开 5 个 `https://node/admin?key=<猜解>` 链接即可远程耗尽其 IP 的防暴力预算并封禁 10 分钟（纯拒绝服务，攻击者得不到任何凭据）；私有部署下接受该取舍，缓解手段是服务端锁定逻辑（10 分钟自动解封）而非前端。

### 7.4 管理端可见的凭据范围
- `GET /api/config` 对上游供应商 `api_keys[].key` 一律掩码（`sk-●●●●●●xxxx`）。
- `settings.client_key`（网关客户端 Key）**按设计明文返回**：管理员需要该值配置 Cursor/Claude 等客户端，控制台"网关接入中心"直接展示。该接口本身受管理员鉴权保护，不得在未鉴权响应、日志或 traces 中出现。
- Full 节点 `admin_password` 与（v3.10 起）`node_token` **均明文存于中枢 KV 并随凭据端点返回**（运营者明确选择的私有部署取舍，见 §2.1 / §2.4）。`token_sha256` 仍是唯一鉴权依据；`sanitizeNode` 在列表/安装载荷中剥离明文字段。凭据端点响应带 `Cache-Control: no-store`，不得在任何中间层缓存。

---

## 八、 前端单文件构建预算与门禁规范

- 前端控制台源码统一位于 `shared/admin/`，通过 `node shared/admin/build.mjs` 构建为内嵌单一单页 HTML（输出至 `shared/admin/dist/index.html` 与 `internal/admin/assets/index.html`）。
- 打包体积硬门禁：**`≤ 320 KiB`（`327,680 bytes`）**（执行 G4 门禁校验与 T1 合同测试；2026-11-22 由 240 KB 重标——magpie 骨架重排与探测/策略胶囊等已确认 UI 的真实字节成本，见 v20261122-06 CHANGELOG）。
- 零内联样式（严禁 `style="` 与 `.style.xxx`）、零 Drawer 抽屉（全部行内展开 `.editor`）、零彩色左边框条、原生 `[hidden]` 显隐控制。
- **流程纪律**：任何对 `shared/admin/` 源码（`admin.html` / `js/*` / `css/*`）的改动，必须当场跑 `npm run test:admin`（含全部体积/样式门禁并再生成 dist、`internal/admin/assets`、`admin/index.html` 与 `edge-functions/_hub` 同步产物）；只跑 `verify:release` 之类的下游产物校验不算数——下游校验看到的是上一次构建的陈旧产物，门禁失败会被静默漏掉。

