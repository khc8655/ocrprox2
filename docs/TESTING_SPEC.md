# 测试体系规范 (Testing Specification — T1 / T2 / T3)

> **核心目标**：用自动化测试锁死架构契约、安全红线与性能基线，确保从 1 代 Python 迁移到 2 代 Go × Magpie 内核后 **100% 功能等价、零安全退化、零轮询计费泄露**。

---

## 一、 三层测试金字塔总览

项目继承并升级 1 代的三层测试架构，所有测试通过 `npm run test:full`（或分层命令）统一编排：

```text
                  ┌──────────────────────────────────────────┐
                  │       T3: 黑盒端到端测试 (E2E Suite)        │
                  │  真实编译 Go 二进制 (lite & full) + 模拟上游 │
                  │  验证：零轮询计数、零落盘扫描、双栈、OCR压测  │
                  └────────────────────┬─────────────────────┘
                                       │
            ┌──────────────────────────┴───────────────────────────┐
            │         T2: 单元测试与并发竞争检测 (Unit & Race)        │
            │  Go: go test -race ./internal/... (含 Magpie 搬运包)  │
            │  Hub: Node.js 测试 EdgeOne 节点签发/投影/304/吊销逻辑   │
            └──────────────────────────┬───────────────────────────┘
                                       │
     ┌─────────────────────────────────┴──────────────────────────────────┐
     │              T1: 静态契约与 Schema 门禁测试 (Contract < 5s)          │
     │  settings.schema ↔ runtime-profiles ↔ admin UI ↔ Go/JS 读取点对齐  │
     │  readonly.go routeMux 路由白名单守卫 · 预设 JSON 完整性校验           │
     └────────────────────────────────────────────────────────────────────┘
```

---

## 二、 T1：静态契约与 Schema 校验层（目标耗时 `< 5s`，零网络）

