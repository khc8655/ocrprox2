# ARCHITECTURE_STANDARDS.md — 核心架构准则与工程铁律

> 本规范定义了 `llmproxy2`（OCRProxy 2.0）的七大最高架构原则。所有模块设计、代码复用、安全边界与测试门禁均以此为准绳。

---

## 准则一：1 代成熟业务架构（80%） × Magpie 冻结级微模块（20%）

1. **定位清晰**：本项目以 **1 代 `ocrprox` 经过生产验证的业务语义与声明式架构** 为核心主体（80%），仅从 `yetone/magpie` 中择优引入已经彻底沉淀、长期零缺陷的**底层标准库微模块**（20%）。
2. **稳定性防火墙（只取冻结级基石，拒引高频变动泥球）**：
   - 经对 `magpie` 近 1,000 次提交（7 天 734 个版本）的审计：只允许静态迁入在 734 个版本中 **0 缺陷 / 0 修改** 的底层标准库微模块（`netguard` + DNS Pinning、`steady`、`lastgood`、`filelock`、`filememo`、`crypto` AES-256-GCM、`readonly.go` 守卫、`sse.go` 扫描器，共约 1,650 行，详见 [`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md)）。
   - **严禁搬运** `magpie` 内部日更数十次的巨型泥球代码（如 10,321 行的 `gateway.go`、4,631 行的 `fallback.go`、2,471 行的 `routing.go` 以及曾触发 `GOAWAY too_many_pings` 断流的 `netproxy` 自定义 Ping 探活器）。
   - 核心调度（`scheduler`）、声明式适配（`adapters`）与 Gemini/Vertex 兼容层（`gemini_compat`）100% 按照 1 代已稳定运行的 Python 逻辑 1:1 干净转写为 Go，彻底废除前任方案的 `unsupported[]` 阉割。
3. **零 CGO 静态编译**：Go 节点必须保持 `CGO_ENABLED=0`，不引入 SQLite C 绑定、不引入 Wails 桌面依赖、不动态 `go get` 依赖 `magpie` 主干，确保单二进制可在 64MB 内存的 NAT VM 上直接启动且不受上游频繁更新影响。

---

## 准则二：EdgeOne 极致轻量化与“零轮询、零心跳”铁律

1. **EdgeOne 彻底退出 `/v1/*` 数据面**：
   - EdgeOne Makers 站点仅承担 **控制面与凭据中枢（Vault Hub）** 职责：维护供应商、API Key、预设适配规则，以及管理 VM 节点的签发（Issue）与注销/吊销（Revoke）。
   - 客户端推理流量 100% 直连 VM 节点（`lite` 或 `full`），彻底消除 EdgeOne 25s 流式空闲超时、900KB 请求体上限与边缘函数双倍请求计费问题。
2. **被动中枢模型（Zero Polling, Zero Heartbeat）**：
   - EdgeOne 按请求次数计费，且 NAT VM 通常无固定公网入站 IP。
   - **严禁**在 Go 节点中编写任何 `time.Ticker` 去定时轮询 EdgeOne 配置或发送心跳包。
   - **严禁**在 EdgeOne 中枢编写任何主动连接/推送 VM 节点的逻辑。
   - 节点状态（`last_seen`、`last_config_version`）仅在节点因真实业务请求触发条件拉取（`POST /api/node/config`）时顺带被动更新。

---

## 准则三：NAT VM 极简模式（`lite`）纯内存零落盘铁律

针对租用、合租或借用的不可信 NAT VM 环境，`--role=lite` 必须满足最高等级的数据防泄漏要求：

1. **Zero-Disk（零落盘）**：
   - 上游供应商 API Key、中枢下发的配置快照、运行时冷却状态、请求统计**全部只驻留在进程内存（`atomic.Pointer[RuntimeSnapshot]`）**。
   - 严禁向磁盘（含工作目录、`/tmp`、`~/.config`、日志、swap/core dump）写入任何明文或密文形式的供应商 Key。
   - 进程启动时强制执行 `setrlimit(RLIMIT_CORE, 0)` 禁用 Core Dump。
2. **Lazy-Once + Lease（按需懒加载与租约节流）**：
   - 进程启动时不请求 EdgeOne（空载等待）；当第一个通过 `CLIENT_KEY` 鉴权的真实客户端请求到达时，使用 `NODE_TOKEN` 调用一次 `POST /api/node/config` 完成首次激活与密钥拉取。
   - 在租约有效期（`lease_ttl`，默认 `24h`，可按节点配置为 `1h`~`24h`）内，后续所有请求 100% 走内存快照，对 EdgeOne 发起 **0 次请求**。
   - 租约到期后的首个请求携带 `If-None-Match: <etag>` 发起条件拉取：配置未变时中枢返回 `304 Not Modified`（仅响应头更新 `X-Lease-Until`，零 JSON 载荷传输）。
3. **Fail-Closed 吊销与断联停服**：
   - 若中枢返回 `401 Unauthorized` / `403 Forbidden`（节点已被注销/吊销或 Token 过期），节点**立即将内存 Snapshot 置空（触发 GC 回收明文 Key）**，并拒绝后续一切请求（返回 `503 Node Revoked`）。
   - 若租约到期时发生网络故障，允许在短宽限期（`grace_ttl`）内沿用 `lastgood` 内存快照；宽限期耗尽仍无法联系中枢续租，则自动清空内存并停服。
4. **物理级只读路由守卫**：
   - `lite` 模式在路由注册层不挂载 `/api/admin/*`、`/api/config` 等任何管理路由，并强制包裹 Magpie 的 `readonly.go` 白名单守卫（`routeMux`）。

---

## 准则四：标准 VM 完整模式（`full`）离线自治与增量协同

针对自有主力生产服务器，`--role=full` 继承 1 代全部生产特性：

1. **本地加密存储为唯一权威源**：
   - 配置与密钥通过标准库 `PBKDF2-SHA256 + AES-256-GCM`（兼容迁移 1 代 Fernet `proxy_config.enc`）原子加密存储在本地磁盘（权限 `0600`）。
   - **Kernel Guard（内核防脱敏覆盖守卫）**：保存配置时自动拦截前端传回的脱敏占位符（`●`、`***`、`********`），严禁将真实密钥覆盖为掩码字符。
2. **离线完全可用**：
   - 即使 EdgeOne 中枢完全断网或未配置，Full 节点依靠本地加密配置依然 100% 正常提供代理与本地 Web 管理服务。
3. **按需显式拉取与 `origin` 归属隔离**：
   - 仅当管理员在 Full 节点的 Web 管理端显式点击“从 EdgeOne 中枢拉取/同步”时才发起网络请求。
   - 严格区分 `origin: "local"`（本地私有密钥，绝不上传或被中枢覆盖）与 `origin: "vault"`（中枢同步密钥，连接参数受保护、支持一键同步适配规则）。

---

## 准则五：四权分立与最小权限凭据体系

系统内存在四类完全正交的凭据，**严禁混用或平权访问**，所有比对必须采用 `crypto/subtle.ConstantTimeCompare`：

| 凭据名称 | 作用域 | 持有方与校验方 | 存储方式 |
|---|---|---|---|
| **`ADMIN_PASSWORD`** | 管理端控制台与 `/api/admin/*`、`/api/config` | 管理员浏览器 → EdgeOne Hub 或 Go Full 节点 | 环境变量；带防爆破 IP 速率限制（5 次失败锁定 600s） |
| **`NODE_TOKEN`** | `POST /api/node/config`（节点激活与拉取配置） | Go Lite/Full 节点 → EdgeOne Hub | 每台 VM 节点独立签发（`stk_node_<48hex>`）；中枢仅存 `sha256` 摘要、绑定 `scope`（允许的 providers/models）与 `enabled` 状态 |
| **`CLIENT_KEY`** | 客户端数据面 `/v1/*` | 下游 AI 客户端 → Go Lite/Full 节点 | 复用 Magpie `internal/access`；**全来源强制鉴权（含 `127.0.0.1`/`::1`）**，支持按 Key 限制可用模型与配额 |
| **`ENCRYPT_KEY`** | Full 节点本地配置加解密 | Go Full 进程内部 | 环境变量；通过 PBKDF2 派生 AES-256-GCM 密钥 |

---

## 准则六：单一真源（SSOT）与声明式适配

1. **`shared/` 单一真源**：
   - `shared/admin/`：唯一管理端前端源码，构建生成 EdgeOne 与 Go Full 内嵌静态资源。
   - `shared/presets/*.json`：唯一供应商声明式规则源（URL 拼接、Header 注入、参数清洗、模型别名、错误分类）。
   - `shared/config/settings.schema.json` & `runtime-profiles.json`：唯一配置 Schema 与三端（`hub` / `lite` / `full`）默认参数源。
2. **两层声明式适配架构（Declarative Rules + Gemini/Anthropic 专项兼容层）**：
   - 第一层（厂商声明式规则层 `internal/adapters/rules.go`）：由 `shared/presets/*.json` 声明式规则驱动 URL 拼接、Header 注入、参数清洗/重命名、`stream_only` SSE 聚合、`rescue_from_text`、Anthropic `strict_signature` / `passback_required` 等，业务路由代码中**严禁硬编码 `if provider == "xxx"`**。
   - 第二层（Gemini / Vertex 专项兼容层 `internal/adapters/gemini.go`）：1:1 移植 1 代 `gemini_compat.py`（Thinking 矩阵映射、`<thought>` 流式状态机切分、`{id}:::{thought_signature}` 无状态透传）并融合 Magpie 稳定的 `gemini_schema.go`（JSON Schema 递归清洗），**严禁阉割任何 1 代已支持的供应商到 `unsupported[]`**。

---

## 准则七：三层测试与六道自动化发版门禁（G1~G6）

日常改动走快速迭代（`npm run check`），发版才跑 G1~G6（`npm run verify:release`）。两条车道与按改动挑测试的规则见 [`AGENTS.md`](./AGENTS.md) 第 2–3 节；门禁检查项见 [`docs/RELEASE_SPEC.md`](./docs/RELEASE_SPEC.md)，测试分层见 [`docs/TESTING_SPEC.md`](./docs/TESTING_SPEC.md)。
