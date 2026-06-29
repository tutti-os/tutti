package workspace

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func BenchmarkSQLiteStoreListWorkspaceGeneratedFiles(b *testing.B) {
	store := openBenchmarkSQLiteStore(b)
	ctx := context.Background()
	const workspaceID = "ws-agent-generated-files-bench"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   workspaceID,
		Name: "Workspace Agent Generated Files Bench",
	}); err != nil {
		b.Fatalf("Create() error = %v", err)
	}
	seedGeneratedFileBenchmarkMessages(b, ctx, store, workspaceID, 100, 50)

	b.Run("empty-query-limit-30", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_, ok, err := store.ListWorkspaceGeneratedFiles(ctx, agentactivitybiz.ListWorkspaceGeneratedFilesInput{
				WorkspaceID: workspaceID,
				Limit:       30,
			})
			if err != nil || !ok {
				b.Fatalf("ListWorkspaceGeneratedFiles() ok=%v error=%v", ok, err)
			}
		}
	})

	b.Run("miss-query-limit-30", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_, ok, err := store.ListWorkspaceGeneratedFiles(ctx, agentactivitybiz.ListWorkspaceGeneratedFilesInput{
				WorkspaceID: workspaceID,
				Query:       "definitely-no-match",
				Limit:       30,
			})
			if err != nil || !ok {
				b.Fatalf("ListWorkspaceGeneratedFiles() ok=%v error=%v", ok, err)
			}
		}
	})
}

func openBenchmarkSQLiteStore(b *testing.B) *SQLiteStore {
	b.Helper()
	dbPath := filepath.Join(b.TempDir(), "tuttid.db")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		b.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	b.Cleanup(func() {
		_ = store.Close()
	})
	if err := store.Migrate(context.Background()); err != nil {
		b.Fatalf("Migrate() error = %v", err)
	}
	return store
}

func seedGeneratedFileBenchmarkMessages(
	b *testing.B,
	ctx context.Context,
	store *SQLiteStore,
	workspaceID string,
	sessionCount int,
	messagesPerSession int,
) {
	b.Helper()
	for sessionIndex := 0; sessionIndex < sessionCount; sessionIndex++ {
		sessionID := fmt.Sprintf("session-%03d", sessionIndex)
		if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID:      workspaceID,
			AgentSessionID:   sessionID,
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Cwd:              fmt.Sprintf("/workspace/project-%02d", sessionIndex%10),
			Status:           "completed",
			OccurredAtUnixMS: int64(1000 + sessionIndex),
		}); err != nil {
			b.Fatalf("ReportSessionState(%s) error = %v", sessionID, err)
		}
		for messageIndex := 0; messageIndex < messagesPerSession; messageIndex++ {
			if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
				WorkspaceID:    workspaceID,
				AgentSessionID: sessionID,
				Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
				Messages: []agentactivitybiz.MessageUpdate{{
					MessageID: fmt.Sprintf("message-%03d-%03d", sessionIndex, messageIndex),
					Role:      "assistant",
					Kind:      "tool_call",
					Status:    "completed",
					Payload: map[string]any{
						"toolName": "Write",
						"fileChanges": map[string]any{
							"files": []any{
								map[string]any{
									"path": fmt.Sprintf("generated/file-%03d-%03d.md", sessionIndex, messageIndex),
								},
							},
						},
					},
					OccurredAtUnixMS: int64(10_000 + sessionIndex*messagesPerSession + messageIndex),
				}},
			}); err != nil {
				b.Fatalf("ReportSessionMessages(%s) error = %v", sessionID, err)
			}
		}
	}
}
