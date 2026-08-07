package agentsessionreplay

import (
	"context"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

var (
	ErrBusy              = replay.ErrBusy
	ErrNotFound          = replay.ErrNotFound
	ErrCassetteNotFound  = replay.ErrCassetteNotFound
	ErrInvalidState      = replay.ErrInvalidState
	ErrInvalidName       = replay.ErrInvalidName
	ErrInvalidImport     = replay.ErrInvalidImport
	ErrUnsupportedTarget = replay.ErrUnsupportedTarget
)

type Status = replay.RecordingStatus
type ScenarioMode = replay.ScenarioMode
type ActivityEventKind = replay.ActivityEventKind
type Recording = replay.Recording
type Cassette = replay.Cassette
type ArtifactLayout = replay.ArtifactLayout
type MetadataStore = replay.MetadataStore
type ReplayStateStore = replay.ReplayStateStore
type ProcessRecorder = replay.ProcessRecorder
type ReplayComposerDefaults = replay.ReplayComposerDefaults
type ReplayPrerequisites = replay.ReplayPrerequisites
type ReplayWorkspaceCassette = replay.ReplayWorkspaceCassette
type ReplayWorkspaceRequest = replay.ReplayWorkspaceRequest
type ReplayScopeSummary = replay.ReplayScopeSummary
type ReplayWorkbenchSnapshot = replay.ReplayWorkbenchSnapshot
type StartInput = replay.StartInput
type BindInput = replay.BindInput
type ImportInput = replay.ImportInput
type ImportFailure = replay.ImportFailure
type ImportResult = replay.ImportResult
type ActivityEvent = replay.RecordingActivityEvent
type Service = replay.Service
type SemanticRegistration = replay.SemanticRegistration
type SemanticProfile = replay.SemanticProfile
type SemanticCassetteReader = replay.SemanticCassetteSource
type SemanticRuntime = replay.SemanticRuntime

func TuttiSemanticProfile() SemanticProfile {
	return replay.TuttiSemanticProfile()
}

func AgentSemanticProfile() SemanticProfile {
	return replay.AgentSemanticProfile()
}

// SemanticWorkspaceStore keeps Tutti's product-facing workspace types at the
// Tutti boundary. The shared replay runtime consumes its neutral equivalents
// through semanticWorkspaceStoreAdapter below.
type SemanticWorkspaceStore interface {
	ReplayWorkspaceExists(context.Context, string) (bool, error)
	Create(context.Context, workspacebiz.Summary) error
	PutWorkbenchSnapshot(context.Context, workspacebiz.WorkbenchSnapshot) error
	RestoreTuttiReplayProductState(
		context.Context,
		string,
		replay.TuttiReplayMergedState,
	) error
	CaptureTuttiReplayStateWithAgent(
		context.Context,
		string,
		agenthost.HistoricalSessionGraph,
	) (replay.TuttiReplayState, error)
}

const (
	StatusPreparing  = replay.StatusPreparing
	StatusReady      = replay.StatusReady
	StatusRecording  = replay.StatusRecording
	StatusFinalizing = replay.StatusFinalizing
	StatusComplete   = replay.StatusComplete
	StatusFailed     = replay.StatusFailed
	StatusCanceled   = replay.StatusCanceled
	StatusIncomplete = replay.StatusIncomplete

	ScenarioModeCreateSession   = replay.ScenarioModeCreateSession
	ScenarioModeContinueSession = replay.ScenarioModeContinueSession

	ActivityEventKindIntent         = replay.ActivityEventKindIntent
	ActivityEventKindEffect         = replay.ActivityEventKindEffect
	ActivityEventKindDirectStimulus = replay.ActivityEventKindDirectStimulus
)

func PrepareSemanticRuntime(
	ctx context.Context,
	store SemanticWorkspaceStore,
	host *agenthost.Host,
	reader SemanticCassetteReader,
	registrations []SemanticRegistration,
) (*SemanticRuntime, error) {
	if store == nil {
		return replay.PrepareSemanticRuntime(ctx, nil, host, reader, registrations)
	}
	return replay.PrepareSemanticRuntime(
		ctx,
		semanticWorkspaceStoreAdapter{store: store},
		host,
		reader,
		registrations,
	)
}

type semanticWorkspaceStoreAdapter struct {
	store SemanticWorkspaceStore
}

var _ replay.SemanticWorkspaceStore = semanticWorkspaceStoreAdapter{}

func (a semanticWorkspaceStoreAdapter) ReplayWorkspaceExists(
	ctx context.Context,
	workspaceID string,
) (bool, error) {
	return a.store.ReplayWorkspaceExists(ctx, workspaceID)
}

func (a semanticWorkspaceStoreAdapter) Create(
	ctx context.Context,
	summary replay.ReplayScopeSummary,
) error {
	return a.store.Create(ctx, workspacebiz.Summary{
		ID:   summary.ID,
		Name: summary.Name,
	})
}

func (a semanticWorkspaceStoreAdapter) PutWorkbenchSnapshot(
	ctx context.Context,
	snapshot replay.ReplayWorkbenchSnapshot,
) error {
	return a.store.PutWorkbenchSnapshot(ctx, workspacebiz.WorkbenchSnapshot{
		WorkspaceID:   snapshot.WorkspaceID,
		SchemaVersion: snapshot.SchemaVersion,
		JSON:          snapshot.JSON,
	})
}

func (a semanticWorkspaceStoreAdapter) RestoreTuttiReplayProductState(
	ctx context.Context,
	workspaceID string,
	state replay.TuttiReplayMergedState,
) error {
	return a.store.RestoreTuttiReplayProductState(ctx, workspaceID, state)
}

func (a semanticWorkspaceStoreAdapter) CaptureTuttiReplayStateWithAgent(
	ctx context.Context,
	workspaceID string,
	agent agenthost.HistoricalSessionGraph,
) (replay.TuttiReplayState, error) {
	return a.store.CaptureTuttiReplayStateWithAgent(ctx, workspaceID, agent)
}
