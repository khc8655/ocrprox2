# Magpie 上游同步手册（Vendored Code & Upgrade Playbook）

> **一句话**：本仓与 `yetone/magpie` 有四种关系 —— **10 个文件是逐字节副本**、**3 个文件是搬运后改造**、**9 个模块是按上游语义自研**、**若干模块明确拒绝搬运**。上游一周 721 次提交、共 4,618 个 tag，所以本仓**不跟随主干**，只在「钉住基线 + 显式同步」的方式下取改动。
>
> **当前基线**：`18cfe278`（v0.1.4624，2026-11-21 核对）。
> 机器可读映射与哈希：[`docs/magpie-baseline.json`](./magpie-baseline.json)；一键核对：`node scripts/magpie-sync.mjs check`。

---

## 0. 这份文档为什么必须存在

上游 `yetone/magpie` 的节奏是**天更**（实测见 §2）。这带来两个后果：

1. **不能靠记忆维护复用关系。** 谁在什么时候从哪个上游文件抄了哪一段，必须写在仓库里，而不是散落在提交信息和聊天记录里。
2. **不能靠"跟主干"升级。** 直接 `go.mod` 依赖上游，会被它每天几十次提交拖着走；整文件覆盖，又会把我们的本地改造冲掉。

因此本文只回答三个问题：

| 问题 | 答案在哪 |
|---|---|
| 哪些代码来自上游、来自哪个文件的哪一部分？ | §3 逐文件台账 + `docs/magpie-baseline.json` |
| 我们本地改了什么？升级时不能丢的是什么？ | §3.3 每个 B 类文件的「保留 / 去掉 / 新增」清单 |
| 上游改了，我要不要跟？怎么跟？ | §4 升级流程（按 A/B/C/D 四类分别处理） |

> **必须说清楚的一点**：本仓**核心调度器（lane 并发、RPM、200 错误体、冷却、SSE 首包）不是从 magpie 拷贝的代码**，而是我们自己写的实现，**行为契约对齐上游**。真正逐字节搬过来的只有 `steady` / `lastgood` / `filelock` 这类底层文件与进程锁微模块。早期文档把这两者混为一谈（"核心部分直接使用 magpie 代码"），本次已按代码事实拆开——**这个区分决定了升级动作完全不同**：逐字节的可以直接覆盖，语义同源的绝对不能整文件拷贝。

---

## 1. 四类关系（决定升级动作）

| 类别 | 定义 | 判定依据 | 规模 | 升级动作 |
|---|---|---|---:|---|
| **A · 逐字节** | 与上游对应文件内容完全一致（仅允许 module 路径改写） | `sha256` 相等 | 10 个文件 + 3 个手工维护 | **直接覆盖**，一条命令 |
| **B · 搬运后改造** | 以上游文件为蓝本，删掉桌面端/供应商特例，加入本项目需要的能力 | 人工台账（§3.3） | 3 个文件 | **三路合并**，逐条看 delta |
| **C · 语义同源** | 独立实现，但行为/契约对齐上游同名能力 | 代码注释 + 本文 §3.4 | 9 个模块 | **读上游提交 → 改我们自己的实现**，禁止整文件拷贝 |
| **D · 明确不搬** | 上游存在、但我们永久拒绝 | 见 §3.5 | — | 只做「上游是否踩到我们已独立解决的坑」的观察 |

任何新代码若想引入上游内容，必须先落到 A/B/C 之一并登记到 `docs/magpie-baseline.json`，否则视为**来源不明代码**。

---

## 2. 上游到底有多快（2026-11-21 实测）

镜像取 `yetone/magpie` 全量历史（`--filter=blob:none`，22 MiB）：

| 指标 | 数值 |
|---|---:|
| 提交总数 | 8,894 |
| 版本 tag 总数（`v0.1.*`） | 4,618 |
| **最近 7 天提交**（2026-11-14 → 11-21） | **721** |
| **最近 24 小时提交** | **65** |

按我们关心到的路径统计「最近 7 天改动次数」与「最后一次改动」：

