package storesqlite

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestChildSessionsKeepImmutableRootAndParentRelations(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child-1", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "call-1",
		Provider: "codex", OccurredAtUnixMS: 20,
	}, "child-turn-1", 20)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child-2", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "child-1", ParentTurnID: "child-turn-1", ParentToolCallID: "call-2",
		Provider: "codex", OccurredAtUnixMS: 30,
	}, "child-turn-2", 30)

	roots, ok, err := store.ListSessions(ctx, "ws-1")
	if err != nil || !ok || len(roots) != 1 || roots[0].ID != "root" {
		t.Fatalf("ListSessions() = %#v ok=%v err=%v", roots, ok, err)
	}
	children, err := store.ListChildSessions(ctx, "ws-1", "root")
	if err != nil {
		t.Fatal(err)
	}
	if len(children) != 2 || children[0].ID != "child-1" || children[1].ID != "child-2" {
		t.Fatalf("ListChildSessions() = %#v", children)
	}
	if children[1].ParentAgentSessionID != "child-1" || children[1].RootAgentSessionID != "root" {
		t.Fatalf("nested child relation = %#v", children[1])
	}

	_, err = store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child-1", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "different-call",
		OccurredAtUnixMS: 40,
	})
	if err == nil || !strings.Contains(err.Error(), "parent tool call id is immutable") {
		t.Fatalf("changed creator relation error = %v", err)
	}
}

func TestChildSessionReportReturnsCanonicalRelations(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root",
		Kind: SessionKindRoot, Provider: "codex",
		OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "root",
		TurnID: "root-turn", Phase: TurnPhaseRunning,
		OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("root turn accepted=%v error=%v", accepted, err)
	}
	for index, childID := range []string{"child-b", "child-a"} {
		result, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: childID,
			Kind: SessionKindChild, Provider: "codex",
			RootAgentSessionID: "root", RootTurnID: "root-turn",
			ParentAgentSessionID: "root", ParentTurnID: "root-turn",
			ParentToolCallID: "call-" + childID,
			OccurredAtUnixMS: int64(3 + index),
			CreatedAtUnixMS:  10,
		})
		if err != nil {
			t.Fatal(err)
		}
		if result.Session.ID != childID ||
			result.Session.ParentAgentSessionID != "root" {
			t.Fatalf("%s canonical Session=%#v", childID, result.Session)
		}
	}
	refreshed, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child-b",
		Kind: SessionKindChild, Provider: "codex",
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn",
		ParentToolCallID: "call-child-b",
		OccurredAtUnixMS: 6,
	})
	if err != nil || refreshed.Session.ID != "child-b" {
		t.Fatalf("refreshed child-b=%#v error=%v", refreshed.Session, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "child-b",
		TurnID: "child-turn", Phase: TurnPhaseRunning,
		OccurredAtUnixMS: 7,
	}); err != nil || !accepted {
		t.Fatalf("child turn accepted=%v error=%v", accepted, err)
	}
	for index, nestedID := range []string{"nested-z", "nested-a"} {
		result, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: nestedID,
			Kind: SessionKindChild, Provider: "codex",
			RootAgentSessionID: "root", RootTurnID: "root-turn",
			ParentAgentSessionID: "child-b", ParentTurnID: "child-turn",
			ParentToolCallID: "call-" + nestedID,
			OccurredAtUnixMS: int64(8 + index),
			CreatedAtUnixMS:  20,
		})
		if err != nil {
			t.Fatal(err)
		}
		if result.Session.ID != nestedID ||
			result.Session.ParentAgentSessionID != "child-b" {
			t.Fatalf("%s canonical Session=%#v", nestedID, result.Session)
		}
	}
	graph, err := store.CaptureHistoricalSessionGraph(ctx, "ws-1", "root")
	if err != nil {
		t.Fatal(err)
	}
	if len(graph.Sessions) != 5 {
		t.Fatalf("captured Sessions=%#v", graph.Sessions)
	}
	if err := store.RestoreHistoricalSessionGraph(ctx, HistoricalSessionGraphRestoreInput{
		WorkspaceID: "ws-restore",
		UserID:      "user-restore",
		Graph:       graph,
	}); err != nil {
		t.Fatal(err)
	}
	restored, err := store.ListChildSessions(ctx, "ws-restore", "root")
	if err != nil {
		t.Fatal(err)
	}
	if len(restored) != 4 ||
		restored[0].ID != "child-a" ||
		restored[1].ID != "child-b" ||
		restored[2].ID != "nested-a" ||
		restored[3].ID != "nested-z" {
		t.Fatalf("restored children=%#v", restored)
	}
}

