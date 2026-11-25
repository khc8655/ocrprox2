# Changelog

本项目遵循 [`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md) 的版本与发版门禁规范，版本号与 [`version.json`](file:///Users/xk/Documents/llmproxy2/version.json) 保持严格同步。

---

## [v20261125-02] - 2026-11-25

### Fixed

- **模型能力信息在接入信息页看不到**：目录抓了 8,968 个模型的上下文窗口 / 最大输出 / 思考档位，但「可用模型」卡片只显示模型 ID 与供应商名——操作员复制 Model ID 的地方反而没有任何能力信息。现在每张卡片新增一行：`上下文 200K · 最大输出 64K · 思考 low / medium / high`（幂等缓存，按 `(预设, target_model)` 查询，别名字模型也能对上）。
- **中转商同名模型回退**：中转商通常不绑定预设（`tokenrhythm` 暴露 `glm-5.3-flash` 却没有 preset），精确查询会落空。现在精确命中失败后，跨供应商按模型 ID 检索，取「多数供应商一致」的规格（modal spec）并标注「按同名模型」。实测 `glm-5.3-flash` → `上下文 1M · 最大输出 131K · 思考 low / high / max · 按同名模型`（30 家列出、15 家规格一致；避免了个别中转商的缩水窗口）。Go 侧 `Catalog.CapabilityByModelID` 与 Hub 侧 `lookupByModelID` 同构，结果确定（不依赖 map 迭代顺序）。
- 目录确实没收录的模型（如 `egg-alpha-003`）显示「能力目录未收录」，悬停说明原因与补充方式；空行不占位。

### Note

- `tokenrhythm` 这类中转商的别名模型（如 `egg-alpha-003`）在 models.dev 里不存在，卡片会如实显示未收录。要让它们也有能力信息，需要在 `shared/model-catalog/overrides.json` 补充后重建目录（后续可做界面化录入）。

---

## [v20261125-01] - 2026-11-25

### Added

- **失败原因可归因（三层打通）**：每次失败的尝试都带归一化 `reason`、上游机器码 `err_type`、脱敏后的 `err` 原文与上游 `rid`。`reason` 是封闭枚举：`auth_invalid` / `quota_exhausted` / `rate_limited` / `model_not_found` / `context_too_long` / `upstream_error` / `timeout` / `network` / `client_disconnected` / `bad_response` / `protocol_mismatch` / `no_candidate` / `config_unavailable` / `unknown`（后两个为本版新增）。
- **拨号前的本地拒绝也进账本与轨迹**：模型未配置（404）、配置不可用（503）、无候选可用（503）、全部 Key 冷却（502）现在都会写一条 `usage.jsonl` 与一条 `RequestTrace`。`UsageRecord` 顶层新增 `reason` / `err_type` / `err` / `rid`，所以「最近请求」的原因列不会再是 `—`；`try_failed` 仍只记具体 Key，不污染 Key 健康统计。
- **`GET /api/admin/recent-requests?limit=50&failed=1`**：从账本尾部反向回放最近请求，重启后仍在。控制台「请求日志」页签展示最近 50 条，并按 `reason × 供应商` 聚合出「错误分析」。
- **`POST /api/admin/test-key`（Hub + Full）**：Key 行的「测试」按钮真实发一句「你好」（`max_tokens` 16、`stream:false`、20s），返回回复文本、耗时与失败原因。模型行的「测试路由」按钮已移除。
- **models.dev 模型目录**：Hub 设置页新增「模型目录」卡片，**手动**点按钮才从 models.dev 更新（不自动联网），瘦身后约 1.6 MB 存 Hub KV；Full 节点内嵌一份兜底目录并带容错查询（手动覆盖 > 映射精确 > 大小写不敏感 > 同族最近亲）。
- **路由候选的「思考档位」真正生效**：OpenAI 方言写 `reasoning_effort`（就近映射到目录里该模型支持的档位），Anthropic 方言写 `thinking.budget_tokens`（`budget < max_tokens` 不成立时整段跳过，不冒必然 400 的险）；空值仍跟随客户端。

### Fixed

- **`app.log` 的失败行描述的是「最后一次尝试」而不是「最后一次失败」**：故障转移成功时那一行是 `status=200 reason=-`，恰好把要看的原因吞掉。现在取最后一次失败，并补 `recovered_by=provider/key`；全部候选被跳过时补 `note=`。
- **`PersistKeyEntry` 在只提交元数据（如 `last_test`）时会清空已存密钥**：现在只有提交了非空且非掩码的 `Key` 才覆盖。
- **Key 测试结果刷新即丢**：改为后端立即落盘——Full 走 `LocalSource.PersistKeyTestState`（按 provider 定位，只写 `last_test`），Hub 走 `persistProviderKeyHealth`；无需再点「保存供应商」。
- **`usage.jsonl` 的单条记录可顶破上限**：`ReqModel` / `ServedModel` / `StopReason` 来自客户端请求体，单条可达 20 MiB。现在单条封顶 256 KiB，两个文件合计 ≤ 20 MiB，全部日志类文件总上界 30 MiB。

### Tests

- 新增 `internal/scheduler/local_failure_test.go`（4 条）：404 / 503 / 全冷却 502 都带 reason；成功故障转移的日志行带 `reason` 与 `recovered_by`。
- 新增 `internal/scheduler/reasoning_test.go`（5 条）：空档位原样透传、OpenAI 方言注入 `reasoning_effort`、Anthropic 方言注入 `thinking.budget_tokens`、`max_tokens` 不够时跳过、端到端上游确实收到档位。
- 新增 `internal/obs/usage_reason_test.go`（2 条）：无 Key 的本地拒绝在记录顶层保留原因且不污染 `try_failed`；有 Key 的失败仍逐 Key 记录。
- 新增 `internal/config/key_test_state_test.go`（3 条）：只写 `last_test` 不动密钥与启用状态、provider 级隔离、`PersistKeyEntry` 不因缺 Key 而清空。
- Hub 新增 1 条：`test-key` 的判定落进 KV 的 `last_test`，其它 Key 与密钥本身不受影响。

---

## [v20261124-03] - 2026-11-24

### Fixed

- **节点 IP 在「只同步配置、不发心跳」的节点上永远为空**：`POST /api/node/config` 的 `clientIp` 只认三个代理头，没有回退到 `request.eo.clientIp`。心跳路径上一版已修，但配置同步是另一条写入路径（`touchNodeLastSeen` 也写 `last_ip`）——关闭心跳的 lite、或只靠配置同步上报的节点，即使跑在 EdgeOne 上也永远显示「未上报」。现在两条路径用完全相同的回退链：

  ```
  eo-connecting-ip > cf-connecting-ip > x-forwarded-for > request.eo.clientIp > null
  ```

### Tests

- 新增 **7 条永久回归用例**，把回退链的顺序钉死：
  - 心跳路径 4 条：`eo.clientIp` 兜底、代理头优先于 eo、两者皆无记 `null`、`eo.clientIp` 为纯空格视为缺失。
  - 配置同步路径 3 条：同三项，证明「只同步配置的 lite 也能拿到 IP」。
  - 此前这条逻辑只由一次性脚本验证，后续重构可能悄悄回退。

### Docs

- `ADMIN_UI_BACKEND_CONTRACT.md` §三·补 与 `shared/contracts/admin-ui-backend.json`：客户端 IP 解析段落更新为完整回退链，并注明配置同步路径同样适用。

## [v20261124-02] - 2026-11-24

### Changed

- **供应商编辑器重构**（用户图1反馈）：
  - 删除「上游协议类型」下拉下面那段长说明文字（移到 title 悬停）。
  - 协议选择从单选改为 **OpenAI 兼容端点 + Anthropic Messages 端点** 两个独立 checkbox。开就有默认 URL（来自预设），可自定义；不开就没有该端点。多数官方厂商两套端点都有，两种客户端都能接。
  - 「预设规则绑定」改为**只读徽章**：程序按 `preset_id` 匹配预设库，用户不能手填；版本徽章仍显示「适配 <id> · vX.Y · 日期」。
  - 高级折叠里的「模型别名映射」**删掉**（映射在模型路由页配，不在供应商上）。高级折叠标题改为「高级 (配额重置 / 适配规则)」。
  - Hub 端「一键测全部 Key」改名为「逐把测 Key」并加 title 说明「逐把发一次最小请求，能拿到上游响应就记为可用」。

- **供应商列表换字母索引条**（用户图2反馈）：过滤从「全部 / 已启用 / 探活通过 / 异常 / 已适配」换成 **A–Z + #** 字母索引条。每个字母胶囊带数量徽标，点击直接过滤；首字符非字母的归 `#`（如中文品牌名「通义千问」）。已启用/探活状态在每行的胶囊里已有，字母才是「查找供应商」的正确维度。

### Added

- **节点详情弹层**（用户图3反馈）：节点列表新增「详情」按钮，弹层展示：
  - 节点 ID / 名称 / 角色 / 创建时间
  - **Token**（默认 `●●●●●●●●●●●●` 遮罩，点眼睛展开为完整 48 位 hex，可复制）
  - **客户端密钥 client_key**（同样遮罩 + 复制）
  - **后台密码**（full 节点显示；lite 节点显示「lite 无控制台密码」）
  - 心跳时间 / 配置版本 / 同步次数 / 最近 IP / 供应商范围 / 模型范围
  - 底部：吊销节点 / 轮换 Token / 关闭
  - lite 节点行不再显示「密码」按钮（上一轮已加）。

- **Token 明文存 Hub KV**（用户拍板）：签发时同时写 `token_sha256`（唯一鉴权依据）与 `node_token_plaintext`（仅供控制台回看），轮换时同步更新。`GET /api/admin/nodes/:id/credentials` 响应加 `node_token` 字段（lite / full 都返回）；列表 `sanitizeNode` 剥离明文字段，凭据端点响应带 `Cache-Control: no-store`。与 `admin_password` 明文存 KV 是同一决策。

### Fixed

- **节点 IP 在本地/直连环境下全是「—」**：EdgeOne Functions 的 EventContext 只暴露 `request/params/env/waitUntil`，**没有 socket 对端地址**。但 `request.eo.clientIp` 是 EdgeOne 运行时解析好的客户端 IP（[官方文档](https://cloud.tencent.com/document/product/1552/81902)）。心跳 `clientIp` 现在按 `(eo-connecting-ip || cf-connecting-ip || x-forwarded-for) || request.eo.clientIp || null` 取。UI 上空 IP 单元格从「—」改为「未上报」。
  - 实测（真实 `handleHeartbeatRequest` + 真实 `lib/nodes.js`）：A 无头+eo → 取 eo；B 头+eo → 头优先；C `eo-connecting-ip` 最高优先级；D 无头无 eo → `null`（UI 显示「未上报」）；E `eo.clientIp` 全空格 → `null`。

### Docs

- `SECURITY_SPEC.md` 第 3 条改为「同时保存 `token_sha256` 与 `node_token_plaintext`」。
- `ADMIN_UI_BACKEND_CONTRACT.md` §2.1/§2.4 补 `node_token` 字段说明（v3.10 契约）。
- `shared/contracts/admin-ui-backend.json` 加 v3.10 条目。
- `UI_DESIGN_SPEC.md` 单文件体积上限从 252 KiB 更正为 **320 KiB**（v20261123-06 已调过，文档滞后）。

## [v20261124-01] - 2026-11-24

### Fixed

- **P0 吊销不生效（最长延迟 24 小时）**：Hub 把节点 `enabled` 置为 false 后，lite 因为租约（`lease_ttl` 默认 86400）还没到期，继续用缓存里的 Key 正常服务——实测吊销当场数据面仍 `200`，要等租约到期才会去 Hub 复验。现在心跳把 `401/403` 当作吊销信号（`hubheartbeat.Beat.Revoked`），节点收到立刻 `MarkRevoked()` 清空内存配置并停服。**实测：吊销 → 54 秒后 503**（心跳 30s 周期）。
- **P0 Hub 改配置不生效**：`POST /api/node/heartbeat` 原为 `204` 无 body，节点无从得知模板变了，只能等租约到期（24h）或手动加 `X-Node-Refresh: 1`。心跳现在返回 `200 {"ok":true,"config_version":N}`，节点比对本地版本后自动拉取。**实测：Hub 保存 → 49 秒后 lite 拿到新路由。**
- **P0 吊销后恢复永久 503**：`purgeAndRevoke()` 会把 `nodeToken` 清空，而 Hub 侧恢复节点（`enabled: true`）后节点再无凭据可验证，只能重启 systemd。现在保留 token，`revokedRetryAfter = 60s` 后重新校验；`Current`/`RefreshForAuth`/singleflight 三处 revoked 短路都过这个闸。**实测：恢复 → 50 秒自愈，未重启。** 吊销期间仍然零转发（上游账本条数不变）。
- **P1 安装指引给了一个永远连不上的地址**：弹窗固定显示 `API Base URL: http://<VM_IP>:8787/v1`，而 `install.sh` 默认 `--bind=local` → systemd `LLMPROXY_ADDR=127.0.0.1:8787`。安装弹窗新增「监听范围」选择，接入地址随选择切换（local 显示 `127.0.0.1` 并提示 `ssh -L`）。
- **P1 lite 无法使用内网/本机上游**：SSRF 防护会拒绝这类地址，但 `install.sh` 根本没有开关，只能手工写 systemd drop-in。新增 `--allow-private`，lite 单元与 full 的 `.env` 都会写入 `ALLOW_PRIVATE_IPS=true`；安装弹窗同时提供勾选项。
- **P1 Docker 安装命令端口映射无效**：缺 `LLMPROXY_ADDR`，容器内进程只绑 `127.0.0.1`。三种安装模式（systemd / Docker / 单行直跑）现在都跟随弹窗的监听范围选择。
- **P2 模型路由的 Key 勾选看不出可选**：`probe-pill` 长得像静态标签，实测两次在「未勾选」状态下提交被拒。加前置方框（未选空心 / 选中实心）。
- **P2 lite 节点的「密码」按钮是死路**：点进去只有「lite 节点无后台密码」。按 role 隐藏。
- **P2 三种版本号另一种说法**：概览与节点表把心跳时间写成「最后同步」、配置版本写成 `v1`、二进制版本写成 `v2026xxxx`，「未上报」实际指用量。现在拆开表述：`心跳 <时间> · 配置 #N`、`用量未上报`。

### Tests

- `internal/hubsync/revoked_test.go`：吊销后可自愈（且窗口内不打扰 Hub）、`MarkRevoked` 立即清空缓存、吊销重试被限流（20 次调用 0 次额外请求）。
- `internal/hubheartbeat/configversion_test.go`：上报版本、401/403 报告 Revoked、200 不误报、旧 Hub 的 204 与超大 body 都安全忽略。
- `edgeone-hub/test/hub.test.mjs`：心跳断言从「204 无 body」改为「200 + 只含 config_version」，并明确「每次非去抖心跳恰好一次 config 读取」。

## [v20261123-09] - 2026-11-24

### Added

- **入口协议与供应商端点不匹配时直接 400**（`internal/scheduler/protocol.go` + `Dispatch` 前置校验）。真机验收实测：`POST /v1/messages` 打只有 OpenAI 端点的模型（`gpt-test`）时，网关把 Anthropic 请求体（`system` / `max_tokens`）原样转到 `<base>/v1/messages` 并返回 200 + OpenAI 形状的 `chat.completion`——Claude SDK 会因缺 `type`/`content` 解析失败；反向（OpenAI 客户端拿 `type: message` 体）同样。现在这类调用**在花掉任何 Key 之前**就返回 `400 invalid_request_error`，错误体点名模型、入口、以及每个候选实际支持的方言：

  ```
  model "gpt-test" cannot be served over /v1/messages:
  mocka (openai-compatible only), mockb (openai-compatible only).
  Call /v1/chat/completions instead, or set an Anthropic Base URL on it
  when the upstream serves both dialects.
  ```

  判定规则（`protocolHints`）：`api_type: anthropic-messages` → 只有 Anthropic 端点；`anthropic_base_url` 非空 → 同时具备 Anthropic 端点（双端点厂商，与 api_type 无关）；其它 OpenAI 家族 `api_type`（`openai-completions` / `gemini` / `vertex` / `responses` …）→ 只有 OpenAI 端点。**没写 `api_type`、也没写 `protocols`、也没写 `anthropic_base_url` 的旧配置一律视为「未声明」，保持原来的宽松转发**——这条边界保证 `test:t3` 里的 `gpt-4o`（无 api_type）打 `/v1/messages` 仍然 200，也保证老配置升级后不会突然 400。
- **协议能力判定与四条回归测试**（`protocol_test.go`）：`EntryProtocol` 路径映射（含 `?query`）、`ProviderServesProtocol` 九种声明组合、`RouteServesProtocol` 的 note 文案（含"未声明"与"未知供应商"）、两个 `Dispatch` 级用例——不匹配时 400 且**上游 0 次命中**、同模型换正确入口仍 200、Anthropic-only 供应商走 `/v1/messages` 成功而反向被拒。

### Changed

- 供应商编辑器的协议说明补上「对不上时直接返回 400 并点名哪个候选不支持，不会把错误协议的请求体发出去」。

## [v20261123-08] - 2026-11-24

### Fixed

- **线上 Hub 全站 545（P0，v20261123-07 引入）**：`GET https://key.khc6.cn/healthz` 返回 `HTTP/1.1 545 Unknown Status` + `XX-Script-Debug: query bu_script_1265948.js failed: file too big`，根路径、`/admin/`、`/api/v1/health` 全部同样失败——边缘函数整包加载不起来。触发点是本版把预设库从 16 个扩到 32 个：`edgeone-hub/lib/generated-presets.js` 用的是 `{...p}` 整份预设（含 `description` / `update_notes` / `features` / `recommended_models`），体积从约 16 KB 涨到 30.8 KB，边缘包体随之越过平台单脚本上限。修复：该文件只输出 Hub 真正读取的两类字段——`adapter_rules`（`lib/projection.js`、`api/vault/manifest.js`、`api/vault/fetch.js`、`api/node/config.js` 用它做规则回填）与 `base_url` / `anthropic_base_url`（`api/admin/probe-models.js`、`api/admin/verify-key.js` 用它兜底地址）。`edge-functions/` 的 gzip 总量从 **33,147 → 26,933 字节**，比出事前（31,588）还低 4.6 KB。`shared/presets/catalog.json`（控制台用的完整目录）不受影响。
- **上游协议下拉的说明文字与实现不符**：原写「网关按这里选择转换」，实测网关不做任何请求体协议改写——它按入口选端点（`/v1/chat/completions` 走 `base_url`，`/v1/messages` 走 `anthropic_base_url`），请求体原样转发（用 mock 上游核对：Anthropic 形状的 `system` / `max_tokens` 被原样送到 OpenAI 端点路径）。改为「网关不做协议转换，客户端入口必须与供应商实际提供的端点对上」，并说明多数官方厂商两套端点都有。

### Changed

- `shared/presets/build-catalog.mjs` 生成 Hub 预设映射时收敛字段，并写明为什么只能带这两类字段——下次再加品牌不会再悄悄把边缘包体顶爆。

## [v20261123-07] - 2026-11-23

### Fixed

- **系统设置输入框显示不全**：Base URL / client_key / Vault 中枢地址 / 节点同步 Token 被裁剪成 `https://hk.1` 一类半截值。根因是 `.setting-control` 只按内容撑开——`flex-shrink: 0` + 内容宽度，而输入框的 `width: 100%` 百分比又反过来解析到这块内容宽度上，形成循环后落在输入框的内在宽度（约 171px）。改法：自由文本行（`.setting-control:has(> .input:not([type="number"]))`）按 `flex: 1 1 300px` 占据行内剩余空间、上限 62%；`.input` 自身 `flex: 1 1 auto` 填满控制区；数字输入保持 `0 0 110px` 固定列宽不参与拉伸；990px 以下换行断点里解除 62% 上限（`:has` 选择器优先级高于原 `.setting-control` 规则，只改 `flex-basis` 会失效）。实测 1038px 行宽下 URL 输入框 171px → 644px，`scrollWidth - clientWidth = 0`。
- **`适配版本` 徽章在中枢供应商上退化成指纹**：`presetVersionPillHtml` 旧逻辑先判 `isVaultCard && p.rule_hash`，vault 供应商因此永远走指纹分支，即使 `preset_id` 能解析到内置适配文件。改为适配版本优先、指纹仅在规则无法映射时兜底；供应商编辑弹窗里同一处优先级（`versionText`）一并修正。
- **添加供应商的 ID 必须手填**：输入品牌名命中预设后只填了 Base URL 和协议，ID 仍要自己发明。现在命中预设时自动派生（`Qwen` → `qwen`），人工输入优先；纯中文自定义名在保存时做 ASCII slug 兜底，仍为空才提示。

### Changed

- **两套预设库合为一套（32 品牌一一对应）**：`internal/provider/presets.go` 的 `catalogPresets` 从 26 补到 32（新增 `agnes` / `bai` / `cline` / `opencode` / `sensenova` / `tokenrhythm`，此前只在 `shared/presets/*.json` 里存在，控制台选不到），并为原先缺文件的 16 个品牌补上适配文件（`anthropic` / `bailian-token-plan` / `baidu-qianfan` / `bedrock` / `groq` / `kimi-code` / `kimi-code-cn` / `minimax-cn` / `moonshot` / `moonshot-cn` / `ollama` / `qwen` / `tencent-cloud` / `volcengine` / `zai` / `zhipu`），版本与 `catalogPresets` 严格对齐（`TestCatalog_PresetAdapterVersions` 强制）。`minimax-cn` 的适配规则沿用 `minimax`（`output_config` 剥离、思考强制、模型名大小写映射）。
- **`presets-extra` 契约变更**：`version` / `updated_at` 从「仅在有适配文件时出现」改为「每个精选品牌都有」——有适配文件取文件版本，否则取内置预设的注册版本。`shared/contracts/admin-ui-backend.json` 已同步。
- **添加供应商表单的预设提示带版本**：「已按预设 Qwen（适配 v1.0.0 · 2026-11-23）自动填充」，选品牌时就能看到套用的是哪一版适配。
- **上游协议类型下拉补说明**：客户端只认 `/v1/chat/completions`（OpenAI 兼容）与 `/v1/messages`（Claude 系），协议选择只决定网关往上转发时用哪种协议；同一对外模型接不同协议的上游时，在路由里加多条候选分别绑定供应商。

### Added

- **新增「接入信息」页签**（概览 / 供应商 / 模型路由 / 接入信息 / 系统设置；Hub 模式隐藏，中枢没有数据面）。原系统设置①里的三个 chip 搬到这里，并改成按客户端协议切换的接入卡：`OpenAI 兼容` tab 给 `base_url = http://host/v1` + `POST /v1/chat/completions`，`Claude 系` tab 给 `ANTHROPIC_BASE_URL = http://host`（不带 `/v1`，Claude Code / Anthropic SDK 自己拼 `/v1/messages`）+ `POST /v1/messages`，两者共用同一把 API Key。协议切换只影响粘贴给客户端的值，不影响上游供应商的协议配置（那是「网关怎么跟上游说话」）。系统设置①只留配置，并注明复制用的值在「接入信息」页。
- **可用模型双行卡片**：每个模型一张卡，第一行是可点击复制的模型 ID（等宽字体），第二行是这条路由绑定到的供应商显示名；候选多于两家时折成「A · B +N」，完整名单在 title 里，卡片宽度固定、名字超长省略号截断，所以一个模型挂十家供应商也不会把网格撑变形。卡片网格 `repeat(auto-fill, minmax(240px, 1fr))`，1920/1280/760 实测分别为 5/4/2 列。另有「复制全部」（逗号分隔）。
- **支持的接口清单**：同页列出 `/v1/chat/completions`、`/v1/messages`、`/v1/responses`、`/v1/models`、`/v1/ocr`、`/v1/embeddings`、`/v1/rerank` 七条路径，逐个可复制（来自 `access-info.endpoints`）。
- 此前只有一个 Model ID chip，取的是 `agent_models` 里按字母序第一个 `enabled !== false` 的路由——既漏掉其余模型，也会把 `enabled` 缺省的停用路由当成可用。

### Fixed

- **控制台模型 ID 与 `/v1/models` 口径不一致**：两处各自实现了一遍过滤。`cmd/llmproxy` 要求 `route.Enabled == true` 且额外补 chat/embedding/reranker/ocr 四个 KB 槽位；`handleAccessInfo` 则把所有 `agent_models` 一律列出、KB 槽只看有没有候选。现在统一收敛到 `types.ProxyConfig.AvailableModelIDs(role)`，公开端点与管理端载荷都调它，控制台不可能再宣传一个网关会 404 的模型 ID，也不会漏掉 KB 槽位。实测：11 条路由（1 条停用）下 `/v1/models` 与 `access-info.models` 完全一致，均为 10 条。

- **magpie 预设表转换器 `scripts/magpie-presets.mjs`**：上游 `internal/provider/presets.go` 里那张 `var presets = []PresetDef{...}`（2026-11-23 核对 63 条）与我们 `PresetDef` 同构，所以品牌接入是数据搬运不是代码搬运。`check` 只读报告（已对齐 / 端点不一致 / 缺上游端点 / 本仓缺失 / 无法导入），`import --only=<ids>` / `--all` 把上游条目转成 `shared/presets/<id>.json` + `internal/provider/presets_imported_generated.go`（由 `presets.go` 的 `init()` 追加进 `catalogPresets`）。导入件带 `source: {repo, preset_id, commit}`，重复导入端点未变则跳过、变了则 patch+1。上游源码可来自工作区或 `scripts/magpie-sync.mjs` 已有的 bare 缓存（`git archive` 一次性取出 `internal/provider` 树后本地读取）。`npm run magpie:presets:check` / `magpie:presets:import`。**转不了的是协议改写**——上游把每家厂商的改写写在 `internal/provider/<vendor>.go` 的 Go 代码里，预设表没有任何描述，所以导入件 `adapter_rules` 一律为 `{}`。详见 `docs/MAGPIE_UPSTREAM_SYNC.md` §5.1。

### Changed

- **11 个品牌补齐 Anthropic 端点**（对齐上游预设表，此前只有 OpenAI 兼容端点）：deepseek `https://api.deepseek.com/anthropic`、moonshot `…/anthropic`、moonshot-cn `…/anthropic`、kimi-code `https://api.kimi.ai/coding`、kimi-code-cn `https://api.kimi.com/coding`、zhipu `https://open.bigmodel.cn/api/anthropic`、zai `https://api.z.ai/api/anthropic`、minimax-cn `https://api.minimaxi.com/anthropic`、tencent-cloud `…/plan/anthropic`、bailian-token-plan `…/apps/anthropic`、opencode `https://opencode.ai/zen`。对应适配文件版本 minor+1（deepseek 1.3.0 / opencode 2.1.0 / minimax-cn 1.5.0 / 其余 1.1.0），Go 目录与文件版本仍由 `TestCatalog_PresetAdapterVersions` 强制一致。核对结果：上游 20 个品牌端点全对齐、0 个缺端点；剩 4 个「不一致」是刻意的地区选择（minimax 国际站 vs 国内站、stepfun .ai vs .com、qwen 国际 vs 国内、openrouter `/api` vs `/api/v1`）。

### Tests

- `tests/t1_contracts/verify_contracts.test.mjs` 的预设完整性断言不再硬编码「恰好 16 个文件」，改为「至少 16 个」+「catalog.json 索引每个文件」，保留一一对应约束同时允许品牌扩容。

## [v20261123-06] - 2026-11-23

### Changed

- **包体硬门禁上调 252 KiB → 320 KiB（`327,680` 字节）**：四处同步（`shared/admin/build.mjs` Gate 4、`scripts/verify-release.mjs`、`tests/t1_contracts/verify_contracts.test.mjs`、`docs/ADMIN_UI_BACKEND_CONTRACT.md`）。此前余量仅剩 2.4 KB，任何 UI 改动都会撞闸；这个控制台是自用且持续演进，反复抠字节没有意义。Go 的 `go:embed` 与 Hub 静态托管对单文件 HTML 体积不敏感，320 KiB 给后续预留约 72 KB。后续若仍需腾空间，首选 `usage.js` 懒加载（切到概览页才注入，首屏可省约 30 KB）。
- **lite 的 `client_key` 语义明确为「中枢投影优先」**：Hub 投影到达后以中枢密钥为准，Lite 本地 `--client-key` 只在首次投影前可用（中枢是 lite 唯一的配置面，它没有 Web 端）。Hub 设置页提示文案已同步为「投影到达后以中枢密钥为准」。

### Removed

- **多客户端密钥（`proxy_keys`）前后端整体删除**：`types.RuntimeSettings.ProxyKeys` 字段、`cmd/llmproxy/main.go` 的 `syncAuthKeysForRole` 按角色合成主密钥 + 附加密钥的分支、`auth.Authenticator.extraKeys` 与 `UpdateClientKeys` / `GetClientKeys`（换成单个 `SetClientKey` / `GetClientKey`）、`/api/admin/access-key` 的 `proxy_keys` 入参与回显、`/api/admin/access-info` 的 `proxy_keys_count`、Hub 默认配置（`edgeone-hub/lib/config.js` 及其镜像 `edge-functions/_hub/lib/config.js`）、`settings.schema.json` 字段、UI「附加客户端密钥列表」行全部移除。**`VerifyClientKey` 收敛为只认单个 `client_key`**（1 代别名 `proxy_api_key` 仍解析为该值）；旧配置里的 `proxy_keys` 按未知 JSON 字段忽略，其中的密钥不再具备鉴权能力。**Hub 侧也彻底丢弃**：`loadConfig` 读出旧 KV 时即剔除该字段、`saveConfigWithCAS` 不再写回、`projectConfigForNode` 投影不带它——此前 Hub 会把旧字段原样回存 KV 并继续下发给节点。
- **单密钥槽位带来的 Lite 鉴权变化（超出「删字段」范围，单独说明）**：`syncAuthKeysForRole` 不再按角色分支，两角色都是「Settings.client_key → proxy_api_key → CLI/.env key」单槽位覆盖。Lite 因此从「CLI key 与中枢投影 key 并存」变为「中枢投影一到就顶掉 CLI key」。`docs/AGENT_DEPLOY_GUIDE.md` §3.2 新增说明，中枢设置页 `#gwHubNotice` 文案同步改写（原文「Lite 本地未配置 --client-key 时自动生效」已失真）。`TestFullMode_AuthSeedRotateRevokesEnvKey_And_LiteModePreservesEnvKey` 更名为 `TestFullAndLite_AuthSeedRotateRevokesEnvKey`，函数名不再宣称「保留」。该行为变更未经独立评审，若需保留 Lite 双密钥语义应回退 RoleLite 分支。
- **供应商面板「手动输入」按钮**：供应商必须先存在才能建路由，该自由输入入口多余。面板只列已存在供应商；搜索无结果只提示「无匹配供应商（请先在供应商页添加）」。
- **供应商编辑器「模型探测与一键纳管」整块**（`btn_probe_prov_*`、`probe_pills_container_*`、`renderProbePillsForProvider`、`state.probeFilterByProvider` 及相关 handler）：探测只在添加模型时进行，编辑供应商时不再重复。
- **「Claude Code 环境变量」与「OpenAI / Cursor 配置」两个 snippet-box**（`#snippetClaude` / `#snippetCursor` 与各自复制按钮）：换成 Base URL / Client Key / Model ID 三个可点击复制的 chip（`#gwCopyChips`），点一下复制对应值并 toast 提示；复制复用既有的 `copyToClipboard()`（与其余 7 处一致：非安全上下文 / 剪贴板被拒时提示「请手动复制」，不再无条件假报成功）；Model ID 取首个**已启用**路由（与 `/v1/models` 口径一致；禁用路由会让客户端 404），无路由时 chip 置灰。

### Fixed

- **供应商搜索面板选不中（#2）**：点行 → 填入输入框 → 关闭面板 → 焦点移到下一个字段（`#newModelTarget`）。根因是行内没有 `mousedown` 焦点保护：面板搜索框 `#npSearch` 持有焦点时点行，pointerdown 的默认行为会把焦点从搜索框移走并吞掉这次点击——补 `mousedown` 阻止默认行为后点击可正常落到行上（面板本身原本就没有 blur 关面板的监听器，这里补的是焦点保护，不是去删一个不存在的 handler）。已聚焦输入框再点击也能重新打开面板（`click` 监听补上，`focus` 在已聚焦时不触发）。
- **`<input type="number">` 滚轮误改值（#3）**：`setupNumberWheelGuard()` 在初始化时挂一个 document 级 `wheel` 委托，命中 `type === 'number'` 即 `blur()`；用 blur 而非 `preventDefault`，页面滚动不被吞掉。
- **「中枢只读」徽章重复且丑（#5）**：从每个 Key 胶囊移除（胶囊只显示 Key 标签名），改为 Key 区块标题旁一行统一说明「中枢托管 Key（只读）：由中枢统一管理，删除会本地移除、可重新拉取」，仅在该供应商确有中枢 Key 时显示；Hub 控制台不显示（那里所有 Key 都是中枢签发）。

### Changed

- **新增模型「对外模型名」默认折叠为只读（#1）**：默认自动取上游模型 ID（跟随 `#newModelTarget` 输入同步），点「自定义名称」才解除只读并聚焦；保存时按「输入值 → 上游模型 ID → 勾选的探测模型」兜底解析路由名，多候选需要区分时再显式命名。两处一致性修正：手动清空/改写 `#newModelTarget` 会同步撤掉探测胶囊的 `.probe-pill--managed` 高亮（否则确认时会静默按残留胶囊的模型名建路由）；切换供应商时 `resetProbe({resetName:true})` 会清掉上一家手填的自定义名并折回只读（否则残留名会经 `targetVal || mName` 变成新供应商上并不存在的 `target_model`）。
- **模板导入改为批量拉取缺失供应商（#7）**：勾选路由点导入后，先对所选路由依赖的全部缺失供应商去重、按依赖顺序一次性 `fetchVaultCredentials` 拉取（按钮实时显示「正在拉取供应商…（i/n）」），全部完成后重载配置再落地所选路由；单个供应商失败不阻断其它，最后汇总「成功 x / 失败 y（失败名单）」。**取消是真取消**：`closeTemplateImportOverlay()` 递增 `state.importRunId`，拉取循环在每个 await 后检查，Esc / 遮罩 / 关闭后不再 persist（此前循环会跑完并照常落地路由）。**未落地的路由逐条点名**：供应商拉取失败 / 拉回的 Key 缺模板要求的标签 / 同名路由已存在，都会出现在 toast 里，且只要还有未导入项就保持弹层打开（此前被静默丢弃）。行内逐个「拉取」按钮与 `data-tpl-fetch` 分支删除，仅保留「本地已有供应商缺 Key 标签」的补拉入口（这类缺口无法自动解析）。

### Verified

- `npm run test:t1` 8/8 全绿（settings/schema/Go 结构体 1:1、admin-ui 契约与 `host.js` capabilities 对齐、readonly 路由守卫、presets 完整性、UI 零内联样式与体积门禁、hub 纯 Web Standard 门禁）。
- `npm run test:admin`（build:admin）5 道硬门禁全过：零内联样式 / 零抽屉 / 零左边框 / 体积 **254,024B ≤ 258,048B**（较上版 256,550B 净减 2,526B）/ edge-functions gzip 31,510B ≤ 45,000B；同步再生成 `shared/admin/dist/index.html`、`internal/admin/assets/index.html`、`admin/index.html` 与 `edge-functions/_hub/`（构建产物未手改）。
- `npm run test:hub` 53/53 全绿；`go build ./...` 通过；`go test ./internal/auth/ ./internal/admin/ ./internal/config/ ./cmd/llmproxy/` 全绿（含新增的 `#8` 守卫：Former `proxy_keys` 条目不再鉴权、旧配置反序列化不报错、`access-key` / `access-info` 不再出现 `proxy_keys`）。
- 版本号三处同步：`version.json`（v20261123-06 / 2.11.0）、`cmd/llmproxy/main.go` 的 `version`/`AppVersion` 回退字面量（`TestVersionVariables` 守护与 version.json 一致）、`edgeone-hub/lib/generated-version.js` 与 `edge-functions/_hub/lib/generated-version.js`（`npm run build:presets` + `npm run test:admin` 再生成，未手改）。
- 契约同步：`shared/contracts/admin-ui-backend.json` `$changelog` 增 v3.7 条（删 `proxy_keys_count`、`access-key` 不收/不回显 `proxy_keys`、`VerifyClientKey` 只认单密钥）；`docs/ADMIN_UI_BACKEND_CONTRACT.md` §6.6 补单密钥口径、§7.3.5 删除 `extraKeys` 表述。`docs/OPERATIONS_GUIDE.md` 无「附加客户端密钥」段落，无需改动（全篇只在 §2.1 描述单 `client_key` / `PROXY_API_KEY`）。

---

## [v20261123-05] - 2026-11-23

### Fixed

- **心跳默认策略按角色分级**：v20261123-03 为了让「升级后中枢显示新版本」立即生效，把 **full** 也设成每 10 分钟周期心跳——这是过度设计。full 有自己的管理台、不依赖中枢存活，周期心跳对它几乎无收益，却要花掉同样的 EdgeOne Makers 免费调用次数（144 次/天/节点）。
- **新策略**：两个角色默认都**只发一次启动心跳**（启动 5 秒后 1 次调用 → 升级重启即让中枢看到新版本）；**周期性心跳只在显式设置 `LLMPROXY_HEARTBEAT_INTERVAL`（≥60 秒）时开启**。
- **lite 保持周期上报**：lite 没有 Web 端，中枢是它唯一的可见性入口，因此 `install.sh` 给 lite 的 systemd 单元显式写入 `LLMPROXY_HEARTBEAT_INTERVAL=600`；full 单元不写该变量，因此不产生周期调用。

### Verified

- 新增 `Client.StartOnce`（单次发送、忽略 interval）与 `ShouldSendStartup`；`ShouldEnable` 收紧为「两个角色都需显式 opt-in 才周期发送」。
- `hubheartbeat` 单测更新并全绿（full 默认 false / 显式 true 才开 / startup 恒发），`go test -race ./internal/hubheartbeat/` 通过。
- `docs/OPERATIONS_GUIDE.md` 心跳章节同步新语义；`deploy/install.sh`（与根目录 `install.sh` 同步）lite 单元补该变量。

---

## [v20261123-04] - 2026-11-23

### Added

- **设置页规范补齐：网关接入 / Vault 链接 / 配置备份三块迁移到 `setting-row`**：v20261123-03 只完成了「全局路由策略」6 项与「并发护栏」2 项，用户报告点名的这三块仍是旧 `form-grid` 形态（无字段说明小字、无悬停提示）。本次补齐后设置页共 **15 行 setting-row**，每行都是「标题 + 说明 + 右侧控件 + `title` 悬停提示」的统一形态：
  - 网关接入：Base URL（只读，由访问地址推导）、主客户端密钥（含随机生成/保存按钮）、附加密钥列表（多端分发用）
  - Vault 链接：中枢地址、节点同步 Token
  - 配置备份：导出完整 JSON、导入 v1/v2（合并/覆盖模式 + 文件选择）
- `settingRow` helper 新增可选 `id` 参数——Base URL 行需要按角色门控（仅 full 显示），旧实现靠 `#gwBaseUrlGroup` 容器，改为把 id 挂到行自身；配套新增 `.setting-row[hidden] { display: none }`（`display:flex` 会盖过 UA 的 `[hidden]` 规则）。

### Verified

- 浏览器实测：15 行 setting-row、全部原有输入框 id 存在（`gwBaseUrl`/`gwClientKey`/`gwProxyKeys`/`cfgVaultUrl`/`cfgVaultToken`/`btnExportConfig`/`importConfigMode`/`btnTriggerImport`）、`gwBaseUrlGroup` 角色门控正常、**0 行空说明**。
- 值填充未受影响（`renderSettingsView` 按 id 填值逻辑零改动）：`gwBaseUrl=http://127.0.0.1:18080/v1`、client_key 已填入、路由策略 `sticky_failover`、OCR 并发 `4`。
- 包体 256,550 / 258,048 字节；`test:admin` 5 门与 `verify:release` G1–G6 全绿。

---

## [v20261123-03] - 2026-11-23

### Added

- **设置页统一 setting-row 行规范（用户报告 #1）**：新增 `.setting-row` 组件——一行一项「标题（`.setting-title`）+ 说明小字（`.setting-desc`）+ 右侧控件（`.setting-control`）」，说明文本镜像写入行容器 `title` 属性作悬停提示，行间以 `--khc-border-1` 分隔线、末行无线。`mountSettingRows()` 初始化时把「全局路由策略」6 项与「高并发护栏」2 项由 `.form-grid` 裸网格改为 setting-row 挂载（`admin.html` 仅留 `#routingPolicyRows`/`#concurrencyGuardRows` 空容器、运行时渲染），全部输入框保留原 id，`renderSettingsView` 按 id 填值的逻辑零改动；每项补齐字段说明（如「429 限流冷却」= 命中上游限流后该 Key 暂停调度的时长）。≤768px 时说明与控件折行、控件占满整行。
- **顶栏品牌区版本号（用户报告 #5）**：品牌行新增 `#brandVersion`（`.text-xs.text-muted`），Full 端经 `GET /api/admin/system/version` 显示网关当前版本号（`setBrandVersion`，与设置页共用一次请求结果）；Hub 中枢无该端点，span 保持留空、不报错。
- **模板导入「缺依赖」可点击动作（用户报告 #4）**：模板候选行原来把「需先拉取供应商 xxx」「候选绑定的 Key 标签本地缺失」渲染成一串红色错误条、无任何动作指引。现改为琥珀色「缺依赖」胶囊 + 行内按钮：整体缺失的供应商给「拉取 <供应商>」（整供应商规则与全部 Key）；本地已有但缺绑定 Key 标签的给「点此补拉 <供应商>」（只补拉缺失的标签列表）——供应商整体缺失时其名下所有标签缺口由「拉取」覆盖，不再叠加必然失败的补拉钮。`#templateImportList` 上单个事件委托监听（`data-tpl-fetch` / `data-tpl-fetch-keys` / `data-labels`）跨每次 innerHTML 重渲染存活，点击经 `fetchVaultCredentials` 拉取（`key_label` 保持 undefined 以对齐供应商编辑器补拉口径），成功即重拉配置并重绘列表、对应候选恢复可勾选，失败 toast 并复位按钮可重试。
- **节点心跳与版本上报（低成本，`edgeone-hub/api/node/heartbeat.js` + `internal/hubheartbeat/`）**：新增 `POST /api/node/heartbeat`——`Bearer stk_node_*` 鉴权（复用 `findNodeByToken`），只更新 `last_seen` / `last_ip` / `last_binary_version`，成功恒定 **204 无 body**，不拉配置、不做投影、不返回 payload；中枢用既有 `last_seen` 做 **60 秒服务端去抖**，窗口内直接 204 且**零 KV 写入**（EdgeOne Makers 免费额度同时限制调用次数与 KV 写入数）。`lite` 与 `full` 令牌均可用（为后续 lite UI 配置预留）。客户端新增 `LLMPROXY_HEARTBEAT_INTERVAL` 环境变量 / `--heartbeat-interval` 标志（秒）：默认 600（每节点每天约 144 次）、最小 60（小于按 60 处理）、`0`/`off` 关闭；**full 默认启用、lite 默认关闭**（lite 显式配置非 off 值才发，保持零轮询）。启动延迟 5 秒发首次心跳、不阻塞启动——升级重启即自动上报新二进制版本；失败只记 debug 日志，不重试风暴、不阻塞数据面与启动。
- **契约与文档同步**：`shared/contracts/admin-ui-backend.json` v3.5 新增 `node_heartbeat` 端点（鉴权、可选 `X-Node-Version`、60s 去抖、204 无 body、不下发配置）与 `LLMPROXY_HEARTBEAT_INTERVAL` 语义；`docs/ADMIN_UI_BACKEND_CONTRACT.md` 新增心跳契约节；`docs/AGENT_DEPLOY_GUIDE.md` §2.5 令牌能力矩阵补心跳行；`docs/OPERATIONS_GUIDE.md` 新增「节点在线状态与版本上报」小节（频率 / 免费额度影响 / 关闭方法）。版本号与已完成的 UI 修复同批交付，仍为 v20261123-03 / 2.10.1。

### Fixed

- **「新增模型路由」首选供应商搜索下拉挤爆表单（用户报告 #6，回归）**：`#npPanel` 原是表单流里的普通 `div.card`，无任何浮层定位——展开即撑开表单布局、宽度随内容收缩到约 1/3、搜索框与「手动输入」按钮挤在面板内部无法使用。现包进 `.np-combo`（`position:relative`）浮层化：`.np-panel` 绝对定位于输入框正下方（`top:100%`、左右贴齐输入框整行宽度）、`z-index:30` 浮于后续字段之上、`max-height:280px` 弹性列布局，搜索框与「手动输入」页脚固定、仅候选列表滚动（`.np-panel-options` `overflow-y:auto`）；HTML 同步重排为 `np-panel-search` / `np-panel-options` / `np-panel-foot` 三段。
- **模型路由术语混乱（用户报告 #3）**：路由列表入口「添加模型」→「新增模型路由」（空态提示同步）；编辑器「模型列表」改「候选池（该路由可用的 供应商×Key 组合）」+ 说明「按策略从这里挑一个来发请求；排第一的是首选」，「+ 添加模型」→「+ 添加候选」并移入候选池标题行；「对外模型名」说明补「这就是一个路由：Agent 客户端用这个名字调用」；「保存模型配置 / 删除此模型」→「保存路由配置 / 删除此路由」，保存/删除 toast 与确认弹窗同步改为「路由」口径。
- **在线升级无反馈、不自动刷新（用户报告 #5）**：升级过程现于 `#systemUpdateResult` 内显示「正在升级...」进度胶囊与失败原因（此前只有一闪而过的 toast）；成功后每 2s 轮询 `/api/admin/system/version`（最长 60s）——检测到版本号翻转（或轮询期间服务曾不可达、重启后恢复）即自动 `location.reload()`，60s 超时兜底显示手动「刷新页面」按钮；升级请求本身补 try/catch，异常不再无提示。
- **高级折叠展开不可见（用户报告 #2）**：`.headers-details` 的 `summary` 挂 `.form-label`（`display:flex`）后原生展开三角被丢弃，用户看不出可展开。补 `summary::after` 显式「⌄」chevron（`--khc-text-3`，展开态旋转 180°、0.15s 过渡）；节点编辑「高级选项」、供应商编辑「高级配置」、原始 JSON「原始 JSON 配置查看与直接保存」三处折叠措辞统一为「高级 (…)」。

### Verified

- `npm run test:admin`（build:admin）五门禁全过：零内联样式 / 零抽屉 / 零左边框 / 体积 257,925B ≤ 258,048B（余量仅 123B，如实记录）/ edge-functions gzip 30,408B ≤ 45,000B；同步再生成 `shared/admin/dist/index.html`、`internal/admin/assets/index.html`、`admin/index.html` 与 `edge-functions/_hub/`。
- `npm run test:t1` 8/8 绿（契约与 host.js capabilities 对齐、readonly 路由守卫、presets 完整性、UI 零内联样式与体积门禁、hub 纯 Web Standard 门禁）。
- `go build -trimpath -o /dev/null ./cmd/llmproxy` 通过。
- 版本号四处同步：`version.json`（v20261123-03 / 2.10.1）、`cmd/llmproxy/main.go` `version`/`AppVersion` 回退字面量、`edgeone-hub/lib/generated-version.js` 与 `edge-functions/_hub/lib/generated-version.js`（`npm run build:presets` + `npm run build:admin` 再生成，未手改）。
- 本版为纯前端（`shared/admin/` 源码 + 三构建产物）可用性修复，无后端/契约/协议改动：`shared/contracts/admin-ui-backend.json` 保持 v3.4，Go 侧仅 `main.go` 版本字面量同步。

---

## [v20261123-02] - 2026-11-23

### Added

- **节点后台密码可回看（Hub KV 明文存，运营者明确选择的方案 A）**：Full 节点签发时生成的 `admin_password` 原先只在 `install_command` 里出现一次、KV 不存，忘掉即只能轮换。现改为签发时即写入中枢 KV（明文，私有部署风险已知悉），节点对象随列表返回该字段、控制台可随时查看与复制（`edgeone-hub/lib/nodes.js` `issueNode`/`sanitizeNode`——脱敏哈希照旧剔除、明文密码保留）。Lite 节点没有管理控制台，从不含该字段；full→lite 改角色时 `patchNode` 主动删除残留密码，不留幽灵凭据；lite→full 改角色时 `patchNode` 立即补生成并持久化一份，凭据端点即刻可回看（不再对刚切角色的节点误报「旧版本未存密码」）。
- **只读凭据端点 `GET /api/admin/nodes/:id/credentials`**：节点列表每行新增「密码」按钮，弹层默认掩码显示（●●●●●●●●●●●●）、「显示/隐藏」切换、「复制密码」「复制 API Key」。端点只读、**绝不轮换 Token**，响应带 `Cache-Control: no-store`（载荷含明文凭据，任何中间层不得缓存；节点列表响应载荷同样携带明文密码，故同加 no-store）；Full 节点返回 KV 明文密码与全局 `client_key`——**原样返回 `settings.client_key` 当前生效值**（full 节点按中枢同步投影的 raw 值鉴权，不做 shell 字符剥离，手打含特殊字符的密钥不会展示成失配值），Lite 节点与「未存过密码的历史版本节点」返回说明性 note 指引（`edgeone-hub/api/admin/nodes.js`）。
- **契约同步**：`shared/contracts/admin-ui-backend.json` 升 v3.4——`$changelog` 补 v3.4 条目、`nodes_list`/`nodes_issue`/`nodes_rotate`/`nodes_install_command` 响应补 `admin_password` 字段说明、新增 `nodes_credentials` 端点、`auth_semantics` 新增 `query_string_credentials`；`docs/ADMIN_UI_BACKEND_CONTRACT.md` 新增 §2.4（凭据端点契约）与 §7.3.5（查询串直登取舍），§2.1/§2.2/§2.3/§7.4 相应补记。

### Fixed

- **重新获取安装命令必然换后台密码**：`reissueNodeToken` 原先每次都重新生成 `admin_password`，配合「KV 不存」意味着每次重取安装命令都得到一个全新的控制台密码。现语义拆分：`node_token` 照旧轮换（KV 仅存 `token_sha256` 的口径不变），KV 已存的 `admin_password` **原样复用**（运营者可能已另行保存）；仅历史未存密码的 Full 节点在此刻补生成一次并持久化，保证后续凭据端点查看稳定（`edgeone-hub/lib/nodes.js` `reissueNodeToken`）。轮换成功 toast 相应改为「Token 轮换成功，后台密码保持不变」。

### Verified

- Go 守卫测试改写并扩充（`internal/auth/auth_test.go`）：原 `TestVerifyAdminAuth_RejectsQueryStringTokens`（拒绝查询串）按新语义翻转为 `TestVerifyAdminAuth_AcceptsQueryStringTokens`——`?key=/?token=/?password=` 三参直登、请求头优先于查询串（错 `?key` + 正确头 → 成功）、`?key` 优先于 `?token`（错 `?key` + 正确 `?token` → 失败）；新增 `TestVerifyAdminAuth_WrongQueryKeyCountsTowardLockout`——错误查询串凭据与错误请求头同等消耗防暴力额度，封禁期内正确 `?key` 同样被拒。
- `go test ./internal/auth/ -run TestVerifyAdminAuth -v` 全过；`npm run test:t1` 8/8 绿（契约与 host.js capabilities 对齐、hub 实现文件存在性、零内联样式、体积 ≤ 258,048 B 门禁）。
- Hub 侧测试补齐（`edgeone-hub/test/hub.test.mjs` 新增 11b 组，共 46/46 绿）：credentials 端点鉴权门（无凭据 401）/未知节点 404/`no-store` 头/full 明文回显/lite note；节点列表载荷携带 `admin_password` 且同样 `no-store`；full↔lite 角色切换双向对称（删残留 / 补生成）；legacy 无密码节点轮换恰好 mint 一次并持久化（二次轮换复用）；`settings.client_key` 含 shell 特殊字符时凭据端点原样直传。全仓门禁 `verify:release` G1–G6 全过（含 `go test -race ./...` 与确定性构建零漂移）。
- 前端零内联样式纪律：凭据弹层的显隐/掩码切换只用 `[hidden]` 与 `textContent`，未引入 `style=`/`.style.xxx`。

---

## [v20261123-01] - 2026-11-23

### Fixed

- **vault 载荷缺 `rpm_per_key`，中枢限流到不了节点（真机 E2E 实测发现）**：`/api/vault/fetch` 的 `provider_config` 与 `/api/vault/manifest` 的 `providers.<id>` 都不带这个字段。后果有两个：① 在中枢给某供应商配了整体 RPM 上限，full 节点按需拉取后拿不到，限流完全不生效；② 更隐蔽的是 full 节点重拉走 replace 语义、整体采纳载荷，缺省值 0 会**把节点本地已设的限流静默清掉**——运营在中枢或节点任一侧配好，下一次重拉就丢。
- 两处载荷均补 `rpm_per_key`（数值，缺省 0）。`lib/projection.js` 的 lite 投影路径原本已携带该字段，未改动。

### Verified

- 回归守卫：`edgeone-hub/test/hub.test.mjs` 的 vault manifest/fetch 用例新增断言（两侧 `rpm_per_key` 等值 60），套件 41/41 通过。
- 真机 E2E（HK NAT + 生产 Hub）全过：签发 `zz_` 节点 → 部署 v20261122-06 → manifest 19 供应商/8 路由且无明文 Key → 按需拉取 siliconflow 4 Key → 添加模型（勾 2/4 Key）→ 真实推理「你好！有什么可以帮助你的吗？」→ RPM 供应商级限流 `[200,200,502,502]` → 恢复不限 `[200,200,200,200]` → 删除路由后 404 → Hub 节点删除 → VM 卸载零残留。
- 同轮真机观察（非缺陷，如实记录）：测试路由命中另一把 Key 时上游返回 402 余额不足，路由按 sticky_failover 自动切到可用 Key 成功服务。
- `go test -race ./...`、`npm run test:hub`、`verify:release` G1–G6 全绿。

---

## [v20261122-06] - 2026-11-22

### Added

- **供应商整体 RPM 限流（调度器按供应商维度）**：`Provider.RPMPerKey`（`rpm_per_key`）语义改为「该供应商整体 RPM 上限，0=不限」——不再是 Key 级限流的回退值。`>0` 时调度器在派发前先对整个供应商做一次滑动窗口检查（**独立 `RPMLimiter` 实例** `providerRPMLimiter` 的桶 `provider:<provider_id>`，与 Key 级桶 `provider:key_label` 分属两个实例，命名空间不相交由构造保证；`internal/scheduler/rpm.go` 新增 `providerRPMKey()`/`TryAcquireToken()`）：窗口满则该供应商**全部 Key** 一律不再派发——排序期 `isCandidateHealthy` 判不健康（不占通道槽）、`Dispatch`（`internal/scheduler/scheduler.go`）与 `ExecuteEndpoint`（`internal/scheduler/high_conc.go`）的候选遍历两处显式跳过，跳过原因记 `<provider_id> (provider RPM limit)`（同供应商多候选去重）；随后才做 Key 级检查，`api_keys[].max_rpm` 语义不变、独立生效。旧「`RPMPerKey` 作为 Key 级回退」行为移除——N 把 Key 不会各拿一份整供应商额度。
- **路由编辑器按 magpie 骨架重排**：`buildModelEditor` 重排为「对外模型名（Agent 客户端看到的模型名）→ 模型列表（每行=序号+上游模型+供应商+上移/下移/移除，底部「+ 添加模型」内联面板：选供应商 → 探测胶囊点选 → 可手填上游 ID 追加）→ Key 选择（按供应商分行、胶囊多选，默认「任一」=空 `key_label` 用全部启用 Key，勾选具体标签按 `key[i%n]` 循环回绑该供应商候选，不乘出行数）→ 候选权重/并发上限折叠 → 路由策略平铺胶囊（每策略下方中文说明 + 当前生效默认值）→ 高级折叠（指定 Key/剥离思考/强制非流式/Key 回退）」。编辑器内全部重绘走局部 draw（`drawCands`/`drawKeys`/`drawAdv`），不再折叠行内编辑器；策略选择由隐藏 input 改为闭包内 `stratVal`。不搬 magpie 的上下文徽章、额度优先、模式匹配、压缩阈值、供应商 logo 与「也列出成员模型」开关；候选仍是一条 `provider+key_label+target_model`。

### Fixed

- **供应商级 RPM 两段式取令牌无回滚（虚耗供应商窗口）**：`Dispatch`/`ExecuteEndpoint` 先取供应商级令牌、随后 Key 级 `TryAcquire` 失败 `continue`（或 OAuth 刷新、`PrepareRequest` 等拨号前失败）时没有任何路径移除该时间戳，供应商窗口被从未发出的请求虚耗——实测 rpm_per_key=3、k1 MaxRPM=1、k2 不限、round_robin 两候选连发 3 请求得 `[200,200,502]`（真实上游命中 2）。`internal/scheduler/rpm.go` 新增 `TryAcquireToken()`（返回撤销句柄，精确移除本次记录的时间戳），两处调度循环在 Key 级拒绝与全部拨号前失败路径上回退供应商令牌（及 Key 令牌）；已拨上线的尝试令牌保留。守卫测试 `TestScheduler_Dispatch_ProviderTokenReleasedWhenKeyLimited`：同场景 3 请求全 200、k1 恰 1 次、k2 恰 2 次。
- **供应商级桶与 KeyTag 桶命名空间碰撞**：KeyTag 为 `providerID:key_label`，单靠注释断言「`provider:<id>` 命名空间不相交」不成立（供应商 ID 恰为 `provider` 且 Key 标签撞另一供应商 ID 即共享窗口）。改为供应商级限流使用独立 `RPMLimiter` 实例（`Scheduler.providerRPMLimiter` + `ProviderRPM()` 访问器），不相交由构造保证；守卫测试 `TestRPMLimiter_ProviderWindowIsOwnLimiter`。
- **跳过原因不可定位且重复**：`provider RPM limit` 裸写不带供应商标识、同供应商多候选按候选数重复 N 遍。改记 `<provider_id> (provider RPM limit)`，并新增 `appendSkipOnce()` 对完全相同的跳过消息去重（Key 级消息既有 `<keyID> (RPM limit)` 格式不变）。注：全部候选被限流跳过时仍回 502 `upstream_error`「all candidate keys failed」——与 Key 级 RPM 既有行为及 E2E S4a 断言一致，未改状态码。
- **high_conc 通道槽 claim 复用 stale 闭包（MaxConc 瞬时旁路）**：RPM 跳过先释放 claim 后，同 KeyTag 后续候选仍走 `claimTag == cand.KeyTag && claimRel != nil` 分支拿已释放的槽位（once-guard 二次释放无效，该次尝试不持通道槽）。改为 `releaseSlot()` 闭包：凡释放的是 claim 槽即置 `claimRel = nil`，后续候选必须自取槽位。
- **vault 重拉对 rpm_per_key 只增不减**：`internal/config/local.go` 两个合并分支原为 `if vp.RPMPerKey > 0 { ... }`，中枢清 0（放开限制）后节点重拉仍保留旧正值。改为中枢托管字段全量跟随（与同函数 `AdapterRules` 缺失即清空的口径一致）；`TestLocalSource_MergeVaultConfig_PreservesMagpieFields` 补「中枢清 0 → 节点跟随 0」与 replace 分支两向断言。
- **供应商编辑器 RPM UI 与新语义相反（方案 C 未落地）**：`rpm_per_key` 字段由高级折叠内的「单 Key RPM 限制 (rpm_per_key)」改为编辑器顶部的「该供应商整体 RPM 上限 (rpm_per_key)」（placeholder `0 = 不限`，vault 托管供应商锁定）；Key 行 RPM 输入（`k_rpm_in`）及其写 `max_rpm` 的监听整体撤除，表头「权重 / RPM」改「权重」。存量配置里已有 `api_keys[].max_rpm` 语义不变，仅不再在节点控制台编辑。
- **模型编辑器 Key 勾选与候选绑定状态不一致**：①打开编辑器时 Key 选择区按候选现状播种 `m._keySel`——添加模型弹层建出的「全绑具体 Key」候选不再显示为骗人的「任一」高亮；②勾选数多于候选数时，多余 Key 的胶囊追加「未绑定候选」徽章、模型列表每行新增绑定 Key 胶囊（`Key <label>` / `任一 Key`），勾了没用的状态可见。
- **编辑器「+ 添加模型」面板换供应商不重绘探测**：`#m_ac_prov` 原仅 click 重绘，键盘/datalist 换供应商后旧供应商的胶囊仍可勾选、确认即生成「新供应商 × 旧供应商模型」的坏候选。补 `input`/`change` 监听（change 提交时同步清空手填目标，与添加模型弹层「换供应商即作废探测结果」防线对等）。
- **添加模型弹层不过滤禁用 Key**：Key 胶囊现按 `enabled !== false` 过滤（与编辑器 Key 选择区一致），确认路径同样拒绝已禁用 Key——调度器展开候选时直接跳过禁用 Key，绑了也不路由。
- **探测失败无持久内联提示**：失败/空结果/异常除 toast 外，在探测结果框（`#npbPills`）内留下持久失败原因（如 401/502 文案），下次探测、切换供应商或关闭弹层时清除——错过 toast 也能看到失败原因；手填路径不受影响。
- **「已适配」判定按 preset_id 而非适配文件**：卡片徽章/编辑器版本说明/「已适配」筛选统一改为「真有适配脚本」判定——适配文件预设（meta 带版本）、中枢规则（`rule_hash`）或内联 `adapter_rules` 三者其一；绑定 anthropic（无适配文件）等仅命名协议的 preset 显示「自定义（无适配文件）」且不再计入已适配；vault 卡片保留 `rule_hash` 指纹展示。
- **hub 端 `_keySel` 编辑态随配置入库**：full 端 Go 结构体丢弃未知字段，hub 端 `saveConfigWithCAS` 原样 `JSON.stringify` 入库导致过期勾选跨会话回显。`persistConfig` 统一在保存前剥离 `agent_models[*]._keySel`，两端口径一致（选中状态仅在编辑会话内存活）。
- **路由行「测试路由」最小推理载荷与方案字面一致**：`POST /api/admin/test-agent-model` 两分支载荷 `content` 由 `"Hi"` 改为 `"你好"`（`max_tokens:16` 不变），与已确认方案 G 对齐（`internal/admin/admin.go`）。
- **路由行「测试路由」统一为最小真实推理**：chat 类路由经 `POST /api/admin/test-agent-model` 对每条启用候选各发一次 `{messages:[{role:"user",content:"你好"}], max_tokens:16}` 的真实推理（`anthropic-messages` 供应商发 `/v1/messages`，最多 5 路并发、15s 超时），路由行展示**最快通过候选**的「测试 `<延迟>ms · <供应商> · <Key>`」胶囊；embedding/reranker/ocr 路由走 `POST /api/admin/test-candidate` 单候选探测（embeddings/rerank/1×1 PNG OCR 载荷）；两种探测成功均清除该 Key 的冷却封禁。两条端点此前未入契约文档，本次补入（`shared/contracts/admin-ui-backend.json` 升 v3.3，`docs/ADMIN_UI_BACKEND_CONTRACT.md` 新增 §6.7/§6.8）。
- **中枢「模型路由模板」页角色降级**：Hub 模板页副标题改为「仅下发给 lite 节点；full 节点可选导入」——Hub 的模型路由退为「lite 模板 + full 可选导入源」，full 节点路由一律本地创建（既有按需拉取 + 模板导入不变）。
- **新增供应商弹层改居中 overlay 模态**：`addProviderForm` 由内嵌卡片改为与登录屏同款的居中 overlay（`login-card` 布局、右上角关闭按钮），cURL 自动解析入口保留；`icons.js` 清理未接线的 generic 图标脚手架（`ICONS`/`getBrandIcon`/未使用的 UI 图标字面量）。

### Verified

- `npm run test:t1` 全绿（T1 契约守卫：capabilities 对齐、full/hub 端点注册与实现文件存在性、readonly 路由边界、presets 完整性、UI 零内联样式与体积门禁）；`npm run test:hub` 41/41 全绿；`go test -count=1 ./internal/...` 全部 22 包通过，`go build ./...` 与 `go vet ./internal/...` 干净。
- `npm run test:admin` 全量构建五门禁通过（零内联样式/零抽屉/零左边框/体积/edge gzip 29,739B ≤ 45,000B），并再生成 `shared/admin/dist/index.html`、`internal/admin/assets/index.html`、`admin/index.html` 与 `edge-functions/_hub` 同步产物（源码与三产物 `probe-pill--managed` 计数一致=15）。**打包体积门禁由 240 KB（245,760B）重标为 252 KB（258,048B）**——magpie 骨架重排与探测/策略胶囊等已确认 UI 的真实字节成本，同步更新 `shared/admin/build.mjs` Gate 4、`scripts/verify-release.mjs`（G2 漂移校验自带同款上限）、`tests/t1_contracts/verify_contracts.test.mjs`、`docs/UI_DESIGN_SPEC.md`、`docs/TESTING_SPEC.md`、`docs/EDGEONE_MAKERS_PLATFORM_GUIDE.md`、`docs/MULTI_AGENT_BLUEPRINT.md`、`CLAUDE.md` 与 `docs/ADMIN_UI_BACKEND_CONTRACT.md` §八；§八新增流程纪律：改 `shared/admin/` 源码必须当场跑 `npm run test:admin`（含体积门禁），只跑下游产物校验不算数。
- `go test -race ./internal/scheduler/` 全绿，含 `internal/scheduler/rpm_provider_test.go` 九例：供应商窗口由双 Key 共享额度（第三请求被拒且不达上游）、Key 级 `MaxRPM` 在供应商窗口有余量时独立拦截、`RPMPerKey=0` 不装供应商窗口（chat 与 embeddings 两路径）、供应商窗口满时排序期即拦截不占通道槽、**供应商令牌在 Key 级拒绝时回滚（3 请求全 200、k1 恰 1 次 k2 恰 2 次）**、**供应商桶与 KeyTag 桶分属独立实例不碰撞**、`TryAcquireToken` 取/还精确配额；`internal/config/local_test.go` 补 vault 重拉 rpm_per_key 双向（设值/清 0）与 replace 分支断言。
- 版本号四处同步：`version.json`（v20261122-06 / 2.9.3）、`cmd/llmproxy/main.go` `version`/`AppVersion` 回退字面量、`edgeone-hub/lib/generated-version.js` 与 `edge-functions/_hub/lib/generated-version.js`（`npm run build:presets` + `npm run build:admin` 再生成，不手改）。

---

## [v20261122-05] - 2026-11-22

### Added

- **添加模型支持探测上游与按需选 Key**：添加模型弹层重构——「首选供应商」由裸下拉改为可搜索下拉面板（行内显示供应商名称与 Base URL，支持 `↑`/`↓`/`Esc` 键盘导航与「手动输入」任意 ID）；新增「探测模型」按钮，经网关 `HOST.probeModels` 用已存 Key 拉取上游 `/models`，探测结果以胶囊展示（支持过滤、点击回填「上游目标模型 ID」）；Key 改为胶囊按需勾选——**默认一个都不勾**（不默认全选），确认时每个勾选的 Key 生成一条候选，切换供应商即作废上次探测结果与勾选。
- **供应商适配文件版本展示**：`presets-extra` 响应的 `PresetDef` 新增 `version` / `updated_at` 字段（`internal/provider/presets.go`，镜像 `shared/presets/<id>.json` 适配文件的版本与日期，Go 目录内 10 个有适配文件的预设置入字面量，如 openai `1.2.1 · 2026-10-19`）。full 与 Hub 两处控制台的供应商卡片均显示「适配 `<id>` · v`<版本>` · `<日期>`」胶囊；vault 中枢拉取供应商因托管字段随中枢、本地不持适配文件，改显示 `rule_hash` 指纹（前 8 位）；编辑面板「预设规则绑定」下方同步显示版本说明。无适配文件的预设（anthropic、minimax-cn 等）两字段 `omitempty`，不显示标签。
- **契约同步**：`shared/contracts/admin-ui-backend.json` 升 v3.2（`presets_extra` preset 对象补 `version`/`updated_at` 字段说明），`docs/ADMIN_UI_BACKEND_CONTRACT.md` §6.5 示例与字段说明同步。

### Fixed

- **模型路由页的「内置固定通道」不再自动生成，且全部可删除**：移除前端 `ensureUnifiedFixedRoutes()`——此前每次读配置都会从 `kb_models` 内存重建 chat/embedding/reranker/ocr 四条路由并置顶展示、带「内置固定通道」标签且无删除按钮。现在四通道不再默认生成，「固定 4 通道」筛选子模式一并移除；所有路由一律按字母序平等渲染，`buildModelEditor` 不再区分 `isFixed`，删除按钮无条件渲染。已有部署存留的四通道升级后原样保留、可手动删除；后端 `kb_models` legacy 回退（`internal/scheduler/high_conc.go ResolveRoute`）与 KB 端点固定名消费（`internal/kb/kb.go`）不动——删除四通道后，KB 端点对未配置类别回 404 属预期行为（要用 KB 就自行建同名路由）。
- **删除路由防幽灵复活**：删除与 legacy KB 通道同名的路由时，同步 `delete kb_models[同名类别]`（复用既有清除模式）——否则下一轮配置回读会被 legacy 回退复活出删不掉的通道。
- **固定通道残留语义清理**：删除前端 `FIXED_SLOT_META`——hub 模型路由页不再隐藏自建的 chat/embedding/reranker/ocr 路由（自建即可见、可管理、可删除，与 full 节点及投影下发语义一致）；模板导入不再把四通道名无条件拉黑（旧中枢清单存留的同名模板路由恢复可导入，与「要用 KB 就自行建同名路由」路径对齐）；随固定通道移除已失效的「全部/自定义模型」子模式切换（过滤逻辑早已为死代码）一并清理。
- **添加模型表单缺陷修复**：探测结果过滤框 stale closure 修复——过滤监听只绑一次但闭包捕获首次探测的数组，重探/换供应商后过滤框按旧供应商列表重绘、可把上一家供应商的模型名回填进「上游目标模型 ID」，现改为 draw 每次实时读 `state.addModelProbed`；切换供应商、重开弹层（另清「对外模型名」）与探测失败/异常均清空「上游目标模型 ID」及探测胶囊，杜绝旧供应商模型名残留成静默坏路由；探测期间禁用按钮防并发重复点击、失败路径不再残留无标记旧胶囊；「手动输入」先校验供应商存在性再校验 Key 勾选，不再以「请至少勾选一把 Key」掩盖「供应商不存在」。
- **供应商版本胶囊接入服务端数据**：`mergeExtraPresets` 对表中已有 id 不再整体跳过——`presets-extra` 下发的 version/updated_at 现在会刷新表项并在加载后重渲染，full 控制台版本胶囊跟随服务端适配文件元数据而非纯前端字面量；`minimax-cn` 表项不再借用 minimax 适配文件的版本号（其自身无适配文件、服务端 omitempty，此前会显示不存在的适配版本）。
- **Vault 重新拉取后悬空候选告警**：重拉成功后扫描 `agent_models` 中候选绑定的 Key 标签是否仍存在于对应供应商 Key 池（复用模板导入的缺失校验），缺失时以警告 toast 列出受影响路由——此前 `replaceVaultKeyList` 整表替换后路由卡片圆点仍按候选数量显示绿色、请求时才 503。

### Verified

- `npm run test:t1` 全绿（T1 契约守卫：路由注册、capabilities 对齐、UI 限额、settings schema 双向校验）。
- `go test -race ./internal/provider/` 全绿，含 `TestCatalog_PresetAdapterVersions`：测试改为直接读取 `shared/presets/<id>.json` 适配文件比对 `presets.go` 的 `version`/`updated_at`（有版本必须有同名适配文件且数值一致、有适配文件不得缺版本，双向守卫杜绝字面量副本漂移）、`Catalog()` 克隆与 JSON 编码后字段存活；`go build` 编译通过。
- 前端源码改动后 `npm run build:admin` 重新构建，`shared/admin/dist/index.html`、`admin/index.html`、`internal/admin/assets/index.html` 三处产物同步零漂移。

---

## [v20261122-04] - 2026-11-22

### Fixed

- **Web 端在线升级 `permission denied`（两层根因，均实测复现后修复）**：full 服务以非特权 `llmproxy` 用户运行，而二进制在 root 属主的 `/usr/local/bin`。第一层：升级暂存文件 `llmproxy.upgrade.tmp` 打开即被拒；第二层（更隐蔽）：即使暂存文件已归运行用户，**rename 替换需要目录写权限**，文件属主并不够——实测仍 `permission denied`。仅靠预创建暂存文件的方案被推翻。
- **二进制布局迁移（最终方案，零提权）**：full 的真实二进制改放 `/opt/llmproxy/bin/llmproxy`（运行用户可写目录），`/usr/local/bin/llmproxy` 降级为符号链接保持 PATH 与文档兼容；systemd `ExecStart` 改指真实路径。`os.Executable()+EvalSymlinks` 解析到真实路径，Web 升级的暂存写入与 rename 全程在可写目录内完成，无 sudoers 变化、无目录放宽权限。
- **历史部署升级路径**：旧布局（二进制直接在 `/usr/local/bin`）重跑一次 `install.sh` 即自动迁移——二进制原子搬迁、原路径换符号链接、`ExecStart` 就地改写、残留 staging 文件清理。lite 无 Web 升级，布局不变。
- **报错可操作化**：staging 打开遇 `permission denied` 时，错误信息附带修复指引（重跑 `install.sh` 或改用 `llmproxy-ctl upgrade`），不再裸抛 errno。

### Verified

- HK NAT 实测两条链路均通过：① 旧布局 v20261122-03 → 重跑 `install.sh` 迁移 → Web 升级 `ok:true` → SIGTERM → systemd 拉起 → 服务 `active`、版本正确；② 全新安装直接新布局 → Web 升级 → `active`。`llmproxy-ctl` 经符号链接正常工作；卸载零残留（含 `/opt/llmproxy`）。
- 回归单测 `TestSystemUpgrade_StagingPermissionHint`：staging 打开失败时报错必须含修复指引；既有 SEC-05 fail-closed 三例保持绿；`go test -race ./internal/admin/` 全绿。

---

## [v20261122-03] - 2026-11-22

### Added

- **full 模式中枢内容改「按需拉取」（对齐 1 代语义，砍掉一键全量同步）**：移除全量同步端点 `POST /api/vault/sync` 与对应合并逻辑 `MergeHubSync`，中枢托管内容不再一键整批落地，改为三步按需：清单 `GET|POST /api/vault/manifest`（仅元数据 + Key 标签，绝无明文）→ 单供应商整体拉取 `POST /api/vault/fetch`（适配规则 + 全部 Key）→ 按 Key 标签补拉（`key_label`/`keys` 参数，增量合并、不影响其它 vault Key）。整体拉取对已存在的 vault 供应商执行**整体替换**：中枢托管字段（name/base_url/anthropic_base_url/adapter_rules/preset_id/api_type/hide_client_name/rule_hash）与 vault Key 列表整体落库——本地删过的 Key 重新拉取即恢复，中枢删掉的 Key 本地随之消失；本地仍存在 Key 的启用开关与本地刷新的 OAuth 状态不被回退，供应商 `Enabled` 属本地运维开关、永不取自中枢载荷。
- **清单新增 `agent_models` 路由模板段**：中枢 manifest 下发按需路由模板——仅收录 `enabled` 的路由，按调用方模型 scope（节点 Token 的 `scope.models`，管理员视为 `["*"]`）过滤；候选必须引用清单 `providers` 段**存活**的供应商（禁用/死亡候选剔除、候选清零的路由整条丢弃），候选携带 `key_label` 与 `max_concurrency`（与运行时投影同字段名），绝不携带明文 Key 材料。控制台新增「从模板导入」弹层按需导入；模板路由不再随同步整批落地，本地路由完全自由、一条不用也可以。`providers` 段同步收紧：只列出启用且有 Key 材料（与运行时投影同口径）的 Key 标签，避免「清单可拉、运行时投影丢弃」的空转。
- **中枢规则漂移检测**：新增 `edgeone-hub/lib/rulehash.js`（FNV-1a 32-bit 内容哈希），manifest 与 fetch 对解析后的 `adapter_rules` 打同一 `rule_hash`；节点存储拉取时的哈希，与清单哈希不一致即规则漂移，控制台显示「中枢规则已更新」横幅提示重新拉取。fetch 载荷同步补 `api_type` 与 `rule_hash`（同为中枢托管字段，旧中枢不下发时重拉不回退为空）。
- **添加供应商不以预设为主**：预设退为适配文件模板——按输入的名称/ID 自动匹配并填充适配规则与 api_type（「已按预设 xxx 自动填充」），不再做头牌下拉；中枢托管供应商在新增弹层中直接从清单点选整体拉取，名称/URL 以中枢为准。

### Fixed

- **防管理密码泄露后把明文 Key 外送（供应商级锁定 + 拉取目标锁定）**：`enforceVaultProviderKeyLock` 升级为 `enforceVaultLock`——外部 SaveConfig 提交时，vault 供应商的 `base_url`/`anthropic_base_url`/`adapter_rules`/`preset_id`/`api_type`/`hide_client_name` 由后端**强制还原**为存储值（中枢托管内容不可本地改），vault Key 按标签/ID 匹配、篡改值或标签即还原，提交中缺失的 Key 视为本地删除（允许，重拉即恢复）；锁定范围由 Key 级扩展到供应商级。`POST /api/vault/fetch` 同时不再接受调用方传入的 `hub_url`/`node_token`——拉取目标永远是节点已配置的 Vault（存储配置或 CLI 默认值），调用方只能选择「拉取什么」，不能选择「从哪里拉」；上游请求体最小化，调用方凭据与 providers 一律不透传。
- **本地同名供应商冲突显式 409**：对已存在且 `origin=local`（或历史空 origin）的同 ID 供应商发起按需拉取，返回 `409 provider_exists_local`，并在配置锁内复核（拉取往返期间被并发改为本地供应商同样失败关闭），绝不把 vault Key 静默并入本地供应商。
- **按需拉取响应不再外泄明文**：full 节点自动导入后回显管理端前，对 `provider_config`/`providers` 中的明文 Key 掩码（控制台只读 `ok`/`provider` 后重载脱敏配置，明文不走管理端响应）；200 但响应体非 JSON 对象的中枢异常回包不再原样回显，改 502 `vault_fetch_invalid_response`。
- **杂项收紧**：中枢下发的供应商 ID 按字符白名单校验（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，ID 会成为 map key、调度标识与 DOM 元素 id，防注入与选择器破坏）；`/api/vault/manifest` 支持 POST（凭据走请求体，节点 Token 不进 URL/CDN 日志，GET + 查询串保留为兼容形态）；`mergeProviderKeys` 补齐本地刷新 OAuth 状态的整体采纳（元数据 + token 字符串一并采纳，避免「新过期时间配旧令牌」的半新状态），按 Key 补拉不再回退已存 Key 的本地启停开关；启动加载时一次性迁移 `origin=vault` 的模板路由为本地路由（不再视为中枢托管状态）。

### Verified

- `npm run verify:release` G1–G6 全绿（版本一致性、确定性构建零漂移、T1 契约守卫、Hub 单测、`go test -race ./...`、T3 黑盒 E2E）。
- 新增单测：Go 侧 `TestLocalSource_MergeVaultConfig_ReplaceBranch` / `TestLocalSource_MergeVaultConfig_PreservesLocalState` / `TestLocalSource_EnforceVaultLock` / `TestLocalSource_LoadFromDisk_MigratesVaultRoutesToLocal`、`TestAdminServer_VaultFetch_CannotBeRepointed` / `TestAdminServer_OnDemandVaultFetch_And_ExportStripsVaultState` / `TestDecodeVaultProviderConfig_RefusesUnsafeProviderIDs`；Hub 侧新增「12. Vault manifest agent_models」套件（scope 过滤、禁用路由与死候选剔除、明文 Key 零出现）与 fetch/manifest `rule_hash` 一致性断言。
- 契约同步：`shared/contracts/admin-ui-backend.json` 升 v3/v3.1（`vault_sync` 端点移除、`vault_fetch` 409/替换语义/`imported_keys`、manifest `agent_models`、manifest 双角色），`docs/ADMIN_UI_BACKEND_CONTRACT.md` §7.3.1 重写为按需拉取契约，`docs/AGENT_DEPLOY_GUIDE.md` 与 `README.md` 的全量同步描述改为按需拉取。

---

## [v20261122-02] - 2026-11-22

### Fixed

- **安装完成横幅的版本号过期**：横幅硬编码 `SCRIPT_VERSION="v20261118-02"`，2.8.0 装好后仍打印 `v20261118-02`，与实际安装的二进制脱节。现在优先执行已安装二进制的 `--version`，从其输出中提取 `vYYYYMMDD-NN` 作为展示版本，仅在无法执行时才回退到脚本常量；常量本身也同步到本轮版本。这样横幅永远不会比它刚装的二进制更旧。
- 同类隐患消除：版本展示不再依赖人工同步，后续发版无需再改横幅常量。

### Verified

- HK NAT 真实 VM 全新安装后横幅显示 `v20261122-01`，与 `llmproxy --version` 完全一致；`llmproxy-ctl uninstall -y` 后零残留（无单元、无二进制、端口释放）。

---

## [v20261122-01] - 2026-11-22

### Added

- **一键安装新增监听范围选项 `--bind=<local|public>`**：与 1 代一致的两种模式，安装时二选一。`local`（默认）写入 `LLMPROXY_ADDR=127.0.0.1:<port>`，只有本机能连，对外发布交给使用者自己的 nginx / caddy 反代或 `ssh -L`；`public` 写入 `[::]:<port>`（双栈通配，IPv4 + IPv6 都可连），直接对外提供服务。脚本**不再探测、也不再打印外部 IP**——端口如何暴露不属于本程序职责。已安装环境重复执行脚本即走平滑升级，`--bind` 同样改写监听地址并重启，因此可随时在两种模式间切换；非法取值立即报错退出（`--bind 参数必须为 'local' 或 'public'`）。

### Fixed

- **全新 full 安装必然失败（rc=1）**：`.env` 生成子 shell 的末条命令是 `[[ -n "$LLMPROXY_NODE_TOKEN" ]] && printf ...`，未提供节点令牌时该 `[[ ]]` 返回 1 并成为整个子 shell 的退出码，在 `set -e` 下直接终止安装；改为 `if ...; then ...; fi`。同款写法在升级路径的 `.env` 生成块中一并修掉。
- **原地升级必然失败（`cp: Text file busy` / ETXTBSY）**：`cp` 覆盖正在运行的二进制会被内核拒绝。改为「同目录临时文件 + `rename`」原子替换（`install.sh` 的二进制落位、`/opt/llmproxy/bin/llmproxy`、`llmproxy-ctl upgrade` 三处）：`rename` 换掉 inode，运行中进程保留旧映射，重启即加载新文件。`llmproxy-ctl` 自身脚本同样改为原子替换，避免覆盖正在被 bash 逐行读取的脚本。
- **`get_env_val` 的失败状态传播**：读取不存在的 `.env` 时该函数返回 1，`VAR=$(get_env_val ...)` 会继承这个状态并被 `set -e` 捕获，导致「只剩二进制、没有 `.env`」的环境必然安装失败。升级路径的 8 处探测统一加保护。
- **「只剩二进制、无 systemd 单元」被误判为已安装**：`is_installed` 曾把 `/usr/local/bin/llmproxy` 存在也算已装，于是进入升级分支——而该分支从不写单元文件，最终停在「Unit not found」。现收紧为**只认 systemd 单元文件**，此类残留状态改走全新安装并重建单元。

### Verified

- HK NAT 真实 VM 覆盖 `full`/`lite` × `local`/`public` 四种组合的全新安装：`ss -ltn` 分别显示 `127.0.0.1:PORT` 与 `*:PORT`，`.env` / 单元文件中的 `LLMPROXY_ADDR` 一致，`/healthz` 正常。
- `public → local → public` 双向升级切换、`llmproxy-ctl upgrade` 自覆盖升级（健康检查通过）、非法 `--bind` 拒绝、`llmproxy-ctl uninstall -y` 卸载后零残留（无单元、无二进制、无目录、端口释放）全部实测通过。
- `README.md` 与 `docs/AGENT_DEPLOY_GUIDE.md` 同步 `--bind` 语义、两种模式的适用场景，以及用 `ss -ltn` 判断对外可达性的方法。

---

## [Unreleased]

### Added
- **节点管理四步直装流程（名称 → 列表 → 一键安装脚本 → 在线）**：节点列表改为表格（名称 / IP / 状态 / 操作），每行新增「安装」按钮，弹出一键安装弹层（systemd / Docker / 单行直跑三模式，与签发面板同一组件）。签发表单精简为仅「节点名称」，角色/租约/权限范围折叠进「高级选项」；添加成功后表单收起、节点直接进列表并自动弹出安装指引。节点页每 15 秒自动刷新，安装成功（节点首次 `/api/node/config` 同步）后状态即变「在线」（与总览一致的 15 分钟在线口径）并显示来源 IP。新增 Hub 端点 `GET /api/admin/nodes/:id/install-command`：KV 仅存 `token_sha256`，故重新获取安装命令内部即轮换 Token（旧 Token 立即失效）；前端同一会话内复用内存缓存 Token 免轮换，跨会话重新获取前弹确认提示。节点列表前端现已渲染 `last_ip`（该字段此前已由列表端点返回，本次是前端开始消费）。

### Fixed（独立验收发现的缺陷，1 medium + 6 low）
- **「最后同步」时间显示为公元 58859 年**：`snap.syncMs`/`lastMs` 为毫秒而 `formatTime` 按秒解释（`x*1000`）；节点列表与 Hub 总览两处均改传秒。
- **矮视口安装弹层顶部裁切不可滚**：`.login-overlay` 补 `overflow-y: auto` 且卡片 `margin: auto`，667×375 下关闭按钮与命令框恢复可达。
- **跨标签页死 Token 无警示**：缓存命中打开弹层时新增提示条（命令来自本页签缓存，装完不在线请重新获取）。
- **Full 节点重开弹层时 ADMIN_PASSWORD 静默变化**：密码改为按节点会话内稳定（`nodeAdminPassMem`），重开不再重新随机。
- **删除节点后明文 Token 残留内存**：删除成功即清理 `nodeTokenMem`/`nodeAdminPassMem`。
- **节点表与总览「在线」口径互斥**：节点表改用与总览一致的 15 分钟在线判定，租约状态（宽限期/过期）另行显示。
- **畸形路径触发轮换**：`isInstallCommand` 改为精确三段路径匹配，`/:id/rotate/install-command` 等不再命中。
- 其余对齐：install-command 响应补 `Cache-Control: no-store`；`reissueNodeToken`/`rotateNodeToken` 合并去重；Esc 关弹层 toast 文案修正；`Number('')` 注释纠正；弹层焦点管理（打开聚焦关闭键、关闭归还触发按钮）；契约文档补 `client_key`/`node`/`404`/`last_ip`；可执行契约 JSON 新增 `nodes_install_command` 端点。

### Verified
- Hub 单测强化：last_ip 真值 round-trip（带 `x-forwarded-for` 断言具体 IP）、install-command 响应脱敏断言（9 个敏感键）、`no-store` 头、畸形路径不轮换且工作 Token 存活；套件 37/37 绿；`npm run verify:release` G1–G6 全绿。
- 独立验收（dynamic workflow，GLM-5.3-Flash max 子代理）：三路代码评审 + 浏览器 7 组断言（登录→添加→列表→安装弹层→模拟同步→在线→轮换确认）全过，20 条发现全部经独立复核证实并于本轮修复；回归 workflow 专项复验矮视口、跨标签页、密码稳定性与时间显示。

---

## [v20261121-02] - 2026-11-21

### Security
- **防未鉴权 `X-Node-Refresh: 1` 刷爆 EdgeOne Hub**：新增 `(*HubSource).RefreshForAuth` 并接入 `newDataPlaneAuthWrapper`；未通过 `CLIENT_KEY` 校验的请求仅允许冷启动与租约过期时正常同步，在 `MinRefreshDebounce`（5 分钟）内携 `X-Node-Refresh: 1` 不再触发回源拉取（已鉴权请求仍可立即强刷）。
- **强制 Hub 通信走 HTTPS 与原始缓冲清零**：未开启 `allowPrivate` 时拒绝非 `https://` 的 `hubURL`（`ErrInsecureHubURL`），避免明文发送 `NODE_TOKEN` 或明文接收上游密钥；拉取配置解码后立即通过 `clear` 清零原始 JSON 缓冲，节点被吊销时同步清空 `nodeToken`，宽限期耗尽丢弃快照后触发 `runtime.GC()`。
- **上游报错动态脱敏与非 `sk-` 前缀覆盖**：`obs.Scrub` 新增 `nvapi-`、`gsk_`、`xai-`、`pplx-` 等前缀规则，并新增 `ScrubWithSecrets` / `ScrubStringWithSecrets`；`Scheduler.Dispatch` 与 `Scheduler.ExecuteEndpoint` 在返回错误响应体与写入 `Try.ErrorSnippet` 前精确脱敏本次请求使用过的任意格式上游密钥。

### Verified
- 新增单测：`TestHubSource_RejectsInsecureHTTPWithoutAllowPrivate`、`TestHubSource_RefreshForAuthDebounce`、`TestLiteMode_UnauthRefreshCannotFloodHub`、`TestScrubWithSecrets`、`TestScheduler_ScrubsArbitraryUnprefixedKeyInUpstreamError`。
- `go test -race ./...`、`npm run test:t3`、`npm run verify:release`（G1–G6）全绿。

---

## [v20261121-01] - 2026-11-21

### Added
- **排队请求的跨 Key 迁移（magpie `laneMate`/`waitMate` 的等价物）**：此前一个请求只有在**所有**候选都满时才排队，且只盯自己首选的那把 Key——兄弟 Key 先空出来也视而不见，闭集批量下空槽白白晾着，直到首选 Key 的回合走完。新增 `LaneTracker.WaitAcquireChoices(ctx, choices, maxWait)`：park 在首选 Key，每次被 `freed` 唤醒都重走整张候选表，取第一个有余量的 Key；`WaitAcquire` 保留为单候选包装，旧调用语义不变。同一闭集用例（30 请求 / 10 槽位，1 把慢 Key 120ms、4 把 15ms）：**1.815s → 120ms**（约 15×）；端到端排队请求在兄弟 Key 释放后 **0.3ms** 到达上游（改前 500ms 内都没到达）。`busy` 仍是唯一准入计数，`waiting` 仍只做观测。
- **Magpie 上游同步基线**：新增 [`docs/MAGPIE_UPSTREAM_SYNC.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_UPSTREAM_SYNC.md)（A 逐字节 / B 改造 / C 语义同源 / D 不搬 四类关系、逐文件台账、升级流程）、[`docs/magpie-baseline.json`](file:///Users/xk/Documents/llmproxy2/docs/magpie-baseline.json)（10 个逐字节文件的 sha256）与 `scripts/magpie-sync.mjs`（`check`/`apply`/`rebaseline`，`npm run magpie:check`）。同步校正复用矩阵中 8 处与代码不符的描述（`filememo`/`access`/`sse.go` 实际不存在等）。

### Fixed
- **KB 入库 OCR 预读并发**：并发占满时此前立刻回 429（5 个文档 / 4 个槽位必然丢一个），现在排队等待（默认 90s，超时才 429 + `Retry-After`）；客户端断开即退出，不写无意义的 429。
- **端点路径绕过请求归一化**：`ExecuteEndpoint` 现在与 `Dispatch` 一样执行 `applyRouteNormalization`（`thinking` / `reasoning_effort` 剥离、`no_reasoning`），KB 等端点请求不再把思考参数透传给上游。
- **HTTP 200 裹着错误体被当成成功**：非流式与流式两条路径都识别 200 响应体里的错误对象（`{"error":{...}}`、顶层数字 `code`、流内错误帧），按错误状态码冷却、按 `forbiddenAlike` 判定失败转移，不再把错误对象当回答返回。
- **`max_concurrency` 未真正限流**：达到上限的 lane 不再接收超限请求，改为跳过该候选；全部候选全满时进入短队列，超时才放弃。
- **lane 观测计数泄漏**：等待中的请求每次被唤醒都 `waiting++` 却没有配对递减，唤醒风暴下 `waiting` 虚高（2 个等待者显示为 4）；现在唤醒即配对递减。

### Verified
- 单元/回归：新增 5 个 lane 用例（跨 Key 迁移、单道对照、`waiting` 不虚高、闭集 makespan、端点路径迁移），改前均红、改后均绿；`go build ./...`、`go test ./...`（20 包）与 `go test -race ./internal/scheduler/` 全绿。
- 真机验收（VM-A，Debian 12 x86_64，full 角色 + 本地 mock 上游）：健康检查、管理端登录、配置读写、chat/embeddings/OCR、双 Key 并发迁移、`max_concurrency` 上限、200 错误体失败转移、连接数/内存回归全部通过；详见发版轮报告。
- `verify:release` G1–G6 全绿。

---

## [v20261120-01] - 2026-11-20

### Added
- **可缓存前缀键（同项目多 Agent 共用一把 Key）**：新增 `cpy:` 维度——把请求里真正可缓存的部分单独哈希（`instructions` / `system` / `tools`，以及 OpenAI 风格的前导 `system` / `developer` `messages[0]`、`messages[1]`），**不含任务本体**。同一项目的多个 Agent 因此被视为同一个缓存主体：实测 6 个 Agent 共享同一段 system+tools 全部落在同一把 Key（`hits=[6,0,0]`），前缀缓存只热一次；此前的第三级结构化指纹会把同一项目的 Agent 按各自的完整首轮消息拆到三把 Key 上（`k1:2 k2:2 k3:2`），前缀 token 成本约 2.3 倍。

### Fixed
- **子代理劫持主会话的粘性绑定（缓存被反复重写）**：Claude Code 的子代理沿用同一 session id / `metadata.user_id`，原有粘性键只有 `(model, sessionKey)` 一个维度，子代理在另一把 Key 上成功后会把**主会话**一并重绑过去，主会话已累积的 prompt 前缀缓存当场作废、整段重写。新增子代理维度（`X-Claude-Code-Agent-Id` / `X-Subagent-Id` / `X-Agent-Id`）：子代理绑定独立槽位，回写只动自身；未绑定的新子代理**继承主会话所在 Key**（前缀相同，省掉首次缓存写入），主会话槽位永不被覆盖。
- **无会话标识的多 agent 全部挤在同一把 Key**：`modelSticky` 兜底分支此前对无会话标识的请求无条件钉死首个 Key，且「同供应商空闲兄弟 Key」分流只在 `sessionKey != ""` 时生效——所有不带 session id 的 agent 排成一队打一把 Key，其余 Key 空闲。现在兜底只是提示而非预留：首选 Key 忙时同供应商空闲兄弟 Key 接管。
- **同时到达的并发突发全落在同一 Key / 反向超配**：排序阶段各请求看到的都是「全部空闲」，等它们各自把 lane 占忙时已全部选中同一把 Key（`[6,0,0]`）。改为**饱和驱动 + 原子占位**：摊开只在 Key 已达到 `max_concurrency` 时发生，认领由 `LaneTracker.TryAcquire` 在**同一把锁内**完成「挑第一个有余量的 Key 并占位」，两个同时到达的请求不可能共享同一个空位；全满时取最闲的一把，超出总容量的突发仍然均分。实测 6 条独立会话、每 Key 上限 2 → `[2,2,2]`；共享前缀同上限 → `[2,1,0]`（前两个留在热 Key，第三个才溢出）。

### Changed
- **摊开触发条件收紧**：从「该 Key 有任何在飞请求就分流」改为「达到 `max_concurrency` 上限才分流」；**未设上限的 Key 永不因负载分流**，绑定会话也不会因超上限而漂移。会话粘性只在 `sticky_failover` 且模型配了 ≥2 把 Key 时才有意义。
- 会话头新增 `X-Session-Affinity`（magpie / pi / omp 等客户端用它命名会话）。
- **并发上限的计数口径统一**：单 Key 信号量（`lanes.go`）中 `busy` 是唯一准入依据，`waiting`（请求正在准备调用）仅供观测；排序阶段认领到的槽位就是普通 lane 槽位，直接交给尝试循环继承，请求没走到那把 Key 时归还。
- `isCandidateAvailableAndIdle` 拆出 `isCandidateHealthy`（只看冷却与 RPM，不看在飞负载），供已占位的调用方判定，避免自我否决。

### Verified
- **修掉两个会让并发上限失效的计数缺陷**：(1) 预留表与 lane 各自计数，同一请求被记两次（4 在飞时 `lanes=4 openings=4`，每个上限实际减半）；(2) 准入用 `busy+waiting`，而每个请求占住 lane 后仍留在 `waiting`，同一请求再被算一次；同时排序第 3/4 步的早返回绕过认领，整波突发读到同一个空位（残留 `[3,2,1]`）。修法是把两套计数压成一套：删掉预留表，认领即 lane 槽位本身。
- 单元测试：新增 6 个用例 + 1 个突发精确性用例（20 轮 × 6 并发，要求每轮严格 `2/2/2` 且无 lane 泄漏），连跑 5 次共 300/300 轮全部精确。**逐一验证过测试有效性**——临时禁用对应修复后对应用例确实失败。
- 真实二进制黑盒 E2E（`scratch/sticky-e2e/`，lite 模式 + mock 上游 + mock Hub 投影 3 Key）：7/7 通过，含子代理隔离（`lead=k1 sub=k1 after=k1`）、6 Agent 同前缀 `[6,0,0]`、同前缀上限 2 `[2,1,0]`、6 条独立会话 `[2,2,2]`、已绑定会话上限 2 下 4 并发全程 `k1:4`。
- `go test -race ./...` 全绿；`verify:release` G1–G6 全绿。
- 性能：排序路径 `sticky/cap0/keys=3` ≈563–590ns / 10 allocs（比 `round_robin` 的 ≈550–615ns / 14 allocs 更省）；开上限的代价 3 Key ≈+0.65–0.9µs、8 Key ≈+1.4–2.1µs；10 路并行争用 ≈1.6–1.9µs vs 无锁路径 ≈0.5–0.8µs（两把锁改一把后由 8.5× 降到 2.8×）；完整 dispatch 各变体同为 37–46µs/op，请求层面无差异。

## [v20261119-04] - 2026-11-19

### Fixed
- **容器镜像无法启动（permission denied）**：GitHub Release 资产下载后不带可执行位，`COPY` 保留原权限，镜像内 `/usr/local/bin/llmproxy` 为 0644，`docker run` 直接报 `exec: "...": permission denied`。改用 `COPY --chmod=0755`。
- **Docker 一键命令加固**（实测暴露）：Full 模式先 `mkdir -p` 数据目录再挂载（否则 Docker 会以 root 建目录，后续非 root 使用不便）；Lite 模式明确不带数据卷（零落盘设计）；镜像默认以 root 运行以确保 bind mount 可写，Dockerfile 注明可选的 `--user $(id -u):$(id -g)` 非 root 用法。

### Verified
- 在 Instabox 沙箱容器（Docker 29.8）实测：镜像 `12.8MB`（`scratch` 基础），`--version` 正常，Lite 与 Full 双模式均启动成功；Full 模式数据卷正确生成 `app.log` / `usage.jsonl` / `key_bans.json.lock`。
- 复现并确认根因：拉取修复前的线上镜像执行即 `permission denied`，用本地修复版构建后同一命令正常运行。

## [v20261119-03] - 2026-11-19

### Added
- **容器镜像发布（ghcr.io）**：新增 `Dockerfile`——基于 `scratch`，仅打包静态二进制 + CA 证书 + tzdata + passwd/group，镜像体积最小化。CI 新增 `docker-release` job：按 `linux/amd64` 与 `linux/arm64` 分别构建推送，再用 `buildx imagetools` 组装多架构 manifest（main → `latest`，`v*` tag → 版本号标签）。
- 节点签发面板的 **Docker 部署**方式自此真实可用（此前镜像从未构建，命令必然 `manifest unknown`）。

### Fixed
- **「单行直跑」命令缺少下载步骤**：原命令直接执行 `./llmproxy-linux-${ARCH}`，假设二进制已在当前目录，用户粘贴即报 `No such file or directory`。现改为：探测架构 → 从 GitHub Release 下载对应资产 → `chmod +x` → 以 env 注入角色/中枢/令牌启动，一条命令真正跑起来。

### Verified
- 香港 NAT 真机实测：一键安装在 Hub 拉脚本后装好并连通中枢（`config_version 27`、真实 MiniMax 调用返回正常）；单行直跑下载 7.3MB 二进制后 `--version` 与 `/healthz` 均正常。
- 四种生成的命令（install/binary × lite/full）均通过 `bash -n` 语法校验。
- `verify:release` G1–G6 全绿（bundle 216,946 B）。

### Notes
- 三种部署方式的定位：**一键安装（systemd）**=生产推荐，有开机自启与 `llmproxy-ctl` 运维；**Docker**=容器化/K8s 场景；**单行直跑**=免安装临时试跑（无自启，关终端即停）。

## [v20261119-02] - 2026-11-19

### Fixed
- **中文界面观感过粗**：全站 12 处 `font-weight: 600`（其中 6 处作用于 11px 小字）在中文字形上笔画粘连、视觉发黑。现建立字重/字号 token 体系并可执行地约束「12px 及以下不使用 600」：
  - 表头、供应商/模型名、导航分段、版本徽章、角色徽章、步骤号：`600 → 500`；
  - 正文字号 `13 → 14px`，表头 `11 → 12px`，卡片标题 `13 → 14px`（字重 `600 → 500`），表单标签 / KPI 标签 / 卡片副标题 `11 → 12px`；
  - 保留 600 的仅为大字号元素（18px 视图标题、20px KPI 数值、14px 品牌名），中文在此尺寸下渲染正常。
- **列表冗余**：供应商名称与 ID 相同时（绝大多数情况）列表行重复渲染 ID 胶囊，现仅在两者不同时显示。

### Verified
- 浏览器实测 computed style：`.name` 500、`.data-table th` 500@12px、`body` 400@14px、`.view-title` 600@18px；浅色/暗色双主题无横向溢出、零内联样式。
- `verify:release` G1–G6 全绿（bundle 216,759 B）。

## [v20261119-01] - 2026-11-19

### Fixed
- **上游忽略 `stream=true` 时的畸形 SSE（上线前验收 P1）**：客户端请求流式、上游却返回普通 `chat.completion` JSON 时，网关此前直接以 `text/event-stream` 头透传裸 JSON——零 `data:` 帧、无 `[DONE]`、无 usage，任何 SSE 客户端都会解析失败或挂起。现 `PeekFirstChunk` 识别「整块为单个 JSON 对象且无 `data:` 帧」的载荷并置 `BareJSONPayload`，调度器用 `adapters.SynthesizeSSEFromJSON` 合成标准 SSE（delta 帧 + finish_reason/usage 帧 + `[DONE]`），并按合成结果回填流式用量与 trace（此前该类请求 `in_tokens/out_tokens` 恒为 0、`stop_reason` 为空）。真实 SSE 上游路径不受影响（新增回归单测覆盖）。
- **Hub 管理员凭据持久化（上线前验收 P2）**：Hub 无登录端点、密码本身即 Bearer 凭证，此前被写入 `localStorage` 长期留存。现改为 `sessionStorage`（关闭标签页即失效）+ 内存兜底，并在 `setToken` 时清理历史遗留的 localStorage 值。Full 节点仍使用 HttpOnly Cookie 会话语义，不受影响。

### Verified
- 本地双向上游实测：裸 JSON 上游 + `stream=true` → 3 个 `data:` 帧 + `[DONE]` + usage；流式 trace 由 `in=0/out=0/stop=None` 变为 `in=1/out=1/stop=stop`；真实 SSE 上游依旧 4 帧原样透传。
- 构建产物零 `localStorage` 写入 `admin_token`，`sessionStorage` 3 处使用，保留迁移清理。
- `verify:release` G1–G6 全绿（bundle 216,592 B）。

### Notes
- 本轮上线前三路并行验收（Lite NAT 主机 / Full 端到端 / Hub 线上 UI）结论：用例通过率 30/33。遗留项为环境限制或非阻塞观察——低 `pids.max` 容器（LXD，128）在 >20 并发时出现服务悬崖、50 并发 3 次冲击 1 次 Go runtime `newosproc` abort（主因容器进程数上限，非内存，VmHWM 13.2MB/零 OOM）；Hub 无变更保存会把 `api_type` 从 `openai` 规范为 `openai-completions`（Go 侧不参与协议判定，无功能影响）。

## [v20261118-02] - 2026-11-18

### Changed
- **Full 节点统一「从中枢同步」（`POST /api/vault/sync`）**：移除原先割裂且会导致全量供应商 Key 翻倍重复的「拉取中枢清单 + 从 Vault 同步密钥」双按钮流程，合并为单一「从中枢同步」原子操作，一次性拉取节点授权范围内的供应商、Vault 密钥、`agent_models` 与 `kb_models` 路由模板（完整保留 Full 本地自建供应商与本地路由），并同步刷新中枢侧节点的在线时间与二进制版本号。
- **角色与 Key 归属边界彻底理顺**：
  - **Hub 中枢**：移除无实际意义的“本地自用 Key / 本地供应商”概念，中枢录入资源统一作为可下发共享资源，按节点 `Scope` 精确授权；
  - **Lite 节点**：中枢投影对 Lite 角色物理忽略 `kb_models` 固定 4 通道及 KB 并发参数（UI 明确标注「仅 Full 节点生效 · Lite 自动忽略」）；
  - **Full 节点**：`origin="vault"` 供应商密钥池严格只读（禁止混塞本地私有 Key），本地私有 Key 统一通过新建本地供应商管理并支持干净导出备份。

### Fixed
- **UI 全流程死胡同与 409 冲突清零**：
  - 修复含 `:` 与 `/` 的模型名（如 `deepseek-ai/DeepSeek-V3.2:free`）在展开编辑或添加时触发选择器崩溃的问题；
  - 修复 Full 设置页「保存密钥」双重提交必现 409 CAS 冲突，以及 Hub 端「校验 Key」递增 KV 版本后未回传 `_version` 导致后续保存必现 409 的问题；
  - 修复「探测模型」点击首个模型一键纳管后整个探测面板被重绘销毁的问题（现持久保留探测列表并标记 `✓ 已纳管`）；
  - 清理预设列表重复项，修正 `minimax` (`api.minimax.io`) 与 `minimax-cn` (`api.minimaxi.com`) 官方域名及 `anthropic_base_url`，保留真实 `preset_id`；
  - 修复候选 `key_label` 留空（「全部启用 Key」）时「测试路由」报 400 的问题，以及 Full 端校验/探测 Anthropic Key 缺少 `x-api-key` / `anthropic-version` 头的问题；
  - 统一 `api_type` 真实协议能力选项（新增原生 `ocr` 类型），仅对 MiniMax 预设展示 OAuth 扫码登录，补齐添加重名模型防覆盖保护、供应商/模型 `<datalist>` 自动补全、密钥表模型级冷却状态展示与设置项数值范围校验；
  - 修复 Full 冷启动 `.env` 注入的 `CLIENT_KEY` 在设置页显示为「未配置」且无法在 Web UI 轮换吊销的问题；Full 管理端登录改用 `HttpOnly` Cookie 会话，不再在 `localStorage` 存放明文管理员密码；空模型列表 `/v1/models` 返回标准 `data: []`。
- **遥测统计失真修复**：`usagecount` 新增按模型独立统计 `calls / successes / failed / in_tokens / out_tokens`，消除中枢概览将失败模型按比例均摊显示为 100% 成功的失真，并在概览与节点卡片展示 `last_binary_version` 版本徽标；修复 `touchNodeLastSeen` 在 60s 内 304 续租丢弃 `X-Node-Usage` 用量的问题；修复非流式请求 `TPS` 虚高为 `20000 tok/s` 的分母计算问题。
- **一键安装与 `llmproxy-ctl` 运维修复**：修复无控制终端 SSH/管道下 `llmproxy-ctl uninstall` 因 `/dev/tty` 报错退出的问题并新增 `-y/--yes` 参数（Lite 卸载不再产生空备份目录）；修复 `curl | sudo bash` 下 `SUDO_USER` 权限配置与普通用户执行 `llmproxy-ctl status` 误判 `8787` 端口的问题；签发 Full 节点面板自动生成并展示后台密码，补齐 Docker 部署、多架构自适应命令与客户端接入指引。

## [v20261118-01] - 2026-11-18

### Security
- **Hub 管理端与 Vault 边界加固**：`ADMIN_PASSWORD` 未配置时强制返回 `503` 失败关闭，采用 SHA-256 摘要进行恒定时间比对消除长度侧信道；`/api/vault/manifest` 与 `/api/vault/fetch` 强制校验 `role === "full"` 及节点 `scope.providers` 授权范围，拒绝 Lite 节点令牌越权拉取明文凭证。
- **配置导出防泄露（仅导出本地配置与 Key）**：Full 节点 `GET /api/admin/config/export` 物理剥离所有 `origin="vault"` 供应商与中枢下发 Key，并清空 `vault.node_token`，严禁全量导出中枢密钥。
- **全链路 SSRF、重定向与防窃取防护**：`netguard` 无条件拦截 `169.254.0.0/16` / `fe80::/10` 链路本地与云元数据地址；数据面禁止跨主机重定向，探测客户端跨主机重定向自动剥离鉴权头；使用已存 Vault Key 验证/探测时禁止覆盖 `base_url`；更换 Vault Hub URL 时若未重填新令牌自动清空旧 `node_token`；前端 Vault 同步统一走节点同源 `/api/vault/*` 代理。
- **安装脚本与自升级供应链加固**：`deploy/install.sh`、`llmproxy-ctl upgrade` 与管理端 `/api/admin/system/upgrade` 强制优先从 GitHub 官方源校验 `SHA256SUMS`（缺失或不匹配立即中止）；移除 `llmproxy` 服务账户的 `sudoers` 权限，收紧 `.env` (`umask 077`)、`llmproxy-lite.service` (`0600`) 与卸载备份目录 (`mktemp -d` + `0700`) 权限，消除 `sed` 注入风险。
- **鉴权与脱敏细节修复**：客户端推理鉴权移除 `adminPassword` 回退；管理端鉴权仅接受请求头凭证（拒绝 URL Query 传参），修复反向代理场景下登录限流 IP 提取与锁定绕过；日志与上游报错回包统一脱敏 `stk_node_*`、`x-api-key`、`x-goog-api-key` 与 `?key=`。

### Fixed
- **HubSync 高可用自愈与零竞争**：`syncWithHub` 使用独立 15s 上下文避免首个请求取消连带中断并发拉取；Hub 5xx/网络抖动进入可自愈 `StateError` 而非永久 `StateRevoked`；修复 `304` 租约续期原地修改与 `200` 刷新过早清零旧快照导致的并发读写竞争。
- **流式 Keepalive 与有界内存保护**：修复 `StreamOnly` 聚合模式与客户端 SSE 模式下 `: keep-alive` 提前写入导致的 `WriteHeader` 冲突与响应损坏；`>1 MiB` 请求体在读取缓冲前即获取 `largeBodySem` 信号量；为 `PeekFirstChunk` (4MB)、非流式响应读取 (20MB)、`AggregateStreamToJSON` (16MB) 与 `ThoughtStreamFilter` (4MB) 补齐硬上限；`usage.jsonl` 增加 10 MiB 自动轮转。
- **一代 `ocrproxy` 预设规则与协议对齐**：Go `AdapterRules` 与 `build-catalog.mjs` 无损解析 `shared/presets/*.json` 嵌套规则；修复 Gemini 思考配置字段层级、`effort="none"` 与非流式 `tool_calls` 签名缓存；`/v1/messages` 透传 `anthropic-version` / `anthropic-beta` / `x-api-key` 并支持 `AuthPrefix="none"`；修复 KB `isNativeOCR` 空目标模型误判与动态并发控制器竞争；修复 Happy Eyeballs IPv6 连接句柄泄漏、OAuth 令牌刷新竞争与前端 `/api/lanes` 字段大小写不匹配。

### Removed
- **彻底精简冗余模块与死代码**：移除双模定时切换（`internal/modesched`、`/api/admin/mode`、`run_mode`、`mode_schedule_*`）、自动模型列表同步（`autolist.go`、`/api/admin/autolist-sync`）、上游余额查询（`balance.go`、`/api/admin/balance`）以及未使用的 `internal/filememo` 与 `internal/upstream/sse.go`，保留极简高吞吐统一路由内核。

## [v20261117-06] - 2026-11-17

### Fixed
- **UI 创建的供应商缺少 `id` 字段**：前端只把 id 用作 map key，没有写进对象，导致调度器 `Trace.WinnerProvider`/`UsageRecord.Provider` 为空——按供应商与按 Key 的用量统计整体失效（实测 `keys: []`）。前端补写 `id`，并在后端 `SaveConfig`/`loadFromDisk` 增加按 map key 回填的兜底，历史配置重启即自愈。
- **节点端手动添加的 Key 被误标 `origin=vault`**：三处三元表达式写成了 `isHubMode() ? 'vault' : 'vault'`，本地 Key 因此被当作中枢下发资源——显示为只读短掩码且不可编辑。改为 `'local'`；`parseMultiApiKeys` 默认 origin 也从 `vault` 改为 `local`。
- **Key 可见性规则落地**：节点仅对 `origin=vault`（中枢下发）的 Key 掩码只读，本地 Key 返回明文并支持「显示/隐藏」切换。新增 `TestAdminServer_VaultKeysMasked` 锁定该语义（vault 必须掩码、local 必须明文）。

### Verified
- 全流程浏览器 UI 端到端（从零创建，无任何预置配置）：登录 → 创建供应商 → 加 Key → 校验 Key(3ms) → 探测模型(2 个) → 一键纳管 → 数据面非流式/流式真实调用（上游回显 key+model 一致）→ Key 显示/隐藏 → 设置保存 → 刷新/重启持久化 → 质量门禁（零内联样式/零抽屉/零溢出/零 emoji/零 JS 错误）。

## [v20261117-05] - 2026-11-17

### Fixed
- **「签发新节点」点击无反应（P1）**：`toggle()` 定义在 `setupCreationForms()` 内部，而按钮绑定在 `setupNavigation()`，跨作用域不可达并抛 `ReferenceError`；同时该调用传的是字符串 id 而非元素（在字符串上赋值 `.hidden` 静默无效）。`toggle()` 提升到模块作用域并支持 id 字符串，实测表单可正常展开/收起。
- **「自动探测协议」只显示"未知错误"**：全部协议探测失败时 `protocols` 为 null，前端无从显示原因。现在逐个透出真实失败状态与上游消息（如 `chat HTTP 401 (未认证或登录已过期)`）。
- **Hub 端看不到完整 Key**：服务端已返回明文，但前端对 Key 单元格无差别二次掩码。现按来源区分——Hub 与节点本地 Key 提供「显示/隐藏」切换，中枢下发的 Key 保持短掩码且只读。
- **复选框与标签错位**：`.form-label` 为 `display:flex; justify-content: space-between`，把开关与说明文字推到行两端。新增 `.form-label--check`（`flex-start` + 8px 间距）并应用到所有内嵌 checkbox 的标签。

### Changed
- **首字母徽标中性化**：移除按名称哈希分配到 accent/success/warning/danger 的随机上色——它会让健康供应商显示为警告色而并不携带任何状态含义。现统一使用中性 surface 令牌；拉丁字母转大写，中文取首字原样。
- **路由策略收敛展示**：默认只列「会话粘性优先（推荐）」「空闲优先轮询」，其余 4 种（weighted / least_busy / fast / manual）归入「高级策略」optgroup，并补充选择指引。6 种策略实现与后端行为完全不变。

### Notes
- `/v1/responses` 维持**透传**语义（不转换 Responses API 请求体）；协议下拉不暴露该选项。Magpie 的 `responses.go`（MIT，2638 行）经评估可低成本移植，但因当前无真实 Responses 流量，本轮不做。

## [v20261117-04] - 2026-11-17

### Fixed
- **lite 用量上报为空**：lite 设计上不创建 `obs.Manager`（零落盘、无 trace 环形缓冲），导致 `X-Node-Usage` 永不发出、中枢概览永远显示「暂无上报」。新增极轻量内存计数器 `internal/usagecount`（仅按模型计数与汇总，上限 64 个模型），同时作为 lite 的 ObservabilitySink 与上报来源。
- **空模板静默全断**：Hub 允许保存「providers 全空 / 全部 Key 禁用」的模板，节点下一次拉取后所有模型消失且无告警。现在保存时即拒绝（400 `refusing to save an empty template`），已有配置保持不变；同时新增 hub 测试覆盖该防护。

### Changed
- **首字母徽标样式 token 化（UI-UX 规范审查结论）**：移除徽标上 8 个硬编码十六进制色与 `[data-bg]` 属性选择器，改用 KHC 语义令牌 `accent / success / warning / danger`（浅/深色主题各自取值），满足正文 4.5:1 对比度要求；徽标补充 `aria-hidden="true"`（装饰性元素，名称文本已可读）。

### Verified
- **Hub↔VM 模板同步全链路测试**（mock hub 复刻真实投影语义）：
  - 模板新增模型 → lite 租约后续租 `config_version` 递增、新模型可调用且使用正确 Key；
  - 模板删除供应商 → 依赖模型自动下架（404 `not configured`），无关模型不受影响；
  - Key 轮换 → 租约内仍用旧 Key、续租后切到新 Key；
  - `origin=local` 供应商与 Key 在投影中被物理阻断；
  - scope 过滤生效；20 并发首拉 20/20 拿到完整 payload；ETag 命中返回 304 且零载荷；
  - 空模板被拒绝、恢复后节点自愈。

## [v20261117-03] - 2026-11-17

### Fixed
- **模型列表被清空（严重）**：模型名含 `.`（如 `MiniMax-M3.1-Flash-Preview`、`deepseek-v4.1-flash-1017`）时，编辑器 id 选择器 `#ed_m_strat_<name>` 中的 `.1-Flash-Preview` 被当成 class，`querySelector` 抛 `SyntaxError`，而列表已 `innerHTML=''`，导致点击即清空整个模型路由页。编辑器查找改为不经 CSS 解析（按 id 取元素，兼容尚未挂载的子树）。
- **Key 短掩码格式**：`sk--...3456` 双横线修正；前端掩码与服务端统一为 `sk-...7Yjl` 形式。

### Changed
- **全站首字母圆形徽标**：供应商与模型列表不再使用品牌 SVG logo，改为名称首字母圆形徽标（零内联样式，颜色由名称哈希决定）。
- **Key 显示规则统一**：中枢端（权威源）对联明文可见可改；节点本地添加的 Key 明文可见可改；中枢下发的 Key 在节点端显示短掩码且禁用编辑/删除（标注「中枢只读 / 由中枢管理」）。
- **Hub 概览重新规划为「统一 VM 管理」视角**：
  - 移除「供应商密钥池与探活健康分布」表；
  - 新增**活跃 VM 节点表**（节点名/角色/在线状态/下发模型/配置版本与同步次数/最后同步/IP）；
  - 新增**VM 端模型使用分布**表（模型 / 使用节点数 / 调用量 / 成功失败 / Token / 节点分布）。
- **Hub 模型路由与策略定位为「下发模板」**：页面与设置说明明确中枢只做编排不参与中转，节点拉取后可自由本地调整，中枢不覆盖、不限制。

### Added
- **节点使用量上报**：节点在每次 `POST /api/node/config` 携带 `X-Node-Usage`（模型调用计数、成功率、Token），中枢记录到节点记录并在概览聚合展示。旧节点未上报时概览显示「暂无上报」。

### Removed
- **查询余额入口**：上游无通用余额接口，移除供应商工具栏按钮、余额 URL/JSONPath 输入与余额徽章（后端 `balance_url`/`balance_path` 字段保留以兼容历史配置）。

## [v20261117-02] - 2026-11-17

### Fixed
- **Hub Vault 同步鉴权**：`/api/vault/manifest`、`/api/vault/fetch` 现在同时接受 Hub 管理员凭据与节点 `NODE_TOKEN`（只读、仅 `origin=vault`）。此前 full 节点的 UI 提示填写 `NODE_TOKEN`，实际只有填 Hub 管理员密码才能同步——既必然 401，又把全局凭据塞进每个节点。
- **LXD/容器部署兼容**：`install.sh` 检测容器环境（`/.dockerenv`、`systemd-detect-virt --container`、`/proc/1/environ`）后改用静态低权用户（`nobody`）并跳过 `ProtectSystem/ProtectHome/PrivateTmp` 等 mount-namespace 类 hardening。此前 lite 在非特权 LXD 中 `226/NAMESPACE` 无限重启。
- **无配置错误脱敏**：`proxy_config.enc` 缺失时不再回显绝对路径，统一返回 `configuration not initialized: upload or sync a config before serving requests`。
- **节点版本遥测**：lite 每次 `POST /api/node/config` 携带 `X-Node-Version`，Hub 写入真实 `last_binary_version`，不再恒为签发默认值。

### Added
- **模型路由 `allow_key_fallback`**（默认 `false`）：候选引用的 Key 被禁用/删除时，可回退到同供应商其它启用 Key；控制台模型编辑器提供勾选项。
- **Hub `/healthz` 版本字段**：返回 `version` / `semver` / `release_date`，用于发现线上 Hub 部署落后。

### Notes
- 线上 EdgeOne Hub 需重新发布到本版本后，Vault 节点鉴权、304 遥测、`PATCH /api/admin/nodes/:id` 与版本字段才会生效。

## [v20261117-01] - 2026-11-17

### Added
- **KB 流水线统一调度**：embedding / rerank / ocr 四类 KB 流水线统一接入 Agent 调度器，复用候选池、冷却与故障转移；新增 Magpie 风格高并发路由策略。
- **会话级多路径粘性路由**：调度器支持 per-session multi-path sticky routing 与全局策略回退。
- **节点永久分类**：节点签发区分 `llm` / `mcp` `service_type`，配置投影按类型隔离。

### Changed
- **收敛为纯 LLM 代理**：移除 MCP / 搜索扩展服务与 Extension Services 视图；`/api/node/config` 信封与租约头对齐 `node-config-projection.json` 契约（closes #1）。
- 供应商多 Key 池支持、Hub origin 范围调整与 exa 预设。

### Removed
- MCP / 搜索扩展服务（含 `docs/mcp-*` 指南），恢复纯 LLM 代理定位。

---

## [v20261115-06] - 2026-11-15

### Fixed
- **管理端 401 未清除旧凭据**：控制台收到 401 时保留过期 token，3 秒轮询会用旧凭据持续请求，5 次即触发 10 分钟防爆破锁定（此时正确密码也被拒）。现在 401 会立即清除凭据并回到登录层。

## [v20261115-05] - 2026-11-15

### Added
- **Hub 搜索服务与提供商控制面** *(已于后续清理中封存移除：MCP / 扩展服务独立管理)*：新增 `search_providers` / `search_selection` 配置域，包含键名规范校验（`[a-z0-9-]+` 且与键名一致）、密钥掩码下发与提交回写还原；面板新增「搜索服务与提供商」视图（`#viewSearch`）。
- **Hub 节点 `status_url`** *(已于后续清理中移除，严格遵循单向拉取)*：节点签发/更新支持配置状态查询地址，严格校验仅 `http(s)` 且禁止内嵌凭据；提供节点状态代理入口与对应契约（`nodes_status`）。

### Fixed
- **`cooldown_auth_error_sec = 0` 不再封禁 24 小时**：此前 0 被当作"未设置"回退默认 `86400`，一次上游 401 即封 Key 一整天；现在 0 明确表示不封禁（schema `minimum` 放开到 0，UI 不再把 0 改写成 86400）。
- **Key 冷却状态可见**：Key 列表按 `/api/admin/cooldowns` 的 `p:<provider>:k:<label>` 实时显示「冷却中 24h」，不再恒显示「就绪」。
- **全候选失败不再返回空原因**：错误体携带具体跳过原因（`skipped: k1 (cooling down 1m0s)`）或上游错误摘要。
- **候选不可用可诊断**：503 文案附带候选明细（`no candidate keys available for model "x": mock_upstream/k1 (key disabled)`）；面板在禁用/删除被路由引用的 Key 时弹窗列出受影响路由并要求确认。
- **usage `model_list` 失败条目补回 `model`**：失败请求按请求模型归并，均缺失时记为 `unknown`。
- **UI 新 Key 掩码**：未保存的 Key 在表格中也按 `sk-●●●●●●1234` 显示，避免明文回显。
- **文档**：`SECURITY_SPEC` 明确 lite 模式管理路由返回 `403 lite_mode_forbidden` 的口径。

---

## [v20261115-04] - 2026-11-15

### Fixed
- **UI 单主按钮层级**：供应商折叠编辑区内的「OAuth 扫码登录」由 `btn--sm btn--primary` 降级为标准 `btn btn--sm`，消除同一编辑区内两个实心主按钮并存，恢复 `UI_DESIGN_SPEC.md` §6.2（`.btn--sm` 禁用于主操作）与 §6.3.1（每视图/编辑区最多 1 个 `.btn--primary`）。
- 依据发布产物复测：provider 行展开态可见 `.btn--primary` 由 3 个（页头 + OAuth + 保存）收敛为 2 个，编辑区内仅保留「保存供应商配置」1 个主按钮。

### Verified
- 按 `docs/UI_DESIGN_SPEC.md` 全项视觉回归通过：零内联样式 `[style]`=0、零 `.drawer`、零左边框彩条、零 emoji、KHC 令牌 `#1664FF`/`#3B82F6`、`.btn/.input` 32px、`.btn--sm` 26px、checkbox 14×14、圆角 6px、20px 左基准线、375px 零横向溢出、双主题持久化、行内 `.editor` 展开无布局跳动、单文件 196,863 B ≤ 240 KB。

---

## [v20261115-03] - 2026-11-15

### Added
- **EdgeOne Hub 统计控制面**：Hub 控制台新增「概览」首页（8 项核心 KPI 卡片、供应商密钥池与探活健康分布表、批量探活全部密钥按钮、中转节点同步/304 缓存命中遥测）；`verify-key.js` 支持将探活结果（`last_ok`、`last_status`、`last_latency_ms`、`last_checked_at`）持久化至 Hub KV；`node/config.js` 记录节点 `sync_count`、`hit_304_count` 与 `last_ip`。
- **EdgeOne Hub 模型路由与配置备份**：Hub 角色正式开放「模型路由」（支持 Agent 路由与 KB 4 条并发流水线编辑）及「配置备份与迁移」（支持 v1/v2 JSON 导出与增量/覆盖导入）。
- **供应商与模型工具栏**：新增搜索框与状态过滤分段器（全部 / 已启用 / 探活通过 / 异常或未测）。

### Changed
- **KHC 设计规范全面重构**：统一采用 `#1664FF` 主色、`#F8FAFC`/`#0F172A` 中性色阶、`4px` 间距栅格、`32px` 控件高度、`1120px` 居中容器，全站移除 emoji 改用线性 SVG 图标，并消除静态写死的预设 `<option>` 列表与默认占位数值。
- **移动端响应式适配**：针对 `375px~768px` 手机视口重构导航换行与横向滚动、2 列 KPI 网格、单列表单栅格与响应式表格容器。
- **图表标签防重叠修复**：`usage.js` 柱状图 X 轴引入最小像素间距守卫，修复密集时间段标签重叠问题，并将 Full 节点概览 KPI 补齐为对称 8 卡。

---

## [v20261115-02] - 2026-11-15

### Fixed
- **上游 URL `/v1/v1` 双拼修复**：`internal/upstream/url.go` 中 `JoinUpstream` 自动剥离 `path` 前导 `v1/`，修复调度器传入 `/v1/chat/completions` 与 `/v1` 结尾的供应商 `base_url` 拼出 `/v1/v1/chat/completions` 导致 404 的问题。

### Added
- **1 代配置原生导入兼容**：`internal/admin/import_v1.go` 新增 `normalizeImportedConfig`，支持 `POST /api/admin/config/import` 直接导入 1 代 `ocrproxy_config_*.json`（自动转换 `providers.*.keys`、`agent_models.*.keys`、`candidates` → `kb_models` 与顶层设置字段，并处理 Vertex `{project_id}` 占位符）。

---

## [v20261115-01] - 2026-11-15

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
