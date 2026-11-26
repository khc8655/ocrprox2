# 腾讯云 EdgeOne Makers 平台规范与运行时适配指南

> **文档目的**：沉淀腾讯云 EdgeOne Makers 官方文档的核心机制、运行时限制与本项目采纳的适配规范，避免后续开发或排障时重复查阅或踩坑。  
> **最后更新**：2026-11-14  
> **官方参考来源**：
> - Edge Functions：<https://makers.edgeone.link/document/edge-functions>
> - KV 存储：<https://makers.edgeone.link/document/kv-storage>
> - 日志分析：<https://makers.edgeone.link/document/log-analysis>
> - Agent 应用鉴权：<https://makers.edgeone.link/document/agents-authentication>

---

## 一、 Edge Functions 运行时红线与限制

Edge Functions 运行在 EdgeOne 全球 3200+ 边缘节点的 **V8 Isolate Serverless 环境**中，**不是完整的 Node.js 环境**。

### 1.1 运行时 API 支持边界

| 类别 | 支持情况 | 说明与本项目规范 |
|---|---|---|
| **Web Standard APIs** | ✅ 原生支持 | 支持 ES2023+、`Request`、`Response`、`Headers`、`Fetch`、`ReadableStream`、`TextEncoder`/`TextDecoder`、`Web Crypto API` (`crypto.getRandomValues` / `crypto.subtle`)、`Cache API` (`caches`)、`Cookies`。 |
| **Node.js 内置模块** | ❌ **不支持** | **严禁在 Edge Functions 及其依赖链中使用 `node:crypto`、`node:fs`、`node:path`、`node:url` 或全局 `Buffer`**。若代码中包含这些模块，边缘函数在平台部署编译阶段会失败，线上访问将静默返回 `404: NOT_FOUND`。 |
| **事件监听** | ❌ 不支持 `addEventListener` | 必须使用标准 Function Handlers 导出：`onRequest`、`onRequestGet`、`onRequestPost`、`onRequestPatch`、`onRequestPut`、`onRequestDelete`、`onRequestHead`、`onRequestOptions`。 |
| **路由 AST 扫描** | ⚠️ **必须显式导出** | 平台构建期静态扫描文件顶层的 `export [async] function onRequest*` 来注册路由；**严禁使用 `export * from '...'` 间接重导出**，否则平台会跳过该路由注册并在线上返回 `404`。 |
| **地理信息** | ✅ `context.request.eo` | 可读取客户端 GEO 信息与 EdgeOne 扩展字段。 |

### 1.2 硬性配额限制

| 指标 | 官方上限 | 对本项目的约束 |
|---|---|---|
| **单个函数代码包大小** | **5 MB** | 管理端单文件控制台 `admin.js` 必须控制在 `≤ 384 KiB`（`393,216 bytes`，远低于 5 MB；上限以 T1 测试为准）。 |
| **客户端请求 Body 大小** | **1 MB** | `/api/config` 与节点配置请求体控制在 1 MB 以内。 |
| **单次执行 CPU 时间片** | **200 ms**（不含 I/O 等待） | 投影计算、JSON 序列化、Hash 计算必须轻量，严禁高迭代 PBKDF2 等重 CPU 操作阻塞。 |
| **开发语言** | JavaScript (ES2023+) | 使用标准 ESM 导出。 |

> ⚠️ **真正的约束是「所有边缘函数的 JS 总字节」，而且官方没有公布。** 上面 5 MB 那条是**
> 单函数**口径，跟实际卡住我们的限制不是一回事：
>
> - 平台把 `/edge-functions` 下的**每个文件**都注册成一个边缘函数（控制台「部署详情 → 函数」
>   会列出全部路由，例如 27 条），部署时打包成一个脚本；
> - 超过它未公开的上限后，**部署与构建全部显示成功**，但访问任何路径都返回
>   `545 Error return from script`，响应头带 `XX-Script-Debug: query bu_script_<id>.js failed: file too big`；
> - 三次生产部署划定的区间：**125,811 字节可正常服务**，131,897 与 131,808 字节均全站 545。
>   gzip 总量不是判据（三版都在 26–28 KB）。
>
> 因此 `npm run build:admin` 的 Gate 5 按 **125,811 字节**（已知安全值）卡总字节数，余量为 0：
> **任何让边缘包变大的改动都会直接失败**。要加东西，必须先等量删掉；或者干脆不放进
> `/edge-functions` —— 例如预设自动绑定放在控制台、`preset-status` 的版本兜底放在 Full 节点，
> 都是这个约束下的产物。调整这个数字必须有一次真实部署证明新值可用，不允许凭推算放宽。

### 1.3 文件路由与静态资源优先级