func TestChildSessionReportKeepsCreatorRelationImmutable(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root",
		Kind: SessionKindRoot, Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "root",
		TurnID: "root-turn", Phase: TurnPhaseRunning, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("root turn accepted=%v error=%v", accepted, err)
	}
	report := SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child",
		Kind: SessionKindChild, Provider: "codex",
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn",
		ParentToolCallID: "call-child", OccurredAtUnixMS: 3,
	}
	if _, err := store.ReportSessionState(ctx, report); err != nil {
		t.Fatal(err)
	}
	report.OccurredAtUnixMS = 4
	report.ParentToolCallID = "different-call"
	if _, err := store.ReportSessionState(ctx, report); err == nil ||
		!strings.Contains(err.Error(), "parent tool call id is immutable") {
		t.Fatalf("changed creator relation error=%v", err)
	}
}

func TestChildSessionRequiresLiveRootTurnAndExistingParentTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Provider: "claude-code", OccurredAtUnixMS: 10,
	}, "root-turn", 10)

	_, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "missing-turn", ParentToolCallID: "call-1",
		OccurredAtUnixMS: 20,
	})
	if err == nil || !strings.Contains(err.Error(), "root parent must use the root session and turn") {
		t.Fatalf("missing parent turn error = %v", err)
	}

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "root-turn",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 30,
	}); err != nil || !accepted {
		t.Fatalf("settle root turn accepted=%v err=%v", accepted, err)
	}
	_, err = store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "late-child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "call-late",
		OccurredAtUnixMS: 40,
	})
	if err == nil || !strings.Contains(err.Error(), "after its root turn settled") {
		t.Fatalf("late child error = %v", err)
	}
}

func TestDeleteSessionTombstonesEntireChildSessionTree(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedChildSessionTree(t, store)

	removed, err := store.DeleteSession(context.Background(), "ws-1", "root")
	if err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v err=%v", removed, err)
	}
	for _, sessionID := range []string{"root", "child-1", "child-2"} {
		deleted, err := store.SessionDeleted(context.Background(), "ws-1", sessionID)
		if err != nil || !deleted {
			t.Fatalf("SessionDeleted(%s)=%v err=%v", sessionID, deleted, err)
		}
	}
	for sessionID, turnID := range map[string]string{
		"root": "root-turn", "child-1": "child-turn-1", "child-2": "child-turn-2",
	} {
		if turn, found, err := store.GetTurn(context.Background(), "ws-1", sessionID, turnID); err != nil || !found || turn.Phase != TurnPhaseSettled || turn.Outcome != TurnOutcomeInterrupted {
			t.Fatalf("GetTurn(%s)=%#v found=%v err=%v, want preserved interrupted history", sessionID, turn, found, err)
		}
	}
}

