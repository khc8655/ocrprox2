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
- **请求头**：`X-Node-Version` 可选（如 `v20261123-03`）；缺省时保留节点既有的 `last_binary_version`，不清空。客户端 IP 解析：`eo-connecting-ip` > `cf-connecting-ip` > `x-forwarded-for`（取逗号前第一个），三者都没有时回退到 `request.eo.clientIp`（EdgeOne 运行时解析好的客户端 IP）；仍为空则记 `null`，控制台显示「未上报」。`/api/node/config` 的同步路径使用完全相同的回退链——只同步配置、不发心跳的节点（如关闭心跳的 lite）同样能记录 IP。
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
      "source": "client",
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
          "reason": "rate_limited",
          "err_type": "rate_limit_exceeded",
          "err": "Upstream rate limit exceeded: RPM quota reached",
          "rid": "req_abc123",
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

**Try 字段说明（v3.11 起）**

| 字段 | 类型 | 语义 |
|---|---|---|
| `reason` | string | 归一化失败原因，取值见下表；成功尝试不填 |
| `err_type` | string | 上游自己的机器码（`error.type` / `error.code` / `type` / `code` / `error.message` 头部 token），小写、仅 `[a-z0-9_]`、最长 64；解析不出为空 |
| `err` | string | 上游原话：去首尾空白、连续空白压成一个空格、截 280 字符，**必过 `obs.ScrubStringWithSecrets`**（密钥等替换为 `…`） |
| `rid` | string | 上游请求 ID，按 `x-request-id` → `request-id` → `x-amzn-requestid` → `x-ms-request-id` → `cf-ray` 顺序取首个非空值，同样归一化为 `[a-z0-9_]`、最长 128 |
| `error_snippet` | string | **向后兼容保留**：上游 body 前 1KB（已脱敏）。新前端请优先读 `err` |
| `resp_headers` | object | 上游响应头（敏感头已脱敏） |

**`reason` 枚举（封闭集合，仅以下 12 个值）**

| reason | 触发条件 | 运营含义 |
|---|---|---|
| `auth_invalid` | 401 / 403；OAuth 刷新失败 | Key 失效或无权调用该模型，换 Key / 修权限 |
| `quota_exhausted` | 402；或 429 且 body 命中 `insufficient_quota` / `quota` / `balance` / `credit` / `billing` / `余额` / `欠费`（大小写不敏感） | 额度用尽，充值或换账户 |
| `rate_limited` | 429 且非额度类 | 触发 RPM/突发限流，调低并发或提额 |
| `model_not_found` | 404 且 body 含 `model` | 上游不存在该模型名，改 `target_model` / 别名 |
| `context_too_long` | 400 且 body 含 `context_length` / `context length` / `too long` / `max_tokens` / `maximum context` | 上下文超限，裁剪输入 |
| `upstream_error` | 5xx；200 但 body 自带 `error` 且声明 5xx | 上游故障，等冷却/换供应商 |
| `timeout` | 首字超时（`ErrFirstByteTimeout`）、总预算 deadline | 上游太慢，调 `agent_first_byte_timeout_sec` |
| `network` | 拨号/DNS/TLS/SSRF 拦截等传输错误 | 网络/线路问题 |
| `client_disconnected` | 客户端中途断开（请求 ctx 取消） | 客户端侧行为，不计上游健康 |
| `bad_response` | 上游 200 但 body 不可用：SSE 坏包/空流/裸错误帧、非流式 body 读取截断、流聚合失败 | 上游协议异常，换 Key 重试 |
| `protocol_mismatch` | 客户端方言无候选可用（拨号前即拒绝，HTTP 400） | 调错入口或补 `anthropic_base_url` |
| `no_candidate` | 全部候选在本地被跳过（Key 冷却中 / RPM 上限 / 已禁用），未发出上游请求 | 等冷却或补 Key |
| `config_unavailable` | 配置尚不可用（未初始化 / 租约过期） | 同步配置或重装节点 |
| `unknown` | 其它 4xx 或无法归因 | 看 `err` / `err_type` 人工判断 |

