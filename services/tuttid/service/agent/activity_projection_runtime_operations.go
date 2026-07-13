package agent

import (
	"context"
	"errors"
	"strings"

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
		turnID := payloadString(event.Payload, "turnId")
		turn, ok, err := p.repo.GetTurn(ctx, event.WorkspaceID, event.AgentSessionID, turnID)
		if err != nil {
			return err
		}
		if ok {
			eventType = "turn_update"
			payload = activityTurnUpdateEventPayload(
				event.WorkspaceID,
				event.AgentSessionID,
				turn,
				event.CreatedAtUnixMS,
			)
		}
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
