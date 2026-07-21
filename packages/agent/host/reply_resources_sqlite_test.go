package agenthost_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

func TestAttachReplyResourceUsesCanonicalActiveTurnFence(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "reply-resources.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("record turn accepted=%v error=%v", accepted, err)
	}

	host := agenthost.New(agenthost.Config{ReplyResources: store})
	ref := agenthost.SessionRef{WorkspaceID: "ws-1", AgentSessionID: "session-1"}
	result, err := host.AttachReplyResource(t.Context(), ref, agenthost.AttachReplyResourceInput{
		TurnID:     "turn-1",
		ResourceID: "resource-1", DedupeKey: "sha256:abc", Kind: storesqlite.ReplyResourceKindLocalFile,
		SourceRef: "sha256_abc", ContentHash: "abc", DisplayName: "chart.png", MediaType: "image/png", SizeBytes: 42,
	})
	if err != nil || !result.Created || result.Resource.TurnID != "turn-1" {
		t.Fatalf("attach result=%#v error=%v", result, err)
	}

	if _, accepted, err := store.RecordTurnTransition(context.Background(), storesqlite.TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3,
	}); err != nil || !accepted {
		t.Fatalf("settle turn accepted=%v error=%v", accepted, err)
	}
	_, err = host.AttachReplyResource(t.Context(), ref, agenthost.AttachReplyResourceInput{
		TurnID:     "turn-1",
		ResourceID: "late", DedupeKey: "sha256:late", Kind: storesqlite.ReplyResourceKindLocalFile,
		SourceRef: "sha256_late", DisplayName: "late.txt",
	})
	if !errors.Is(err, agenthost.ErrNoActiveTurn) {
		t.Fatalf("late attach error = %v, want %v", err, agenthost.ErrNoActiveTurn)
	}
}
