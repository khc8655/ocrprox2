# LLMProxy2 (OCRProxy v2) — 轻量级多协议 AI 网关与中枢系统

> **定位**：`ocrprox`（1 代）的彻底重构升级版 —— **1 代完整业务能力（EdgeOne 密钥中枢 + Agent/KB 双模 + 零拷贝 OCR + 时段调度） × `yetone/magpie` 工业级 Go 内核**。
> **核心目标**：彻底解决 1 代 Python (FastAPI + Uvicorn) 运行时内存占用高、依赖重、无法在廉价/受限 **NAT VM（64MB~256MB 内存、共享公网 IPv4 / 纯 IPv6、不可信磁盘）** 上稳定运行的问题。

---

## 1. 为什么重构？（从 1 代到 2 代）

| 痛点维度 | 1 代 (`ocrprox` Python 版) | 2 代 (`llmproxy2` Go × Magpie 版) |
|---|---|---|
| **运行时体积与内存** | Python + venv + FastAPI/httpx/cryptography，空载内存 80~150MB，NAT 小鸡易 OOM | 单一静态二进制（`CGO_ENABLED=0`），空载内存 **< 15MB**，64MB NAT VM 轻松运行 |
| **EdgeOne 职责与计费** | EdgeOne 既做 Vault 又做 `/v1/*` 流量中转，KV 读写频繁，受 25s 流式超时和 900KB 请求体限制 | **EdgeOne Makers 仅做轻中枢（Hub）**：只管 Key/规则维护与 VM 节点签发/注销；**零 `/v1/*` 流量中转、零定时轮询、零心跳** |
| **NAT VM 安全性** | 密钥加密落盘在本地 `proxy_config.enc`，合租/借用 NAT 小鸡存在磁盘被导出风险 | **极简模式（`lite`）纯内存运行**：按需向中枢拉取一次（Lazy-Once + Lease），**零落盘、零管理写接口**，进程退出或吊销即刻清空 |
| **NAT VM 复杂网络适应力** | 依赖系统默认网络栈，遇到 NAT 小鸡 IPv6 黑洞易卡死 | **双栈监听 (`IPV6_V6ONLY=0`) + Go 标准库 RFC 6555 Happy Eyeballs**：300ms 内 IPv6 黑洞自动无感切 IPv4，稳健零自定义连接池 Bug |
| **代码复用与稳定性防火墙** | Python 与 EdgeOne JS 双栈重复维护适配逻辑 | **80% 1代成熟业务架构 + 20% Magpie 冻结级标准库微模块**：仅搬运 Magpie 经受 734 个版本 0 修改考验的底层微模块（`netguard`、`steady`、`lastgood`、`filelock`、`filememo`、`readonly.go` 等 ~1650 行），彻底隔绝 Magpie 上层日更百次的大泥球代码 |

---

## 2. 总体架构：一中枢 + 两类客户端（节点）

```text
                       ┌────────────────────────────────────────────────────┐
                       │     EdgeOne Makers · 统一轻中枢 (Role: hub)         │
                       │  1. Vault K 维护：供应商 / API Key / 预设适配规则     │
                       │  2. 节点管理：VM 节点 Token 签发 (Issue)、注销/吊销   │
                       │  3. 被动配置投影：POST /api/node/config (ETag/304)   │
                       │  4. 统一管理 UI (shared/admin)                       │
                       │  ✗ 不中转 /v1/* 流量   ✗ 不主动连 VM   ✗ 不收定时心跳 │
                       └───────────────┬──────────────────────┬─────────────┘
                                       │                      │
            真实请求触发 · Lazy-Once + Lease (304 续租)         │ 仅管理员在 Web UI 显式按需拉取
                                       ▼                      ▼
            ┌────────────────────────────────────┐  ┌────────────────────────────────────┐
            │  VM 客户端 A：极简模式 (--role=lite) │  │  VM 客户端 B：完整模式 (--role=full) │
            │  适用：NAT VM / 借用小鸡 / 出站节点   │  │  适用：自有标准 VM / 主力生产网关     │
            ├────────────────────────────────────┤  ├────────────────────────────────────┤
            │ · 纯内存保存 Key，绝不落盘 (Zero-Disk)│  │ · 本地 AES-256-GCM 加密持久化落盘   │
            │ · 首次真实请求激活拉取，租约期零请求   │  │ · 离线完全独立可用，中枢断网零影响    │
            │ · 中枢注销/401 或租约断联即刻清空停服 │  │ · Agent + KB 双模式 + 时段自动切换   │
            │ · 仅开放 Agent 数据面 (/v1/chat 等) │  │ · 20MB 零拷贝 OCR 队列 + Emb/Rerank │
            │ · 零管理端、零写接口 (readonly 守卫) │  │ · 完整本地 Web 管理控制台 + OAuth   │
            └──────────────────┬─────────────────┘  └──────────────────┬─────────────────┘
                               ▲                                       ▲
                               └─────────── 客户端通过 CLIENT_KEY 直连 ──┘
```

