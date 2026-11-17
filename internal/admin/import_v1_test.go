package admin

import (
	"encoding/json"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func TestNormalizeImportedConfigV1(t *testing.T) {
	raw := map[string]any{
		"run_mode":               "agent",
		"proxy_api_key":          "sk-synthetic-client-0000",
		"agent_routing_strategy": "sticky_failover",
		"cooldown_429_sec":       60,
		"providers": map[string]any{
			"stepfun": map[string]any{
				"base_url":  "https://api.stepfun.com/step_plan/v1",
				"protocols": []any{"openai"},
				"keys": map[string]any{
					"k1": "sk-synthetic-step-0001",
					"k2": map[string]any{
						"key":      "sk-synthetic-step-0002",
						"is_local": true,
					},
				},
			},
			"vertex": map[string]any{
				"base_url": "https://aiplatform.googleapis.com/v1beta1/projects/{project_id}/locations/global/endpoints/openapi",
				"keys": map[string]any{
					"v1": map[string]any{
						"key":        "sk-synthetic-vertex-0001",
						"project_id": "proj-123",
					},
				},
			},
		},
		"agent_models": map[string]any{
			"step-5-preview": map[string]any{
				"keys": []any{
					map[string]any{"provider": "stepfun", "key": "k1"},
				},
			},
		},
		"candidates": map[string]any{
			"ocr": []any{
				map[string]any{"provider": "stepfun", "key": "k2", "model": "step-ocr"},
			},
		},
	}

	normalizeImportedConfig(raw)

	b, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var cfg types.ProxyConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatalf("unmarshal ProxyConfig failed: %v", err)
	}

	step := cfg.Providers["stepfun"]
	if step == nil || !step.Enabled || len(step.APIKeys) != 2 {
		t.Fatalf("unexpected stepfun provider: %+v", step)
	}
	if step.APIKeys[0].Label != "k1" || step.APIKeys[0].Key != "sk-synthetic-step-0001" {
		t.Fatalf("unexpected k1: %+v", step.APIKeys[0])
	}
	if step.APIKeys[1].Label != "k2" || step.APIKeys[1].Key != "sk-synthetic-step-0002" {
		t.Fatalf("unexpected k2: %+v", step.APIKeys[1])
	}

	vtx := cfg.Providers["vertex"]
	if vtx == nil || vtx.BaseURL != "https://aiplatform.googleapis.com/v1beta1/projects/proj-123/locations/global/endpoints/openapi" {
		t.Fatalf("unexpected vertex base_url: %+v", vtx)
	}

	am := cfg.AgentModels["step-5-preview"]
	if am == nil || !am.Enabled || len(am.Candidates) != 1 || am.Candidates[0].KeyLabel != "k1" {
		t.Fatalf("unexpected agent_models: %+v", am)
	}

	ocr := cfg.KBModels["ocr"]
	if len(ocr) != 1 || ocr[0].Provider != "stepfun" || ocr[0].KeyLabel != "k2" || ocr[0].Model != "step-ocr" {
		t.Fatalf("unexpected kb_models: %+v", ocr)
	}

	if cfg.Settings.ClientKey != "sk-synthetic-client-0000" {
		t.Fatalf("unexpected settings: %+v", cfg.Settings)
	}
}
