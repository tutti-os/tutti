package conformance

import (
	"context"
	"errors"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func runDirectAndTypedGoalEquivalence(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-goal-direct", "")
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	direct, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-direct", Action: "set", Objective: "ship it",
		SubmissionMetadata: map[string]any{"clientSubmitId": "goal-direct"},
	})
	if err != nil {
		return fmt.Errorf("direct goal control: %w", err)
	}
	fixture = liveSessionFixture("session-goal-typed", "")
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	typed, err := driver.SendInput(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-typed"}, agenthost.SendInput{
		Content:  []agenthost.PromptContentBlock{{Type: "text", Text: "/goal ship it"}},
		Metadata: map[string]any{"clientSubmitId": "goal-typed"},
	})
	if err != nil {
		return fmt.Errorf("typed goal control: %w", err)
	}
	if typed.Kind != "goalControl" || typed.TurnID != "" || driver.Metrics().ExecCalls != 0 {
		return fmt.Errorf("typed goal opened a turn: result=%#v metrics=%#v", typed, driver.Metrics())
	}
	if metadataString(direct.Goal, "objective") != "ship it" || metadataString(typed.Goal, "objective") != "ship it" || direct.Revision != typed.Revision {
		return fmt.Errorf("direct=%#v typed=%#v", direct, typed)
	}
	return nil
}

func runGoalActionLifecycle(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-actions", "")); err != nil {
		return err
	}
	ref := agenthost.GoalControlInput{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-actions"}
	for index, command := range []struct{ action, objective, status string }{
		{action: "set", objective: "ship it", status: "active"},
		{action: "pause", status: "paused"},
		{action: "resume", status: "active"},
		{action: "clear"},
	} {
		ref.Action, ref.Objective = command.action, command.objective
		result, err := driver.GoalControl(ctx, ref)
		if err != nil {
			return fmt.Errorf("goal %s: %w", command.action, err)
		}
		if result.Revision != int64(index+1) {
			return fmt.Errorf("goal %s revision=%d", command.action, result.Revision)
		}
		if command.action == "clear" && result.Goal != nil {
			return fmt.Errorf("clear goal=%#v", result.Goal)
		}
		if command.status != "" && metadataString(result.Goal, "status") != command.status {
			return fmt.Errorf("goal %s result=%#v", command.action, result)
		}
		if result.PendingOperationID != "" || result.SyncStatus != storesqlite.GoalSyncStatusSynced {
			return fmt.Errorf("goal %s did not durably commit provider confirmation: %#v", command.action, result)
		}
	}
	if driver.Metrics().GoalControlCalls != 4 {
		return fmt.Errorf("goal control calls=%d", driver.Metrics().GoalControlCalls)
	}
	return nil
}

func runGoalControlPreservesDurableGoalWithoutProviderObservation(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-goal-empty-status-observation", "")
	fixture.EmptyPauseResumeGoal = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	ref := agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-empty-status-observation",
		Action: "set", Objective: "keep visible",
	}
	if _, err := driver.GoalControl(ctx, ref); err != nil {
		return fmt.Errorf("set goal before empty provider observation: %w", err)
	}
	for _, command := range []struct {
		action string
		status string
	}{
		{action: "pause", status: "paused"},
		{action: "resume", status: "active"},
	} {
		ref.Action, ref.Objective = command.action, ""
		result, err := driver.GoalControl(ctx, ref)
		if err != nil {
			return fmt.Errorf("goal %s with empty provider observation: %w", command.action, err)
		}
		if metadataString(result.Goal, "objective") != "keep visible" ||
			metadataString(result.Goal, "status") != command.status {
			return fmt.Errorf("goal %s lost durable projection: %#v", command.action, result)
		}
		if result.PendingOperationID != "" || result.SyncStatus != storesqlite.GoalSyncStatusDiverged {
			return fmt.Errorf("goal %s empty observation state=%#v", command.action, result)
		}
	}
	return nil
}

