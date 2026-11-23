package types

import "sort"

// AvailableModelIDs lists the model ids the data plane actually answers on
// GET /v1/models: agent routes that are enabled, plus the legacy fixed KB slots
// that still have an enabled candidate (chat on both roles; embedding / reranker
// / ocr on a full node only).
//
// The public /v1/models handler and the admin access-info payload both call it,
// so the console can never advertise a model id the gateway would 404 on —
// previously each side re-implemented the filter and they drifted apart (the
// console listed disabled routes and hid KB slots).
func (c *ProxyConfig) AvailableModelIDs(role Role) []string {
	if c == nil {
		return []string{}
	}
	seen := make(map[string]bool)
	for id, route := range c.AgentModels {
		if route != nil && route.Enabled {
			seen[id] = true
		}
	}
	// The four fixed slots are addressed by their category name ("chat", …) when
	// no agent route claims that id.
	for _, cat := range []string{"chat", "embedding", "reranker", "ocr"} {
		if seen[cat] {
			continue
		}
		if cat != "chat" && role != RoleFull {
			continue
		}
		for _, cand := range c.KBModels[cat] {
			if cand != nil && cand.Enabled {
				seen[cat] = true
				break
			}
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
