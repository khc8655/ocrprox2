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
