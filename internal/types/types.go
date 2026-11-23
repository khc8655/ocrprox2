package types

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Role 定义进程运行角色
type Role string

const (
	RoleLite Role = "lite" // NAT VM 极简纯内存节点（零落盘，零管理端）
	RoleFull Role = "full" // 标准 VM 完整节点（统一路由，本地 AES-256-GCM 持久化，内嵌 Web 管理端）
	RoleHub  Role = "hub"  // EdgeOne Makers 轻中枢（由 edgeone-hub/ 实现）
)

// ProxyConfig 100% 兼容 1 代 proxy_config.enc 与 EdgeOne KV 的顶层配置结构
type ProxyConfig struct {
	Version     int64                       `json:"_version"`
	Providers   map[string]*ProviderConfig  `json:"providers"`
	AgentModels map[string]*AgentModelRoute `json:"agent_models"`
	KBModels    map[string][]*KBCandidate   `json:"kb_models,omitempty"` // key: "chat" | "embedding" | "reranker" | "ocr"
	Settings    RuntimeSettings             `json:"settings"`
	Vault       *VaultClientConfig          `json:"vault,omitempty"` // 仅 Full 模式保存中枢连接配置
}

// ProviderConfig 供应商配置（兼容 1 代字段 + Magpie 探活扩展）
type ProviderConfig struct {
	ID               string            `json:"id,omitempty"`
	Name             string            `json:"name,omitempty"`
	PresetID         string            `json:"preset_id,omitempty"`
	APIType          string            `json:"api_type,omitempty"`
	Protocols        []string          `json:"protocols,omitempty"`
	BaseURL          string            `json:"base_url"`
	AnthropicBaseURL string            `json:"anthropic_base_url,omitempty"`
	Enabled          bool              `json:"enabled"`
	Origin           string            `json:"origin,omitempty"` // "vault" (中枢共享) | "local" (仅本端私有，Hub绝不下发)
	RuleHash         string            `json:"rule_hash,omitempty"`
	RPMPerKey        int               `json:"rpm_per_key,omitempty"`
	QuotaResetAt     string            `json:"quota_reset_at,omitempty"`   // Magpie 每日配额重置时间，如 "00:00+08:00"
	HideClientName   bool              `json:"hide_client_name,omitempty"` // 仿 Magpie user-agent 开关：默认 false 透传客户端 User-Agent；开启后隐藏客户端名称
	APIKeys          []*KeyEntry       `json:"api_keys"`
	ModelAliases     map[string]string `json:"model_aliases,omitempty"`
	AdapterRules     *AdapterRules     `json:"adapter_rules,omitempty"`
}

// KeyEntry 单把 API Key 或 OAuth 凭证条目
type KeyEntry struct {
	ID        string     `json:"id,omitempty"` // 稳定短 ID（如未指定则取 label 或 key 指纹前 8 位）
	Label     string     `json:"label"`        // 1 代兼容标签名（如 "hk-pool-01"）
	Key       string     `json:"key"`          // 明文 API Key 或 OAuth AccessToken
	Enabled   bool       `json:"enabled"`
	Remark    string     `json:"remark,omitempty"`
	Weight    int        `json:"weight,omitempty"`
	MaxRPM    int        `json:"max_rpm,omitempty"`
	Origin    string     `json:"origin,omitempty"`    // "vault" | "local"
	AuthType  string     `json:"auth_type,omitempty"` // "api_key" (默认) | "oauth_device"
	OAuthMeta *OAuthMeta `json:"oauth_meta,omitempty"`
}

// OAuthMeta MiniMax Code Plan 等 OAuth 2.0 刷新元数据（仅 Full 模式持久化）
type OAuthMeta struct {
	Provider     string `json:"provider"` // e.g. "minimax"
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresAt    int64  `json:"expires_at"` // Unix 秒
	ClientID     string `json:"client_id,omitempty"`
}

// AgentModelRoute 统一路由模式下的模型路由绑定（兼容 1 代 agent_models 与固定 4 KB 模型槽位）
type AgentModelRoute struct {
	Enabled         bool   `json:"enabled"`
	Origin          string `json:"origin,omitempty"`           // "vault" (中枢同步模板) | "local" (节点本地路由)
	ActiveKey       string `json:"active_key,omitempty"`       // 格式: "{provider}:{key_label}"（sticky_failover 首选粘性 Key）
	RoutingStrategy string `json:"routing_strategy,omitempty"` // 覆盖全局: "sticky_failover" | "round_robin" | "weighted" | "least_busy" | "fast" | "manual"
	NoReasoning     bool   `json:"no_reasoning,omitempty"`     // 强制剥离思考/推理参数（KB RAG chat 推荐开启）
	ForceNonStream  bool   `json:"force_non_stream,omitempty"` // 强制改写 stream=false 非流式输出
	// AllowKeyFallback: 当候选引用的 key_label 被禁用/删除时，回退到同供应商其它启用 Key（默认关闭，保持精确绑定语义）。
	AllowKeyFallback bool              `json:"allow_key_fallback,omitempty"`
	Candidates       []*RouteCandidate `json:"candidates"`
}

