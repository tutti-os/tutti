package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// runRetryTurnCreatesLineageTurn verifies that Host.RetryTurn creates a new
// turn with parent_turn_id and relation="retry", and that the parent turn
// remains unchanged.
//
// The scenario seeds a session with TWO settled turns so that the retried
// turn is not the first turn — this ensures RetryTurn resolves the correct
// parent turn's user input, not a different turn's input.
func runRetryTurnCreatesLineageTurn(ctx context.Context, driver Driver) error {
	const parentTurnID = "turn-parent"
	fixture := Fixture{
		Session: &SessionSeed{
			WorkspaceID: "workspace-1", AgentSessionID: "session-retry", Provider: "codex",
			ProviderSessionID: "provider-retry", Cwd: "/workspace", Title: "Retry test",
			InitialTitleEstablished: true, Live: true,
		},
		// Seed two settled turns so the retried parent is not the first turn.
		// Turn IDs avoid colliding with the conformance fake runtime's default
		// submitted turn id ("turn-1").
		AdditionalTurns: []TurnSeed{
			{TurnID: "turn-prior", Phase: canonical.TurnPhaseSettled, Outcome: canonical.TurnOutcomeCompleted},
			{TurnID: parentTurnID, Phase: canonical.TurnPhaseSettled, Outcome: canonical.TurnOutcomeCompleted},
		},
		// Seed user messages for both turns. Only the parent turn's text must
		// be re-sent; the prior turn is a decoy for TurnID-filtered lookup.
		Messages: []MessageSeed{
			{MessageID: "msg-prior-user", TurnID: "turn-prior", Role: "user", Kind: "text", Text: "first turn input"},
			{MessageID: "msg-parent-user", TurnID: parentTurnID, Role: "user", Kind: "text", Text: "change to python"},
		},
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}

	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-retry"}

	// Verify the parent turn has no lineage before retry.
	parentBefore, found, err := driver.GetTurn(ctx, ref, parentTurnID)
	if err != nil || !found {
		return fmt.Errorf("GetTurn(%s) before retry: found=%v err=%w", parentTurnID, found, err)
	}
	if parentBefore.ParentTurnID != "" || parentBefore.Relation != "" {
		return fmt.Errorf("parent turn before retry has lineage: parent=%q relation=%q", parentBefore.ParentTurnID, parentBefore.Relation)
	}

	// Retry the parent turn through the public Host contract.
	result, err := driver.RetryTurn(ctx, ref, parentTurnID)
	if err != nil {
		return fmt.Errorf("RetryTurn(%s): %w", parentTurnID, err)
	}
	if result.TurnID == "" || result.TurnID == parentTurnID {
		return fmt.Errorf("RetryTurn result turnID=%q, want a new non-empty turn ID", result.TurnID)
	}

	// Verify the new turn has correct lineage.
	newTurn, found, err := driver.GetTurn(ctx, ref, result.TurnID)
	if err != nil || !found {
		return fmt.Errorf("GetTurn(new turn %q): found=%v err=%w", result.TurnID, found, err)
	}
	if newTurn.ParentTurnID != parentTurnID {
		return fmt.Errorf("new turn ParentTurnID=%q, want %q", newTurn.ParentTurnID, parentTurnID)
	}
	if newTurn.Relation != string(agenthost.TurnRelationRetry) {
		return fmt.Errorf("new turn Relation=%q, want %q", newTurn.Relation, agenthost.TurnRelationRetry)
	}

	// Prove the Host re-sent turn-parent's input, not the earlier decoy.
	// Without this check, a TurnID-filter regression would still pass lineage
	// assertions while submitting the wrong prompt.
	metrics := driver.Metrics()
	if metrics.ExecCalls != 1 {
		return fmt.Errorf("RetryTurn exec calls=%d, want 1", metrics.ExecCalls)
	}
	if metrics.LastExecText != "change to python" {
		return fmt.Errorf("RetryTurn exec text=%q, want %q (not the prior-turn decoy)", metrics.LastExecText, "change to python")
	}

	// Verify the parent turn remains unchanged.
	parentAfter, found, err := driver.GetTurn(ctx, ref, parentTurnID)
	if err != nil || !found {
		return fmt.Errorf("GetTurn(%s) after retry: found=%v err=%w", parentTurnID, found, err)
	}
	if parentAfter.ParentTurnID != "" || parentAfter.Relation != "" {
		return fmt.Errorf("parent turn after retry has lineage: parent=%q relation=%q", parentAfter.ParentTurnID, parentAfter.Relation)
	}
	if parentAfter.Phase != canonical.TurnPhaseSettled {
		return fmt.Errorf("parent turn phase after retry=%q, want %q", parentAfter.Phase, canonical.TurnPhaseSettled)
	}

	return nil
}