| 上游路径 | 7 天改动 | 最后改动 | 我们的关系 |
|---|---:|---|---|
| `internal/steady` | **0** | 2026-11-05 | A 类 |
| `internal/lastgood` | **0** | 2026-10-15 | A 类 |
| `internal/filelock` | **0** | 2026-10-20 | A 类 |
| `internal/netguard` | **0** | 2026-11-08 | B 类 |
| `internal/applog` | **0** | 2026-11-10 | B 类 |
| `internal/gateway/sse.go` | **0** | 2026-11-05 | C 类（peek） |
| `internal/gateway/rpm.go` | **0** | 2026-11-03 | C 类（rpm） |
| `internal/gateway/readonly.go` | 2 | 2026-11-21 | B 类 |
| `internal/gateway/concurrency.go` | 2 | 2026-11-17 | C 类（lanes） |
| `internal/backup` | 2 | 2026-11-17 | C 类（crypto，无跟随义务） |
| `internal/gateway/trace.go` | 7 | 2026-11-20 | C 类（trace） |
| `internal/netproxy` | 7 | 2026-11-19 | **D 类，拒绝搬运** |
| `internal/gateway/fallback.go` | 10 | 2026-11-21 | C 类（errorbody/cooldown） |
| `internal/gateway/routing.go` | 15 | 2026-11-21 | C 类（errorbody/cooldown） |
| `internal/usage` | 21 | 2026-11-21 | C 类（usage） |
| `internal/gateway/gateway.go` | **59** | 2026-11-21 | **D 类，禁止搬运** |

结论与 2026-11-08 的审计一致，只是数据更新了：**底层文件/锁/SSRF 三个包是真的冻结**（`lastgood` 已经 37 天没动，同期仓库走了 8,894 次提交），而 `gateway.go` 依然是一周 59 次的泥潭。所以「A/B 类可以跟、C 类只读提交、D 类永不碰」不是保守，是数据支持的。

---

## 3. 逐文件台账（基线 `18cfe278`）

### 3.1 A 类：逐字节副本（自动同步）

以下 10 个文件与上游 **完全一致**（`git hash-object` 相等），升级时可整文件覆盖：

| 本仓路径 | 上游路径 | 行数 |
|---|---|---:|
| `internal/steady/steady.go` | `internal/steady/steady.go` | 225 |
| `internal/steady/steady_test.go` | 同 | 68 |
| `internal/steady/write_test.go` | 同 | 103 |
| `internal/steady/steady_windows_test.go` | 同 | 79 |
| `internal/lastgood/lastgood.go` | `internal/lastgood/lastgood.go` | 276 |
| `internal/lastgood/lastgood_test.go` | 同 | 242 |
| `internal/filelock/filelock.go` | `internal/filelock/filelock.go` | 94 |
| `internal/filelock/lock_unix.go` | 同 | 22 |
| `internal/filelock/lock_windows.go` | 同 | 23 |
| `internal/filelock/filelock_test.go` | 同 | 98 |

**唯一例外**：`internal/lastgood/lastgood.go` 与上游差 **1 行**——import 路径 `github.com/yetone/magpie/internal/steady` 改成本仓路径。工具会自动做这个改写（`rewrite_module: true`）。

### 3.2 A 类里 3 个手工维护的文件

`internal/{steady,lastgood,filelock}/main_test.go` 与上游不同：上游用 `internal/testenv.Main(m)` 把 `HOME` 指向临时目录，本项目所有测试都已用 `t.TempDir()`，因此改成 `os.Exit(m.Run())`。

- 升级时**不需要**跟这 3 个文件，除非上游给 `TestMain` 加了实际逻辑（例如新增全局清理）。
- 它们**不纳入自动覆盖**，避免把 `testenv` 依赖带进来。

### 3.3 B 类：搬运后本地改造（三路合并）

#### `internal/obs/applog.go` ← `internal/applog/applog.go`（234 行 → 176 行）

| 保留（升级要跟） | 去掉 | 新增 |
|---|---|---|
| `secrets` 脱敏规则表（与上游逐条一致，仅把 `lazyre.RE` 换成标准库 `regexp`）<br>`Scrub()` 的替换逻辑<br>5 MiB 双文件轮转（`app.log` → `app.old.log`，移动失败则清空）<br>`Write` 前脱敏 | `Path()` / `Current()`（依赖上游 `appdir`，本仓有自己的目录策略）<br>`Start()` / `Stop()`（上游 GUI 生命周期）<br>`quiet` writer<br>`open()`（并入 `InitAppLog`） | `ScrubWriter` / `ScrubString` 导出<br>`InitAppLog(role, logDir, version)`：`full` 落盘 + `debug.SetCrashOutput`；`lite` 仅挂 `stderr`（零落盘） |

**合并规则**：上游改动落在「脱敏规则表 / 轮转逻辑」→ 必须合并（安全相关）；落在 `Start/Stop/Path/quiet` → 忽略。

