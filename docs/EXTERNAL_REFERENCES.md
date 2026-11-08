# 外部权威文档与开源许可索引 (External References & Licenses)

> 本文件集中登记 `llmproxy2` 依赖的开源上游仓库、腾讯云 EdgeOne 官方文档与各 AI 厂商协议规范。
> **维护准则**：收到新官方文档或上游变更时先更新本表，再同步修改相关规范文档。

最后核对日期：2026-11-08

---

## 一、 核心参考与代码复用开源项目

| 项目 | 仓库地址 | 许可证 | 本项目复用范围与说明 |
|---|---|---|---|
| **yetone/magpie** | https://github.com/yetone/magpie | **MIT License**<br>`Copyright (c) 2026 yetone` | **冻结级底层标准库微模块复用源（经 734 版本 0 缺陷审计）**：<br>1. 原封不动静态搬运（共约 1,880 行）：`internal/netguard` + `image_fetch_guard.go` (SSRF + DNS Pinning)、`internal/steady`、`internal/lastgood`、`internal/filelock`、`internal/filememo`、`internal/backup/crypto.go` (PBKDF2+AES-GCM)、`internal/gateway/{readonly,sse}.go`、`internal/applog/applog.go` (20行 `scrub` 脱敏 + 5MB 双文件轮转)；<br>2. 核心结构/算法借鉴：`internal/gateway/gemini_schema.go` (Schema递归清洗)、`internal/gateway/trace.go` (`traceKeep=60` 故障转移轨迹回放)、`internal/usage` (`usage.jsonl` 追加账本与按时区聚合)、`internal/access` (SHA-256 常量时间比对)、`forbiddenAlike` 同错免误封思想。<br>详见 [`docs/MAGPIE_REUSE_MATRIX.md`](file:///Users/xk/Documents/llmproxy2/docs/MAGPIE_REUSE_MATRIX.md)。 |
| **khc8655/ocrproxy (1 代)** | 本地 `/Users/xk/Documents/ocrprox` | 内部自有项目 | **核心业务模型与契约源（80% 业务主体）**：<br>EdgeOne Vault Hub 密钥隔离模型、`shared/admin` 单一前端源码、`shared/presets/*.json` 16 家厂商声明式适配规则、`gemini_compat.py` (374行)、`scheduler.py` (300s 预算 + 三级冷却 + 流式首包 Peek)、`shared/config/settings.schema.json`、Agent/KB 双模与时段自动切换器、20MB 预读信号量零拷贝流式 OCR 队列、MiniMax Code Plan OAuth Device Flow。 |
| **New API (主从节点概念参考)** | https://docs.newapi.pro/zh/docs/installation/deployment-methods/cluster-deployment | 文档参考 | 仅参考其“中心管配置、边缘节点只读转发”的拓扑理念，并将传统轮询改造为适合 Serverless 计费的 `Lazy-Once + Lease + 304` 零轮询模型。 |

### `yetone/magpie` MIT 许可证原文（随二进制 `//go:embed` 分发）

```text
MIT License

Copyright (c) 2026 yetone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 二、 腾讯云 EdgeOne Makers 官方文档

| 主题 | 官方文档链接 | 关联架构决策 |
|---|---|---|
| Makers 平台概览 | https://cloud.tencent.com/document/product/1552/127415 | `edgeone-hub/` 站点部署拓扑 |
| 边缘函数 Runtime APIs · Fetch 限制 | https://cloud.tencent.com/document/product/1552/81897 | 解释为何 2 代彻底移除 EdgeOne `/v1/*` 推理中转（规避单次调用并发 8 / 总数 64 Fetch 限制与流式超时） |
| `edgeone.json` 配置规范 | https://cloud.tencent.com/document/product/1552/127389 | `edgeone-hub/edgeone.json` 路由表定义 |
| 日志分析与可观测性 | https://cloud.tencent.com/document/product/1552/127413 | EdgeOne 侧日志统一在腾讯云 Makers 控制台查看，不在管理 UI 重复存储错误日志 |

---

## 三、 上游 AI 厂商协议与预设映射索引

| 协议 / 厂商 | 官方 API 文档 | 预设与协议层落点 |
|---|---|---|
| OpenAI Chat & Responses | https://platform.openai.com/docs/api-reference | `internal/adapters/rules.go` + `shared/presets/openai.json` |
| Anthropic Messages | https://docs.anthropic.com/en/api | `internal/adapters/rules.go` + `internal/upstream/url.go` |
| Google Gemini API | https://ai.google.dev/gemini-api/docs | `internal/adapters/gemini.go` + `shared/presets/google.json` |
| Google Cloud Vertex AI | https://cloud.google.com/vertex-ai/generative-ai/docs | `internal/adapters/gemini.go` + `shared/presets/vertex.json` |
| MiniMax (含 Code Plan OAuth) | https://platform.minimaxi.com/document | `internal/oauth/` + `shared/presets/minimax.json` |
| DeepSeek | https://api-docs.deepseek.com/ | `shared/presets/deepseek.json` |
| SiliconFlow 硅基流动 | https://docs.siliconflow.cn/ | `shared/presets/siliconflow.json` |
| StepFun 阶跃星辰 | https://platform.stepfun.com/docs | `shared/presets/stepfun.json` |
| NVIDIA NIM | https://docs.api.nvidia.com/nim/ | `shared/presets/nvidia.json` |
| OpenRouter | https://openrouter.ai/docs | `shared/presets/openrouter.json` |
| Cline | https://docs.cline.bot/api/overview | `shared/presets/cline.json` |
