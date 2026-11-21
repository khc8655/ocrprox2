# Magpie 源码稳定性审计与“白名单级”复用矩阵

> ⚠️ **本文是 2026-11-08 的「要不要搬」决策审计，不是现状清单。**
> 本仓实际搬运了什么、本地改了什么、上游改到哪一步、如何跟着升级，一律以
> **[`MAGPIE_UPSTREAM_SYNC.md`](./MAGPIE_UPSTREAM_SYNC.md)** 和机器可读的
> [`magpie-baseline.json`](./magpie-baseline.json) 为准（核对工具：`node scripts/magpie-sync.mjs check`）。
> 本文正文保留当时的论证与数据；下表列出与代码不符之处（§7 有完整清单）。
>
> | 本文中的说法 | 2026-11-21 核对结果 |
> |---|---|
> | 搬运了 `internal/filememo/` | 本仓从未有此包 |
> | 精简提取 `internal/access` | 本仓从未有此包 |
> | `internal/upstream/sse.go` 来自 `gateway/sse.go` | 无此文件；SSE 语义在 `internal/scheduler/peek.go`，独立实现 |
> | `internal/obs/usage.go` ~250 行 | 实际 1,245 行，思想借鉴、实现独立 |
> | `internal/crypto` ~100 行 | 实际 254 行，且信封格式与上游**不兼容** |
> | `internal/netguard` 458 行 | 实际 277 行 |

> **核心结论（基于 Git 历史实证审计）**：
> 通过对 `yetone/magpie` 最近 **1,000 次提交（仅 7 天内就发布了 `v0.1.2560` ~ `v0.1.3294` 共 734 个版本，日均 >100 次提交）** 进行文件级变更频率（Churn Rate）与缺陷分析，我们发现 `magpie` 内部呈现极端的**“两极分化”**：
> 1. **上层业务与网关大泥球（Red Zone · 严禁搬运）**：`internal/gui`（7 天 387 次提交）、`internal/gateway/gateway.go`（单文件 10,321 行，7 天改 109 次）、`fallback.go`（4,631 行，7 天改 32 次）、`routing.go`（2,471 行，7 天改 26 次）、`provider`（7 天 252 次提交）。**原因**：它们把各家逆向订阅（Claude Code/Kiro/Antigravity/ZCode）和厂商特例全部用 `if/else` 硬编码在万行巨型文件里，天天破防、天天打补丁；甚至 `netproxy` 自定义的 10s HTTP/2 Ping 昨天刚引发 `GOAWAY too_many_pings` 断流事故（`#970a86ff`）。
> 2. **底层标准库基础设施（Green Zone · 彻底稳定、可安全搬运）**：`netguard`、`steady`、`lastgood`、`filelock`、`filememo`、`readonly.go`、`sse.go` 等纯 Go 标准库微模块（每个仅 100~300 行），**在过去 734 个版本中几乎是 0 修改（Frozen & Battle-Tested）**！
>
> **因此，本项目的复用铁律修正为**：**只搬运 Magpie 已经彻底沉淀稳定的底层标准库微模块（~1,600 行，734 版本 0 缺陷），严禁引入其高频变动的 `gateway`/`routing`/`fallback`/`netproxy` 大泥球；核心调度、冷却与声明式适配引擎 100% 以我们已稳定运行的 1 代 `ocrprox` 为蓝本用干净的 Go 实现！**

---

## 一、 Magpie 最近 1,000 次提交（7 天 734 个版本）变更热度实测数据

