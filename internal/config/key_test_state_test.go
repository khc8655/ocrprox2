package config

// PersistKeyTestState is the disk path behind the console's per-key "测试"
// button: the verdict must survive a refresh without an explicit provider save,
// and it must never touch the stored secret or any other key attribute.

import (
	"context"
	"testing"

	"github.com/khc8655/llmproxy2/internal/types"
)

func newKeyTestStateSource(t *testing.T) *LocalSource {
	t.Helper()
	tmpDir := t.TempDir()
	src, err := NewLocalSource(tmpDir, "test-pass")
	if err != nil {
		t.Fatalf("NewLocalSource: %v", err)
	}
	if _, err := src.SaveConfig(&types.ProxyConfig{
		Version: 1,
		Providers: map[string]*types.ProviderConfig{
			"prov-a": {
				ID: "prov-a", BaseURL: "https://a.example.com", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "ka", Label: "key-a", Key: "sk-secret-a", Enabled: true}},
			},
			"prov-b": {
				ID: "prov-b", BaseURL: "https://b.example.com", Enabled: true,
				APIKeys: []*types.KeyEntry{{ID: "kb", Label: "key-b", Key: "sk-secret-b", Enabled: true}},
			},
		},
	}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	return src
}

func TestPersistKeyTestState_KeepsSecretAndIsolatesProvider(t *testing.T) {
	src := newKeyTestStateSource(t)

	err := src.PersistKeyTestState("prov-a", "ka", "key-a", &types.KeyLastTest{
		OK: true, Status: 200, LatencyMS: 42, ReplyText: "你好", At: "2026-11-25T10:00:00Z",
	})
	if err != nil {
		t.Fatalf("PersistKeyTestState: %v", err)
	}

	snap, err := src.Current(context.Background(), true)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}

	ka := snap.Config.Providers["prov-a"].APIKeys[0]
	if ka.Key != "sk-secret-a" {
		t.Fatalf("secret must survive a metadata-only write, got %q", ka.Key)
	}
	if !ka.Enabled {
		t.Fatal("enabled flag must survive a metadata-only write")
	}
	if ka.LastTest == nil || ka.LastTest.Status != 200 || ka.LastTest.ReplyText != "你好" {
		t.Fatalf("last_test not persisted, got %+v", ka.LastTest)
	}

	// Same label on another provider must stay untouched: resolution is scoped
	// to the provider the caller named.
	kb := snap.Config.Providers["prov-b"].APIKeys[0]
	if kb.LastTest != nil {
		t.Fatalf("prov-b must not receive prov-a's verdict, got %+v", kb.LastTest)
	}
	if kb.Key != "sk-secret-b" {
		t.Fatalf("prov-b secret changed, got %q", kb.Key)
	}
}

func TestPersistKeyTestState_RejectsUnknownProvider(t *testing.T) {
	src := newKeyTestStateSource(t)
	err := src.PersistKeyTestState("nope", "ka", "key-a", &types.KeyLastTest{Status: 200})
	if err == nil {
		t.Fatal("expected an error for an unknown provider")
	}
}

func TestPersistKeyEntry_DoesNotWipeSecretWhenNoneSupplied(t *testing.T) {
	src := newKeyTestStateSource(t)
	// An entry carrying only metadata (no Key) must not blank the stored secret.
	if err := src.PersistKeyEntry(context.Background(), &types.KeyEntry{
		ID: "ka", LastTest: &types.KeyLastTest{Status: 200},
	}); err != nil {
		t.Fatalf("PersistKeyEntry: %v", err)
	}
	snap, _ := src.Current(context.Background(), true)
	if got := snap.Config.Providers["prov-a"].APIKeys[0].Key; got != "sk-secret-a" {
		t.Fatalf("secret was wiped by a metadata-only persist, got %q", got)
	}
}
