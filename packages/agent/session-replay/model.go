// Package sessionreplay owns provider-neutral Agent Session recording,
// cassette, and replay-run semantics.
package sessionreplay

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrBusy              = errors.New("another agent session recording is active")
	ErrRecordingNotFound = errors.New("agent session recording not found")
	ErrCassetteNotFound  = errors.New("agent session cassette not found")
	ErrReplayRunNotFound = errors.New("agent session replay run not found")
	ErrInvalidState      = errors.New("agent session replay state is invalid")
	ErrInvalidName       = errors.New("agent session recording name is invalid")
)

const MaxRecordingNameRunes = 120

type RecordingStatus string

const (
	RecordingStatusPreparing  RecordingStatus = "preparing"
	RecordingStatusReady      RecordingStatus = "ready"
	RecordingStatusRecording  RecordingStatus = "recording"
	RecordingStatusFinalizing RecordingStatus = "finalizing"
	RecordingStatusComplete   RecordingStatus = "complete"
	RecordingStatusFailed     RecordingStatus = "failed"
	RecordingStatusCanceled   RecordingStatus = "canceled"
	RecordingStatusIncomplete RecordingStatus = "incomplete"
)

type ScenarioMode string

const (
	ScenarioModeCreateSession   ScenarioMode = "create-session"
	ScenarioModeContinueSession ScenarioMode = "continue-session"
)

// Recording is a mutable capture task. A successful Recording produces exactly
// one Cassette whose replay payload is immutable and whose name is mutable.
type Recording struct {
	ID                 string          `json:"id"`
	Name               string          `json:"name"`
	CassetteID         string          `json:"cassetteId,omitempty"`
	ScopeID            string          `json:"scopeId"`
	AgentTargetID      string          `json:"agentTargetId"`
	Mode               ScenarioMode    `json:"mode"`
	RootAgentSessionID string          `json:"rootAgentSessionId,omitempty"`
	Status             RecordingStatus `json:"status"`
	ArtifactKey        string          `json:"-"`
	ErrorCode          string          `json:"errorCode,omitempty"`
	ErrorMessage       string          `json:"errorMessage,omitempty"`
	CreatedAtUnixMS    int64           `json:"createdAtUnixMs"`
	RecordingAtUnixMS  int64           `json:"recordingAtUnixMs,omitempty"`
	StoppedAtUnixMS    int64           `json:"stoppedAtUnixMs,omitempty"`
	UpdatedAtUnixMS    int64           `json:"updatedAtUnixMs"`
}

type StartRecordingInput struct {
	ScopeID       string
	AgentTargetID string
	// AgentSessionID selects continue-session mode. Empty selects create-session.
	AgentSessionID string
}

type BindRecordingInput struct {
	RecordingID    string
	ScopeID        string
	AgentTargetID  string
	AgentSessionID string
}

type FixturePhase string

const (
	FixturePhaseSeed     FixturePhase = "seed"
	FixturePhaseExpected FixturePhase = "expected"
)

// Cassette is the rebuildable catalog entry for one portable artifact. Its
// replay payload is immutable; Name and the manifest hash change together when
// renamed. ArtifactKey is adapter-owned and must not be serialized into the
// portable artifact or durable metadata.
type Cassette struct {
	ID                 string       `json:"id"`
	Name               string       `json:"name"`
	SourceRecordingID  string       `json:"sourceRecordingId"`
	ScopeID            string       `json:"scopeId"`
	AgentTargetID      string       `json:"agentTargetId"`
	RootAgentSessionID string       `json:"rootAgentSessionId"`
	Mode               ScenarioMode `json:"mode"`
	TotalBytes         int64        `json:"totalBytes"`
	ManifestSHA256     string       `json:"manifestSha256"`
	ArtifactKey        string       `json:"-"`
	CreatedAtUnixMS    int64        `json:"createdAtUnixMs"`
}

type ReplayRunStatus string

const (
	ReplayRunStatusStarting ReplayRunStatus = "starting"
	ReplayRunStatusRunning  ReplayRunStatus = "running"
	ReplayRunStatusComplete ReplayRunStatus = "complete"
	ReplayRunStatusFailed   ReplayRunStatus = "failed"
	ReplayRunStatusCanceled ReplayRunStatus = "canceled"
)