1. **静态资源优先**：**如果 Edge Functions 路由与静态资源路由冲突，客户端请求将优先被路由到静态资源。**
   - 例如 `outputDirectory: "."` 时，若根目录存在 `index.html`，访问 `/` 会直接命中静态 `index.html`（可用于兜底跳转到 `/admin`）。
2. **目录映射规则**：基于项目根目录 `/edge-functions` 生成路由（**大小写敏感**）：
   - `/edge-functions/index.js` → `/`
   - `/edge-functions/admin.js` → `/admin`
   - `/edge-functions/api/config.js` → `/api/config`
   - `/edge-functions/api/admin/nodes/[id].js` → `/api/admin/nodes/:id`（一级动态路径，`context.params.id`）
   - `/edge-functions/api/admin/nodes/[[default]].js` → 多级动态路径（如 `/api/admin/nodes/:id` 与 `/api/admin/nodes/:id/rotate`）
3. **函数目录自包含原则**：
   - 部署到 EdgeOne Makers 时，`/edge-functions/` 目录下的函数应保持自包含（不依赖外部目录中的 `node:*` 模块，构建产物由 `npm run build:admin` 自动同步至 `edge-functions/_lib/` 或内联打包）。

---

## 二、 KV 存储架构与一致性格局

### 2.1 核心特性与约束

- **适用范围**：**当前仅支持在 Edge Functions 中使用**（Cloud Functions 无法直接使用边缘 KV 全局变量）。
- **容量限制**：单账户 1 GB，最多 10 个命名空间；单 Key ≤ 512 B（仅支持数字、字母及下划线），单 Value ≤ 25 MB；`list()` 单次分页 `limit` 上限为 `256`。
- **最终一致性模型（关键！）**：
  - **写入（`put`）**：并行写入当前最近边缘节点与中心存储，写入完成后**同一边缘节点立即可读到最新值**。
  - **更新 / 删除（`put` / `delete`）**：当前节点立即生效；**其他边缘节点的旧缓存最长 60 秒内自然过期**（若跨节点需要强一致，官方建议使用 Blob 存储）。
  - **对本项目的影响**：
    - `POST /api/config` 的 CAS 乐观锁与 `POST /api/node/config` 的 ETag 304 机制能天然容忍 60s 最终一致性；
    - 节点吊销（`enabled: false`）在同节点立即返回 401，跨全球其他边缘节点最长在 60s 内全部同步生效。

### 2.2 绑定注入与 API 用法

- 在 Makers 控制台绑定命名空间时定义的「变量名」（本项目约定为 **`agent_kv`**），在运行时会作为**V8 全局变量**直接注入（如 `await agent_kv.get(...)`），而非只挂在 `context.env` 上。
- 本项目 [`edgeone-hub/lib/config.js`](file:///Users/xk/Documents/llmproxy2/edgeone-hub/lib/config.js) 的 `resolveKvBinding()` 按以下优先级探测：
  1. 显式传入的 `explicitKv`；
  2. `context` / `context.env` / `context.bindings` / `globalThis` 上的候选名（`agent_kv`, `KV`, `EDGE_KV`, `ocrproxy_kv`, `my_kv` 等）；
  3. V8 顶层全局作用域变量（`typeof agent_kv !== 'undefined'`）；
  4. Duck-typing 扫描（同时具备 `get` 和 `put` 方法的对象）。

---

## 三、 可观测性与日志分析限制

- 根据官方《日志分析》文档，控制台「日志分析」目前支持 **SSR**、**Cloud Functions**（`cloud-functions/`）和 **Agents**（`agents/`），**Edge Functions 来源（`edge-functions/` 文件夹）的日志目前仍在平台规划中**。
- **排障策略**：
  - 由于线上 Edge Functions 报错时控制台暂无函数日志回显，必须依赖：
    1. 本地全真测试（`npm run test:hub` + 纯 Web Standard 兼容静态扫描门禁）；
    2. `/health` 与 `/healthz` 接口直接返回 `kv_bound`、`role`、`timestamp` 等诊断状态；
    3. 严禁在 Edge Functions 中引入任何未捕获异常或 Node.js 专有 API。

---

## 四、 鉴权架构参考（Web Crypto 边缘中间件模式）

- 本项目 Hub 角色采用 `ADMIN_PASSWORD`（管理端 `Authorization: Bearer` 常量时间比对）+ `NODE_TOKEN`（`stk_node_<48hex>`，KV 仅存 `SHA-256` 哈希）。
- 按照官方《Agent 应用鉴权》文档，边缘 V8 环境下的加密/哈希/签名校验一律使用 **Web Crypto API**（`crypto.getRandomValues` / `crypto.subtle`）或零外部依赖的纯 JS 实现，不引入 `node:crypto` 或 `bcrypt` 等原生 C++/Node 模块。
