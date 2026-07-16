package main

import (
	"context"
	"strings"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

// agentCollaborationSessionCanceller adapts collaboration cancellation to the
// protocol-v2 active-turn API. A session without an active turn is already
// settled from the canceller's perspective; the collaboration service's
// idempotent settlement decides the final ledger state.
type agentCollaborationSessionCanceller struct {
	Service *agentservice.Service
}

func (c agentCollaborationSessionCanceller) CancelTargetSession(ctx context.Context, workspaceID string, agentSessionID string) error {
	if c.Service == nil {
		return agentservice.ErrSessionNotFound
	}
	session, err := c.Service.Get(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	if err != nil {
		return err
	}
	turnID := strings.TrimSpace(session.ActiveTurnID)
	if turnID == "" {
		return nil
	}
	_, err = c.Service.CancelTurn(ctx, workspaceID, agentSessionID, turnID)
	return err
}