func runDuplicateGoalClientSubmitID(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-idempotent", "")); err != nil {
		return err
	}
	input := agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-idempotent",
		Action: "set", Objective: "ship exactly once", ClientSubmitID: "goal-idempotent-1",
		SubmissionMetadata: map[string]any{"clientSubmitId": "ignored-legacy-id"},
	}
	first, err := driver.GoalControl(ctx, input)
	if err != nil {
		return fmt.Errorf("first goal control: %w", err)
	}
	second, err := driver.GoalControl(ctx, input)
	if err != nil {
		return fmt.Errorf("duplicate goal control: %w", err)
	}
	if first.Revision != 1 || second.Revision != first.Revision || driver.Metrics().GoalControlCalls != 1 {
		return fmt.Errorf("duplicate goal control was not idempotent: first=%#v second=%#v metrics=%#v", first, second, driver.Metrics())
	}
	return nil
}

func runProviderAuthoredGoalAdoption(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-provider-adoption", "")); err != nil {
		return err
	}
	input := agenthost.ProviderGoalAdoptionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-adoption",
		ProviderSessionID: "provider-session-goal-provider-adoption",
		Fingerprint:       "sha256:provider-goal-generation",
		Goal: map[string]any{
			"threadId":  "provider-session-goal-provider-adoption",
			"objective": "continue autonomously", "status": "active",
			"createdAt": int64(1_000), "updatedAt": int64(1_000),
		},
	}
	first, err := driver.AdoptProviderGoal(ctx, input)
	if err != nil {
		return fmt.Errorf("adopt provider goal: %w", err)
	}
	second, err := driver.AdoptProviderGoal(ctx, input)
	if err != nil {
		return fmt.Errorf("replay provider goal adoption: %w", err)
	}
	if first.OperationID == "" || first.OperationID != second.OperationID ||
		first.Revision != 1 || second.Revision != first.Revision ||
		first.PendingOperationID != "" || first.SyncStatus != storesqlite.GoalSyncStatusSynced ||
		metadataString(first.Goal, "objective") != "continue autonomously" {
		return fmt.Errorf("provider goal adoption was not durably idempotent: first=%#v second=%#v", first, second)
	}
	if driver.Metrics().GoalControlCalls != 0 {
		return fmt.Errorf("provider goal adoption redispatched mutation: metrics=%#v", driver.Metrics())
	}
	return nil
}

func runProviderAuthoredGoalActiveConflict(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-provider-active-conflict", "")); err != nil {
		return err
	}
	first := agenthost.ProviderGoalAdoptionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-active-conflict",
		ProviderSessionID: "provider-session-goal-provider-active-conflict",
		Fingerprint:       "sha256:provider-goal-active-first",
		Goal: map[string]any{
			"threadId":  "provider-session-goal-provider-active-conflict",
			"objective": "first", "status": "active",
		},
	}
	if _, err := driver.AdoptProviderGoal(ctx, first); err != nil {
		return fmt.Errorf("adopt first active provider goal: %w", err)
	}
	second := first
	second.Fingerprint = "sha256:provider-goal-active-second"
	second.ExpectedRevision = 1
	second.Goal = map[string]any{
		"threadId":  "provider-session-goal-provider-active-conflict",
		"objective": "second", "status": "active",
	}
	if _, err := driver.AdoptProviderGoal(ctx, second); !errors.Is(err, storesqlite.ErrGoalOperationConflict) {
		return fmt.Errorf("active provider goal replacement error=%v", err)
	}
	state, err := driver.GetGoalState(ctx, agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-active-conflict",
	})
	if err != nil {
		return err
	}
	if state.Revision != 1 || metadataString(state.Goal, "objective") != "first" {
		return fmt.Errorf("active provider goal changed after conflict: %#v", state)
	}
	return nil
}

