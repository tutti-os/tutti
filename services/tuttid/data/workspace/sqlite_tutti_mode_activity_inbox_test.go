package workspace

import (
	"context"
	"errors"
	"strings"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

type failingSourceActivityRows struct {
	tuttiModeSourceActivityRows
	yielded bool
	failure error
}

func (rows *failingSourceActivityRows) Next() bool {
	if rows.yielded {
		return false
	}
	rows.yielded = rows.tuttiModeSourceActivityRows.Next()
	return rows.yielded
}

func (rows *failingSourceActivityRows) Err() error {
	if rows.yielded {
		return rows.failure
	}
	return rows.tuttiModeSourceActivityRows.Err()
}

func TestCanonicalSourceActivityCannotCommitWithoutDurableInboxMarker(t *testing.T) {
	t.Parallel()
	store := openTuttiModeExecutionStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: "workspace-activity-atomic", Name: "Activity atomicity",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.writeDB.ExecContext(
		ctx, `DROP TABLE workspace_tutti_source_activity_inbox`,
	); err != nil {
		t.Fatal(err)
	}

	_, err := store.ReportActivityState(ctx, agentactivitybiz.ActivityStateReport{
		Session: agentactivitybiz.SessionStateReport{
			WorkspaceID:      "workspace-activity-atomic",
			AgentSessionID:   "session-source",
			Kind:             agentactivitybiz.SessionKindRoot,
			Origin:           "runtime",
			Provider:         "codex",
			Status:           "working",
			OccurredAtUnixMS: 100,
		},
		Turn: &agentactivitybiz.TurnTransition{
			WorkspaceID:      "workspace-activity-atomic",
			AgentSessionID:   "session-source",
			TurnID:           "turn-source",
			Origin:           agentactivitybiz.TurnOriginUserPrompt,
			Phase:            agentactivitybiz.TurnPhaseRunning,
			StartedAtUnixMS:  100,
			OccurredAtUnixMS: 100,
		},
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "message-source",
			TurnID:           "turn-source",
			Role:             "user",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"clientSubmitId": "submit-source"},
			OccurredAtUnixMS: 100,
		}},
	})
	if err == nil ||
		!strings.Contains(err.Error(), "append Tutti mode source activity marker") {
		t.Fatalf("ReportActivityState() error = %v, want durable marker failure", err)
	}
	if _, found, getErr := store.GetTurn(
		ctx, "workspace-activity-atomic", "session-source", "turn-source",
	); getErr != nil || found {
		t.Fatalf(
			"canonical Turn committed without activity marker: found=%v error=%v",
			found, getErr,
		)
	}
}

func TestDeletingWorkspaceCascadesPendingSourceActivityMarkers(t *testing.T) {
	t.Parallel()
	store := openTuttiModeExecutionStore(t)
	ctx := context.Background()
	const workspaceID = "workspace-activity-delete"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Activity delete",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(
		ctx,
		agentactivitybiz.ActivityStateReport{
			Session: agentactivitybiz.SessionStateReport{
				WorkspaceID:      workspaceID,
				AgentSessionID:   "session-source",
				Kind:             agentactivitybiz.SessionKindRoot,
				Origin:           "runtime",
				Provider:         "codex",
				Status:           "working",
				OccurredAtUnixMS: 100,
			},
			Turn: &agentactivitybiz.TurnTransition{
				WorkspaceID:      workspaceID,
				AgentSessionID:   "session-source",
				TurnID:           "turn-source",
				Origin:           agentactivitybiz.TurnOriginUserPrompt,
				Phase:            agentactivitybiz.TurnPhaseRunning,
				StartedAtUnixMS:  100,
				OccurredAtUnixMS: 100,
			},
		},
	); err != nil {
		t.Fatal(err)
	}
	var before int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_tutti_source_activity_inbox
WHERE workspace_id = ?
`, workspaceID).Scan(&before); err != nil || before == 0 {
		t.Fatalf("pending markers before delete = %d, error=%v", before, err)
	}
	if err := store.Delete(ctx, workspaceID); err != nil {
		t.Fatal(err)
	}
	var after int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_tutti_source_activity_inbox
WHERE workspace_id = ?
`, workspaceID).Scan(&after); err != nil || after != 0 {
		t.Fatalf("pending markers after delete = %d, error=%v", after, err)
	}
}

func TestSourceActivityDrainRollsBackWhenRowIterationFails(t *testing.T) {
	t.Parallel()
	store := openTuttiModeExecutionStore(t)
	ctx := context.Background()
	const workspaceID = "workspace-activity-iteration-failure"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Activity iteration failure",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(
		ctx,
		agentactivitybiz.ActivityStateReport{
			Session: agentactivitybiz.SessionStateReport{
				WorkspaceID: workspaceID, AgentSessionID: "session-source",
				Kind: agentactivitybiz.SessionKindRoot, Origin: "runtime",
				Provider: "codex", Status: "working", OccurredAtUnixMS: 100,
			},
			Turn: &agentactivitybiz.TurnTransition{
				WorkspaceID: workspaceID, AgentSessionID: "session-source",
				TurnID: "turn-source", Origin: agentactivitybiz.TurnOriginUserPrompt,
				Phase:           agentactivitybiz.TurnPhaseRunning,
				StartedAtUnixMS: 100, OccurredAtUnixMS: 100,
			},
			Messages: []agentactivitybiz.MessageUpdate{{
				MessageID: "message-source", TurnID: "turn-source",
				Role: "user", Kind: "text", Status: "completed",
				OccurredAtUnixMS: 200,
			}},
		},
	); err != nil {
		t.Fatal(err)
	}
	iterationErr := errors.New("injected source activity iteration failure")
	store.sourceActivityRowsHook = func(
		rows tuttiModeSourceActivityRows,
	) tuttiModeSourceActivityRows {
		return &failingSourceActivityRows{
			tuttiModeSourceActivityRows: rows,
			failure:                     iterationErr,
		}
	}

	err := store.DrainTuttiModeSourceActivityInbox(ctx, workspaceID)
	if !errors.Is(err, iterationErr) {
		t.Fatalf("DrainTuttiModeSourceActivityInbox() error = %v, want %v", err, iterationErr)
	}
	var remaining int
	if countErr := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_tutti_source_activity_inbox
WHERE workspace_id = ?
`, workspaceID).Scan(&remaining); countErr != nil || remaining == 0 {
		t.Fatalf(
			"pending markers after iteration failure = %d, error=%v; want rollback/no loss",
			remaining, countErr,
		)
	}
}