#### `internal/netguard/netguard.go` ← `internal/netguard/netguard.go`(124) + `internal/gateway/image_fetch_guard.go`(365)（→ 277 行）

| 保留（升级要跟） | 去掉 | 新增（本项目） |
|---|---|---|
| `Public()`：回环 / RFC1918 / `fc00::/7` / 链路本地 / CGNAT / Fake-IP / 文档段 判定<br>云元数据地址（`169.254.169.254`、`fd00:ec2::254`、`100.100.100.200`）<br>特殊网段表 `specialNets` | `LoonPaired` / `FakePaired`（按 DNS 应答配对判定代理软件 Fake-IP）<br>`vendorClient` / `PublicClient` / `guardedClient`（上游供应商专用 client）<br>`publicTransport`（上游 fetch 守卫，本仓有自己的 transport） | `isAlwaysBlocked()`：即使 `allowPrivate=true` 也永不拨号（元数据 + 链路本地 + 组播 + 未指定）<br>`NewPinnedDialContext()`：解析一次、只拨公网地址，防 DNS Rebinding<br>`happyEyeballsDial()`：IPv6 300ms 黑洞回退（替代上游 `netproxy`） |

**合并规则**：上游新增/修改**地址段**（新的保留段、新的云元数据地址）→ 必须合并进 `specialNets` / `IsMetadataIP`；上游 `image_fetch_guard` 的供应商白名单 → 忽略。

#### `internal/router/readonly.go` ← `internal/gateway/readonly.go`（118 行 → 210 行）

| 保留（升级要跟） | 改造 |
|---|---|
| `routeMux` 思想：注册路由时记录 pattern，未登记路由在测试里直接报错<br>只读守卫：`lite` 模式下拒绝白名单外的写请求，返回结构化 403 | `routeMux` → 导出的 `RouteMux`（`ServeMux` 包装）<br>新增 `Patterns()` / `Validate()` / `ValidateRegisteredRoutes()`<br>`ReadOnlyGuard(role types.Role, next)` 取本仓 `types.Role`<br>白名单 `AllowedLiteRoutes` / `FullOnlyRoutes` 由本仓路由表决定（上游是 `v1/magpie/*` 那套） |

**合并规则**：白名单**永远以本仓为准**；上游 `readonly.go` 的改动只在「守卫机制本身有缺陷」时才值得看。

### 3.4 C 类：语义同源（只读上游提交，改我们自己的实现）

这 9 个模块**没有任何一行是从上游拷来的**，但它们的行为契约来自上游同名能力。升级时**禁止**整文件拷贝（既违反铁律，也会把上游的桌面端假设带进来），只允许「读提交说明 → 判断是否适用于我们的场景 → 改我们的实现 → 补测试」。

| 本仓模块 | 行数 | 上游锚点 | 同源的部分 | 尚未对齐的部分 |
|---|---:|---|---|---|
| `internal/scheduler/lanes.go` | 373 | `gateway/concurrency.go`（633） | `Lane{Busy,Waiting,Limit}` 结构；`tryTake`/`take`/`await` 的「满则排队、排队不算失败」语义；`signal` 唤醒；**`laneMate`/`waitMate`**：排队的请求每次被唤醒都重走整张候选表，取第一个有余量的 key（2026-11-21 补齐，30 请求闭集实测 1.815s → 121ms） | 上游按 lane 的 FIFO 队列与位次保留；上游 `QueueLimit`/`QueueWait` 超限即 429 + `Retry-After`，我们只有单请求 `QueueWait` 上限、无队列长度上限 |
| `internal/scheduler/rpm.go` | 105 | `gateway/rpm.go`（294） | 每 key 滑动窗口 RPM，一次真实尝试消耗一个 token | 上游按「账号/分组」聚合的窗口 |
| `internal/scheduler/errorbody.go` | 142 | `routing.go` `carriedStatus`、`fallback.go` `namedStatus`/`namedStatusOf` | HTTP 200 里裹错误体 → 按错误处理并换 key；命名状态码取自错误对象的数字 `code`/`status` | 上游还覆盖 `finish_reason:"error"`、流内 `eventError`/`eventEmptyEnd` |
| `internal/scheduler/cooldown.go` | 555 | `gateway/routing.go` | `forbiddenAlike`：两把 key 同一客户端错误不误封（约 30 行思想） | 上游按状态码/retry-after/供应商窗口的细分冷却 |
| `internal/scheduler/peek.go` | 283 | `gateway/sse.go`（148） | 首包 Peek、流内裸 JSON 错误识别、`: keepalive` | 上游更细的 SSE 事件解析 |
| `internal/obs/trace.go` | 72 | `gateway/trace.go`（1,206） | 最近 60 条 `Tries` 环形回放的思想 | 上游 trace 含更完整的成本/缓存字段 |
| `internal/obs/usage.go` | 1,245 | `usage/usage.go`（1,322） | `usage.jsonl` 单句柄追加账本 + `today/7d/30d` 聚合 | 上游的 speed/advisor 等新指标 |
| `internal/crypto/crypto.go` | 254 | `backup/backup.go` + `backup/data.go` | PBKDF2-SHA256 + AES-256-GCM 信封**算法** | **格式不兼容**：我们是 `llmproxy-encrypted`，上游是 `magpie-data`/`magpie-backup`；另有 1 代 Fernet 兼容。**无跟随义务** |
| `internal/upstream/transport.go` | 114 | `internal/netproxy` | —（反向：这是对上游的**替代**） | 上游 `netproxy` 被明确拒绝（见 §3.5） |