**拨号前本地拒绝也进账本**：`model` 未配置（404）、配置不可用（503）、无候选可用（503）都会写一条 `usage.jsonl` 记录并带顶层 `reason` / `err_type` / `err`，因此控制台「最近请求 / 错误分析」不会漏掉这类客户端错误。这类记录没有具体 Key，`try_failed` 为空——原因在记录顶层字段里（`json:reason|err_type|err|rid`）。

**`RequestTrace.source`**：`"client"` 表示真实客户端流量（**空串等价于 client**），`"probe"` 表示控制台自己发起的探测/测试请求。

**落盘**：`usage.jsonl` 的 `try_failed[]`（`TryFailure`）逐条携带失败 Key 的 `provider` / `key_id` / `status` / `reason` / `err_type` / `err` / `rid`；**成功请求只要中途用过故障转移，其失败尝试同样记录**，便于按 (provider, key, reason) 做聚合。

**app.log**：最终失败（返回非 nil error）或存在任意失败尝试时，写恰好一行（已整体脱敏）：

```
req=<trace_id> model=<req_model> endpoint=<endpoint> status=<最终状态码或0> reason=<最后一个 try 的 reason> err_type=<...> provider=<最后一个 try 的 provider> key=<key_id> tries=<尝试次数> ms=<total_ms> err=<压缩后的错误原文>
```

成功且无重试的请求不写；同一 (provider, key, reason) 的连续失败不做日志聚合（由 usage 层聚合）。

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
>
> **身份字段与契约库必须逐字段一致（v3.14）**：规则 A（§7.3.7）用 `id` / `name` / `base_url` 匹配供应商，Hub 与前端拿的是 `shared/presets/*.json`，Full 节点拿的是这份内置库——两侧任一字段漂移都会让同一供应商在三端绑到不同预设。因此 `internal/provider/presets.go` 的 `id` / `name` / `base_url` / `version` 与 `shared/presets/<id>.json` 逐条相同，由守卫测试 `internal/provider/provider_test.go` 的 `TestCatalog_MatchesSharedPresetIdentity` 直接读盘比对（例如 `amd` 是「AMD Radeon Cloud」/ `https://developer.amd.com.cn/radeon/api/v1`，`minimax` 是「MiniMax」/ `https://api.minimaxi.com/v1`，与 `minimax-cn` 同主机）。

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
- **前端状态（v3.12 起）**：路由行的「测试路由」按钮与其 `_lastTest` 胶囊已移除，前端不再调用本组接口；两个端点保留（不删除，避免破坏契约测试与外部脚本），逐 Key 测试改用 `POST /api/admin/test-key`（见 6.9）。

### 6.9 Key 行「测试」：`POST /api/admin/test-key`（hub + full）
逐 Key 的**真实推理**探针：用该 Key 的存储密钥向供应商真实端点发一条最小推理（`user: "你好"`、`max_tokens: 16`、`stream: false`），返回判定、失败原因与实际回复。它替代了「用 `GET /models` 证明 Key 可用」——套餐 Key 能列模型但没有推理额度是常见故障。

