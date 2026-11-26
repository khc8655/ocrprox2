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
5. **单文件瞬开体积上限**：`shared/admin/dist/index.html` 与 `internal/admin/assets/index.html` 体积必须 **≤ 327,680 bytes（320 KiB）**（v20261123-06 起；此前 252 KiB，详见 CHANGELOG）。

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
- **4px 基准栅格**：所有间距严格采用 `4px` 倍数（`4 / 8 / 12 / 16 / 20 / 24px`）。
- **居中容器**：`.main-wrap` 与 `.header-inner` 最大宽度 `1120px`，左右留白 `20px`（移动端 `12px`）。
- **吸顶顶栏**：桌面端高度 `48px`（`--khc-header-h`），仅含品牌标识+角色徽章、分段主导航（`.seg`）、版本号/模式切换/隐私遮罩/主题切换/登出按钮。
- **统一控件高度**：所有 `.btn`、`.input`、`.select` 统一高度 `32px`（`--khc-ctrl-h`），圆角 `6px`（`--khc-radius-md`）；行内小按钮 `.btn--sm` 高度 `28px`（`--khc-ctrl-h-sm`）。
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
| **概览 (`viewActivity`)** | **Hub 无此页**（导航隐藏） | 显示 `#fullOverviewBox` | **Full**：8 项对称 KPI、纯 SVG 双色堆叠柱状图（含 X 轴标签防重叠守卫）、3 维用量排行、60 条请求瀑布流轨迹、错误分析 |
| **供应商 (`viewProviders`)** | 完整管理 + 密钥探活持久化 | 完整管理 + Vault 同步 + 探活/余额/OAuth | 搜索框 + A–Z 索引条、行内密钥池表格与模型探测一键纳管 |
| **模型路由 (`viewModels`)** | Agent 路由 + KB 4 流水线配置 | Agent 路由 + KB 4 流水线配置 + 在线路由测试 | 顶部 `Agent 路由 / KB 流水线` 切换器、模型搜索框、候选权重与粘性 Key 行内编辑器 |
| **节点 (`viewNodes`)** | 完整支持（Hub 落地页，登录后默认进入） | 隐藏 | 节点签发（`NODE_TOKEN`）、租约与模型/供应商白名单（`scope`）、轮换 Token、吊销/恢复、行内安装视图 |
| **接入信息 (`viewAccess`)** | **Hub 无此页**（导航隐藏，中枢是配置面，没有自己的数据面） | 显示 `#viewAccess` | 客户端接入（协议分段 + 基址 / 密钥 / 请求地址三个复制芯片）、模拟请求面板、可用模型卡片、支持的接口清单 |
| **系统设置 (`viewSettings`)** | 分组 `2`（路由与限流 / 系统）+ 分组 `1`（接入，投影客户端密钥） | 三个分组全部开放 | **无编号**：分组标题 + `.setting-row` 行清单 |

> **Hub 导航只有四项**：节点 / 供应商 / 模型路由 / 设置。Hub 没有独立的「概览」页——
> 原概览的「活跃 VM 节点」由**节点列表本身**承担（状态点 + 最近同步时间），
> 「VM 端模型使用分布」下沉到**节点页底部的「中枢概览」折叠区**（`#hubOverviewBox`
> 是 `<details class="headers-details">`，内含 6 项下发规模 KPI 与全节点模型使用分布表）。
> 节点上报的模型用量**按节点**显示在节点行展开后的详情里（`#node_model_usage_{id}`）。

### 4.1 系统设置页分组（`#viewSettings`）

设置页**不再有编号步骤卡片**。页面是三个**分组**（`.block`），组内是**子块**
（`.setting-section`），组内每个子块是一份 `.setting-row` 行清单；分组之间靠
`24px` 留白（`--khc-block-gap`）分隔，行清单是唯一的 `1px --khc-border-1` 外框。

| 分组 | 子块 | 行项（`.setting-row`） | Hub / Full |
|---|---|---|---|
| **接入** | 网关接入 | 网关入口地址 (Base URL，只读) · 主客户端鉴权密钥 (client_key) | 两端（Base URL 行仅 Full 显示） |
| **路由与限流** | 全局路由与异常冷却策略 | 默认路由策略 · 首字超时 (秒) · 429 / 5xx / 网络超时 / 401-403 冷却 (秒) · 「解除全部冷却」 | 两端（「解除全部冷却」仅 Full） |
| | 高并发与多模态护栏 | OCR 预读并发上限 · 固定通道全局并发上限 | 两端 |
| **系统** | 模型目录 | 上次更新 · 手动更新（models.dev） | **仅 Hub**（Hub 持有 KV 目录） |
| | Vault 中枢连接 | Vault 中枢地址 · 节点同步 Token · 「测试连接」 | **仅 Full** |
| | 备份与迁移 | 导出当前完整配置 (JSON) · 导入 v1 / v2 配置文件 · 高级折叠（原始 JSON 查看与直接保存） | 两端 |
| | 版本与升级 | 「检查程序更新」·「平滑重启服务」 | **仅 Full** |

