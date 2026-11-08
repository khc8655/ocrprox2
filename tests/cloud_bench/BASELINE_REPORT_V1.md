# Instabox 云端 Linux VM 真实黑盒压测基线报告（1 代 Python ocrprox）

> **测试执行环境**：Instabox 云端专属 VM (`llmproxy-lab`)  
> **操作系统**：Debian 13 (Trixie) amd64 · 内核 `6.18.60-instabox` · 4 vCPU · 8 GiB 物理内存  
> **容器运行时**：Docker 29.8.2（Linux cgroups v2 内存硬限制）  
> **Python 运行栈**：CPython 3.13.5 + FastAPI + Uvicorn + uvloop  
> **测试执行时间**：2026-11-08  
> **执行脚本**：`/data/home/bench/benchmark_runner.sh` & `tests/cloud_bench/chaos_harness.py`

---

## 一、 1 代 Python (`ocrprox`) 云端实测全景指标

### 1. 硬件级内存水位线（Linux `/proc/<pid>/status`）

| 指标项 | 1 代 Python (`ocrprox`) 实测值 | 极限 NAT 容器 (64MB) 表现 | 关键架构诊断与瓶颈分析 |
|---|---|---|---|
| **启动空载物理内存 (`VmRSS`)** | **`62,692 KB` (~61.2 MB)** | 接近 64MB 警戒线（占容器 95.6% 容量） | Python 运行时解释器 + `cryptography` + `pydantic` + `fastapi` 导入开销巨大，启动即逼近 64MB。 |
| **50 并发 SSE 流式压测峰值 (`VmHWM`)** | **`74,036 KB` (~72.3 MB)** | 触发轻度内存换页与延迟上升 | 协程上下文与连接缓冲导致常驻物理内存增加约 11MB。 |
| **5 路并发大载荷峰值 (`VmHWM`)** | **`202,392 KB` (~197.6 MB)** | **瞬间 OOM-Killed (Exit Code 137)** | `bytearray` 缓冲 + `json.loads` 字符串对象 + 字典深拷贝，内存瞬间暴涨至近 200MB。 |
| **测试后驻留内存 (`VmRSS`)** | **`71,496 KB` (~69.8 MB)** | — | Python 内存分配器（pymalloc）持有的内存碎片无法及时完全归还 OS。 |
| **开启文件句柄数 (`FDs`)** | **15** | 15 | 连接复用良好，无明显 FD 句柄泄漏。 |

---

## 二、 极限 64MB 容器生存测试（NAT 小鸡场景实证）

在云端 VM 执行严格限制 64MB 内存与 0 Swap 的容器化生存压测：
```bash
docker run -m 64m --memory-swap 64m --network host python:3.13-slim ...
```

### 实测结果
1. **轻载阶段（50 路并发 SSE 流）**：
   - 容器勉强存活，但吞吐量明显从 Host 的 312.6 RPS 降至 254.89 RPS，延迟中位数由 138ms 恶化至 171ms（Linux cgroup 处于极限压力）。
2. **大载荷并发阶段（5 路并发 8MB 载荷，共 40MB 入站流量）**：
   - **容器进程立刻被 Linux 内核 cgroups v2 OOM-Killer 强行击杀！**
   - **退出码**：`ExitCode: 137` (`SIGKILL`)
   - **Docker 审计**：`OOMKilled: true`
   - **结论**：**1 代 Python 架构在物理内存硬限制 64MB 的极限 NAT 环境下，无法抵御任何突发并发大载荷！**

---

## 三、 吞吐量与尾延迟基线（Host Linux VM 模式）

通过 `tests/cloud_bench/chaos_harness.py` 对 1 代网关进行 50 并发、100 次长连接 SSE 请求压测：

- **有效吞吐量 (RPS)**：`312.60 req/s`
- **首字时间 (TTFT P50)**：`88.74 ms`
- **首字时间 (TTFT P95)**：`104.31 ms`
- **首字时间 (TTFT P99)**：`118.92 ms`
- **总处理延迟 (Latency P50)**：`138.17 ms`
- **总处理延迟 (Latency P95)**：`163.62 ms`
- **总处理延迟 (Latency P99)**：`164.03 ms`
- **成功率**：`100 / 100` (100%)

---

## 四、 混沌故障注入实测行为

在云端 VM 模拟真实生产环境的 5 种故障模式，1 代 Python 网关表现如下：

1. **`rate_limit_first_key`（首把 Key 429 限流）**：
   - 行为：网关捕捉到 `chaos_prov:k1` 返回的 429，在 4049.71 ms 内自动重试并故障转移至 `k2`，客户端收到 `200 OK` 正常流。
   - 耗时原因：1 代调度器带有指数退避休眠（2s + 2s）。
2. **`stream_200_embedded_error`（HTTP 200 但流内首包报错）**：
   - 行为：1 代网关成功通过流式首包 Peek 机制捕获首包 `code: 503`，拦截后向客户端隐藏了该错误，并无缝重试后续 Key 成功返回（耗时 `43.74 ms`，`leaked_error: false`）。
3. **`bad_client_payload_400`（连续客户端参数错误）**：
   - 行为：网关如实向前透传 400 状态码，且随后的正常请求能立刻恢复响应（`recovered_on_next_request: true`），未发生 Key 被误判冷却。
4. **`large_ocr_20mb` / 大载荷保护**：
   - 行为：在 Agent 模式下，1 代通过 `_MAX_JSON_BODY_BYTES = 10MB` 门禁，直接在读取 body 前返回 `413 Request body too large`；但在 8MB 大小以内的并发请求中，内存会暴涨至 197MB。

---

## 五、 2 代 Go 对标就绪状态

1. **云端实验室就绪**：
   - VM `llmproxy-lab` 运行状态正常；
   - Mock EdgeOne Hub (`:19001`) 与 Chaos Mock Upstream (`:19002`) 处于就绪状态；
   - `/data/home/bench/benchmark_runner.sh` 已编写完成，内置 2 代 Go 二进制自动探测机制（检测到 `/data/home/bench/llmproxy2` 即可自动执行完整 Lite / Full / 64MB 容器测试并生成对比）。
2. **待接入步骤**：
   - 当 `dist/llmproxy-linux-amd64` 编译生成后，只需执行：
     ```bash
     instabox push llmproxy-lab /Users/xk/Documents/llmproxy2/dist/llmproxy-linux-amd64 /data/home/bench/llmproxy2
     instabox exec llmproxy-lab --cwd /data/home/bench -- './benchmark_runner.sh'
     ```
   - 即可瞬间生成 1 代 Python vs 2 代 Go 物理内存（预期 62MB -> <15MB）、容器生存（预期 OOM -> 零 OOM）、吞吐与延迟同场残酷对标数据！
