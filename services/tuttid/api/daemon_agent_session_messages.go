package api

import (
	"fmt"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func generatedAgentSessionMessages(messages []agentservice.SessionMessage) ([]tuttigenerated.WorkspaceAgentSessionMessage, error) {
	result := make([]tuttigenerated.WorkspaceAgentSessionMessage, 0, len(messages))
	for _, message := range messages {
		turnID := strings.TrimSpace(message.TurnID)
		if turnID == "" {
			messageID := strings.TrimSpace(message.MessageID)
			if messageID == "" {
				messageID = fmt.Sprintf("id:%d", message.ID)
			}
			return nil, apierrors.WorkspaceOperationFailed(
				apierrors.WithDeveloperMessage(fmt.Sprintf("workspace agent session message %q is missing turnId", messageID)),
			)
		}
		result = append(result, tuttigenerated.WorkspaceAgentSessionMessage{
			AgentSessionId:    strings.TrimSpace(message.AgentSessionID),
			CompletedAtUnixMs: int64Pointer(message.CompletedAtUnixMS),
			CreatedAtUnixMs:   int64Pointer(message.CreatedAtUnixMS),
			Id:                int64(message.ID),
			Kind:              strings.TrimSpace(message.Kind),
			MessageId:         strings.TrimSpace(message.MessageID),
			OccurredAtUnixMs:  normalizedGeneratedMessageOccurredAtUnixMS(message),
			Payload:           clonePayloadPointer(message.Payload),
			Role:              strings.TrimSpace(message.Role),
			StartedAtUnixMs:   int64Pointer(message.StartedAtUnixMS),
			Status:            stringPointer(strings.TrimSpace(message.Status)),
			TurnId:            turnID,
			UpdatedAtUnixMs:   int64Pointer(message.UpdatedAtUnixMS),
			Version:           int64(message.Version),
		})
	}
	return result, nil
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

func normalizedGeneratedMessageOccurredAtUnixMS(message agentservice.SessionMessage) int64 {
	return firstPositiveInt64(
		message.OccurredAtUnixMS,
		message.StartedAtUnixMS,
		message.CompletedAtUnixMS,
		message.CreatedAtUnixMS,
		message.UpdatedAtUnixMS,
		int64(message.Version),
		int64(message.ID),
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
