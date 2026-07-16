package eventstream

type agentActivityUpdatedDataHeader struct {
	WorkspaceID    string `json:"workspaceId"`
	AgentSessionID string `json:"agentSessionId"`
	EventType      string `json:"eventType"`
}

type agentActivitySessionUpdateData struct {
	agentActivityUpdatedDataHeader
	AgentTargetID   string `json:"agentTargetId,omitempty"`
	LastEventUnixMS *int64 `json:"lastEventUnixMs"`
}

type agentActivitySessionDeletedData struct {
	agentActivityUpdatedDataHeader
	DeletedAtUnixMS *int64 `json:"deletedAtUnixMs"`
}

type agentActivityMessageUpdateData struct {
	agentActivityUpdatedDataHeader
	LatestVersion *uint64                    `json:"latestVersion"`
	AcceptedCount *int                       `json:"acceptedCount"`
	Messages      []agentActivityMessageData `json:"messages"`
}

type agentActivityMessageData struct {
	AgentSessionID string         `json:"agentSessionId"`
	Kind           string         `json:"kind"`
	MessageID      string         `json:"messageId"`
	Payload        map[string]any `json:"payload"`
	Role           string         `json:"role"`
	Sequence       *uint64        `json:"sequence"`
	Version        *uint64        `json:"version"`
	TurnID         *string        `json:"turnId"`
	Status         string         `json:"status,omitempty"`
	OccurredAtMS   *int64         `json:"occurredAtUnixMs"`
	StartedAtMS    *int64         `json:"startedAtUnixMs,omitempty"`
	CompletedAtMS  *int64         `json:"completedAtUnixMs,omitempty"`
	CreatedAtMS    *int64         `json:"createdAtUnixMs,omitempty"`
	UpdatedAtMS    *int64         `json:"updatedAtUnixMs,omitempty"`
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
	OccurredAtUnixMS *int64                `json:"occurredAtUnixMs"`
	ActiveTurnID     *string               `json:"activeTurnId"`
	Turn             agentActivityTurnData `json:"turn"`
}

type agentActivityTurnData struct {
	TurnID                string                                 `json:"turnId"`
	AgentSessionID        string                                 `json:"agentSessionId"`
	CapabilityRefs        []agentActivityCapabilityReferenceData `json:"capabilityRefs,omitempty"`
	Phase                 string                                 `json:"phase"`
	Origin                string                                 `json:"origin"`
	SourceGoalOperationID *string                                `json:"sourceGoalOperationId,omitempty"`
	SourceGoalRevision    *int64                                 `json:"sourceGoalRevision,omitempty"`
	SourceGoalRepairEpoch *int64                                 `json:"sourceGoalRepairEpoch,omitempty"`
	Outcome               *string                                `json:"outcome"`
	Error                 *agentActivityTurnErrorData            `json:"error"`
	FileChanges           *map[string]any                        `json:"fileChanges"`
	CompletedCommand      *agentActivityCompletedCommand         `json:"completedCommand"`
	StartedAtUnixMS       *int64                                 `json:"startedAtUnixMs"`
	SettledAtUnixMS       *int64                                 `json:"settledAtUnixMs"`
	UpdatedAtUnixMS       *int64                                 `json:"updatedAtUnixMs"`
}

type agentActivityCapabilityReferenceData struct {
	Capability string `json:"capability"`
	Source     string `json:"source"`
}

type agentActivityTurnErrorData struct {
	Message string  `json:"message"`
	Code    *string `json:"code"`
}

type agentActivityCompletedCommand struct {
	Kind   string `json:"kind"`
	Status string `json:"status"`
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
