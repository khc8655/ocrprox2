# AGENTS.md — llmproxy2 协作入口

所有 agent（以及人）进仓库先读这一页。这里只写「怎么干活」；系统怎么设计的看 `docs/`，
每份文档管什么见下面的「文档地图」。和代码冲突时以代码、契约 JSON 与测试为准，并顺手把文档改对。

## 1. 三个角色，边界不能破

| 角色 | 代码 | 只做 | 绝不做 |
|---|---|---|---|
| 中枢 `hub` | `edgeone-hub/`（`edge-functions/` 是构建生成的，别手改） | 供应商与 Key、预设、节点签发/吊销、被动响应节点拉配置、托管控制台 | `/v1/*` 推理、主动连节点、`node:*` 引用与 `Buffer` |
| 轻节点 `lite` | `internal/`，`--role=lite` | `/v1/*` 代理、按需拉配置 + 租约续期、周期心跳 | 落盘任何配置或 Key、挂 `/api/admin/*` |
| 完整节点 `full` | `internal/`，`--role=full` | 本地加密配置、完整控制台、从中枢按需拉取、OAuth | 把本地 Key 回传中枢 |

控制台只有一份源码：`shared/admin/`，同时服务 hub 与 full。

## 2. 两条车道：默认走快速迭代

| | 快速迭代（默认） | 发版 |
|---|---|---|
| 什么时候 | 日常改动、修 bug、调界面 | 用户说「发版」 |
| 检查 | `npm run check`（约 10 秒） | `npm run verify:release`（G1–G6，约 30 秒） |
| 提交 | 改完即可提交到 `main`，不升版本号 | 升版本号 → 门禁 → 提交 → tag → 推送 |
| 推送 | 推 `main` 会触发中枢部署和 CI，可以推 | 推 `main` + tag，tag 触发二进制与镜像发布 |

**快速迭代**：改代码 → `npm run check` → 提交。只改前端，构建通过就行；改了 Go 或中枢，`check` 会跑对应测试。
不需要每次改动都写 CHANGELOG，改动先记在 CHANGELOG 顶部的 `## [Unreleased]`，发版时整理。

**发版**（一次发一批，别一个小修一次版）：
1. `version.json`：`version`（`vYYYYMMDD-NN`）、`semver`、`release_date`、`title`、`changelog`；
   同步改 `cmd/llmproxy/main.go` 里的 `version` 和 `AppVersion` 两个字面量（有测试守着）；
   把 CHANGELOG 的 `[Unreleased]` 改成 `## [vYYYYMMDD-NN] - 日期`。
2. `npm run build:presets && npm run build:admin && npm run verify:release`，G1–G6 必须全过。
3. **一条命令完成提交、打 tag、推送**，前一步失败后面就不执行：
   `git add -A && git commit -m "release: vX (semver) 摘要" && git tag vX && git push origin main && git push origin vX`
   打 tag 前确认 `git log -1` 是这次的 `release:` 提交（曾经出过 tag 打在上一版的事故）。
4. 等 CI 的 tag 构建变绿，下载产物核对 `SHA256SUMS` 和 `--version`。

线上中枢的实机冒烟（T4）只在改了 `edgeone-hub/` 且用户要求时做。

## 3. 测试：按改动挑，不全量跑

| 改了什么 | 跑什么 |
|---|---|
| `shared/admin/` | `npm run build:admin`（含零内联样式、零抽屉、包体 ≤ 384 KiB） |
| `edgeone-hub/` | `npm run test:hub` |
| `internal/`、`cmd/` | `go test ./internal/<包>/...`；碰了并发再加 `-race` |
| 契约、schema、预设 | `npm run test:t1` |
| 拿不准 | `npm run check` |

`npm run check` = 构建 + T1 + 中枢单测 + `go vet` + `go test`（只测 `cmd/` 与 `internal/`，不碰 `scratch/`）。全量 race 和 T3 黑盒只在发版门禁里跑一次，不要重复跑。

界面改动要在浏览器里真点一遍（本机环境见 `docs/TESTING_SPEC.md` §本机环境）。
**先确认服务的是新构建**：Full 节点内嵌页面，改完前端要重新编译二进制，否则看到的是旧界面。

## 4. 多 agent 协作

1. **按文件分工，不按步骤分工。** 并行的 agent 改的文件集合必须互不相交，开工前写清楚各自负责哪些文件。
   改同一批文件的连续工作交给同一个 agent 接着做。
2. **跨端改动先定约定。** 改接口、数据结构、中枢与节点之间的协议，先写进对应文档和契约 JSON（见第 5 节），
   再让各端按同一份约定实现。各 agent 不要自己发明字段名。
3. **两个工作流不要同时改同一批文件**（常见冲突点：`shared/admin/js/app.js`、`internal/admin/admin.go`、
   `internal/router/readonly.go`、`shared/admin/build.mjs`、`edgeone-hub/test/hub.test.mjs`）。
