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
		if turn, found, err := store.GetTurn(context.Background(), "ws-1", sessionID, turnID); err != nil || found {
			t.Fatalf("GetTurn(%s)=%#v found=%v err=%v", sessionID, turn, found, err)
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
