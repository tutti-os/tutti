package agent

import (
	"context"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

// These cases intentionally stay in tuttid: they exercise the concrete
// workspace SQLite adapter and provider-runtime bridge together with Host.
// Provider-neutral actor and recovery-policy semantics live in packages/agent/host.

func TestGoalRecoveryDoesNotReplayAcceptedClaudeSet(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-recovery", Name: "Goal Recovery"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-recovery", AgentSessionID: "session-goal-recovery", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-unsafe-set", WorkspaceID: "ws-goal-recovery", AgentSessionID: "session-goal-recovery",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-goal-recovery", "goal-unsafe-set", 21); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AcknowledgeGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationAcknowledge{
		WorkspaceID: "ws-goal-recovery", OperationID: "goal-unsafe-set",
		Evidence: map[string]any{"phase": "accepted"}, OccurredAtUnixMS: 22,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.goalRecoveryPolicyHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
		return RuntimeGoalRecoveryPolicy{QuerySupported: false, ReplaySetAfterRestart: false}, nil
	}
	runtime.sessions["ws-goal-recovery:session-goal-recovery"] = ProviderRuntimeSession{
		ID: "session-goal-recovery", Provider: "claude-code", ProviderSessionID: "claude-session", Status: "ready",
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-recovery-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(6000) }
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, true); err != nil {
		t.Fatalf("recover accepted Claude set: %v", err)
	}
	if len(runtime.goalControlCalls) != 0 {
		t.Fatalf("unsafe Claude set replayed: %#v", runtime.goalControlCalls)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-goal-recovery", "goal-unsafe-set")
	if err != nil || !found || op.Status != "failed" {
		t.Fatalf("operation=%#v found=%v error=%v", op, found, err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-goal-recovery", "session-goal-recovery")
	if err != nil || !found || state.SyncStatus != agentactivitybiz.GoalSyncStatusFailed || state.PendingOperationID != "" {
		t.Fatalf("state=%#v found=%v error=%v", state, found, err)
	}
}

func TestGoalRecoveryTimeoutThenRestartDoesNotReplayClaudeSet(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-timeout", Name: "Goal Timeout"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-timeout", AgentSessionID: "session-goal-timeout", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-timeout-set", WorkspaceID: "ws-goal-timeout", AgentSessionID: "session-goal-timeout",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.goalRecoveryPolicyHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
		return RuntimeGoalRecoveryPolicy{QuerySupported: false, ReplaySetAfterRestart: false}, nil
	}
	runtime.sessions["ws-goal-timeout:session-goal-timeout"] = ProviderRuntimeSession{
		ID: "session-goal-timeout", Provider: "claude-code", ProviderSessionID: "claude-timeout", Status: "ready",
	}
	runtime.goalControlHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		return RuntimeGoalControlResult{}, context.DeadlineExceeded
	}
	nowMS := int64(30)
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-timeout-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(nowMS) }
	service.GoalOperationMaxAttempts = 1
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatalf("timeout attempt: %v", err)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-goal-timeout", "goal-timeout-set")
	if err != nil || !found || op.Status != agentactivitybiz.GoalOperationStatusDispatched ||
		op.ProviderPhase != agentactivitybiz.GoalProviderPhaseDispatched || op.LeaseOwner != "" || op.NextAttemptAtMS <= nowMS {
		t.Fatalf("timed out operation=%#v found=%v err=%v", op, found, err)
	}
	nowMS = op.NextAttemptAtMS
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatalf("startup recovery: %v", err)
	}
	op, found, err = store.GetGoalControlOperation(ctx, "ws-goal-timeout", "goal-timeout-set")
	if err != nil || !found || op.Status != agentactivitybiz.GoalOperationStatusFailed || op.LeaseOwner != "" {
		t.Fatalf("startup operation=%#v found=%v err=%v", op, found, err)
	}
	runtime.mu.Lock()
	callCount := len(runtime.goalControlCalls)
	runtime.mu.Unlock()
	if callCount != 1 {
		t.Fatalf("Claude set provider calls=%d, want exactly one", callCount)
	}
}

