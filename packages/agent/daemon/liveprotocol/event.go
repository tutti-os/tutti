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

func NewTurnUpdateEvent(data TurnUpdateData) (Event, error) {
	return newTypedEvent(data.WorkspaceID, data.AgentSessionID, EventTypeTurnUpdate, data)
}

func NewInteractionUpdateEvent(data InteractionUpdateData) (Event, error) {
	return newTypedEvent(data.WorkspaceID, data.AgentSessionID, EventTypeInteractionUpdate, data)
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
	case EventTypeMessageDelta:
		var data MessageDeltaData
		if err := strictDecode(event.Data, &data); err != nil {
			return err
		}
		if data.WorkspaceID != event.WorkspaceID || data.AgentSessionID != event.AgentSessionID ||
			strings.TrimSpace(data.MessageID) == "" || strings.TrimSpace(data.Role) == "" ||
			strings.TrimSpace(data.Kind) == "" || data.OccurredAtUnixMS <= 0 {
			return fmt.Errorf("%w: invalid message delta identity", ErrInvalidLiveEvent)
		}
		hasMutation := data.Content != nil || len(data.PayloadSet) > 0 || len(data.PayloadUnset) > 0 ||
			data.Status != nil || len(data.Semantics) > 0 || data.StartedAtUnixMS != nil || data.CompletedAtUnixMS != nil
		if !hasMutation {
			return fmt.Errorf("%w: empty message delta", ErrInvalidLiveEvent)
		}
		if data.Content != nil {
			switch data.Content.Operation {
			case "append_text":
				if len(data.Content.Value) != 0 {
					return fmt.Errorf("%w: append_text cannot carry value", ErrInvalidLiveEvent)
				}
			case "set":
				if len(data.Content.Value) == 0 {
					return fmt.Errorf("%w: set requires value", ErrInvalidLiveEvent)
				}
			default:
				return fmt.Errorf("%w: unknown content operation", ErrInvalidLiveEvent)
			}
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
			strings.TrimSpace(data.Audit.Role) == "" || data.Audit.Version <= 0 || len(data.Audit.Payload) == 0 {
			return fmt.Errorf("%w: invalid session audit identity", ErrInvalidLiveEvent)
		}
	default:
		return fmt.Errorf("%w: unsupported event type %q", ErrInvalidLiveEvent, event.EventType)
	}
	return nil
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