| 模块 / 文件 | 代码行数 | 近 1000 次提交修改次数 | 稳定性评级 | 审计结论与处置策略 |
|---|---:|---:|---|---|
| `internal/netguard/netguard.go` | 97 行 | **0 次** (仅分支合并基线) | 🟢 **极度稳定 (Frozen)** | **整包搬运**：纯 `net/netip` SSRF 地址段判定，已完全收敛 |
| `internal/gateway/image_fetch_guard.go` | 361 行 | **0 次** | 🟢 **极度稳定 (Frozen)** | **直接搬运**：DNS 解析后 IP Pinning + `Dialer.Control` 防 DNS Rebinding |
| `internal/lastgood/lastgood.go` | 276 行 | **0 次** | 🟢 **极度稳定 (Frozen)** | **整包搬运**：防配置文件损坏内存快照与 `.corrupt` 备份自愈 |
| `internal/filelock/filelock.go` | 116 行 | **0 次** | 🟢 **极度稳定 (Frozen)** | **整包搬运**：跨进程 `syscall.Flock` 文件互斥锁 |
| `internal/filememo/filememo.go` | 317 行 | **0 次** | 🟢 **极度稳定 (Frozen)** | **整包搬运**：按 `(mtime, size)` 缓存反序列化结果 |
| `internal/steady/steady.go` | 225 行 | **1 次** (`#4938` 清理残留 `.tmp`) | 🟢 **极度稳定 (Frozen)** | **整包搬运**：跨平台原子写文件（Temp + Fsync + Chmod + Rename） |
| `internal/backup` (加解密函数) | ~100 行 | **0 次** (加密逻辑零改动) | 🟢 **极度稳定 (Frozen)** | **直接搬运**：纯标准库 `PBKDF2-SHA256 + AES-256-GCM` |
| `internal/gateway/readonly.go` | 108 行 | **0 次逻辑改动** (仅白名单增删路径) | 🟢 **极度稳定 (Frozen)** | **直接搬运**：只读路由白名单守卫 + `routeMux` 未登记路由单测报错机制 |
| `internal/gateway/sse.go` | 148 行 | **1 次** (`#8c733bb3` 识别裸 JSON 错误行) | 🟢 **极度稳定 (Frozen)** | **直接搬运**：轻量级 SSE 行扫描器与 `: keepalive` 保活 |
| `internal/applog/applog.go` | 234 行 | **0 次** | 🟢 **极度稳定 (Frozen)** | **整包搬运**：纯标准库 5MB 双文件自动轮转（`app.log`/`app.old.log`）+ 20 行内置 `scrub()` 密钥正则脱敏 + `debug.SetCrashOutput` 崩溃捕获 |
| `internal/gateway/trace.go` (路由轨迹环存思想) | ~120 行 | **核心结构稳定** | 🟢 **高度稳定** | **精简提取 (~120 行)**：`traceKeep = 60` 内存环形缓冲区，完整记录单次请求内 `Tries []Try` 的多跳故障转移回放（哪把 Key 先试、为何失败、哪把 Key 最终成功） |
| `internal/usage` (仅 `usage.jsonl` 账本与聚合层) | ~250 行 (剥离本地客户端 Session 扫描后) | **核心账本结构稳定** | 🟡 **取其核心账本，剥离桌面端杂项** | **提取核心 ~250 行**：复用其 `usage.jsonl` 单句柄追加写账本（`heldLog`）与按时段（`today`/`7d`/`30d`）+ 时区聚合为 `Models / Providers / Keys` 三张表的清爽设计，彻底替代 1 代烂尾的 `stats_data.json` + `agent_metrics.json` 双 JSON 全量覆写 |
| `internal/gateway/gemini_schema.go` | 336 行 | **1 次** | 🟢 **高度稳定** | **函数级借鉴**：与 1 代 `gemini_compat.py` 的 `_sanitize_gemini_schema` 结合 |
| `internal/access` | ~1,100 行 | **8 次** (均为新增 Browser/MCP 字段，核心 SHA256/Scope 0 Bug) | 🟡 **核心稳定，外围膨胀** | **精简提取 (~250 行)**：只取 `sha256` 常量时间比对、子 Key TTL 与 Scope 交集折叠算法，剥离 Browser/MCP/Desktop 逻辑 |
| `internal/netproxy` | ~1,100 行 | **8 次** (**含 `#970a86ff` HTTP/2 Ping 导致上游 `GOAWAY` 断流 Bug**) | 🔴 **存在稳定性隐患，拒绝搬运** | **放弃搬运，改用 Go 标准库原生能力**：Go 标准库 `net.Dialer{FallbackDelay: 300ms}` 原生自带 RFC 6555 Happy Eyeballs（IPv6 不通 300ms 自动无感切 IPv4），无需引入 `netproxy` 易出错的自定义 HTTP/2 Ping 探活！ |
| `internal/redact` | ~900 行 | **16 次** (因捆绑本地 NER 模型高频调优误杀词表) | 🔴 **频繁变动，拒绝整包搬运** | **放弃搬运**：直接移植 1 代 `logger_utils.py` (142 行) 的确定性正则/Header 脱敏 + `Mask()`，简单可靠零误杀 |
| `internal/gateway/routing.go` & `fallback.go` | 7,102 行 | **58 次 / 7 天** | 🔴 **重度泥球，严禁搬运** | **严禁搬运代码**：内部充斥 ZCode/Antigravity/Kiro 等硬编码补丁；我们 **100% 沿用 1 代 `scheduler.py` 架构**，仅吸收其 `forbiddenAlike`（双 Key 同错免误伤）这一条算法思想（约 30 行 Go 代码） |
| `internal/gateway/gateway.go` & `ir.go` 等 | 16,000+ 行 | **140+ 次 / 7 天** | 🔴 **重度泥球，严禁搬运** | **严禁搬运代码**：1 代本身就是高性能同构透传（`/v1/chat/completions`、`/v1/messages`）+ 声明式 `shared/presets/*.json` + `gemini_compat.py`，无需套一层 1.6 万行的 IR 转换大泥球 |

