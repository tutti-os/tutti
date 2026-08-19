package agenthost

type GoalReconcileRequiredInput struct {
	WorkspaceID         string
	AgentSessionID      string
	RequestID           string
	ProviderTurnID      string
	Reason              string
	FenceMode           string
	ExpectedOperationID string
	ExpectedRevision    int64
	ExpectedRepairEpoch int64
	QuiesceSucceeded    bool
	QuiesceError        string
}
