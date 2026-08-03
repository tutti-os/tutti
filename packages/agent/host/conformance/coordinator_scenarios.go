package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

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
	// Runtime-operation processing owns the session actor. A plan decision must
	// dispatch its serialized send path directly rather than re-entering the
	// public actor-taking command; keep this bounded so every Host adapter
	// proves that regression cannot become a worker deadlock.
	planCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	operation, err := driver.SubmitPlanDecision(planCtx,
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
	fixture.Turn = &TurnSeed{
		TurnID:                  "turn-recovery",
		Phase:                   canonical.TurnPhaseWaiting,
		RootProviderTurnID:      "provider-turn-recovery",
		ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
	}
	fixture.Interaction = &InteractionSeed{
		RequestID: "request-recovery", TurnID: "turn-recovery",
		Kind: canonical.InteractionKindApproval, Status: canonical.InteractionStatusPending,
	}
	fixture.RecoverInteractive = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if err := driver.RecoverCore(ctx); err != nil {
		return fmt.Errorf("recover core: %w", err)
	}
	metrics := driver.Metrics()
	if metrics.ExecCalls != 0 {
		return fmt.Errorf(
			"accepted incomplete turn was re-dispatched during recovery: exec calls=%d",
			metrics.ExecCalls,
		)
	}
	steps := metrics.RecoverySteps
	want := []string{"runtime_requeue", "goal_requeue", "goal_inbox_requeue"}
	if len(steps) != len(want) {
		return fmt.Errorf("recovery steps=%v, want %v", steps, want)
	}
	for index := range want {
		if steps[index] != want[index] {
			return fmt.Errorf("recovery steps=%v, want %v", steps, want)
		}
	}
	if err := driver.RecoverPostListener(ctx); err != nil {
		return fmt.Errorf("post-listener recovery: %w", err)
	}
	return nil
}

func recoveryStepAppearsAfter(steps []string, start int, wanted string) bool {
	for _, step := range steps[start:] {
		if step == wanted {
			return true
		}
	}
	return false
}
