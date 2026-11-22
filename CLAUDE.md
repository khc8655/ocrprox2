# CLAUDE.md — LLMProxy2 (OCRProxy v2) AI 代理入口与工程宪法

> 本文件是 AI 代理与开发者进入 `llmproxy2` 仓库的第一入口。任何代码编写、架构调整与文档修改必须严格遵守本文件规定的优先级与红线。

---

## 1. 冲突裁决优先级（最高铁律）

当文档、注释或历史方案出现不一致时，严格按以下优先级裁决：

1. **可执行契约与 Schema**：`internal/types/types.go` + `shared/config/settings.schema.json` + `shared/config/runtime-profiles.json` + `shared/contracts/*.json` + 自动化门禁测试（`tests/` & `go test ./...`）
2. **核心接口与模块契约蓝图**：[`docs/MULTI_AGENT_BLUEPRINT.md`](file:///Users/xk/Documents/llmproxy2/docs/MULTI_AGENT_BLUEPRINT.md)（定义了全局唯一 Go 结构体、跨包接口签名与模块文件边界）
3. **核心规范文档**：[`docs/SYSTEM_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SYSTEM_DESIGN_SPEC.md)、[`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md)、[`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md)、[`docs/SECURITY_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SECURITY_SPEC.md)、[`docs/ADMIN_UI_BACKEND_CONTRACT.md`](file:///Users/xk/Documents/llmproxy2/docs/ADMIN_UI_BACKEND_CONTRACT.md)、[`docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md`](file:///Users/xk/Documents/llmproxy2/docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md)
4. **工程准则**：[`ARCHITECTURE_STANDARDS.md`](file:///Users/xk/Documents/llmproxy2/ARCHITECTURE_STANDARDS.md)
5. **其它说明文档**：`README.md`、历史归档或旧草案

**铁律**：发现文档与可执行契约冲突时，以可执行契约和测试为准，并当场同步更新文档。

---

## 2. “只取冻结级基石，拒引高频变动泥球”：Magpie 源码复用强制准则

本项目是 **1 代 (`ocrprox`) 已验证的稳定业务模型（80%）** 与 **`yetone/magpie` 底层冻结级标准库微模块（20%）** 的结合体。
实测 `magpie` 在最近 7 天提交了 721 次（共 4,618 个 tag），其变更高度集中在 `gateway/gateway.go`（7 天 59 次）以及 `routing.go`/`fallback.go` 等逆向订阅与硬编码特例大泥球中；而其底层标准库微模块同期 **0 修改**（`lastgood` 已 37 天未动）。**现状台账与升级流程见 [`docs/MAGPIE_UPSTREAM_SYNC.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_UPSTREAM_SYNC.md)，机器可读基线见 [`docs/magpie-baseline.json`](file:///Users/xk/Documents/llmproxy2/docs/magpie-baseline.json)，核对命令 `node scripts/magpie-sync.mjs check`。**（[`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md) 是 2026-11-08 的决策审计，仅供背景，其中个别条目与代码不符已在该文顶部标出。）

复用关系必须按下面四类登记，**A/B 类要出现在 `docs/magpie-baseline.json`，C 类要在代码注释里写上游文件 + 函数名**，否则视为来源不明代码：

1. **🟢 A 类 · 逐字节搬运（可直接覆盖升级，10 个文件 + 3 个手工 main_test）**：
   - 原子文件存储与防损坏（Full 模式）：`magpie/internal/steady` (225 行)、`lastgood` (276 行)、`filelock` (94+22+23 行) 及其测试 —— 目前与本仓**逐字节一致**（`lastgood.go` 仅 import 路径改写 1 行）。
   - 注意：**不存在** `filememo`（早期文档误记，本仓从未引入）。
2. **🟡 B 类 · 搬运后本地改造（升级需三路合并）**：
   - `internal/obs/applog.go` ← `magpie/internal/applog`：保留 `scrub` 规则表 + 5MB 双文件轮转；去掉 `appdir`/GUI 生命周期；新增 `lite` 零落盘。
   - `internal/netguard/netguard.go` ← `magpie/internal/netguard` + `gateway/image_fetch_guard.go`：保留地址段判定；新增 DNS Pinning + Happy Eyeballs；去掉供应商 client / Loon 配对逻辑。
   - `internal/router/readonly.go` ← `magpie/internal/gateway/readonly.go`：保留 `routeMux` 未登记路由即报错 + 只读守卫；白名单以本仓为准。
3. **🟠 C 类 · 语义同源（独立实现，禁止整文件拷贝，只读上游提交后改我们自己的实现）**：
   - `scheduler/lanes.go` ← `gateway/concurrency.go`（lane 结构 + 「满则排队、排队不算失败」+ `laneMate`/`waitMate` 等价物：排队中被唤醒即重走候选表、取第一个有余量的 key）
   - `scheduler/rpm.go` ← `gateway/rpm.go`；`scheduler/errorbody.go` ← `routing.go` `carriedStatus` + `fallback.go` `namedStatus`；`scheduler/cooldown.go` ← `forbiddenAlike`；`scheduler/peek.go` ← `gateway/sse.go`
   - `obs/trace.go` ← `gateway/trace.go`（仅 60 条环形回放思想）；`obs/usage.go` ← `internal/usage`（jsonl 账本思想）
   - `crypto` ← `internal/backup` 的信封**算法**（格式串不同、互不兼容，无跟随义务）
   - 标准库加解密：`magpie/internal/backup` 的 `PBKDF2-SHA256 + AES-256-GCM` 实现（本仓 `internal/crypto`，另有 50 行 1 代 Fernet 兼容解密）。
   - 局部算法借鉴：`routing.go` 的 `forbiddenAlike` 双账号同错免误封思想（约 30 行）、`gemini_schema.go` 的 Schema 递归清洗函数。
4. **🔴 D 类 · 严禁搬运的 Magpie 高频变动模块（Red Zone）**：
   - **严禁搬运** `magpie/internal/gateway/{gateway,fallback,routing,ir,chat,anthropic,claude_subscription}.go`（1.7 万行巨型文件，7 天改动 160+ 次，充斥硬编码逆向补丁）；
   - **严禁搬运** `magpie/internal/netproxy`（其自定义 10s HTTP/2 Ping 刚引发慢思考模型 `GOAWAY too_many_pings` 断流 Bug；NAT VM 出站 IPv6 黑洞回退直接使用 Go 标准库原生 `net.Dialer{FallbackDelay: 300ms}` RFC 6555 Happy Eyeballs）；
   - **严禁通过 `go.mod` 动态依赖上游 `magpie` 仓库**：白名单微模块一次性静态考入本仓 `internal/`，由本仓测试锁定，彻底隔绝上游日更百次的波动。
5. **1 代 (`ocrprox`) 核心业务的 1:1 干净 Go 转译**：
   - `adapters`（1:1 转译 1 代 `proxy_routes.py` 声明式 `adapter_rules` + `gemini_compat.py` 374 行，**完整支持 Google/Vertex/Anthropic/AMD，严禁搞 `unsupported[]` 阉割**）；
   - `scheduler`（1:1 转译 1 代 `scheduler.py` 300s 预算、Sticky/RR/Manual、三级冷却、流式首包 `_peek_until_payload` + 45s 预提交保活）；
   - `hubsync`（EdgeOne `lazy-once + lease` 零轮询按需拉取 + ETag/304 续租 + 401 `PurgeMemory` 内存销毁）；
   - `kb`（预读入场信号量 `ocr_max_inflight` + 20MB 零拷贝分片流式 OCR + `/v1/embeddings` + `/v1/rerank`）；
   - `modesched`（`agent` ↔ `kb` 时段边沿切换 + 活跃请求优雅排空 + HMAC Webhook）；
   - `oauth`（MiniMax Code Plan RFC 8628 OAuth Device Flow + PKCE + 6h 保活 + 401 强制刷新重试）。
6. **开源许可合规**：凡复用 `yetone/magpie` A/B 类源码，必须在仓库根目录 `THIRD_PARTY_NOTICES` 及二进制 `//go:embed` 中保留 MIT License 声明（见 [`docs/EXTERNAL_REFERENCES.md`](file:///Users/xk/Documents/llmproxy2/docs/EXTERNAL_REFERENCES.md)）。升级前先跑 `node scripts/magpie-sync.mjs check`，流程见 `docs/MAGPIE_UPSTREAM_SYNC.md` §4。

---

## 3. 三端职责与不可逾越的边界

1. **EdgeOne Makers（`hub` 角色）**：
   - **只做**：供应商与 Key（Vault Hub）管理、预设适配规则管理、VM 节点的**签发（Issue `NODE_TOKEN`）与注销/吊销（Revoke）**、被动响应 `POST /api/node/config` 配置投影、托管管理端 UI。
   - **绝不做**：不再提供 `/v1/*` 推理代理、不再接收定时心跳、不再主动连接任何 VM；**本仓已封存并移除 MCP / 扩展服务（`search_providers`、`verify-search-key`、`mcp_url` 等）**，保持纯粹的 LLM Proxy + Hub 定位。
2. **NAT VM 极简客户端（`--role=lite`）**：
   - **只做**：Agent 数据面代理（`/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/responses`）、首次真实请求触发拉取配置（`lazy-once + lease`）、租约到期 `If-None-Match` 304 续租。
   - **绝不做**：**绝不落盘任何配置或明文/密文 Key**、绝不挂载 `/api/admin/*` 或任何写接口、绝不启动后台轮询或心跳定时器；收到中枢 `401` 或租约宽限期耗尽立即清空内存并停服（返回 `503`）。
3. **标准 VM 完整客户端（`--role=full`）**：
   - **全功能**：本地加密配置持久化（权威源，离线可用）、完整 Web 管理端、支持管理员手动从 EdgeOne 拉取增量 Key（保留 `origin="vault"` vs `origin="local"` 隔离）、完整支持 `agent` + `kb` 双模式、OCR 队列、时段调度与 OAuth 登录。

---

## 4. 单一真源（SSOT）与设置项生效契约

1. **前端唯一源码与 Magpie 极简风格铁律**：
   - 所有管理端 UI 仅在 `shared/admin/` 编写，构建产物禁止手改；
   - **彻底摒弃 1 代臃肿 UI（禁止 Drawer 抽屉、禁止多层弹窗、禁止彩色左边框、禁止 JS 内联 `style=`）**，严格遵循 [`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md) 的 Magpie 极简设计语言（`One Quiet Surface` + `.list/.row` + 行内原地展开 `.editor` + 原生 `[hidden]` 控制显隐，单文件打包体积 `≤ 252 KB`（`258,048 bytes`））；
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
4. **设计先行变更铁律（Design-First Change Rule）**：
   - **跨端交互与契约优先**：在修改跨端实现（前后端交互 API、中枢与节点通信、核心数据结构）前，必须先行更新设计规范与机器可读契约：
     - 若修改管理端 UI 与后端的交互 API：必须先同步更新 [`docs/ADMIN_UI_BACKEND_CONTRACT.md`](file:///Users/xk/Documents/llmproxy2/docs/ADMIN_UI_BACKEND_CONTRACT.md) 与可执行契约 [`shared/contracts/admin-ui-backend.json`](file:///Users/xk/Documents/llmproxy2/shared/contracts/admin-ui-backend.json)；
     - 若调整 Go 节点数据结构或跨包核心接口：必须先同步更新 [`docs/MULTI_AGENT_BLUEPRINT.md`](file:///Users/xk/Documents/llmproxy2/docs/MULTI_AGENT_BLUEPRINT.md) 与 `internal/types/types.go`；
     - 若涉及外部依赖平台机制或边缘限制：必须将平台约束先行沉淀至 [`docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md`](file:///Users/xk/Documents/llmproxy2/docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md) 或 [`docs/EXTERNAL_REFERENCES.md`](file:///Users/xk/Documents/llmproxy2/docs/EXTERNAL_REFERENCES.md)，严禁未经契约定义直接编写跨端实现代码。
5. **开源仓库与测试数据安全红线（Public Repository & Test Data Redlines）**：
   - **零真实凭据与敏感数据**：严禁在 Git 工作区或 Git 提交历史中出现任何真实生产域名、密码、私钥、或真实节点令牌（`stk_node_*`）；单元测试与 E2E 仅允许使用 `0123456789abcdef` / 全零等合成 Mock 字符串；
   - **测试快照与测试产物隔离**：所有针对线上 EdgeOne Hub 或外部平台的实机集成测试（T4 级测试）、冒烟脚本、测试快照（如 `before_*.json`、`after_*.json`、`matrix_results.json`、`live_hub_test_report.md`）必须严格放置在仓库根目录外的 `scratch/` 外部临时目录中运行，严禁污染或提交至 Git 仓库。

---

## 5. 四层测试体系与五步双轨发布流程

### 5.1 四层测试金字塔（T1 ~ T4）

项目实行严格的四层分层测试架构（详见 [`docs/TESTING_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/TESTING_SPEC.md)）：

- **T1：静态契约与 AST 门禁层（Contract & Guard < 5s，零网络）**：
  - `T1.settings_contract`：`settings.schema` ↔ `runtime-profiles` ↔ Go `types.go` 1:1 对齐与已废弃字段阻断；
  - `T1.admin_ui_contract`：前后端路由契约与 `HOST.capabilities` 声明一致性；
  - `T1.presets_integrity`：16 家厂商预设与 `catalog.json` 哈希防篡改；
  - `T1.readonly_route_guard`：Go `internal/router/readonly.go`（`routeMux` 路由白名单单测报错机制）；
  - `T1.ui_layout_and_zero_inline_style`：单文件控制台零内联样式、零抽屉、零左边框彩条、打包体积 `≤ 252 KB`（`258,048 bytes`）；
  - `T1.hub_export_guard`：EdgeOne `edge-functions/` 纯 Web Standard 检查（零 `node:*` 引用、零 `Buffer`、无边界逃逸）与 AST 显式 `export function onRequest*` 路由扫描门禁。
- **T2：单元测试与并发竞争检测（Unit & Race < 30s）**：
  - `edgeone-hub/test/hub.test.mjs`：中枢 CAS 乐观锁、Scope 投影、304 续租、节点签发/吊销/轮换；
  - `go test -race ./...`：Go 全包并发数据竞争检测（覆盖 `netguard`、`hubsync` 单飞与宽限期、`scheduler` 故障转移与双账号同错自愈、`adapters` 等）。
- **T3：本地多进程黑盒端到端测试（Local Blackbox E2E）**：
  - 真实编译 `bin/llmproxy` 二进制，使用 `127.0.0.1` 临时端口与合成测试密钥；
  - 验证 Lite 节点零轮询断言（中枢请求严格为 1）、全盘零落盘扫描、401 吊销内存清零、双栈监听与 Full 模式离线回退。
- **T4：线上 EdgeOne Hub 实机冒烟与集成验证（Live Hub Smoke & Verification）**：
  - 当修改并部署 `edgeone-hub/` 或 `edge-functions/` 时触发；
  - **严格在仓库外 `scratch/` 目录执行**：测试前后获取配置与节点快照、使用 `zz_e2e_` 命名空间隔离测试节点、验证 100% 零残留清理与管理端只读可访问性。

### 5.2 六道发布门禁（G1 ~ G6）

执行 `npm run verify:release` 时必须全绿（详见 [`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md)）：

- **G1 版本与许可证一致性**：`version.json`（`vYYYYMMDD-NN` + `semver`）、`CHANGELOG.md` 与 `THIRD_PARTY_NOTICES` 对齐；
- **G2 确定性构建与零漂移**：`npm run build:presets` + `npm run build:admin` 生成物与 Go 静态编译无漂移；
- **G3 前后端与节点契约守卫**：T1 各项契约守卫与 AST 路由导出检查 100% 通过；
- **G4 Profile 与 Schema 双向对齐**：`settings.schema.json`、`runtime-profiles.json` 与 Go 结构体一致；
- **G5 全量测试与 Race 检测**：`npm run test:hub` + `go test -race ./...` + `npm run test:t3` 全绿；
- **G6 工作区洁净度与敏感信息扫描**：零未提交改动、零禁存测试快照文件、零泄漏真实私钥或真实节点令牌（`stk_node_*`）。

### 5.3 五步双轨发布与部署 SOP

项目采用 **主分支触发 EdgeOne 中枢部署 + Git Tag 触发 GitHub Actions 编译 Go 二进制** 的双轨发布模式：

1. **Step 1：确定性构建（Zero-Drift Artifact Build）**：
   运行 `npm run build:presets && npm run build:admin`，生成 `catalog.json` 与内嵌控制台，确保工作区无构建漂移。
2. **Step 2：版本号与日志同步（Version & Changelog Sync）**：
   原子更新 `version.json`（更新 `version`、`semver`、`release_date`、`title`、`changelog`）及 `CHANGELOG.md`。
3. **Step 3：本地门禁终审（Mandatory Local Gatekeeper）**：
   执行 `npm run verify:release`，确认 G1 ~ G6 六道门禁 100% PASS，任何一项失败严禁推送。
4. **Step 4：主分支推送与中枢部署（Main Branch Push & EdgeOne Hub Deploy）**：
   执行 `git push origin main`，触发腾讯云 EdgeOne Makers 自动化构建与边缘部署（若中枢更新，在外部 `scratch/` 执行 T4 冒烟验证）。
5. **Step 5：Tag 推送与跨平台二进制发版（Tag Push & Go Multi-Arch Release）**：
   执行 `git tag vYYYYMMDD-NN && git push origin vYYYYMMDD-NN`，触发 GitHub Actions `ci-release.yml` 自动完成 Linux AMD64/ARM64 及 macOS 多架构静态交叉编译并发布至 GitHub Releases。
