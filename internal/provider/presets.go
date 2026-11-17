package provider

import (
	"slices"
	"strings"

	"github.com/khc8655/llmproxy2/internal/types"
)

// Region represents a regional endpoint or specific subscription plan for a provider.
type Region struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	BaseURL          string   `json:"base_url,omitempty"`
	ChatURL          string   `json:"chat_url,omitempty"`
	ResponsesURL     string   `json:"responses_url,omitempty"`
	AnthropicURL     string   `json:"anthropic_url,omitempty"`
	AnthropicBaseURL string   `json:"anthropic_base_url,omitempty"`
	Models           []string `json:"models,omitempty"`
	Lists            bool     `json:"lists,omitempty"`
	KeysURL          string   `json:"keys_url,omitempty"`
	Website          string   `json:"website,omitempty"`
}

// PresetDef defines a curated provider template with default routes, fallback models, and capability hints.
type PresetDef struct {
	ID               string              `json:"id"`
	Name             string              `json:"name"`
	Icon             string              `json:"icon,omitempty"`
	Kind             string              `json:"kind,omitempty"` // "vendor", "relay", "local"
	BaseURL          string              `json:"base_url,omitempty"`
	ChatURL          string              `json:"chat_url,omitempty"`
	ResponsesURL     string              `json:"responses_url,omitempty"`
	AnthropicURL     string              `json:"anthropic_url,omitempty"`
	AnthropicBaseURL string              `json:"anthropic_base_url,omitempty"`
	DecideURL        string              `json:"decide_url,omitempty"`
	Website          string              `json:"website,omitempty"`
	KeysURL          string              `json:"keys_url,omitempty"`
	NoList           bool                `json:"no_list,omitempty"`
	Models           []string            `json:"models,omitempty"`
	VisionModels     []string            `json:"vision_models,omitempty"`
	ReasoningModels  []string            `json:"reasoning_models,omitempty"`
	Regions          []Region            `json:"regions,omitempty"`
	RegionLabel      string              `json:"region_label,omitempty"`
	KeyPlans         bool                `json:"key_plans,omitempty"`
	AdapterRules     *types.AdapterRules `json:"adapter_rules,omitempty"`
}

// Fallback model lists for vendors that do not provide a live /models endpoint (NoList=true).
var (
	arkPlanModels = []string{
		"ark-code-latest", "doubao-seed-evolving", "doubao-seed-2.1-pro", "doubao-seed-2.1-lite",
		"doubao-seed-2.0-mini", "minimax-m3", "glm-5.3", "glm-5.3-flash", "deepseek-v4.1-flash",
		"deepseek-v4.1-flash-economy", "deepseek-v4-flash", "deepseek-v4-pro",
		"kimi-k2.8-preview", "kimi-k3", "kimi-k3.1-pro",
	}

	alibabaPlanModels = []string{
		"auto", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
		"deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731",
		"glm-5.3", "glm-5.2",
	}

	vertexModels = []string{
		"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash",
		"gemini-1.5-pro", "gemini-1.5-flash", "claude-3-5-sonnet-v2", "claude-3-5-haiku",
		"deepseek-v4.1-flash-maas",
	}

	baiduPlanModels = []string{
		"qianfan-code-latest", "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-pro-0813",
		"deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v3.2", "glm-5.3", "glm-5.3-flash", "glm-5.2",
	}

	bedrockModels = []string{
		"global.anthropic.claude-3-5-sonnet-20241022-v2:0",
		"global.anthropic.claude-3-5-haiku-20241022-v1:0",
		"global.anthropic.claude-3-opus-20240229-v1:0",
		"openai.gpt-oss-120b-1:0", "deepseek.v3.2",
	}
)

