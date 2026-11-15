# Web 管理端 UI 设计与前端工程规范 (KHC Admin Design System + Magpie 轻量架构)

> **核心定位**：保留 `yetone/magpie` 的 **“零依赖、单文件瞬开、行内原地展开编辑、零内联样式”** 轻量工程内核，同时全面采用 **KHC Admin Design System** 的视觉令牌、栅格规范与移动优先响应式体系，彻底消除 1 代遗留的杂乱样式、硬编码元素与双模式别扭兼容。
> **适用端**：EdgeOne Makers 轻中枢 (`hub`) 管理端与 Go 标准 VM 完整节点 (`full`) 管理端（`lite` 极简节点无 UI，VM 端通过 `//go:embed assets/index.html` 静态内嵌，零运行时内存膨胀）。

---

## 一、 工程轻量化与硬性门禁（Hard Gates）

所有 UI 变更必须通过 `npm run build:admin` 与 `npm run verify:release` 的 5 项自动化门禁校验：

1. **零外部依赖**：`package.json` 的 `dependencies` 与 `devDependencies` 保持 `{}`，严禁引入 React / Vue / Tailwind / ECharts / 图标字体包，全部采用原生 HTML5 + CSS3 + ES6 + 内联 SVG。
2. **零内联样式（Zero Inline Style）**：HTML 与 JS 字符串中严禁出现 `style="..."`，JS 代码中严禁出现 `.style.xxx`（显隐统一使用 `[hidden]` 与 `.hidden`，SVG 尺寸/进度条使用 SVG 属性如 `width` / `height` / `rx`）。
3. **零抽屉弹窗（Zero `.drawer`）**：列表项配置统一使用行内原地展开（`.row` + `.editor`），严禁右侧大抽屉套娃。
4. **零左边框色条**：严禁使用 `border-left: ... (#|rgb|hsl|var(--)` 彩色竖条，状态统一采用 `7px` 语义圆点（`.dot`）与轻量胶囊（`.pill`）。
5. **单文件瞬开体积上限**：`shared/admin/dist/index.html` 与 `internal/admin/assets/index.html` 体积必须 **≤ 245,760 bytes（240 KB）**，当前为 ~215 KB。

---

## 二、 KHC Admin Design System 视觉令牌

