package liveprotocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

const maxJSONDepth = 64

func NewMessageDeltaEvent(data MessageDeltaData) (Event, error) {
	return newTypedEvent(data.WorkspaceID, data.AgentSessionID, EventTypeMessageDelta, data)
}

func NewRuntimeActivityUpdateEvent(data RuntimeActivityUpdateData) (Event, error) {
	return newTypedEvent(data.WorkspaceID, data.AgentSessionID, EventTypeRuntimeActivityUpdate, data)
}

func NewTurnUpdateEvent(data TurnUpdateData) (Event, error) {
	return newTypedEvent(data.WorkspaceID, data.AgentSessionID, EventTypeTurnUpdate, data)
}

func NewInteractionUpdateEvent(data InteractionUpdateData) (Event, error) {
	return newTypedEvent(data.WorkspaceID, data.AgentSessionID, EventTypeInteractionUpdate, data)
}

func NewInteractionSnapshotEvent(data InteractionSnapshotData) (Event, error) {
	if data.Interactions == nil {
		data.Interactions = []EventInteraction{}
	}
	return newTypedEvent(data.WorkspaceID, data.AgentSessionID, EventTypeInteractionSnapshot, data)
}

func NewSessionAuditEvent(data SessionAuditData) (Event, error) {
	return newTypedEvent(data.WorkspaceID, data.AgentSessionID, EventTypeSessionAudit, data)
}

func newTypedEvent(workspaceID, agentSessionID string, eventType EventType, data any) (Event, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return Event{}, fmt.Errorf("%w: marshal %s: %v", ErrInvalidLiveEvent, eventType, err)
	}
	event := Event{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		EventType:      eventType,
		Data:           raw,
	}
	if _, err := MarshalEvent(event); err != nil {
		return Event{}, err
	}
	return event, nil
}

func MarshalEvent(event Event) ([]byte, error) {
	if err := validateEvent(event); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	return raw, nil
}

func DecodeEvent(raw []byte) (Event, error) {
	if len(raw) == 0 || !utf8.Valid(raw) {
		return Event{}, fmt.Errorf("%w: empty or invalid UTF-8", ErrInvalidLiveEvent)
	}
	if err := validateJSONStructure(raw); err != nil {
		return Event{}, err
	}
	var event Event
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&event); err != nil {
		return Event{}, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Event{}, err
	}
	if err := validateEvent(event); err != nil {
		return Event{}, err
	}
	return event, nil
}

