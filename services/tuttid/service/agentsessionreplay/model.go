package agentsessionreplay

import (
	"errors"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

var (
	ErrBusy              = replay.ErrBusy
	ErrNotFound          = replay.ErrRecordingNotFound
	ErrCassetteNotFound  = replay.ErrCassetteNotFound
	ErrReplayRunNotFound = replay.ErrReplayRunNotFound
	ErrInvalidState      = replay.ErrInvalidState
	ErrInvalidName       = replay.ErrInvalidName
	ErrUnsupportedTarget = errors.New("agent session recording target is unsupported")
)

type Status = replay.RecordingStatus
type ScenarioMode = replay.ScenarioMode
type ActivityEventKind = replay.ActivityEventKind
type Recording = replay.Recording
type Cassette = replay.Cassette
type ReplayRunStatus = replay.ReplayRunStatus
type ReplayRun = replay.ReplayRun
type ReplayRequest = replay.ReplayRequest
type MetadataStore = replay.MetadataStore
type StateFixtureStore = replay.FixtureStore
type ProcessRecorder = replay.ProcessRecorder

type StartInput struct {
	WorkspaceID    string
	AgentTargetID  string
	AgentSessionID string
}

type BindInput struct {
	RecordingID    string
	WorkspaceID    string
	AgentTargetID  string
	AgentSessionID string
}

type ActivityEvent struct {
	SchemaVersion   int                      `json:"schemaVersion"`
	Sequence        uint64                   `json:"sequence"`
	Kind            replay.ActivityEventKind `json:"kind"`
	Type            string                   `json:"type"`
	EventID         string                   `json:"eventId"`
	CorrelationID   string                   `json:"correlationId,omitempty"`
	CausedByEventID string                   `json:"causedByEventId,omitempty"`
	WorkspaceID     string                   `json:"workspaceId"`
	AgentSessionID  string                   `json:"agentSessionId,omitempty"`
	Payload         map[string]any           `json:"payload,omitempty"`
	OccurredAtMS    int64                    `json:"occurredAtUnixMs"`
}

const (
	StatusPreparing  = replay.RecordingStatusPreparing
	StatusReady      = replay.RecordingStatusReady
	StatusRecording  = replay.RecordingStatusRecording
	StatusFinalizing = replay.RecordingStatusFinalizing
	StatusComplete   = replay.RecordingStatusComplete
	StatusFailed     = replay.RecordingStatusFailed
	StatusCanceled   = replay.RecordingStatusCanceled
	StatusIncomplete = replay.RecordingStatusIncomplete

	ScenarioModeCreateSession   = replay.ScenarioModeCreateSession
	ScenarioModeContinueSession = replay.ScenarioModeContinueSession

	ReplayRunStatusStarting = replay.ReplayRunStatusStarting
	ReplayRunStatusRunning  = replay.ReplayRunStatusRunning
	ReplayRunStatusComplete = replay.ReplayRunStatusComplete
	ReplayRunStatusFailed   = replay.ReplayRunStatusFailed
	ReplayRunStatusCanceled = replay.ReplayRunStatusCanceled

	ActivityEventKindIntent         = replay.ActivityEventKindIntent
	ActivityEventKindEffect         = replay.ActivityEventKindEffect
	ActivityEventKindDirectStimulus = replay.ActivityEventKindDirectStimulus
)
