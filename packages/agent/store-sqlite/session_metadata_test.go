package storesqlite

import "testing"

func TestSplitSessionRuntimeContextSeparatesPublicMetadataFromProviderPrivateState(t *testing.T) {
	metadata, internal, err := splitSessionRuntimeContext(map[string]any{
		"visible": false, "imported": true,
		"capabilities": []any{"planMode", "interrupt"},
		"usage": map[string]any{
			"contextWindow": map[string]any{"usedTokens": 33_168, "totalTokens": 400_000},
			"quotas": []any{map[string]any{
				"quotaType": "weekly", "percentRemaining": 75.5, "resetsAtUnixMs": 1_750_003_600_000,
			}},
		},
		"backgroundAgents": map[string]any{"count": 0, "items": []any{}},
		"goal":             map[string]any{"objective": "ship", "status": "active"},
		"providerConfig":   map[string]any{"threadId": "thread-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Visible || !metadata.Imported || len(metadata.Capabilities) != 2 ||
		metadata.Usage == nil || metadata.Usage.ContextWindow == nil || metadata.Usage.ContextWindow.UsedTokens != 33_168 ||
		metadata.BackgroundAgents == nil || metadata.Goal == nil || metadata.Goal.Objective != "ship" {
		t.Fatalf("metadata=%#v", metadata)
	}
	providerConfig, _ := internal["providerConfig"].(map[string]any)
	if providerConfig["threadId"] != "thread-1" {
		t.Fatalf("internal=%#v", internal)
	}
	for _, key := range sessionMetadataRuntimeContextKeys {
		if _, leaked := internal[key]; leaked {
			t.Fatalf("typed key %q leaked into internal context %#v", key, internal)
		}
	}
}

func TestSplitSessionRuntimeContextNormalizesClosedMetadataVocabularies(t *testing.T) {
	metadata, _, err := splitSessionRuntimeContext(map[string]any{
		"capabilities": []any{" planMode ", "planMode", "provider-private"},
		"backgroundAgents": map[string]any{"count": 1, "items": []any{map[string]any{
			"taskId": "task-1", "description": "work", "status": "queued",
		}}},
		"goal": map[string]any{"objective": "ship", "status": "usageLimited"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(metadata.Capabilities) != 1 || metadata.Capabilities[0] != "planMode" ||
		metadata.BackgroundAgents.Items[0].Status != "running" || metadata.Goal.Status != "usageLimited" {
		t.Fatalf("metadata=%#v", metadata)
	}
	if _, _, err := splitSessionRuntimeContext(map[string]any{
		"backgroundAgents": map[string]any{"count": 0, "items": []any{map[string]any{
			"taskId": "task-1", "description": "work", "status": "running",
		}}},
	}); err == nil {
		t.Fatal("running count mismatch error=nil")
	}
}