// RouteCandidate 模型候选池条目
type RouteCandidate struct {
	Provider    string `json:"provider"`
	KeyLabel    string `json:"key_label"`              // 对应 KeyEntry.Label（为空表示展开该供应商下全部启用 Key）
	TargetModel string `json:"target_model,omitempty"` // 显式指定上游真实模型名（为空则走 ModelAliases 或原名）
	Enabled     bool   `json:"enabled"`
	Weight      int    `json:"weight,omitempty"`          // weighted 策略权重（默认 1）
	MaxConc     int    `json:"max_concurrency,omitempty"` // 单候选软并发阈值（0 表示不限，超限优先分流到其他空闲候选）
}

// KBCandidate 固定高并发通道四分类（chat / embedding / reranker / ocr）兼容候选条目
type KBCandidate struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	KeyLabel string `json:"key_label,omitempty"`
	Enabled  bool   `json:"enabled"`
	MaxRPM   int    `json:"max_rpm,omitempty"`
	MaxConc  int    `json:"max_concurrency,omitempty"`
}

// RuntimeSettings 与 shared/config/settings.schema.json 一一对齐的规范化设置项
type RuntimeSettings struct {
	ClientKey                string `json:"client_key,omitempty"`         // 客户端鉴权密钥 (等同 PROXY_API_KEY)
	ProxyAPIKey              string `json:"proxy_api_key,omitempty"`      // 1 代兼容字段名
	AgentRoutingStrategy     string `json:"agent_routing_strategy"`       // "sticky_failover" | "round_robin" | "weighted" | "least_busy" | "fast" | "manual"
	AgentFirstByteTimeoutSec int    `json:"agent_first_byte_timeout_sec"` // 默认 120
	CooldownRateLimitSec     int    `json:"cooldown_rate_limit_sec"`      // 429 模型级冷却秒数，默认 15
	CooldownServerErrorSec   int    `json:"cooldown_server_error_sec"`    // 5xx 模型级冷却秒数，默认 30
	CooldownNetworkErrorSec  int    `json:"cooldown_network_error_sec"`   // 网络超时冷却秒数，默认 15
	CooldownAuthErrorSec     int    `json:"cooldown_auth_error_sec"`      // 401/402/403 Key 级冷却秒数，默认 86400 (24h)
	OCRMaxInflight           int    `json:"ocr_max_inflight"`             // OCR 预读信号量上限，默认 4
	KBGlobalMaxConcurrency   int    `json:"kb_global_max_concurrency"`    // 固定通道全局并发上限，默认 16
}

// VaultClientConfig Full 节点连接 EdgeOne Hub 的客户端配置
type VaultClientConfig struct {
	URL       string `json:"url"`
	NodeToken string `json:"node_token,omitempty"`
}

// AdapterRules 声明式适配规则（兼容扁平 v2 结构与 1 代 shared/presets/*.json 嵌套结构）
type AdapterRules struct {
	AuthHeader              string            `json:"auth_header,omitempty"`   // 默认 "Authorization"
	AuthPrefix              string            `json:"auth_prefix,omitempty"`   // 默认 "Bearer "；设为 "none" 表示无前缀裸 Key
	ExtraHeaders            map[string]string `json:"extra_headers,omitempty"` // 静态注入头
	StripParams             []string          `json:"strip_params,omitempty"`  // 剥离顶层参数
	RenameParams            map[string]string `json:"rename_params,omitempty"` // 重命名参数
	OverrideParams          map[string]any    `json:"override_params,omitempty"`
	StreamOnly              bool              `json:"stream_only,omitempty"`
	RescueFromText          bool              `json:"rescue_from_text,omitempty"`
	UnwrapRoot              string            `json:"unwrap_root,omitempty"`
	StripReasoningEnabled   bool              `json:"strip_reasoning_enabled,omitempty"`
	GeminiCompat            bool              `json:"gemini_compat,omitempty"`
	ThoughtTagMarker        string            `json:"thought_tag_marker,omitempty"`
	AnthropicStrictSig      bool              `json:"anthropic_strict_signature,omitempty"`
	AnthropicPassbackReq    bool              `json:"anthropic_passback_required,omitempty"`
	DenyDeveloperRole       bool              `json:"deny_developer_role,omitempty"`
	SystemFirstOnly         bool              `json:"system_first_only,omitempty"`
	MergeSystem             bool              `json:"merge_system,omitempty"`
	StripEmpty              bool              `json:"strip_empty,omitempty"`
	ThinkingPolicy          string            `json:"thinking_policy,omitempty"` // "strip" | "strict_signature" | "passback_required" | "force"
	EnsureGooglePrefix      bool              `json:"ensure_google_prefix,omitempty"`
	MaxTokensCeiling        int               `json:"max_tokens_ceiling,omitempty"`
	NormalizeChoiceToString bool              `json:"normalize_choice_to_string,omitempty"`
	ReasoningFields         []string          `json:"reasoning_fields,omitempty"`
	ModelAliases            map[string]string `json:"model_aliases,omitempty"`
}