func validateEvent(event Event) error {
	if strings.TrimSpace(event.WorkspaceID) == "" ||
		strings.TrimSpace(event.AgentSessionID) == "" ||
		len(event.Data) == 0 {
		return fmt.Errorf("%w: missing identity or data", ErrInvalidLiveEvent)
	}
	switch event.EventType {
	case EventTypeRuntimeActivityUpdate:
		_, err := requiredJSONFields(
			event.Data,
			"workspaceId",
			"agentSessionId",
			"eventType",
			"state",
			"occurredAtUnixMs",
		)
		if err != nil {
			return err
		}
		var data RuntimeActivityUpdateData
		if err := strictDecode(event.Data, &data); err != nil {
			return err
		}
		if data.EventType != event.EventType ||
			data.WorkspaceID != event.WorkspaceID ||
			data.AgentSessionID != event.AgentSessionID ||
			(data.State != "idle" && data.State != "running") ||
			data.OccurredAtUnixMS <= 0 {
			return fmt.Errorf("%w: invalid runtime activity update", ErrInvalidLiveEvent)
		}
	case EventTypeMessageDelta:
		record, err := requiredJSONFields(
			event.Data,
			"workspaceId",
			"agentSessionId",
			"messageId",
			"turnId",
			"role",
			"kind",
			"occurredAtUnixMs",
		)
		if err != nil {
			return err
		}
		var data MessageDeltaData
		if err := strictDecode(event.Data, &data); err != nil {
			return err
		}
		if data.WorkspaceID != event.WorkspaceID || data.AgentSessionID != event.AgentSessionID ||
			strings.TrimSpace(data.MessageID) == "" || strings.TrimSpace(data.TurnID) == "" ||
			strings.TrimSpace(data.Role) == "" ||
			strings.TrimSpace(data.Kind) == "" || data.OccurredAtUnixMS <= 0 {
			return fmt.Errorf("%w: invalid message delta identity", ErrInvalidLiveEvent)
		}
		hasMutation := data.Content != nil || data.ToolOutput != nil ||
			len(data.PayloadSet) > 0 || len(data.PayloadUnset) > 0 ||
			data.Status != nil || len(data.Semantics) > 0 || data.StartedAtUnixMS != nil || data.CompletedAtUnixMS != nil
		if !hasMutation {
			return fmt.Errorf("%w: empty message delta", ErrInvalidLiveEvent)
		}
		contentRaw, hasContent := record["content"]
		if hasContent && data.Content == nil {
			return fmt.Errorf("%w: content must be an operation object", ErrInvalidLiveEvent)
		}
		if data.Content != nil {
			contentRecord, err := requiredJSONFields(contentRaw, "operation")
			if err != nil {
				return err
			}
			switch data.Content.Operation {
			case "append_text":
				if _, ok := contentRecord["text"]; !ok {
					return fmt.Errorf("%w: append_text requires text", ErrInvalidLiveEvent)
				}
				if len(data.Content.Value) != 0 {
					return fmt.Errorf("%w: append_text cannot carry value", ErrInvalidLiveEvent)
				}
			case "set":
				if _, ok := contentRecord["value"]; !ok || len(data.Content.Value) == 0 {
					return fmt.Errorf("%w: set requires value", ErrInvalidLiveEvent)
				}
			default:
				return fmt.Errorf("%w: unknown content operation", ErrInvalidLiveEvent)
			}
		}
		toolOutputRaw, hasToolOutput := record["toolOutput"]
		if hasToolOutput && data.ToolOutput == nil {
			return fmt.Errorf("%w: toolOutput must be an operation object", ErrInvalidLiveEvent)
		}
		if data.ToolOutput != nil {
			if data.Kind != "tool_call" {
				return fmt.Errorf("%w: toolOutput requires tool_call kind", ErrInvalidLiveEvent)
			}
			toolOutputRecord, err := requiredJSONFields(toolOutputRaw, "operation", "text")
			if err != nil {
				return err
			}
			switch data.ToolOutput.Operation {
			case "set":
				if _, ok := toolOutputRecord["offsetBytes"]; ok {
					return fmt.Errorf("%w: toolOutput set forbids offsetBytes", ErrInvalidLiveEvent)
				}
			case "append_text":
				if data.ToolOutput.Text == "" {
					return fmt.Errorf("%w: toolOutput append_text requires non-empty text", ErrInvalidLiveEvent)
				}
				if _, ok := toolOutputRecord["offsetBytes"]; !ok ||
					data.ToolOutput.OffsetBytes == nil || *data.ToolOutput.OffsetBytes < 0 {
					return fmt.Errorf("%w: toolOutput append_text requires non-negative offsetBytes", ErrInvalidLiveEvent)
				}
			default:
				return fmt.Errorf("%w: unsupported toolOutput operation %q", ErrInvalidLiveEvent, data.ToolOutput.Operation)
			}
		}
		if err := validatePayloadMutation(record, data); err != nil {
			return err
		}
	case EventTypeTurnUpdate:
		record, err := requiredJSONFields(event.Data, "workspaceId", "agentSessionId", "eventType", "occurredAtUnixMs", "activeTurnId", "turn")
		if err != nil {
			return err
		}
		if _, err := requiredJSONFields(record["turn"], "turnId", "agentSessionId", "phase", "origin", "outcome", "error", "fileChanges", "completedCommand", "startedAtUnixMs", "settledAtUnixMs", "updatedAtUnixMs"); err != nil {
			return err
		}
		var data TurnUpdateData
		if err := strictDecode(event.Data, &data); err != nil {
			return err
		}
		if data.EventType != event.EventType || data.WorkspaceID != event.WorkspaceID ||
			data.AgentSessionID != event.AgentSessionID || data.Turn.AgentSessionID != event.AgentSessionID ||
			strings.TrimSpace(data.Turn.TurnID) == "" {
			return fmt.Errorf("%w: invalid turn update identity", ErrInvalidLiveEvent)
		}
		if !validTurnPhase(data.Turn.Phase) || !validTurnOrigin(data.Turn.Origin) ||
			(data.Turn.Outcome != nil && !validTurnOutcome(*data.Turn.Outcome)) {
			return fmt.Errorf("%w: invalid turn vocabulary", ErrInvalidLiveEvent)
		}
		if err := validateTurnUpdate(data); err != nil {
			return err
		}
	case EventTypeInteractionUpdate:
		record, err := requiredJSONFields(event.Data, "workspaceId", "agentSessionId", "eventType", "occurredAtUnixMs", "interaction")
		if err != nil {
			return err
		}
		if _, err := requiredJSONFields(record["interaction"], "requestId", "agentSessionId", "turnId", "kind", "status", "toolName", "input", "output", "metadata", "createdAtUnixMs", "updatedAtUnixMs"); err != nil {
			return err
		}
		var data InteractionUpdateData
		if err := strictDecode(event.Data, &data); err != nil {
			return err
		}
		if data.EventType != event.EventType || data.WorkspaceID != event.WorkspaceID ||
			data.AgentSessionID != event.AgentSessionID || data.Interaction.AgentSessionID != event.AgentSessionID ||
			strings.TrimSpace(data.Interaction.TurnID) == "" || strings.TrimSpace(data.Interaction.RequestID) == "" {
			return fmt.Errorf("%w: invalid interaction update identity", ErrInvalidLiveEvent)
		}
		if !validInteractionKind(data.Interaction.Kind) || !validInteractionStatus(data.Interaction.Status) {
			return fmt.Errorf("%w: invalid interaction vocabulary", ErrInvalidLiveEvent)
		}
		if data.OccurredAtUnixMS < 0 || data.Interaction.CreatedAtUnixMS < 0 ||
			data.Interaction.UpdatedAtUnixMS < 0 {
			return fmt.Errorf("%w: invalid interaction timestamp", ErrInvalidLiveEvent)
		}
		for name, raw := range map[string]json.RawMessage{
			"input": data.Interaction.Input, "output": data.Interaction.Output, "metadata": data.Interaction.Metadata,
		} {
			if err := validateJSONObjectOrNull(raw, name); err != nil {
				return err
			}
		}
	case EventTypeInteractionSnapshot:
		record, err := requiredJSONFields(event.Data, "workspaceId", "agentSessionId", "eventType", "occurredAtUnixMs", "rootTurnId", "interactions")
		if err != nil {
			return err
		}
		if string(record["interactions"]) == "null" {
			return fmt.Errorf("%w: interactions must be an array", ErrInvalidLiveEvent)
		}
		var data InteractionSnapshotData
		if err := strictDecode(event.Data, &data); err != nil {
			return err
		}
		if data.EventType != event.EventType || data.WorkspaceID != event.WorkspaceID ||
			data.AgentSessionID != event.AgentSessionID || strings.TrimSpace(data.RootTurnID) == "" ||
			data.OccurredAtUnixMS < 0 {
			return fmt.Errorf("%w: invalid interaction snapshot identity", ErrInvalidLiveEvent)
		}
		seen := make(map[string]struct{}, len(data.Interactions))
		for _, interaction := range data.Interactions {
			if interaction.AgentSessionID != event.AgentSessionID ||
				strings.TrimSpace(interaction.TurnID) == "" || strings.TrimSpace(interaction.RequestID) == "" ||
				!validInteractionKind(interaction.Kind) || !validInteractionStatus(interaction.Status) ||
				interaction.CreatedAtUnixMS < 0 || interaction.UpdatedAtUnixMS < 0 {
				return fmt.Errorf("%w: invalid interaction snapshot item", ErrInvalidLiveEvent)
			}
			if _, duplicate := seen[interaction.RequestID]; duplicate {
				return fmt.Errorf("%w: duplicate interaction snapshot request", ErrInvalidLiveEvent)
			}
			seen[interaction.RequestID] = struct{}{}
			for name, raw := range map[string]json.RawMessage{
				"input": interaction.Input, "output": interaction.Output, "metadata": interaction.Metadata,
			} {
				if err := validateJSONObjectOrNull(raw, name); err != nil {
					return err
				}
			}
		}
	case EventTypeSessionAudit:
		record, err := requiredJSONFields(event.Data, "workspaceId", "agentSessionId", "eventType", "audit")
		if err != nil {
			return err
		}
		if _, err := requiredJSONFields(record["audit"], "auditId", "role", "payload", "occurredAtUnixMs", "version"); err != nil {
			return err
		}
		var data SessionAuditData
		if err := strictDecode(event.Data, &data); err != nil {
			return err
		}
		if data.EventType != event.EventType || data.WorkspaceID != event.WorkspaceID ||
			data.AgentSessionID != event.AgentSessionID || strings.TrimSpace(data.Audit.AuditID) == "" ||
			strings.TrimSpace(data.Audit.Role) == "" || data.Audit.OccurredAtUnixMS <= 0 ||
			data.Audit.Version <= 0 || len(data.Audit.Payload) == 0 {
			return fmt.Errorf("%w: invalid session audit identity", ErrInvalidLiveEvent)
		}
		if err := validateJSONObject(data.Audit.Payload, "audit payload"); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: unsupported event type %q", ErrInvalidLiveEvent, event.EventType)
	}
	return nil
}

