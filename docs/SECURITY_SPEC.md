# 安全架构与凭据隔离规范 (Security Specification)

> **适用范围**：`llmproxy2` 全组件（EdgeOne Makers 轻中枢 `hub`、Go 极简节点 `lite`、Go 完整节点 `full`）
> **核心基准**：继承 1 代 `SECURITY_SPEC.md` 零信任红线，并融入 `yetone/magpie` 冻结级微模块 `netguard`、`readonly.go`、`applog.go` (`scrub`) 与 `access` 常量时间摘要比对机制。

---

## 一、 威胁模型（Threat Model）

1. **不可信 NAT VM 环境（核心新增威胁）**：
   - `lite` 节点常部署在廉价合租 NAT VM、借用的临时服务器或容器平台上，宿主机管理员可能随时 dump 磁盘镜像、查看 `/tmp` 或读取历史日志。
   - **防御目标**：即使攻击者完整拷贝走 NAT VM 的磁盘，也**拿不到任何一条上游供应商 API Key**；一旦管理员在 EdgeOne 中枢点击“注销/吊销”，该节点在租约到期或触发刷新后立即永久失去服务能力。
2. **EdgeOne 计费攻击与扫描（DDoS / Billing Exhaustion）**：
   - 恶意节点或外部扫描高频请求 EdgeOne 接口试图刷爆按次计费额度。
   - **防御目标**：移除 `/v1/*` 边缘代理，节点零轮询、零心跳；`POST /api/node/config` 先做无状态 Token 格式与 SHA-256 校验，命中 `(node_id, config_version)` 内存缓存或直接返回 0 载荷 `304 Not Modified`。
3. **SSRF 与 DNS Rebinding 攻击**：
   - 攻击者通过自定义 `base_url` 或模型探测接口诱导网关访问内网服务、云厂商元数据（`169.254.169.254` / `100.100.100.200`）或透明代理 Fake-IP。
4. **前端掩码覆盖事故（Masked Secret Overwrite）**：
   - 管理端回传脱敏占位符（`●`、`***`）导致真实 API Key 被覆盖损坏。

---

## 二、 四权分立凭据矩阵（严禁凭据平权）

系统中四类凭据完全正交，**任何一类凭据绝不能通过另一类路由的鉴权**，所有密钥比较强制使用 `crypto/subtle.ConstantTimeCompare`（对 SHA-256 摘要比对）：