// UnmarshalJSON losslessly decodes both flat v2 AdapterRules and nested v1 preset adapter_rules.
func (r *AdapterRules) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	type flatAlias struct {
		AuthHeader              string            `json:"auth_header,omitempty"`
		AuthPrefix              string            `json:"auth_prefix,omitempty"`
		ExtraHeaders            map[string]string `json:"extra_headers,omitempty"`
		InjectHeaders           map[string]string `json:"inject_headers,omitempty"`
		StripParams             []string          `json:"strip_params,omitempty"`
		RenameParams            map[string]string `json:"rename_params,omitempty"`
		OverrideParams          map[string]any    `json:"override_params,omitempty"`
		StreamOnly              bool              `json:"stream_only,omitempty"`
		RescueFromText          bool              `json:"rescue_from_text,omitempty"`
		UnwrapRoot              string            `json:"unwrap_root,omitempty"`
		StripReasoningEnabled   bool              `json:"strip_reasoning_enabled,omitempty"`
		GeminiCompat            bool              `json:"gemini_compat,omitempty"`
		ThoughtTagMarkerRaw     json.RawMessage   `json:"thought_tag_marker,omitempty"`
		AnthropicStrictSig      bool              `json:"anthropic_strict_signature,omitempty"`
		AnthropicPassbackReq    bool              `json:"anthropic_passback_required,omitempty"`
		DenyDeveloperRole       bool              `json:"deny_developer_role,omitempty"`
		SystemFirstOnly         bool              `json:"system_first_only,omitempty"`
		MergeSystem             bool              `json:"merge_system,omitempty"`
		StripEmpty              bool              `json:"strip_empty,omitempty"`
		ThinkingPolicy          string            `json:"thinking_policy,omitempty"`
		EnsureGooglePrefix      bool              `json:"ensure_google_prefix,omitempty"`
		MaxTokensCeiling        int               `json:"max_tokens_ceiling,omitempty"`
		NormalizeChoiceToString bool              `json:"normalize_choice_to_string,omitempty"`
		ReasoningFields         []string          `json:"reasoning_fields,omitempty"`
		ModelAliases            map[string]string `json:"model_aliases,omitempty"`
		ModelAliasV1            map[string]string `json:"model_alias,omitempty"`
		CaseSensitiveModels     map[string]string `json:"case_sensitive_models,omitempty"`
		Messages                *struct {
			DenyDeveloperRole bool `json:"deny_developer_role"`
			SystemFirstOnly   bool `json:"system_first_only"`
			MergeSystem       bool `json:"merge_system"`
			StripEmpty        bool `json:"strip_empty"`
		} `json:"messages,omitempty"`
		Sanitization *struct {
			StripParams           []string `json:"strip_params"`
			UnsupportedParams     []string `json:"unsupported_params"`
			StripReasoningEnabled bool     `json:"strip_reasoning_enabled"`
			MaxTokensCeiling      int      `json:"max_tokens_ceiling"`
		} `json:"sanitization,omitempty"`
		Tools *struct {
			RescueFromText          bool `json:"rescue_from_text"`
			NormalizeChoiceToString bool `json:"normalize_choice_to_string"`
		} `json:"tools,omitempty"`
		Reasoning *struct {
			Strategy            string          `json:"strategy"`
			ThoughtTagMarkerRaw json.RawMessage `json:"thought_tag_marker"`
			ForceAdaptive       bool            `json:"force_adaptive_thinking"`
		} `json:"reasoning,omitempty"`
		Response *struct {
			UnwrapRoot      string   `json:"unwrap_root"`
			ReasoningFields []string `json:"reasoning_fields"`
		} `json:"response,omitempty"`
	}

	var aux flatAlias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	r.AuthHeader = aux.AuthHeader
	r.AuthPrefix = aux.AuthPrefix
	if len(aux.ExtraHeaders) > 0 || len(aux.InjectHeaders) > 0 {
		r.ExtraHeaders = make(map[string]string)
		for k, v := range aux.InjectHeaders {
			r.ExtraHeaders[k] = v
		}
		for k, v := range aux.ExtraHeaders {
			r.ExtraHeaders[k] = v
		}
	}
	r.StripParams = aux.StripParams
	r.RenameParams = aux.RenameParams
	r.OverrideParams = aux.OverrideParams
	r.StreamOnly = aux.StreamOnly
	r.RescueFromText = aux.RescueFromText
	r.UnwrapRoot = aux.UnwrapRoot
	r.StripReasoningEnabled = aux.StripReasoningEnabled
	r.GeminiCompat = aux.GeminiCompat
	r.ThoughtTagMarker = parseThoughtTagMarker(aux.ThoughtTagMarkerRaw)
	r.AnthropicStrictSig = aux.AnthropicStrictSig
	r.AnthropicPassbackReq = aux.AnthropicPassbackReq
	r.DenyDeveloperRole = aux.DenyDeveloperRole
	r.SystemFirstOnly = aux.SystemFirstOnly
	r.MergeSystem = aux.MergeSystem
	r.StripEmpty = aux.StripEmpty
	r.ThinkingPolicy = aux.ThinkingPolicy
	r.EnsureGooglePrefix = aux.EnsureGooglePrefix
	r.MaxTokensCeiling = aux.MaxTokensCeiling
	r.NormalizeChoiceToString = aux.NormalizeChoiceToString
	r.ReasoningFields = aux.ReasoningFields

	if len(aux.ModelAliases) > 0 || len(aux.ModelAliasV1) > 0 || len(aux.CaseSensitiveModels) > 0 {
		r.ModelAliases = make(map[string]string)
		for k, v := range aux.CaseSensitiveModels {
			r.ModelAliases[k] = v
		}
		for k, v := range aux.ModelAliasV1 {
			r.ModelAliases[k] = v
		}
		for k, v := range aux.ModelAliases {
			r.ModelAliases[k] = v
		}
	}

	if aux.Messages != nil {
		if aux.Messages.DenyDeveloperRole {
			r.DenyDeveloperRole = true
		}
		if aux.Messages.SystemFirstOnly {
			r.SystemFirstOnly = true
		}
		if aux.Messages.MergeSystem {
			r.MergeSystem = true
		}
		if aux.Messages.StripEmpty {
			r.StripEmpty = true
		}
	}
	if aux.Sanitization != nil {
		if len(aux.Sanitization.StripParams) > 0 {
			r.StripParams = appendUniqueStrings(r.StripParams, aux.Sanitization.StripParams...)
		}
		if len(aux.Sanitization.UnsupportedParams) > 0 {
			r.StripParams = appendUniqueStrings(r.StripParams, aux.Sanitization.UnsupportedParams...)
		}
		if aux.Sanitization.StripReasoningEnabled {
			r.StripReasoningEnabled = true
		}
		if aux.Sanitization.MaxTokensCeiling > 0 && r.MaxTokensCeiling == 0 {
			r.MaxTokensCeiling = aux.Sanitization.MaxTokensCeiling
		}
	}
	if aux.Tools != nil {
		if aux.Tools.RescueFromText {
			r.RescueFromText = true
		}
		if aux.Tools.NormalizeChoiceToString {
			r.NormalizeChoiceToString = true
		}
	}
	if aux.Reasoning != nil {
		if aux.Reasoning.Strategy == "gemini_thinking_matrix" {
			r.GeminiCompat = true
		}
		if m := parseThoughtTagMarker(aux.Reasoning.ThoughtTagMarkerRaw); m != "" && r.ThoughtTagMarker == "" {
			r.ThoughtTagMarker = m
		}
		if aux.Reasoning.ForceAdaptive && r.ThinkingPolicy == "" {
			r.ThinkingPolicy = "force"
		}
	}
	if aux.Response != nil {
		if aux.Response.UnwrapRoot != "" && r.UnwrapRoot == "" {
			r.UnwrapRoot = aux.Response.UnwrapRoot
		}
		if len(aux.Response.ReasoningFields) > 0 && len(r.ReasoningFields) == 0 {
			r.ReasoningFields = aux.Response.ReasoningFields
		}
	}
	return nil
}

