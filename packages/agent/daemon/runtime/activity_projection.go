package agentruntime

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

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
		if deltas := liveMessageDeltasFromSessionEvent(session, event, sessionID, timestamp); len(deltas) > 0 {
			for _, delta := range deltas {
				out = append(out, StreamEvent{
					EventType: StreamEventMessageDelta,
					Data:      delta,
				})
			}
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
			if audit, ok := visibleFailureSessionAuditUpdate(source, event, sessionID, timestamp); ok {
				out = append(out, StreamEvent{EventType: StreamEventSessionAudit, Data: audit})
			} else if update, ok := visibleFailureMessageUpdate(source, event, sessionID, timestamp); ok {
				out = append(out, StreamEvent{
					EventType: StreamEventMessageUpdate,
					Data:      update,
				})
			}
		}
	}
	return out
}

func liveMessageDeltasFromSessionEvent(
	session Session,
	event activityshared.Event,
	sessionID string,
	timestamp int64,
) []liveprotocol.Event {
	contentOperation, _ := event.Payload.Metadata[liveContentOperationMetadataKey].(*liveprotocol.MessageContentOperation)
	toolOutputOperation, _ := event.Payload.Metadata[liveToolOutputOperationMetadataKey].(*liveprotocol.MessageToolOutputOperation)
	if contentOperation == nil && toolOutputOperation == nil {
		return nil
	}
	messageID := firstNonEmptyString(stringFromPayload(event.Payload.Metadata, "messageId"), event.EventID)
	if toolOutputOperation != nil {
		// Tool-call persistence deliberately keys the canonical message by call
		// identity (`toolcall:<callId>`), while EventID is the normalizer's
		// internal lifecycle identity. The live output must target that same
		// canonical anchor or the optimistic overlay would create a second,
		// output-only tool row.
		messageID = toolCallMessageUpdateID(event, sessionID, timestamp)
	}
	if messageID == "" || strings.TrimSpace(event.Payload.TurnID) == "" || timestamp <= 0 {
		return nil
	}
	var contentOperationCopy *liveprotocol.MessageContentOperation
	if contentOperation != nil {
		copy := *contentOperation
		copy.Value = append(json.RawMessage(nil), contentOperation.Value...)
		contentOperationCopy = &copy
	}
	var toolOutputOperationCopy *liveprotocol.MessageToolOutputOperation
	if toolOutputOperation != nil {
		copy := *toolOutputOperation
		if toolOutputOperation.OffsetBytes != nil {
			offset := *toolOutputOperation.OffsetBytes
			copy.OffsetBytes = &offset
		}
		toolOutputOperationCopy = &copy
	}
	status := strings.TrimSpace(stringFromPayload(event.Payload.Metadata, "streamState"))
	data := liveprotocol.MessageDeltaData{
		WorkspaceID:      strings.TrimSpace(session.RoomID),
		AgentSessionID:   strings.TrimSpace(sessionID),
		MessageID:        messageID,
		TurnID:           strings.TrimSpace(event.Payload.TurnID),
		Role:             strings.TrimSpace(stringFromPayload(event.Payload.Metadata, liveMessageRoleMetadataKey)),
		Kind:             strings.TrimSpace(stringFromPayload(event.Payload.Metadata, liveMessageKindMetadataKey)),
		OccurredAtUnixMS: timestamp,
		Content:          contentOperationCopy,
		ToolOutput:       toolOutputOperationCopy,
	}
	if status != "" {
		data.Status = &status
	}
	return deliverableMessageDeltaEvents(data)
}

// JSON encoding can expand a single source byte to six bytes (for example,
// control characters become \u00XX). Keeping each semantic tool-output chunk
// to one eighth of the live delivery budget leaves room for that worst-case
// expansion plus the message and protobuf envelopes.
const liveToolOutputTextChunkMaxBytes = liveprotocol.DefaultDeliveryMaxBytes / 8

func deliverableMessageDeltaEvents(data liveprotocol.MessageDeltaData) []liveprotocol.Event {
	operation := data.ToolOutput
	if operation == nil || len(operation.Text) <= liveToolOutputTextChunkMaxBytes {
		delta, err := liveprotocol.NewMessageDeltaEvent(data)
		if err != nil {
			return nil
		}
		return []liveprotocol.Event{delta}
	}

	chunks := splitLiveToolOutputText(operation.Text)
	out := make([]liveprotocol.Event, 0, len(chunks))
	consumedBytes := int64(0)
	if operation.OffsetBytes != nil {
		consumedBytes = *operation.OffsetBytes
	}
	for index, chunk := range chunks {
		part := data
		partOperation := *operation
		partOperation.Text = chunk
		if index > 0 {
			part.Status = nil
			partOperation.Operation = "append_text"
			offset := consumedBytes
			partOperation.OffsetBytes = &offset
		}
		part.ToolOutput = &partOperation
		delta, err := liveprotocol.NewMessageDeltaEvent(part)
		if err != nil {
			return nil
		}
		out = append(out, delta)
		consumedBytes += int64(len(chunk))
	}
	return out
}

func splitLiveToolOutputText(text string) []string {
	chunks := make([]string, 0, len(text)/liveToolOutputTextChunkMaxBytes+1)
	for len(text) > liveToolOutputTextChunkMaxBytes {
		end := liveToolOutputTextChunkMaxBytes
		for end > 0 && !utf8.RuneStart(text[end]) {
			end--
		}
		if end == 0 {
			end = liveToolOutputTextChunkMaxBytes
		}
		chunks = append(chunks, text[:end])
		text = text[end:]
	}
	if text != "" {
		chunks = append(chunks, text)
	}
	return chunks
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
	return activityEventContextAt(session, eventID, turnID, 0)
}

func activityEventContextAt(session Session, eventID string, turnID string, occurredAtUnixMS int64) (activityshared.EventContext, bool) {
	provider, ok := activityshared.NormalizeProvider(session.Provider)
	if !ok {
		return activityshared.EventContext{}, false
	}
	if occurredAtUnixMS <= 0 {
		occurredAtUnixMS = nextEventUnixMS()
	}
	return activityshared.EventContext{
		EventID:           strings.TrimSpace(eventID),
		Provider:          provider,
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		AgentSessionID:    strings.TrimSpace(session.AgentSessionID),
		TurnID:            strings.TrimSpace(turnID),
		CWD:               strings.TrimSpace(session.CWD),
		Title:             strings.TrimSpace(session.Title),
		OccurredAtUnixMS:  occurredAtUnixMS,
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
		activityshared.EventRootProviderTurnCheckpoint,
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
