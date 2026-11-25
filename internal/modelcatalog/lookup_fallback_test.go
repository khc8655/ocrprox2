package modelcatalog

// A reseller/gateway exposes vendor models under its own provider id, often with
// no preset binding (tokenrhythm → glm-5.3-flash). The exact lookup misses; the
// same-named fallback must still return the vendor's canonical spec, and it must
// be deterministic (map iteration order must never decide).

import "testing"

func TestCapabilityByModelID_ResellerAliasResolves(t *testing.T) {
	cat, err := Bundled()
	if err != nil {
		t.Fatalf("Bundled: %v", err)
	}

	cap, modal, total := cat.CapabilityByModelID("glm-5.3-flash")
	if !cap.Found {
		t.Skip("catalog snapshot no longer lists glm-5.3-flash; fallback logic is covered by the hub test")
	}
	if cap.ContextTokens <= 0 {
		t.Fatalf("context must be resolved, got %+v", cap)
	}
	if modal < 2 || total < modal {
		t.Fatalf("expected several providers to list the model, modal=%d total=%d", modal, total)
	}
	// The modal spec is what most providers publish; a single outlier
	// (a reseller with a cut-down window) must not win.
	again, modal2, total2 := cat.CapabilityByModelID("glm-5.3-flash")
	if again.ContextTokens != cap.ContextTokens || again.OutputTokens != cap.OutputTokens ||
		modal2 != modal || total2 != total {
		t.Fatalf("fallback is not deterministic: %+v/%d/%d vs %+v/%d/%d",
			cap, modal, total, again, modal2, total2)
	}
}

func TestCapabilityByModelID_UnknownStaysUnknown(t *testing.T) {
	cat, err := Bundled()
	if err != nil {
		t.Fatalf("Bundled: %v", err)
	}
	if cap, modal, total := cat.CapabilityByModelID("egg-alpha-003"); cap.Found || modal != 0 || total != 0 {
		t.Fatalf("unknown model must not be invented, got %+v modal=%d total=%d", cap, modal, total)
	}
	if cap, _, _ := cat.CapabilityByModelID(""); cap.Found {
		t.Fatal("empty id must not match anything")
	}
}
