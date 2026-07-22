package storesqlite

import (
	"context"
	"testing"
)

func TestUpdateSessionSettingsInvalidatesContextWindowWhenModelChanges(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	resetAt := int64(1_750_003_600_000)
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex",
		Model: "gpt-5.5", Settings: map[string]any{"model": "gpt-5.5"}, OccurredAtUnixMS: 100,
		RuntimeContext: map[string]any{
			"usage": map[string]any{
				"contextWindow": map[string]any{"usedTokens": 33_168, "totalTokens": 200_000},
				"quotas": []any{map[string]any{
					"quotaType": "weekly", "percentRemaining": 75.5, "resetsAtUnixMs": resetAt,
				}},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}

	updated, ok, err := store.UpdateSessionSettings(ctx, "ws-1", "session-1", "gpt-5.6-sol", map[string]any{"model": "gpt-5.6-sol"})
	if err != nil || !ok {
		t.Fatalf("UpdateSessionSettings() ok=%v error=%v", ok, err)
	}
	if updated.Metadata.Usage == nil {
		t.Fatal("usage=nil, want preserved quota usage")
	}
	if updated.Metadata.Usage.ContextWindow != nil {
		t.Fatalf("contextWindow=%#v, want invalidated after model change", updated.Metadata.Usage.ContextWindow)
	}
	if len(updated.Metadata.Usage.Quotas) != 1 || updated.Metadata.Usage.Quotas[0].QuotaType != "weekly" {
		t.Fatalf("quotas=%#v, want preserved quotas", updated.Metadata.Usage.Quotas)
	}
}

func TestUpdateSessionSettingsPreservesContextWindowWhenModelDoesNotChange(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "claude-code",
		Model: "opus", Settings: map[string]any{"model": "opus"}, OccurredAtUnixMS: 100,
		RuntimeContext: map[string]any{
			"usage": map[string]any{
				"contextWindow": map[string]any{"usedTokens": 33_168, "totalTokens": 1_000_000},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}

	updated, ok, err := store.UpdateSessionSettings(ctx, "ws-1", "session-1", "opus", map[string]any{
		"model": "opus", "permissionModeId": "full-access",
	})
	if err != nil || !ok {
		t.Fatalf("UpdateSessionSettings() ok=%v error=%v", ok, err)
	}
	if updated.Metadata.Usage == nil || updated.Metadata.Usage.ContextWindow == nil || updated.Metadata.Usage.ContextWindow.TotalTokens != 1_000_000 {
		t.Fatalf("usage=%#v, want unchanged context window", updated.Metadata.Usage)
	}
}