| 测试项 ID | 校验内容 | 失败判定条件 |
|---|---|---|
| **`T1.settings_contract`** | 扫描 `shared/config/settings.schema.json`、`runtime-profiles.json`、`shared/admin/js/settings*.js` 与 Go `internal/config/`、EdgeOne `edgeone-hub/` | 任何设置项未在 Schema 登记、默认值不一致、或复活了已删除字段（`request_total_budget_sec` 等）立即变红 |
| **`T1.admin_ui_contract`** | 校验 `shared/contracts/admin-ui-backend.json` 中声明的所有 API 路径、请求方法和响应字段 | `edgeone-hub` 或 Go `internal/admin` 缺失契约路由，或前端引用了不存在的 `data-cap` 能力位 |
| **`T1.presets_integrity`** | 校验 `shared/presets/*.json` 与生成的 `catalog.json` 的 Schema 合法性及 `rule_hash` 一致性 | JSON 语法错误、未知 `adapter_rules` 键或构建产物漂移 |
| **`T1.readonly_route_guard`** | 执行 Magpie 搬运的 `internal/router/readonly_test.go` (`routeMux` 门禁) | 任何新注册到 HTTP `ServeMux` 的路由未显式在 `allowedLiteRoutes` 或 `fullOnlyRoutes` 登记 |
| **`T1.ui_layout_and_zero_inline_style`** | 扫描 `shared/admin/` 全部 `.html`、`.css`、`.js` 文件（执行 [`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md) 五大硬门禁） | 出现任何 `style="` 或 `.style.display` 内联样式、出现 `.drawer` 组件、出现左边框彩条，或打包总大小 `> 80KB` |
| **`T1.hub_export_guard`** | AST/静态检查 `edgeone-hub/` | 若 `edgeone-hub` 仍残留 `/v1/*` 路由或未对 `origin === "local"` 执行物理过滤则变红 |

---

## 三、 T2：单元测试与并发竞争检测层（目标耗时 `< 30s`）

全部 Go 单测强制开启 **`-race`（并发数据竞争检测器）**：`go test -race ./internal/...`

| 测试包 / 模块 | 核心测试覆盖点 |
|---|---|
| **`internal/netguard` & `internal/upstream`** | 1. IPv4/IPv6 私网、Loopback、`::ffff:127.0.0.1`、云元数据 `169.254.169.254`/`100.100.100.200`、Clash Fake-IP `198.18.0.1`/`fc00::1` 拦截；<br>2. DNS Rebinding 模拟（第一次解析公网、第二次解析内网，验证 Pinning 生效）；<br>3. Go 标准库 Happy Eyeballs（300ms IPv6 黑洞自动切 IPv4）与 `sse.go` 裸 JSON 错误行扫描。 |
| **`internal/auth` & `internal/obs`** | 1. 四权分立凭据隔离（`ADMIN_PASSWORD`/`NODE_TOKEN`/`CLIENT_KEY` 互不可越权）与 Loopback 强制鉴权；<br>2. `applog.go` 的 `scrub()` 对 `sk-*`、`Bearer`、`?key=`、`AIza*`、`eyJ*` 100% 脱敏及 5MB 双文件自动轮转；<br>3. `usage.go` (`usage.jsonl` 追加写与按 `today/7d/30d` + 时区聚合) 与 `trace.go` (`traceKeep=60` 环形覆盖与 `Tries[]` 多跳故障转移记录)。 |
| **`internal/hubsync` (Lazy-Once + Lease)** | 1. **零轮询断言**：启动后静置，断言 Hub 收到 `0` 次请求；<br>2. **并发首请求合并（Singleflight）**：50 个并发客户端请求同时到达未激活节点，断言 Hub 仅收到 **严格 1 次** `POST /api/node/config`；<br>3. **304 续租**：租约到期后携带 `ETag` 请求，收到 `304` 后零载荷延长 `lease_until`；<br>4. **401 即刻销毁**：收到 `401` 后 `RuntimeSnapshot` 立即为 `nil` 且原 Key 字节切片被清零；<br>5. **宽限期（Grace Period）**：Hub 502 时在 `grace_ttl` 内保留 `lastgood`，超期后自动清空停服。 |
| **`internal/adapters` (声明式规则 + Gemini 兼容)** | 使用 `shared/contracts/adapter_fixtures.json` 驱动：<br>1. 16 家厂商预设规则（`stream_only` SSE 聚合、`rescue_from_text`、`unwrap_root`、Anthropic `strict_signature`/`passback_required`、AMD `strip_reasoning_enabled`）逐一回归；<br>2. Gemini 2.5 `thinking_budget` 与 3.x `thinking_level`、`<thought>` 流式拆分、`{id}:::{thought_signature}` 往返保持、Magpie `gemini_schema.go` 递归清洗。 |
| **`internal/scheduler`** | 1. 300s 硬总超时、`sticky_failover` vs `round_robin` vs `manual`；<br>2. 三级冷却（模型级 / Key 级 24h / 410 Gone）与 `key_bans.json` 持久化；<br>3. **Magpie `forbiddenAlike` 双账号同错免误伤自愈测试**（验证坏请求不会把所有 Key 打入冷却）；<br>4. 流式首包 Peek（拦截 200 OK 流内 `{"error":...}` 与空流 `[DONE]` 并无感换 Key）及 45s `: keep-alive` 预提交。 |
| **`internal/kb` & `modesched` & `oauth` & `config`** | 1. OCR 预读信号量（超出 `ocr_max_inflight` 在读 body 前即回 429）与零拷贝多 Key 重试重放；<br>2. 时段切换边沿触发、活跃请求优雅排空、同日手动覆盖记忆、HMAC Webhook；<br>3. OAuth PKCE Device Flow 轮询、提前 5m 刷新与 401 强制刷新重试；<br>4. 1 代 Fernet `proxy_config.enc` 自动解密并升级为 AES-256-GCM + Kernel Guard 防 `●` 覆盖。 |

---

## 四、 T3：黑盒端到端与 Instabox 云端 Linux VM 对标压测层（1 代 Python vs 2 代 Go）

除本地进程测试外，本项目引入 **Instabox 云端 Linux VM（Debian 13 / Kernel 6.18 / Docker cgroup 内存限制）** 作为真实 Linux 黑盒验证与 1 代 (`ocrprox`) vs 2 代 (`llmproxy2`) 正面对标实验室：

### 4.1 云端 VM 对标验证目标（方向正确性实证）
在 Instabox 云端 Linux VM 中同时部署 **1 代 Python (`ocrprox`)** 与 **2 代 Go (`llmproxy2`)**，并在 `docker run -m 64m`（64MB 物理内存硬上限容器，1:1 模拟极限 NAT 小鸡）下进行残酷黑盒对比：
1. **内存占用硬对标（Memory Footprint）**：
   - 采集 Linux `/proc/<pid>/status` 的 `VmRSS` / `VmHWM` 与容器 `memory.current`：
   - 验证 **1 代 Python** 在空载（~95MB）与并发流式请求下触发 64MB 容器 OOM-Killed (Exit 137)；
   - 验证 **2 代 Go (`--role=lite`, `GOMEMLIMIT=48MiB`)** 在空载（`< 15MB`）、100 并发 SSE 流式长连接与 20MB 大载荷下 **全程零 OOM、RSS 稳定在 `12MB ~ 32MB`**。
2. **高并发与故障注入稳定性对标（Stability & Chaos）**：
   - **上游混沌故障注入**：模拟上游随机返回 `429 Rate Limit`、`502 Bad Gateway`、`200 OK` 但 SSE 流内夹带 `{"error":...}`、空流 `[DONE]`、慢首字超时、以及连续客户端坏请求（验证 `forbiddenAlike` 免误封自愈）；
   - **NAT 双栈与 IPv6 黑洞回退**：在云端 Linux 环境模拟 IPv6 路由黑洞，实测 300ms Happy Eyeballs 无感回退 IPv4；
   - **吞吐量与尾延迟（P50 / P95 / P99 Gateway Overhead）**：对比 1,000 次请求下 1 代 Python vs 2 代 Go 的网关自身转发开销、FD 句柄泄漏与 Goroutine 收敛情况。

### 4.2 T3 标准黑盒用例

启动真实编译出的 `bin/llmproxy` 进程（分别以 `--role=lite` 和 `--role=full` 启动）+ 本地/云端 Mock EdgeOne Hub + Mock 上游 LLM Server：

1. **`T3.lite_zero_disk_and_budget`（NAT 极简节点专项验收）**：
   - 发送 1,000 次客户端 `/v1/chat/completions`（流式 + 非流式）与 `/v1/messages` 请求：
     - **断言 1（计费保护）**：Mock Hub 被调用的总次数 **严格等于 1**（首次激活）；
     - **断言 2（零落盘扫描）**：扫描测试进程工作目录、临时目录、日志输出与进程内存转储控制位（`RLIMIT_CORE == 0`），确保磁盘上 **0 字节**包含上游测试 Key（如 `sk-test-upstream-secret-999`），且未生成 `app.log` 或 `usage.jsonl`；
     - **断言 3（吊销生效）**：在 Mock Hub 将该节点设为 `enabled=false` 并令租约过期，发送第 1,001 次请求，断言节点立即返回 `503` 且内存 Key 已清零。
2. **`T3.dual_stack_and_happy_eyeballs`（NAT 双栈与出站回退验收）**：
   - 验证单进程 `::` 监听同时响应 `http://127.0.0.1:<port>/v1/models` 与 `http://[::1]:<port>/v1/models`；
   - 模拟上游 IPv6 地址连接黑洞，验证 `internal/upstream/transport.go` 在 300ms 内自动切 IPv4 成功返回推理结果。
3. **`T3.full_mode_matrix_e2e`（完整节点全矩阵验收）**：
   - 关闭 Mock Hub（模拟中枢彻底断网），验证 `full` 节点凭本地加密配置正常完成 Agent 聊天、模式切换至 KB、20MB 大图片流式 `/v1/ocr`、`/v1/embeddings`、`/v1/rerank`、`/api/admin/usage` 统计与 `/api/admin/traces` 多跳重试轨迹回放。

---

## 五、 1 代 21 项测试向 2 代测试套件的迁移映射表

| 1 代测试文件 (`ocrprox/tests/`) | 2 代对应落点 (`llmproxy2`) | 演进方式 |
|---|---|---|
| `test_admin_contract.py` / `test_runtime_profiles.py` / `test_settings_schema.py` / `verify_presets_integrity.py` / `verify_ui_layout.py` | `tests/t1_contracts/` | 保留并扩展支持 `hub/lite/full` 三角色 + Magpie 极简 UI 零内联样式门禁 |
| `test_edgeone_export_guard.py` / `test_vault_sync.py` / `test_vault_key_isolation.py` | `tests/t2_hub/` | 升级为校验 `/api/node/config` Scope 隔离、`origin=local` 阻断与 304 续租 |
| `test_scheduler_p1_fixes.py` / `test_stream_turn_integrity.py` | `internal/scheduler/*_test.go` | 转化为 Go `-race` 单测 + 新增 `forbiddenAlike` 自愈单测 |
| `test_gemini_compat.py` / `test_agent_dual_engine.py` | `internal/adapters/*_test.go` | 转化为 Go 声明式规则 + Gemini 兼容层 Fixtures 单测 |
| `test_oauth_credentials.py` / `verify_security_redlines.py` | `internal/oauth/*_test.go` & `internal/auth/*_test.go` | 转化为 Go 单测 |
| `verify_gateway_e2e.py` / `test_all_endpoints.py` / `test_dual_stack.py` / `test_kb_queue_and_models.py` / `verify_fixes.py` | `tests/t3_e2e/` | 对真实 `bin/llmproxy` (`lite` & `full`) 进程执行黑盒 E2E 验证 |