func runProviderAuthoredGoalTerminalAdvancement(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-goal-provider-terminal-advance", "")
	fixture.CompleteGoalOnSet = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if _, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-terminal-advance",
		Action: "set", Objective: "terminal first",
	}); err != nil {
		return fmt.Errorf("create terminal provider goal: %w", err)
	}
	next, err := driver.AdoptProviderGoal(ctx, agenthost.ProviderGoalAdoptionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-terminal-advance",
		ProviderSessionID: "provider-session-goal-provider-terminal-advance",
		Fingerprint:       "sha256:provider-goal-after-terminal",
		ExpectedRevision:  1,
		Goal: map[string]any{
			"threadId":  "provider-session-goal-provider-terminal-advance",
			"objective": "after terminal", "status": "active",
		},
	})
	if err != nil {
		return fmt.Errorf("advance terminal provider goal: %w", err)
	}
	if next.Revision != 2 || metadataString(next.Goal, "objective") != "after terminal" {
		return fmt.Errorf("terminal provider goal did not advance: %#v", next)
	}
	return nil
}

func runProviderAuthoredGoalClearedAdvancement(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-provider-cleared-advance", "")); err != nil {
		return err
	}
	ref := agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-cleared-advance",
		Action: "set", Objective: "clear first",
	}
	if _, err := driver.GoalControl(ctx, ref); err != nil {
		return fmt.Errorf("create provider goal before clear: %w", err)
	}
	ref.Action, ref.Objective = "clear", ""
	if _, err := driver.GoalControl(ctx, ref); err != nil {
		return fmt.Errorf("clear provider goal: %w", err)
	}
	next, err := driver.AdoptProviderGoal(ctx, agenthost.ProviderGoalAdoptionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-cleared-advance",
		ProviderSessionID: "provider-session-goal-provider-cleared-advance",
		Fingerprint:       "sha256:provider-goal-after-clear",
		ExpectedRevision:  2,
		Goal: map[string]any{
			"threadId":  "provider-session-goal-provider-cleared-advance",
			"objective": "after clear", "status": "active",
		},
	})
	if err != nil {
		return fmt.Errorf("advance cleared provider goal: %w", err)
	}
	if next.Revision != 3 || metadataString(next.Goal, "objective") != "after clear" {
		return fmt.Errorf("cleared provider goal did not advance: %#v", next)
	}
	return nil
}

func runProviderAuthoredGoalStaleAfterClear(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-provider-stale-after-clear", "")); err != nil {
		return err
	}
	ref := agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-stale-after-clear",
		Action: "set", Objective: "clear first",
	}
	if _, err := driver.GoalControl(ctx, ref); err != nil {
		return fmt.Errorf("create Goal before stale provider observation: %w", err)
	}
	ref.Action, ref.Objective = "clear", ""
	if _, err := driver.GoalControl(ctx, ref); err != nil {
		return fmt.Errorf("clear Goal before stale provider observation: %w", err)
	}
	_, err := driver.AdoptProviderGoal(ctx, agenthost.ProviderGoalAdoptionInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-stale-after-clear",
		ProviderSessionID: "provider-session-goal-provider-stale-after-clear",
		Fingerprint:       "sha256:provider-goal-observed-before-clear",
		ExpectedRevision:  1,
		Goal: map[string]any{
			"threadId":  "provider-session-goal-provider-stale-after-clear",
			"objective": "clear first", "status": "active",
		},
	})
	if !errors.Is(err, storesqlite.ErrGoalGenerationSuperseded) {
		return fmt.Errorf("stale provider Goal adoption error=%v", err)
	}
	state, err := driver.GetGoalState(ctx, agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-provider-stale-after-clear",
	})
	if err != nil {
		return err
	}
	if state.Revision != 2 || state.Goal != nil || state.PendingOperationID != "" {
		return fmt.Errorf("stale provider Goal adoption changed cleared state: %#v", state)
	}
	return nil
}