定义于 [`shared/admin/css/app.css`](file:///Users/xk/Documents/llmproxy2/shared/admin/css/app.css)，原生支持 Light 与 Dark（`data-theme="dark"` 或系统偏好）双主题：

| 类别 | Token | Light 值 | Dark 值 | 用途 |
|---|---|---|---|---|
| **主强调色** | `--khc-primary-500` | `#1664FF` | `#3B82F6` | 主按钮、激活态、图表主柱、进度条 |
| | `--khc-primary-600` | `#0F54E0` | `#2563EB` | 主按钮悬停态 |
| | `--khc-primary-50` | `#E6EEFF` | `rgba(59,130,246,0.15)` | 角色徽章底色、强调胶囊底色 |
| **中性表面** | `--khc-surface-page` | `#F8FAFC` | `#0F172A` | 全局页面底色 |
| | `--khc-surface-card` | `#FFFFFF` | `#1E293B` | 卡片、吸顶顶栏、表格表面 |
| | `--khc-surface-hover` | `#F1F5F9` | `#334155` | 列表行悬停与展开高亮 |
| | `--khc-surface-muted` | `#F1F5F9` | `#162032` | 分段轨道、行内编辑器背景、表头 |
| **边框线条** | `--khc-border-1` | `#E2E8F0` | `#334155` | 卡片外框、表格/行分割线 |
| | `--khc-border-2` | `#CBD5E1` | `#475569` | 按钮悬停边框 |
| **文字层级** | `--khc-text-1` | `#0F172A` | `#F8FAFC` | 主标题、核心数值、正文 |
| | `--khc-text-2` | `#475569` | `#94A3B8` | 副标题、标签、次级说明 |
| | `--khc-text-3` | `#94A3B8` | `#64748B` | 占位符、图标、辅助次要文本 |
| **语义状态** | `--khc-success-500` | `#10B981` | `#10B981` | 在线、探活通过、健康进度 |
| | `--khc-warning-500` | `#F59E0B` | `#F59E0B` | 冷却中、重试、未探活 |
| | `--khc-danger-500` | `#EF4444` | `#EF4444` | 异常、吊销、鉴权失败 |

### 布局与控件尺寸规范
- **4px 基准栅格**：所有间距严格采用 `4px` 倍数（`4 / 8 / 12 / 16 / 20px`）。
- **居中容器**：`.main-wrap` 与 `.header-inner` 最大宽度 `1120px`，左右留白 `20px`（移动端 `12px`）。
- **吸顶顶栏**：桌面端高度 `48px`（`--khc-header-h`），仅含品牌标识+角色徽章、分段主导航（`.seg`）、版本号/模式切换/隐私遮罩/主题切换/登出按钮。
- **统一控件高度**：所有 `.btn`、`.input`、`.select` 统一高度 `32px`（`--khc-ctrl-h`），圆角 `6px`（`--khc-radius-md`）；行内小按钮 `.btn--sm` 高度 `26px`。
- **数字排版**：所有计数、延迟、版本号、密钥预览、IP 地址均使用 `.tabular`（`font-variant-numeric: tabular-nums` + 等宽字体栈）。
- **零 Emoji 规范**：全站界面（含按钮、折叠标题、状态提示）严禁使用 emoji，统一使用 [`shared/admin/js/icons.js`](file:///Users/xk/Documents/llmproxy2/shared/admin/js/icons.js) 提供的线性 SVG 图标（`uiIcon()`）与供应商官方品牌 SVG（`renderBrandIcon()`）。

---

## 三、 零硬编码原则（Zero Hardcoded DOM Elements）

[`shared/admin/admin.html`](file:///Users/xk/Documents/llmproxy2/shared/admin/admin.html) 仅保留语义化骨架，禁止写死业务或演示数据：
1. **供应商预设模板**：`#newProvPreset` 不在 HTML 中硬编码 `<option>`，由 `app.js` 的 `populatePresetDropdown()` 运行时从 `PRESETS_META` 动态渲染。
2. **接入地址与配置默认值**：`#gwBaseUrl` 由 `location.origin` 动态生成；超时与冷却秒数不在 HTML 中写死 `value="120"` 等静态值，统一使用 `placeholder` 并由后端/KV 下发的 `state.config.settings` 填充。
3. **角色与版本标识**：`#brandRole`、`#loginHostBadge`、`#configVersionDisplay` 全部由运行时 `window.HOST.kind` 与 `_version` 动态写入。

---

## 四、 信息架构与端能力对齐（Hub vs Full）

| 视图 Tab | EdgeOne Hub (`hub`) | VM 完整节点 (`full`) | 核心内容 |
|---|---|---|---|
| **概览 (`viewActivity`)** | 显示 `#hubOverviewBox` | 显示 `#fullOverviewBox` | **Hub**：8 项对称 KPI、供应商密钥池健康分布表 + 一键批量探活、中转节点同步/304 遥测表<br>**Full**：8 项对称 KPI、纯 SVG 双色堆叠柱状图（含 X 轴标签防重叠守卫）、53 周热力图、3 维用量排行、60 条请求瀑布流轨迹 |
| **供应商 (`viewProviders`)** | 完整管理 + 密钥探活持久化 | 完整管理 + Vault 同步 + 探活/余额/OAuth | 搜索框 + 状态分段筛选（全部/已启用/探活通过/异常或未测）、cURL 自动解析、行内密钥池表格与模型探测一键纳管 |
| **模型路由 (`viewModels`)** | Agent 路由 + KB 4 流水线配置 | Agent 路由 + KB 4 流水线配置 + 在线路由测试 | 顶部 `Agent 路由 / KB 流水线` 切换器、模型搜索框、候选权重与粘性 Key 行内编辑器 |
| **中转节点 (`viewNodes`)** | 完整支持 | 隐藏 | 节点签发（`NODE_TOKEN`）、租约与模型/供应商白名单（`scope`）、轮换 Token、吊销/恢复 |
| **系统设置 (`viewSettings`)** | 卡片 `2`（全局策略）+ 卡片 `5`（备份与迁移） | 卡片 `1~5` 全部开放 | 编号步骤卡片：1 网关接入与密钥、2 路由与冷却策略、3 时段调度与并发、4 Vault 连接、5 JSON 导出与 v1/v2 导入 |

---

## 五、 手机端响应式适配规范（`<= 768px`）

针对 `375px ~ 768px` 移动端视口强制保证 **零横向溢出（`scrollWidth <= innerWidth`）**：
1. **顶栏两行折叠与横向滑轨**：`.header-inner` 自动换行，第一行保留品牌与操作图标按钮，第二行 `.nav-wrap` 占满 `100%` 宽度并支持横向平滑滑动（隐藏滚动条）。
2. **KPI 卡片网格**：桌面端 4 列（`repeat(4, minmax(0, 1fr))`）自动切换为移动端 **2 列（`repeat(2, minmax(0, 1fr))`）**，8 项 KPI 始终保持 `2×4` 对称。
3. **表单栅格**：桌面端 3 列（`.form-grid`）与 2 列（`.form-grid--2`）在移动端统一收敛为 **单列**。
4. **宽表局部滚动**：所有密钥池表格、供应商健康分布表、中转节点遥测表均包裹在 `.table-wrap`（`overflow-x: auto`）内，避免撑破页面整体宽度。
5. **列表行与工具栏**：`.row` 右侧 `.fields` 在移动端自动折行右对齐；搜索框自动占满 `100%` 宽度。


---

## 6. 对齐、按钮尺寸与操作层级规范（严谨标准）

### 6.1 垂直与水平对齐基准
1. **20px 卡片左基准线**：`.card-header`（`12px 20px`）、`.card-pad`（`16px 20px`）、`.row`（`12px 20px`）、`.editor`（`16px 20px`）以及 `.data-table` 首末列（`padding-left/right: 20px`）统一采用 `20px` 水平内边距，确保同页卡片标题、表单首列、表格首列与折叠行严丝合缝在同一垂直线上。
2. **页面头部居中对齐**：`.view-header` 使用 `align-items: center`，左侧标题与右侧 `.view-actions` 按钮组垂直居中对齐。
3. **标签等高禁止塞入按钮**：`.form-label` 固定 `min-height: 18px; line-height: 18px`，**严禁**把按钮放入 `.form-label` 内导致同行输入框高低错位。
4. **输入框同行并排（`.input-row`）**：输入框/下拉框与右侧操作按钮同行时，必须包裹在 `.input-row` 中（`input/select` `flex: 1 1 auto; min-width: 0;`，按钮 `flex-shrink: 0` 且必须使用标准 `32px` `.btn`），保证 `32px` 控件严格等高齐平。
5. **复选框对齐**：所有 `input[type="checkbox"]` 固定 `14px × 14px`，与右侧文字通过 `display: flex; align-items: center; gap: 6px;` 居中对齐。

### 6.2 三档按钮尺寸与适用场景
| 规格 | 高度 / 内边距 / 字号 | 唯一允许使用场景 | 禁止场景 |
| --- | --- | --- | --- |
| **标准 `.btn`** | `32px` / `0 12px` / `12px` | 页面顶部 `.view-actions`、表单底部 `.form-actions`、与 `32px` `.input`/`.select` 同行的 `.input-row` 工具按钮、局部添加提交按钮 | 表格单元格行内 |
| **紧凑 `.btn--sm`** | `26px` / `0 10px` / `11px` | 表格行内操作、卡片头右上角辅助跳转、代码块右上角 `复制`、工具条紧凑辅助按钮 | **严禁与 `32px` `.input` 同行混用** |
| **图标 `.btn--icon`** | `32px × 32px` / `0` | 顶栏纯图标操作（隐私遮罩、主题切换、退出登录） | 带文字按钮 |

### 6.3 按钮语义层级与防误触分栏
1. **单区域单主按钮原则（Single Primary CTA）**：每个独立视图或折叠编辑区**最多 1 个 `.btn--primary`**（实心主蓝，仅用于主保存/主创建动作）；局部辅助动作（如“添加 Key”“添加候选”“随机生成”“探测协议”“选择文件导入”）统一使用标准 `.btn`（白底灰框）。
2. **破坏性操作统一标识**：所有删除、移除、清空、停用、解除冷却操作统一使用 `.btn--danger`（包括表格行内的 `移除` 按钮 `.btn--sm.btn--danger`）。
3. **左右分栏操作栏（`.form-actions--split`）**：当表单底部同时存在危险操作与主保存操作时，必须使用 `.form-actions--split`：**危险/次级维护操作放左侧 `.form-actions-group`，主确认操作（`.btn--primary`）放右侧 `.form-actions-group`**，禁止紧邻混排防止误触。