func TestDeleteSessionsBatchExpandsChildSessionTree(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedChildSessionTree(t, store)

	result, err := store.DeleteSessionsBatch(context.Background(), DeleteSessionsBatchInput{
		WorkspaceID: "ws-1",
		SessionIDs:  []string{"root"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.RemovedSessions != 3 || len(result.RemovedSessionIDs) != 3 {
		t.Fatalf("DeleteSessionsBatch()=%#v", result)
	}
	for _, sessionID := range []string{"root", "child-1", "child-2"} {
		if !containsString(result.RemovedSessionIDs, sessionID) {
			t.Fatalf("removed session ids=%#v, want %s", result.RemovedSessionIDs, sessionID)
		}
	}
}

func TestDeleteSessionsBatchRejectsChangedDeletionPlan(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedChildSessionTree(t, store)

	_, err := store.DeleteSessionsBatch(context.Background(), DeleteSessionsBatchInput{
		WorkspaceID:        "ws-1",
		SessionIDs:         []string{"root"},
		ExpectedSessionIDs: []string{"root"},
	})
	if !errors.Is(err, ErrDeleteSessionsPlanChanged) {
		t.Fatalf("DeleteSessionsBatch() error = %v, want plan changed", err)
	}
	for _, sessionID := range []string{"root", "child-1", "child-2"} {
		if deleted, lookupErr := store.SessionDeleted(context.Background(), "ws-1", sessionID); lookupErr != nil || deleted {
			t.Fatalf("SessionDeleted(%s)=%v err=%v after rejected plan", sessionID, deleted, lookupErr)
		}
	}
}

func TestDeleteSessionsBatchPreservesRootPinnedAfterConditionalPlan(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedChildSessionTree(t, store)
	ctx := context.Background()
	sectionKey := RailSectionKeyForProject("/workspace/project")
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET rail_section_key = ?
WHERE workspace_id = 'ws-1' AND agent_session_id = 'root'
`, sectionKey); err != nil {
		t.Fatal(err)
	}
	input := DeleteSessionsBatchInput{
		WorkspaceID:                "ws-1",
		SessionIDs:                 []string{"root"},
		RequiredRootRailSectionKey: sectionKey,
		ExcludePinnedRoots:         true,
	}
	plan, err := store.PlanDeleteSessions(ctx, input)
	if err != nil || len(plan.SessionIDs) != 3 {
		t.Fatalf("PlanDeleteSessions() = %#v, error = %v", plan, err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET pinned_at_unix_ms = 100
WHERE workspace_id = 'ws-1' AND agent_session_id = 'root'
`); err != nil {
		t.Fatal(err)
	}
	input.ExpectedSessionIDs = plan.SessionIDs
	if _, err := store.DeleteSessionsBatch(ctx, input); !errors.Is(err, ErrDeleteSessionsPlanChanged) {
		t.Fatalf("DeleteSessionsBatch() error = %v, want plan changed", err)
	}
	for _, sessionID := range []string{"root", "child-1", "child-2"} {
		if deleted, lookupErr := store.SessionDeleted(ctx, "ws-1", sessionID); lookupErr != nil || deleted {
			t.Fatalf("SessionDeleted(%s)=%v err=%v after root was pinned", sessionID, deleted, lookupErr)
		}
	}
}

func seedChildSessionTree(t *testing.T, store *Store) {
	t.Helper()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child-1", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "call-1",
		Provider: "codex", OccurredAtUnixMS: 20,
	}, "child-turn-1", 20)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child-2", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "child-1", ParentTurnID: "child-turn-1", ParentToolCallID: "call-2",
		Provider: "codex", OccurredAtUnixMS: 30,
	}, "child-turn-2", 30)
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func reportSessionWithTurn(
	t *testing.T,
	store *Store,
	session SessionStateReport,
	turnID string,
	occurredAtUnixMS int64,
) {
	t.Helper()
	result, err := store.ReportActivityState(context.Background(), ActivityStateReport{
		Session: session,
		Turn: &TurnTransition{
			WorkspaceID: session.WorkspaceID, AgentSessionID: session.AgentSessionID,
			TurnID: turnID, Phase: TurnPhaseRunning, OccurredAtUnixMS: occurredAtUnixMS,
		},
	})
	if err != nil || !result.TurnAccepted {
		t.Fatalf("ReportActivityState(%s) accepted=%v err=%v", session.AgentSessionID, result.TurnAccepted, err)
	}
}