---

## 二、 修正后的“黄金组合”边界：哪些拿 Magpie？哪些用 1 代？

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                   LLMProxy2 (Go) 黄金代码来源边界                            │
├──────────────────────────────────────┬──────────────────────────────────────┤
│   来自 Magpie 的 20%（纯底层基石）    │     来自 1 代 ocrprox 的 80%（业务内核）│
│   特点：734 个版本 0 修改、纯标准库    │     特点：生产已验证、声明式、逻辑清晰  │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ 1. netguard + DNS Pinning (~450行)   │ 1. EdgeOne 轻中枢 + Vault 归属隔离     │
│ 2. steady 原子文件写 (~225行)         │ 2. Lazy-Once + Lease + 304 零轮询同步 │
│ 3. lastgood 防损坏快照 (~276行)       │ 3. 声明式 adapter_rules 引擎 (presets) │
│ 4. filelock 跨进程锁 (~116行)         │ 4. Gemini 2.5/3.x 兼容层 (374行转Go)  │
│ 5. filememo 缓存层 (~317行)          │ 5. 300s 预算 + Sticky/RR + 三级冷却   │
│ 6. AES-256-GCM 标准库加密 (~100行)   │ 6. 流式首包 Peek + 45s 预提交保活      │
│ 7. readonly.go 路由白名单守卫 (108行) │ 7. 预读信号量 + 20MB 零拷贝流式 OCR   │
│ 8. sse.go 基础流扫描器 (148行)        │ 8. 时段自动切换器 (mode_scheduler)    │
│ 9. access 常量时间 SHA256 比对思想    │ 9. MiniMax OAuth Device Flow + 保活  │
│ 10. forbiddenAlike 同错免封算法思想   │ 10. shared/admin 单一前端与契约门禁    │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

---

## 三、 逐模块最终实施方案（拒绝任何不稳定代码进入仓库）

### 3.1 直接搬运的 Magpie 冻结级微模块（白名单，共约 1,650 行，全部 0 第三方依赖）

| 目标路径 (`llmproxy2`) | 源路径 (`yetone/magpie`) | 行数 | 近 734 版本改动 | 作用 |
|---|---|---:|---:|---|
| `internal/netguard/` | `internal/netguard/netguard.go` + `internal/gateway/image_fetch_guard.go` | 458 | **0 次** | SSRF 私网/云元数据/Fake-IP 阻断 + DNS 解析后直接拨号 Pinning |
| `internal/steady/` | `internal/steady/steady.go` | 225 | **1 次** | Full 模式原子文件写入（Temp + Chmod 0600 + Fsync + Rename） |
| `internal/lastgood/` | `internal/lastgood/lastgood.go` | 276 | **0 次** | 配置防损坏快照与 `.corrupt` 自动备份恢复 |
| `internal/filelock/` | `internal/filelock/filelock.go` + `lock_unix.go` | 116 | **0 次** | 跨进程 OS 文件锁 |
| `internal/filememo/` | `internal/filememo/filememo.go` | 317 | **0 次** | 基于 `mtime + size` 的零重复反序列化内存缓存 |
| `internal/crypto/` | `internal/backup/crypto.go` (加解密函数) | ~100 | **0 次** | 标准库 `PBKDF2-SHA256 + AES-256-GCM`（外加 50 行 1 代 Fernet 兼容解密） |
| `internal/router/readonly.go` | `internal/gateway/readonly.go` | 108 | **0 次** | `lite` 模式物理级只读路由守卫 + `routeMux` 未登记路由单测直接报错 |
| `internal/upstream/sse.go` | `internal/gateway/sse.go` | 148 | **1 次** | SSE 事件流读取、裸错误 JSON 识别与 `: keepalive` 写入 |
| `internal/obs/applog.go` | `internal/applog/applog.go` | 234 | **0 次** | 20 行内置 `scrub()` 正则密钥脱敏 + `full` 模式 5MB 双文件自动轮转（`lite` 模式仅挂 `stderr` 零落盘） |
| `internal/obs/trace.go` | `internal/gateway/trace.go` (精简) | ~120 | **0 Bug** | `traceKeep = 60` 内存环形缓冲区，记录每次请求 `Tries []Try` 完整故障转移轨迹与耗时拆解 |
| `internal/obs/usage.go` | `internal/usage/usage.go` + `usageapi.go` (核心账本) | ~250 | **0 Bug** | `usage.jsonl` 保持句柄追加写账本 + 按 `today/7d/30d` 与浏览器时区聚合的模型/供应商/Key 统计 |