### 3.5 D 类：明确不搬运

| 上游路径 | 原因 |
|---|---|
| `internal/gateway/{gateway,fallback,routing,ir,chat,anthropic,claude_subscription}.go` | 1.7 万行巨型文件，一周 59~160 次改动，充斥订阅逆向与厂商特例硬编码 |
| `internal/netproxy` | 自定义 HTTP/2 Ping 曾引发 `GOAWAY too_many_pings` 断流；用 Go 标准库 `net.Dialer{FallbackDelay: 300ms}` + `netguard` Pinning 替代 |
| `internal/redact` | 捆绑本地 NER 模型，一周多次调词表；改用确定性正则/Header 脱敏 |
| `internal/access`、`internal/gui`、`internal/provider` | 桌面端 / 订阅账号体系，本项目无对应概念 |
| `internal/filememo` | **本仓从未引入**（早期文档误记，见 §7） |

> 注意 D 类不等于「不看」。对 `routing.go` / `fallback.go` 的观察是 C 类的输入源——`carriedStatus`、`forbiddenAlike`、`laneMate` 都是这样发现的。

---

## 4. 升级流程

### 4.1 例行检查（每周一次，或每次 `发版` 前）

```bash
node scripts/magpie-sync.mjs check
```

输出分四段：基线 vs 目标、A 类一致性、B 类有上游提交的文件、C 类有上游提交的文件。**退出码 1 表示有需要处理的项目**（该命令刻意没有接进 `verify:release`，避免上游节奏阻塞发版）。

### 4.2 A 类：直接覆盖

```bash
node scripts/magpie-sync.mjs apply          # 只写 A 类；本地改过的文件会跳过
go test ./internal/steady/ ./internal/lastgood/ ./internal/filelock/
```

规则：

- 本地文件与基线哈希不符 → 说明我们动过它，工具会**跳过并要求人工确认**（`--force` 才覆盖）。这是为了不冲掉本地修补。
- A 类一旦出现「本地改动」，正确做法不是每次 `--force`，而是**把它降级成 B 类**（登记到 `magpie-baseline.json` 的 `adapted`，写清 delta），否则下次升级还会打架。

### 4.3 B 类：三路合并

以 `internal/obs/applog.go` 为例：

```bash
U=~/.cache/llmproxy2/magpie.git
git -C $U log --oneline 18cfe278..HEAD -- internal/applog/applog.go   # 上游改了什么
git -C $U show <sha> -- internal/applog/applog.go                     # 逐条看
```

判定表（每个 B 类文件在 §3.3 都有对应清单）：

| 上游改动位置 | 动作 |
|---|---|
| 「保留」列里的逻辑（脱敏表、地址段、守卫机制） | **必须合并**，然后跑该包测试 |
| 「去掉」列里的逻辑（`Start/Stop`、供应商 client、白名单条目） | 忽略 |
| 新增的第三方依赖或桌面端概念 | 忽略，并确认没有耦合进「保留」逻辑 |

合并后把该文件在 `magpie-baseline.json` 的 `sha256` 更新（`rebaseline` 会一起刷新）。

### 4.4 C 类：语义对齐

