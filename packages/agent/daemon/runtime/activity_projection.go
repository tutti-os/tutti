package agentruntime

import (
	"encoding/json"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
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
		if delta, ok := liveMessageDeltaFromSessionEvent(session, event, timestamp); ok {
			out = append(out, StreamEvent{
				EventType: StreamEventMessageDelta,
				Data:      delta,
			})
			continue
		}
		if isPrecommitTerminalTextMessage(event) {
			continue
		}
		if update, ok := messageUpdateFromSessionEvent(source, event, sessionID, timestamp); ok {
			out = append(out, StreamEvent{
				EventType: StreamEventMessageUpdate,
				Data:      update,
			})
		}
		if audit, ok := sessionAuditUpdateFromSessionEvent(event, sessionID, timestamp); ok {
			out = append(out, StreamEvent{EventType: StreamEventSessionAudit, Data: audit})
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

func liveMessageDeltaFromSessionEvent(session Session, event activityshared.Event, timestamp int64) (liveprotocol.Event, bool) {
	operation, ok := event.Payload.Metadata[liveContentOperationMetadataKey].(*liveprotocol.MessageContentOperation)
	if !ok || operation == nil {
		return liveprotocol.Event{}, false
	}
	messageID := firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "messageId"), event.EventID)
	if messageID == "" || strings.TrimSpace(event.Payload.TurnID) == "" || timestamp <= 0 {
		return liveprotocol.Event{}, false
	}
	operationCopy := *operation
	operationCopy.Value = append(json.RawMessage(nil), operation.Value...)
	status := strings.TrimSpace(stringFromPayload(event.Payload.Metadata, "streamState"))
	data := liveprotocol.MessageDeltaData{
		WorkspaceID:      strings.TrimSpace(session.RoomID),
		AgentSessionID:   strings.TrimSpace(event.AgentSessionID),
		MessageID:        messageID,
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		Role:             strings.TrimSpace(stringFromPayload(event.Payload.Metadata, liveMessageRoleMetadataKey)),
		Kind:             strings.TrimSpace(stringFromPayload(event.Payload.Metadata, liveMessageKindMetadataKey)),
		OccurredAtUnixMS: timestamp,
		Content:          &operationCopy,
	}
	if status != "" {
		data.Status = &status
	}
	delta, err := liveprotocol.NewMessageDeltaEvent(data)
	return delta, err == nil
}

func isPrecommitTerminalTextMessage(event activityshared.Event) bool {
	if event.Type != activityshared.EventMessageAppended && event.Type != activityshared.EventMessageCreated {
		return false
	}
	role := strings.TrimSpace(string(event.Payload.Role))
	if role != RoleAssistant && role != RoleAssistantThinking {
		return false
	}
	if stringFromPayload(event.Payload.Metadata, "contentMode") != messageContentModeSnapshot {
		return false
	}
	switch stringFromPayload(event.Payload.Metadata, "streamState") {
	case messageStreamStateCompleted, messageStreamStateFailed:
		return true
	default:
		return false
	}
}

func eventSourceFromSession(session Session) canonical.EventSource {
	return canonical.EventSource{
		Provider:               strings.TrimSpace(session.Provider),
		ProviderSessionID:      strings.TrimSpace(session.ProviderSessionID),
		SessionCreatedAtUnixMS: session.CreatedAtUnixMS,
		AgentID:                strings.TrimSpace(session.AgentSessionID),
		AgentTargetID:          strings.TrimSpace(session.AgentTargetID),
		CWD:                    strings.TrimSpace(session.CWD),
		SessionOrigin:          agentsessionstore.WorkspaceAgentSessionOriginRuntime,
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
		activityshared.EventSessionAudit,
		activityshared.EventGoalReconcileRequired,
		activityshared.EventTurnStarted,
		activityshared.EventTurnUpdated,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed,
		activityshared.EventRootProviderTurnStarted,
		activityshared.EventRootProviderTurnCompleted,
		activityshared.EventMessageAppended,
		activityshared.EventMessageCreated,
		activityshared.EventCallStarted,
		activityshared.EventCallCompleted,
		activityshared.EventCallFailed,
		activityshared.EventInteractionRequested,
		activityshared.EventInteractionSuperseded:
		return true
	default:
		return false
	}
}

func goalReconcileRequestFromSessionEvent(event activityshared.Event, sessionID string) (agentsessionstore.WorkspaceAgentGoalReconcileRequest, bool) {
	if event.Type != activityshared.EventGoalReconcileRequired || strings.TrimSpace(sessionID) == "" {
		return agentsessionstore.WorkspaceAgentGoalReconcileRequest{}, false
	}
	metadata := event.Payload.Metadata
	requestID := firstNonEmptyString(stringFromPayload(metadata, "requestId"), event.EventID)
	if requestID == "" {
		return agentsessionstore.WorkspaceAgentGoalReconcileRequest{}, false
	}
	return agentsessionstore.WorkspaceAgentGoalReconcileRequest{
		RequestID:           requestID,
		Phase:               stringFromPayload(metadata, "phase"),
		AgentSessionID:      strings.TrimSpace(sessionID),
		ProviderTurnID:      stringFromPayload(metadata, "providerTurnId"),
		Reason:              stringFromPayload(metadata, "reason"),
		FenceMode:           stringFromPayload(metadata, "fenceMode"),
		ExpectedOperationID: stringFromPayload(metadata, "expectedGoalOperationId"),
		ExpectedRevision:    payloadInt64(metadata, "expectedGoalRevision"),
		ExpectedRepairEpoch: payloadInt64(metadata, "expectedGoalRepairEpoch"),
		QuiesceSucceeded:    metadata["quiesceSucceeded"] == true,
		QuiesceError:        stringFromPayload(metadata, "quiesceError"),
	}, true
}

func sessionAuditUpdateFromSessionEvent(event activityshared.Event, sessionID string, timestamp int64) (agentsessionstore.WorkspaceAgentSessionAuditUpdate, bool) {
	if event.Type != activityshared.EventSessionAudit || strings.TrimSpace(sessionID) == "" || timestamp <= 0 {
		return agentsessionstore.WorkspaceAgentSessionAuditUpdate{}, false
	}
	auditID := firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "auditId"), event.EventID)
	if auditID == "" || strings.TrimSpace(event.Payload.TurnID) != "" {
		return agentsessionstore.WorkspaceAgentSessionAuditUpdate{}, false
	}
	return agentsessionstore.WorkspaceAgentSessionAuditUpdate{
		AuditID: auditID, Role: strings.TrimSpace(string(event.Payload.Role)), Content: event.Payload.Content,
		Payload: clonePayload(event.Payload.Metadata), OccurredAtUnixMS: timestamp,
	}, true
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
