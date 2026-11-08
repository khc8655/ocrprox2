# CLAUDE.md — LLMProxy2 (OCRProxy v2) AI 代理入口与工程宪法

> 本文件是 AI 代理与开发者进入 `llmproxy2` 仓库的第一入口。任何代码编写、架构调整与文档修改必须严格遵守本文件规定的优先级与红线。

---

## 0. 主从 Agent 协作开发模式（最高调度准则）

1. **主 Agent（总架构师与总验收官）职责**：
   - 负责全局架构规划、规范文档维护、按 [`docs/MULTI_AGENT_BLUEPRINT.md`](file:///Users/xk/Documents/llmproxy2/docs/MULTI_AGENT_BLUEPRINT.md) 拆解并下发无冲突子任务（`W0` ~ `W6`）；
   - **主 Agent 不直接编写业务实现代码**，全部代码实现与单元/集成测试交由子代理（Subagents）执行；
   - 待子代理完成开发与自测后，由主 Agent 负责**最终统一集成验证、契约审查与 G1~G6 门禁终审**。
2. **子 Agent（代码与测试执行官）配置规范**：
   - 调用 `invoke_subagent` 时，统一指定 **`Model: "flash"`（对应 Gemini Flash High 档位）** 与 `TypeName: "self"`；
   - 每个子 Agent 严格限制在其分配的 `Workstream`（`W0`~`W6`）独占文件目录内编写代码并运行 `-race` 测试验证，严禁跨界修改其它 Workstream 的文件。

---

## 1. 冲突裁决优先级（最高铁律）

当文档、注释或历史方案出现不一致时，严格按以下优先级裁决：

1. **可执行契约与 Schema**：`internal/types/types.go` + `shared/config/settings.schema.json` + `shared/config/runtime-profiles.json` + `shared/contracts/*.json` + 自动化门禁测试（`tests/` & `go test ./...`）
2. **多 Agent 协作与接口锁死蓝图**：[`docs/MULTI_AGENT_BLUEPRINT.md`](file:///Users/xk/Documents/llmproxy2/docs/MULTI_AGENT_BLUEPRINT.md)（定义了全局唯一 Go 结构体、跨包接口签名与 W0~W6 物理文件所有权边界，任何 Agent 开工前必读！）
3. **核心规范文档**：[`docs/SYSTEM_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SYSTEM_DESIGN_SPEC.md)、[`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md)、[`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md)、[`docs/SECURITY_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SECURITY_SPEC.md)、[`docs/ADMIN_UI_BACKEND_CONTRACT.md`](file:///Users/xk/Documents/llmproxy2/docs/ADMIN_UI_BACKEND_CONTRACT.md)
4. **工程准则**：[`ARCHITECTURE_STANDARDS.md`](file:///Users/xk/Documents/llmproxy2/ARCHITECTURE_STANDARDS.md)
5. **其它说明文档**：`README.md`、历史归档或旧草案

**铁律**：发现文档与可执行契约冲突时，以可执行契约和测试为准，并当场同步更新文档。

---

## 2. “只取冻结级基石，拒引高频变动泥球”：Magpie 源码复用强制准则

本项目是 **1 代 (`ocrprox`) 已验证的稳定业务模型（80%）** 与 **`yetone/magpie` 底层冻结级标准库微模块（20%）** 的结合体。
实测 `magpie` 在 7 天内提交了 1,000 次（734 个版本），其变更高度集中在 `gui`、`provider` 以及 `gateway/{gateway,fallback,routing}.go` 等逆向订阅与硬编码特例大泥球中；而其底层标准库微模块在 734 个版本中几乎 **0 修改**（详见 [`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md)）。因此必须严格执行以下红白名单：

1. **🟢 白名单：直接搬运的 Magpie 冻结级标准库微模块（共约 1,880 行，734 版本 0 缺陷，0 第三方依赖）**：
   - SSRF 防护与 DNS Pinning：`magpie/internal/netguard` (97 行，0 修改) + `magpie/internal/gateway/image_fetch_guard.go` (361 行，0 修改)。
   - 原子文件存储与防损坏（Full 模式）：`magpie/internal/steady` (225 行)、`lastgood` (276 行，0 修改)、`filelock` (116 行，0 修改)、`filememo` (317 行，0 修改)。
   - 标准库加解密：`magpie/internal/backup/crypto.go` 的 `PBKDF2-SHA256 + AES-256-GCM` 实现（~100 行，0 修改）。
   - 路由只读白名单守卫与流扫描器：`magpie/internal/gateway/readonly.go` (108 行，含 `routeMux` 未登记路由单测报错机制) 与 `sse.go` (148 行)。
   - 日志脱敏与三层可观测性：`magpie/internal/applog/applog.go` (234 行，0 修改，20 行 `scrub` 正则脱敏 + 5MB 双文件轮转)、`trace.go` (`traceKeep = 60` 多跳故障转移轨迹回放)、`usage.jsonl` 单句柄追加写账本。
   - 局部算法借鉴：`access` 的 SHA-256 常量时间比对、`gemini_schema.go` 的 Schema 递归清洗函数、`routing.go` 的 `forbiddenAlike` 双账号同错免误封思想（约 30 行）。
2. **🔴 黑名单：严禁搬运的 Magpie 高频变动模块（Red Zone）**：
   - **严禁搬运** `magpie/internal/gateway/{gateway,fallback,routing,ir,chat,anthropic,claude_subscription}.go`（1.7 万行巨型文件，7 天改动 160+ 次，充斥硬编码逆向补丁）；
   - **严禁搬运** `magpie/internal/netproxy`（其自定义 10s HTTP/2 Ping 刚引发慢思考模型 `GOAWAY too_many_pings` 断流 Bug；NAT VM 出站 IPv6 黑洞回退直接使用 Go 标准库原生 `net.Dialer{FallbackDelay: 300ms}` RFC 6555 Happy Eyeballs）；
   - **严禁通过 `go.mod` 动态依赖上游 `magpie` 仓库**：白名单微模块一次性静态考入本仓 `internal/`，由本仓测试锁定，彻底隔绝上游日更百次的波动。
3. **1 代 (`ocrprox`) 核心业务的 1:1 干净 Go 转译**：
   - `adapters`（1:1 转译 1 代 `proxy_routes.py` 声明式 `adapter_rules` + `gemini_compat.py` 374 行，**完整支持 Google/Vertex/Anthropic/AMD，严禁搞 `unsupported[]` 阉割**）；
   - `scheduler`（1:1 转译 1 代 `scheduler.py` 300s 预算、Sticky/RR/Manual、三级冷却、流式首包 `_peek_until_payload` + 45s 预提交保活）；
   - `hubsync`（EdgeOne `lazy-once + lease` 零轮询按需拉取 + ETag/304 续租 + 401 `PurgeMemory` 内存销毁）；
   - `kb`（预读入场信号量 `ocr_max_inflight` + 20MB 零拷贝分片流式 OCR + `/v1/embeddings` + `/v1/rerank`）；
   - `modesched`（`agent` ↔ `kb` 时段边沿切换 + 活跃请求优雅排空 + HMAC Webhook）；
   - `oauth`（MiniMax Code Plan RFC 8628 OAuth Device Flow + PKCE + 6h 保活 + 401 强制刷新重试）。
4. **开源许可合规**：凡复用 `yetone/magpie` 白名单微模块源码，必须在仓库根目录 `THIRD_PARTY_NOTICES` 及二进制 `//go:embed` 中保留 MIT License 声明（见 [`docs/EXTERNAL_REFERENCES.md`](file:///Users/xk/Documents/llmproxy2/docs/EXTERNAL_REFERENCES.md)）。

---

## 3. 三端职责与不可逾越的边界

1. **EdgeOne Makers（`hub` 角色）**：
   - **只做**：供应商与 Key（Vault Hub）管理、预设适配规则管理、VM 节点的**签发（Issue `NODE_TOKEN`）与注销/吊销（Revoke）**、被动响应 `POST /api/node/config` 配置投影、托管管理端 UI。
   - **绝不做**：不再提供 `/v1/*` 推理代理、不再接收定时心跳、不再主动连接任何 VM。
2. **NAT VM 极简客户端（`--role=lite`）**：
   - **只做**：Agent 数据面代理（`/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/responses`）、首次真实请求触发拉取配置（`lazy-once + lease`）、租约到期 `If-None-Match` 304 续租。
   - **绝不做**：**绝不落盘任何配置或明文/密文 Key**、绝不挂载 `/api/admin/*` 或任何写接口、绝不启动后台轮询或心跳定时器；收到中枢 `401` 或租约宽限期耗尽立即清空内存并停服（返回 `503`）。
3. **标准 VM 完整客户端（`--role=full`）**：
   - **全功能**：本地加密配置持久化（权威源，离线可用）、完整 Web 管理端、支持管理员手动从 EdgeOne 拉取增量 Key（保留 `origin="vault"` vs `origin="local"` 隔离）、完整支持 `agent` + `kb` 双模式、OCR 队列、时段调度与 OAuth 登录。

---

## 4. 单一真源（SSOT）与设置项生效契约

1. **前端唯一源码与 Magpie 极简风格铁律**：
   - 所有管理端 UI 仅在 `shared/admin/` 编写，构建产物禁止手改；
   - **彻底摒弃 1 代臃肿 UI（禁止 Drawer 抽屉、禁止多层弹窗、禁止彩色左边框、禁止 JS 内联 `style=`）**，严格遵循 [`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md) 的 Magpie 极简设计语言（`One Quiet Surface` + `.list/.row` + 行内原地展开 `.editor` + 原生 `[hidden]` 控制显隐，单文件打包体积 `≤ 80KB`）；
   - `HOST.capabilities` 严格按 `hub` / `lite` / `full` 真实能力位声明。
2. **配置与预设唯一源码**：`shared/config/settings.schema.json`、`shared/config/runtime-profiles.json`、`shared/presets/*.json`。
3. **设置项新增/修改六步契约**：
   - Step 1：更新 `shared/config/settings.schema.json`；
   - Step 2：更新 `shared/config/runtime-profiles.json` 默认值；
   - Step 3：更新 `shared/admin/` 表单控件与保存逻辑；
   - Step 4：Go 节点与 EdgeOne 中枢读取同名 canonical key；
   - Step 5：补充契约测试与行为单测；
   - Step 6：同步更新 `docs/` 规范文档。
   - **禁止复活已废弃字段**：`request_total_budget_sec`、`max_retries`、`max_attempts_per_provider`（硬总超时固定为 `300s`）。

---

## 5. 发布与提交门禁（G1~G6）

任何代码提交与版本发布前，必须确保以下门禁全绿（详见 [`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md)）：

- **G1 版本一致性**：`version.json`、Git Tag、二进制内嵌版本与构建产物一致；
- **G2 零构建漂移**：运行 `npm run build:admin` 后工作区无未提交的生成物差异；
- **G3 契约完整性**：前后端路由契约、节点投影契约、只读路由白名单守卫（`routeMux`）100% 通过；
- **G4 Profile 与 Schema 一致性**：`settings.schema.json` 与 `runtime-profiles.json` 双向对齐；
- **G5 三层测试全绿**：`go test -race ./...` + T1（契约）+ T2（单元）+ T3（E2E，含中枢请求次数断言与 Lite 零落盘扫描）；
- **G6 文档同步与工作区洁净**：代码、测试、文档、`CHANGELOG.md` 同批更新。
