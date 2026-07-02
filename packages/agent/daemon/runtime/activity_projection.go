package agentruntime

import (
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

func ReportableActivityEvents(events []activityshared.Event) []activityshared.Event {
	out := make([]activityshared.Event, 0, len(events))
	for _, event := range events {
		if !isReportableActivityType(event.Type) || shouldSkipActivityEvent(event) {
			continue
		}
		out = append(out, event)
	}
	return out
}

func ProjectActivityEventsToStreamEvents(session Session, events []activityshared.Event) []StreamEvent {
	source := eventSourceFromSession(session)
	out := make([]StreamEvent, 0, len(events))
	timestampNow := unixMS(now())
	for _, event := range events {
		sessionID := firstNonEmptyString(event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
		if sessionID == "" {
			continue
		}
		timestamp := event.OccurredAtUnixMS
		if timestamp <= 0 {
			timestamp = timestampNow
		}
		if patch, ok := statePatchFromSessionEvent(source, event, sessionID, timestamp); ok {
			out = append(out, StreamEvent{
				EventType: StreamEventStatePatch,
				Data:      patch,
			})
		}
		if update, ok := messageUpdateFromSessionEvent(source, event, sessionID, timestamp); ok {
			out = append(out, StreamEvent{
				EventType: StreamEventMessageUpdate,
				Data:      update,
			})
		}
		if shouldAppendVisibleFailure(events, event) {
			if update, ok := visibleFailureMessageUpdate(source, event, sessionID, timestamp); ok {
				out = append(out, StreamEvent{
					EventType: StreamEventMessageUpdate,
					Data:      update,
				})
			}
		}
	}
	return out
}

func eventSourceFromSession(session Session) agentsessionstore.EventSource {
	return agentsessionstore.EventSource{
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		AgentID:           strings.TrimSpace(session.AgentSessionID),
		AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
		CWD:               strings.TrimSpace(session.CWD),
		SessionOrigin:     agentsessionstore.WorkspaceAgentSessionOriginRuntime,
	}
}

func activityEventContext(session Session, eventID string, turnID string) (activityshared.EventContext, bool) {
	provider, ok := activityshared.NormalizeProvider(session.Provider)
	if !ok {
		return activityshared.EventContext{}, false
	}
	return activityshared.EventContext{
		EventID:           strings.TrimSpace(eventID),
		Provider:          provider,
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		AgentSessionID:    strings.TrimSpace(session.AgentSessionID),
		TurnID:            strings.TrimSpace(turnID),
		CWD:               strings.TrimSpace(session.CWD),
		Title:             strings.TrimSpace(session.Title),
		OccurredAtUnixMS:  nextEventUnixMS(),
	}, true
}

func sessionStatusFromActivity(status string) string {
	switch strings.TrimSpace(status) {
	case string(activityshared.SessionStatusWorking):
		return SessionStatusWorking
	case string(activityshared.SessionStatusWaiting):
		return SessionStatusWaiting
	case string(activityshared.SessionStatusCompleted):
		return SessionStatusCompleted
	case string(activityshared.SessionStatusFailed):
		return SessionStatusFailed
	case string(activityshared.SessionStatusPaused):
		return SessionStatusCanceled
	default:
		return SessionStatusReady
	}
}

func activitySessionStatusFromControllerStatus(status string) activityshared.SessionStatus {
	switch strings.TrimSpace(status) {
	case SessionStatusWorking:
		return activityshared.SessionStatusWorking
	case SessionStatusWaiting:
		return activityshared.SessionStatusWaiting
	case SessionStatusCanceled, string(activityshared.SessionStatusPaused):
		return activityshared.SessionStatusPaused
	case SessionStatusCompleted:
		return activityshared.SessionStatusCompleted
	case SessionStatusFailed:
		return activityshared.SessionStatusFailed
	case SessionStatusReady, string(activityshared.SessionStatusIdle), "":
		return activityshared.SessionStatusIdle
	default:
		return activityshared.SessionStatusIdle
	}
}

func isReportableActivityType(eventType activityshared.EventType) bool {
	switch eventType {
	case activityshared.EventSessionStarted,
		activityshared.EventSessionUpdated,
		activityshared.EventSessionCompleted,
		activityshared.EventSessionFailed,
		activityshared.EventTurnStarted,
		activityshared.EventTurnUpdated,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed,
		activityshared.EventMessageAppended,
		activityshared.EventMessageCreated,
		activityshared.EventCallStarted,
		activityshared.EventCallCompleted,
		activityshared.EventCallFailed:
		return true
	default:
		return false
	}
}

func shouldSkipActivityEvent(event activityshared.Event) bool {
	if event.Type != activityshared.EventMessageAppended && event.Type != activityshared.EventMessageCreated {
		return false
	}
	role := string(event.Payload.Role)
	if role != "" &&
		role != string(activityshared.MessageRoleAssistant) &&
		role != string(activityshared.MessageRoleAssistantThinking) {
		return false
	}
	streamState := asString(event.Payload.Metadata["streamState"])
	if streamState == "" {
		return false
	}
	return streamState != messageStreamStateCompleted && streamState != messageStreamStateFailed
}

func payloadString(payload map[string]any, key string) string {
	if len(payload) == 0 {
		return ""
	}
	return asString(payload[key])
}

func payloadMap(payload map[string]any, key string) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	value, _ := payload[key].(map[string]any)
	return value
}

func clonePayload(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = clonePayloadValue(value)
	}
	return out
}
