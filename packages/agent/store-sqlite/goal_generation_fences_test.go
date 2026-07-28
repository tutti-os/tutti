package storesqlite

import (
	"context"
	"errors"
	"testing"
)

func TestGoalGenerationFencePersistsExactGenerationAndLeaseRecovery(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws", AgentSessionID: "session", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	target, _, created, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-op", WorkspaceID: "ws", AgentSessionID: "session",
		Action: "set", Objective: "keep working", ClientSubmitID: "goal-submit", OccurredAtUnixMS: 20,
	})
	if err != nil || !created {
		t.Fatalf("prepare target created=%v error=%v", created, err)
	}

	fence, created, err := store.PrepareGoalGenerationFence(ctx, GoalGenerationFencePrepare{
		FenceID: "fence-1", WorkspaceID: "ws", AgentSessionID: "session",
		TargetOperationID: "goal-op", ClientSubmitID: "fence-submit", Reason: "binding_revoked",
		OccurredAtUnixMS: 30,
	})
	if err != nil || !created {
		t.Fatalf("prepare fence=%#v created=%v error=%v", fence, created, err)
	}
	if fence.TargetRevision != target.GoalRevision || fence.TargetRepairEpoch != target.RepairEpoch ||
		fence.Status != GoalGenerationFenceStatusPending || fence.Reason != "binding_revoked" {
		t.Fatalf("prepared fence=%#v target=%#v", fence, target)
	}
	replayed, created, err := store.PrepareGoalGenerationFence(ctx, GoalGenerationFencePrepare{
		FenceID: "fence-1", WorkspaceID: "ws", AgentSessionID: "session",
		TargetOperationID: "goal-op", ClientSubmitID: "fence-submit", Reason: "binding_revoked",
		OccurredAtUnixMS: 31,
	})
	if err != nil || created || replayed.FenceID != fence.FenceID {
		t.Fatalf("replay fence=%#v created=%v error=%v", replayed, created, err)
	}

	claimable, err := store.ListClaimableGoalGenerationFences(ctx, ListClaimableGoalGenerationFencesInput{
		NowUnixMS: 40, Limit: 10,
	})
	if err != nil || len(claimable) != 1 || claimable[0].FenceID != "fence-1" {
		t.Fatalf("claimable=%#v error=%v", claimable, err)
	}
	leased, claimed, err := store.ClaimGoalGenerationFence(ctx, ClaimGoalGenerationFenceInput{
		FenceID: "fence-1", LeaseOwner: "worker-a", NowUnixMS: 40, LeaseExpiresAtMS: 80,
	})
	if err != nil || !claimed || leased.Status != GoalGenerationFenceStatusProcessing || leased.Attempt != 1 {
		t.Fatalf("leased=%#v claimed=%v error=%v", leased, claimed, err)
	}
	if _, claimed, err := store.ClaimGoalGenerationFence(ctx, ClaimGoalGenerationFenceInput{
		FenceID: "fence-1", LeaseOwner: "worker-b", NowUnixMS: 50, LeaseExpiresAtMS: 90,
	}); err != nil || claimed {
		t.Fatalf("second claim claimed=%v error=%v", claimed, err)
	}

	if count, err := store.RequeueLeasedGoalGenerationFencesOnStartup(ctx, 60); err != nil || count != 1 {
		t.Fatalf("startup requeue count=%d error=%v", count, err)
	}
	leased, claimed, err = store.ClaimGoalGenerationFence(ctx, ClaimGoalGenerationFenceInput{
		FenceID: "fence-1", LeaseOwner: "worker-b", NowUnixMS: 60, LeaseExpiresAtMS: 100,
	})
	if err != nil || !claimed || leased.Attempt != 2 {
		t.Fatalf("reclaimed=%#v claimed=%v error=%v", leased, claimed, err)
	}
	completed, changed, err := store.CompleteGoalGenerationFence(ctx, CompleteGoalGenerationFenceInput{
		FenceID: "fence-1", LeaseOwner: "worker-b", ClearOperationID: "clear-op", OccurredAtUnixMS: 70,
	})
	if err != nil || !changed || completed.Status != GoalGenerationFenceStatusCompleted ||
		completed.ClearOperationID != "clear-op" || completed.CompletedAtUnixMS != 70 {
		t.Fatalf("completed=%#v changed=%v error=%v", completed, changed, err)
	}
	persisted, err := store.ListGoalGenerationFencesForSession(ctx, "ws", "session")
	if err != nil || len(persisted) != 1 || persisted[0].TargetOperationID != "goal-op" {
		t.Fatalf("persisted=%#v error=%v", persisted, err)
	}
}

func TestGoalGenerationFenceRejectsCrossSessionAndIdentityReuse(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, sessionID := range []string{"session-a", "session-b"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws", AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 10,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-op", WorkspaceID: "ws", AgentSessionID: "session-a",
		Action: "set", Objective: "work", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.PrepareGoalGenerationFence(ctx, GoalGenerationFencePrepare{
		FenceID: "cross-session", WorkspaceID: "ws", AgentSessionID: "session-b",
		TargetOperationID: "goal-op", ClientSubmitID: "cross-submit", OccurredAtUnixMS: 30,
	}); !errors.Is(err, ErrGoalGenerationFenceConflict) {
		t.Fatalf("cross-session error=%v", err)
	}
	if _, _, err := store.PrepareGoalGenerationFence(ctx, GoalGenerationFencePrepare{
		FenceID: "fence", WorkspaceID: "ws", AgentSessionID: "session-a",
		TargetOperationID: "goal-op", ClientSubmitID: "submit-1", OccurredAtUnixMS: 40,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.PrepareGoalGenerationFence(ctx, GoalGenerationFencePrepare{
		FenceID: "fence", WorkspaceID: "ws", AgentSessionID: "session-a",
		TargetOperationID: "goal-op", ClientSubmitID: "submit-2", OccurredAtUnixMS: 50,
	}); !errors.Is(err, ErrGoalGenerationFenceConflict) {
		t.Fatalf("identity reuse error=%v", err)
	}
}
