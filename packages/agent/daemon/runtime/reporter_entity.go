package agentruntime

import (
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func entityPatchFromSessionEvent(
	source agentsessionstore.EventSource,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
	item agentsessionstore.WorkspaceAgentTimelineItem,
) *agentsessionstore.WorkspaceAgentStatePatch {
	if strings.TrimSpace(item.CallID) == "" && strings.TrimSpace(item.Name) == "" {
		return nil
	}
	entity := agentsessionstore.WorkspaceAgentEntityPatch{
		CallID:   strings.TrimSpace(item.CallID),
		TurnID:   strings.TrimSpace(item.TurnID),
		CallType: firstNonEmptyString(item.CallType, "tool"),
		Name:     strings.TrimSpace(item.Name),
		Status:   strings.TrimSpace(item.Status),
	}
	switch event.Type {
	case activityshared.EventCallStarted:
		entity.Input = clonePayload(event.Payload.Input)
		entity.StartedAtUnixMS = timestamp
	case activityshared.EventCallCompleted:
		entity.Output = clonePayload(event.Payload.Output)
		entity.CompletedAtUnixMS = timestamp
	case activityshared.EventCallFailed:
		if len(event.Payload.Output) > 0 {
			entity.Output = clonePayload(event.Payload.Output)
		}
		entity.Error = clonePayload(event.Payload.Error)
		entity.CompletedAtUnixMS = timestamp
	}
	return &agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(sessionID),
		Provider:          firstNonEmptyString(string(event.Provider), source.Provider),
		ProviderSessionID: firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
		CWD:               firstNonEmptyString(event.Payload.CWD, source.CWD),
		OccurredAtUnixMS:  timestamp,
		Entities:          []agentsessionstore.WorkspaceAgentEntityPatch{entity},
	}
}

func payloadWithCallBody(key string, payload map[string]any, metadata map[string]any) map[string]any {
	out := clonePayload(metadata)
	if out == nil {
		out = map[string]any{}
	}
	if len(payload) > 0 {
		out[key] = clonePayload(payload)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func withOwnerThreadID(payload map[string]any, event activityshared.Event) map[string]any {
	ownerThreadID := strings.TrimSpace(event.OwnerThreadID)
	if ownerThreadID == "" {
		return payload
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payload["ownerThreadId"] = ownerThreadID
	// The spawn call that created the owning child thread. The GUI attaches
	// sub-agent lanes to their collab card by this id alone (ADR 0007); a
	// child row without it never attaches by guesswork.
	if ownerCallID := strings.TrimSpace(event.OwnerCallID); ownerCallID != "" {
		payload["ownerCallId"] = ownerCallID
	}
	return payload
}

func payloadValueIsEmpty(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

func clonePayloadValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = clonePayloadValue(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = clonePayloadValue(item)
		}
		return out
	default:
		return value
	}
}

func stringFromPayload(payload map[string]any, key string) string {
	if len(payload) == 0 {
		return ""
	}
	return asString(payload[key])
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
