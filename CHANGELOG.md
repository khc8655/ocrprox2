# Changelog

本项目遵循 [`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md) 的版本与发版门禁规范，版本号与 [`version.json`](file:///Users/xk/Documents/llmproxy2/version.json) 保持严格同步。

---

## [Unreleased]

### Fixed
- **管理端自锁（P1）**：完全无凭据的请求不再计入防爆破失败阶梯（此前未登录刷新控制台 5 次即把该 IP 锁 10 分钟，期间正确密码也被拒）；锁定期返回 `429 Too Many Requests` + `Retry-After`，控制台据此提示"临时锁定"而非"密码错误"；未登录首屏不再预取 `/api/config`。
- **供应商详情面板"自动探测协议"失效（P2）**：补齐 `btn_detect_ed_<id>` 的行内事件绑定，调用 `/api/admin/detect-provider` 并回填归一化 Base URL。
- **新建供应商 API Key 明文回显（P3）**：`#newProvApiKey` 改为 `type="password"`。
- **显式 IPv4 绑定的误导性 dual-stack 告警（P3）**：仅在通配/IPv6 绑定时尝试双栈 socket，IPv4 直连不再打印 `dual-stack listen failed`。
- **密钥健康度统计失真（P3）**：`usage.jsonl` 记录新增 `try_failed`，故障转移中失败的上游尝试计入对应 Key 的 `failed`，不再只统计最终胜出 Key。
- **版本常量漂移（P3）**：`cmd/llmproxy/main.go` 默认版本同步至 `v20261114-03 / 2.1.0`，`go build` 直接产出的 `--version` 不再错误。
- **文档漂移（P3）**：`docs/TESTING_SPEC.md` 中 T2 中枢测试落点修正为 `edgeone-hub/test/hub.test.mjs`；`docs/ADMIN_UI_BACKEND_CONTRACT.md` 补充 429 契约与 `settings.client_key` 明文可见的设计说明。

---

## [v20261114-03] - 2026-11-14

### Added
- **Magpie 供应商智能引擎深度移植 (Detect, Balance, Test & AutoList)**：
  - 新增 `internal/provider` 引擎：内置 16+ 主流 AI 供应商自动探测与端点嗅探（OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / SiliconFlow / Groq / xAI / Cohere / Mistral / Together / Ollama 等）；
  - 支持多币种账户余额实时查询（`balance_url` + `balance_path`）与凭据活性自动探测（`test-candidate`）；
  - 定时模型列表全量刷新与自动纳管正则匹配（`RefreshManager` / `refresh_every` / `auto_include`）。
- **Magpie 极简单页 Web UI 现代化升级 (240 KB 纯原生零框架控制台)**：
  - 引入 16+ 厂商高精度矢量 SVG 图标集（`shared/admin/js/icons.js`）；
  - 新增 Token 消耗与吞吐时序条形直方图（`shared/admin/js/usage.js`）与 GitHub 风格 53 周活动热力图；
  - 新增 KB 模式 4 大流水线（Chat / Embedding / Reranker / OCR）独立可视化编辑器面板；
  - 新增客户端接入网关控制中心（Gateway Access Center），一键切换并复制 curl / Python / OpenAI SDK 接入代码与临时/永久凭证；
  - 保持 0 inline style、0 drawer、0 left-border 铁律，将单文件打包预算扩展至 `<= 240 KB`（`245,760 bytes`）。
- **v1 协议全量对齐与多模态扩展**：
  - `/v1/ocr`：完整支持 Base64 / URL 图片预读与 Vision 模型多模态 OCR 识别流水线，支持流式并发零拷贝与 20MB 超大图片保护；
  - `<thought>` 思维链标签流式过滤器（`internal/adapters/stream_filter.go`）：针对 DeepSeek-R1 / Qwen 等思考模型，支持将 `<thought>` 标签内容实时剥离或重定向为推理字段；
  - 流式 SSE 统计注入：严格遵循 OpenAI 标准在最后一个 SSE chunk 中注入 `usage` 块，确保客户端与中枢精准统计输入/输出/推理/缓存 Token。
- **持久化封禁与高可用冷却系统 (`key_bans.json`)**：
  - 实现持久化封禁机制：当 Full 节点遇到 401 认证失败或 410 永久失效时，自动将受限凭据持久化写入 `--config-dir/key_bans.json`；
  - 进程重启后自动加载历史有效封禁记录，并在 `GET /api/admin/cooldowns` 中精确呈现，杜绝服务重启造成无效 Key 反复拨号；
  - Lite 节点保持 0 磁盘 I/O 运行设计。

### Fixed
- **核心调度器与主入口装配加固**：
  - 修复 `cmd/llmproxy/main.go` 中 `sched.InitBans` 缺少调用的问题，确保 Full 模式节点启动时正确挂载持久化封禁文件；
  - 优化高并发流式代理内存开销，实施 OOM 有界缓冲区保护，杜绝长会话流式代理内存泄露；
  - 严格限制跨私网穿透规则，确保 `--allow-private` 仅在显式声明时允许本地回环与私网上游。

### Changed
- **VM 运维与部署脚本强化**：
  - 升级 `deploy/install.sh` 与 `llmproxy-ctl`：增强系统环境检测、自动更新通道、服务健康检查与无损热重载（SIGHUP / systemctl reload）；
  - 完善 EdgeOne Makers 中枢与 VM 本地节点独立演进架构，解耦中枢 KV 存储与本地节点私有密钥。

---

## [v20261114-02] - 2026-11-14

### Added
- **管理控制台供应商与模型快速创建**：
  - 在 `#viewProviders` 中新增「＋ 添加供应商」按钮与内嵌配置面板，内置 OpenAI、Anthropic、Gemini、DeepSeek、OpenRouter、SiliconFlow、Groq、xAI 等快速预设与自定义协议配置，支持自动填充及初始密钥添加；
  - 在 `#viewModels` 中新增「＋ 添加模型」按钮与内嵌配置面板（KB 模式自动隐藏），支持逻辑模型名称、候选供应商下拉与上游目标模型配置；
  - 严格保持 **0 inline style** 属性与 JavaScript 样式操作，优化构建内联压缩，确保单文件控制台体积控制在 80,000 字节以内（~75.47 KB）。

### Fixed
- **EdgeOne Hub 密钥校验与模型探测契约对齐与掩码反查**：
  - 修复 `shared/admin/app.js` 统一传递 `api_key` 与 `key`，兼容 Go 完整节点与 EdgeOne Hub 契约；
  - `edgeone-hub/api/admin/verify-key.js` 与 `probe-models.js` 新增对前端传递脱敏密钥（`●●●`）的自动反查机制，依据 `provider` 与 `key_label` 从 KV 存储中提取真实密钥并补全 Base URL 与协议类型，彻底解决控制台保存后无法校验及探测的可用性缺陷。

### Changed
- **VM 节点一键安装与预设链接优化**：
  - `deploy/install.sh`：当未指定 `--bin` 且本地未找到对应架构二进制时，自动从 GitHub Releases 下载对应架构最新静态二进制并完成 systemd 配置；
  - `README.md`：在 §6.2 中补充清晰的 GitHub Releases 访问链接；
  - `shared/presets/openrouter.json`：更新 `HTTP-Referer` 为 `https://github.com/khc8655/ocrprox2`。

---

## [v20261114-01] - 2026-11-14

### Added
- **EdgeOne Makers 官方运行时指南与平台适配规范**：
  - 新增 [`docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md`](file:///Users/xk/Documents/llmproxy2/docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md)：沉淀 EdgeOne Makers V8 Isolate Serverless 运行时限制、Web Standard API 边界、5MB 包体积配额、KV 最终一致性格局（同节点即时生效 / 跨节点 60s）与 Web Crypto 鉴权规范。
- **四层测试金字塔与 T4 线上实机冒烟验证**：
  - 升级 [`docs/TESTING_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/TESTING_SPEC.md)，扩展为 T1~T4 四层测试架构：
    - T1：静态契约、UI 限制、Go 路由白名单及 EdgeOne AST 显式导出与纯 Web Standard 边界守卫；
    - T2：EdgeOne Hub 单元测试与 Go `-race` 并发竞争检测（`npm run test:hub` + `go test -race ./...`）；
    - T3：本地多进程黑盒 E2E 测试（`npm run test:t3`，严格采用 `127.0.0.1` 临时端口与合成测试密钥）；
    - T4：线上 EdgeOne Hub 实机冒烟与集成验证（在外部 `scratch/` 隔离运行、`before/after` 快照对比、`zz_e2e_` 命名空间隔离、100% 零残留验证及只读控制台探活）。
- **五步双轨发版 SOP 与发布规范**：
  - 升级 [`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md)，正式确立「`version` 日期序号制 + `semver` 语义化版本」双轨方案与原子同步机制；
  - 确立五步双轨发布流程（Step 1 确定性构建 -> Step 2 版本与日志同步 -> Step 3 本地门禁终审 -> Step 4 主分支推送中枢部署 -> Step 5 Tag 推送与 GitHub Actions 跨平台静态二进制构建）。
- **发布门禁 G6 硬化与仓库防泄露规则**：
  - 升级 [`scripts/verify-release.mjs`](file:///Users/xk/Documents/llmproxy2/scripts/verify-release.mjs) Gate G6：新增禁止残留测试快照与报告文件校验（`before_config.json`, `after_config.json`, `before_nodes.json`, `after_nodes.json`, `matrix_results.json`, `live_hub_test_report.md`）及真实节点令牌防泄露正则扫描（`/\bstk_node_[a-f0-9]{32,}\b/i`）；
  - 更新 [`.gitignore`](file:///Users/xk/Documents/llmproxy2/.gitignore)：显式忽略 `*.sqlite`、`*.sqlite3`、`*.db`、`data/`、`*snapshot*.json`、`before_*.json`、`after_*.json`、`matrix_results.json`、`live_hub_test_report.md`、`.live_test*`。

### Fixed
- **EdgeOne 纯 Web Standard 运行时适配（`8ef569a`）**：
  - 彻底去除 `edge-functions/` 及 `edgeone-hub/` 依赖链中所有 `node:crypto`、`node:fs`、`node:path`、`node:url` 内置模块与全局 `Buffer`；
  - 采用标准 Web Crypto API（`crypto.getRandomValues` / `crypto.subtle`）实现节点令牌生成、SHA-256 哈希计算与 Bearer 鉴权常量时间比对；
  - 将中枢核心依赖收敛至自包含目录 `edge-functions/_hub/`，阻断跨根目录依赖，彻底解决 EdgeOne 平台构建失败与线上静默 404 问题。
- **EdgeOne Makers AST 显式路由扫描适配（`cc1172d`）**：
  - 针对 EdgeOne Makers 平台构建期仅做顶层静态 AST 扫描的机制，将 `edge-functions/` 下所有路由文件的 `export * from '...'` 间接转发导出重构为显式顶层 `export async function onRequest(...)` 声明，修复线上路由无法被平台注册的缺陷。
- **Go hubsync 协议数字时间戳解析兼容（`8f72508`）**：
  - 修复 [`internal/hubsync/hubsync.go`](file:///Users/xk/Documents/llmproxy2/internal/hubsync/hubsync.go) 中对租约截止时间 `lease_until` 与宽限期截止时间 `grace_until` 的反序列化逻辑，全面兼容中枢返回的 Unix 秒级（10位）与毫秒级（13位）数字时间戳，杜绝由于时间格式反序列化失败导致节点降级。

### Changed
- **设计规范文档体系统一收敛**：
  - 移除历史遗留冗余目录与文件 `doc/GO_NODE_REFACTOR_SPEC.md`（`rm -rf doc`），将唯一权威系统架构设计规范统一收敛至 [`docs/SYSTEM_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SYSTEM_DESIGN_SPEC.md)。
- **工程宪法与治理红线更新（[`CLAUDE.md`](file:///Users/xk/Documents/llmproxy2/CLAUDE.md)）**：
  - 将 [`docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md`](file:///Users/xk/Documents/llmproxy2/docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md) 纳入核心权威规范文档序列；
  - 确立「设计先行变更铁律（Design-First Change Rule）」：跨端 API、数据模型与外部依赖变更前必须先行同步更新契约文件（`docs/ADMIN_UI_BACKEND_CONTRACT.md` + `shared/contracts/admin-ui-backend.json` 或 `docs/MULTI_AGENT_BLUEPRINT.md` + `internal/types/types.go`）；
  - 确立「开源仓库与测试数据安全红线（Public Repository & Test Data Redlines）」：零真实凭据/令牌入库，实机测试脚本与快照产物必须严格隔离在外部 `scratch/` 临时目录运行。

---

## [v20261108-02] - 2026-11-08

### Added
- **W1（配置与极简同步闭环）**：
  - [`internal/config/local.go`](file:///Users/xk/Documents/llmproxy2/internal/config/local.go)：新增 `VersionConflictError`（携带 `CurrentVersion` 与 `SubmittedVersion`）、`MergeVaultConfig`（严格保护 `origin="local"` 供应商与私有密钥不被中枢覆盖）及 `UpdateRunMode` 原子持久化。
  - [`internal/hubsync/hubsync.go`](file:///Users/xk/Documents/llmproxy2/internal/hubsync/hubsync.go)：兼容中枢 `payload` 契约封装响应，修复 `forceRefresh` 双检锁穿透，支持 `X-Node-Refresh: 1` 强制条件刷新。
- **W2（调度内核、只读路由守卫与可观测性闭环）**：
  - [`internal/scheduler/scheduler.go`](file:///Users/xk/Documents/llmproxy2/internal/scheduler/scheduler.go) & [`cooldown.go`](file:///Users/xk/Documents/llmproxy2/internal/scheduler/cooldown.go)：新增 `OAuthRefresher` 动态刷新接口、`TriggerAllKeysFailed` 防抖联动及 `CooldownManager.Snapshot()` 冷却状态快照。
  - [`internal/router/readonly.go`](file:///Users/xk/Documents/llmproxy2/internal/router/readonly.go)：补齐 `FullOnlyRoutes` 与 `ValidateRegisteredRoutes` 路由白名单门禁。
  - [`internal/obs/usage.go`](file:///Users/xk/Documents/llmproxy2/internal/obs/usage.go)：对齐 `QueryUsage` 的 `totals`、`models`、`keys` 契约字段。
- **W3（Full 完整节点扩展与主入口装配）**：
  - [`internal/admin/admin.go`](file:///Users/xk/Documents/llmproxy2/internal/admin/admin.go)：通过 `//go:embed` 内嵌单文件管理端控制台与 `THIRD_PARTY_NOTICES`，完整实现 `/api/config`（含标准 409 冲突载荷）、`/api/admin/mode`、`/api/admin/verify-key`、`/api/admin/probe-models`、`/api/vault/manifest`、`/api/vault/fetch`、`/api/admin/cooldowns` 与 `/api/admin/oauth/*`。
  - [`internal/kb/kb.go`](file:///Users/xk/Documents/llmproxy2/internal/kb/kb.go)：实现 `chat` / `embedding` / `reranker` / `ocr` 四分类多候选自动故障转移（Failover）并接入 `ObservabilitySink` 轨迹记录。
  - [`cmd/llmproxy/main.go`](file:///Users/xk/Documents/llmproxy2/cmd/llmproxy/main.go)：完整对齐 `LLMPROXY_*` 环境变量、`ENCRYPT_KEY`、`-ldflags` 版本注入、`X-Node-Refresh: 1` 及 `agent` ↔ `kb` 路由模式门禁。
- **W4（EdgeOne Makers 轻中枢与共享契约）**：
  - 新增 [`edgeone-hub/lib/models.js`](file:///Users/xk/Documents/llmproxy2/edgeone-hub/lib/models.js)、[`edgeone-hub/api/admin/verify-key.js`](file:///Users/xk/Documents/llmproxy2/edgeone-hub/api/admin/verify-key.js)、[`edgeone-hub/api/admin/probe-models.js`](file:///Users/xk/Documents/llmproxy2/edgeone-hub/api/admin/probe-models.js)，完善 [`shared/contracts/admin-ui-backend.json`](file:///Users/xk/Documents/llmproxy2/shared/contracts/admin-ui-backend.json)。
- **W5（Magpie 极简风格单页管理端 UI）**：
  - 升级 [`shared/admin/`](file:///Users/xk/Documents/llmproxy2/shared/admin)，实现 Usage 多格式兼容、CAS 409 自动刷新恢复、Vault 同步、Key 校验与模型探测交互，单文件打包体积 `74.27 KB`（`≤ 80KB`），零内联样式、零抽屉。
- **W6（T1~T3 全量测试、多架构发布脚本与部署模板）**：
  - 新增 [`tests/t3_e2e/e2e.test.mjs`](file:///Users/xk/Documents/llmproxy2/tests/t3_e2e/e2e.test.mjs) 真实进程黑盒 E2E 测试套件（覆盖 Lite 零轮询/零落盘/401 吊销、双栈监听、Full 模式全矩阵）。
  - 新增 [`scripts/build-release.mjs`](file:///Users/xk/Documents/llmproxy2/scripts/build-release.mjs)（`linux-amd64` / `linux-arm64` / `darwin-arm64` 零 CGO 静态编译 + `SHA256SUMS`）及 [`deploy/`](file:///Users/xk/Documents/llmproxy2/deploy) systemd 加固服务模板与 [`deploy/install.sh`](file:///Users/xk/Documents/llmproxy2/deploy/install.sh)。

---

## [v20261108-01] - 2026-11-08

### Added
- **项目初始化与标准文档体系建设**：
  - 新增 [`README.md`](file:///Users/xk/Documents/llmproxy2/README.md)、[`CLAUDE.md`](file:///Users/xk/Documents/llmproxy2/CLAUDE.md)、[`ARCHITECTURE_STANDARDS.md`](file:///Users/xk/Documents/llmproxy2/ARCHITECTURE_STANDARDS.md)，确立工程宪法与七大架构准则。
  - 新增 [`docs/SYSTEM_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SYSTEM_DESIGN_SPEC.md)（现已统一收敛至 `docs/`，移除旧 `doc/` 历史草案）：深度复盘前任设计草案的五大缺陷，确立 **EdgeOne Makers 轻中枢 (`hub`) + Go 极简 NAT 节点 (`lite`) + Go 完整节点 (`full`)** 的三端融合架构。
  - 新增 [`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md)：完成 `yetone/magpie` 近 1,000 次提交（734 个版本）变更热度审计，确立 9 个零变更标准库微模块的白名单搬运矩阵与三层统计/轨迹回放（`applog` + `usage.jsonl` + `traceKeep=60`）方案。
  - 新增 [`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md)：确立 Magpie 极简风格 UI 标准（安静表面、`.list/.row` + 行内原地展开 `.editor`、零抽屉、零内联样式、体积 ≤ 80KB）。
  - 新增 [`docs/MULTI_AGENT_BLUEPRINT.md`](file:///Users/xk/Documents/llmproxy2/docs/MULTI_AGENT_BLUEPRINT.md)：锁死全局唯一 Go 核心结构体与跨包接口（`internal/types/types.go`）及 W0~W6 多 Agent 物理文件所有权边界（零冲突并行开发）。
  - 新增 [`docs/SECURITY_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SECURITY_SPEC.md)、[`docs/ADMIN_UI_BACKEND_CONTRACT.md`](file:///Users/xk/Documents/llmproxy2/docs/ADMIN_UI_BACKEND_CONTRACT.md)、[`docs/TESTING_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/TESTING_SPEC.md)、[`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md)、[`docs/OPERATIONS_GUIDE.md`](file:///Users/xk/Documents/llmproxy2/docs/OPERATIONS_GUIDE.md)、[`docs/EXTERNAL_REFERENCES.md`](file:///Users/xk/Documents/llmproxy2/docs/EXTERNAL_REFERENCES.md)。