---

## 3. 仓库目录结构规范

```text
llmproxy2/
├── README.md                        # 项目总览与快速指南（本文件）
├── CLAUDE.md                        # AI 代理入口、文档优先级与工程铁律
├── ARCHITECTURE_STANDARDS.md        # 核心架构准则与七大工程红线
├── CHANGELOG.md                     # 版本发布历史与变更记录
├── version.json                     # 全局唯一版本号真源 (SSOT)
├── package.json                     # 前端构建、契约校验与门禁脚本入口
├── go.mod / go.sum                  # Go 模块定义 (CGO_ENABLED=0)
├── install.sh                       # 一键安装 / 平滑升级 / 卸载脚本（与 deploy/install.sh 同步）
├── Dockerfile                       # 容器镜像定义（scratch 基础，多架构，由 CI 推送 ghcr.io）
├── cmd/
│   └── llmproxy/
│       └── main.go                  # 统一二进制入口 (--role=lite|full，RLIMIT_CORE=0，双栈监听)
├── internal/                        # Go 核心包（20% Magpie 冻结级微模块 + 80% 1代成熟业务）
│   ├── types/                       # 全局共享核心结构体与接口契约（多 Agent 协作零歧义基石）
│   ├── netguard/                    # [搬运自 Magpie · 0改动] SSRF 公共地址守卫 + DNS Pinning 拨号器
│   ├── steady/                      # [搬运自 Magpie · 1改动] Full 模式跨平台原子文件写入 (Temp+Fsync+Rename)
│   ├── lastgood/                    # [搬运自 Magpie · 0改动] 配置防损坏内存快照与 .corrupt 自愈
│   ├── filelock/                    # [搬运自 Magpie · 0改动] 跨进程 OS 文件锁 (syscall.Flock)
│   ├── filememo/                    # [搬运自 Magpie · 0改动] 基于 mtime+size 的零重解析内存缓存
│   ├── crypto/                      # [搬运自 Magpie · 0改动] PBKDF2-SHA256 + AES-256-GCM + 1代 Fernet 兼容
│   ├── router/                      # [搬运自 Magpie readonly.go + 1代 middleware] Lite 只读白名单守卫与 CORS
│   ├── upstream/                    # [搬运自 Magpie sse.go + Go原生 Happy Eyeballs] 300ms IPv6->IPv4 回退与 SSE 扫描
│   ├── auth/                        # [融合 Magpie access + 1代 auth] SHA-256 常量时间四权鉴权与 IP 防爆破
│   ├── config/                      # [移植自 1代 config_store] Full 本地加密配置源 + Kernel Guard 防掩码覆盖
│   ├── hubsync/                     # [2代核心新增] Lite 按需 Lazy-Once + Lease + ETag 304 续租 + 401 PurgeMemory
│   ├── adapters/                    # [移植自 1代 proxy_routes + gemini_compat + Magpie gemini_schema] 16家厂商声明式适配
│   ├── scheduler/                   # [移植自 1代 scheduler + Magpie forbiddenAlike] 300s预算、三级冷却、流式首包 Peek
│   ├── obs/                         # [借鉴自 Magpie applog + usage.jsonl + trace.go] 5MB脱敏日志、Token账本、60条重试轨迹
│   ├── kb/                          # [移植自 1代 (Full专属)] 预读信号量 + 20MB 零拷贝分片流式 OCR + Emb/Rerank
│   ├── modesched/                   # [移植自 1代 (Full专属)] Agent <-> KB 时段自动切换器与活跃请求优雅排空
│   ├── oauth/                       # [移植自 1代 (Full专属)] MiniMax OAuth 2.0 Device Flow (PKCE) + 6h 保活
│   └── admin/                       # [移植自 1代 (Full专属)] 本地管理 API、Vault 按需拉取与内嵌静态控制台
├── edgeone-hub/                     # EdgeOne Makers 轻中枢代码
│   ├── edge-functions/              # 仅保留 api/vault/*、api/node/*、api/admin/*、api/config、admin.js
│   └── scripts/                     # 预设与单文件管理端打包脚本
├── shared/                          # 跨端单一真源 (SSOT)
│   ├── admin/                       # 唯一管理端前端源码 (HTML/CSS/JS，支持 hub/full 角色能力裁剪)
│   ├── config/                      # settings.schema.json 与 runtime-profiles.json
│   ├── contracts/                   # 前后端契约、节点投影契约与适配规则测试 Fixtures
│   └── presets/                     # 供应商声明式适配规则预设库 (*.json)
├── tests/                           # 三层自动化测试套件 (T1 契约 / T2 单元 / T3 E2E) 与 G1~G6 门禁
└── docs/                            # 标准项目文档中心
```