func TestGoalRepairSetTimeoutThenRestartDoesNotReplayClaudeSet(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-repair-set-timeout", Name: "Repair Set Timeout"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-repair-set-timeout", AgentSessionID: "session-repair-set-timeout", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-original-set", WorkspaceID: "ws-repair-set-timeout", AgentSessionID: "session-repair-set-timeout",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationComplete{
		WorkspaceID: "ws-repair-set-timeout", OperationID: "goal-original-set", Succeeded: true,
		Observed: map[string]any{"objective": "ship it", "status": "active"}, OccurredAtUnixMS: 21,
	}); err != nil {
		t.Fatal(err)
	}
	repair, _, created, err := store.EnsureOrWakeGoalRepairOperation(ctx, agentactivitybiz.EnsureGoalRepairOperationInput{
		WorkspaceID: "ws-repair-set-timeout", AgentSessionID: "session-repair-set-timeout",
		SourceOperationID: "stale-old-operation", SourceRevision: 0, CurrentRevision: 1, OccurredAtUnixMS: 30,
	})
	if err != nil || !created || repair.Action != "set" {
		t.Fatalf("repair=%#v created=%v err=%v", repair, created, err)
	}
	runtime := newFakeRuntime()
	runtime.goalRecoveryPolicyHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
		return RuntimeGoalRecoveryPolicy{QuerySupported: false, ReplaySetAfterRestart: false}, nil
	}
	runtime.sessions["ws-repair-set-timeout:session-repair-set-timeout"] = ProviderRuntimeSession{
		ID: "session-repair-set-timeout", Provider: "claude-code", ProviderSessionID: "claude-repair-timeout", Status: "ready",
	}
	runtime.goalControlHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
		return RuntimeGoalControlResult{}, context.DeadlineExceeded
	}
	nowMS := int64(30)
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-repair-timeout-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(nowMS) }
	service.GoalOperationMaxAttempts = 1
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	repair, found, err := store.GetGoalControlOperation(ctx, "ws-repair-set-timeout", repair.OperationID)
	if err != nil || !found || repair.ProviderPhase != agentactivitybiz.GoalProviderPhaseDispatched || repair.NextAttemptAtMS <= nowMS {
		t.Fatalf("timed out repair=%#v found=%v err=%v", repair, found, err)
	}
	nowMS = repair.NextAttemptAtMS
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	repair, found, err = store.GetGoalControlOperation(ctx, "ws-repair-set-timeout", repair.OperationID)
	if err != nil || !found || repair.Status != agentactivitybiz.GoalOperationStatusFailed {
		t.Fatalf("startup repair=%#v found=%v err=%v", repair, found, err)
	}
	runtime.mu.Lock()
	callCount := len(runtime.goalControlCalls)
	runtime.mu.Unlock()
	if callCount != 1 {
		t.Fatalf("repair set provider calls=%d, want exactly one", callCount)
	}
}

func TestAcceptedClaudeGoalExpiresWithoutProviderReplay(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal-accepted-age", Name: "Accepted Age"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-goal-accepted-age", AgentSessionID: "session-goal-accepted-age", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{
		OperationID: "goal-accepted-age", WorkspaceID: "ws-goal-accepted-age", AgentSessionID: "session-goal-accepted-age",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-goal-accepted-age", "goal-accepted-age", 21); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AcknowledgeGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationAcknowledge{
		WorkspaceID: "ws-goal-accepted-age", OperationID: "goal-accepted-age", OccurredAtUnixMS: 22,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-goal-accepted-age:session-goal-accepted-age"] = ProviderRuntimeSession{
		ID: "session-goal-accepted-age", Provider: "claude-code", ProviderSessionID: "claude-accepted", Status: "ready",
	}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "goal-accepted-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(130_000) }
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-goal-accepted-age", "goal-accepted-age")
	if err != nil || !found || op.Status != agentactivitybiz.GoalOperationStatusFailed {
		t.Fatalf("expired operation=%#v found=%v err=%v", op, found, err)
	}
	if len(runtime.goalControlCalls) != 0 {
		t.Fatalf("expired accepted operation replayed: %#v", runtime.goalControlCalls)
	}
}

func TestAcceptedClaudeClearExpiresWhenLifecycleEvidenceIsLost(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-clear-age", Name: "Clear Age"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{WorkspaceID: "ws-clear-age", AgentSessionID: "session-clear-age", Provider: "claude-code", OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationPrepare{OperationID: "clear-age", WorkspaceID: "ws-clear-age", AgentSessionID: "session-clear-age", Action: "clear", OccurredAtUnixMS: 20}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-clear-age", "clear-age", 21); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AcknowledgeGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationAcknowledge{WorkspaceID: "ws-clear-age", OperationID: "clear-age", OccurredAtUnixMS: 22}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	runtime.sessions["ws-clear-age:session-clear-age"] = ProviderRuntimeSession{ID: "session-clear-age", Provider: "claude-code", ProviderSessionID: "claude-clear-age", Status: "ready"}
	service := newIsolatedAgentService(runtime)
	service.GoalStateStore = store
	service.GoalOperationOwner = "clear-age-worker"
	service.GoalOperationClock = func() time.Time { return time.UnixMilli(130_000) }
	if err := service.ApplicationHost().StepGoalOperationWorker(ctx, false); err != nil {
		t.Fatal(err)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-clear-age", "clear-age")
	if err != nil || !found || op.Status != agentactivitybiz.GoalOperationStatusFailed {
		t.Fatalf("op=%#v found=%v err=%v", op, found, err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-clear-age", "session-clear-age")
	if err != nil || !found || state.PendingOperationID != "" || state.SyncStatus != agentactivitybiz.GoalSyncStatusFailed {
		t.Fatalf("state=%#v found=%v err=%v", state, found, err)
	}
	if len(runtime.goalControlCalls) != 0 {
		t.Fatalf("expired clear replayed: %#v", runtime.goalControlCalls)
	}
}