- **Request**：`{provider: string, key_id?: string, key_label?: string, model?: string}`。`key_id`/`key_label` 二选一定位已存 Key（显式指定的 Key 即使被禁用也允许测试，这正是「要不要重新启用」的判断依据）；都没给则取该供应商第一把启用 Key。
- **model 解析链**（响应 `model_source`）：`request`（请求显式给出）→ `route`（该供应商作为候选出现的第一个 `agent_models` 路由的 `target_model`；路由名排序、候选按配置顺序、优先启用候选）→ `preset`（预设的第一推荐模型）→ `fallback`（`anthropic-messages` 用 `claude-3-haiku-20240307`，其余 `gpt-4o-mini`）。
- **协议**：按供应商 `api_type`（缺省按 `protocols`/预设推断）。`openai-completions` → `POST {base_url}/chat/completions`（`Authorization: Bearer`）；`anthropic-messages` → `POST {anthropic_base_url|base_url}/messages`（`x-api-key` + `anthropic-version: 2023-06-01`）。超时 20s，不重试、不走调度器、不计入冷却。**中枢**沿用 verify-key 的 SSRF 规则（内网/本机地址 → `400 unsafe_upstream_url`）。
- **Response**（恒为这些字段，密钥绝不出现在任何字段里）：
```json
{
  "ok": true, "valid": true, "status": 200, "latency_ms": 812,
  "provider": "minimax", "key_id": "k_live", "key_label": "hk-pool-01",
  "model": "MiniMax-M3", "model_source": "route", "api_type": "openai-completions",
  "reply_text": "你好！有什么可以帮你？", "reason": "", "err_type": "", "error": "", "rid": "req_abc123"
}
```
  - `ok`：端点是否完成判定（上游 2xx/非 2xx 均为 `true`）；参数/供应商/Key 解析失败为 `false` 且 HTTP 4xx/503。
  - `valid`：上游 2xx 即 `true`（`reply_text` 抽不到文本也给空串），非 2xx/传输失败为 `false`。
  - 失败时 `reason`/`err_type` 与 Try 完全同源（见 §5.2 的 12 值封闭枚举；full 直接调 `scheduler.ClassifyFailure`，hub 用 `edgeone-hub/lib/failure_reason.js` 同规则实现）；`error` 为上游原话（压缩单行、≤280 字符、已脱敏），`rid` 为上游请求 ID。
- **trace**：full 侧每次调用写一条 `RequestTrace`（`source:"probe"`、`endpoint:"/admin/test-key"`、`tries` 一条上游尝试），出现在「最近请求轨迹」并标「测试」；`obs.RecordRequest` 对 `source=="probe"` **跳过 usage.jsonl 账本**（测试不计请求量/Token）。hub 无 obs，不写 trace。
- **`last_test`**：`POST /api/admin/test-key` 返回后由后端**立即落盘**（full 通过 `config.LocalSource.PersistKeyTestState`，只写该 Key 的 `last_test`，不碰密钥/启用状态，provider 级定位因此同名 Key 不会串），无需点「保存供应商」；刷新页面/重启后仍在。前端同时把同一判定写进内存，保证无刷新时胶囊立刻更新。对象内不含密钥。

---

## 六·补 模型目录与按模型能力查询（Hub 存储 + Hub/Full 查询）

「模型目录」是 models.dev 的瘦身投影（约 1.6 MB / 235 个 provider / 8,968 个模型），只保留每个模型的 `limit{context,output}`、`reasoning`、`reasoning_options`（白名单 `type/values/min/max`）、`family`、`release_date`。它是**缓存，不是配置**：不进 `types.ProxyConfig`、不进导出/导入、也不进 `POST /api/node/config` 的投影（整包会让载荷涨约 1.6 MB，超过 EdgeOne 1 MB 请求体上限）。

**存储**：Hub 侧 KV key `model_catalog`，单值即 `shared/model-catalog/catalog.json` 原文（写入上限 4 MB，EdgeOne 单值上限 25 MB）。Full 节点侧 `<CONFIG_DIR>/model-catalog.json`（0600，原子写），缺省用内嵌 `//go:embed catalog.json.gz`。

### 6.10 Hub 目录元信息与更新
- **`GET /api/admin/model-catalog`**（仅管理员）→ `{ok, present, fetched_at, model_count, bytes}`；无目录 `present:false, fetched_at:'', model_count:0, bytes:0`。
- **`POST /api/admin/model-catalog/update`**（仅管理员，无请求体）→ 拉 `https://models.dev/api.json`（20s 超时），边缘侧瘦身、校验后写 KV。成功 `{ok:true, fetched_at, model_count, bytes}`；失败 `502 models.dev_unreachable|models.dev_invalid`、`500 catalog_invalid`。**所有失败路径都不触碰 KV**，旧目录保持原样。
- **`GET /api/admin/model-catalog/data`**（管理员凭据 **或** 有效启用的 Full 节点 Token；lite → 403）→ body 为目录原文（`content-type: application/json`、`cache-control: no-store`），无目录 404 `catalog_not_found`。
- **`GET /api/config`** 额外返回 `model_catalog_meta: {present, fetched_at, model_count}`（只有 meta）；该字段是只读投影，`sanitizeStoredConfig` 在任何保存路径把它删掉，控制台回存不会落进 KV。

