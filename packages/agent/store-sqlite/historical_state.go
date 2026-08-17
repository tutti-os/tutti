package storesqlite

import "errors"

var ErrHistoricalStateConflict = errors.New(
	"historical Agent state conflicts with canonical state",
)

type HistoricalSessionGraph struct {
	RootSessionID string              `json:"rootSessionId"`
	Sessions      []HistoricalSession `json:"sessions"`
}

// HistoricalSessionGraphRestoreInput binds portable historical state to one
// runtime-owned Workspace and user. WorkspaceID and UserID are deliberately
// outside HistoricalSessionGraph so cassette artifacts remain product-neutral
// and do not persist the identity of the user that recorded them.
type HistoricalSessionGraphRestoreInput struct {
	WorkspaceID string
	UserID      string
	Graph       HistoricalSessionGraph
}

type HistoricalSession struct {
	ID                       string                  `json:"id"`
	Kind                     string                  `json:"kind,omitempty"`
	RootSessionID            string                  `json:"rootSessionId,omitempty"`
	RootTurnID               string                  `json:"rootTurnId,omitempty"`
	ParentSessionID          string                  `json:"parentSessionId,omitempty"`
	ParentTurnID             string                  `json:"parentTurnId,omitempty"`
	ParentToolCallID         string                  `json:"parentToolCallId,omitempty"`
	Origin                   string                  `json:"origin,omitempty"`
	AgentTargetID            string                  `json:"agentTargetId"`
	Provider                 string                  `json:"provider"`
	ProviderSessionID        string                  `json:"providerSessionId"`
	Model                    string                  `json:"model,omitempty"`
	Settings                 map[string]any          `json:"settings"`
	ProviderResumeCheckpoint map[string]any          `json:"providerResumeCheckpoint,omitempty"`
	Cwd                      string                  `json:"cwd,omitempty"`
	RailSectionKind          string                  `json:"railSectionKind,omitempty"`
	RailProjectPath          string                  `json:"railProjectPath,omitempty"`
	RailSectionKey           string                  `json:"railSectionKey,omitempty"`
	Title                    string                  `json:"title,omitempty"`
	ActiveTurnID             string                  `json:"activeTurnId,omitempty"`
	Pinned                   bool                    `json:"pinned"`
	Turns                    []HistoricalTurn        `json:"turns"`
	Messages                 []HistoricalMessage     `json:"messages"`
	Interactions             []HistoricalInteraction `json:"interactions"`
	Goal                     *HistoricalGoal         `json:"goal,omitempty"`
}

type HistoricalTurn struct {
	ID                    string                `json:"id"`
	IdentityAnchorTurnID  string                `json:"identityAnchorTurnId,omitempty"`
	CapabilityRefs        []CapabilityReference `json:"capabilityRefs"`
	Phase                 string                `json:"phase"`
	Outcome               string                `json:"outcome,omitempty"`
	Error                 map[string]any        `json:"error,omitempty"`
	FileChanges           map[string]any        `json:"fileChanges,omitempty"`
	CompletedCommand      map[string]any        `json:"completedCommand,omitempty"`
	Origin                string                `json:"origin"`
	SourceGoalOperationID string                `json:"sourceGoalOperationId,omitempty"`
	SourceGoalRevision    int64                 `json:"sourceGoalRevision,omitempty"`
	SourceGoalRepairEpoch int64                 `json:"sourceGoalRepairEpoch,omitempty"`
	RootProviderTurnID    string                `json:"rootProviderTurnId,omitempty"`
}

type HistoricalMessage struct {
	ID        string         `json:"id"`
	TurnID    string         `json:"turnId,omitempty"`
	Role      string         `json:"role"`
	Kind      string         `json:"kind,omitempty"`
	Status    string         `json:"status,omitempty"`
	Semantics map[string]any `json:"semantics,omitempty"`
	Payload   map[string]any `json:"payload"`
}

type HistoricalInteraction struct {
	RequestID string         `json:"requestId"`
	TurnID    string         `json:"turnId"`
	Kind      string         `json:"kind"`
	Status    string         `json:"status"`
	ToolName  string         `json:"toolName,omitempty"`
	Input     map[string]any `json:"input"`
	Output    map[string]any `json:"output"`
	Metadata  map[string]any `json:"metadata"`
}

type HistoricalGoal struct {
	Desired            map[string]any `json:"desired"`
	Observed           map[string]any `json:"observed"`
	Revision           int64          `json:"revision"`
	Tombstoned         bool           `json:"tombstoned"`
	SyncStatus         string         `json:"syncStatus"`
	PendingOperationID string         `json:"pendingOperationId,omitempty"`
	LastEvidence       map[string]any `json:"lastEvidence"`
	LastError          string         `json:"lastError,omitempty"`
}