func parseThoughtTagMarker(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil && b {
		return "<thought>"
	}
	return ""
}

func appendUniqueStrings(dst []string, items ...string) []string {
	seen := make(map[string]bool, len(dst))
	for _, s := range dst {
		seen[s] = true
	}
	for _, it := range items {
		if it != "" && !seen[it] {
			seen[it] = true
			dst = append(dst, it)
		}
	}
	return dst
}

// RuntimeSnapshot 不可变内存快照（由 atomic.Pointer[RuntimeSnapshot] 持有，支持零锁并发读取）
type RuntimeSnapshot struct {
	Config     *ProxyConfig
	ETag       string
	LeaseUntil time.Time // Lite 模式：当前租约到期时间
	GraceUntil time.Time // Lite 模式：断网宽限期截止时间
	LoadedAt   time.Time
}

// PurgeSecrets 清空快照内所有明文凭据引用（仅在节点收到 401/403 吊销或超出宽限期停服时调用）
func (s *RuntimeSnapshot) PurgeSecrets() {
	if s == nil || s.Config == nil {
		return
	}
	for _, p := range s.Config.Providers {
		if p == nil {
			continue
		}
		for _, k := range p.APIKeys {
			if k == nil {
				continue
			}
			k.Key = ""
			if k.OAuthMeta != nil {
				k.OAuthMeta.RefreshToken = ""
			}
		}
	}
	s.Config.Settings.ClientKey = ""
	s.Config.Settings.ProxyAPIKey = ""
	s.Config.Vault = nil
}

