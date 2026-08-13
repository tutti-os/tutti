package eventstream

import (
	"encoding/json"
	"fmt"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

type agentActivityUpdatedDataHeader struct {
	WorkspaceID    string `json:"workspaceId"`
	AgentSessionID string `json:"agentSessionId"`
	EventType      string `json:"eventType"`
}

func validateAgentActivityUpdatedPayload(payload []byte) error {
	var decoded agentActivityUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.WorkspaceID) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if strings.TrimSpace(decoded.AgentSessionID) == "" {
		return fmt.Errorf("agentSessionId is required")
	}
	switch strings.TrimSpace(decoded.EventType) {
	case "runtime_activity_update", "session_reconcile_required", "session_deleted", "session_restored", "session_audit", "message_delta", "message_update", "turn_update", "interaction_update":
	default:
		return fmt.Errorf("eventType is unsupported")
	}
	if len(decoded.Data) == 0 || string(decoded.Data) == "null" {
		return fmt.Errorf("data is required")
	}
	return validateAgentActivityUpdatedData(decoded)
}

type agentActivitySessionUpdateData struct {
	agentActivityUpdatedDataHeader
	AgentTargetID   string `json:"agentTargetId,omitempty"`
	LastEventUnixMS *int64 `json:"lastEventUnixMs"`
}

type agentActivityRuntimeActivityUpdateData struct {
	agentActivityUpdatedDataHeader
	State            string `json:"state"`
	OccurredAtUnixMS *int64 `json:"occurredAtUnixMs"`
}

func validateAgentActivityRuntimeActivityUpdateData(raw json.RawMessage) error {
	var data agentActivityRuntimeActivityUpdateData
	if err := decodeJSONStrict(raw, &data); err != nil {
		return fmt.Errorf("decode runtime_activity_update data: %w", err)
	}
	if !isOneOf(strings.TrimSpace(data.State), "idle", "running") {
		return fmt.Errorf("data.state is invalid")
	}
	if data.OccurredAtUnixMS == nil || *data.OccurredAtUnixMS <= 0 {
		return fmt.Errorf("data.occurredAtUnixMs is required")
	}
	return nil
}

type agentActivitySessionDeletedData struct {
	agentActivityUpdatedDataHeader
	DeletedAtUnixMS *int64 `json:"deletedAtUnixMs"`
}

type agentActivitySessionRestoredData struct {
	agentActivityUpdatedDataHeader
	RestoredAtUnixMS *int64 `json:"restoredAtUnixMs"`
}

type agentActivityMessageUpdateData struct {
	agentActivityUpdatedDataHeader
	LatestVersion *uint64                    `json:"latestVersion"`
	AcceptedCount *int                       `json:"acceptedCount"`
	Messages      []agentActivityMessageData `json:"messages"`
}

type agentActivityMessageData struct {
	AgentSessionID string                         `json:"agentSessionId"`
	Kind           string                         `json:"kind"`
	MessageID      string                         `json:"messageId"`
	Payload        map[string]any                 `json:"payload"`
	Role           string                         `json:"role"`
	Sequence       *uint64                        `json:"sequence"`
	Version        *uint64                        `json:"version"`
	TurnID         *string                        `json:"turnId"`
	Status         string                         `json:"status,omitempty"`
	Semantics      *agentActivityMessageSemantics `json:"semantics,omitempty"`
	OccurredAtMS   *int64                         `json:"occurredAtUnixMs"`
	StartedAtMS    *int64                         `json:"startedAtUnixMs,omitempty"`
	CompletedAtMS  *int64                         `json:"completedAtUnixMs,omitempty"`
	CreatedAtMS    *int64                         `json:"createdAtUnixMs,omitempty"`
	UpdatedAtMS    *int64                         `json:"updatedAtUnixMs,omitempty"`
}

// agentActivityMessageSemantics mirrors the canonical message semantics
// payload. Keep this DTO local to the eventstream catalog so strict decoding
// remains independent of the storage package.
type agentActivityMessageSemantics struct {
	UserVisibleAssistantResponse bool   `json:"userVisibleAssistantResponse"`
	TurnSettling                 bool   `json:"turnSettling,omitempty"`
	NoticeCommand                string `json:"noticeCommand,omitempty"`
	NoticeCommandStatus          string `json:"noticeCommandStatus,omitempty"`
}

type agentActivitySessionAuditData struct {
	agentActivityUpdatedDataHeader
	Audit agentActivitySessionAudit `json:"audit"`
}

type agentActivitySessionAudit struct {
	AuditID          string         `json:"auditId"`
	Role             string         `json:"role"`
	Payload          map[string]any `json:"payload"`
	OccurredAtUnixMS *int64         `json:"occurredAtUnixMs"`
	Version          *uint64        `json:"version"`
}

type agentActivityTurnUpdateData struct {
	agentActivityUpdatedDataHeader
	OccurredAtUnixMS *int64                            `json:"occurredAtUnixMs"`
	ActiveTurnID     *string                           `json:"activeTurnId"`
	Turn             tuttigenerated.WorkspaceAgentTurn `json:"turn"`
}

type agentActivityInteractionUpdateData struct {
	agentActivityUpdatedDataHeader
	OccurredAtUnixMS *int64                       `json:"occurredAtUnixMs"`
	Interaction      agentActivityInteractionData `json:"interaction"`
}

type agentActivityInteractionData struct {
	RequestID       string          `json:"requestId"`
	AgentSessionID  string          `json:"agentSessionId"`
	TurnID          string          `json:"turnId"`
	Kind            string          `json:"kind"`
	Status          string          `json:"status"`
	ToolName        *string         `json:"toolName"`
	Input           *map[string]any `json:"input"`
	Output          *map[string]any `json:"output"`
	Metadata        *map[string]any `json:"metadata"`
	CreatedAtUnixMS *int64          `json:"createdAtUnixMs"`
	UpdatedAtUnixMS *int64          `json:"updatedAtUnixMs"`
}
