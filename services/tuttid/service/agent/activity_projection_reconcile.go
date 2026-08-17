package agent

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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
	delta := agenthost.StaleTurnSettlementDelta(settlements)
	for index, settled := range delta.RootTurnsSettled {
		delta.RootTurnsSettled[index].Provider, delta.RootTurnsSettled[index].IsChildSession =
			p.sessionTerminalFailureIdentity(ctx, settled.WorkspaceID, settled.AgentSessionID)
	}
	p.observeCommittedOutsideHost(ctx, delta)
	return nil
}

// sessionTerminalFailureIdentity resolves fields that message and stale-turn
// reports do not repeat but terminal failure analytics need.
func (p *ActivityProjection) sessionTerminalFailureIdentity(ctx context.Context, workspaceID, agentSessionID string) (string, bool) {
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	if p == nil || p.repo == nil || workspaceID == "" || agentSessionID == "" {
		return "", false
	}
	session, found, err := p.repo.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil || !found {
		return "", false
	}
	return strings.TrimSpace(session.Provider), strings.EqualFold(strings.TrimSpace(session.Kind), agentactivitybiz.SessionKindChild) ||
		strings.TrimSpace(session.ParentToolCallID) != ""
}
