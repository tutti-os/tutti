package sessionreplay

import "errors"

var (
	ErrNotFound          = ErrRecordingNotFound
	ErrInvalidImport     = errors.New("agent session cassette import is invalid")
	ErrUnsupportedTarget = errors.New("agent session recording target is unsupported")
)

type ReplayWorkspaceCassette struct {
	Cassette Cassette
	Layout   ArtifactLayout
}

type ReplayWorkspaceRequest struct {
	Cassettes []ReplayWorkspaceCassette
}

// ReplayScopeSummary is the minimal product scope identity needed when a
// semantic replay workspace is materialized. Product hosts map their local
// Room/Workspace model to this neutral shape.
type ReplayScopeSummary struct {
	ID   string
	Name string
}

// ReplayWorkbenchSnapshot is the minimal Workbench snapshot payload needed
// to seed an isolated replay scope.
type ReplayWorkbenchSnapshot struct {
	WorkspaceID   string
	SchemaVersion int
	JSON          []byte
}

type StartInput struct {
	WorkspaceID         string
	AgentTargetID       string
	AgentSessionID      string
	ReplayPrerequisites ReplayPrerequisites
}

type BindInput struct {
	RecordingID    string
	WorkspaceID    string
	AgentTargetID  string
	AgentSessionID string
}

type ImportInput struct {
	WorkspaceID       string
	SourceDirectories []string
}

type ImportFailure struct {
	Code            string
	SourceDirectory string
}

type ImportResult struct {
	Failures   []ImportFailure
	Recordings []Recording
}

// RecordingActivityEvent is the host-facing event shape. The core
// ActivityEvent uses ScopeID for capture routing; this adapter shape keeps the
// existing daemon API's WorkspaceID naming at the boundary.
type RecordingActivityEvent struct {
	SchemaVersion   int               `json:"schemaVersion"`
	Sequence        uint64            `json:"sequence"`
	Kind            ActivityEventKind `json:"kind"`
	Type            string            `json:"type"`
	EventID         string            `json:"eventId"`
	CorrelationID   string            `json:"correlationId,omitempty"`
	CausedByEventID string            `json:"causedByEventId,omitempty"`
	WorkspaceID     string            `json:"workspaceId"`
	AgentSessionID  string            `json:"agentSessionId,omitempty"`
	Payload         map[string]any    `json:"payload,omitempty"`
	OccurredAtMS    int64             `json:"occurredAtUnixMs"`
}

const (
	StatusPreparing  = RecordingStatusPreparing
	StatusReady      = RecordingStatusReady
	StatusRecording  = RecordingStatusRecording
	StatusFinalizing = RecordingStatusFinalizing
	StatusComplete   = RecordingStatusComplete
	StatusFailed     = RecordingStatusFailed
	StatusCanceled   = RecordingStatusCanceled
	StatusIncomplete = RecordingStatusIncomplete
)
