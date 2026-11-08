# 发版流程、静态构建与门禁规范 (Release Specification)

> **核心原则**：每一次版本发布必须是确定性的、可回滚的，且必须 100% 通过 G1~G6 六道自动化门禁。

---

## 一、 版本号与单一真源（Version SSOT）

1. **版本格式**：采用日期序号制 `vYYYYMMDD-NN`（如 `v20261108-01`），同时在 [`version.json`](file:///Users/xk/Documents/llmproxy2/version.json) 中维护对应的语义化版本 `semver`（如 `2.0.0`）。
2. **唯一真源**：根目录 [`version.json`](file:///Users/xk/Documents/llmproxy2/version.json) 是全仓库唯一的版本定义源。
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

---

## 三、 六道自动化发版门禁（G1 ~ G6）

执行 `npm run verify:release` 时，脚本按顺序严格检查以下 6 道门禁，任一失败即阻断发版：

| 门禁编号 | 门禁名称 | 自动化检查内容 |
|---|---|---|
| **G1** | **版本与许可证一致性** | 1. 校验 `version.json` 字段完整性（`version`, `semver`, `release_date`, `commit`, `title`, `changelog`）；<br>2. 校验 `CHANGELOG.md` 包含当前版本号条目；<br>3. 校验 `THIRD_PARTY_NOTICES` 包含 `yetone/magpie` MIT 许可证声明。 |
| **G2** | **确定性构建与零漂移** | 1. 执行 `npm run build:admin` 与 Go 编译；<br>2. 检查 `git status --porcelain` 中所有生成物目录无未提交变更（Zero Drift）。 |
| **G3** | **前后端与节点契约守卫** | 执行 `T1.admin_ui_contract`、`T1.readonly_route_guard`（Magpie `routeMux` 只读路由守卫）与 `T1.hub_export_guard`。 |
| **G4** | **Profile 与 Schema 双向对齐** | 执行 `T1.settings_contract` 与 `T1.presets_integrity`，确保 `settings.schema.json`、`runtime-profiles.json`、Go 结构体与前端表单 100% 同步。 |
| **G5** | **全量三层测试与 Race 检测** | 1. 执行 `go test -race ./...`；<br>2. 执行 T2 EdgeOne 中枢单测；<br>3. 执行 T3 黑盒 E2E 测试（含 **Lite 节点中枢调用次数断言** 与 **全盘零落盘扫描**）。 |
| **G6** | **工作区洁净度与敏感信息扫描** | 1. 确认 Git 工作树无未跟踪残留或未提交修改；<br>2. 扫描全仓代码确保无硬编码真实 `sk-*`、私钥或 `.pem` 证书被意外追踪。 |

---

## 四、 标准发版 SOP

1. **特性开发与测试**：完成代码与对应 T1/T2/T3 测试编写，本地运行 `go test -race ./...`。
2. **构建共享资产**：运行 `npm run build:admin` 同步前端与预设产物。
3. **更新版本与文档**：更新 `version.json`、`CHANGELOG.md` 及涉及的 `docs/*.md` 规范文档。
4. **执行发版门禁**：运行 `npm run verify:release`，确认 **G1 ~ G6 全部 PASS**。
5. **交叉编译与签名校验**：运行 `npm run build:release` 生成 `dist/` 下各平台静态二进制与 `SHA256SUMS`。
6. **提交与打标**：
   ```bash
   git add -A
   git commit -m "release: vYYYYMMDD-NN <简明标题>"
   git tag -a vYYYYMMDD-NN -m "vYYYYMMDD-NN"
   git push origin main --tags
   ```
