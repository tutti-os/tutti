package agent

import (
	"context"
	"log/slog"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (p *ActivityProjection) publishActivityUpdated(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	eventType string,
	data map[string]any,
) {
	if p == nil || p.publisher == nil {
		return
	}
	if err := p.publisher.PublishAgentActivityUpdated(
		ctx,
		workspaceID,
		agentSessionID,
		eventType,
		data,
	); err != nil {
		slog.Warn("publish workspace agent activity update failed",
			"event", "workspace.agent_activity.publish_failed",
			"workspace_id", strings.TrimSpace(workspaceID),
			"agent_session_id", strings.TrimSpace(agentSessionID),
			"event_type", strings.TrimSpace(eventType),
			"error", err,
		)
	}
}

func (p *ActivityProjection) observeSessionState(
	ctx context.Context,
	input canonical.ReportSessionStateInput,
	reply canonical.ReportSessionStateReply,
) {
	if p == nil || p.sessionStateObserver == nil {
		return
	}
	p.sessionStateObserver.ObserveAgentSessionState(ctx, input, reply)
}

func (p *ActivityProjection) observeSessionMessages(
	ctx context.Context,
	input canonical.ReportSessionMessagesInput,
	reply canonical.ReportSessionMessagesReply,
) {
	if p == nil || p.sessionMessageObserver == nil {
		return
	}
	p.sessionMessageObserver.ObserveAgentSessionMessages(ctx, input, reply)
}

func activityMessageUpdates(updates []canonical.WorkspaceAgentSessionMessageUpdate) []agentactivitybiz.MessageUpdate {
	if len(updates) == 0 {
		return nil
	}
	out := make([]agentactivitybiz.MessageUpdate, 0, len(updates))
	for _, update := range updates {
		out = append(out, agentactivitybiz.MessageUpdate{
			MessageID:         strings.TrimSpace(update.MessageID),
			TurnID:            strings.TrimSpace(update.TurnID),
			Role:              strings.TrimSpace(update.Role),
			Kind:              strings.TrimSpace(update.Kind),
			Status:            strings.TrimSpace(update.Status),
			Semantics:         activityMessageSemantics(update.Semantics),
			ContentDelta:      update.ContentDelta,
			Payload:           update.Payload,
			OccurredAtUnixMS:  update.OccurredAtUnixMS,
			StartedAtUnixMS:   update.StartedAtUnixMS,
			CompletedAtUnixMS: update.CompletedAtUnixMS,
		})
	}
	return out
}

func activityMessagesEventPayload(messages []agentactivitybiz.Message) []map[string]any {
	if len(messages) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		// Protocol v2: session-level messages carry turnId null, never "".
		var turnID any
		if trimmed := strings.TrimSpace(message.TurnID); trimmed != "" {
			turnID = trimmed
		}
		item := map[string]any{
			"agentSessionId":   strings.TrimSpace(message.AgentSessionID),
			"kind":             strings.TrimSpace(message.Kind),
			"messageId":        strings.TrimSpace(message.MessageID),
			"occurredAtUnixMs": message.OccurredAtUnixMS,
			"payload":          clonePayload(message.Payload),
			"role":             strings.TrimSpace(message.Role),
			"sequence":         message.ID,
			"turnId":           turnID,
			"version":          message.Version,
		}
		if status := strings.TrimSpace(message.Status); status != "" {
			item["status"] = status
		}
		if semantics := activityMessageSemanticsPayload(message.Semantics); semantics != nil {
			item["semantics"] = semantics
		}
		if message.StartedAtUnixMS > 0 {
			item["startedAtUnixMs"] = message.StartedAtUnixMS
		}
		if message.CompletedAtUnixMS > 0 {
			item["completedAtUnixMs"] = message.CompletedAtUnixMS
		}
		if message.CreatedAtUnixMS > 0 {
			item["createdAtUnixMs"] = message.CreatedAtUnixMS
		}
		if message.UpdatedAtUnixMS > 0 {
			item["updatedAtUnixMs"] = message.UpdatedAtUnixMS
		}
		out = append(out, item)
	}
	return out
}

func activityMessageSemantics(value *canonical.WorkspaceAgentMessageSemantics) *agentactivitybiz.MessageSemantics {
	if value == nil {
		return nil
	}
	return &agentactivitybiz.MessageSemantics{
		UserVisibleAssistantResponse: value.UserVisibleAssistantResponse,
		TurnSettling:                 value.TurnSettling,
		NoticeCommand:                strings.TrimSpace(value.NoticeCommand),
		NoticeCommandStatus:          strings.TrimSpace(value.NoticeCommandStatus),
	}
}

func activityMessageSemanticsPayload(value *agentactivitybiz.MessageSemantics) map[string]any {
	if value == nil {
		return nil
	}
	out := map[string]any{}
	out["userVisibleAssistantResponse"] = value.UserVisibleAssistantResponse
	out["turnSettling"] = value.TurnSettling
	if value.NoticeCommand != "" {
		out["noticeCommand"] = value.NoticeCommand
	}
	if value.NoticeCommandStatus != "" {
		out["noticeCommandStatus"] = value.NoticeCommandStatus
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
