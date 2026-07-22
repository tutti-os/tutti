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
