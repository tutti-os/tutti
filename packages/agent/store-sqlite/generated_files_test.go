package storesqlite

import (
	"context"
	"fmt"
	"testing"
)

func TestListWorkspaceGeneratedFilesFiltersAgentTargetsBeforeScanLimit(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	const workspaceID = "workspace-generated-file-agent-filter"

	for _, session := range []struct {
		id            string
		agentTargetID string
		provider      string
	}{
		{id: "wanted-session", agentTargetID: testTargetIDCodex, provider: "codex"},
		{id: "other-session", agentTargetID: testTargetIDClaude, provider: "claude-code"},
	} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID:      workspaceID,
			AgentSessionID:   session.id,
			Origin:           "runtime",
			AgentTargetID:    session.agentTargetID,
			Provider:         session.provider,
			Cwd:              "/workspace",
			Status:           "completed",
			OccurredAtUnixMS: 10,
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", session.id, err)
		}
		if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
			WorkspaceID: workspaceID, AgentSessionID: session.id, TurnID: "turn-" + session.id,
			Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, Origin: TurnOriginLegacyUnknown, OccurredAtUnixMS: 11,
		}); err != nil || !accepted {
			t.Fatalf("RecordTurnTransition(%s) accepted=%v error=%v", session.id, accepted, err)
		}
	}

	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID:    workspaceID,
		AgentSessionID: "wanted-session",
		Origin:         "runtime",
		Messages: []MessageUpdate{{
			MessageID: "wanted-message",
			TurnID:    "turn-wanted-session",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "completed",
			Payload: map[string]any{
				"toolName": "Write",
				"fileChanges": map[string]any{
					"files": []any{map[string]any{"path": "wanted.md"}},
				},
			},
			OccurredAtUnixMS: 100,
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages(wanted) error = %v", err)
	}

	otherMessages := make([]MessageUpdate, 500)
	for index := range otherMessages {
		otherMessages[index] = MessageUpdate{
			MessageID: fmt.Sprintf("other-message-%03d", index),
			TurnID:    "turn-other-session",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "completed",
			Payload: map[string]any{
				"toolName": "Write",
				"fileChanges": map[string]any{
					"files": []any{map[string]any{"path": fmt.Sprintf("other-%03d.md", index)}},
				},
			},
			OccurredAtUnixMS: int64(1_000 + index),
		}
	}
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID:    workspaceID,
		AgentSessionID: "other-session",
		Origin:         "runtime",
		Messages:       otherMessages,
	}); err != nil {
		t.Fatalf("ReportSessionMessages(other) error = %v", err)
	}

	result, ok, err := store.ListWorkspaceGeneratedFiles(ctx, ListWorkspaceGeneratedFilesInput{
		WorkspaceID:    workspaceID,
		AgentTargetIDs: []string{testTargetIDCodex},
		Limit:          1,
	})
	if err != nil {
		t.Fatalf("ListWorkspaceGeneratedFiles() error = %v", err)
	}
	if !ok {
		t.Fatal("ListWorkspaceGeneratedFiles() ok = false, want true")
	}
	if len(result.Files) != 1 || result.Files[0].Path != "/workspace/wanted.md" {
		t.Fatalf("files = %#v, want the older selected-agent file", result.Files)
	}
}