**挂载纪律不变**：所有输入框 id 与 `renderSettingsView()` 按 id 填值的逻辑保持原样
（`cfgRoutingStrategy` / `cfgFirstByteTimeout` / `cfgCooldown*` / `cfgOcrInflight` /
`cfgKbConcurrency` / `gwBaseUrl` / `gwClientKey` / `cfgVaultUrl` / `cfgVaultToken` /
`rawConfigTextarea` …）。静态 HTML 只留空容器，由 `mountSettingRows()` 运行时挂载
`.setting-row`。

### 4.2 接入信息页（`#viewAccess`，仅 Full）

四个**分组**（`.block`），与设置页同一套分组组件：

| 分组 | 内容 |
|---|---|
| **客户端接入** | 协议分段控件（OpenAI 兼容 / Claude 系）+ 三个复制芯片（`base_url` / API Key / 请求地址）+ 一行协议说明（缺密钥时额外一行告警说明） |
| **模拟请求** | 协议分段控件 + 模型 ID 输入（带 datalist） + 话术输入 + 「发送」（`.btn--primary`）+ 结果区（`.gw-test-result`） |
| **可用模型** | 计数 `.pill` + 「复制全部」+ 模型卡片网格（`gw-model-item`：模型 ID / 供应商 / 能力目录行，点卡片复制 Model ID） |
| **支持的接口** | 接口路径复制芯片（`gwEndpointChips`） |


---

## 五、 手机端响应式适配规范（`<= 768px`）

针对 `375px ~ 768px` 移动端视口强制保证 **零横向溢出（`scrollWidth <= innerWidth`）**：
1. **顶栏两行折叠与横向滑轨**：`.header-inner` 自动换行，第一行保留品牌与操作图标按钮，第二行 `.nav-wrap` 占满 `100%` 宽度并支持横向平滑滑动（隐藏滚动条）。
2. **KPI 卡片网格**：桌面端 4 列（`repeat(4, minmax(0, 1fr))`）自动切换为移动端 **2 列（`repeat(2, minmax(0, 1fr))`）**，8 项 KPI 始终保持 `2×4` 对称。
3. **表单栅格**：桌面端 `.form-grid` / `.form-grid--2` 均为 **2 列**（基本字段 ≤ 4 个，两列网格），移动端统一收敛为 **单列**。
4. **宽表局部滚动**：所有密钥池表格、供应商健康分布表、中转节点遥测表均包裹在 `.table-wrap`（`overflow-x: auto`）内，避免撑破页面整体宽度。
5. **列表行与工具栏**：`.row` 右侧 `.fields` 在移动端自动折行右对齐；搜索框自动占满 `100%` 宽度。


---

## 6. 对齐、按钮尺寸与操作层级规范（严谨标准）

### 6.1 垂直与水平对齐基准
1. **20px 卡片左基准线**：`.card-header`（`12px 20px`）、`.card-pad`（`16px 20px`）、`.row`（`12px 20px`）、`.editor`（`16px 20px`）以及 `.data-table` 首末列（`padding-left/right: 20px`）统一采用 `20px` 水平内边距，确保同页卡片标题、表单首列、表格首列与折叠行严丝合缝在同一垂直线上。
2. **页面头部居中对齐**：`.view-header` 使用 `align-items: center`，左侧标题与右侧 `.view-actions` 按钮组垂直居中对齐。
3. **标签等高禁止塞入按钮**：`.form-label` 固定 `min-height: 18px; line-height: 18px`，**严禁**把按钮放入 `.form-label` 内导致同行输入框高低错位（标签旁的说明用 ⓘ `.field-hint`）。
4. **输入框同行并排（`.input-row`）**：输入框/下拉框与右侧操作按钮同行时，必须包裹在 `.input-row` 中（`input/select` `flex: 1 1 auto; min-width: 0;`，按钮 `flex-shrink: 0` 且必须使用标准 `32px` `.btn`），保证 `32px` 控件严格等高齐平。
5. **复选框对齐**：所有 `input[type="checkbox"]` 固定 `14px × 14px`，与右侧文字通过 `display: flex; align-items: center; gap: 6px;` 居中对齐。

### 6.2 三档按钮尺寸与适用场景
| 规格 | 高度 / 内边距 / 字号 | 唯一允许使用场景 | 禁止场景 |
| --- | --- | --- | --- |
| **标准 `.btn`** | `32px` / `0 12px` / `13px` | 页面顶部 `.view-actions`、表单底部 `.form-actions`、与 `32px` `.input`/`.select` 同行的 `.input-row` 工具按钮、局部添加提交按钮 | 表格单元格行内 |
| **紧凑 `.btn--sm`** | `28px` / `0 10px` / `13px` | 表格行内操作、卡片头右上角辅助跳转、代码块右上角 `复制`、工具条紧凑辅助按钮 | **严禁与 `32px` `.input` 同行混用** |
| **图标 `.btn--icon`** | `32px × 32px` / `0` | 顶栏纯图标操作（隐私遮罩、主题切换、退出登录） | 带文字按钮 |