### 6.11 按模型能力查询（Hub + Full，前端统一走 `HOST.modelInfo(presetId, modelId)`）
两条传输，同一份响应契约：
- **Full**：`POST /api/admin/model-catalog/lookup`，body `{preset_id, model_id}`（节点本地目录：内嵌或 Hub 同步的 cache）。
- **Hub**：`GET /api/admin/model-catalog/lookup?preset=…&model=…`（KV 目录 + 与 Go 同源的 provider-map / overrides；控制台自己渲染路由下拉与能力摘要）。

响应字段（两条一致）：
```json
{
  "ok": true, "found": true,
  "context_tokens": 1048576, "output_tokens": 393216, "reasoning": true,
  "efforts": ["low", "high", "max"], "toggle": true,
  "budget": { "min": 1024, "max": 0 }, "family": "deepseek-thinking", "release_date": "2026-08-13",
  "from_override": false
}
```
- `found:false` = **目录未收录**（不是「无能力」），调用方应回退预设规则。`efforts:null` = 无离散档位——仅开关（`toggle:true`）与 token 预算（`budget`）模型各有自己的字段，绝不伪装成档位。
- 解析顺序与 Go `internal/modelcatalog` 一致：overrides（逐字段）→ provider-map 映射的 models.dev provider（先所有候选精确匹配，再一轮大小写不敏感匹配）→ 未收录。同族兜底：`reasoning:true` 且完全没有 `reasoning_options` 时，取同 provider + 同 family、`release_date` 不晚于目标（空视为不晚于）的最新兄弟模型的 effort 档位。
- Full 侧另有 `GET /api/admin/model-catalog`（节点自身目录状态，`source: bundled|cache`）与 `POST /api/admin/model-catalog/sync`（用已存 Vault 配置里的 Hub 地址 + 节点 Token 拉取；调用方不能指定 Hub 地址）。

### 6.12 路由候选的思考档位 `reasoning_effort`
路由候选对象新增 `reasoning_effort: string`（`types.RouteCandidate`，`omitempty`）：空 = **跟随客户端**（客户端传什么就透什么），具体档位名来自上面的 `efforts`，仅开关模型用 `"on"` / `"off"`。控制台在候选行按该候选 `(provider.preset_id, target_model)` 的真实档位渲染下拉，并把它写进候选 JSON。
> **状态**：**已生效**（调度器消费）。落到请求体的规则：
> - **OpenAI 方言**（`api_type: openai-completions` 等）：写 `body.reasoning_effort = <档位>`；若模型目录对该 `(preset_id, target_model)` 有档位列表，先就近映射到模型真实支持的档位（永不降到 `none`），避免上游 400。
> - **Anthropic 方言**（`api_type: anthropic-messages` 或配了 `anthropic_base_url`）：写 `body.thinking = {type:"enabled", budget_tokens:N}`（档位→预算：minimal 1024 / low 2048 / medium 8192 / high 16384 / xhigh 24576 / max 32768，目录给了预算区间则夹到区间内）。Anthropic 要求 `budget_tokens < max_tokens`，因此**响应上限不够时整段跳过**（body 原样转发），不冒必 400 的险；客户端没给 `max_tokens` 时补 `max_tokens = 预算 + 1024`。
> - 路由开了 `no_reasoning` 时不注入（与既有的剥字段行为一致）。

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
      "preset_version": "1.4.0",
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
- `preset_id` / `preset_version` 与 `rule_hash` 同为中枢托管元数据：`preset_version` 是预设库里该预设的 `version`（未绑定为空串），节点拉取时记录到 `ProviderConfig.preset_version`，供 `GET /api/admin/providers/preset-status` 判断是否落后于中枢（见 §7.3.6）。
- `rule_hash` 由中枢按解析后的 `adapter_rules` 内容实时计算（与 `/api/vault/fetch` 下发的同一哈希）：节点存储拉取时的哈希，清单哈希与之不一致即规则漂移，控制台出现「中枢规则已更新」提示。
- `agent_models` 为**按需路由模板**：仅收录 `enabled` 的路由；按调用方模型 scope（节点 Token 的 `scope.models`，管理员视为 `["*"]`）过滤；候选必须引用在本清单 `providers` 段**存活**的供应商——已禁用或已死亡的候选被剔除，候选清零的路由整条丢弃。
- 候选携带 Key 标签（`key_label`）与单候选并发上限 `max_concurrency`（与运行时投影、节点 `RouteCandidate` 字段名一致），绝不携带明文 Key 材料。
- full 节点支持 `POST`（`hub_url`/`node_token` 走请求体，token 不进 URL 日志）；`GET` + 查询串为兼容形态。