func runGoalReconcileObservation(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-reconcile", "")); err != nil {
		return err
	}
	if _, err := driver.GoalControl(ctx, agenthost.GoalControlInput{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-reconcile", Action: "set", Objective: "reconcile me"}); err != nil {
		return err
	}
	result, err := driver.ReconcileGoal(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-reconcile"})
	if err != nil {
		return fmt.Errorf("reconcile goal: %w", err)
	}
	if metadataString(result.Goal, "objective") != "reconcile me" || driver.Metrics().GoalReconcileCalls == 0 {
		return fmt.Errorf("reconcile result=%#v metrics=%#v", result, driver.Metrics())
	}
	return nil
}

func runGoalRevisionActorFence(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-fence", "")); err != nil {
		return err
	}
	inputs := []agenthost.GoalControlInput{
		{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-fence", Action: "set", Objective: "first"},
		{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-fence", Action: "clear"},
	}
	errs := make(chan error, len(inputs))
	for _, input := range inputs {
		input := input
		go func() { _, err := driver.GoalControl(ctx, input); errs <- err }()
	}
	for range inputs {
		if err := <-errs; err != nil {
			return fmt.Errorf("concurrent goal control: %w", err)
		}
	}
	state, err := driver.GetGoalState(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-fence"})
	if err != nil {
		return err
	}
	if state.Revision != 2 || driver.Metrics().GoalControlCalls != 2 {
		return fmt.Errorf("goal fence state=%#v", state)
	}
	return nil
}

func runGoalGenerationFencePreservesNewerGoal(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-goal-generation-fence", "")); err != nil {
		return err
	}
	target, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-generation-fence",
		Action: "set", Objective: "shared work", ClientSubmitID: "shared-goal",
		SubmissionMetadata: map[string]any{"clientSubmitId": "shared-goal"},
	})
	if err != nil || target.OperationID == "" {
		return fmt.Errorf("prepare shared Goal operation: result=%#v error=%w", target, err)
	}
	if _, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-generation-fence",
		Action: "set", Objective: "owner work", ClientSubmitID: "owner-goal",
		SubmissionMetadata: map[string]any{"clientSubmitId": "owner-goal"},
	}); err != nil {
		return fmt.Errorf("prepare owner Goal operation: %w", err)
	}
	fenced, err := driver.FenceGoalGeneration(ctx, agenthost.FenceGoalGenerationInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-generation-fence",
		TargetOperationID: target.OperationID, ClientSubmitID: "binding-revoked",
		Reason: "binding_revoked",
	})
	if err != nil || !fenced.IntentAccepted || !fenced.Settled {
		return fmt.Errorf("fence result=%#v error=%w", fenced, err)
	}
	state, err := driver.GetGoalState(ctx, agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-generation-fence",
	})
	if err != nil {
		return err
	}
	if state.Revision != 2 || metadataString(state.Goal, "objective") != "owner work" {
		return fmt.Errorf("generation fence changed newer owner Goal: %#v", state)
	}
	return nil
}