### 3.4 统计与日志重构：彻底抛弃 1 代双端妥协烂账，全面采用 Magpie 三层清爽架构

1 代 (`ocrprox`) 的统计与日志之所以体验极差，根本原因是**当时为了强行兼容 EdgeOne KV (`nodestat:agent:...`) 与 VM 本地文件，搞出了 `stats_data.json` + `agent_metrics.json` 两套割裂的 JSON 全量覆写机制**，不仅每 2 秒全量序列化重写磁盘文件，而且遇到重试（Failover）时只记最后一把 Key 的结果，中间哪把 Key 报了 429/502 被跳过完全是黑盒。

在 2 代 (`llmproxy2`) 中，**EdgeOne (`hub`) 已经彻底不再转发任何 `/v1/*` 流量**，完全卸下了兼容 KV 统计的历史包袱！因此我们在 `internal/obs/` 中 **100% 借鉴 `magpie` 的“三层轻量可观测体系”**：

1. **第一层：运行与崩溃日志 —— 直接搬运 `magpie/internal/applog/applog.go`（234 行，734 版本 0 改动）**
   - **零泄漏内置脱敏（`scrub`）**：`applog.go` 自带极其精炼的 20 行正则脱敏器，在 `Write(p []byte)` 写盘或输出到 `stderr` 前自动将 `Bearer ***`、`?key=***`、`sk-***`、`AIza***`、`eyJ***` (JWT) 抹除。
   - **双文件定长自轮转（5 MiB 上限）**：`full` 模式下将标准库 `log` 与 Go runtime 崩溃栈（`debug.SetCrashOutput`）同时 Tee 到 `stderr` 和 `app.log`（权限 `0600`），满 `5 MiB` 自动重命名为 `app.old.log`，磁盘永远最多只占 `10 MiB`，绝不撑爆磁盘。
   - **`lite` 极简模式零落盘适配**：当 `--role=lite` 时，不打开任何磁盘文件，仅将 `applog.scrub` 挂载到 `os.Stderr`，既享受 100% 密钥脱敏，又严格遵守 NAT 小鸡零落盘铁律。
2. **第二层：请求与 Token 流水账 —— 借鉴 `magpie/internal/usage` 的 `usage.jsonl` 追加写账本（~250 行）**
   - 废除 1 代 `stats_data.json` 和 `agent_metrics.json` 的定时全量覆写！
   - 每完成一次请求，向打开的 `usage.jsonl` 句柄追加一行紧凑 JSONL（`Record`）：
     ```json
     {"t":1762566012,"mode":"agent","ep":"/v1/chat/completions","req":"claude-sonnet-4-20250514","served":"MiniMax-M2.5","provider":"minimax","key_id":"hk-01","in":1420,"out":380,"cache_read":1024,"reasoning":120,"ms":1840,"ttft_ms":420,"retried_ms":310,"status":200,"tries":2}
     ```
   - 内存维护按天/按模型的轻量级累加桶，支持前端按周期（`today` 今日 / `7d` 近7天 / `30d` 近30天 / `all` 全部）和浏览器本地时区（`?tz=Asia/Shanghai`）秒级聚合出 **按模型 (`Models`)**、**按供应商与 Key (`Providers & Keys`)** 的请求数、成功率、输入/输出/缓存/思考 Token 数、平均延迟与 TTFT。