---

## 4. 标准项目文档导航

本项目从立项第一天起严格执行文档驱动与契约先行规范，所有文档位于根目录与 [`docs/`](file:///Users/xk/Documents/llmproxy2/docs/) 下：

| 类别 | 文档路径 | 核心内容说明 |
|---|---|---|
| **AI 与架构宪法** | [`CLAUDE.md`](file:///Users/xk/Documents/llmproxy2/CLAUDE.md) | AI 协作入口、冲突裁决优先级、禁止重造轮子原则 |
| **多 Agent 协同蓝图** | [`docs/MULTI_AGENT_BLUEPRINT.md`](file:///Users/xk/Documents/llmproxy2/docs/MULTI_AGENT_BLUEPRINT.md) | **多 Agent 并行必读**：`internal/types` 全局接口锁死、W0~W6 物理文件所有权矩阵（零冲突） |
| **架构标准** | [`ARCHITECTURE_STANDARDS.md`](file:///Users/xk/Documents/llmproxy2/ARCHITECTURE_STANDARDS.md) | 七大工程铁律（SSOT、Magpie 复用、零轮询、零落盘、四权分立等） |
| **核心系统设计** | [`docs/SYSTEM_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SYSTEM_DESIGN_SPEC.md) | 完整重构设计方案（含前任方案缺陷诊断、三端架构、状态机、数据流） |
| **Magpie 上游同步（必读）** | [`docs/MAGPIE_UPSTREAM_SYNC.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_UPSTREAM_SYNC.md) | **搬运了什么 / 本地改了什么 / 上游改了怎么跟**：A 逐字节（10 文件）、B 改造（3 文件）、C 语义同源（9 模块）、D 拒绝搬运；基线 `18cfe278`（v0.1.4624），核对 `node scripts/magpie-sync.mjs check` |
| **Magpie 复用决策审计** | [`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md) | 2026-11-08 的「要不要搬」论证与变更热度实测（历史背景；现状以同步手册为准） |
| **安全与凭据规范** | [`docs/SECURITY_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/SECURITY_SPEC.md) | 节点签发/吊销、极简模式内存安全、SSRF DNS Pinning、密钥隔离 |
| **前后端与节点契约** | [`docs/ADMIN_UI_BACKEND_CONTRACT.md`](file:///Users/xk/Documents/llmproxy2/docs/ADMIN_UI_BACKEND_CONTRACT.md) | `POST /api/node/config` 协议、`HOST.capabilities`、设置项生效契约 |
| **Web 管理端 UI 规范** | [`docs/UI_DESIGN_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/UI_DESIGN_SPEC.md) | **Magpie 极简风格 UI 标准**：安静表面、列表行内原地展开编辑（零抽屉）、零内联样式门禁 |
| **测试体系规范** | [`docs/TESTING_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/TESTING_SPEC.md) | T1 契约 / T2 Go 单元 (`-race`) / T3 黑盒 E2E 与零轮询/零落盘专项测试 |
| **发版与门禁规范** | [`docs/RELEASE_SPEC.md`](file:///Users/xk/Documents/llmproxy2/docs/RELEASE_SPEC.md) | 版本规范、多平台静态交叉编译、G1~G6 六道自动化门禁 |
| **运维与 NAT 部署** | [`docs/OPERATIONS_GUIDE.md`](file:///Users/xk/Documents/llmproxy2/docs/OPERATIONS_GUIDE.md) | EdgeOne Makers 部署、NAT VM 极简模式只读加固、标准 VM 运维 |
| **外部参考与许可证** | [`docs/EXTERNAL_REFERENCES.md`](file:///Users/xk/Documents/llmproxy2/docs/EXTERNAL_REFERENCES.md) | EdgeOne 官方文档、各厂商 API 规范、`yetone/magpie` MIT 许可声明 |

---

## 5. 常用开发与发版验证命令

```bash
# 1. 构建共享预设与管理端单文件产物
npm run build:admin

# 2. 编译 Go 静态二进制（零 CGO，同时支持 --role=lite 与 --role=full）
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/llmproxy ./cmd/llmproxy

# 3. 运行 Go 单元测试与并发竞争检测
go test -race ./...

# 4. 运行全量三层测试（T1 契约 + T2 单元 + T3 黑盒 E2E）
npm run test:full

# 5. 发版前执行 G1~G6 六道门禁校验
npm run verify:release
```

---

## 6. 快速部署指引 (Quick Deployment)

### 6.1 腾讯云 EdgeOne Makers (Pages) 轻中枢部署（Role: `hub`）

EdgeOne Makers 仅负责供应商/Key 与适配规则维护、节点 Token 签发与被动配置投影，**零 `/v1/*` 流量中转、零心跳轮询**。

1. **连接 GitHub 仓库**：登录腾讯云 EdgeOne Makers 控制台，新建 Pages 项目并连接本 GitHub 仓库的 `main` 分支；
2. **绑定 KV 命名空间**：进入站点设置 -> KV 存储，绑定命名空间变量名为 `agent_kv`（用于持久化密钥与节点注册表）；
3. **设置环境变量**：在环境变量中配置 `ADMIN_PASSWORD`（管理端登录强密码，必填）；
4. **访问管理端与签发节点**：
   - 部署完成后访问 `https://<your-hub-domain>/admin`，使用 `ADMIN_PASSWORD` 登录；
   - 在 **「供应商与密钥 (Vault Hub)」** 中维护上游 API 供应商及密钥；
   - 进入 **「中转节点 (Relay Nodes)」** 点击「新建节点」，选择角色 `lite`（NAT 节点）或 `full`（标准节点），设置租约与供应商权限，系统将自动生成一次性节点 Token（形如 `stk_node_...`）及配套启动命令。

---

### 6.2 VM 客户端节点部署

`llmproxy2` 为单一静态 Go 二进制，零 CGO 依赖，支持以下三种部署方式。Hub 控制台签发节点后会自动生成对应的单行命令（含角色、中枢地址、节点令牌、客户端 Key 等全部参数），复制即用：

| 方式 | 适用场景 | 开机自启 | 配置持久化 | 升级 / 卸载 |
|---|---|---|---|---|
| **一键安装（systemd）** | 生产部署（推荐） | ✅ systemd | `/etc/llmproxy` | `llmproxy-ctl upgrade` / `uninstall` |
| **Docker 容器** | 容器化 / K8s 环境 | ✅ `--restart` | 卷 `./llmproxy-data`（仅 Full） | 拉新镜像重建 / `docker rm -f` |
| **单行直跑（免安装）** | 临时试跑、调试 | ❌ 关终端即停 | `./llmproxy-data/config` | 手动替换二进制 |

#### 方式一：使用 `install.sh` 一键安装（推荐，对齐 1 代流程）

在 Hub 控制台「中转节点 → 签发新节点」（或「轮换 Token」）后，可直接复制生成的单行一键安装命令；也可直接在 Linux VM 上执行脚本。脚本将自动识别架构（`amd64` / `arm64`）、从 GitHub Releases 下载静态二进制（内置 `ghfast.top` / `gh-proxy.com` 回退与 `SHA256SUMS` 校验，支持 `--version` / `--mirror`）、安装到 `/usr/local/bin/llmproxy` 并注册 `systemd`（已兼容非特权 LXD/Docker 容器）与 `llmproxy-ctl` 快捷运维命令。

> 脚本同步托管在你的 EdgeOne Hub 同域 `/install.sh`（国内/纯 IPv6 推荐，不依赖 `raw.githubusercontent.com`）及仓库根目录 `install.sh`。

**1. 交互式一键安装（与 1 代相同，`safe_read` 兼容管道交互向导）**：
```bash
curl -fsSL https://your-hub.edgeone.app/install.sh | sudo bash
# 或从 GitHub Raw:
curl -fsSL https://raw.githubusercontent.com/khc8655/ocrprox2/main/install.sh | sudo bash
```

**2. NAT VM 极简节点 (`--role=lite`) 非交互一键安装**：
> 专为 **64MB~256MB 内存、共享 IPv4 / 纯 IPv6、不可信磁盘** 的 NAT 小鸡设计。纯内存运行、零落盘、开机无定时轮询、中枢注销即停服。

```bash
curl -fsSL https://your-hub.edgeone.app/install.sh | sudo bash -s -- \
  --role=lite \
  --hub-url="https://your-hub.edgeone.app" \
  --node-token="stk_node_example_node_token_48chars_long_placeholder" \
  --client-key="sk-llmproxy-client-example-key" \
  -p 8787 -y
```

**3. 标准 VM 完整节点 (`--role=full`) 一键安装**：
> 适用于自有主力云主机，具备本地 AES-256-GCM 加密落盘、离线可用、Agent + KB 双模时段切换、20MB 零拷贝 OCR 队列与本地 Web 控制台；传入 `--hub-url` 与 `--node-token` 可预绑定 Vault 拉取源，登录后台按需拉取中枢供应商（清单 → 整体拉取 → 按 Key 标签补拉）与路由模板，无一键全量同步。

```bash
curl -fsSL https://your-hub.edgeone.app/install.sh | sudo bash -s -- \
  --role=full \
  --hub-url="https://your-hub.edgeone.app" \
  --node-token="stk_node_example_node_token_48chars_long_placeholder" \
  --client-key="sk-llmproxy-client-example-key" \
  --admin-pass="your_strong_admin_pass" \
  -p 8787 -y
```

**监听范围（安装时二选一，默认 `local`）**：

| `--bind=` | 写入的监听地址 | 适用场景 |
|---|---|---|
| `local`（默认） | `127.0.0.1:<port>` | 只给本机用；对外发布交给 nginx / caddy 反代或 `ssh -L` 转发 |
| `public` | `[::]:<port>`（双栈通配） | 直接对外提供服务，IPv4 + IPv6 都能连 |

```bash
# 默认：仅本机可访问
curl -fsSL "$HUB/install.sh" | sudo bash -s -- --role=lite ... -y

# 直接对外提供服务
curl -fsSL "$HUB/install.sh" | sudo bash -s -- --role=lite ... --bind=public -y
```

> 脚本**不探测也不显示外部 IP**：端口怎么发布（反代、端口映射、防火墙）不属于本程序职责，与 1 代行为一致。
> 已安装的环境再次执行脚本即走平滑升级，`--bind` 同样会改写监听地址并重启，因此可随时在两种模式间切换。

---

#### 方式二：单行直跑预编译静态二进制（免安装）

从 GitHub Releases (https://github.com/khc8655/ocrprox2/releases) 下载对应架构的免依赖单文件二进制：

> Hub 签发面板生成的「单行直跑」命令会自动探测架构、从 GitHub Releases 下载对应二进制再启动，无需手工准备文件：

**1. 极简节点 (`lite`)，一条命令完成下载 + 启动**：
```bash
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
  && mkdir -p ./llmproxy-data && cd ./llmproxy-data \
  && curl -fL --retry 2 -o llmproxy \
     "https://github.com/khc8655/ocrprox2/releases/latest/download/llmproxy-linux-${ARCH}" \
  && chmod +x ./llmproxy \
  && LLMPROXY_ROLE=lite \
     LLMPROXY_HUB_URL="https://your-hub.edgeone.app" \
     LLMPROXY_NODE_TOKEN="stk_node_example_node_token_48chars_long_placeholder" \
     LLMPROXY_CLIENT_KEY="sk-llmproxy-client-example-key" \
     GOMEMLIMIT=48MiB \
     ./llmproxy --addr="[::]:8000"
```

**2. 完整节点 (`full`)**（配置写入 `./llmproxy-data/config`）：
```bash
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
  && mkdir -p ./llmproxy-data && cd ./llmproxy-data \
  && curl -fL --retry 2 -o llmproxy \
     "https://github.com/khc8655/ocrprox2/releases/latest/download/llmproxy-linux-${ARCH}" \
  && chmod +x ./llmproxy \
  && ADMIN_PASSWORD="your_strong_admin_pass" CONFIG_DIR="$(pwd)/config" \
     ./llmproxy --role=full --addr="[::]:8000"
```

> 免安装模式的进程随终端退出而停止，适合验证与调试；长期运行请用下面的一键安装或 Docker。

---

---

#### 方式三：Docker 容器部署

官方镜像发布在 GitHub Container Registry，基于 `scratch` 构建，仅打包静态二进制 + CA 证书 + tzdata（约 **12.8 MB**），支持 `linux/amd64` 与 `linux/arm64` 双架构：

```
ghcr.io/khc8655/ocrprox2:latest        # main 分支最新构建
ghcr.io/khc8655/ocrprox2:v20261119-04  # 指定版本（生产建议固定版本号）
```

**1. 极简节点 (`lite`)——零落盘，无需数据卷**：
```bash
docker run -d --name llmproxy-lite --restart unless-stopped \
  -p 8787:8787 \
  -e LLMPROXY_ROLE=lite \
  -e LLMPROXY_HUB_URL="https://your-hub.edgeone.app" \
  -e LLMPROXY_NODE_TOKEN="stk_node_example_node_token_48chars_long_placeholder" \
  -e LLMPROXY_CLIENT_KEY="sk-llmproxy-client-example-key" \
  ghcr.io/khc8655/ocrprox2:latest
```

**2. 完整节点 (`full`)——挂载数据卷持久化配置**：
```bash
mkdir -p "$(pwd)/llmproxy-data" && docker run -d --name llmproxy-full --restart unless-stopped \
  -p 8787:8787 \
  -v "$(pwd)/llmproxy-data:/data" \
  -e LLMPROXY_ROLE=full -e CONFIG_DIR=/data \
  -e ADMIN_PASSWORD="your_strong_admin_pass" \
  -e LLMPROXY_HUB_URL="https://your-hub.edgeone.app" \
  -e LLMPROXY_NODE_TOKEN="stk_node_example_node_token_48chars_long_placeholder" \
  ghcr.io/khc8655/ocrprox2:latest
```

> **注意（实测踩坑）**：数据卷目录必须**先创建**再挂载，否则 Docker 会以 root 属主创建它。镜像默认以 root 运行以保证 bind mount 可写；若需最小权限运行，可加 `--user "$(id -u):$(id -g)"`（镜像内置 `llmproxy` 账户 UID/GID 10001）。

**运维要点**：
- 升级：`docker pull ghcr.io/khc8655/ocrprox2:latest && docker rm -f llmproxy-full` 后用原命令重建（数据卷保留）；
- 查看日志：`docker logs -f llmproxy-full`（容器内同时写入 `/data/app.log`）；
- 卸载：`docker rm -f llmproxy-full`，删除数据卷目录即彻底清理；
- 健康检查：`curl http://127.0.0.1:8787/healthz`。

---

### 6.3 GitHub Actions 自动化 CI/CD

本仓库已配置完善的 GitHub Actions 工作流（[`.github/workflows/ci-release.yml`](.github/workflows/ci-release.yml)）：
- **每次 Push (`main`) 与 Pull Request**：自动触发 `verify-gates` 任务，运行 G1~G6 全量门禁（T1 契约守卫、EdgeOne Hub 单测、Go `-race` 并发竞争检测、T3 真实进程黑盒 E2E、敏感私钥与凭据扫描）；
- **推送版本 Tag (`v*` 如 `v20261119-04`)**：自动交叉编译全架构 Linux (amd64 / arm64) 与 macOS (arm64) 静态二进制，生成 SHA256 校验清单，并通过 `softprops/action-gh-release@v2` 自动发布至 GitHub Releases；
- **容器镜像发布（`docker-release` job）**：分 `linux/amd64` 与 `linux/arm64` 构建推送到 `ghcr.io/khc8655/ocrprox2`，再用 `docker/buildx imagetools` 组装多架构 manifest——`main` 分支推 `latest` 标签，`v*` Tag 推版本号标签。
