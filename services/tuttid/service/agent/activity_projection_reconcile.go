package agent

import (
	"context"
	"errors"
	"log/slog"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

// SettleStaleTurnsOnStartup is the daemon-start reconciliation of protocol v2
// (refactor plan rule nine). No provider process survives a daemon restart,
// so every non-settled turn on disk is force-settled as interrupted, its
// pending interactions are superseded, and each affected session gets one
// session-level system message (turnId null) explaining the interruption.
// The legacy lazy reconcileStaleTurnOnResume path stays in place but should
// no longer hit anything after this runs.
func (p *ActivityProjection) SettleStaleTurnsOnStartup(ctx context.Context) error {
	if p == nil || p.repo == nil {
		return errors.New("agent activity repository is unavailable for startup reconciliation")
	}
	settlements, err := p.repo.SettleStaleTurns(ctx)
	if err != nil {
		slog.Warn("workspace agent stale turn settlement failed",
			"event", "workspace.agent_turn.stale_settlement_failed",
			"error", err,
		)
		return err
	}
	if len(settlements) == 0 {
		return nil
	}
	slog.Info("workspace agent stale turns settled on startup",
		"event", "workspace.agent_turn.stale_settled",
		"count", len(settlements),
	)
	agenthost.NotifyCommitted(ctx, p, agenthost.StaleTurnSettlementDelta(settlements))
	return nil
}