4. **测试只跑一遍。** 能用命令判定的交给脚本；不要工程师自测、审核员复测、门禁再测各来一次。
   审出的问题修一次，不循环复审。
5. **「通过」要有证据。** 报告里写跑了什么命令、看到什么结果；子代理说通过不算数，由主代理复核关键结论。
6. **新增 HTTP 端点必须登记**：`internal/admin/admin.go` 的 `register`、`internal/router/readonly.go`，
   中枢的还要登记 `shared/admin/build.mjs` 的 `apiRoutes`，否则线上 404。
7. 测试产物、截图、临时脚本放 `scratch/`（已 gitignore）；测试数据用 `zz_` 前缀，用完删。
8. **验收报告由主代理写。** 子代理只产生观察并落盘（截图路径、命令、关键输出），不派子代理把观察
   再重读一遍总结成报告。工作流本身的设计规矩在全局 `~/.zcode/AGENTS.md`「工作流设计」里，
   这里不重复。

## 5. 文档规范

### 文档地图（一件事只在一个地方写）

| 文档 | 管什么 | 谁改 |
|---|---|---|
| `AGENTS.md`（本文） | 怎么干活：车道、测试、协作、文档规则 | 流程变了就改 |
| `CHANGELOG.md` | 每版改了什么，面向使用者 | 每次提交加到 `[Unreleased]` |
| `docs/ADMIN_UI_BACKEND_CONTRACT.md` + `shared/contracts/admin-ui-backend.json` | 控制台 ↔ 后端的接口 | 改接口前先改 |
| `docs/MULTI_AGENT_BLUEPRINT.md` + `internal/types/types.go` | Go 核心数据结构、包边界 | 改结构前先改 |
| `docs/UI_DESIGN_SPEC.md` + `docs/ui-v2/mockups/` | 界面规范（含验收清单）与效果图，效果图是外观标准 | 改界面模式时改 |
| `docs/SYSTEM_DESIGN_SPEC.md` | 三端架构、数据流 | 架构变了改 |
| `docs/SECURITY_SPEC.md` | 鉴权、凭据、红线 | 安全相关变了改 |
| `docs/TESTING_SPEC.md` | 测试分层、本机测试环境 | 测试方式变了改 |
| `docs/RELEASE_SPEC.md` | 门禁 G1–G6 的检查项、CI 流水线 | 门禁变了改 |
| `docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md`、`docs/EXTERNAL_REFERENCES.md` | 外部平台限制、第三方参考 | 发现新限制时改 |
| `docs/MAGPIE_UPSTREAM_SYNC.md` + `docs/magpie-baseline.json` | 从 magpie 复用了什么、怎么跟上游 | 搬运或升级时改 |
| `docs/OPERATIONS_GUIDE.md`、`docs/AGENT_DEPLOY_GUIDE.md` | 部署与运维操作手册 | 安装方式变了改 |
| `README.md` | 项目简介与快速上手 | 对外描述变了改 |

`docs/MAGPIE_REUSE_MATRIX.md` 是 2026-11-08 的决策存档，只读，不再更新。

### 写文档的规则

1. **一件事只写一处。** 别的文档需要时写一句话加链接，不复制内容。数字（包体上限、超时、端口）尤其只在一处定义。
2. **写现状，不写历史。** 功能删了，文档里一起删；历史放 CHANGELOG。不要留「v20261117 起…」这类叠加说明。
3. **能被测试守住的写进测试。** 「禁止内联样式」「包体上限」这类规则以 T1 测试为准，文档只说明规则存在。
4. **同一次提交里改代码和文档。** 改了接口没改契约文档，审核时算没改完。
5. **短。** 一节说一件事；能用一张表说清楚就不写三段话。
6. **不要新建规划、分析、复盘类文档**，除非用户要求。临时笔记放 `scratch/`。
7. 本仓是公开仓库：文档和测试里只用合成的假密钥（`0123456789abcdef` 这类），不写真实域名、密码、节点令牌。

## 6. 几条不能碰的线

- 不复活已删除的字段：`request_total_budget_sec`、`max_retries`、`max_attempts_per_provider`（总超时固定 300s）。
- 不通过 `go.mod` 依赖 magpie；只复用 `docs/MAGPIE_UPSTREAM_SYNC.md` 登记过的冻结模块，并保留 `THIRD_PARTY_NOTICES`。
- 不手改构建产物：`shared/admin/dist/`、`internal/admin/assets/index.html`、`admin/index.html`、`edge-functions/`、`edgeone-hub/lib/generated-*.js`。
- 设置项新增/修改：`shared/config/settings.schema.json` → `runtime-profiles.json` → Go 与中枢读同名 key → 控制台 → 测试，一次改齐。
