# 前后端与节点通信契约规范 (Admin UI & Node Contract)

> **核心原则**：前端只有一份源码（`shared/admin/`），全面采用 [`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md) 定义的 **Magpie 极简列表+行内展开（Inline Editor）设计规范**；配置只有一份 Schema（`shared/config/settings.schema.json`），所有跨端接口由可执行契约文件（`shared/contracts/*.json`）与门禁测试 G3/G4 强力约束。

---

## 一、 三角色宿主适配器契约（`HOST.capabilities`）

`shared/admin/js/host.js` 将运行环境归纳为三种标准角色（`window.__HOST_KIND__`），前端严禁通过 URL 猜测环境，一律通过 `HOST.capabilities` 控制 UI 模块显隐（`data-cap="<capName>"`）：

| 能力位 (`HOST.capabilities`) | `hub` (EdgeOne Makers 中枢) | `full` (Go 完整节点) | `lite` (Go 极简节点 — 无 UI) | 说明 |
|---|:---:|:---:|:---:|---|
| `vaultHub` | `true` | `false` | — | 供应商与 Key 中枢管理、区分 `origin: vault/local` |
| `nodeManager` | `true` | `false` | — | **2代新增**：VM 节点的 Token 签发、Scope 配置、注销与 `last_seen` 状态查看 |
| `vaultClient` | `false` | `true` | — | Full 节点手动从 EdgeOne 中枢拉取供应商、增量加 Key、同步规则 |
| `runModes` | `false` | `true` | — | `agent` ↔ `kb` 运行模式切换与时段自动调度器 |
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
- **Response (`200 OK`)**：返回一次性明文 `node_token`（后续查询不再返回明文，KV 仅存 `token_sha256`）及一键启动命令模板：
```json
{
  "ok": true,
  "node": { "id": "node_jp_02", "name": "日本 NAT 极简节点", "enabled": true },
  "node_token": "stk_node_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a",
  "bootstrap_env": "LLMPROXY_ROLE=lite LLMPROXY_HUB_URL=https://hub.example.com LLMPROXY_NODE_TOKEN=stk_node_9f8e... LLMPROXY_CLIENT_KEY=sk-llmproxy-..."
}
```

### 2.3 注销/吊销、恢复、轮换与删除节点
- **吊销/启用**：`PATCH /api/admin/nodes/:id` `{ "enabled": false, "scope": {...}, "lease_ttl": 3600 }`
- **轮换 Token**：`POST /api/admin/nodes/:id/rotate` → 生成新 `node_token`，旧 Token 立即失效。
- **删除节点**：`DELETE /api/admin/nodes/:id` → 物理移除 KV 中的节点记录。

---

## 三、 节点按需配置投影契约（`POST /api/node/config`）

受 `NODE_TOKEN`（`Authorization: Bearer <NODE_TOKEN>`）保护，遵循零轮询、被动响应原则：

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
