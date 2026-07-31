package agent

import (
	"context"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestCollaborationTimelineReporterPersistsTurnlessMessageUpdatesInPlace(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	projection := NewActivityProjection(store)
	if _, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
		SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Provider: "codex", CurrentPhase: "idle", OccurredAtUnixMS: 1000,
		},
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	reporter := CollaborationTimelineReporter{Projection: projection}
	run := collabrunbiz.Run{
		ID: "run-1", WorkspaceID: "ws-1", SourceSessionID: "session-1",
		Mode: collabrunbiz.ModeDelegate, TriggerSource: collabrunbiz.TriggerUser,
		Status: collabrunbiz.StatusCompleted, Adoption: collabrunbiz.AdoptionPending,
		CreatedAt: time.UnixMilli(2000), UpdatedAt: time.UnixMilli(2000),
	}
	reporter.ReportCollaborationTimeline(ctx, run)

	run.Adoption = collabrunbiz.AdoptionAdopted
	run.UpdatedAt = time.UnixMilli(3000)
	reporter.ReportCollaborationTimeline(ctx, run)

	page, ok := projection.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Order: agentactivitybiz.MessageOrderAsc, Limit: 20,
	})
	if !ok || len(page.Messages) != 1 {
		t.Fatalf("messages = %#v, ok = %v", page.Messages, ok)
	}
	message := page.Messages[0]
	if message.MessageID != "collab:run-1" || message.Kind != "collaboration" || message.TurnID != "" {
		t.Fatalf("message = %#v", message)
	}
	if message.Version != 2 || message.Payload["adoption"] != string(collabrunbiz.AdoptionAdopted) {
		t.Fatalf("updated message = %#v", message)
	}
	if _, exists, err := store.GetTurn(ctx, "ws-1", "session-1", "collab:run-1"); err != nil || exists {
		t.Fatalf("synthetic turn exists = %v, err = %v; want absent", exists, err)
	}
}