func validatePayloadMutation(record map[string]json.RawMessage, data MessageDeltaData) error {
	if raw, ok := record["payloadSet"]; ok {
		if len(data.PayloadSet) == 0 {
			return fmt.Errorf("%w: payloadSet must not be empty", ErrInvalidLiveEvent)
		}
		if err := validateJSONObject(raw, "payloadSet"); err != nil {
			return err
		}
		for key := range data.PayloadSet {
			if key == "" {
				return fmt.Errorf("%w: payloadSet contains an empty key", ErrInvalidLiveEvent)
			}
		}
	}
	if _, ok := record["payloadUnset"]; ok {
		if len(data.PayloadUnset) == 0 {
			return fmt.Errorf("%w: payloadUnset must not be empty", ErrInvalidLiveEvent)
		}
		seen := make(map[string]struct{}, len(data.PayloadUnset))
		for _, key := range data.PayloadUnset {
			if key == "" {
				return fmt.Errorf("%w: payloadUnset contains an empty key", ErrInvalidLiveEvent)
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("%w: payloadUnset contains duplicate key %q", ErrInvalidLiveEvent, key)
			}
			seen[key] = struct{}{}
		}
	}
	if raw, ok := record["semantics"]; ok {
		if err := validateJSONObject(raw, "semantics"); err != nil {
			return err
		}
	}
	if data.StartedAtUnixMS != nil && *data.StartedAtUnixMS < 0 {
		return fmt.Errorf("%w: startedAtUnixMs must be non-negative", ErrInvalidLiveEvent)
	}
	if data.CompletedAtUnixMS != nil && *data.CompletedAtUnixMS < 0 {
		return fmt.Errorf("%w: completedAtUnixMs must be non-negative", ErrInvalidLiveEvent)
	}
	return nil
}

