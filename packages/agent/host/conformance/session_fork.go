package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func sessionForkInput() agenthost.ForkSessionInput {
	return agenthost.ForkSessionInput{
		WorkspaceID:          "workspace-fork",
		SourceAgentSessionID: "session-source",
		TargetAgentSessionID: "session-target",
		RequestID:            "request-fork",
		Point: agenthost.SessionForkPoint{
			Kind: agenthost.SessionForkPointThroughTurn, TurnID: "turn-boundary",
		},
	}
}

func runThroughTurnForkReplay(
	ctx context.Context,
	driver SessionForkDriver,
) error {
	if err := driver.ResetSessionFork(ctx, SessionForkFixture{
		FailFirstLocalCommit: true,
	}); err != nil {
		return err
	}
	input := sessionForkInput()
	first, err := driver.ForkSession(ctx, input)
	if err == nil ||
		first.Operation.Status != storesqlite.SessionForkStatusProviderAccepted {
		return fmt.Errorf(
			"first ForkSession() = status %q, error %v; want provider_accepted and local commit error",
			first.Operation.Status, err,
		)
	}
	second, err := driver.ForkSession(ctx, input)
	if err != nil {
		return fmt.Errorf("replayed ForkSession(): %w", err)
	}
	if second.Operation.Status != storesqlite.SessionForkStatusCommitted {
		return fmt.Errorf(
			"replayed ForkSession() status = %q, want committed",
			second.Operation.Status,
		)
	}
	if calls := driver.SessionForkMetrics().ProviderForkCalls; calls != 1 {
		return fmt.Errorf("provider ForkSession calls = %d, want 1", calls)
	}
	return nil
}

func runProviderAcceptedForkRecovery(
	ctx context.Context,
	driver SessionForkDriver,
) error {
	if err := driver.ResetSessionFork(ctx, SessionForkFixture{
		RecoverProviderAccepted: true,
	}); err != nil {
		return err
	}
	if err := driver.RecoverSessionForks(ctx); err != nil {
		return fmt.Errorf("RecoverSessionForks(): %w", err)
	}
	result, found, err := driver.GetSessionForkOperation(
		ctx, "workspace-fork", "operation-fork",
	)
	if err != nil {
		return err
	}
	if !found || result.Operation.Status != storesqlite.SessionForkStatusCommitted {
		return fmt.Errorf(
			"recovered operation = found %v, status %q; want committed",
			found, result.Operation.Status,
		)
	}
	if calls := driver.SessionForkMetrics().ProviderForkCalls; calls != 0 {
		return fmt.Errorf("provider ForkSession calls during recovery = %d, want 0", calls)
	}
	return nil
}

func runPermanentlyInconsistentForkRecovery(
	ctx context.Context,
	driver SessionForkDriver,
) error {
	if err := driver.ResetSessionFork(ctx, SessionForkFixture{
		RecoverProviderAccepted:        true,
		RecoverPermanentlyInconsistent: true,
	}); err != nil {
		return err
	}
	if err := driver.RecoverSessionForks(ctx); err != nil {
		return fmt.Errorf("RecoverSessionForks(): %w", err)
	}
	result, found, err := driver.GetSessionForkOperation(
		ctx, "workspace-fork", "operation-fork",
	)
	if err != nil {
		return err
	}
	if !found || result.Operation.Status != storesqlite.SessionForkStatusFailed {
		return fmt.Errorf(
			"recovered operation = found %v, status %q; want failed",
			found, result.Operation.Status,
		)
	}
	if calls := driver.SessionForkMetrics().ProviderForkCalls; calls != 0 {
		return fmt.Errorf("provider ForkSession calls during quarantine = %d, want 0", calls)
	}
	return nil
}

func runActiveSourceFork(
	ctx context.Context,
	driver SessionForkDriver,
) error {
	if err := driver.ResetSessionFork(ctx, SessionForkFixture{
		KeepSourceActive: true,
	}); err != nil {
		return err
	}
	result, err := driver.ForkSession(ctx, sessionForkInput())
	if err != nil {
		return fmt.Errorf("ForkSession(active source): %w", err)
	}
	if result.Operation.Status != storesqlite.SessionForkStatusCommitted {
		return fmt.Errorf(
			"ForkSession(active source) status = %q, want committed",
			result.Operation.Status,
		)
	}
	if calls := driver.SessionForkMetrics().ProviderForkCalls; calls != 1 {
		return fmt.Errorf("provider ForkSession calls = %d, want 1", calls)
	}
	return nil
}
