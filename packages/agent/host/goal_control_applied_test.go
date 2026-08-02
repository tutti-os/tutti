package agenthost

import (
	"context"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type registeringGoalRuntime struct {
	sink RuntimeGoalControlAppliedSink
}

func (*registeringGoalRuntime) GoalControl(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
	return RuntimeGoalControlResult{}, nil
}

func (r *registeringGoalRuntime) SetGoalControlAppliedSink(sink RuntimeGoalControlAppliedSink) {
	r.sink = sink
}

func TestHostRegistersGoalControlLifecycleWithStandardRuntimePort(t *testing.T) {
	t.Parallel()
	runtime := &registeringGoalRuntime{}
	New(Config{GoalRuntime: runtime})
	if runtime.sink == nil {
		t.Fatal("Host did not register its Goal lifecycle sink")
	}
}

func TestObserveRuntimeGoalProviderStatePublishesCompletedEffectiveGoal(t *testing.T) {
	t.Parallel()
	store := openGoalOperationWorkerStore(t)
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-provider", AgentSessionID: "session-provider",
		Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	operation, _, _, err := store.PrepareGoalControlOperation(t.Context(), storesqlite.GoalControlOperationPrepare{
		OperationID: "goal-op-provider", WorkspaceID: "workspace-provider", AgentSessionID: "session-provider",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(t.Context(), storesqlite.GoalControlOperationComplete{
		WorkspaceID: "workspace-provider", OperationID: operation.OperationID,
		Succeeded: true, Observed: map[string]any{"objective": "ship it", "status": "active"},
		Evidence: map[string]any{"source": "provider_ack", "confidence": "authoritative",
			"operationId": operation.OperationID, "revision": operation.GoalRevision, "repairEpoch": operation.RepairEpoch},
		OccurredAtUnixMS: 21,
	}); err != nil {
		t.Fatal(err)
	}

	host := New(Config{GoalStore: store})
	stale := RuntimeGoalProviderObservedInput{
		WorkspaceID: "workspace-provider", AgentSessionID: "session-provider",
		OperationID: operation.OperationID, GoalRevision: operation.GoalRevision + 1,
		Source: "transcript_mirror", UpdateType: "thread_goal_completed",
		Observed:         map[string]any{"objective": "ship it", "status": "complete"},
		OccurredAtUnixMS: 30,
	}
	if err := host.ObserveRuntimeGoalProviderState(t.Context(), stale); err != nil {
		t.Fatal(err)
	}
	state, found, err := store.GetSessionGoalState(t.Context(), "workspace-provider", "session-provider")
	if err != nil || !found || state.Observed["status"] != "active" {
		t.Fatalf("stale provider observation state=%#v found=%v error=%v", state, found, err)
	}

	exact := stale
	exact.GoalRevision = operation.GoalRevision
	exact.ProviderTurnID = "provider-turn-1"
	exact.Observed = map[string]any{
		"objective": "ship it", "status": "complete", "iterations": int64(3),
		"durationMs": int64(1200), "tokens": int64(420),
	}
	exact.OccurredAtUnixMS = 31
	if err := host.ObserveRuntimeGoalProviderState(t.Context(), exact); err != nil {
		t.Fatal(err)
	}
	state, found, err = store.GetSessionGoalState(t.Context(), "workspace-provider", "session-provider")
	if err != nil || !found || state.Observed["status"] != "complete" ||
		state.LastEvidence["source"] != "runtime_goal_provider_lifecycle" {
		t.Fatalf("exact provider observation state=%#v found=%v error=%v", state, found, err)
	}
	if goal := durableGoalForResponse(state); goal["status"] != "complete" || goal["iterations"] != 3 {
		t.Fatalf("effective response Goal=%#v", goal)
	}
	session, found, err := store.GetSession(t.Context(), "workspace-provider", "session-provider")
	if err != nil || !found {
		t.Fatalf("canonical Session found=%v error=%v", found, err)
	}
	if session.Metadata.Goal == nil || session.Metadata.Goal.Status != "complete" || session.Metadata.Goal.Iterations != 3 {
		t.Fatalf("canonical Session Goal=%#v", session.Metadata.Goal)
	}
}

func TestGoalProviderObservationInboxRecoversAndAppliesLifecycle(t *testing.T) {
	t.Parallel()
	store := openGoalOperationWorkerStore(t)
	ctx := t.Context()
	if _, err := store.ReportSessionState(ctx, storesqlite.SessionStateReport{
		WorkspaceID: "workspace-provider-inbox", AgentSessionID: "session-provider-inbox",
		Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	operation, _, _, err := store.PrepareGoalControlOperation(ctx, storesqlite.GoalControlOperationPrepare{
		OperationID: "goal-op-provider-inbox", WorkspaceID: "workspace-provider-inbox",
		AgentSessionID: "session-provider-inbox", Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, storesqlite.GoalControlOperationComplete{
		WorkspaceID: "workspace-provider-inbox", OperationID: operation.OperationID,
		Succeeded: true, Observed: map[string]any{"objective": "ship it", "status": "active"},
		Evidence: map[string]any{"source": "provider_ack", "confidence": "authoritative",
			"operationId": operation.OperationID, "revision": operation.GoalRevision, "repairEpoch": operation.RepairEpoch}, OccurredAtUnixMS: 21,
	}); err != nil {
		t.Fatal(err)
	}
	if created, err := store.PutGoalReconcileInbox(ctx, storesqlite.GoalReconcileInboxItem{
		RequestID: "goal-provider-observed:event-1", WorkspaceID: "workspace-provider-inbox",
		AgentSessionID: "session-provider-inbox", CreatedAtUnixMS: 30,
		Payload: map[string]any{
			"phase": "provider_observed", "expectedOperationId": operation.OperationID,
			"expectedRevision": operation.GoalRevision, "expectedRepairEpoch": operation.RepairEpoch,
			"providerSource": "transcript_mirror", "updateType": "thread_goal_completed",
			"observed":         map[string]any{"objective": "ship it", "status": "complete", "iterations": int64(3)},
			"occurredAtUnixMs": int64(31),
		},
	}); err != nil || !created {
		t.Fatalf("put provider observation created=%v error=%v", created, err)
	}
	host := New(Config{GoalStore: store, GoalInbox: store})
	if err := host.StepGoalReconcileInboxWorker(ctx); err != nil {
		t.Fatal(err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "workspace-provider-inbox", "session-provider-inbox")
	if err != nil || !found || state.Observed["status"] != "complete" {
		t.Fatalf("provider inbox state=%#v found=%v error=%v", state, found, err)
	}
}

func TestGoalRuntimeGenerationRestoresFromDurableAppliedOperation(t *testing.T) {
	t.Parallel()
	store := openGoalOperationWorkerStore(t)
	ctx := t.Context()
	if _, err := store.ReportSessionState(ctx, storesqlite.SessionStateReport{
		WorkspaceID: "workspace-restore", AgentSessionID: "session-restore",
		Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	operation, _, _, err := store.PrepareGoalControlOperation(ctx, storesqlite.GoalControlOperationPrepare{
		OperationID: "goal-op-restore", WorkspaceID: "workspace-restore", AgentSessionID: "session-restore",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.MarkGoalControlOperationDispatched(ctx, "workspace-restore", operation.OperationID, 21); err != nil || !changed {
		t.Fatalf("dispatch changed=%v error=%v", changed, err)
	}
	host := New(Config{GoalStore: store})
	if result, err := host.ObserveRuntimeGoalControlApplied(ctx, RuntimeGoalControlAppliedInput{
		WorkspaceID: "workspace-restore", AgentSessionID: "session-restore",
		OperationID: operation.OperationID, GoalRevision: operation.GoalRevision,
		RepairEpoch: operation.RepairEpoch, Action: "set",
		Observed:         map[string]any{"objective": "ship it", "status": "active"},
		OccurredAtUnixMS: 22,
	}); err != nil || !result.Accepted {
		t.Fatal(err)
	}

	generation, err := host.goalRuntimeGenerationForResume(ctx, "workspace-restore", "session-restore")
	if err != nil {
		t.Fatal(err)
	}
	if generation == nil || generation.OperationID != operation.OperationID ||
		generation.Revision != operation.GoalRevision || generation.RepairEpoch != operation.RepairEpoch ||
		generation.ActivatedAtUnixMS != 22 || metadataString(generation.Goal, "status") != "active" {
		t.Fatalf("restored generation=%#v", generation)
	}
}

func TestGoalProviderObservationCannotOvertakePendingRepair(t *testing.T) {
	t.Parallel()
	store := openGoalOperationWorkerStore(t)
	ctx := t.Context()
	if _, err := store.ReportSessionState(ctx, storesqlite.SessionStateReport{
		WorkspaceID: "workspace-repair", AgentSessionID: "session-repair",
		Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	operation, _, _, err := store.PrepareGoalControlOperation(ctx, storesqlite.GoalControlOperationPrepare{
		OperationID: "goal-op-before-repair", WorkspaceID: "workspace-repair", AgentSessionID: "session-repair",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, storesqlite.GoalControlOperationComplete{
		WorkspaceID: "workspace-repair", OperationID: operation.OperationID,
		Succeeded: true, Observed: map[string]any{"objective": "ship it", "status": "active"},
		Evidence: map[string]any{"source": "runtime_goal_control_lifecycle", "operationId": operation.OperationID,
			"revision": operation.GoalRevision, "repairEpoch": operation.RepairEpoch}, OccurredAtUnixMS: 21,
	}); err != nil {
		t.Fatal(err)
	}
	if _, state, created, err := store.EnsureOrWakeGoalRepairOperation(ctx, storesqlite.EnsureGoalRepairOperationInput{
		WorkspaceID: "workspace-repair", AgentSessionID: "session-repair",
		SourceOperationID: "source-stale", SourceRevision: 0, CurrentRevision: operation.GoalRevision,
		OccurredAtUnixMS: 30,
	}); err != nil || !created || state.PendingOperationID == "" {
		t.Fatalf("repair state=%#v created=%v error=%v", state, created, err)
	}
	host := New(Config{GoalStore: store})
	if err := host.ObserveRuntimeGoalProviderState(ctx, RuntimeGoalProviderObservedInput{
		WorkspaceID: "workspace-repair", AgentSessionID: "session-repair",
		OperationID: operation.OperationID, GoalRevision: operation.GoalRevision,
		RepairEpoch: operation.RepairEpoch, Source: "transcript_mirror",
		Observed:         map[string]any{"objective": "ship it", "status": "complete"},
		OccurredAtUnixMS: 31,
	}); err != nil {
		t.Fatal(err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "workspace-repair", "session-repair")
	if err != nil || !found || state.PendingOperationID == "" || metadataString(state.Observed, "status") != "active" {
		t.Fatalf("stale provider observation overtook repair: state=%#v found=%v error=%v", state, found, err)
	}
}

func TestObserveRuntimeGoalControlAppliedCompletesOnlyExactOperation(t *testing.T) {
	t.Parallel()
	store := openGoalOperationWorkerStore(t)
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace", AgentSessionID: "session", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	operation, _, _, err := store.PrepareGoalControlOperation(t.Context(), storesqlite.GoalControlOperationPrepare{
		OperationID: "goal-op-1", WorkspaceID: "workspace", AgentSessionID: "session",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.MarkGoalControlOperationDispatched(t.Context(), "workspace", operation.OperationID, 21); err != nil || !changed {
		t.Fatalf("dispatch changed=%v error=%v", changed, err)
	}

	host := New(Config{GoalStore: store})
	stale := RuntimeGoalControlAppliedInput{
		WorkspaceID: "workspace", AgentSessionID: "session", OperationID: operation.OperationID,
		GoalRevision: operation.GoalRevision + 1, Action: "set",
		Observed: map[string]any{"objective": "ship it", "status": "active"}, OccurredAtUnixMS: 30,
	}
	if result, err := host.ObserveRuntimeGoalControlApplied(t.Context(), stale); err != nil || result.Accepted {
		t.Fatal(err)
	}
	persisted, found, err := store.GetGoalControlOperation(t.Context(), "workspace", operation.OperationID)
	if err != nil || !found || persisted.Status != storesqlite.GoalOperationStatusDispatched {
		t.Fatalf("stale observation changed operation=%#v found=%v error=%v", persisted, found, err)
	}

	exact := stale
	exact.GoalRevision = operation.GoalRevision
	exact.ProviderTurnID = "provider-turn-1"
	exact.OccurredAtUnixMS = 31
	if result, err := host.ObserveRuntimeGoalControlApplied(t.Context(), exact); err != nil || !result.Accepted {
		t.Fatal(err)
	}
	persisted, found, err = store.GetGoalControlOperation(t.Context(), "workspace", operation.OperationID)
	if err != nil || !found || persisted.Status != storesqlite.GoalOperationStatusCompleted || persisted.ProviderPhase != storesqlite.GoalProviderPhaseApplied {
		t.Fatalf("exact observation operation=%#v found=%v error=%v", persisted, found, err)
	}
	state, found, err := store.GetSessionGoalState(t.Context(), "workspace", "session")
	if err != nil || !found || state.SyncStatus != storesqlite.GoalSyncStatusSynced || state.PendingOperationID != "" {
		t.Fatalf("exact observation state=%#v found=%v error=%v", state, found, err)
	}
	if state.LastEvidence["source"] != "runtime_goal_control_lifecycle" || state.LastEvidence["providerTurnId"] != "provider-turn-1" {
		t.Fatalf("exact observation evidence=%#v", state.LastEvidence)
	}

	if result, err := host.ObserveRuntimeGoalControlApplied(t.Context(), exact); err != nil || result.Accepted {
		t.Fatalf("duplicate observation: %v", err)
	}
}