3. **第三层：最近 60 次请求故障转移回放 —— 借鉴 `magpie/internal/gateway/trace.go`（`traceKeep = 60`）**
   - 这是 `magpie` 最实用、最能解决 1 代排障痛点的设计：在内存中维护一个容量为 **60 条** 的环形缓冲区（`[]RequestTrace`），不仅记录最终结果，还完整记录该请求经历的每一次尝试（`Tries []Try`）：
     - 例如：`Try #1: minimax / hk-pool-01 -> 429 rate_limit (310ms, 已触发模型级冷却 15s)` ➡️ `Try #2: minimax / hk-pool-02 -> 200 OK (TTFT 420ms, Total 1530ms)`。
   - 在 Web UI 的「状态与日志 (Activity)」页中，管理员点击任意一条请求行，即可**行内原地展开（`.editor`）**查看完整的 `Try #1 -> Try #2` 故障转移链路与脱敏错误响应体，一眼看清调度器为什么切 Key、哪把 Key 出了什么问题！

### 3.2 NAT VM 网络栈：用 Go 标准库原生双栈与 Happy Eyeballs 替代不稳定的 `netproxy`

针对 `magpie/internal/netproxy` 近期因自定义 HTTP/2 Ping 引发 `GOAWAY too_many_pings` 的教训，我们在 `internal/upstream/transport.go` 中采用 **100% Go 标准库原生稳健方案（约 120 行）**：
1. **入站双栈监听（源自 1 代 `run_server.py`）**：`net.ListenConfig` 设置 `syscall.IPV6_V6ONLY = 0` 绑定 `::`，单端口同时服务 IPv4 与 IPv6。
2. **出站 IPv6 黑洞无感回退（Go 标准库 RFC 6555 Happy Eyeballs）**：
   - Go 标准库的 `net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second, FallbackDelay: 300 * time.Millisecond}` **原生内置了工业级 Happy Eyeballs 状态机**——当域名同时有 AAAA (IPv6) 和 A (IPv4) 记录时，若 IPv6 在 **300ms** 内未完成握手，Go 标准库会自动并发发起 IPv4 连接并采用先连通者！
   - 配合我们在 `netguard` Pinning Dialer 中保留全部解析出的公网 IPv6 + IPv4 地址切片按序快速回退，既享受 SSRF DNS Pinning，又具备原生 300ms IPv6 黑洞回退能力，**零自定义连接池 Bug**。

### 3.3 协议适配与复杂厂商支持：1:1 移植 1 代已验证的声明式引擎 + `gemini_compat`

为什么前任 Agent 觉得 `google` / `vertex` / `amd` 难写想放进 `unsupported[]`，而我们不需要搬运 Magpie 1.6 万行的 `gateway.go` 也能 100% 支持？
- 因为在 1 代 `ocrprox` 中，这部分代码其实非常精炼且边界清晰：
  1. `vm-app/app/gemini_compat.py` **总共只有 374 行 Python**！只做四件事：
     - `reasoning_effort` → Gemini 2.5 `thinking_budget` / Gemini 3.x `thinking_level` 映射；
     - Vertex AI `thought_tag_marker: "thought"` 注入与 `_ThoughtSplitter` 流式 `<thought>` 标签状态机切分；
     - Tool Call `{id}:::{thought_signature}` 无状态拼接与还原（外加 2000 条 LRU 内存兜底）；
     - 结合 `magpie/internal/gateway/gemini_schema.go`（336 行，734 版本仅 1 次改动）的递归 JSON Schema 清洗（剥离 `$schema`/`additionalProperties`/`$defs`）。
  2. `vm-app/app/proxy_routes.py` 中的 `_apply_request_adapter_rules` **总共不到 350 行**！完整驱动 `shared/presets/*.json` 的 16 家厂商规则（含 AMD 的 `strip_reasoning_enabled`、Anthropic 的 `strict_signature` / `passback_required`、`stream_only` SSE 聚合、`rescue_from_text`）。
- 将这 **~700 行已经在 1 代生产环境千锤百炼的逻辑** 1:1 转写为强类型 Go 代码（放入 `internal/adapters/`），既有 **100% 完整协议支持（无任何 `unsupported[]`）**，又彻底远离了 Magpie `gateway.go` 每天改十几遍的泥潭！

---

## 四、 开源合规要求（MIT License 声明）

对上述列入白名单搬运的 8 个 `yetone/magpie` 微模块（共约 1,650 行）：
1. 在 `THIRD_PARTY_NOTICES` 中完整保留 `Copyright (c) 2026 yetone` 与 MIT 许可证全文；
2. 在对应 `.go` 文件头部标注来源注释；
3. **一次性静态迁入本仓库 `internal/` 下由我们自己的 `go test -race` 锁定维护**，不通过 `go.mod` 动态依赖上游 `magpie` 主干，从物理上隔绝上游日常高频更新带来的任何连锁波动。