#### 7.3.1.2 单供应商按需拉取 `POST /api/vault/fetch`
- **Request**（`key_label` / `keys` 可选——按 Key 标签补拉；**不含** `hub_url`/`node_token`，拉取目标恒为节点已配置的 Vault）:
```json
{ "provider": "minimax", "key_label": "hk-pool-01" }
```
- **Response (`200 OK`)**：`provider_config` 携带中枢托管字段（`name`/`preset_id`/`preset_version`/`api_type`/`base_url`/`anthropic_base_url`/`hide_client_name`/`adapter_rules`/`rule_hash`）与 `keys`（标签→Key材料 映射；hub 本体返回明文供中枢控制台管理，full 节点自动导入并在回显前掩码）；`imported_keys` 为本次落地的 vault Key 标签数组（full 节点附加）。**不下发 `enabled`**——供应商与 Key 的启停是节点本地运维开关。
- **`409 Conflict`（仅 full 节点）**：目标供应商本地已存在且 `origin=local`（或历史空 origin）—— 本地新建的供应商不可再从中枢拉取，须先删除/改名：
```json
{ "ok": false, "error": "provider_exists_local", "provider": "minimax" }
```
该冲突在导入时于配置锁内复核（合并前快照与落地之间同 ID 被并发改为本地供应商也会失败，不会把 vault Key 静默并入本地供应商）。
- **替换语义**：整体拉取（不带 `key_label`/`keys`）时，full 节点对已存在的 vault 供应商**整体替换中枢托管字段**（`name`/`base_url`/`anthropic_base_url`/`adapter_rules`/`preset_id`/`preset_version`/`api_type`/`hide_client_name`/`rule_hash`）与 vault Key 列表——本地删过的 Key 重新拉取即恢复，中枢删掉的 Key 本地随之消失；本地仍存在的 Key 保留其启用开关。**本地 Key（`origin="local"`）与它们的启用开关原样保留**（约定 C：本地 Key 与中枢 Key 共存于同一供应商，见 §7.3.7）。按 Key 标签补拉则为增量合并，不影响其它 vault Key，也不改动已存 Key 的启用开关。`origin="local"`（及历史空 origin）的供应商与本地 Key 永不被覆盖。
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

### 7.3.6 预设状态 `GET /api/admin/providers/preset-status`（仅 Full，v3.14 契约）
> 约定 C（2026-11）：控制台列表行的「可更新」标记与设置页「预设与中枢同步」行都读这一条端点。Hub 主机没有该能力，`host.js` 的 `HOST.getPresetStatus` 在 Hub 上不存在、相关入口也不渲染。

