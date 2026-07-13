package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
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

	now := time.Now().UnixMilli()
	for _, settlement := range settlements {
		turn, ok, err := p.repo.GetTurn(ctx, settlement.WorkspaceID, settlement.AgentSessionID, settlement.TurnID)
		if err != nil {
			return fmt.Errorf("read startup-settled turn %s: %w", settlement.TurnID, err)
		}
		if !ok {
			return fmt.Errorf("startup-settled turn %s is unavailable", settlement.TurnID)
		}
		p.publishActivityUpdated(ctx, settlement.WorkspaceID, settlement.AgentSessionID, "turn_update",
			activityTurnUpdateEventPayload(settlement.WorkspaceID, settlement.AgentSessionID, turn, now))
	}
	return nil
}
