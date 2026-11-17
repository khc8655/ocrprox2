package admin

import (
	"sort"
	"strings"
)

// normalizeImportedConfig converts legacy v1 ocrproxy configuration payloads
// (providers.*.keys map, agent_models.*.keys, top-level candidates, top-level
// proxy_api_key/run_mode) into canonical v2 ProxyConfig JSON shape before unmarshaling.
// Already-canonical v2 payloads pass through untouched.
func normalizeImportedConfig(raw map[string]any) {
	if raw == nil {
		return
	}

	if provs, ok := raw["providers"].(map[string]any); ok {
		for _, pv := range provs {
			pm, ok := pv.(map[string]any)
			if !ok || pm == nil {
				continue
			}
			normalizeImportedProvider(pm)
		}
	}

	if models, ok := raw["agent_models"].(map[string]any); ok {
		for _, mv := range models {
			mm, ok := mv.(map[string]any)
			if !ok || mm == nil {
				continue
			}
			if _, hasEnabled := mm["enabled"]; !hasEnabled {
				mm["enabled"] = true
			}
			if _, hasCands := mm["candidates"]; !hasCands {
				if legacyKeys, ok := mm["keys"].([]any); ok {
					cands := make([]any, 0, len(legacyKeys))
					for _, item := range legacyKeys {
						km, ok := item.(map[string]any)
						if !ok || km == nil {
							continue
						}
						keyLabel := strVal(km["key_label"])
						if keyLabel == "" {
							keyLabel = strVal(km["key"])
						}
						targetModel := strVal(km["target_model"])
						if targetModel == "" {
							targetModel = strVal(km["model"])
						}
						cand := map[string]any{
							"provider":  strVal(km["provider"]),
							"key_label": keyLabel,
							"enabled":   true,
						}
						if targetModel != "" {
							cand["target_model"] = targetModel
						}
						if en, ok := km["enabled"].(bool); ok {
							cand["enabled"] = en
						}
						cands = append(cands, cand)
					}
					mm["candidates"] = cands
				}
			}
		}
	}

	if _, hasKB := raw["kb_models"]; !hasKB {
		if legacyCands, ok := raw["candidates"].(map[string]any); ok {
			kbModels := make(map[string]any, len(legacyCands))
			for cat, listAny := range legacyCands {
				list, ok := listAny.([]any)
				if !ok {
					continue
				}
				out := make([]any, 0, len(list))
				for _, item := range list {
					km, ok := item.(map[string]any)
					if !ok || km == nil {
						continue
					}
					keyLabel := strVal(km["key_label"])
					if keyLabel == "" {
						keyLabel = strVal(km["key"])
					}
					entry := map[string]any{
						"provider":  strVal(km["provider"]),
						"model":     strVal(km["model"]),
						"key_label": keyLabel,
						"enabled":   true,
					}
					if en, ok := km["enabled"].(bool); ok {
						entry["enabled"] = en
					}
					out = append(out, entry)
				}
				kbModels[cat] = out
			}
			raw["kb_models"] = kbModels
		}
	}

	settings, _ := raw["settings"].(map[string]any)
	if settings == nil {
		settings = make(map[string]any)
	}
	copyIfEmpty := func(dstKey string, srcKeys ...string) {
		if v, exists := settings[dstKey]; exists && v != nil && v != "" {
			return
		}
		for _, sk := range srcKeys {
			if v, exists := raw[sk]; exists && v != nil && v != "" {
				settings[dstKey] = v
				return
			}
		}
	}
	copyIfEmpty("client_key", "proxy_api_key", "client_key")
	copyIfEmpty("proxy_api_key", "proxy_api_key")
	copyIfEmpty("agent_routing_strategy", "agent_routing_strategy")
	copyIfEmpty("cooldown_rate_limit_sec", "cooldown_429_sec")
	copyIfEmpty("cooldown_server_error_sec", "cooldown_5xx_sec")
	copyIfEmpty("cooldown_auth_error_sec", "cooldown_403_sec")
	raw["settings"] = settings
}

func normalizeImportedProvider(pm map[string]any) {
	if _, hasEnabled := pm["enabled"]; !hasEnabled {
		pm["enabled"] = true
	}
	if strVal(pm["origin"]) == "" {
		pm["origin"] = "local"
	}
	if strVal(pm["api_type"]) == "" {
		apiType := "openai"
		if protos, ok := pm["protocols"].([]any); ok && len(protos) > 0 {
			hasOpenAI := false
			hasAnthropic := false
			for _, p := range protos {
				ps := strings.ToLower(strVal(p))
				if ps == "messages" || ps == "anthropic" {
					hasAnthropic = true
				}
				if ps == "openai" || ps == "chat" || ps == "responses" {
					hasOpenAI = true
				}
			}
			if hasAnthropic && !hasOpenAI {
				apiType = "anthropic"
			}
		}
		pm["api_type"] = apiType
	}

	if _, hasAPIKeys := pm["api_keys"]; hasAPIKeys {
		return
	}
	legacyKeys, ok := pm["keys"].(map[string]any)
	if !ok {
		return
	}

	labels := make([]string, 0, len(legacyKeys))
	for lbl := range legacyKeys {
		labels = append(labels, lbl)
	}
	sort.Strings(labels)

	entries := make([]any, 0, len(labels))
	baseURL := strVal(pm["base_url"])
	for _, lbl := range labels {
		val := legacyKeys[lbl]
		entry := map[string]any{
			"id":      lbl,
			"label":   lbl,
			"enabled": true,
			"origin":  "local",
		}
		switch v := val.(type) {
		case string:
			entry["key"] = v
		case map[string]any:
			entry["key"] = strVal(v["key"])
			if orig := strVal(v["origin"]); orig != "" {
				entry["origin"] = orig
			}
			if rpm := v["rpm"]; rpm != nil {
				entry["max_rpm"] = rpm
			}
			if en, ok := v["enabled"].(bool); ok {
				entry["enabled"] = en
			}
			if strings.Contains(baseURL, "{project_id}") {
				if keyURL := strVal(v["base_url"]); keyURL != "" {
					baseURL = keyURL
					pm["base_url"] = baseURL
				} else if projID := strVal(v["project_id"]); projID != "" {
					baseURL = strings.ReplaceAll(baseURL, "{project_id}", projID)
					pm["base_url"] = baseURL
				}
			}
		default:
			continue
		}
		if strVal(entry["key"]) == "" {
			continue
		}
		entries = append(entries, entry)
	}
	pm["api_keys"] = entries
}

func strVal(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}
