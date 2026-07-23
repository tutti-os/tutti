package storesqlite

import (
	"context"
	"testing"
)

// TestRecordTurnTransitionPersistsParentTurnIDAndRelation verifies that the
// Store persists parent_turn_id and relation when a TurnTransition carries
// lineage metadata.
func TestRecordTurnTransitionPersistsParentTurnIDAndRelation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	// Seed: create session + parent turn (settled).
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-lin", AgentSessionID: "session-lin",
		Origin: "runtime", Provider: "codex", Status: "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState: %v", err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-lin", AgentSessionID: "session-lin",
		TurnID: "turn-parent", Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted,
		OccurredAtUnixMS: 110,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(parent) accepted=%v err=%v", accepted, err)
	}

	// Act: create a retry turn with lineage.
	retryTurn, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-lin", AgentSessionID: "session-lin",
		TurnID: "turn-retry", Phase: TurnPhaseSubmitted,
		OccurredAtUnixMS: 120,
		ParentTurnID:     "turn-parent",
		Relation:         TurnRelationRetry,
	})
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(retry) accepted=%v err=%v", accepted, err)
	}

	// Assert: the stored turn carries lineage.
	if retryTurn.ParentTurnID != "turn-parent" {
		t.Fatalf("retryTurn.ParentTurnID = %q, want %q", retryTurn.ParentTurnID, "turn-parent")
	}
	if retryTurn.Relation != TurnRelationRetry {
		t.Fatalf("retryTurn.Relation = %q, want %q", retryTurn.Relation, TurnRelationRetry)
	}

	// Assert: re-reading from store returns the same lineage.
	got, found, err := store.GetTurn(ctx, "ws-lin", "session-lin", "turn-retry")
	if err != nil || !found {
		t.Fatalf("GetTurn(retry) found=%v err=%v", found, err)
	}
	if got.ParentTurnID != "turn-parent" {
		t.Fatalf("GetTurn.ParentTurnID = %q, want %q", got.ParentTurnID, "turn-parent")
	}
	if got.Relation != TurnRelationRetry {
		t.Fatalf("GetTurn.Relation = %q, want %q", got.Relation, TurnRelationRetry)
	}

	// Assert: the parent turn is unaffected.
	parent, found, err := store.GetTurn(ctx, "ws-lin", "session-lin", "turn-parent")
	if err != nil || !found {
		t.Fatalf("GetTurn(parent) found=%v err=%v", found, err)
	}
	if parent.ParentTurnID != "" {
		t.Fatalf("parent.ParentTurnID = %q, want empty", parent.ParentTurnID)
	}
	if parent.Relation != "" {
		t.Fatalf("parent.Relation = %q, want empty", parent.Relation)
	}
	if parent.Phase != TurnPhaseSettled {
		t.Fatalf("parent.Phase = %q, want %q", parent.Phase, TurnPhaseSettled)
	}
}

// TestRecordTurnTransitionWithoutLineageFields verifies that turns created
// without lineage metadata work correctly (backward compatibility).
func TestRecordTurnTransitionWithoutLineageFields(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-nolin", AgentSessionID: "session-nolin",
		Origin: "runtime", Provider: "codex", Status: "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState: %v", err)
	}

	// Act: create a normal turn without any lineage.
	turn, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-nolin", AgentSessionID: "session-nolin",
		TurnID: "turn-normal", Phase: TurnPhaseSubmitted,
		OccurredAtUnixMS: 110,
	})
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition accepted=%v err=%v", accepted, err)
	}

	// Assert: lineage fields are empty, not null-panicking.
	if turn.ParentTurnID != "" {
		t.Fatalf("turn.ParentTurnID = %q, want empty", turn.ParentTurnID)
	}
	if turn.Relation != "" {
		t.Fatalf("turn.Relation = %q, want empty", turn.Relation)
	}

	// Assert: re-read is consistent.
	got, found, err := store.GetTurn(ctx, "ws-nolin", "session-nolin", "turn-normal")
	if err != nil || !found {
		t.Fatalf("GetTurn found=%v err=%v", found, err)
	}
	if got.ParentTurnID != "" || got.Relation != "" {
		t.Fatalf("GetTurn lineage = %q/%q, want empty/empty", got.ParentTurnID, got.Relation)
	}
}