func runRestartCompletesOfflineGoalFenceWithoutReplay(ctx context.Context, driver Driver) error {
	const sessionID = "session-goal-fence-restart-stop"
	fixture := liveSessionFixture(sessionID, "")
	fixture.DisconnectGoalFenceDelivery = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	target, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: sessionID,
		Action: "set", Objective: "must not replay", ClientSubmitID: "old-goal",
	})
	if err != nil || target.OperationID == "" {
		return fmt.Errorf("prepare old Goal: result=%#v error=%w", target, err)
	}
	fenceInput := agenthost.FenceGoalGenerationInput{
		WorkspaceID: "workspace-1", AgentSessionID: sessionID,
		TargetOperationID: target.OperationID, ClientSubmitID: "restart-stop-fence",
		Reason: "binding_revoked",
	}
	fenced, err := driver.FenceGoalGeneration(ctx, fenceInput)
	if err == nil || !fenced.IntentAccepted || fenced.Settled {
		return fmt.Errorf("disconnected fence result=%#v error=%v", fenced, err)
	}
	beforeRecovery := driver.Metrics()
	if beforeRecovery.ResumeCalls != 0 || beforeRecovery.GoalControlCalls != 1 {
		return fmt.Errorf("fence failure resumed or replayed provider work: %#v", beforeRecovery)
	}
	if err := driver.Recover(ctx); err != nil {
		return fmt.Errorf("recover offline Goal fence: %w", err)
	}
	state, err := driver.GetGoalState(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: sessionID})
	if err != nil {
		return err
	}
	if state.Revision != 2 || state.Goal != nil || state.PendingOperationID != "" ||
		state.SyncStatus != storesqlite.GoalSyncStatusUnknown {
		return fmt.Errorf("offline recovery state=%#v", state)
	}
	afterRecovery := driver.Metrics()
	if afterRecovery.ResumeCalls != 0 || afterRecovery.GoalControlCalls != 1 || afterRecovery.CancelCalls != 0 {
		return fmt.Errorf("offline recovery reached provider: %#v", afterRecovery)
	}
	replayedFence, err := driver.FenceGoalGeneration(ctx, fenceInput)
	if err != nil || !replayedFence.IntentAccepted || !replayedFence.Settled {
		return fmt.Errorf("completed fence replay result=%#v error=%w", replayedFence, err)
	}
	if err := driver.Recover(ctx); err != nil {
		return fmt.Errorf("second restart recovery: %w", err)
	}
	afterSecondRecovery := driver.Metrics()
	if afterSecondRecovery.ResumeCalls != 0 || afterSecondRecovery.GoalControlCalls != 1 ||
		afterSecondRecovery.CancelCalls != 0 {
		return fmt.Errorf("second recovery retried stopped Goal: %#v", afterSecondRecovery)
	}
	if _, err := driver.EnsureSession(ctx, agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: sessionID,
	}); err != nil {
		return fmt.Errorf("manual Session resume: %w", err)
	}
	resumed := driver.Metrics()
	if resumed.ResumeCalls != 1 || len(resumed.LastResumeGoalGenerationFences) != 1 {
		return fmt.Errorf("manual resume did not preload durable fence: %#v", resumed)
	}
	preloaded := resumed.LastResumeGoalGenerationFences[0]
	if preloaded.TargetOperationID != target.OperationID || preloaded.TargetRevision != 1 || preloaded.RequireLive {
		return fmt.Errorf("preloaded fence=%#v", preloaded)
	}
	if _, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: sessionID,
		Action: "set", Objective: "new generation", ClientSubmitID: "new-goal",
	}); err != nil {
		return fmt.Errorf("submit new Goal generation: %w", err)
	}
	finalState, err := driver.GetGoalState(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: sessionID})
	if err != nil {
		return err
	}
	if finalState.Revision != 3 || metadataString(finalState.Goal, "objective") != "new generation" ||
		driver.Metrics().GoalControlCalls != 2 {
		return fmt.Errorf("new Goal state=%#v metrics=%#v", finalState, driver.Metrics())
	}
	return nil
}

func runAcceptedGoalControlWaitsWithoutReplay(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-goal-accepted", "")
	fixture.AcceptGoalControlsOnly = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	result, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-accepted",
		Action: "clear", ClientSubmitID: "goal-clear-accepted",
	})
	if err != nil {
		return fmt.Errorf("accepted goal clear: %w", err)
	}
	if result.PendingOperationID == "" || result.SyncStatus != storesqlite.GoalSyncStatusApplying {
		return fmt.Errorf("accepted goal clear state=%#v", result)
	}
	if calls := driver.Metrics().GoalControlCalls; calls != 1 {
		return fmt.Errorf("initial goal control calls=%d", calls)
	}
	if err := driver.StepGoalOperations(ctx, 7_000); err != nil {
		return fmt.Errorf("step accepted goal worker: %w", err)
	}
	if calls := driver.Metrics().GoalControlCalls; calls != 1 {
		return fmt.Errorf("accepted goal control replayed: calls=%d", calls)
	}
	state, err := driver.GetGoalState(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-goal-accepted"})
	if err != nil {
		return err
	}
	if state.PendingOperationID != result.PendingOperationID || state.SyncStatus != storesqlite.GoalSyncStatusApplying {
		return fmt.Errorf("accepted goal state after worker=%#v", state)
	}
	return nil
}