var catalogPresets = []PresetDef{
	// 1. OpenAI
	{
		ID:           "openai",
		Name:         "OpenAI",
		Icon:         "openai",
		Kind:         "vendor",
		BaseURL:      "https://api.openai.com/v1",
		ChatURL:      "https://api.openai.com/v1",
		ResponsesURL: "https://api.openai.com/v1",
		Website:      "https://platform.openai.com",
		KeysURL:      "https://platform.openai.com/api-keys",
		VisionModels: []string{"gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3-mini"},
		ReasoningModels: []string{"o1", "o1-mini", "o1-preview", "o3", "o3-mini"},
	},

	// 2. Anthropic
	{
		ID:               "anthropic",
		Name:             "Anthropic",
		Icon:             "claude-color",
		Kind:             "vendor",
		BaseURL:          "https://api.anthropic.com/v1",
		ChatURL:          "https://api.anthropic.com/v1",
		AnthropicURL:     "https://api.anthropic.com",
		AnthropicBaseURL: "https://api.anthropic.com",
		Website:          "https://console.anthropic.com",
		KeysURL:          "https://console.anthropic.com/settings/keys",
		VisionModels: []string{
			"claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307",
			"claude-3-5-sonnet-20240620", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-7-sonnet",
		},
		ReasoningModels: []string{"claude-3-7-sonnet"},
	},

	// 3. Google Gemini Developer API
	{
		ID:           "google",
		Name:         "Google Gemini",
		Icon:         "gemini-color",
		Kind:         "vendor",
		BaseURL:      "https://generativelanguage.googleapis.com/v1beta/openai",
		ChatURL:      "https://generativelanguage.googleapis.com/v1beta/openai",
		Website:      "https://aistudio.google.com",
		KeysURL:      "https://aistudio.google.com/apikey",
		VisionModels: []string{"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"},
		ReasoningModels: []string{"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash-thinking-exp-01-21"},
	},

	// 4. Google Vertex AI
	{
		ID:              "vertex",
		Name:            "Google Vertex AI",
		Icon:            "vertexai-color",
		Kind:            "vendor",
		BaseURL:         "https://aiplatform.googleapis.com/v1beta1/openai",
		ChatURL:         "https://aiplatform.googleapis.com/v1beta1/openai",
		Website:         "https://cloud.google.com/vertex-ai",
		NoList:          true,
		Models:          vertexModels,
		VisionModels:    []string{"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"},
		ReasoningModels: []string{"gemini-2.5-pro", "gemini-2.5-flash"},
	},

	// 5. DeepSeek
	{
		ID:           "deepseek",
		Name:         "DeepSeek",
		Icon:         "deepseek-color",
		Kind:         "vendor",
		BaseURL:      "https://api.deepseek.com/v1",
		ChatURL:      "https://api.deepseek.com/v1",
		ResponsesURL: "https://api.deepseek.com/v1",
		AnthropicURL: "https://api.deepseek.com/anthropic",
		Website:      "https://platform.deepseek.com",
		KeysURL:      "https://platform.deepseek.com/api_keys",
		VisionModels: []string{"deepseek-vl-7b-chat", "deepseek-vl2"},
		ReasoningModels: []string{"deepseek-reasoner", "deepseek-r1"},
	},

	// 6. MiniMax Global
	{
		ID:           "minimax",
		Name:         "MiniMax",
		Icon:         "minimax-color",
		Kind:         "vendor",
		BaseURL:      "https://api.minimax.io/v1",
		ChatURL:      "https://api.minimax.io/v1",
		AnthropicURL: "https://api.minimax.io/anthropic",
		Website:      "https://platform.minimax.io",
		KeysURL:      "https://platform.minimax.io/user-center/basic-information/interface-key",
		VisionModels: []string{"minimax-m3", "minimax-m2.7"},
	},

	// 7. MiniMax China
	{
		ID:           "minimax-cn",
		Name:         "MiniMax (China)",
		Icon:         "minimax-color",
		Kind:         "vendor",
		BaseURL:      "https://api.minimaxi.com/v1",
		ChatURL:      "https://api.minimaxi.com/v1",
		AnthropicURL: "https://api.minimaxi.com/anthropic",
		Website:      "https://platform.minimaxi.com",
		KeysURL:      "https://platform.minimaxi.com/user-center/basic-information/interface-key",
		VisionModels: []string{"minimax-m3", "minimax-m2.7"},
	},

	// 8. Kimi / Moonshot Global
	{
		ID:           "moonshot",
		Name:         "Kimi",
		Icon:         "kimi",
		Kind:         "vendor",
		BaseURL:      "https://api.moonshot.ai/v1",
		ChatURL:      "https://api.moonshot.ai/v1",
		AnthropicURL: "https://api.moonshot.ai/anthropic",
		Website:      "https://platform.kimi.ai",
		KeysURL:      "https://platform.kimi.ai/console/api-keys",
		VisionModels: []string{"kimi-k3", "kimi-k2.8-preview"},
		ReasoningModels: []string{"kimi-k3", "kimi-k2.5"},
	},

	// 9. Kimi / Moonshot China
	{
		ID:           "moonshot-cn",
		Name:         "Kimi (China)",
		Icon:         "kimi",
		Kind:         "vendor",
		BaseURL:      "https://api.moonshot.cn/v1",
		ChatURL:      "https://api.moonshot.cn/v1",
		AnthropicURL: "https://api.moonshot.cn/anthropic",
		Website:      "https://platform.kimi.com",
		KeysURL:      "https://platform.kimi.com/console/api-keys",
		VisionModels: []string{"kimi-k3", "kimi-k2.8-preview"},
		ReasoningModels: []string{"kimi-k3", "kimi-k2.5"},
	},

	// 10. Kimi Code Global
	{
		ID:           "kimi-code",
		Name:         "Kimi Code",
		Icon:         "kimi",
		Kind:         "vendor",
		BaseURL:      "https://api.kimi.ai/coding/v1",
		ChatURL:      "https://api.kimi.ai/coding/v1",
		AnthropicURL: "https://api.kimi.ai/coding",
		Website:      "https://www.kimi.ai/code",
		KeysURL:      "https://www.kimi.ai/code/console",
		VisionModels: []string{"kimi-k3", "kimi-k2.8-preview"},
	},

	// 11. Kimi Code China
	{
		ID:           "kimi-code-cn",
		Name:         "Kimi Code (China)",
		Icon:         "kimi",
		Kind:         "vendor",
		BaseURL:      "https://api.kimi.com/coding/v1",
		ChatURL:      "https://api.kimi.com/coding/v1",
		AnthropicURL: "https://api.kimi.com/coding",
		Website:      "https://www.kimi.com/code",
		KeysURL:      "https://www.kimi.com/code/console",
		VisionModels: []string{"kimi-k3", "kimi-k2.8-preview"},
	},

	// 12. Zhipu GLM
	{
		ID:           "zhipu",
		Name:         "Zhipu GLM",
		Icon:         "zhipu-color",
		Kind:         "vendor",
		BaseURL:      "https://open.bigmodel.cn/api/paas/v4",
		ChatURL:      "https://open.bigmodel.cn/api/paas/v4",
		AnthropicURL: "https://open.bigmodel.cn/api/anthropic",
		Website:      "https://open.bigmodel.cn",
		KeysURL:      "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
		RegionLabel:  "Plan",
		KeyPlans:     true,
		Regions: []Region{
			{ID: "api", Name: "Pay as you go", ChatURL: "https://open.bigmodel.cn/api/paas/v4", AnthropicURL: "https://open.bigmodel.cn/api/anthropic"},
			{ID: "coding", Name: "Coding Plan", ChatURL: "https://open.bigmodel.cn/api/coding/paas/v4", ResponsesURL: "https://open.bigmodel.cn/api/v1", AnthropicURL: "https://open.bigmodel.cn/api/anthropic"},
		},
		VisionModels: []string{"glm-4v", "glm-4v-plus", "glm-5.3-flash"},
		ReasoningModels: []string{"glm-zero-preview"},
	},

	// 13. Z.ai
	{
		ID:           "zai",
		Name:         "Z.ai",
		Icon:         "zai",
		Kind:         "vendor",
		BaseURL:      "https://api.z.ai/api/paas/v4",
		ChatURL:      "https://api.z.ai/api/paas/v4",
		AnthropicURL: "https://api.z.ai/api/anthropic",
		Website:      "https://z.ai",
		KeysURL:      "https://z.ai/manage-apikey/apikey-list",
		RegionLabel:  "Plan",
		KeyPlans:     true,
		Regions: []Region{
			{ID: "api", Name: "Pay as you go", ChatURL: "https://api.z.ai/api/paas/v4", AnthropicURL: "https://api.z.ai/api/anthropic"},
			{ID: "coding", Name: "Coding Plan", ChatURL: "https://api.z.ai/api/coding/paas/v4", ResponsesURL: "https://api.z.ai/api/v1", AnthropicURL: "https://api.z.ai/api/anthropic"},
		},
		VisionModels: []string{"glm-4v", "glm-4v-plus", "glm-5.3-flash"},
	},

	// 14. Volcengine Ark
	{
		ID:           "volcengine",
		Name:         "Volcengine Ark",
		Icon:         "volcengine-color",
		Kind:         "vendor",
		BaseURL:      "https://ark.cn-beijing.volces.com/api/coding/v3",
		ChatURL:      "https://ark.cn-beijing.volces.com/api/coding/v3",
		ResponsesURL: "https://ark.cn-beijing.volces.com/api/coding/v3",
		AnthropicURL: "https://ark.cn-beijing.volces.com/api/coding",
		Website:      "https://www.volcengine.com/docs/82379/1925114",
		KeysURL:      "https://ark.volcengine.com/region:cn-beijing/apikey",
		RegionLabel:  "Plan",
		KeyPlans:     true,
		NoList:       true,
		Models:       arkPlanModels,
		Regions: []Region{
			{ID: "coding", Name: "Coding Plan", ChatURL: "https://ark.cn-beijing.volces.com/api/coding/v3", ResponsesURL: "https://ark.cn-beijing.volces.com/api/coding/v3", AnthropicURL: "https://ark.cn-beijing.volces.com/api/coding", Models: arkPlanModels},
			{ID: "agent", Name: "Agent Plan", ChatURL: "https://ark.cn-beijing.volces.com/api/plan/v3", ResponsesURL: "https://ark.cn-beijing.volces.com/api/plan/v3", AnthropicURL: "https://ark.cn-beijing.volces.com/api/plan", Models: arkPlanModels},
			{ID: "api", Name: "Pay as you go", ChatURL: "https://ark.cn-beijing.volces.com/api/v3", ResponsesURL: "https://ark.cn-beijing.volces.com/api/v3", Lists: true},
		},
		VisionModels: []string{"doubao-seed-evolving", "doubao-seed-2.1-pro", "glm-5.3-flash", "kimi-k3", "minimax-m3"},
	},

	// 15. Alibaba Bailian Token Plan
	{
		ID:           "bailian-token-plan",
		Name:         "Bailian Token Plan",
		Icon:         "bailian-color",
		Kind:         "vendor",
		BaseURL:      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		ChatURL:      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		AnthropicURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
		DecideURL:    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		Website:      "https://help.aliyun.com/zh/model-studio/token-plan-overview",
		KeysURL:      "https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal",
		NoList:       true,
		Models:       alibabaPlanModels,
		VisionModels: []string{"qwen-vl-max", "qwen-vl-plus"},
	},

	// 16. Alibaba Qwen (DashScope)
	{
		ID:           "qwen",
		Name:         "Qwen",
		Icon:         "qwen-color",
		Kind:         "vendor",
		BaseURL:      "https://dashscope.aliyuncs.com/compatible-mode/v1",
		ChatURL:      "https://dashscope.aliyuncs.com/compatible-mode/v1",
		AnthropicURL: "https://dashscope.aliyuncs.com/apps/anthropic",
		Website:      "https://bailian.console.aliyun.com",
		KeysURL:      "https://bailian.console.aliyun.com/?tab=model#/api-key",
		VisionModels: []string{"qwen-vl-max", "qwen-vl-plus", "qwen2.5-vl-72b-instruct"},
		ReasoningModels: []string{"qwq-32b-preview", "qwen-plus"},
	},

	// 17. OpenRouter
	{
		ID:           "openrouter",
		Name:         "OpenRouter",
		Icon:         "openrouter",
		Kind:         "relay",
		BaseURL:      "https://openrouter.ai/api/v1",
		ChatURL:      "https://openrouter.ai/api/v1",
		AnthropicURL: "https://openrouter.ai/api",
		Website:      "https://openrouter.ai",
		KeysURL:      "https://openrouter.ai/keys",
	},

	// 18. SiliconFlow
	{
		ID:         "siliconflow",
		Name:       "SiliconFlow",
		Icon:       "siliconcloud-color",
		Kind:       "relay",
		BaseURL:    "https://api.siliconflow.cn/v1",
		ChatURL:    "https://api.siliconflow.cn/v1",
		Website:    "https://cloud.siliconflow.cn",
		KeysURL:    "https://cloud.siliconflow.cn/account/ak",
		KeyPlans:   true,
		Regions: []Region{
			{ID: "cn", Name: "China", ChatURL: "https://api.siliconflow.cn/v1"},
			{ID: "intl", Name: "Global", ChatURL: "https://api.siliconflow.com/v1", Website: "https://cloud.siliconflow.com", KeysURL: "https://cloud.siliconflow.com/account/ak"},
		},
	},

	// 19. StepFun
	{
		ID:           "stepfun",
		Name:         "StepFun",
		Icon:         "stepfun-color",
		Kind:         "vendor",
		BaseURL:      "https://api.stepfun.ai/step_plan/v1",
		ChatURL:      "https://api.stepfun.ai/step_plan/v1",
		AnthropicURL: "https://api.stepfun.ai/step_plan",
		Website:      "https://platform.stepfun.ai",
		KeysURL:      "https://platform.stepfun.ai/interface-key",
		RegionLabel:  "Plan",
		KeyPlans:     true,
		Regions: []Region{
			{ID: "plan", Name: "Step Plan", ChatURL: "https://api.stepfun.ai/step_plan/v1", AnthropicURL: "https://api.stepfun.ai/step_plan"},
			{ID: "api", Name: "Pay as you go", ChatURL: "https://api.stepfun.ai/v1", AnthropicURL: "https://api.stepfun.ai"},
		},
		VisionModels: []string{"step-1v-8k", "step-1v-32k"},
	},

	// 20. Groq
	{
		ID:           "groq",
		Name:         "Groq",
		Icon:         "groq",
		Kind:         "vendor",
		BaseURL:      "https://api.groq.com/openai/v1",
		ChatURL:      "https://api.groq.com/openai/v1",
		ResponsesURL: "https://api.groq.com/openai/v1",
		Website:      "https://console.groq.com",
		KeysURL:      "https://console.groq.com/keys",
		VisionModels: []string{"llama-3.2-11b-vision-preview", "llama-3.2-90b-vision-preview"},
		ReasoningModels: []string{"deepseek-r1-distill-llama-70b"},
	},

	// 21. NVIDIA NIM
	{
		ID:      "nvidia",
		Name:    "NVIDIA NIM",
		Icon:    "nvidia-color",
		Kind:    "relay",
		BaseURL: "https://integrate.api.nvidia.com/v1",
		ChatURL: "https://integrate.api.nvidia.com/v1",
		Website: "https://build.nvidia.com",
		KeysURL: "https://build.nvidia.com/settings/api-keys",
	},

	// 22. Baidu Qianfan
	{
		ID:           "baidu-qianfan",
		Name:         "Baidu Qianfan",
		Icon:         "baiducloud-color",
		Kind:         "vendor",
		BaseURL:      "https://qianfan.baidubce.com/v2/tokenplan/personal",
		ChatURL:      "https://qianfan.baidubce.com/v2/tokenplan/personal",
		ResponsesURL: "https://qianfan.baidubce.com/v2/tokenplan/personal",
		AnthropicURL: "https://qianfan.baidubce.com/anthropic/tokenplan/personal",
		Website:      "https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6",
		KeysURL:      "https://console.bce.baidu.com/qianfan/resource/token-plan",
		RegionLabel:  "Plan",
		KeyPlans:     true,
		NoList:       true,
		Models:       baiduPlanModels,
		Regions: []Region{
			{ID: "personal", Name: "Token Plan Personal", ChatURL: "https://qianfan.baidubce.com/v2/tokenplan/personal", ResponsesURL: "https://qianfan.baidubce.com/v2/tokenplan/personal", AnthropicURL: "https://qianfan.baidubce.com/anthropic/tokenplan/personal"},
			{ID: "team", Name: "Token Plan Enterprise", ChatURL: "https://qianfan.baidubce.com/v2/tokenplan/team", ResponsesURL: "https://qianfan.baidubce.com/v2/tokenplan/team", AnthropicURL: "https://qianfan.baidubce.com/anthropic/tokenplan/team"},
			{ID: "api", Name: "Pay as you go", ChatURL: "https://qianfan.baidubce.com/v2", ResponsesURL: "https://qianfan.baidubce.com/v2", AnthropicURL: "https://qianfan.baidubce.com/anthropic", Lists: true},
		},
	},

	// 23. Tencent Cloud
	{
		ID:           "tencent-cloud",
		Name:         "Tencent Cloud",
		Icon:         "tencentcloud-color",
		Kind:         "vendor",
		BaseURL:      "https://tokenhub.tencentmaas.com/plan/v3",
		ChatURL:      "https://tokenhub.tencentmaas.com/plan/v3",
		ResponsesURL: "https://tokenhub.tencentmaas.com/plan/v3",
		AnthropicURL: "https://tokenhub.tencentmaas.com/plan/anthropic",
		Website:      "https://cloud.tencent.com/document/product/1823/130060",
		KeysURL:      "https://console.cloud.tencent.com/tokenhub/tokenplan",
		KeyPlans:     true,
		Regions: []Region{
			{ID: "plan", Name: "Plan · China", ChatURL: "https://tokenhub.tencentmaas.com/plan/v3", ResponsesURL: "https://tokenhub.tencentmaas.com/plan/v3", AnthropicURL: "https://tokenhub.tencentmaas.com/plan/anthropic"},
			{ID: "cn", Name: "Pay as you go · China", ChatURL: "https://tokenhub.tencentmaas.com/v1", ResponsesURL: "https://tokenhub.tencentmaas.com/v1", AnthropicURL: "https://tokenhub.tencentmaas.com"},
			{ID: "intl", Name: "Pay as you go · Global", ChatURL: "https://tokenhub-intl.tencentmaas.com/v1", ResponsesURL: "https://tokenhub-intl.tencentmaas.com/v1", AnthropicURL: "https://tokenhub-intl.tencentmaas.com"},
		},
	},

	// 24. Amazon Bedrock
	{
		ID:           "bedrock",
		Name:         "Amazon Bedrock",
		Icon:         "bedrock-color",
		Kind:         "vendor",
		BaseURL:      "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
		ChatURL:      "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
		ResponsesURL: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
		AnthropicURL: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
		Website:      "https://aws.amazon.com/bedrock/",
		KeysURL:      "https://console.aws.amazon.com/bedrock/home#/api-keys",
		NoList:       true,
		Models:       bedrockModels,
		Regions: []Region{
			{ID: "us-east-1", Name: "us-east-1", ChatURL: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", ResponsesURL: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", AnthropicURL: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic"},
			{ID: "us-west-2", Name: "us-west-2", ChatURL: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1", ResponsesURL: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1", AnthropicURL: "https://bedrock-runtime.us-west-2.amazonaws.com/anthropic"},
			{ID: "eu-central-1", Name: "eu-central-1", ChatURL: "https://bedrock-runtime.eu-central-1.amazonaws.com/openai/v1", ResponsesURL: "https://bedrock-runtime.eu-central-1.amazonaws.com/openai/v1", AnthropicURL: "https://bedrock-runtime.eu-central-1.amazonaws.com/anthropic"},
		},
	},

	// 25. AMD Developer Cloud
	{
		ID:      "amd",
		Name:    "AMD Developer Cloud",
		Icon:    "amd",
		Kind:    "vendor",
		BaseURL: "https://llm-api.amd.com/v1",
		ChatURL: "https://llm-api.amd.com/v1",
		Website: "https://developer.amd.com",
	},

	// 26. Ollama Local
	{
		ID:               "ollama",
		Name:             "Ollama",
		Icon:             "ollama",
		Kind:             "local",
		BaseURL:          "http://localhost:11434/v1",
		ChatURL:          "http://localhost:11434/v1",
		AnthropicURL:     "http://localhost:11434",
		AnthropicBaseURL: "http://localhost:11434",
		DecideURL:        "http://localhost:11434/v1",
		Website:          "https://ollama.com",
	},
}

func init() {
	for i := range catalogPresets {
		p := &catalogPresets[i]
		if p.BaseURL == "" && p.ChatURL != "" {
			p.BaseURL = p.ChatURL
		}
		if p.ChatURL == "" && p.BaseURL != "" {
			p.ChatURL = p.BaseURL
		}
		if p.AnthropicBaseURL == "" && p.AnthropicURL != "" {
			p.AnthropicBaseURL = p.AnthropicURL
		}
		if p.AnthropicURL == "" && p.AnthropicBaseURL != "" {
			p.AnthropicURL = p.AnthropicBaseURL
		}
		if p.AdapterRules == nil {
			p.AdapterRules = DefaultPresetAdapterRules(p.ID)
		}
		for j := range p.Regions {
			r := &p.Regions[j]
			if r.BaseURL == "" && r.ChatURL != "" {
				r.BaseURL = r.ChatURL
			}
			if r.AnthropicBaseURL == "" && r.AnthropicURL != "" {
				r.AnthropicBaseURL = r.AnthropicURL
			}
		}
	}
}

// Catalog returns all curated preset definitions.
func Catalog() []PresetDef {
	return slices.Clone(catalogPresets)
}

// FindPreset looks up a preset by its identifier.
func FindPreset(id string) *PresetDef {
	id = strings.ToLower(strings.TrimSpace(id))
	for i := range catalogPresets {
		if strings.ToLower(catalogPresets[i].ID) == id {
			return &catalogPresets[i]
		}
	}
	return nil
}

// IsVisionModel reports whether a given model supports visual inputs.
func IsVisionModel(presetID, model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if p := FindPreset(presetID); p != nil {
		for _, vm := range p.VisionModels {
			if strings.EqualFold(vm, m) {
				return true
			}
		}
	}

	// General heuristic fallbacks
	if strings.Contains(m, "vision") || strings.Contains(m, "-vl") || strings.Contains(m, "4o") ||
		strings.Contains(m, "gemini") || strings.Contains(m, "claude-3") {
		return true
	}
	return false
}

// IsReasoningModel reports whether a given model has extended thinking / reasoning capability.
func IsReasoningModel(presetID, model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if p := FindPreset(presetID); p != nil {
		for _, rm := range p.ReasoningModels {
			if strings.EqualFold(rm, m) {
				return true
			}
		}
	}

	// General heuristic fallbacks
	if strings.Contains(m, "reasoner") || strings.Contains(m, "-r1") || strings.HasPrefix(m, "o1") ||
		strings.HasPrefix(m, "o3") || strings.Contains(m, "thinking") || strings.Contains(m, "qwq") {
		return true
	}
	return false
}

// DefaultPresetAdapterRules returns built-in declarative AdapterRules aligned 1:1
// with shared/presets/*.json for standalone Full nodes when ProviderConfig.AdapterRules is unset.
func DefaultPresetAdapterRules(presetID string) *types.AdapterRules {
	switch strings.ToLower(strings.TrimSpace(presetID)) {
	case "agnes":
		return &types.AdapterRules{MaxTokensCeiling: 65536}
	case "amd":
		return &types.AdapterRules{
			StripParams:           []string{"thinking", "chat_template_kwargs"},
			StripReasoningEnabled: true,
			DenyDeveloperRole:     true,
			SystemFirstOnly:       true,
			MergeSystem:           true,
			StripEmpty:            true,
			ReasoningFields:       []string{"reasoning"},
		}
	case "cline":
		return &types.AdapterRules{
			UnwrapRoot: "data",
			ModelAliases: map[string]string{
				"cline-free/muse-spark-1.3-contributor": "meta/muse-spark-1.3-contributor",
				"cline-free/muse-spark-1.3":             "meta/muse-spark-1.3",
				"cline-free/muse-spark-1.2-contributor": "meta/muse-spark-1.2-contributor",
			},
		}
	case "google":
		return &types.AdapterRules{
			GeminiCompat:   true,
			RescueFromText: true,
		}
	case "minimax", "minimax-cn":
		return &types.AdapterRules{
			StripParams:    []string{"output_config"},
			ThinkingPolicy: "force",
			ModelAliases: map[string]string{
				"minimax-m3":               "MiniMax-M3",
				"minimax-m3.1-flash-preview": "MiniMax-M3.1-Flash-Preview",
			},
		}
	case "nvidia":
		return &types.AdapterRules{NormalizeChoiceToString: true}
	case "openai":
		return &types.AdapterRules{StripReasoningEnabled: true}
	case "openrouter":
		return &types.AdapterRules{
			ExtraHeaders: map[string]string{
				"HTTP-Referer": "https://github.com/khc8655/ocrprox2",
				"X-Title":      "OCRProxy",
			},
		}
	case "vertex":
		return &types.AdapterRules{
			GeminiCompat:       true,
			ThoughtTagMarker:   "<thought>",
			RescueFromText:     true,
			EnsureGooglePrefix: true,
			ModelAliases: map[string]string{
				"gemini-3.8-flash": "google/gemini-3.8-flash",
			},
		}
	default:
		return nil
	}
}
