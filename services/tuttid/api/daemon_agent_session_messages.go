package api

import (
	"fmt"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

const maxWorkspaceAgentJSONSafeInteger = uint64(1<<53 - 1)

func generatedAgentSessionMessages(messages []agentservice.SessionMessage) ([]tuttigenerated.WorkspaceAgentSessionMessage, error) {
	result := make([]tuttigenerated.WorkspaceAgentSessionMessage, 0, len(messages))
	for _, message := range messages {
		// Protocol v2 message ownership: a non-empty turnId attaches the
		// message to that turn; an empty stored turn id is projected as null
		// (session-level message) instead of being rejected.
		var turnID *string
		if trimmed := strings.TrimSpace(message.TurnID); trimmed != "" {
			turnID = &trimmed
		}
		sequence, err := generatedWorkspaceAgentSafeInteger("message sequence", message.ID)
		if err != nil {
			return nil, fmt.Errorf("project workspace agent message %q: %w", message.MessageID, err)
		}
		version, err := generatedWorkspaceAgentSafeInteger("message version", message.Version)
		if err != nil {
			return nil, fmt.Errorf("project workspace agent message %q: %w", message.MessageID, err)
		}
		generated := tuttigenerated.WorkspaceAgentSessionMessage{
			AgentSessionId:    strings.TrimSpace(message.AgentSessionID),
			CompletedAtUnixMs: int64Pointer(message.CompletedAtUnixMS),
			CreatedAtUnixMs:   int64Pointer(message.CreatedAtUnixMS),
			Kind:              strings.TrimSpace(message.Kind),
			MessageId:         strings.TrimSpace(message.MessageID),
			OccurredAtUnixMs:  normalizedGeneratedMessageOccurredAtUnixMS(message, version),
			Payload:           clonePayloadPointer(message.Payload),
			Role:              strings.TrimSpace(message.Role),
			Sequence:          sequence,
			StartedAtUnixMs:   int64Pointer(message.StartedAtUnixMS),
			Status:            stringPointer(strings.TrimSpace(message.Status)),
			TurnId:            turnID,
			UpdatedAtUnixMs:   int64Pointer(message.UpdatedAtUnixMS),
			Version:           version,
		}
		if message.Semantics != nil {
			userVisible := message.Semantics.UserVisibleAssistantResponse
			turnSettling := message.Semantics.TurnSettling
			generated.Semantics = &tuttigenerated.AgentActivityMessageSemantics{
				UserVisibleAssistantResponse: &userVisible,
				TurnSettling:                 &turnSettling,
				NoticeCommand:                stringPointerIfNotBlank(message.Semantics.NoticeCommand),
				NoticeCommandStatus:          stringPointerIfNotBlank(message.Semantics.NoticeCommandStatus),
			}
		}
		result = append(result, generated)
	}
	return result, nil
}

func generatedWorkspaceAgentSafeInteger(field string, value uint64) (int64, error) {
	if value > maxWorkspaceAgentJSONSafeInteger {
		return 0, fmt.Errorf(
			"%s %d exceeds JavaScript safe integer maximum %d",
			field,
			value,
			maxWorkspaceAgentJSONSafeInteger,
		)
	}
	return int64(value), nil
}

func workspaceAgentMessageCursorFromRequest(value int64) (uint64, error) {
	if value < 0 || uint64(value) > maxWorkspaceAgentJSONSafeInteger {
		return 0, agentservice.ErrInvalidArgument
	}
	return uint64(value), nil
}

func agentSessionMessageVersionRange(messages []agentservice.SessionMessage) (uint64, uint64) {
	var first uint64
	var last uint64
	for _, message := range messages {
		if first == 0 || message.Version < first {
			first = message.Version
		}
		if message.Version > last {
			last = message.Version
		}
	}
	return first, last
}

func generatedAgentSessionMessageVersionRange(messages []tuttigenerated.WorkspaceAgentSessionMessage) (int64, int64) {
	var first int64
	var last int64
	for _, message := range messages {
		if first == 0 || message.Version < first {
			first = message.Version
		}
		if message.Version > last {
			last = message.Version
		}
	}
	return first, last
}

func normalizedGeneratedMessageOccurredAtUnixMS(message agentservice.SessionMessage, version int64) int64 {
	return firstPositiveInt64(
		message.OccurredAtUnixMS,
		message.StartedAtUnixMS,
		message.CompletedAtUnixMS,
		message.CreatedAtUnixMS,
		message.UpdatedAtUnixMS,
		version,
		1,
	)
}

func firstPositiveInt64(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}
