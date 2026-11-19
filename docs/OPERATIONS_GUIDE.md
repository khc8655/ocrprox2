# 运维与部署手册 (Operations Guide — Hub / NAT Lite / Full)

> 本手册涵盖 `llmproxy2` 三种运行形态的部署、NAT VM 专项调优、节点签发/吊销与故障排查。

---

## 一、 EdgeOne Makers 轻中枢部署（Role: `hub`）

### 1.1 环境变量与 KV 绑定
在腾讯云 EdgeOne Makers 控制台创建站点并配置：
- **KV 命名空间绑定**：绑定变量名 `agent_kv`（用于存储供应商/Key、预设缓存与 `relay_nodes` 节点注册表）。
- **环境变量**：
  - `ADMIN_PASSWORD`：管理端登录强密码（必填，未配置时所有管理接口返回 `503`）。

### 1.2 日常操作：签发与注销 VM 节点
1. 登录 EdgeOne 管理控制台 `https://<your-hub-domain>/admin`；
2. 在 **「供应商与密钥 (Vault Hub)」** 页维护上游供应商与 API Key（需要下发给节点的 Key 保持默认共享状态，仅中枢自用的标记为 `本地私有 Key`）；
3. 进入 **「中转节点 (Relay Nodes)」** 页：
   - **签发节点**：点击「新建节点」，选择角色 `lite`（NAT 小鸡）或 `full`，勾选允许该节点使用的供应商与模型 Scope，设置 `lease_ttl`（默认 `86400` 秒 = 24h），复制一次性生成的 `stk_node_...` Token 与启动命令；
   - **紧急注销/吊销**：若某台借用的 NAT VM 不再使用或疑似环境不安全，点击该节点右侧「注销/禁用」，状态立即变为 `disabled`。

---

## 二、 NAT VM 极简节点部署（Role: `lite`）

专为 **低内存（64MB ~ 256MB）、共享 IPv4 端口映射 / 纯 IPv6、不可信磁盘** 的 NAT 小鸡设计。

### 2.1 一键启动（无配置文件、纯环境变量）

将静态编译好的 `llmproxy-linux-amd64`（或 `arm64`）上传至 `/usr/local/bin/llmproxy` 并赋予可执行权限（`chmod +x /usr/local/bin/llmproxy`）：

```bash
LLMPROXY_ROLE=lite \
LLMPROXY_ADDR="[::]:8000" \
LLMPROXY_HUB_URL="https://your-hub.edgeone.app" \
LLMPROXY_NODE_TOKEN="stk_node_9f8e7d6c5b4a..." \
LLMPROXY_CLIENT_KEY="sk-llmproxy-client-secret-xxx" \
/usr/local/bin/llmproxy
```

> **NAT VM 端口与双栈说明**：
> - `LLMPROXY_ADDR="[::]:8000"` 默认启用 `IPV6_V6ONLY=0` 双栈监听，同时接收 NAT 映射进来的 IPv4 流量（如 `公网IPv4:34567 -> 内网:8000`）与公网 IPv6 直连流量；
> - 若 NAT VM 出站存在 IPv6 路由黑洞，内置的 `internal/upstream/transport.go`（基于 Go 标准库 RFC 6555 Happy Eyeballs `FallbackDelay: 300ms` + `netguard` 多 IP Pinning）会在 300ms 内自动无缝回退至 IPv4 出站，无需手动修改系统 `gai.conf` 或禁用 IPv6。

### 2.2 Systemd 最高安全级别只读加固配置（推荐）

创建 `/etc/systemd/system/llmproxy-lite.service`，从操作系统层锁死**零落盘、禁 Core Dump、只读根文件系统**：

```ini
[Unit]
Description=LLMProxy2 Lite Node (Zero-Disk In-Memory Relay)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
Environment="LLMPROXY_ROLE=lite"
Environment="LLMPROXY_ADDR=[::]:8000"
Environment="LLMPROXY_HUB_URL=https://your-hub.edgeone.app"
Environment="LLMPROXY_NODE_TOKEN=stk_node_replace_me"
Environment="LLMPROXY_CLIENT_KEY=sk-llmproxy-replace_me"
Environment="GOMEMLIMIT=48MiB"
ExecStart=/usr/local/bin/llmproxy
Restart=always
RestartSec=3

# 内存与零落盘强制加固
LimitCORE=0
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
MemoryDenyWriteExecute=yes

[Install]
WantedBy=multi-user.target
```

> **低内存调优提示**：在 64MB 内存的极限 NAT VM 上，通过设置 Go 标准环境变量 `GOMEMLIMIT=48MiB`，Go 运行时 GC 会在内存接近 48MB 时主动高频回收，彻底杜绝 Linux OOM Killer 杀进程！

### 2.3 极简节点运维操作
- **查看健康状态**：`curl http://127.0.0.1:8000/healthz`
  - 启动未收到请求时：`{"status":"standby","role":"lite","state":"waiting_first_request","lease_valid":false}`
  - 正常服务中：`{"status":"ok","role":"lite","state":"active","lease_valid":true,"config_version":137}`
  - 被中枢注销后：`{"status":"stopped","role":"lite","state":"revoked","lease_valid":false}`
