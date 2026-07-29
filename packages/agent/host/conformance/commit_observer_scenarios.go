package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func runRuntimeCommitObserverFailure(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-observer-runtime", "turn-observer-runtime")
	fixture.Turn = &TurnSeed{TurnID: "turn-observer-runtime", Phase: canonical.TurnPhaseWaiting}
	fixture.Interaction = &InteractionSeed{
		RequestID: "request-observer-runtime", TurnID: "turn-observer-runtime",
		Kind: canonical.InteractionKindQuestion, Status: canonical.InteractionStatusPending,
	}
	fixture.FailCommitObserver = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	optionID := "approve"
	if _, err := driver.SubmitInteractive(ctx,
		agenthost.InteractionRef{
			WorkspaceID: "workspace-1", AgentSessionID: "session-observer-runtime",
			TurnID: "turn-observer-runtime", RequestID: "request-observer-runtime",
		},
		agenthost.SubmitInteractiveInput{OptionID: &optionID},
	); err != nil {
		return fmt.Errorf("observer failure escaped committed runtime command: %w", err)
	}
	if commits := driver.Metrics().RuntimeOperationCommits; commits < 2 {
		return fmt.Errorf("runtime committed deltas=%d, want prepare and completion", commits)
	}
	return nil
}

func runGoalOperationCommittedDeltas(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-observer-goal", "")
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	result, err := driver.GoalControl(ctx, agenthost.GoalControlInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-observer-goal",
		Action: "set", Objective: "observe durable goal",
	})
	if err != nil {
		return fmt.Errorf("goal control: %w", err)
	}
	metrics := driver.Metrics()
	if result.SyncStatus != storesqlite.GoalSyncStatusSynced || metrics.GoalOperationCommits < 3 {
		return fmt.Errorf("goal result=%#v committed deltas=%d, want prepare/dispatch/complete", result, metrics.GoalOperationCommits)
	}
	return nil
}
