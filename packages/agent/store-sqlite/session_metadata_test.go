package storesqlite

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestSplitSessionRuntimeContextSeparatesPublicMetadataFromProviderPrivateState(t *testing.T) {
	metadata, capabilities, internal, err := splitSessionRuntimeContext(map[string]any{
		"visible": false, "imported": true,
		"capabilities": []any{"planMode", "interrupt"},
		"usage": map[string]any{
			"contextWindow": map[string]any{"usedTokens": 33_168, "totalTokens": 400_000},
			"quotas": []any{map[string]any{
				"quotaType": "weekly", "percentRemaining": 75.5, "resetsAtUnixMs": 1_750_003_600_000,
			}},
		},
		"goal":           map[string]any{"objective": "ship", "status": "active"},
		"providerConfig": map[string]any{"threadId": "thread-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Visible || !metadata.Imported || capabilities == nil || len(capabilities.Values) != 2 ||
		metadata.Usage == nil || metadata.Usage.ContextWindow == nil || metadata.Usage.ContextWindow.UsedTokens != 33_168 ||
		metadata.Goal == nil || metadata.Goal.Objective != "ship" {
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

func TestSessionMetadataCapabilitySnapshotBackwardCompatibility(t *testing.T) {
	_, legacyUnknown, err := unmarshalSessionMetadata(`{"visible":true,"imported":false,"capabilities":[]}`)
	if err != nil {
		t.Fatal(err)
	}
	if legacyUnknown != nil {
		t.Fatalf("legacy empty capabilities = %#v, want unknown", legacyUnknown)
	}

	_, legacyReported, err := unmarshalSessionMetadata(`{"visible":true,"imported":false,"capabilities":["goalPause"]}`)
	if err != nil {
		t.Fatal(err)
	}
	if legacyReported == nil || len(legacyReported.Values) != 1 || legacyReported.Values[0] != "goalPause" {
		t.Fatalf("legacy non-empty capabilities = %#v, want reported", legacyReported)
	}

	raw, err := marshalSessionMetadata(SessionMetadata{Visible: true}, canonical.NewCapabilitySnapshot(nil))
	if err != nil {
		t.Fatal(err)
	}
	_, reportedEmpty, err := unmarshalSessionMetadata(raw)
	if err != nil {
		t.Fatal(err)
	}
	if reportedEmpty == nil || len(reportedEmpty.Values) != 0 {
		t.Fatalf("reported empty capabilities = %#v", reportedEmpty)
	}
}

func TestSplitSessionRuntimeContextUsesClosedMetadataVocabularies(t *testing.T) {
	metadata, capabilities, internal, err := splitSessionRuntimeContext(map[string]any{
		"capabilities": []any{" planMode ", "planMode", "provider-private"},
		"goal":         map[string]any{"objective": "ship", "status": "usageLimited"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if capabilities == nil || len(capabilities.Values) != 1 || capabilities.Values[0] != "planMode" ||
		metadata.Goal.Status != "usageLimited" {
		t.Fatalf("metadata=%#v", metadata)
	}
	if len(internal) != 0 {
		t.Fatalf("internal context = %#v, want empty", internal)
	}
}

func TestDecodeSessionGoalUsesCanonicalValidation(t *testing.T) {
	goal, err := DecodeSessionGoal(map[string]any{
		"objective": "ship", "status": "paused", "startedAtUnixMs": 10, "iterations": 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if goal.Objective != "ship" || goal.Status != "paused" || goal.StartedAtUnixMS != 10 || goal.Iterations != 2 {
		t.Fatalf("goal=%#v", goal)
	}
	if _, err := DecodeSessionGoal(map[string]any{"objective": "ship", "status": "unknown"}); err == nil {
		t.Fatal("DecodeSessionGoal() error=nil, want closed status validation")
	}
}