func validateTurnUpdate(data TurnUpdateData) error {
	turn := data.Turn
	if data.OccurredAtUnixMS < 0 || turn.StartedAtUnixMS < 0 || turn.UpdatedAtUnixMS < 0 ||
		(turn.SettledAtUnixMS != nil && *turn.SettledAtUnixMS < 0) ||
		(turn.SourceGoalRevision != nil && *turn.SourceGoalRevision < 0) ||
		(turn.SourceGoalRepairEpoch != nil && *turn.SourceGoalRepairEpoch < 0) {
		return fmt.Errorf("%w: invalid turn timestamp or revision", ErrInvalidLiveEvent)
	}
	if turn.SourceGoalOperationID != nil && strings.TrimSpace(*turn.SourceGoalOperationID) == "" {
		return fmt.Errorf("%w: empty source goal operation identity", ErrInvalidLiveEvent)
	}
	for _, reference := range turn.CapabilityRefs {
		if reference.Capability != "tutti" || reference.Source != "slash_command" {
			return fmt.Errorf("%w: invalid turn capability reference", ErrInvalidLiveEvent)
		}
	}
	if turn.Error != nil && strings.TrimSpace(turn.Error.Message) == "" {
		return fmt.Errorf("%w: turn error requires a message", ErrInvalidLiveEvent)
	}
	if turn.CompletedCommand != nil &&
		(!validCompletedCommandKind(turn.CompletedCommand.Kind) ||
			!validCompletedCommandStatus(turn.CompletedCommand.Status)) {
		return fmt.Errorf("%w: invalid completed command", ErrInvalidLiveEvent)
	}
	if turn.Phase == "settled" {
		if data.ActiveTurnID != nil || turn.Outcome == nil || turn.SettledAtUnixMS == nil {
			return fmt.Errorf("%w: settled turn has inconsistent terminal fields", ErrInvalidLiveEvent)
		}
		return nil
	}
	if data.ActiveTurnID == nil || strings.TrimSpace(*data.ActiveTurnID) != turn.TurnID ||
		turn.Outcome != nil || turn.SettledAtUnixMS != nil {
		return fmt.Errorf("%w: active turn has inconsistent non-terminal fields", ErrInvalidLiveEvent)
	}
	return nil
}