- **手动触发立即刷新配置（不等租约到期）**：
  ```bash
  curl -X POST http://127.0.0.1:8000/v1/models \
    -H "Authorization: Bearer ${LLMPROXY_CLIENT_KEY}" \
    -H "X-Node-Refresh: 1"
  ```

---

## 三、 标准 VM 完整节点部署（Role: `full`）

适用于自有主力云主机，提供 `agent` + `kb` 双模式、20MB 零拷贝流式 OCR 队列、本地加密配置与完整 Web 管理控制台。

### 3.1 启动与环境变量

```ini
# /etc/systemd/system/llmproxy-full.service
[Unit]
Description=LLMProxy2 Full Gateway (Agent + KB + Web Admin)
After=network-online.target

[Service]
Type=simple
User=llmproxy
WorkingDirectory=/opt/llmproxy
EnvironmentFile=/opt/llmproxy/.env
ExecStart=/opt/llmproxy/bin/llmproxy --role=full
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

`/opt/llmproxy/.env` 关键配置项：
```dotenv
LLMPROXY_ROLE=full
LLMPROXY_ADDR=[::]:8000
CONFIG_DIR=/opt/llmproxy/config
ENCRYPT_KEY=<32字节高熵密钥，兼容1代Fernet密钥>
ADMIN_PASSWORD=<管理端强密码>
PROXY_API_KEY=<默认客户端CLIENT_KEY>
```

### 3.2 从 1 代 (`ocrprox`) 平滑升级至 2 代 Full 节点
1. 将 1 代的 `/opt/ocrproxy/config/proxy_config.enc` 与 `.env` 中的 `ENCRYPT_KEY` 直接复制到 `/opt/llmproxy/config/`；
2. 启动 `llmproxy --role=full`：内置的 `internal/crypto` 会自动识别 1 代 Fernet 密文格式并无损解密，首次保存时自动原子升级为 `PBKDF2-SHA256 + AES-256-GCM` 格式。

---

## 四、 Docker 容器部署（`lite` / `full` 通用）

官方镜像基于 `scratch` 构建，仅含静态二进制、CA 证书与 tzdata，约 **12.8 MB**，支持 `linux/amd64` 与 `linux/arm64`：

```
ghcr.io/khc8655/ocrprox2:latest         # main 分支最新构建
ghcr.io/khc8655/ocrprox2:<version>      # 生产建议固定版本，如 v20261119-04
```

> 镜像由 CI 的 `docker-release` job 自动构建推送（G1~G6 门禁通过后执行），无需手工构建。

### 4.1 极简节点（`lite`）：零落盘，不需要数据卷

```bash
docker run -d --name llmproxy-lite --restart unless-stopped \
  -p 8787:8787 \
  -e LLMPROXY_ROLE=lite \
  -e LLMPROXY_HUB_URL="https://your-hub.edgeone.app" \
  -e LLMPROXY_NODE_TOKEN="stk_node_..." \
  -e LLMPROXY_CLIENT_KEY="sk-llmproxy-..." \
  ghcr.io/khc8655/ocrprox2:latest
```

Lite 模式纯内存运行、不写任何配置与日志文件，因此**不要**挂载 `/data`（挂了也只是空目录）。

### 4.2 完整节点（`full`）：挂载数据卷

```bash
mkdir -p "$(pwd)/llmproxy-data" && docker run -d --name llmproxy-full --restart unless-stopped \
  -p 8787:8787 \
  -v "$(pwd)/llmproxy-data:/data" \
  -e LLMPROXY_ROLE=full -e CONFIG_DIR=/data \
  -e ADMIN_PASSWORD="<管理端强密码>" \
  -e LLMPROXY_HUB_URL="https://your-hub.edgeone.app" \
  -e LLMPROXY_NODE_TOKEN="stk_node_..." \
  ghcr.io/khc8655/ocrprox2:latest
```

**必须注意（实测踩坑）**：

| 事项 | 说明 |
|---|---|
| 先建目录再挂载 | 目录不存在时 Docker 会以 `root:root` 创建它；先 `mkdir -p` 可保持宿主用户属主 |
| 默认以 root 运行 | 为让 bind mount 可写，镜像未强制非 root；需要最小权限时加 `--user "$(id -u):$(id -g)"`（镜像内置 `llmproxy` 账户 UID/GID 为 10001） |
| 卷内产物 | `proxy_config.enc`（AES-256-GCM 加密配置）、`app.log`、`usage.jsonl`、`key_bans.json.lock` |

### 4.3 容器运维

```bash
docker logs -f llmproxy-full                       # 实时日志（容器内同时写 /data/app.log）
curl -s http://127.0.0.1:8787/healthz              # 健康检查
docker pull ghcr.io/khc8655/ocrprox2:latest \
  && docker rm -f llmproxy-full                    # 升级：拉新镜像后按原命令重建，数据卷保留
docker rm -f llmproxy-full && rm -rf ./llmproxy-data   # 卸载：含数据
```

> 容器部署不提供 `llmproxy-ctl`（该命令由 `install.sh` 安装到宿主的 systemd 场景）；如需 `upgrade` / `uninstall` 等便捷运维，请使用一键安装方式。
