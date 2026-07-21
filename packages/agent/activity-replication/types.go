// Package activityreplication defines the versioned JSON contract used to
// project owner-local canonical agent activity into a cloud read model.
//
// It deliberately contains no persistence, transport, room authorization, or
// GUI-derived state. Local command state is not replicated; its legacy entity
// names remain decodable only for tombstone cleanup.
package activityreplication

import "encoding/json"

const (
	SchemaVersion = 1
	// ProjectionEpoch fences local acknowledgement state from a cloud
	// projection that has been intentionally rebaselined. Increment it in the
	// same release as any destructive cloud projection reset.
	ProjectionEpoch   = 1
	MaxBatchMutations = 500
)

type EntityType string

const (
	EntityTarget      EntityType = "agentTarget"
	EntitySession     EntityType = "session"
	EntityTurn        EntityType = "turn"
	EntityInteraction EntityType = "interaction"
	EntityMessage     EntityType = "message"

	// Legacy command-state entity names are accepted only for delete mutations.
	EntityRuntimeOperation      EntityType = "runtimeOperation"
	EntityRuntimeOperationEvent EntityType = "runtimeOperationEvent"
	EntitySubmitClaim           EntityType = "submitClaim"
)

type Operation string

const (
	OperationUpsert Operation = "upsert"
	OperationDelete Operation = "delete"
)