func validCompletedCommandKind(value string) bool {
	switch value {
	case "compact", "review", "undo", "goal":
		return true
	default:
		return false
	}
}

func validCompletedCommandStatus(value string) bool {
	switch value {
	case "completed", "failed", "canceled":
		return true
	default:
		return false
	}
}

func validateJSONObject(raw json.RawMessage, field string) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("%w: %s must be an object", ErrInvalidLiveEvent, field)
	}
	return nil
}

func validateJSONObjectOrNull(raw json.RawMessage, field string) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	return validateJSONObject(raw, field)
}

func requiredJSONFields(raw []byte, fields ...string) (map[string]json.RawMessage, error) {
	var record map[string]json.RawMessage
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	for _, field := range fields {
		if _, ok := record[field]; !ok {
			return nil, fmt.Errorf("%w: missing field %q", ErrInvalidLiveEvent, field)
		}
	}
	return record, nil
}

func validTurnPhase(value string) bool {
	switch value {
	case "submitted", "running", "waiting", "settling", "settled":
		return true
	default:
		return false
	}
}

func validTurnOrigin(value string) bool {
	switch value {
	case "user_prompt", "goal_arm", "goal_continuation", "provider_initiated", "legacy_unknown":
		return true
	default:
		return false
	}
}

func validTurnOutcome(value string) bool {
	switch value {
	case "completed", "failed", "canceled", "interrupted":
		return true
	default:
		return false
	}
}

func validInteractionKind(value string) bool {
	switch value {
	case "approval", "question", "plan":
		return true
	default:
		return false
	}
}

func validInteractionStatus(value string) bool {
	switch value {
	case "pending", "answered", "superseded":
		return true
	default:
		return false
	}
}

func strictDecode(raw []byte, target any) error {
	if !utf8.Valid(raw) {
		return fmt.Errorf("%w: invalid UTF-8", ErrInvalidLiveEvent)
	}
	if err := validateJSONStructure(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	return ensureJSONEOF(decoder)
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("%w: multiple JSON values", ErrInvalidLiveEvent)
		}
		return fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	return nil
}

func validateJSONStructure(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := consumeJSONValue(decoder, 0); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func consumeJSONValue(decoder *json.Decoder, depth int) error {
	if depth > maxJSONDepth {
		return fmt.Errorf("%w: JSON nesting exceeds limit", ErrInvalidLiveEvent)
	}
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
	}
	delim, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	switch delim {
	case '{':
		keys := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("%w: %v", ErrInvalidLiveEvent, err)
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("%w: non-string object key", ErrInvalidLiveEvent)
			}
			if _, exists := keys[key]; exists {
				return fmt.Errorf("%w: duplicate JSON key %q", ErrInvalidLiveEvent, key)
			}
			keys[key] = struct{}{}
			if err := consumeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return fmt.Errorf("%w: unterminated object", ErrInvalidLiveEvent)
		}
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return fmt.Errorf("%w: unterminated array", ErrInvalidLiveEvent)
		}
	default:
		return fmt.Errorf("%w: unexpected JSON delimiter", ErrInvalidLiveEvent)
	}
	return nil
}
