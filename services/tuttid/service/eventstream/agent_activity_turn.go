package eventstream

type agentActivityTurnUpdateData struct {
	agentActivityUpdatedDataHeader
	OccurredAtUnixMS *int64                `json:"occurredAtUnixMs"`
	ActiveTurnID     *string               `json:"activeTurnId"`
	Turn             agentActivityTurnData `json:"turn"`
}

type agentActivityTurnData struct {
	TurnID           string                                 `json:"turnId"`
	AgentSessionID   string                                 `json:"agentSessionId"`
	CapabilityRefs   []agentActivityCapabilityReferenceData `json:"capabilityRefs,omitempty"`
	Phase            string                                 `json:"phase"`
	Outcome          *string                                `json:"outcome"`
	Error            *agentActivityTurnErrorData            `json:"error"`
	FileChanges      *map[string]any                        `json:"fileChanges"`
	CompletedCommand *agentActivityCompletedCommand         `json:"completedCommand"`
	StartedAtUnixMS  *int64                                 `json:"startedAtUnixMs"`
	SettledAtUnixMS  *int64                                 `json:"settledAtUnixMs"`
	UpdatedAtUnixMS  *int64                                 `json:"updatedAtUnixMs"`
}

type agentActivityCapabilityReferenceData struct {
	Capability string `json:"capability"`
	Source     string `json:"source"`
}