type EntityKey struct {
	AgentTargetID  string `json:"agentTargetId,omitempty"`
	AgentSessionID string `json:"agentSessionId,omitempty"`
	TurnID         string `json:"turnId,omitempty"`
	RequestID      string `json:"requestId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	OperationID    string `json:"operationId,omitempty"`
	EventKind      string `json:"eventKind,omitempty"`
	ClientSubmitID string `json:"clientSubmitId,omitempty"`
}

type Target struct {
	ID              string          `json:"id"`
	Provider        string          `json:"provider"`
	LaunchRef       json.RawMessage `json:"launchRef"`
	Name            string          `json:"name"`
	IconKey         *string         `json:"iconKey"`
	IconURL         string          `json:"iconUrl"`
	MaskIconURL     string          `json:"maskIconUrl,omitempty"`
	HeroImageURL    string          `json:"heroImageUrl"`
	Enabled         bool            `json:"enabled"`
	Source          string          `json:"source"`
	SortOrder       int64           `json:"sortOrder"`
	CreatedAtUnixMS int64           `json:"createdAtUnixMs"`
	UpdatedAtUnixMS int64           `json:"updatedAtUnixMs"`
}

type Session struct {
	WorkspaceID            string          `json:"workspaceId"`
	AgentSessionID         string          `json:"agentSessionId"`
	Kind                   string          `json:"kind"`
	RootAgentSessionID     *string         `json:"rootAgentSessionId"`
	RootTurnID             *string         `json:"rootTurnId"`
	ParentAgentSessionID   *string         `json:"parentAgentSessionId"`
	ParentTurnID           *string         `json:"parentTurnId"`
	ParentToolCallID       *string         `json:"parentToolCallId"`
	Origin                 string          `json:"origin"`
	UserID                 string          `json:"userId"`
	AgentTargetID          *string         `json:"agentTargetId"`
	Provider               string          `json:"provider"`
	ProviderSessionID      string          `json:"providerSessionId"`
	Model                  string          `json:"model"`
	Settings               json.RawMessage `json:"settings"`
	SessionMetadata        json.RawMessage `json:"sessionMetadata"`
	InternalRuntimeContext json.RawMessage `json:"internalRuntimeContext"`
	CWD                    string          `json:"cwd"`
	RailSectionKind        string          `json:"railSectionKind"`
	RailProjectPath        string          `json:"railProjectPath"`
	RailSectionKey         string          `json:"railSectionKey"`
	Title                  string          `json:"title"`
	MessageVersion         uint64          `json:"messageVersion"`
	LastEventAtUnixMS      int64           `json:"lastEventAtUnixMs"`
	StartedAtUnixMS        int64           `json:"startedAtUnixMs"`
	EndedAtUnixMS          int64           `json:"endedAtUnixMs"`
	PinnedAtUnixMS         int64           `json:"pinnedAtUnixMs"`
	DeletedAtUnixMS        int64           `json:"deletedAtUnixMs"`
	CreatedAtUnixMS        int64           `json:"createdAtUnixMs"`
	UpdatedAtUnixMS        int64           `json:"updatedAtUnixMs"`
	ActiveTurnID           *string         `json:"activeTurnId"`
}

type Turn struct {
	WorkspaceID                      string          `json:"workspaceId"`
	AgentSessionID                   string          `json:"agentSessionId"`
	TurnID                           string          `json:"turnId"`
	Phase                            string          `json:"phase"`
	Outcome                          *string         `json:"outcome"`
	Error                            json.RawMessage `json:"error"`
	FileChanges                      json.RawMessage `json:"fileChanges"`
	CompletedCommand                 json.RawMessage `json:"completedCommand"`
	Backfilled                       bool            `json:"backfilled"`
	Origin                           string          `json:"origin"`
	SourceGoalOperationID            *string         `json:"sourceGoalOperationId"`
	SourceGoalRevision               *int64          `json:"sourceGoalRevision"`
	SourceGoalRepairEpoch            *int64          `json:"sourceGoalRepairEpoch"`
	StartedAtUnixMS                  int64           `json:"startedAtUnixMs"`
	SettledAtUnixMS                  *int64          `json:"settledAtUnixMs"`
	CreatedAtUnixMS                  int64           `json:"createdAtUnixMs"`
	UpdatedAtUnixMS                  int64           `json:"updatedAtUnixMs"`
	RootProviderTurnID               *string         `json:"rootProviderTurnId"`
	RootProviderTurnPhase            *string         `json:"rootProviderTurnPhase"`
	RootProviderTurnOutcome          *string         `json:"rootProviderTurnOutcome"`
	RootProviderTurnError            json.RawMessage `json:"rootProviderTurnError"`
	RootProviderTurnCompletedCommand json.RawMessage `json:"rootProviderTurnCompletedCommand"`
	RootProviderTurnUpdatedAtUnixMS  int64           `json:"rootProviderTurnUpdatedAtUnixMs"`
}

type Interaction struct {
	WorkspaceID     string          `json:"workspaceId"`
	AgentSessionID  string          `json:"agentSessionId"`
	RequestID       string          `json:"requestId"`
	TurnID          string          `json:"turnId"`
	Kind            string          `json:"kind"`
	Status          string          `json:"status"`
	ToolName        string          `json:"toolName"`
	Input           json.RawMessage `json:"input"`
	Output          json.RawMessage `json:"output"`
	Metadata        json.RawMessage `json:"metadata"`
	CreatedAtUnixMS int64           `json:"createdAtUnixMs"`
	UpdatedAtUnixMS int64           `json:"updatedAtUnixMs"`
}

type Message struct {
	ID                uint64          `json:"id"`
	WorkspaceID       string          `json:"workspaceId"`
	AgentSessionID    string          `json:"agentSessionId"`
	MessageID         string          `json:"messageId"`
	Version           uint64          `json:"version"`
	TurnID            *string         `json:"turnId"`
	Role              string          `json:"role"`
	Kind              string          `json:"kind"`
	Status            string          `json:"status"`
	Semantics         json.RawMessage `json:"semantics"`
	Payload           json.RawMessage `json:"payload"`
	OccurredAtUnixMS  int64           `json:"occurredAtUnixMs"`
	StartedAtUnixMS   int64           `json:"startedAtUnixMs"`
	CompletedAtUnixMS int64           `json:"completedAtUnixMs"`
	DeletedAtUnixMS   int64           `json:"deletedAtUnixMs"`
	CreatedAtUnixMS   int64           `json:"createdAtUnixMs"`
	UpdatedAtUnixMS   int64           `json:"updatedAtUnixMs"`
}

type TargetScope struct {
	OwnerUserID   string  `json:"ownerUserId"`
	OwnerDeviceID string  `json:"ownerDeviceId"`
	Description   *string `json:"description"`
}

type SessionScope struct {
	InitiatorUserID     string `json:"initiatorUserId"`
	ExecutorOwnerUserID string `json:"executorOwnerUserId"`
	SourceDeviceID      string `json:"sourceDeviceId"`
	LaunchKind          string `json:"launchKind"`
	Visibility          string `json:"visibility"`
}

// Mutation is a closed tagged union. Command-state payloads are intentionally
// absent: their legacy entity names can only be decoded as delete tombstones.
type Mutation struct {
	SchemaVersion  int           `json:"schemaVersion"`
	MutationID     string        `json:"mutationId"`
	TransactionID  string        `json:"transactionId"`
	SourceDeviceID string        `json:"sourceDeviceId"`
	WorkspaceID    string        `json:"workspaceId"`
	EntityType     EntityType    `json:"entityType"`
	Operation      Operation     `json:"operation"`
	Key            EntityKey     `json:"key"`
	Target         *Target       `json:"target,omitempty"`
	TargetScope    *TargetScope  `json:"targetScope,omitempty"`
	Session        *Session      `json:"session,omitempty"`
	SessionScope   *SessionScope `json:"sessionScope,omitempty"`
	Turn           *Turn         `json:"turn,omitempty"`
	Interaction    *Interaction  `json:"interaction,omitempty"`
	Message        *Message      `json:"message,omitempty"`
}

type ChangeBatch struct {
	SchemaVersion   int        `json:"schemaVersion"`
	ProjectionEpoch int        `json:"projectionEpoch"`
	Mutations       []Mutation `json:"mutations"`
}

// ApplyResult is the HTTP acknowledgement returned after a whole ordered
// batch is accepted. Cursor is the greatest durable cursor observed while
// applying the batch; stale no-ops do not create one.
type ApplyResult struct {
	AcceptedCount   int    `json:"acceptedCount"`
	Cursor          uint64 `json:"cursor"`
	ProjectionEpoch int    `json:"projectionEpoch"`
}
