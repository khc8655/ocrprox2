# 发版流程、静态构建与门禁规范 (Release Specification)

> **核心原则**：每一次版本发布必须是确定性的、可回滚的，且必须 100% 通过 G1~G6 六道自动化门禁。

---

## 一、 版本号与单一真源（Version SSOT）

1. **双轨版本号方案（Dual-Version Scheme）**：
   - **`version`（日期序号制）**：采用 `vYYYYMMDD-NN` 格式（如 `v20261114-01`）。用于 Git Tag、Go 二进制内嵌版本、发布归档以及三端握手诊断（`/healthz`、`POST /api/node/config`）；
   - **`semver`（语义化版本）**：采用标准 `MAJOR.MINOR.PATCH` 格式（如 `2.0.1`）。用于包管理器、生态版本对照与语义兼容性声明；
   - **原子同步更新铁律**：每次发版必须在同一 Git 提交中原子更新 [`version.json`](file:///Users/xk/Documents/llmproxy2/version.json) 与 [`CHANGELOG.md`](file:///Users/xk/Documents/llmproxy2/CHANGELOG.md)。`CHANGELOG.md` 顶层必须包含与 `version.json` 中 `version` 完全一致的条目标题，严禁版本号脱节或单边提交。
2. **唯一真源（Single Source of Truth）**：根目录 [`version.json`](file:///Users/xk/Documents/llmproxy2/version.json) 是全仓库唯一的版本定义源。
3. **自动注入点**：
   - **Go 二进制**：编译时通过 `-ldflags="-s -w -X main.version=$(jq -r .version version.json) -X main.commit=$(git rev-parse --short HEAD)"` 注入，支持 `llmproxy --version` 与 `/healthz` 读取；
   - **管理端 UI 与 EdgeOne Hub**：由 `npm run build:admin` 在构建时从 `version.json` 自动同步到构建产物。

---

## 二、 零 CGO 多架构静态编译规范

为确保在各类廉价 NAT VM（Alpine `musl`、老旧 Debian/Ubuntu `glibc`、x86_64 与 ARM64 架构）上实现**“单文件拷过去就能跑，零动态库依赖”**，构建脚本固定如下：

```bash
VERSION=$(jq -r .version version.json)
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
LDFLAGS="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}"

# 1. Linux AMD64 (主流 x86_64 NAT VM / 标准云主机)
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="${LDFLAGS}" -o dist/llmproxy-linux-amd64 ./cmd/llmproxy

# 2. Linux ARM64 (Oracle ARM / 树莓派 / ARM NAT 小鸡)
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="${LDFLAGS}" -o dist/llmproxy-linux-arm64 ./cmd/llmproxy

# 3. macOS ARM64 (本地开发与调试)
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="${LDFLAGS}" -o dist/llmproxy-darwin-arm64 ./cmd/llmproxy
```

### 制品基线指标（硬门禁）
- **动态链接检查**：`ldd dist/llmproxy-linux-amd64` 必须输出 `not a dynamic executable`（100% 静态链接）。
- **二进制体积**：去除符号表后单文件体积控制在 **12MB ~ 18MB** 以内（已内嵌 `shared/presets`、`shared/config`、`shared/admin` 静态控制台与 `THIRD_PARTY_NOTICES`）。
- **内存占用基线**：
  - `--role=lite` 启动空载 RSS **≤ 15MB**，常规并发代理下 RSS **≤ 30MB**；
  - `--role=full` 启动空载 RSS **≤ 22MB**。
- **容器镜像**：基于 `scratch`，仅含静态二进制 + CA + tzdata + passwd/group，体积 **≤ 20MB**（当前约 12.8MB）；必须支持 `linux/amd64` 与 `linux/arm64`；`docker run <image> --version` 必须退出码 0（镜像内二进制需 `COPY --chmod=0755`，Release 资产不带执行位）。

---

## 三、 六道自动化发版门禁（G1 ~ G6）

执行 `npm run verify:release` 时，脚本按顺序严格检查以下 6 道门禁，任一失败即阻断发版：

| 门禁编号 | 门禁名称 | 自动化检查内容 |
|---|---|---|
| **G1** | **版本与许可证一致性** | 1. 校验 `version.json` 字段完整性（`version`, `semver`, `release_date`, `commit`, `title`, `changelog`）；<br>2. 校验 `CHANGELOG.md` 包含当前版本号条目；<br>3. 校验 `THIRD_PARTY_NOTICES` 包含 `yetone/magpie` MIT 许可证声明。 |
| **G2** | **确定性构建与零漂移** | 1. 执行 `npm run build:presets` 与 `npm run build:admin`；<br>2. 检查 `git status --porcelain` 中所有生成物目录无未提交变更（Zero Drift）；<br>3. 确保 Go 二进制在 `CGO_ENABLED=0` 下干净编译。 |
| **G3** | **前后端与节点契约守卫** | 执行 T1 契约守卫：`T1.admin_ui_contract`、`T1.readonly_route_guard`（Magpie `routeMux` 只读路由守卫）、`T1.ui_layout_and_zero_inline_style`（极简 UI 体积与样式守卫）与 `T1.hub_export_guard`（EdgeOne 纯 Web Standard 与 AST 显式 `export function onRequest*` 守卫）。 |
| **G4** | **Profile 与 Schema 双向对齐** | 执行 `T1.settings_contract` 与 `T1.presets_integrity`，确保 `settings.schema.json`、`runtime-profiles.json`、Go 结构体与前端表单 100% 同步且无已废弃字段。 |
| **G5** | **全量测试与 Race 检测** | 1. 执行 `npm run test:hub`（EdgeOne 中枢单测）；<br>2. 执行 `go test -race ./...`（Go 全模块并发数据竞争检测）；<br>3. 执行 `npm run test:t3`（本地多进程黑盒 E2E 测试，含 **Lite 节点中枢调用次数严格为 1** 与 **全盘零落盘扫描**）。 |
| **G6** | **工作区洁净度与敏感信息扫描** | 1. 确认 Git 工作树无未跟踪残留或未提交修改；<br>2. 扫描工作区严禁残留任何线上测试快照或报告文件（`before_config.json`, `after_config.json`, `before_nodes.json`, `after_nodes.json`, `matrix_results.json`, `live_hub_test_report.md`）；<br>3. 扫描全仓代码确保无硬编码真实 `sk-*`、未脱敏私钥文件或真实节点令牌（`stk_node_*`）。 |

---

## 四、 五步双轨发版与部署 SOP

本项目采用 **主分支推送触发 EdgeOne 中枢自动化部署 + Git Tag 触发 GitHub Actions 编译多架构 Go 二进制** 的双轨发布模式，发版流程严格遵循以下 5 个步骤：

```text
 ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 │    Step 1    │     │    Step 2    │     │    Step 3    │     │    Step 4    │     │    Step 5    │
 │ 确定性构建产物 │ ──> │ 版本与日志同步 │ ──> │ 本地门禁终审  │ ──> │ 主分支推送部署 │ ──> │ 打标与全架构发版│
 │ Zero-Drift   │     │ Version Sync │     │ G1 ~ G6 100% │     │ EdgeOne Auto │     │ GitHub CI    │
 └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

### Step 1：确定性资产构建（Zero-Drift Artifact Build）
运行预设和前端构建脚本，更新静态资产：
```bash
npm run build:presets
npm run build:admin
```
构建脚本会自动将预设目录哈希同步至 `catalog.json`，并将打包压缩后的管理端单文件控制台同步复制至 `edge-functions/_hub/admin.html` 与 `internal/admin/assets/index.html`。

### Step 2：版本号与更新日志同步（Version & Changelog Sync）
原子同步更新 [`version.json`](file:///Users/xk/Documents/llmproxy2/version.json) 与 [`CHANGELOG.md`](file:///Users/xk/Documents/llmproxy2/CHANGELOG.md)：
1. 在 `version.json` 中更新 `version`（`vYYYYMMDD-NN`）、`semver`（`MAJOR.MINOR.PATCH`）、`release_date`、`title` 及 `changelog` 数组；
2. 在 `CHANGELOG.md` 顶层添加对应版本号的发布日志块，详细记录 `Added`、`Fixed`、`Changed` 改动点。

### Step 3：本地门禁终审（Mandatory Local Gatekeeper）
在本地运行全自动发版门禁脚本：
```bash
npm run verify:release
```
**铁律**：G1 ~ G6 六道门禁必须 100% 通过（PASS）。任一门禁失败必须立即阻断发版，修复后重试，严禁绕过门禁强行推送。

### Step 4：主分支推送与中枢部署（Main Branch Push & Hub Deployment）
将经过门禁验证的代码提交并推送到 GitHub `main` 分支：
```bash
git add -A
git commit -m "release: vYYYYMMDD-NN <简明摘要>"
git push origin main
```
- **EdgeOne 自动化部署**：推送至 `main` 分支后，腾讯云 EdgeOne Makers 会自动捕获提交并完成边缘函数与静态资源的部署；
- **可选 T4 外部冒烟验证**：若本次改动涉及 `edgeone-hub/` 或 `edge-functions/`，在部署完成后必须在仓库外部 `scratch/` 目录运行 T4 冒烟脚本，验证生产环境 100% 正常且零残留。

### Step 5：Tag 推送与跨平台编译发版（Tag Push & Go Release）
在本地创建与 `version.json` 完全一致的 Git Tag 并推送到远程仓库：
```bash
git tag vYYYYMMDD-NN
git push origin vYYYYMMDD-NN
```
- **GitHub Actions 自动化流水线**：推送到 Tag 后，`.github/workflows/ci-release.yml` 触发流水线，在纯净容器中自动交叉编译 `linux-amd64`、`linux-arm64`、`darwin-arm64` 静态二进制，计算 `SHA256SUMS`，并自动发布 GitHub Release 制品。
- **容器镜像发布（`docker-release` job）**：`build-release` 完成后，按 `linux/amd64` 与 `linux/arm64` 分别构建推送 `ghcr.io/khc8655/ocrprox2`，再用 `docker buildx imagetools create` 组装多架构 manifest（`main` → `latest`，`v*` Tag → 版本号）。Gatekeeper 的 G1~G6 通过是前置条件（`needs: build-release` → `needs: verify-gates`）。