func runTurnlessGoalSessionResumesAfterDisconnect(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-turnless-goal-resume"}
	_, turnID, err := driver.Create(ctx, ref.WorkspaceID, agenthost.CreateSessionInput{
		AgentSessionID: ref.AgentSessionID, AgentTargetID: "target-1", Provider: "codex",
		ClientSubmitID: "turnless-goal-create-1",
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action: "set", Objective: "survive provider reconnect",
		},
	})
	if err != nil {
		return fmt.Errorf("create turnless Goal session: %w", err)
	}
	if turnID != "" {
		return fmt.Errorf("turnless Goal session opened turn %q", turnID)
	}
	if err := driver.DisconnectRuntimeSession(ctx, ref); err != nil {
		return fmt.Errorf("disconnect turnless Goal session: %w", err)
	}
	resumed, err := driver.EnsureSession(ctx, ref)
	if err != nil {
		return fmt.Errorf("resume turnless Goal session: %w", err)
	}
	if resumed.SessionID != ref.AgentSessionID || !resumed.Resumable {
		return fmt.Errorf("resumed turnless Goal session=%#v", resumed)
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.ResumeCalls != 1 || metrics.GoalControlCalls != 1 {
		return fmt.Errorf("turnless Goal resume metrics=%#v", metrics)
	}
	return nil
}

func runGoalIntentAcceptedBeforeRuntimeReadinessFailure(ctx context.Context, driver Driver) error {
	fixture := Fixture{
		Session: &SessionSeed{
			WorkspaceID: "workspace-1", AgentSessionID: "session-goal-readiness-failure", Provider: "codex",
			ProviderSessionID: "provider-session-goal-readiness-failure", Cwd: "/workspace",
		},
		Turn: &TurnSeed{
			TurnID: "turn-canceled-before-provider-start", Phase: storesqlite.TurnPhaseSettled,
			Outcome: storesqlite.TurnOutcomeCanceled,
		},
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	result, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-goal-readiness-failure",
		Action: "set", Objective: "persist before delivery", ClientSubmitID: "goal-readiness-failure-1",
	})
	if !errors.Is(err, agenthost.ErrProviderSessionNotEstablished) {
		return fmt.Errorf("goal readiness error=%v", err)
	}
	if !result.IntentAccepted || result.OperationID == "" ||
		result.PendingOperationID != result.OperationID || result.SyncStatus != storesqlite.GoalSyncStatusPending ||
		metadataString(result.Goal, "objective") != "persist before delivery" {
		return fmt.Errorf("accepted Goal readiness result=%#v", result)
	}
	if metrics := driver.Metrics(); metrics.ResumeCalls != 0 || metrics.GoalControlCalls != 0 {
		return fmt.Errorf("failed readiness reached runtime: metrics=%#v", metrics)
	}
	return nil
}

func runGoalInboxConsumerPreflight(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-goal-no-consumer", "")
	fixture.DisableGoalInbox = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if err := driver.Recover(ctx); !errors.Is(err, agenthost.ErrGoalConsumerUnavailable) {
		return fmt.Errorf("missing goal consumer error=%v", err)
	}
	if steps := driver.Metrics().RecoverySteps; len(steps) != 0 {
		return fmt.Errorf("missing goal consumer ran recovery before preflight failure: %v", steps)
	}
	return nil
}

func metadataString(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}
