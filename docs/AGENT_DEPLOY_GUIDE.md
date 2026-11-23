# Agent 接入指南（Hub API 与节点部署）

> **这份文档的唯一用途**：交给一个 AI agent 或脚本，让它能够 **自动化地在远程 VM 上部署 LLMProxy2 节点**。
> 所有命令与字段均按当前实现核对，可直接执行；不需要读其它文档。
>
> 版本基准：`v20261122-03 / 2.9.0` ｜ 最后核验：2026-11-22

---

## 0. 你需要知道的四件事

1. **Hub 是配置中枢**（默认 `https://key.khc6.cn`）。它持有供应商与 Key，向节点下发配置投影。
2. **签发节点需要 Hub 管理员密码**（这份文档里记作 `<HUB_ADMIN_PASSWORD>`，通过 `Authorization: Bearer` 传递）。
3. **节点运行不需要管理员密码**，它只需要一个 `stk_node_*` 令牌去 Hub 拉配置。
4. **安装只需一条命令**，脚本和二进制都从公网 HTTPS 获取。

---

## 1. 最短路径（3 步）

```bash
HUB="https://key.khc6.cn"
ADMIN="<HUB_ADMIN_PASSWORD>"      # 仅签发时需要

# ① 签发节点 —— 唯一需要管理员密码的调用
curl -sS -X POST "$HUB/api/admin/nodes" \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "vm-01",
        "role": "lite",
        "lease_ttl": 86400,
        "grace_ttl": 3600,
        "scope": { "models": ["*"], "providers": ["*"] }
      }'

# ② 从响应里取出 install_command（一次调用即可拿到可直接执行的命令）
#    响应：{"ok":true,"node":{...},"node_token":"stk_node_...","client_key":"sk-...",
#           "bootstrap_env":"...","install_command":"curl -fsSL ... | bash -s -- ..."}

# ③ 把 install_command 原样在目标 VM 上执行（需要 root/sudo）
```

`install_command` 已包含角色、中枢地址、节点令牌、客户端 Key 与端口，**不要自行改写**。

---

## 2. 完整 API 参考

所有端点均在 Hub 域名下；除特别说明外，响应均为 JSON，成功时含 `"ok": true`。

### 2.1 鉴权

| 调用方 | 请求头 | 用途 |
|---|---|---|
| 管理员（你/你的面板） | `Authorization: Bearer <HUB_ADMIN_PASSWORD>` | 签发/管理节点、读写配置 |
| 节点（VM 上运行的进程） | `Authorization: Bearer stk_node_<48hex>` | 仅拉取自己的配置投影 |

- 管理员密码等同全局权限，**只应存在于你的面板后端**，绝不下发到 VM。
- 节点令牌权限严格受限，见 §2.5。

### 2.2 签发节点