- **鉴权**：`ADMIN_PASSWORD`；仅 `full` 角色注册（`internal/router/readonly.go` 的 `FullOnlyRoutes`）。
- **Response (`200 OK`)**：
```json
{
  "ok": true,
  "update_count": 2,
  "providers": [
    {
      "id": "deepseek",
      "origin": "local",
      "preset_id": "deepseek",
      "current_version": "1.2.0",
      "latest_version": "1.3.0",
      "has_update": true,
      "note": ""
    },
    {
      "id": "vault-p1",
      "origin": "vault",
      "preset_id": "minimax-cn",
      "current_version": "1.4.0",
      "latest_version": "",
      "has_update": false,
      "note": "dial tcp 10.0.0.1:443: connect: connection refused"
    }
  ]
}
```
- **语义**：
  - `origin`：`local` | `vault`（历史空 origin 归为 `local`，与合并/锁定同一判定）。
  - `current_version`：本地供应商取自身 `ProviderConfig.preset_version`；中枢供应商取上次拉取时记录的值。
  - **本地供应商**的 `latest_version` 取**内置预设库**（编译进二进制的 `internal/provider/presets.go`，`/api/admin/presets-extra` 的同源）；未绑定/`custom`/库内不存在/无版本时 `latest_version=""`、`has_update=false`，`note` 写原因（「未绑定预设」「内置预设库无此预设」「预设无版本信息」）。
  - **中枢供应商**的 `latest_version` 取中枢 `/api/vault/manifest` 返回的 `preset_version`（一次 manifest 拉取覆盖全部中枢供应商，不逐个 fetch）；连不上中枢或清单未返回该供应商时 `note` 写原因、`has_update=false`。
  - `update_count` = `has_update=true` 的行数。
- 该端点**只读**：不写配置、不回传任何 Key 材料。

### 7.3.7 一键更新 `POST /api/admin/providers/sync`（仅 Full，v3.14 契约）
> **只有操作者点击才执行**：无定时器、无启动钩子、无任何自动触发。Hub 主机没有该端点。

- **鉴权**：`ADMIN_PASSWORD`；仅 `full` 角色注册（`FullOnlyRoutes`）。无请求体。
- **Response (`200 OK`，部分失败也是 200，供应商之间互不影响)**：
```json
{
  "ok": true,
  "updated": [
    { "id": "vault-p1", "from_version": "1.4.0", "to_version": "1.5.0", "keys_added": 2, "keys_removed": 1 }
  ],
  "skipped": [
    { "id": "localp", "reason": "规则已手动修改，未覆盖" }
  ],
  "errors": [
    { "id": "vault-p2", "error": "hub fetch returned HTTP 502" }
  ]
}
```
- **三类动作**：
  1. **每个中枢托管供应商（`origin=vault`）**：从中枢 `/api/vault/fetch` 整体重新拉取（地址、协议、规则、中枢 Key 全量替换），**本地 Key 与它们的启用开关原样保留**；`from_version`/`to_version` 为 `preset_version` 前后值，`keys_added`/`keys_removed` 是**中枢 Key 标签**集合的增减数（本地 Key 不计入）。
  2. **每个绑定了预设的本地供应商（`origin=local` 且 `preset_id` 在库内）**：`adapter_rules` 为空、或仍等于预设当前规则 → 换成最新预设规则并更新 `preset_version`；**手动改过的跳过**，`reason="规则已手动修改，未覆盖"`（节点不保留预设规则历史版本，因此「仍等于所记录版本」只能对当前规则求证；与当前规则不等即视为手改）。已是最新版本时跳过，`reason="已是最新版本"`。
  3. **未绑定预设的本地供应商**：按**规则 A** 尝试绑定（`preset_id="custom"` 跳过，`reason="已选择自定义（不绑定预设）"`；匹配不到跳过，`reason="未匹配到预设"`）；绑定后空规则随之采用预设规则。