// TestRecordTurnTransitionPersistsEditRelation verifies that the edit relation
// value is accepted and persisted.
func TestRecordTurnTransitionPersistsEditRelation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-edit", AgentSessionID: "session-edit",
		Origin: "runtime", Provider: "codex", Status: "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState: %v", err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-edit", AgentSessionID: "session-edit",
		TurnID: "turn-orig", Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted,
		OccurredAtUnixMS: 110,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(orig) accepted=%v err=%v", accepted, err)
	}

	turn, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-edit", AgentSessionID: "session-edit",
		TurnID: "turn-edit", Phase: TurnPhaseSubmitted,
		OccurredAtUnixMS: 120,
		ParentTurnID:     "turn-orig",
		Relation:         TurnRelationEdit,
	})
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(edit) accepted=%v err=%v", accepted, err)
	}
	if turn.Relation != TurnRelationEdit {
		t.Fatalf("turn.Relation = %q, want %q", turn.Relation, TurnRelationEdit)
	}
	if turn.ParentTurnID != "turn-orig" {
		t.Fatalf("turn.ParentTurnID = %q, want %q", turn.ParentTurnID, "turn-orig")
	}
}

// TestRecordTurnTransitionRejectsInvalidRelation verifies that the Store
// rejects an unknown relation value at the Go validation layer, before it
// reaches the SQLite CHECK constraint.
func TestRecordTurnTransitionRejectsInvalidRelation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-bad", AgentSessionID: "session-bad",
		Origin: "runtime", Provider: "codex", Status: "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState: %v", err)
	}

	_, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-bad", AgentSessionID: "session-bad",
		TurnID: "turn-bad", Phase: TurnPhaseSubmitted,
		OccurredAtUnixMS: 110,
		ParentTurnID:     "turn-parent",
		Relation:         TurnRelation("bogus"),
	})
	if err == nil {
		t.Fatalf("RecordTurnTransition(bogus relation) err=nil, want error")
	}
	if accepted {
		t.Fatalf("RecordTurnTransition(bogus relation) accepted=true, want false")
	}
}

func TestRecordTurnTransitionRejectsIncompleteOrSelfLineage(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-lineage-shape", AgentSessionID: "session-lineage-shape",
		Origin: "runtime", Provider: "codex", Status: "completed", OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}
	for _, transition := range []TurnTransition{
		{TurnID: "only-parent", ParentTurnID: "parent"},
		{TurnID: "only-relation", Relation: TurnRelationRetry},
		{TurnID: "self", ParentTurnID: "self", Relation: TurnRelationRetry},
	} {
		transition.WorkspaceID = "ws-lineage-shape"
		transition.AgentSessionID = "session-lineage-shape"
		transition.Phase = TurnPhaseSubmitted
		transition.OccurredAtUnixMS = 110
		if _, accepted, err := store.RecordTurnTransition(ctx, transition); err == nil || accepted {
			t.Fatalf("RecordTurnTransition(%#v) accepted=%v err=%v, want validation failure", transition, accepted, err)
		}
	}
}

func TestRecordTurnTransitionRejectsMissingOrUnsettledLineageParent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-lineage-parent", AgentSessionID: "session-lineage-parent",
		Origin: "runtime", Provider: "codex", Status: "completed", OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-lineage-parent", AgentSessionID: "session-lineage-parent", TurnID: "missing-parent-child",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 110, ParentTurnID: "missing", Relation: TurnRelationRetry,
	}); err == nil || accepted {
		t.Fatalf("missing parent accepted=%v err=%v, want validation failure", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-lineage-parent", AgentSessionID: "session-lineage-parent", TurnID: "running-parent",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 111,
	}); err != nil || !accepted {
		t.Fatalf("seed running parent accepted=%v err=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-lineage-parent", AgentSessionID: "session-lineage-parent", TurnID: "unsettled-parent-child",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 112, ParentTurnID: "running-parent", Relation: TurnRelationRetry,
	}); err == nil || accepted {
		t.Fatalf("unsettled parent accepted=%v err=%v, want validation failure", accepted, err)
	}
}
