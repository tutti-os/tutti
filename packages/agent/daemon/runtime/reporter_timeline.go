package agentruntime

import (
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func timelineItemFromSessionEvent(
	roomID string,
	source agentsessionstore.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) (agentsessionstore.WorkspaceAgentTimelineItem, *agentsessionstore.WorkspaceAgentStatePatch, bool) {
	item := agentsessionstore.WorkspaceAgentTimelineItem{
		RoomID:           strings.TrimSpace(roomID),
		AgentSessionID:   strings.TrimSpace(sessionID),
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		EventSource:      "runtime",
		EventID:          strings.TrimSpace(event.EventID),
		ActorType:        "agent",
		ActorID:          firstNonEmptyString(string(event.Provider), source.Provider),
		OccurredAtUnixMS: timestamp,
		CreatedAtUnixMS:  timestamp,
	}
	if item.AgentSessionID == "" || item.EventID == "" {
		return agentsessionstore.WorkspaceAgentTimelineItem{}, nil, false
	}
	switch event.Type {
	case activityshared.EventMessageAppended, activityshared.EventMessageCreated:
		role := string(event.Payload.Role)
		if role == "" {
			role = string(activityshared.MessageRoleAssistant)
		}
		item.Role = role
		item.ItemType = messageTimelineItemType(role)
		item.Status = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "streamState"), event.Payload.Status)
		item.Payload = clonePayload(event.Payload.Metadata)
		if item.Payload == nil {
			item.Payload = map[string]any{}
		}
		item.Payload = withOwnerThreadID(item.Payload, event)
		if event.Payload.Content != "" {
			if _, exists := item.Payload["content"]; !exists {
				item.Payload["content"] = event.Payload.Content
			}
			item.Payload["text"] = event.Payload.Content
		}
		if role == string(activityshared.MessageRoleUser) {
			item.ActorType = "user"
		}
		return item, nil, true
	case activityshared.EventCallStarted:
		item.ItemType = "call.started"
		item.CallID = strings.TrimSpace(event.Payload.CallID)
		item.EventID = reportCallTimelineEventID(item.CallID, source, event)
		item.CallType = firstNonEmptyString(event.Payload.CallType, "tool")
		item.Name = strings.TrimSpace(event.Payload.Name)
		item.Status = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "status"), event.Payload.Status, string(activityshared.ActivityStatusRunning), "running")
		item.Payload = payloadWithCallBody("input", event.Payload.Input, event.Payload.Metadata)
		item.Payload = withOwnerThreadID(item.Payload, event)
		return item, entityPatchFromSessionEvent(source, event, sessionID, timestamp, item), true
	case activityshared.EventCallCompleted:
		item.ItemType = "call.completed"
		item.CallID = strings.TrimSpace(event.Payload.CallID)
		item.EventID = reportCallTimelineEventID(item.CallID, source, event)
		item.CallType = firstNonEmptyString(event.Payload.CallType, "tool")
		item.Name = strings.TrimSpace(event.Payload.Name)
		item.Status = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "status"), event.Payload.Status, string(activityshared.ActivityStatusCompleted), "completed")
		item.Payload = payloadWithCallBody("output", event.Payload.Output, event.Payload.Metadata)
		item.Payload = withOwnerThreadID(item.Payload, event)
		return item, entityPatchFromSessionEvent(source, event, sessionID, timestamp, item), true
	case activityshared.EventCallFailed:
		item.ItemType = "call.errored"
		item.CallID = strings.TrimSpace(event.Payload.CallID)
		item.EventID = reportCallTimelineEventID(item.CallID, source, event)
		item.CallType = firstNonEmptyString(event.Payload.CallType, "tool")
		item.Name = strings.TrimSpace(event.Payload.Name)
		item.Status = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "status"), event.Payload.Status, string(activityshared.ActivityStatusFailed), "failed")
		item.Payload = payloadWithCallBody("error", event.Payload.Error, event.Payload.Metadata)
		item.Payload = withOwnerThreadID(item.Payload, event)
		return item, entityPatchFromSessionEvent(source, event, sessionID, timestamp, item), true
	case activityshared.EventActivityStarted,
		activityshared.EventActivityUpdated,
		activityshared.EventActivityCompleted,
		activityshared.EventActivityFailed:
		item.ItemType = string(event.Type)
		item.CallID = strings.TrimSpace(event.Payload.ActivityKey)
		item.CallType = firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "kind"), "activity")
		item.Name = firstNonEmptyString(
			stringFromPayload(event.Payload.Metadata, "title"),
			stringFromPayload(event.Payload.Metadata, "description"),
			item.CallID,
		)
		item.Status = activityTimelineStatus(event)
		item.Payload = clonePayload(event.Payload.Metadata)
		if item.Payload == nil {
			item.Payload = map[string]any{}
		}
		item.Payload["activityKey"] = strings.TrimSpace(event.Payload.ActivityKey)
		return item, nil, true
	default:
		return agentsessionstore.WorkspaceAgentTimelineItem{}, nil, false
	}
}

func activityTimelineStatus(event activityshared.Event) string {
	return firstNonEmptyString(
		event.Payload.ActivityStatus,
		stringFromPayload(event.Payload.Metadata, "status"),
		event.Payload.Status,
		activityTimelineDefaultStatus(event.Type),
	)
}

func activityTimelineDefaultStatus(eventType activityshared.EventType) string {
	switch eventType {
	case activityshared.EventActivityCompleted:
		return string(activityshared.ActivityStatusCompleted)
	case activityshared.EventActivityFailed:
		return string(activityshared.ActivityStatusFailed)
	default:
		return string(activityshared.ActivityStatusRunning)
	}
}

func messageTimelineItemType(role string) string {
	switch strings.TrimSpace(role) {
	case string(activityshared.MessageRoleUser):
		return "message.user"
	case string(activityshared.MessageRoleAssistantThinking):
		return "message.assistant_thinking"
	default:
		return "message.assistant"
	}
}

func reportCallTimelineEventID(callID string, source agentsessionstore.EventSource, event activityshared.Event) string {
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return strings.TrimSpace(event.EventID)
	}
	provider := strings.TrimSpace(firstNonEmptyString(string(event.Provider), source.Provider))
	providerSessionID := strings.TrimSpace(firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID))
	if provider == "" || providerSessionID == "" {
		return strings.TrimSpace(event.EventID)
	}
	return provider + ":" + providerSessionID + ":call:" + callID
}