> 按钮变体（主要 / 默认 / 文字 / 危险）与单区域单主按钮原则见 [§七 组件标准](#七组件标准极简一套组件一种交互)。

### 6.3 按钮语义层级与防误触分栏
1. **单区域单主按钮原则（Single Primary CTA）**：每个独立视图或折叠编辑区**最多 1 个 `.btn--primary`**（实心主蓝，仅用于主保存/主创建动作）；局部辅助动作（如“添加 Key”“添加候选”“随机生成”“探测协议”“选择文件导入”）统一使用标准 `.btn`（白底灰框）。
2. **破坏性操作统一标识**：所有删除、移除、清空、停用、解除冷却操作统一使用 `.btn--danger`（包括表格行内的 `移除` 按钮 `.btn--sm.btn--danger`）。
3. **左右分栏操作栏（`.form-actions--split`）**：当表单底部同时存在危险操作与主保存操作时，必须使用 `.form-actions--split`：**危险/次级维护操作放左侧 `.form-actions-group`，主确认操作（`.btn--primary`）放右侧 `.form-actions-group`**，禁止紧邻混排防止误触。

### 6.4 设置行组件规范（`.setting-row`，v20261123-03 新增，v20261126-01 归入 `.block` 分组）

系统设置页一类「一行一项」配置清单统一使用 `.setting-row`（定义于 [`shared/admin/css/app.css`](file:///Users/xk/Documents/llmproxy2/shared/admin/css/app.css)，生成器 `settingRow(title, desc, controlHtml)` 于 [`shared/admin/js/app.js`](file:///Users/xk/Documents/llmproxy2/shared/admin/js/app.js)），替代裸 `.form-grid` 网格，与 magpie 设置页形态对齐。**设置页整体骨架是 `.block` 分组（见 [§7.0b](#70b-分组-block设置页--接入信息页的骨架)），不再有编号步骤卡片**：

1. **结构**：`.setting-row`（`display:flex; align-items:center`）内为 `.setting-main`（`flex:1; min-width:0`，含标题与说明）+ `.setting-control`（`flex-shrink:0; gap:8px`，右侧控件容器）。
2. **尺寸**：行内边距 `10px 0`（上下），列间距 `16px`（4px 栅格）；标题 `.setting-title` `14px / font-weight:500`，说明 `.setting-desc` `12px / margin-top:2px`；控件高度沿用全局 `32px`（`--khc-ctrl-h`）。
3. **颜色只用 KHC token**：标题 `--khc-text-1`、说明 `--khc-text-2`、行间分隔线 `1px solid var(--khc-border-1)`（`.setting-row:last-child` 无分隔线）；严禁硬编码色值。
4. **悬停提示**：行容器 `title` 属性由 `settingRow()` 自动镜像说明文本，鼠标悬停即显示完整说明——新增行必须走 `settingRow()` 生成器，不得手写缺失 `title` 的行。
5. **控件宽度约定**：`.setting-control .input` 固定 `110px`（秒数/并发数等小数值输入），`.setting-control .select` 宽度自适应（`width:auto`）；超长控件（搜索框等）不适用本组件。
6. **移动端 ≤768px**：`.setting-row` 折行（`flex-wrap:wrap; gap:8px 16px`），`.setting-control` 占满整行（`flex-basis:100%`）。
7. **挂载纪律**：静态 HTML 只留空容器（如 `#routingPolicyRows`），由 `mountSettingRows()` 运行时一次性挂载；行内输入框 id 必须保留原 id（`renderSettingsView` 按 id 填值），禁止在 HTML 中硬编码业务默认值。
8. **行清单外框**：`.setting-rows` 容器是「列表容器」，保留 `1px solid var(--khc-border-1)` 上下外框；行清单之外的分组标题区**不带外框**（卡片去外框、靠留白分隔）。

### 6.5 输入框下拉浮层规范（`.np-combo` / `.np-panel`，v20261123-03 新增）

「输入框 + 可搜索候选面板」组合（如新增模型路由的「首选供应商」）必须浮层化，严禁表单流内联展开挤开布局：

1. **结构**：`.np-combo`（`position:relative`）包裹输入框与 `.np-panel`（`position:absolute; top:100%; left:0; right:0`）——面板贴齐输入框整行宽度，`z-index:30` 浮于后续表单字段之上，`max-height:280px`，阴影 `var(--khc-shadow-md)`。
2. **面板三段**：`.np-panel-search`（固定顶部，`border-bottom: var(--khc-border-1)`）、`.np-panel-options`（唯一滚动区，`overflow-y:auto; min-height:0`）、`.np-panel-foot`（固定底部，操作按钮放此处）；`display:flex; flex-direction:column` 保证搜索框与页脚不随列表滚动。
3. **复用纪律**：候选行复用供应商列表的 `.row/.who/.name`，面板本体仅是 `.card`——不为本组件新增行样式。

---

## 七、组件标准（极简：一套组件一种交互）

> **设计先行**：本节是全站前端的组件契约。新写法必须复用下列 8 个组件；只用一次的样式一律内联到复用组件上（禁止新增只出现一次的类）。落地实现在 [`shared/admin/css/app.css`](file:///Users/xk/Documents/llmproxy2/shared/admin/css/app.css)，帮助函数在 [`shared/admin/js/app.js`](file:///Users/xk/Documents/llmproxy2/shared/admin/js/app.js)。

### 7.0 视觉基线

1. **灰阶 + 一个主色**：全站颜色只用 `--khc-*` token，唯一彩色是 `--khc-primary-500`（主按钮 / 激活态）。禁止硬编码色值；禁止彩色左边框（门禁 4）。
2. **卡片去阴影**：`.card` / `.kpi-card` / `.metric-box` 等一律 `box-shadow: none`；**只有列表容器保留 `1px solid var(--khc-border-1)` 外框**。阴影仅允许出现在浮层（`.dialog` / `.menu-pop` / `.toast`）——它们必须读作与平面分离。
3. **区块之间靠 `24px` 留白分隔**（`--khc-block-gap: 24px`），不再一张张卡片叠。`.card` 的 `margin-bottom` 即为该留白。
4. **字号只有三档**：正文 `14px`（`--khc-text-md`）、控件 `13px`（`--khc-text-sm`）、辅助 `12px`（`--khc-text-xs`）。**禁止 11px**。`≤12px` 不得用 `600` 字重（字重上限 `500`）。
5. **页面头**：标题 `18px / 500`（`.view-title`）；副标题最多一行 `13px` `--khc-text-2`（`.view-sub`），能删就删。`.view-header` 与 `.view-actions` 垂直居中。
6. **零内联样式、零 `.drawer`**（门禁 1 / 2）：显隐统一用 `[hidden]` / `.hidden`；SVG 尺寸用属性。

### 7.0b 分组 `.block`（设置页 / 接入信息页的骨架）

页面级分区用 `.block`，**不是**卡片：分组标题下是一条 `1px --khc-border-1` 分隔线，
组内是子块与行清单，组间靠 `24px` 留白。

1. **`.block`**：一个分组容器，`margin-bottom: var(--khc-block-gap)`。
2. **`.block-head`**：分组标题行（`.block-title`，`14px / 500`）+ 右侧动作区（`.block-actions`）；底部一条 `1px` 分隔线。
3. **`.setting-section`**：组内子块（如「路由与限流」下的「全局路由与异常冷却策略」），标题 `.setting-section-title`（`13px / 500`）+ 说明 `.setting-section-sub`（`12px --khc-text-2`），右侧动作 `.block-actions`。
4. **`.setting-rows`**：行清单容器，**唯一的 `1px --khc-border-1` 外框**（上下各一条），行间一条分隔线；内部每行是 `.setting-row`。
5. **`.setting-row`**：一行一项 —— 左侧 `.setting-main`（`.setting-title` `14px / 500` + `.setting-desc` `12px --khc-text-2`），右侧 `.setting-control`（控件，`32px` 高）。数值输入固定 `110px` 宽以对齐控制列。
6. **`.setting-row` 的说明不常驻**：整行 `title` 属性镜像说明文本，鼠标悬停即显示；控件本身的补充说明写进 `placeholder`。

### 7.1 按钮 `.btn`（四种）

| 变体 | 用途 |
|---|---|
| `.btn--primary` | 主要动作。每个区域最多 1 个（单区域单主 CTA）。 |
| `.btn` | 默认动作（次级、并列操作）。 |
| `.btn--ghost` | 文字按钮：表格行内次要操作、顶栏图标按钮。 |
| `.btn--danger` | 破坏性动作：删除 / 移除 / 清空 / 吊销 / 停用 / 解除冷却 / 轮换。 |

1. **高度 `32px`**（`--khc-ctrl-h`），圆角 `6px`，字号 `13px`。
2. **行内紧凑 `.btn--sm` 高度 `28px`**（`--khc-ctrl-h-sm`），字号仍为 `13px`。严禁与 `32px` 控件同行混用。
3. **图标按钮 `.btn--icon`**：`32px × 32px`，仅顶栏纯图标操作使用。

### 7.2 输入 / 选择 `.input` / `.select`

1. **高度 `32px`，字号 `13px`**；`.textarea` 同字号、最小高度 `76px`。
2. **标签在上方**：`.form-label`（`12px` `--khc-text-2`，`min-height:18px`）。标签里**严禁**塞按钮导致同行高低错位。
3. **字段说明不常驻**：优先写进 `placeholder`；放不下的补充说明在**标签旁放一个 ⓘ**（`.field-hint`，`title` 悬停提示）。
4. **校验错误才显示红字**：`.field-error`（`12px` `--khc-danger-text`），输入框加 `aria-invalid="true"`。

### 7.3 列表 `.list > .row`

1. **行高 ≥ 44px**（`.row` 的 `min-height`）；悬停整行 `--khc-surface-hover`；展开态（`.row.expanded`）同色；**行尾 chevron**（`.caret`，展开时旋转 180°）。
2. **一行里只允许**：名称、一行次要信息（`12px` **等宽** `--khc-text-2`，即 `.sub`，用 `--khc-font-mono` 让 Base URL / ID 等长串同列对齐）、**一个状态**（`.dot` + 一个词）、**至多一个计数**（`.pill`）。
3. **禁止一行堆 3 个以上 pill**：多余的标签（适配版本 / 归属 / 正常数 / 运行中…）合并进 `.sub` 行或收进「⋯」菜单。

### 7.4 数据表 `.data-table`

1. **表头 `12px` `--khc-text-2` 无底色**；**行高 `40px`**；悬停高亮整行。
2. **操作列右对齐**；表首末列 `padding-left/right: 20px` 与卡片标题对齐。
3. **行内操作 ≤ 2 个**用 `.btn--sm .btn--ghost`；**更多收进「⋯」菜单**（组件 7）。

### 7.5 行内编辑器 `.editor`（唯一的增删改查模式）

1. **点行展开编辑**；宪法规定**不用抽屉**（门禁 3）。
2. **「新增 X」按钮在列表顶部插入一个空白编辑器**（与编辑用**同一个构建函数**，`create` 模式），**不再用居中弹框**。
   - 实现：新增走 `buildProviderCreateEditor()` / `buildModelCreateEditor()`，二者与 `buildProviderEditor()` / `buildModelEditor()` 共用同一套字段、id 与保存逻辑，仅「新建」时字段留空、无「删除」按钮。
   - 状态：`state.creatingProvider` / `state.creatingModel`（互斥于普通展开态 `state.activeEditorKey`）。再次点击「新增 X」按钮、点「取消」、按 `Esc`、或点任意列表行都会收起它。
   - 接线顺序：编辑器**先挂进 DOM 再接线**（`wireProviderCreateEditor()` / `wireModelCreateEditor()`）—— 控件靠全局 `$()` 查找，元素没接上时点击处理器绑不上。
3. **编辑器结构固定**：基本字段（≤ 4 个，两列网格 `.form-grid`）→ 子表（Key、候选等）→「高级」折叠（`<details class="headers-details">`，带 chevron）→ 底部 `.form-actions--split`：**左侧「删除」**（危险，二次确认），**右侧「取消」+「保存」**（主要）。
4. 保存逻辑与后端读写字段不变；按 id 填值的输入框（如 `renderSettingsView` 依赖的 id）**保留原 id**。

### 7.6 弹框 `.dialog`（只用于三类场景）

1. **用途限定**：(a) 删除 / 吊销 / 轮换等**确认**；(b) **只显示一次**的密钥、密码、安装命令；(c) **登录**。
2. **统一组件**：`.dialog`（遮罩）+ `.dialog-body`（宽 `480px`，`--wide` 变体 `640px`）+ `.dialog-head`（标题 `16px`，右上角 `✕` 图标按钮 `.dialog-close`）+ `.dialog-actions`（底部按钮右对齐）。
3. **交互**：`Esc` 与**点击遮罩**关闭；**不嵌套**。
4. **统一确认入口**：所有二次确认走 `confirmDialog()` 帮助函数（返回 `Promise<boolean>`），**禁止原生 `window.confirm()` / `alert()`**。业务弹框走 `openDialog()` / `closeDialog()`；需要副作用的弹框用 `registerDialog(id, closer)` 注册关闭动作（恢复焦点、取消进行中的批量拉取等）。
5. **登录保留独立外观可以，但样式名分开**：登录遮罩用 `.login-overlay` / `.login-card`，**不得**复用这两个类名给业务弹框。

### 7.7 菜单 `.menu`

1. **行内次要操作超过 2 个时收进「⋯」**（`.menu-btn`）。
2. **浮层用类名控制位置**（`.menu-pop` 默认右对齐，`.menu-pop--left` 左对齐），**无内联样式**。
3. 菜单项 `.menu-item`，危险项加 `.menu-item--danger`。点菜单外部或按 `Esc` 关闭。
4. **「菜单开着」的定义是「浮层仍在 DOM 上且可见」**：列表重绘（`innerHTML` 重建）会把浮层从 DOM 上摘除，留下「已脱离 DOM 但 `hidden=false`」的死条目。死条目**不得**吞掉本该关闭弹框的 `Esc` —— 读菜单状态前必须先剔除 `!isConnected || hidden` 的条目（`pruneOpenMenus()`）。同理，列表重绘前先关掉已开的菜单。

### 7.8 状态与提示

1. **状态 = `.dot` + 一个词**：`.dot` / `.dot--ok` / `.dot--warn` / `.dot--err`（`7px` 语义圆点）。
2. **`.pill` 只用于中性计数 / 标签**（无彩色语义版本；状态语义一律走 `.dot`）。
3. **Toast 保持现状**：`.toast-box` / `.toast`，右下角堆叠。

### 7.9 空状态

**一句话 + 一个主按钮**（`.btn--primary`）。禁止空状态里堆多个按钮。

### 7.10 供应商页（`#viewProviders`）的落地口径

1. **列表行**（组件 3）：名称 + 一行次要信息（供应商 ID · Base URL，12px 等宽）+ **一个状态**（`.dot` + 一个词，综合「停用 / 无 Key / 异常 / 部分异常 / 运行中 / 正常 / 未测」）+ **至多一个计数**（`N 把 Key`）。适配版本、归属（本地私有 / 共享）、正常数等次要标签**全部挪进编辑器**，列表不再堆 pill。
2. **新增供应商**：`#btnAddProvider` 在列表**顶部**插入空白 `.editor`（create 模式，`buildProviderCreateEditor()`）；编辑器开着时页头按钮变「收起」且去掉 `.btn--primary`（同一屏只有一个主按钮）。空列表走「一句话 + 一个主按钮」的空状态。
3. **新增编辑器的必填只有三项**：名称、Base URL、API Key（多把换行 / 逗号分隔，`<textarea>`）。**供应商 ID 由名称自动生成**（`providerIdFromName()`，预设命中时用预设 id），可在「高级」里改；**保存后不可改**（编辑器的「高级」里以只读 `input` 展示）。
4. **协议默认自动识别**：`#newProvApiType` 首选「自动识别」，保存时调 `detectProviderProtocol()` 探测上游；手动选择与「探测协议」按钮都在「高级」里。
5. **「高级」折叠**收纳：供应商 ID / 协议 / 预设 / Key 标签前缀 / RPM 上限 / 每日重置时间 / 隐藏客户端 UA / 适配规则 JSON。
6. **顶部文字链接**：「从 cURL 解析」（展开粘贴框）与「改用中枢托管供应商」（Hub 端隐藏）—— 用 `.text-link`（文字按钮），不占 `.btn` 位。
7. **Key 子表**（组件 4）列固定为：`启用 / 标签 / Key / 状态 / 操作`。「测试」「校验」合并为一个**「测试」**（保留真发「你好」的行为），「校验（探活）」「解除冷却」「删除此 Key」收进「⋯」菜单（菜单项仍带 `.btn_verify_k` / `.btn_clear_k_cd` / `.btn_del_k` 类名，功能把手不丢）。权重输入（`.input--compact`，72px）与标签**同一行**并排（`.fields`），不另起一行 —— 另起一行会把行高撑到 70px，违反 §7.4 的 40px 行高。
8. **编辑器里的子表行高 40px**：`.editor .data-table td` 的上下内边距收到 `6px`（默认 `9px`），行内 28px 控件（权重输入 / `.btn--sm`）+ 12px 内边距 = 40px，与 §7.4 的数据表行高一致。
9. **「一键测全部 Key」与「OAuth 扫码登录」在子表标题行右侧**；「添加 Key」是表格下方一行输入（标签 + 完整 Key + 按钮）。
10. **底部 `.form-actions--split`**：左侧「删除供应商」（`.btn--danger`，走 `confirmDialog()` 二次确认），右侧「取消」+「保存」（`.btn--primary`）。中枢托管供应商没有「保存」（中枢是权威），改成「重新拉取」。
11. **Hub 与 Full 的差异保持**：Hub 无「归属」列、「逐把测 Key」文案、无 OAuth / 探测协议 / 中枢托管来源；Hub 页头多一个「一键探活全部 Key」（`#btnHubBatchVerifyAll`，逐把探活不消耗推理额度）。

### 7.12 模型路由页（`#viewModels`）的落地口径

1. **列表行**（组件 3）：模型名 + **一行次要信息**（首选候选 = 排第一的那个候选：`供应商 · 上游模型 · Key`，12px 等宽）+ **一个状态**（`.dot` + 一个词：`可用 / 停用 / 无候选`）+ **至多一个计数**（`N 候选`）。上游模型为空时显示路由名 —— 调度器也是这么回退的（候选 → 别名 → 路由名）。
2. **一个编辑器管完整个模型**：`buildModelEditor(mName, m, { create })` 是新增与编辑**共用的唯一构建函数**，`wireModelEditor()` 是共用的唯一接线函数。新增 = 列表顶部插入空白 `.editor`（`state.creatingModel`），**不再有居中弹框**；页头按钮在编辑器开着时变「收起」且去掉 `.btn--primary`（同一屏只有一个主按钮）。
3. **编辑器结构固定**：基本字段（`对外模型名` + `路由策略`，两列网格）→ **候选子表** → 「测试这个模型」→ 「高级」折叠 → 底部 `.form-actions--split`（左「删除此路由」走 `confirmDialog()`，右「取消」+「保存」）。create 模式没有「删除」按钮。
4. **对外模型名可留空**：留空时取第一个候选的上游模型 ID（单候选路由的常见情形）。改名 = 换路由键：老键删除、新键挂上，编辑器跟着新名字继续开着。
5. **候选子表**（组件 4 `.data-table`）列固定为：`供应商 / 上游模型 / Key / 思考档位 / 状态 / 操作`。
   - 「Key」列是**每候选一个 `<select>`**：第一项「任一」（= 展开该供应商全部启用 Key），其后是该供应商真实存在的 Key 标签；已绑定但本地已没有的标签照样显示（标「本地缺失」），不静默改成「任一」。
   - 「思考档位」是 per-candidate 的 `<select>`，档位阶梯来自 models.dev 目录（异步），没到之前这一格留空 —— 不显示可能被误认成真值的占位符。
   - 「状态」= `.dot` + 一个词（启用 / 停用）。行内操作是「↑ / ↓ / 移除」三个 `.btn--sm`：排序用 `.btn--sm .btn--ghost`，「移除」是破坏性操作用 `.btn--sm .btn--danger`（§6.3.2）；首个 ↑ 与末个 ↓ 禁用。
6. **「＋ 添加候选」就地展开一行内联选择**（不弹框、不进抽屉）：供应商下拉沿用 `.np-combo` / `.np-panel` 规范（浮层贴输入框整行宽度，搜索钉顶、只有选项列表滚动）；选供应商后可「拉取上游模型」（缓存进 `state.probedModelsByProvider`）并用过滤框缩小范围，勾选模型与 Key 后「添加候选」落进子表。勾多把 Key = 「每个模型 × 每把 Key」各生成一个候选；不勾 = 任一 Key（一个候选）。
7. **「测试这个模型」在编辑器内、候选列表下方**：选「哪个候选」+「用哪把 Key」→ 真实发一句「你好」，把上游实际回复显示出来（`.m-test-out` + `.gw-test-meta` / `.gw-test-reply`）。
8. **「高级」折叠**收纳：指定 / 首选 Key（`provider:key_label`）、候选 Key 回退同供应商其它 Key、剥离思考、强制非流式、候选权重 / 并发上限。
9. **模型名可以含点号与空格**：模型名**绝不进 CSS 选择器**（历史 bug）。编辑器里所有 id 都是静态的，模型名只作为普通文本与 `data-*` 值出现。
10. **「从模板导入」保留**：走统一 `.dialog`（`--wide` 640px），弹框内是统一列表样式（组件 3 `.list > .row`）：勾选框 + 路由名 + 一行次要信息 + 一个状态（可导入 / 缺依赖）+ 一个计数。缺 Key 标签的中枢托管供应商就地给「补拉」按钮；本地自建供应商只给说明（中枢补不回来）。
11. **Hub 与 Full 的差异保持**：Hub 无「从模板导入」（`vaultClient` 门控）、无上游模型能力摘要（Hub 没有推理引擎）；Full 两样都有。

### 7.12b 节点页（`#viewNodes`）的落地口径（Hub 落地页）

1. **导航与落地**：Hub 导航只剩「节点 / 供应商 / 模型路由 / 设置」四项，**登录后默认进「节点」**；Hub 端不再显示「概览」页（`#navActivity` 隐藏，`state.activeTab = 'nodes'`）。Full 端不受影响（Full 没有节点页，`#navNodes` 由 `nodeManager` 门控隐藏）。
2. **列表行**（组件 3）：节点名 + **一行次要信息**（`角色 · 最近同步 · 最近 IP`，12px 等宽）+ **一个状态**（`.dot` + 一个词：`在线 / 离线 / 宽限期内 / 未安装 / 已吊销`）+ **一个计数**（`N 次同步`）。适配版本 / 配置版本 / IP 不再堆 pill —— 详情行里全都有。
3. **「新增节点」= 列表顶部插入空白 `.editor`**（create 模式，`state.creatingNode`），与编辑共用 `buildNodeEditor(node, { create })` / `wireNodeEditor()`。
   - **create 模式只填「节点名称」**（`#issueNodeName`）；角色、租约、宽限期、供应商/模型权限范围全部收进「高级」折叠。
   - create 模式的控件沿用签发表单的旧 id（`#issueNodeName` / `#issueNodeRole` / `#issueNodeTTL` / `#issueNodeGraceTTL` / `#issueNodeProvAll` / `#issueNodeProvs` / `#issueNodeModelAll` / `#issueNodeModels`），编辑模式用 `#ed_node_*_{id}`；两套 id 指向同一套取值逻辑。
   - 页头「添加节点」按钮在编辑器开着时变「收起」且去掉 `.btn--primary`（同一屏只有一个主按钮）；空列表走「一句话 + 一个主按钮」的空状态。
4. **保存后同一个编辑器切换为「安装」视图**（`state.nodeInstallFor = <node id>`）：
   - **一条推荐命令**（一键安装 · systemd）+ 「复制命令」按钮；
   - **后台密码**（Full 才有）只此一次，带「复制密码」；
   - **Docker 部署 / 单行直跑**收进「其它安装方式」折叠（分段控件切换，命令落在同一块输出区）；
   - **端口、脚本源、下载源、交互方式、监听范围、内网上游**收进「安装选项」折叠。
5. **节点详情就地展开**（删掉了 `#nodeDetailOverlay` 弹框）：点节点行展开的行内编辑器里含
   - **基本信息**：节点 ID / 角色 / 创建时间 / 最后心跳 / 配置版本 / 同步次数 / 最近 IP / 供应商范围 / 模型范围（`.setting-row`）；
   - **Token 查看复制 / 后台密码查看**：`[data-detail-eye]` 遮罩显示 + `[data-detail-copy]` 复制；凭据走只读的 `GET /api/admin/nodes/:id/credentials`（**查看绝不轮换 Token**），明文只留内存（`state.nodeSecrets`）；
   - **模型使用**（按节点）：`#node_model_usage_{id}` 渲染该节点上报的 `usage.model_stats`（调用 / 成功失败 / 输入输出 Token），没有精确统计时退回 `usage.models` 的调用数；
   - **底部 `.form-actions--split`**：左侧「吊销/恢复」（`.btn--danger`，走 `confirmDialog()`）+ 「⋯」菜单里的「删除节点」（`.menu-item--danger`），右侧「取消」+「轮换 Token」+「重新获取安装命令」+「保存节点」。
6. **轮换 / 重新获取后的一次性命令用 `.dialog` 展示**（组件 6 允许「只显示一次」的材料）：`#nodeInstallOverlay` 保留，标题改「一次性安装命令」，顶部保留「已轮换」提示条与「缓存失效」提示条。
7. **中枢概览下沉到节点页底部**：`<details class="headers-details" id="hubOverviewBox">`（「中枢概览」折叠），内含 6 项下发规模 KPI（`.metric-grid` / `.metric-box`）与全节点模型使用分布表（`#hubModelUsageBody`）。原「活跃 VM 节点」表不再单独成表 —— 节点列表本身承担。

### 7.13 测试与保存的版本契约（配置 CAS）

`POST /api/admin/test-key` 会把这次测试结论**落盘**到配置的 Key 上（Full 节点走
`PersistKeyTestState` → `saveConfigLocked`），**配置版本 +1**，但它的响应里没有
`_version`。因此「先测一下再保存」天然带着一个版本竞态：页面持有的
`state.config._version` 落后一版，紧随其后的保存带着旧版本提交，被 CAS 判为
409（`config_version_conflict`），**用户的改动被整条丢弃**（新建路由时整条路由
都不会落地）。

控制台侧的三条纪律（`shared/admin/js/app.js`）：

1. **测试期间禁用「保存」**：`#m_test_send` 发起请求时禁用 `#btn_save_model`，
   请求结束（无论成败）在 `finally` 里恢复。竞态根本不发生。
2. **测试结束后追平版本号**：`refreshConfigVersion()` 回读 `GET /api/config`
   的 `_version` 并写回 `state.config`（只同步版本号，**不覆盖整份配置** ——
   整份回读会把编辑器里未保存的草稿冲掉）。
3. **测试结论写回本地配置**：服务端把结论写到 Key 上，本地那份配置也要跟上
   （`applyKeyLastTest`），否则紧接着的保存（整份提交 `state.config`）会把服务端
   刚写下的结论用旧值覆盖掉。

**冲突文案必须诚实**：真冲突（别人改了配置）时，提示语要同时说清两件事 ——
**冲突原因**与**「本次修改没有保存」**。禁止只说「配置已被其他人修改」：
本页自己的测试请求同样会推高版本号，说成「其他人」会把操作者引向错误方向，
而只说「请刷新后重试」又不告诉操作者他的改动已经没了。

冲突重试（`persistConfig(successMsg, pendingEdit)`）只把**用户正在改的那一项**
（`applyPendingEdit`）贴到服务端最新配置上再保存，绝不拿本地过期快照整份硬覆盖 ——
那会把服务端刚写下的内容冲掉。版本落后超过两版（超出本页测试请求能造成的范围）
时不自动重试，直接如实报错。

### 7.14 组件帮助函数速查（`shared/admin/js/app.js`）

| 函数 | 用途 |
|---|---|
| `openDialog(target, { focus })` | 打开 `.dialog`（含遮罩显隐 + 焦点进入）。 |
| `closeDialog(target)` | 关闭 `.dialog`。 |
| `registerDialog(id, closer)` / `closeDialogById(id)` | 为有副作用的弹框注册 / 调用关闭动作。 |
| `confirmDialog({ title, message, confirmText, cancelText, danger })` | 统一确认弹框，返回 `Promise<boolean>`。 |
| `buildMenu(items, { align, label })` | 渲染「⋯」菜单；`items` 为 `{ label, title?, danger?, onClick }`。 |
| `fieldHint(text)` | 生成标签旁的 ⓘ 悬停说明。 |
| `refreshConfigVersion()` | 回读服务端当前 `_version` 并写回 `state.config`（只同步版本号，不覆盖整份配置）。 |
| `persistConfig(msg, pendingEdit?)` | 保存配置；`pendingEdit` 用于 409 冲突时把用户改的那一项贴回服务端最新配置再重试。 |
| `applyPendingEdit(freshCfg, edit)` | 把 `{scope, key, value, removeKey?}` 贴到服务端最新配置上（冲突重试用）。 |