1. `check` 列出上游提交 → **只读提交说明**（上游 commit message 写得非常具体，例如 `gateway: a usage cap holds with sessions in parallel`）。
2. 判断是否命中我们的使用场景（本仓是**同构透传 + 声明式适配**，不做订阅逆向，绝大多数提交与我们无关）。
3. 命中则在自己的实现里加行为，**并在代码注释里写清上游出处**（文件名 + 函数名，不要写行号——行号每周都变）。
4. 必须先写能挂的测试（本仓惯例：先让测试红，再改实现）。
5. 不命中就在本次同步记录里写一句「已读，不适用」，避免下次重复阅读。

### 4.5 收尾

```bash
node scripts/magpie-sync.mjs rebaseline --ref <新 commit>   # 刷新基线哈希
# 手动把 docs/MAGPIE_UPSTREAM_SYNC.md §2 / §3 的日期与数字更新
go test -race ./...
```

`rebaseline` 只写 `docs/magpie-baseline.json`；文档里的叙述需要人工同步（工具会提示）。

---

## 5. 工具与数据

| 文件 | 作用 |
|---|---|
| `docs/magpie-baseline.json` | **唯一事实源**：基线 commit/tag、A/B/C 映射、每个 A 类文件的 `sha256`、watch 列表 |
| `scripts/magpie-sync.mjs` | `check` / `apply` / `rebaseline` / `baseline` 四个命令，零依赖，首次运行会在 `~/.cache/llmproxy2/magpie.git` 建一个 bare 局部克隆（约 22 MiB，6 秒） |
| `npm run magpie:check` | 等价于 `node scripts/magpie-sync.mjs check` |
| `scripts/magpie-presets.mjs` | **预设表转换器**（与代码同步是两件事）：`check` 报告上游品牌缺口与端点漂移，`import --only=<ids>` / `--all` 把上游 `PresetDef` 表转成本仓 `shared/presets/*.json` + `internal/provider/presets_imported_generated.go` |
| `npm run magpie:presets:check` | 等价于 `node scripts/magpie-presets.mjs check` |

工具行为约定：

- **只读上游，不写上游**；只在 `apply` 时写本仓 A 类文件。
- `check` 的比较基准是**文件内容哈希**，不是行数或 diff——所以它可以证明「逐字节一致」这件事，而不是靠人眼看。
- 上游历史用 `--filter=blob:none` 克隆：全量提交（8,894 个）都在，但只有被 `show` 到的文件才下载内容。

### 5.1 预设表（Provider Presets）怎么同步

上游 `internal/provider/presets.go` 里有一张 `var presets = []PresetDef{...}` 表（2026-11-23 核对：63 条），字段与我们 `internal/provider/presets.go` 的 `PresetDef` 几乎同构（`Chat/Anthropic/Responses/Website/KeysURL/NoList/KeyPlans/Regions/Models`）。因此品牌接入是**数据搬运**，不是代码搬运：

```bash
node scripts/magpie-presets.mjs check                      # 缺口 + 端点漂移报告（只读）
node scripts/magpie-presets.mjs import --only=xai,longcat  # 导入指定品牌
node scripts/magpie-presets.mjs import --all               # 全量导入（--dry-run 先看）
```

- **能转的**：id / name / 端点（Chat→`base_url`、Anthropic→`anthropic_base_url`）/ 官网 / note / 模型清单 / Regions / KeyPlans / NoList。导入后 `shared/presets/<id>.json` 带 `source: {repo, preset_id, commit}` 便于回溯。
- **转不了的**：**协议改写**。上游把每家厂商的改写写在 `internal/provider/<vendor>.go` 的 Go 代码里，预设表里没有任何描述。所以导入的预设 `adapter_rules` 一律为 `{}`：端点是正确的，行为不等价，需要在本仓 `adapter_rules` 里补规则。
- **不能导的**：`Decide`-only 的 decision API（magpie 内部路由专用）、函数动态生成 region 的（bedrock / qwencloud / bedrock-mantle，需手工建）、endpoint 由用户自填的（Azure 类）。
- **版本号**：首次导入 `1.0.0`；再次导入时若上游端点未变则跳过，变了则 patch +1 并刷新 `updated_at`（`--force` 则直接覆盖上游值）。
- 导入后必须跑 `node shared/presets/build-catalog.mjs && go test ./internal/provider/`：`TestCatalog_PresetAdapterVersions` 强制 Go 目录与适配文件版本一致。

---

## 6. 铁律与开源合规