- **失败隔离**：单个中枢供应商拉取失败只进 `errors`，其余照常；本地供应商的规则更新是一次原子保存，保存失败则该批全部进 `errors` 且磁盘配置不变。
- **规则 A**（三端同序同结果，实现见 `internal/admin/preset_match.go` / `edgeone-hub/lib/presetbind.js` / `shared/admin/js/app.js` 的 `matchPresetRules`）：
  1. `preset_id === "custom"` → 显式不绑，保持。
  2. 已有 `preset_id` 且预设库存在 → 保留。
  3. `base_url` 主机名（小写）等于某预设 `base_url` 主机名 → 绑定（含「{」占位符的预设跳过）；同主机命中多个预设时用 4)/5) 在这几个里挑，挑不出就不绑（不落回全库匹配）。
  4. 供应商 id（小写）等于预设 id。
  5. 供应商名称（小写、去首尾空格）等于预设名称（小写）或预设 id。
  6. 都不中 → 不绑定（界面显示「自定义」）。

### 7.3.8 中枢供应商上的本地 Key（约定 C，v3.14 契约）
- `origin="vault"` 的供应商**允许本地 Key**：`origin="local"` 的 Key 与 `origin="vault"` 的 Key **共存于同一个供应商**。本地 Key 完全可增删改（值、标签、启用开关）；中枢 Key 只读可删（沿用既有锁定：值/标签被篡改时从存储恢复，提交里缺它 = 本地删除）。
- 重新拉取（§7.3.1.2）与一键更新（§7.3.7）只替换中枢 Key；**本地 Key 与它们的启用开关原样保留**。中枢新增的 Key 若标签与本地 Key 相同，该中枢 Key 被跳过（本地 Key 优先，不产生同标签双份）。
- **同标签冲突**：向中枢供应商保存一个与中枢 Key 同标签（Label 或 ID 相同）的**本地 Key**，`POST /api/config` 返回：
```json
{ "ok": false, "error": "key_label_conflict", "label": "hk-pool-01" }
```
HTTP `400`。校验在写盘前、Kernel Guard 之前完成，配置不被改动（Go 侧 `config.KeyLabelConflictError`）。同一供应商内两把本地 Key 同标签同样 400。

### 7.4 管理端可见的凭据范围
- `GET /api/config` 对上游供应商 `api_keys[].key` 一律掩码（`sk-●●●●●●xxxx`）。
- `settings.client_key`（网关客户端 Key）**按设计明文返回**：管理员需要该值配置 Cursor/Claude 等客户端，控制台"网关接入中心"直接展示。该接口本身受管理员鉴权保护，不得在未鉴权响应、日志或 traces 中出现。
- Full 节点 `admin_password` 与（v3.10 起）`node_token` **均明文存于中枢 KV 并随凭据端点返回**（运营者明确选择的私有部署取舍，见 §2.1 / §2.4）。`token_sha256` 仍是唯一鉴权依据；`sanitizeNode` 在列表/安装载荷中剥离明文字段。凭据端点响应带 `Cache-Control: no-store`，不得在任何中间层缓存。

---

## 八、 前端单文件构建预算与门禁规范

- 前端控制台源码统一位于 `shared/admin/`，通过 `node shared/admin/build.mjs` 构建为内嵌单一单页 HTML（输出至 `shared/admin/dist/index.html` 与 `internal/admin/assets/index.html`）。
- 打包体积硬门禁：**`≤ 384 KiB`（`393,216 bytes`）**（执行 G4 门禁校验与 T1 合同测试；2026-11-26 由 320 KiB 重标——预设与中枢同步入口（`getPresetStatus`/`syncProviders`）、本地 Key 与中枢 Key 共存编辑器等本轮 UI 的真实字节成本；2026-11-22 曾由 240 KB 重标为 320 KiB，见 v20261122-06 CHANGELOG）。
- 零内联样式（严禁 `style="` 与 `.style.xxx`）、零 Drawer 抽屉（全部行内展开 `.editor`）、零彩色左边框条、原生 `[hidden]` 显隐控制。
- **流程纪律**：任何对 `shared/admin/` 源码（`admin.html` / `js/*` / `css/*`）的改动，必须当场跑 `npm run test:admin`（含全部体积/样式门禁并再生成 dist、`internal/admin/assets`、`admin/index.html` 与 `edge-functions/_hub` 同步产物）；只跑 `verify:release` 之类的下游产物校验不算数——下游校验看到的是上一次构建的陈旧产物，门禁失败会被静默漏掉。