// ReplayRun is mutable execution state. Multiple runs may reference the same
// immutable Cassette.
type ReplayRun struct {
	ID                string          `json:"id"`
	CassetteID        string          `json:"cassetteId"`
	Status            ReplayRunStatus `json:"status"`
	Checkpoint        int64           `json:"checkpoint"`
	ErrorCode         string          `json:"errorCode,omitempty"`
	ErrorMessage      string          `json:"errorMessage,omitempty"`
	CreatedAtUnixMS   int64           `json:"createdAtUnixMs"`
	StartedAtUnixMS   int64           `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMS int64           `json:"completedAtUnixMs,omitempty"`
	UpdatedAtUnixMS   int64           `json:"updatedAtUnixMs"`
}

// MetadataStore persists operational metadata. Implementations may use a
// durable local database or an ephemeral CI store.
type MetadataStore interface {
	PutRecording(context.Context, Recording) error
	DeleteRecording(context.Context, string) error
	GetRecording(context.Context, string) (Recording, error)
	ListRecordings(context.Context, string) ([]Recording, error)
	PublishCassette(context.Context, Recording, Cassette) error
	UpdateCassette(context.Context, Recording, Cassette) error
	GetCassette(context.Context, string) (Cassette, error)
	ListCassettes(context.Context, string) ([]Cassette, error)
	PutReplayRun(context.Context, ReplayRun) error
	GetReplayRun(context.Context, string) (ReplayRun, error)
	ListReplayRuns(context.Context, string) ([]ReplayRun, error)
}

// FixtureStore exports only the selected SessionGraph dependency closure.
// destination is allocated by the product's artifact adapter.
type FixtureStore interface {
	ResolveRootAgentSession(context.Context, string, string) (string, error)
	ExportAgentSessionGraph(context.Context, string, string, string) error
	WaitAgentSessionGraphSettled(context.Context, string, string) error
}

// ProcessRecorder captures provider protocol traffic for one root SessionGraph.
// artifactKey is opaque to the core and resolved by the product adapter.
type ProcessRecorder interface {
	Arm(rootAgentSessionID, artifactKey string) error
	Complete(rootAgentSessionID string) error
	Cancel(rootAgentSessionID string) error
}

type ArtifactLayout struct {
	StorageKey         string
	ProviderTapeKey    string
	SeedFixtureKey     string
	ExpectedFixtureKey string
}

type Artifact struct {
	Cassette Cassette
	Layout   ArtifactLayout
}

// ArtifactStore owns every file operation for Recording candidates and
// Cassettes. Keys are opaque to the application workflow.
type ArtifactStore interface {
	Prepare(context.Context, Recording) (ArtifactLayout, error)
	LocateRecording(context.Context, Recording) (ArtifactLayout, error)
	WriteScenario(context.Context, Recording, uint64) error
	AppendActivityEvent(context.Context, Recording, ActivityEvent) error
	CollectFixtureDependencies(context.Context, Recording, FixturePhase) error
	Publish(context.Context, Recording, string, uint64) (Artifact, error)
	RollbackPublish(context.Context, Artifact, Recording) error
	Resolve(context.Context, Cassette) (Artifact, error)
	RenameCassette(context.Context, Cassette, string) (Artifact, error)
	DiscardRecording(context.Context, string) error
}

type ReplayRequest struct {
	Run      ReplayRun
	Artifact Artifact
}

// ReplayRuntime starts an isolated provider-free replay composition. Desktop,
// daemon processes, VMs, and Electron windows are adapter concerns.
type ReplayRuntime interface {
	Start(context.Context, ReplayRequest) error
	Cancel(context.Context, string) error
}

type IDGenerator func() string
type Clock func() time.Time

func DefaultRecordingName(createdAt time.Time) string {
	return createdAt.UTC().Format("2006-01-02T15:04:05.000Z")
}

func NormalizeRecordingName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > MaxRecordingNameRunes {
		return "", ErrInvalidName
	}
	return name, nil
}
