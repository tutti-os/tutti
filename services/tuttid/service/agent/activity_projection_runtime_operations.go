package agent

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (p *ActivityProjection) PublishRuntimeOperationEvent(
	ctx context.Context,
	event agentactivitybiz.RuntimeOperationEvent,
) error {
	if p == nil || p.repo == nil || p.publisher == nil {
		return errors.New("runtime operation event projection dependencies are unavailable")
	}
	var eventType string
	var payload map[string]any
	switch event.Kind {
	case agentactivitybiz.RuntimeOperationEventInteractiveCompleted:
		requestID := payloadString(event.Payload, "requestId")
		interactions, err := p.repo.ListSessionInteractions(ctx, agentactivitybiz.ListSessionInteractionsInput{
			WorkspaceID:    event.WorkspaceID,
			AgentSessionID: event.AgentSessionID,
		})
		if err != nil {
			return err
		}
		for _, interaction := range interactions {
			if strings.TrimSpace(interaction.RequestID) == requestID {
				eventType = "interaction_update"
				payload = activityInteractionUpdateEventPayload(
					event.WorkspaceID,
					event.AgentSessionID,
					interaction,
					event.CreatedAtUnixMS,
				)
				break
			}
		}
	case agentactivitybiz.RuntimeOperationEventTurnCanceled:
		targets, _ := event.Payload["targets"].([]any)
		published := 0
		for _, rawTarget := range targets {
			target, _ := rawTarget.(map[string]any)
			agentSessionID := payloadString(target, "agentSessionId")
			turnID := payloadString(target, "turnId")
			turn, ok, err := p.repo.GetTurn(ctx, event.WorkspaceID, agentSessionID, turnID)
			if err != nil {
				return err
			}
			if !ok {
				return errors.New("cancel runtime operation target turn is unavailable")
			}
			if err := p.publisher.PublishAgentActivityUpdated(
				ctx,
				event.WorkspaceID,
				agentSessionID,
				"turn_update",
				activityTurnUpdateEventPayload(
					event.WorkspaceID,
					agentSessionID,
					turn,
					event.CreatedAtUnixMS,
				),
			); err != nil {
				return err
			}
			p.observeRootTurnSettledSessionState(ctx, event.WorkspaceID, agentSessionID, turn)
			published++
		}
		if rawRoot, ok := event.Payload["reconciledRoot"].(map[string]any); ok {
			agentSessionID := payloadString(rawRoot, "agentSessionId")
			turnID := payloadString(rawRoot, "turnId")
			turn, found, err := p.repo.GetTurn(ctx, event.WorkspaceID, agentSessionID, turnID)
			if err != nil {
				return err
			}
			if !found || turn.Phase != agentactivitybiz.TurnPhaseSettled {
				return errors.New("reconciled root turn is unavailable")
			}
			if err := p.publisher.PublishAgentActivityUpdated(
				ctx,
				event.WorkspaceID,
				agentSessionID,
				"turn_update",
				activityTurnUpdateEventPayload(event.WorkspaceID, agentSessionID, turn, event.CreatedAtUnixMS),
			); err != nil {
				return err
			}
			p.observeRootTurnSettledSessionState(ctx, event.WorkspaceID, agentSessionID, turn)
			published++
		}
		if published == 0 {
			return errors.New("cancel runtime operation targets are unavailable")
		}
		return nil
	case agentactivitybiz.RuntimeOperationEventPlanDecisionPending:
		return p.publishPlanDecisionNoticeUpdate(ctx, event)
	case agentactivitybiz.RuntimeOperationEventPlanDecisionCompleted:
		turnID := payloadString(event.Payload, "confirmedTurnId")
		turn, ok, err := p.repo.GetTurn(ctx, event.WorkspaceID, event.AgentSessionID, turnID)
		if err != nil {
			return err
		}
		if !ok {
			break
		}
		if err := p.publisher.PublishAgentActivityUpdated(
			ctx,
			event.WorkspaceID,
			event.AgentSessionID,
			"turn_update",
			activityTurnUpdateEventPayload(
				event.WorkspaceID,
				event.AgentSessionID,
				turn,
				event.CreatedAtUnixMS,
			),
		); err != nil {
			return err
		}
		return p.publishPlanDecisionNoticeUpdate(ctx, event)
	}
	if eventType == "" || payload == nil {
		return errors.New("runtime operation event domain entity is unavailable")
	}
	return p.publisher.PublishAgentActivityUpdated(
		ctx,
		event.WorkspaceID,
		event.AgentSessionID,
		eventType,
		payload,
	)
}

func (p *ActivityProjection) observeRootTurnSettled(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
) {
	if p == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if p.rootTurnObserver != nil {
		p.rootTurnObserver.ObserveRootTurnSettled(ctx, workspaceID, agentSessionID, turn)
	}
	p.observeRootTurnSettledSessionState(ctx, workspaceID, agentSessionID, turn)
}