1. **不动态依赖**：`go.mod` 里不出现 `yetone/magpie`。白名单模块一次性静态考入本仓，由本仓测试锁定。
2. **D 类永不搬运**；C 类永不整文件拷贝（只对齐行为）。
3. **任何复用都要可追溯**：A/B 类必须出现在 `docs/magpie-baseline.json`；C 类必须在代码注释里写上游文件 + 函数名。
4. **许可证**：`THIRD_PARTY_NOTICES` 保留 `Copyright (c) 2026 yetone` 与 MIT 全文。A 类文件**不额外加文件头**（保持逐字节一致，便于 `apply` 与 diff 证明），provenance 统一记录在本文 + `THIRD_PARTY_NOTICES`；B/C 类文件在包注释里标注来源。

---

## 7. 本次核对发现的文档偏差（已修正）

| 位置 | 旧说法 | 事实 |
|---|---|---|
| `MAGPIE_REUSE_MATRIX.md` §3.1 | 搬运了 `internal/filememo/`（317 行） | **本仓没有这个包** |
| 同上 | 精简提取了 `internal/access`（~250 行） | **本仓没有这个包**（常量时间 SHA256 比对为自研） |
| 同上 | `internal/upstream/sse.go` ← `gateway/sse.go` | **没有 sse.go**；SSE 语义在 `internal/scheduler/peek.go`（C 类） |
| 同上 | `internal/obs/usage.go` ~250 行 | 实际 1,245 行，独立实现，非搬运 |
| 同上 | `internal/crypto` ~100 行 | 实际 254 行，格式与上游不兼容 |
| 同上 | `internal/netguard` 458 行 | 实际 277 行（合并 image_fetch_guard 后又删了供应商逻辑） |
| `README.md` 文档索引 | "85 个包与 1 代 17 个模块的逐文件对照表" | 矩阵里没有 85 个包；实际台账见本文 §3（13 + 3 + 9） |
| `CLAUDE.md` 白名单 | 列了 `filememo` | 删除；改为指向本文与基线文件 |

> 经验教训：**「搬运矩阵」这类文档必须由可执行工具生成或校验**，否则半年后必然与代码脱节。这正是 `scripts/magpie-sync.mjs` 存在的原因。

---

## 8. 测试矩阵（改哪类跑哪些）

| 改动 | 必跑 |
|---|---|
| A 类覆盖 | `go test ./internal/steady/ ./internal/lastgood/ ./internal/filelock/` |
| B 类 applog | `go test ./internal/obs/` + `npm run verify:release`（G 系列含日志扫描） |
| B 类 netguard / transport | `go test ./internal/netguard/ ./internal/upstream/` |
| B 类 readonly | `go test ./internal/router/` |
| C 类 lanes / rpm / errorbody | `go test ./internal/scheduler/`（含 `-race`；并发用例必须开） |
| C 类 peek / usage / trace | `go test ./internal/scheduler/ ./internal/obs/` |
| 任意 A/B 类改动后 | `go test -race ./...`（发版前再加 `npm run verify:release`） |

---

## 9. 变更记录

| 日期 | 基线 | 动作 |
|---|---|---|
| 2026-11-08 | —（未记录 commit） | 首次静态迁入 steady / lastgood / filelock / netguard / applog 等模块 |
| 2026-11-21 | `18cfe278` (v0.1.4624) | 首次建立可核对基线：逐文件哈希验证 10 个文件逐字节一致；拆出 B/C/D 三类；新增本文与 `scripts/magpie-sync.mjs`；修正 8 处文档偏差 |
| 2026-11-21 | 同上 | 10 个 B/C 类文件的包注释补上「上游文件 + 函数名 + 本文小节」provenance，使 §6 第 3 条可从代码侧直接核对（A 类保持零注释以维持逐字节一致） |
| 2026-11-21 | 同上 | `lanes.go` 补齐 `laneMate`/`waitMate` 等价物：`WaitAcquireChoices` 在被唤醒时重走候选表（闭集 30 请求实测 1.815s → 121ms），并修掉唤醒时 `waiting` 只增不减的观测 bug；上游 633 行 `concurrency.go` 仍未经搬入——只对齐行为 |

---

**相关文档**：[`MAGPIE_REUSE_MATRIX.md`](./MAGPIE_REUSE_MATRIX.md)（2026-11-08 的复用决策审计，历史背景）、[`SYSTEM_DESIGN_SPEC.md`](./SYSTEM_DESIGN_SPEC.md)（架构总览）、[`EXTERNAL_REFERENCES.md`](./EXTERNAL_REFERENCES.md)（外部链接与许可证）、[`THIRD_PARTY_NOTICES`](../THIRD_PARTY_NOTICES)（MIT 全文）。
