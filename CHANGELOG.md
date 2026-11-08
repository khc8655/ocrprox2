# Changelog

本项目遵循 [`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md) 的版本与发版门禁规范，版本号与 [`version.json`](file:///Users/xk/Documents/llmproxy2/version.json) 保持严格同步。

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
  - 新增 [`docs/SYSTEM_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SYSTEM_DESIGN_SPEC.md)（并同步更新 [`doc/GO_NODE_REFACTOR_SPEC.md`](file:///Users/xk/Documents/llmproxy2/doc/GO_NODE_REFACTOR_SPEC.md)）：深度复盘前任设计草案的五大缺陷，确立 **EdgeOne Makers 轻中枢 (`hub`) + Go 极简 NAT 节点 (`lite`) + Go 完整节点 (`full`)** 的三端融合架构。
  - 新增 [`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md)：完成 `yetone/magpie` 近 1,000 次提交（734 个版本）变更热度审计，确立 9 个零变更标准库微模块的白名单搬运矩阵与三层统计/轨迹回放（`applog` + `usage.jsonl` + `traceKeep=60`）方案。
  - 新增 [`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md)：确立 Magpie 极简风格 UI 标准（安静表面、`.list/.row` + 行内原地展开 `.editor`、零抽屉、零内联样式、体积 ≤ 80KB）。
  - 新增 [`docs/MULTI_AGENT_BLUEPRINT.md`](file:///Users/xk/Documents/llmproxy2/docs/MULTI_AGENT_BLUEPRINT.md)：锁死全局唯一 Go 核心结构体与跨包接口（`internal/types/types.go`）及 W0~W6 多 Agent 物理文件所有权边界（零冲突并行开发）。
  - 新增 [`docs/SECURITY_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SECURITY_SPEC.md)、[`docs/ADMIN_UI_BACKEND_CONTRACT.md`](file:///Users/xk/Documents/llmproxy2/docs/ADMIN_UI_BACKEND_CONTRACT.md)、[`docs/TESTING_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/TESTING_SPEC.md)、[`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md)、[`docs/OPERATIONS_GUIDE.md`](file:///Users/xk/Documents/llmproxy2/docs/OPERATIONS_GUIDE.md)、[`docs/EXTERNAL_REFERENCES.md`](file:///Users/xk/Documents/llmproxy2/docs/EXTERNAL_REFERENCES.md)。
