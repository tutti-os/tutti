package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func runExactTurnCancel(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-cancel", "turn-cancel")
	fixture.Turn = &TurnSeed{TurnID: "turn-cancel", Phase: canonical.TurnPhaseRunning}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	result, err := driver.CancelTurn(ctx, agenthost.CancelTurnInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-cancel", TurnID: "turn-cancel", Reason: "user_requested",
	})
	if err != nil {
		return fmt.Errorf("exact turn cancel: %w", err)
	}
	metrics := driver.Metrics()
	if !result.Canceled || result.TurnID != "turn-cancel" || metrics.CancelCalls != 1 || len(metrics.LastCancelTargets) != 1 ||
		metrics.LastCancelTargets[0].AgentSessionID != "session-cancel" || metrics.LastCancelTargets[0].TurnID != "turn-cancel" {
		return fmt.Errorf("cancel result=%#v metrics=%#v", result, metrics)
	}
	return nil
}

func runPlanDecision(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-plan", "plan-turn")
	fixture.Turn = &TurnSeed{TurnID: "plan-turn", Phase: canonical.TurnPhaseWaiting}
	fixture.Interaction = &InteractionSeed{
		RequestID: "plan-turn", TurnID: "plan-turn", Kind: canonical.InteractionKindPlan, Status: canonical.InteractionStatusPending,
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	operation, err := driver.SubmitPlanDecision(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-plan"},
		"plan-turn", "plan-turn", agenthost.SubmitPlanDecisionInput{
			PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1",
		},
	)
	if err != nil {
		return fmt.Errorf("submit plan decision: %w", err)
	}
	metrics := driver.Metrics()
	if operation.OperationID == "" || metrics.UpdateSettingsCalls != 1 || metrics.ExecCalls != 1 {
		return fmt.Errorf("plan operation=%#v metrics=%#v", operation, metrics)
	}
	return nil
}

func runRecoveryOrder(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-recovery", "turn-recovery")
	fixture.Turn = &TurnSeed{TurnID: "turn-recovery", Phase: canonical.TurnPhaseWaiting}
	fixture.Interaction = &InteractionSeed{
		RequestID: "request-recovery", TurnID: "turn-recovery",
		Kind: canonical.InteractionKindApproval, Status: canonical.InteractionStatusPending,
	}
	fixture.RecoverInteractive = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if err := driver.Recover(ctx); err != nil {
		return fmt.Errorf("recover host: %w", err)
	}
	steps := driver.Metrics().RecoverySteps
	want := []string{"runtime_requeue", "runtime_complete", "goal_requeue", "goal_inbox_requeue", "stale_settle", "worktree_sweep"}
	if len(steps) != len(want) {
		return fmt.Errorf("recovery steps=%v, want %v", steps, want)
	}
	for index := range want {
		if steps[index] != want[index] {
			return fmt.Errorf("recovery steps=%v, want %v", steps, want)
		}
	}
	return nil
}