```
POST /api/admin/nodes
Authorization: Bearer <HUB_ADMIN_PASSWORD>
Content-Type: application/json
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 节点名，建议用 VM 主机名或固定前缀，便于识别 |
| `role` | string | 是 | `lite` 或 `full`（区别见 §3.1） |
| `lease_ttl` | integer | 否 | 租约秒数，默认 `86400` |
| `grace_ttl` | integer | 否 | 断网宽限秒数，默认 `3600` |
| `scope.models` | string[] | 否 | 允许下发的模型；`["*"]` 表示全部 |
| `scope.providers` | string[] | 否 | 允许下发的供应商；`["*"]` 表示全部 |

响应字段：

| 字段 | 说明 |
|---|---|
| `node.id` | 节点 ID，后续 PATCH/DELETE 用 |
| `node_token` | **一次性返回**的明文令牌（`stk_node_` + 48 hex） |
| `client_key` | 客户端 API Key，VM 上的调用方用它访问 `/v1/*` |
| `bootstrap_env` | 一行环境变量，适合注入 systemd/docker |
| `install_command` | 一行可直接执行的安装命令 |

> **令牌不可反查**：Hub 只存 SHA-256 摘要。丢了就轮换（§2.4），旧令牌立即失效。

### 2.3 重新获取安装命令（已存在的节点）

> **部署状态**：该接口随节点安装 UX 一起交付，**当前线上 Hub（`v20261121-02`）尚未包含**，调用会返回 `404`。发布后按下面用法。

```
GET /api/admin/nodes/:id/install-command
Authorization: Bearer <HUB_ADMIN_PASSWORD>
```

- 返回体同上（含新的 `node_token` 与 `install_command`），响应头带 `cache-control: no-store`。
- **注意**：该调用会**轮换令牌**，正在运行的节点会立刻失去授权。仅在（重新）部署该节点时使用。

**为已有节点重建安装命令（当前线上即可用）**：`rotate` 已同时返回 `install_command`，无需自行拼装：

```bash
curl -sS -X POST "$HUB/api/admin/nodes/$NODE_ID/rotate" \
  -H "Authorization: Bearer $ADMIN"
# → {"ok":true,"node_token":"stk_node_...","client_key":"sk-...",
#    "bootstrap_env":"...","install_command":"curl -fsSL ... | bash -s -- ..."}
```

> 同样会轮换令牌（旧令牌立即失效，`/api/node/config` 返回 `401 node_revoked_or_invalid`），因此只在该节点要重新部署时调用。

### 2.4 其它节点操作

| 操作 | 请求 |
|---|---|
| 列表 | `GET /api/admin/nodes` → `{"ok":true,"nodes":[...]}` |
| 改配置/停用/恢复 | `PATCH /api/admin/nodes/:id`，body 可含 `name`/`role`/`enabled`/`lease_ttl`/`grace_ttl`/`scope` |
| 轮换令牌 | `POST /api/admin/nodes/:id/rotate` → 返回新 `node_token` |
| 删除 | `DELETE /api/admin/nodes/:id` |

### 2.5 节点自己用的端点（你通常不用调）

```
POST /api/node/config
Authorization: Bearer stk_node_<48hex>
If-None-Match: "<etag>"        # 可选，命中返回 304 零载荷
```

- 返回本节点 scope 内的供应商/Key/路由投影，附 `ETag`、`X-Lease-Until`、`X-Grace-Until`。
- 节点因此**零轮询**：租约内不重复请求，到期才续租。

**令牌能力边界（实测）**：

| 能力 | `lite` 令牌 | `full` 令牌 |
|---|---|---|
| 拉配置投影 `/api/node/config` | ✅ | ✅ |
| 心跳上报 `/api/node/heartbeat`（`204` 无 body、不返回配置；60s 服务端去抖） | ✅ | ✅ |
| 取明文 Key `/api/vault/manifest`、`/api/vault/fetch` | ❌ `403` | ✅（限 scope 内） |
| 任何 `/api/admin/*` | ❌ `401` | ❌ `401` |

> 即：**只想中转就用 `lite`**，令牌即使泄露也拿不到明文 Key。

> **full 节点的中枢内容按需拉取（v2.9.0 起，无一键全量同步）**：full 令牌先取 `/api/vault/manifest` 清单（供应商元数据 + Key 标签 + 路由模板，绝无明文）→ 需要哪个供应商就整体拉取哪个（适配规则 + 全部 Key，`POST /api/vault/fetch`），缺哪个 Key 标签就按标签补拉；模型路由一律本地创建，也可从清单模板按需导入，一条不用也可以。拉取目标恒为节点已配置的 Vault（不接受调用方传入的 hub_url/node_token）。

---

## 3. 部署方式（三选一）

`install_command` 默认给的是方式 A。三者都已在真实 VM 上验证。

### 3.1 先选角色

| | `lite` | `full` |
|---|---|---|
| 形态 | 纯内存中转，**零落盘** | 完整网关 + 本地 Web 管理端 |
| 配置文件 | 不写任何文件 | 本地 AES-256-GCM 加密（`proxy_config.enc`） |
| 断电/重启 | 重新从 Hub 拉取 | 离线可用，本地为准 |
| 能否看明文 Key | 不能 | 能（可直接调 vault） |
| 典型场景 | NAT 小鸡、只做转发 | 主力主机、要本地管理和 KB |

### 3.2 方式 A：一键安装（systemd，推荐生产）

```bash
curl -fsSL "$HUB/install.sh" | sudo bash -s -- \
  --role=lite \
  --hub-url="$HUB" \
  --node-token="stk_node_..." \
  --client-key="sk-..." \
  -p 8787 -y
```

- 自动识别 `amd64`/`arm64`，从 GitHub Releases 下载二进制并校验 `SHA256SUMS`。
- 安装后：`/usr/local/bin/llmproxy`，systemd 服务 `llmproxy-lite` / `llmproxy-full`。
- `full` 角色额外需要 `--admin-pass="<强密码>"`（否则随机生成并打印一次）。
- 运维：`llmproxy-ctl status | log | restart | upgrade | uninstall [-y] [--keep-config]`。
- 支持 `--version=<tag>` 固定版本、`--mirror=<url>` 走镜像加速。
- 已适配非特权 LXD/Docker 容器（自动降级 systemd 的 namespace 加固）。

**监听范围 `--bind`（安装时二选一，默认 `local`）**：

| 取值 | 写入的 `LLMPROXY_ADDR` | 谁能连 |
|---|---|---|
| `local`（默认） | `127.0.0.1:<port>` | 仅本机；对外发布由你自己用 nginx / caddy 反代或 `ssh -L` |
| `public` | `[::]:<port>` | 任何能到达该主机的客户端（IPv4 + IPv6 双栈） |

- 脚本**不探测、也不打印外部 IP**；端口如何暴露不属于程序职责。
- 已安装的服务再次执行脚本会走平滑升级，`--bind` 会改写监听地址并重启，可在两模式间随时切换。
- 判断是否对外可达只看 `ss -ltn`：`127.0.0.1:PORT` = 仅本机，`*:PORT` = 对外。
- 传错值会立即报错退出：`--bind 参数必须为 'local' 或 'public'`。

### 3.3 方式 B：Docker

```bash
# lite（零落盘，不需要数据卷）
docker run -d --name llmproxy-lite --restart unless-stopped \
  -p 8787:8787 \
  -e LLMPROXY_ROLE=lite \
  -e LLMPROXY_HUB_URL="$HUB" \
  -e LLMPROXY_NODE_TOKEN="stk_node_..." \
  -e LLMPROXY_CLIENT_KEY="sk-..." \
  ghcr.io/khc8655/ocrprox2:latest

# full（挂载数据卷；目录必须先建，否则 Docker 会以 root 创建）
mkdir -p ./llmproxy-data && docker run -d --name llmproxy-full --restart unless-stopped \
  -p 8787:8787 -v "$(pwd)/llmproxy-data:/data" \
  -e LLMPROXY_ROLE=full -e CONFIG_DIR=/data \
  -e ADMIN_PASSWORD="<强密码>" \
  -e LLMPROXY_HUB_URL="$HUB" -e LLMPROXY_NODE_TOKEN="stk_node_..." \
  ghcr.io/khc8655/ocrprox2:latest
```

- 镜像基于 `scratch`，约 12.8 MB，支持 `amd64` + `arm64`。
- 生产建议固定版本标签（如 `:v20261121-02`）而非 `:latest`。

### 3.4 方式 C：单行直跑（免安装，调试用）

```bash
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
  && mkdir -p ./llmproxy-data && cd ./llmproxy-data \
  && curl -fL --retry 2 -o llmproxy \
     "https://github.com/khc8655/ocrprox2/releases/latest/download/llmproxy-linux-${ARCH}" \
  && chmod +x ./llmproxy \
  && LLMPROXY_ROLE=lite \
     LLMPROXY_HUB_URL="$HUB" \
     LLMPROXY_NODE_TOKEN="stk_node_..." \
     LLMPROXY_CLIENT_KEY="sk-..." \
     ./llmproxy --addr="[::]:8787"
```

无开机自启，关终端即停。

---

## 4. 部署后验证（agent 必须做）

```bash
# ① 进程活着且角色正确
curl -s http://127.0.0.1:8787/healthz
# 期望：{"role":"lite","state":"waiting_first_request","status":"standby",...}

# ② 触发首次拉取（lite 才会去 Hub 取配置）
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <CLIENT_KEY>" http://127.0.0.1:8787/v1/models
# 期望 200

# ③ 再次确认已激活
curl -s http://127.0.0.1:8787/healthz
# 期望：state 变为 "ready"，config_version > 0，lease_valid: true

# ④ 真实推理（用 scope 内的任一模型）
curl -s -H "Authorization: Bearer <CLIENT_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"<MODEL>","messages":[{"role":"user","content":"1+1=?"}],"max_tokens":16}' \
  http://127.0.0.1:8787/v1/chat/completions
# 期望 200 且 choices[0].message.content 非空
```

`healthz` 状态含义：

| `state` | 含义 | 处理 |
|---|---|---|
| `waiting_first_request` | 尚未拉取配置（正常初态） | 发一次 `/v1/models` 触发 |
| `ready` | 已激活，可服务 | 正常 |
| `stale` / `degraded` | 租约过期，宽限期内仍可服务 | 下一个请求会自动续租 |
| `revoked` | 节点被停用/删除 | 需重新签发，节点已清空内存 Key |
| `no_config` | full 节点尚无本地配置 | 需初始化配置 |

---

## 5. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `healthz` 一直 `waiting_first_request` | 未发过请求（lite 懒加载） | 发一次 `/v1/models` |
| 请求返回 `503 hubsync: node token unauthorized or revoked` | 令牌失效/节点被停用 | 重新签发或启用节点 |
| `503 hub unavailable and grace period expired` | 中枢不可达且宽限耗尽 | 检查 VM 出网、`--hub-url` |
| 返回 `403 lite node tokens cannot access vault endpoints` | 用 lite 令牌调 vault | 设计如此；需要明文 Key 请用 `full` |
| 签发后立刻用令牌调 Hub 偶发 `401` | EdgeOne KV 最终一致性抖动 | 等 1–3 秒重试，不是故障 |
| Docker 报 `permission denied` 执行二进制 | 用了 v20261119-03 之前的镜像 | 升级镜像（≥ `v20261119-04`） |
| `docker run` 后卷目录属主是 root | 未先创建目录 | 先 `mkdir -p` 再挂载 |

---

## 6. Agent 执行检查清单

```
[ ] 已确认目标 VM：架构（amd64/arm64）、是否有 root/sudo、能否出网到 Hub
[ ] 已选择 role：只要转发 → lite；要本地管理/KB → full
[ ] 已确认监听范围：仅本机（默认 `--bind=local`）还是直接对外（`--bind=public`）
[ ] scope 已按用途收窄（不要无条件 ["*"]）
[ ] 已调 POST /api/admin/nodes 拿到 node_token / client_key / install_command
[ ] 已在 VM 上执行 install_command（root）
[ ] 已跑完 §4 的 4 步验证（healthz → /v1/models → ready → 真实推理）
[ ] 已记录 node.id 与部署方式，供后续升级/回滚
[ ] 未把 <HUB_ADMIN_PASSWORD> 写入 VM 或日志
```

---

## 7. 安全硬性要求

1. **管理员密码只留在你的面板后端**，不进 VM、不进日志、不进命令历史。
2. **`node_token` 与 `client_key` 会出现在 `install_command` 里**：执行命令时避免 `set -x`、避免把完整命令回显到不可信日志。
3. **一个 VM 一个令牌**，不要多机共用一个 `stk_node_*`。
4. 卸载/下线 VM 时**删除节点**（`DELETE /api/admin/nodes/:id`），令牌随之失效。
5. 怀疑泄露：立刻 `POST /api/admin/nodes/:id/rotate` 轮换。

---

## 8. 附：环境变量速查

| 变量 | 作用 |
|---|---|
| `LLMPROXY_ROLE` | `lite` / `full` |
| `LLMPROXY_ADDR` | 监听地址：`127.0.0.1:8787`（仅本机，默认）/ `[::]:8787`（双栈对外） |
| `LLMPROXY_HUB_URL` | Hub 地址 |
| `LLMPROXY_NODE_TOKEN` | 节点令牌 |
| `LLMPROXY_CLIENT_KEY` | 客户端 API Key |
| `ADMIN_PASSWORD` | 仅 `full`：本地管理端登录密码 |
| `CONFIG_DIR` | 仅 `full`：配置目录（Docker 下为 `/data`） |
| `GOMEMLIMIT` | Go 内存软上限，NAT 小机建议 `48MiB` |
| `ALLOW_PRIVATE_IPS` | 允许上游为私网地址（默认拒绝，测试 mock 时用 `true`） |