// observeRootTurnSettledSessionState fans the committed canonical root-turn
// settlement out to the dedicated root-turn-settle observer list.
// Root-provider-lifecycle adapters (codex app-server, Claude SDK, standard
// ACP) never report a settled TurnLifecycle/Turn state patch: their terminal
// fact is a RootProviderTurn transition that the store aggregates into the
// canonical settlement. The settled+outcome state shape the observers key on
// therefore has to be synthesized here at the commit point, exactly like
// SettleStaleTurnsOnStartup already does for startup reconciliation.
//
// Delivery is at-least-once, never exactly-once: the cancel funnel can
// re-observe a settlement the normal aggregation already delivered
// (AlreadySettled overlap), and outbox-style publish-then-mark retries can
// replay it. Every observer on the dedicated list must be idempotent per
// settled turn (automation rules dedup on the durable execution ledger plus
// the in-memory engine claim).
//
// The observation is deliberately opt-in (rootTurnSettleStateObserver, not
// the general sessionStateObserver fan-out): the general observers
// historically never received live turn settles, and reviving one changes
// its product semantics — each needs its own ruling first (W4③-11).
func (p *ActivityProjection) observeRootTurnSettledSessionState(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
) {
	if p == nil || p.rootTurnSettleStateObserver == nil || turn.Phase != agentactivitybiz.TurnPhaseSettled {
		return
	}
	turnID := strings.TrimSpace(turn.TurnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return
	}
	// The session read is load-bearing, not best-effort: runtimeContext holds
	// the automation-origin marker (the only rescue-chain circuit breaker) and
	// agentTargetID drives source matching. Fanning out without them could
	// turn an automation-launched session's completion into a fresh trigger,
	// so a failed or missing read skips this delivery entirely — the durable
	// dedup keys on the turn, and missing one trigger beats misfiring one.
	if p.repo == nil {
		return
	}
	session, ok, err := p.repo.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil || !ok {
		slog.Warn("read settled root turn session for state observers failed; skipping settle fan-out",
			"event", "workspace.agent_turn.settled_session_read_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"turn_id", turnID,
			"session_found", ok,
			"error", err,
		)
		return
	}
	outcome := strings.TrimSpace(turn.Outcome)
	agentTargetID := strings.TrimSpace(session.AgentTargetID)
	state := canonical.WorkspaceAgentSessionStateUpdate{
		Kind:          strings.TrimSpace(session.Kind),
		AgentTargetID: agentTargetID,
		Provider:      strings.TrimSpace(session.Provider),
		Model:         strings.TrimSpace(session.Model),
		RuntimeContext: agentactivitybiz.JoinSessionRuntimeContext(
			session.Metadata,
			session.InternalRuntimeContext,
		),
		LastError: strings.TrimSpace(turn.ErrorMessage),
		TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
			Phase:   turn.Phase,
			Outcome: &outcome,
		},
		Turn: &canonical.WorkspaceAgentTurnStateUpdate{
			TurnID:            turnID,
			Phase:             turn.Phase,
			Outcome:           outcome,
			StartedAtUnixMS:   turn.StartedAtUnixMS,
			CompletedAtUnixMS: turn.SettledAtUnixMS,
		},
		OccurredAtUnixMS: firstNonZeroInt64(turn.SettledAtUnixMS, turn.UpdatedAtUnixMS),
	}
	p.rootTurnSettleStateObserver.ObserveAgentSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		AgentTargetID:  agentTargetID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State:          state,
	}, canonical.ReportSessionStateReply{
		Accepted:          true,
		StateApplied:      true,
		LastEventAtUnixMS: firstNonZeroInt64(turn.UpdatedAtUnixMS, turn.SettledAtUnixMS),
	})
}

func (p *ActivityProjection) publishPlanDecisionNoticeUpdate(ctx context.Context, event agentactivitybiz.RuntimeOperationEvent) error {
	page, ok, err := p.repo.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID: event.WorkspaceID, AgentSessionID: event.AgentSessionID,
		Limit: 1000, Order: agentactivitybiz.MessageOrderDesc,
	})
	if err != nil {
		return err
	}
	noticeMessageID := payloadString(event.Payload, "noticeMessageId")
	for _, message := range page.Messages {
		if ok && message.MessageID == noticeMessageID {
			return p.publisher.PublishAgentActivityUpdated(
				ctx,
				event.WorkspaceID,
				event.AgentSessionID,
				"message_update",
				map[string]any{
					"acceptedCount":  1,
					"agentSessionId": event.AgentSessionID,
					"eventType":      "message_update",
					"latestVersion":  message.Version,
					"messages":       activityMessagesEventPayload([]agentactivitybiz.Message{message}),
					"workspaceId":    event.WorkspaceID,
				},
			)
		}
	}
	return errors.New("plan decision notice is unavailable")
}