| 凭据类型 | 签发/配置位置 | 授权访问的唯一路由域 | 越权访问其它路由时的响应 | 未配置时的行为 |
|---|---|---|---|---|
| **`ADMIN_PASSWORD`** | EdgeOne 环境变量 / Full 节点环境变量 | `/admin`, `/api/admin/*`, `/api/config` | 访问 `/v1/*` 或 `/api/node/*` → `401` | **Fail-Closed (`503`)**，拒绝切入管理端 |
| **`NODE_TOKEN`** | EdgeOne 中枢动态签发（`stk_node_<48hex>`） | `POST /api/node/config`（以及 Full 节点的 `/api/vault/*`） | 访问 `/api/admin/*` 或 `/v1/*` → `401` | 节点无法激活拉取配置，保持停服 (`503`) |
| **`CLIENT_KEY`** | 节点启动配置或中枢下发（`sk-llmproxy-...`） | 节点数据面 `/v1/*` (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`, `/v1/ocr` 等) | 访问 `/api/admin/*` 或 `/api/node/*` → `401` | **Fail-Closed (`503`)**，**即使来自 `127.0.0.1`/`::1` 也绝不免鉴权** |
| **`ENCRYPT_KEY`** | Full 节点本地环境变量 | 仅用于本地 `proxy_config.enc` 的 `PBKDF2-SHA256 + AES-256-GCM` 加解密 | 不作为任何 HTTP 鉴权 Token | Full 节点拒绝启动并报错提示生成密钥 |

**防爆破限流**：`/api/admin/*` 与 `/api/node/config` 内置按源 IP 滑动窗口限流（10 分钟内连续 5 次鉴权失败，锁定该 IP 600 秒并返回 `429 Too Many Requests`）。仅当请求来自 Loopback 或显式设置 `TRUST_PROXY_HEADERS=1` 时才信任 `X-Forwarded-For` / `X-Real-IP`。

---

## 三、 NAT VM 极简模式（`lite`）五大内存与只读防线

1. **Zero-Disk 纯内存驻留**：
   - `lite` 模式不初始化 `LocalConfigSource`，所有上游 Key 仅存在于 `atomic.Pointer[RuntimeSnapshot]` 指向的堆结构体中。
   - 严禁向任何本地文件、环境变量、临时目录或日志输出明文或加密的上游 Key。
2. **禁用 Core Dump 与进程加固**：
   - 启动时在 `main()` 第一行调用 `syscall.Setrlimit(syscall.RLIMIT_CORE, &syscall.Rlimit{Cur: 0, Max: 0})`；
   - 配套 systemd 单元默认开启 `ProtectSystem=strict`、`ProtectHome=yes`、`PrivateTmp=yes`、`NoNewPrivileges=yes`。
3. **401 内存即时销毁（`PurgeMemory()`）**：
   - 当条件拉取收到中枢返回的 `401`/`403`（节点被吊销）或宽限期（`grace_ttl`）耗尽时，立即执行 `PurgeMemory()`：先遍历旧 `Snapshot` 将全部 API Key 字节数组用 `0x00` 覆写清零，再将 `atomic.Pointer` 置为 `nil` 并触发 `runtime.GC()`。
4. **物理级只读路由守卫（复用 Magpie `internal/router/readonly.go`）**：
   - `lite` 模式在编译运行期根本不注册 `/api/admin/*` 路由处理器；运行时对 `/admin`、`/api/config`、`/api/admin/*` 等管理路径统一返回 **`403 Forbidden`**（`{"ok":false,"error":"lite_mode_forbidden"}`），不泄露任何配置内容；
   - 同时在顶层 `http.Handler` 包裹 `readOnlyGuard` 与 `routeMux`，任何未在 `allowedLiteRoutes` 白名单登记的路由或方法在单元测试阶段直接报错。
5. **全链路自动脱敏（复用 Magpie `internal/obs/applog.go` 的 `scrub` + 1 代 Header 掩码）**：
   - 所有日志输出、崩溃栈、最近 60 条轨迹回放（`trace.go`）、`/healthz` 状态均经过 `applog.Scrub` 与 `MaskKey` 过滤，自动剥离 `Authorization`、`x-api-key`、`x-goog-api-key`、URL 中的 `?key=` 以及符合 `sk-*` / `AIza*` / `eyJ*` 特征的令牌字符串（统一打码为 `***` 或 `前4位...后4位`）。
   - `lite` 模式下 `applog` 仅挂载到 `os.Stderr`，绝不创建 `app.log` 或 `usage.jsonl` 磁盘文件。

---

## 四、 `origin` 密钥归属隔离与 Kernel Guard

1. **`origin: "local"` vs `origin: "vault"` 物理隔离**：
   - 在 EdgeOne 中枢，凡标记为 `origin === "local"` 或 `is_local === true` 的供应商、`search_providers` 与 Key，在 `POST /api/node/config`、`/api/vault/manifest`、`/api/vault/fetch` 中**一律在序列化前物理剔除**，绝不下发给任何 VM/MCP 节点；同时受 `node.scope.providers` / `node.scope.search_providers` 与 `search_selection` 过滤。
   - 在 Go Full 节点，凡从中枢同步下来的 `origin === "vault"` 供应商，其连接核心字段（`base_url`、`anthropic_base_url`）在本地 UI 锁定只读，但允许管理员追加本地私有 Key（标记为 `origin: "local"`）。
2. **Kernel Guard（防掩码覆盖内核守卫）**：
   - 在 EdgeOne `api/config`（含 `providers` 与 `search_providers`）与 Go Full `internal/config/local_source.go` 的保存路径中，强制检测所有传入的密钥字符串：若包含掩码字符 `●`、全星号 `***` 或与脱敏预览格式匹配，**强制回退保留原存储中的真实明文 Key**，从内核层杜绝前端误把脱敏占位符写回磁盘。
3. **严格单向拉取与 KV 摘要隔离（无明文/密文 `node_token` 持久化）**：
   - EdgeOne Hub 仅保存 `NODE_TOKEN` 的单向 SHA-256 摘要（`token_sha256`），**不存储可逆密文且不发起任何 Hub → 节点反向状态回调请求**；MCP/VM 节点按需请求 `POST /api/node/config` 时顺带上报的 `telemetry` 经 `scrubSecrets` 清洗后写入 KV。
   - Hub 侧新增 `POST /api/admin/verify-search-key` 使用 `isSafePublicHttpUrl` 校验出站探测地址并脱敏上游报错。
4. **Vault URL 变更防凭据泄露守卫**：
   - 当管理员在 Full 节点修改 `vault.url`（指向新的中枢域名）时，若请求未同时提交新的明文 `vault.token`，后端强制清空旧 Token，防止旧中枢的 `NODE_TOKEN` 被发送到恶意第三方地址。

---

## 五、 SSRF 防护与 DNS Pinning（复用 Magpie `netguard`）

所有出站连接（包括上游推理转发、在线测 Key `verify-key`、模型列表探测 `probe-models`）统一经过 `internal/netguard` 强化的 `http.Transport`：

1. **解析后 IP 级校验（`netguard.Public`）**：
   - 先执行 `ip.Unmap()` 还原 IPv4-mapped IPv6（如 `::ffff:127.0.0.1` → `127.0.0.1`）；
   - 拦截：`0.0.0.0/8`、`127.0.0.0/8`、`::1`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`fc00::/7`（含 Clash Fake-IP `fc00::/18`）、`169.254.0.0/16` 与 `fe80::/10`（Link-Local 与 AWS/GCP/Azure/阿里云元数据）、`100.64.0.0/10`（CGNAT 与阿里云元数据 `100.100.100.200`）、`198.18.0.0/15`（Clash Fake-IP 段）。
2. **DNS Pinning 消除 TOCTOU**：
   - `DialContext` 完成 `LookupNetIP` 并校验通过后，**直接向该 IP 字面量发起 TCP 握手**，不让底层再次解析域名，彻底免疫 DNS Rebinding。
3. **重定向严控**：
   - 上游推理接口默认禁止自动跟随跨域 `3xx` 重定向（避免 `Authorization` 头在重定向中泄露）；探测接口最多允许 5 跳且每一跳均重新执行 `netguard` 校验。
4. **Full 模式内网白名单例外**：
   - `full` 模式允许管理员在本地显式配置内网推理后端（如 `http://192.168.1.50:11434` Ollama/vLLM），但**无论任何配置，云厂商元数据地址（`169.254.169.254`、`100.100.100.200`、`fd00:ec2::254`）永远硬编码封禁**。