// ============================================================================
// 跨包标准接口契约
// ============================================================================

type ConfigSource interface {
	Current(ctx context.Context, forceRefresh bool) (*RuntimeSnapshot, error)
	HealthState() (status string, state string, leaseValid bool, configVer int64)
}

type Try struct {
	Attempt            int               `json:"attempt"`
	Provider           string            `json:"provider"`
	KeyID              string            `json:"key_id"`
	Model              string            `json:"model"`
	Status             int               `json:"status"`
	Millis             int64             `json:"ms"`
	TTFTMillis         int64             `json:"ttft_ms,omitempty"`
	Reason             string            `json:"reason,omitempty"`
	CooldownAppliedSec int               `json:"cooldown_applied_sec,omitempty"`
	ErrorSnippet       string            `json:"error_snippet,omitempty"`
	RespHeaders        map[string]string `json:"resp_headers,omitempty"`
}

type RequestTrace struct {
	ID                 string            `json:"id"`
	Timestamp          int64             `json:"ts"`
	Mode               string            `json:"mode"`
	Endpoint           string            `json:"endpoint"`
	ReqModel           string            `json:"req_model"`
	ServedModel        string            `json:"served_model"`
	WinnerProvider     string            `json:"winner_provider,omitempty"`
	WinnerKey          string            `json:"winner_key,omitempty"`
	Status             int               `json:"status"`
	Stream             bool              `json:"stream"`
	InTokens           int               `json:"in_tokens"`
	OutTokens          int               `json:"out_tokens"`
	CacheReadTokens    int               `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens   int               `json:"cache_write_tokens,omitempty"`
	CacheWrite1hTokens int               `json:"cache_write_1h_tokens,omitempty"`
	ReasoningTokens    int               `json:"reasoning_tokens,omitempty"`
	TTFTMillis         int64             `json:"ttft_ms"`
	FlowMillis         int64             `json:"flow_ms,omitempty"`
	OwnMillis          int64             `json:"own_ms,omitempty"`
	QueuedMillis       int64             `json:"queued_ms,omitempty"`
	SentMillis         int64             `json:"sent_ms,omitempty"`
	TotalMillis        int64             `json:"total_ms"`
	RetriedMillis      int64             `json:"retried_ms,omitempty"`
	UpBytes            int               `json:"up_bytes,omitempty"`
	DownBytes          int               `json:"down_bytes,omitempty"`
	StopReason         string            `json:"stop_reason,omitempty"`
	ReqHeaders         map[string]string `json:"req_headers,omitempty"`
	Tries              []Try             `json:"tries"`
}

type ObservabilitySink interface {
	RecordRequest(trace RequestTrace)
	RecentTraces(onlyFailedOrRetried bool) []RequestTrace
	QueryUsage(period string, tzName string) (map[string]any, error)
}

type AdapterEngine interface {
	PrepareRequest(endpoint string, reqBody []byte, provider *ProviderConfig, targetModel string, clientForcedStream bool) (mutatedBody []byte, extraHeaders map[string]string, upstreamStream bool, err error)
	TransformNonStreamResponse(endpoint string, respBody []byte, provider *ProviderConfig, reqModel string) ([]byte, error)
	WrapStreamTransformer(endpoint string, upstreamReader http.Flusher, provider *ProviderConfig, reqModel string)
}
