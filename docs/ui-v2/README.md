# UI v2 落地说明

> 状态：进行中。全部工作包合并后删除本文件，只保留 `docs/UI_DESIGN_SPEC.md` 与 `mockups/`。
> 规范：[`../UI_DESIGN_SPEC.md`](../UI_DESIGN_SPEC.md)。效果图：[`mockups/`](./mockups/)（浏览器直接打开 `.html`；`.png` 为 1280 宽截图）。

## 效果图清单

| 文件 | 内容 |
|---|---|
| 01-providers | 供应商列表（分组、问题优先、Key 健康条） |
| 02-provider-dialog | 供应商详情弹框（Key 池） |
| 03-add-provider | 添加供应商（预设网格） |
| 04-models / 05-model-dialog | 模型列表 / 编辑模型 |
| 06-add-model / 07-add-model-advanced | 添加模型（一个窗口；高级设置展开态） |
| 08-nodes / 09-node-dialog | 节点列表 / 节点详情 |
| 10-stats / 11-settings | 统计 / 设置（含未保存浮条） |

效果图里的像素值只是示意。实现时一律取 token（规范 §2），不要照抄 `v2.css` 的数字。

## 工作包

并行的包改动的文件不能重叠（`AGENTS.md` §4）。`app.js` 是最大的冲突点，所以先拆分它，再分页面并行。

| 包 | 内容 | 只改这些文件 | 依赖 |
|---|---|---|---|
| **W0 拆分** | 把 `app.js` 按页面拆成 `js/pages/{providers,models,nodes,stats,settings,access,overview}.js` 和 `js/core.js`（state、请求、通用帮助函数）。**只搬代码，不改行为**；`build.mjs` 按固定顺序拼接，产物仍是单文件 | `shared/admin/js/**`、`shared/admin/build.mjs`、T1 中与文件列表相关的断言 | 无 |
| **W1 基础** | token 与组件：`:root` token、暗色覆盖、`listRow()`、弹框、开关、芯片、`fmtTime()`、设置保存浮条；删除 `--khc-*`；新增门禁（规范 §6） | `css/app.css`、`js/core.js`、`admin.html` 顶栏部分、`build.mjs` 门禁段、T1 UI 测试 | W0 |
| **W2 供应商** | 效果图 01–03 | `js/pages/providers.js` | W1 |
| **W3 模型** | 效果图 04–07 | `js/pages/models.js` | W1 |
| **W4 节点 + 统计** | 效果图 08–10 | `js/pages/nodes.js`、`js/pages/stats.js` | W1 |
| **W5 设置 + Full 页** | 效果图 11；概览、接入信息按规范 §5.5 | `js/pages/settings.js`、`access.js`、`overview.js` | W1 |

W2–W5 可以并行。`admin.html` 中各页的静态骨架归对应页面包，开工前在 PR 描述里写清楚自己改哪几段。

### H：中枢边缘瘦身（独立一条线）

边缘函数 JS 总字节已贴近上限（见 `docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md` §1.2）。方向：边缘只保留鉴权、配置读写、节点签发与拉配置、vault manifest/fetch，加一个「按供应商转发」端点（服务端从 KV 注入 Key，只放行该供应商 base_url 的 host）；测 Key、校验、探测模型、失败原因分类、models.dev 目录裁剪移到控制台。
先改 `docs/ADMIN_UI_BACKEND_CONTRACT.md` 与 `shared/contracts/admin-ui-backend.json`，再动代码；在 W0 之后进行，和 W2–W5 只在 `js/core.js` 的请求函数上相交，届时先合 H 的请求函数改动。

## 验收（由 Hark 执行）

每个包的 PR 需要：

1. `npm run check` 通过，贴命令输出的最后几行。
2. 截图：浅色主题、1280 宽，对应效果图的同一状态各一张（列表页、弹框打开态）；W1 额外给暗色主题一张。截图放 `scratch/`，在 PR 描述里贴图。
3. 自查清单（逐条打勾）：
   - [ ] 没有新增后端字段，没有改接口
   - [ ] JS / HTML 中没有尺寸数字；颜色只在 `:root` 与暗色块
   - [ ] 列表行全部来自 `listRow()`，名称、状态、计数三列跨页对齐
   - [ ] 列表里没有展开 / 折叠；折叠只出现在弹框的「高级设置」
   - [ ] 时间全部经过 `fmtTime()`
   - [ ] 弹框：Esc / 遮罩 / 关闭可用；有改动时关闭先确认；头尾不随内容滚动
   - [ ] 一个弹框或页头最多一个主按钮

Hark 验收时会：拉取 PR 分支构建，用模拟数据打开 Hub 与 Full 两种模式逐页截图，与效果图并排比对；对照规范 §5 的交互逐条点一遍；不通过的项会以 PR 评论列出，修一次后复核。
