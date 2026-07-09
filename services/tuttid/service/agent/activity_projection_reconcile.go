package agent

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

// SettleStaleTurnsOnStartup is the daemon-start reconciliation of protocol v2
// (refactor plan rule nine). No provider process survives a daemon restart,
// so every non-settled turn on disk is force-settled as interrupted, its
// pending interactions are superseded, and each affected session gets one
// session-level system message (turnId null) explaining the interruption.
// The legacy lazy reconcileStaleTurnOnResume path stays in place but should
// no longer hit anything after this runs.
func (p *ActivityProjection) SettleStaleTurnsOnStartup(ctx context.Context) {
	if p == nil || p.repo == nil {
		return
	}
	settlements, err := p.repo.SettleStaleTurns(ctx)
	if err != nil {
		slog.Warn("workspace agent stale turn settlement failed",
			"event", "workspace.agent_turn.stale_settlement_failed",
			"error", err,
		)
		return
	}
	if len(settlements) == 0 {
		return
	}
	slog.Info("workspace agent stale turns settled on startup",
		"event", "workspace.agent_turn.stale_settled",
		"count", len(settlements),
	)

	now := time.Now().UnixMilli()
	type sessionKey struct {
		workspaceID    string
		agentSessionID string
	}
	notified := make(map[sessionKey]bool, len(settlements))
	for _, settlement := range settlements {
		if turn, ok, err := p.repo.GetTurn(ctx, settlement.WorkspaceID, settlement.AgentSessionID, settlement.TurnID); err == nil && ok {
			p.publishActivityUpdated(ctx, settlement.WorkspaceID, settlement.AgentSessionID, "turn_update",
				activityTurnUpdateEventPayload(settlement.WorkspaceID, settlement.AgentSessionID, turn, now))
		}
		key := sessionKey{settlement.WorkspaceID, settlement.AgentSessionID}
		if notified[key] {
			continue
		}
		notified[key] = true
		p.reportStaleTurnSystemMessage(ctx, settlement.WorkspaceID, settlement.AgentSessionID, settlement.TurnID, now)
	}
}

// reportStaleTurnSystemMessage persists one session-level (turnId null)
// system notice through the regular message report path, mirroring the
// acpSystemNoticeEvent payload shape so the timeline renders it like any
// other system notice. The message id is derived from the settled turn id,
// so replays are idempotent upserts.
func (p *ActivityProjection) reportStaleTurnSystemMessage(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
	occurredAtUnixMS int64,
) {
	title := "Agent run was interrupted by an application restart."
	payload := map[string]any{
		"kind":       "agent_system_notice",
		"noticeKind": "stale_turn_reconciled",
		"severity":   "warning",
		"title":      title,
		"content":    title,
		"text":       title,
	}
	if _, err := p.ReportSessionMessages(ctx, agentsessionstore.ReportSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Updates: []agentsessionstore.WorkspaceAgentSessionMessageUpdate{
			{
				MessageID:         fmt.Sprintf("system-stale-turn-%s", strings.TrimSpace(turnID)),
				TurnID:            "",
				Role:              "assistant",
				Kind:              "text",
				Status:            "completed",
				Payload:           payload,
				OccurredAtUnixMS:  occurredAtUnixMS,
				CompletedAtUnixMS: occurredAtUnixMS,
			},
		},
	}); err != nil {
		slog.Warn("workspace agent stale turn system message failed",
			"event", "workspace.agent_turn.stale_message_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"turn_id", turnID,
			"error", err,
		)
	}
}
