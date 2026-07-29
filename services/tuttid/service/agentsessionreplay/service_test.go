package agentsessionreplay

import (
	"context"
	"errors"
	"testing"
	"time"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func TestServiceKeepsTuttiTargetPolicyOutsideSharedWorkflow(t *testing.T) {
	service := &Service{}
	_, err := service.Start(context.Background(), StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:claude-code",
	})
	if !errors.Is(err, ErrUnsupportedTarget) {
		t.Fatalf("error = %v", err)
	}
}

func TestServiceMapsWorkspaceActivityEventToSharedScope(t *testing.T) {
	artifacts := &activityEventArtifactStore{}
	store := &serviceMetadataStore{}
	service := &Service{Workflow: &replay.Workflow{
		Fixtures:  serviceFixtureStore{},
		Artifacts: artifacts,
		Transport: serviceRecorder{},
		Store:     store,
		NewID:     func() string { return "recording-1" },
	}}
	recording, err := service.Start(context.Background(), StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Bind(context.Background(), BindInput{
		RecordingID: recording.ID, WorkspaceID: "workspace-1",
		AgentTargetID: "local:codex", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.RecordActivityEvent(context.Background(), ActivityEvent{
		Kind: ActivityEventKindDirectStimulus, Type: "session.send",
		EventID: "event-1", WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.events) != 1 || artifacts.events[0].ScopeID != "workspace-1" {
		t.Fatalf("events = %#v", artifacts.events)
	}
}

func TestServiceListsCassettesByWorkspaceScope(t *testing.T) {
	store := &serviceMetadataStore{
		cassettes: []replay.Cassette{{ID: "cassette-1"}},
	}
	service := &Service{Workflow: &replay.Workflow{Store: store}}
	cassettes, err := service.ListCassettes(context.Background(), " workspace-1 ")
	if err != nil {
		t.Fatal(err)
	}
	if store.cassetteScope != "workspace-1" ||
		len(cassettes) != 1 ||
		cassettes[0].ID != "cassette-1" {
		t.Fatalf("scope=%q cassettes=%#v", store.cassetteScope, cassettes)
	}
}

func TestServiceDelegatesReplayRunCheckpointAndCancel(t *testing.T) {
	store := &serviceMetadataStore{
		replayRun: replay.ReplayRun{
			ID: "run-1", CassetteID: "cassette-1",
			Status: replay.ReplayRunStatusRunning,
		},
	}
	service := &Service{Workflow: &replay.Workflow{
		Store: store,
		Now:   func() time.Time { return time.UnixMilli(10) },
	}}
	run, err := service.AdvanceReplayRunCheckpoint(context.Background(), "run-1", 2)
	if err != nil {
		t.Fatal(err)
	}
	if run.Checkpoint != 2 || store.replayRun.Checkpoint != 2 {
		t.Fatalf("advanced run=%#v stored=%#v", run, store.replayRun)
	}
	run, err = service.CancelReplayRun(context.Background(), "run-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != replay.ReplayRunStatusCanceled ||
		store.replayRun.Status != replay.ReplayRunStatusCanceled {
		t.Fatalf("canceled run=%#v stored=%#v", run, store.replayRun)
	}
}

type serviceMetadataStore struct {
	recording     replay.Recording
	cassettes     []replay.Cassette
	cassetteScope string
	replayRun     replay.ReplayRun
}

func (s *serviceMetadataStore) PutRecording(_ context.Context, value replay.Recording) error {
	s.recording = value
	return nil
}
func (s *serviceMetadataStore) DeleteRecording(context.Context, string) error {
	s.recording = replay.Recording{}
	return nil
}
func (s *serviceMetadataStore) GetRecording(context.Context, string) (replay.Recording, error) {
	return s.recording, nil
}
func (s *serviceMetadataStore) ListRecordings(context.Context, string) ([]replay.Recording, error) {
	return []replay.Recording{s.recording}, nil
}
func (*serviceMetadataStore) PublishCassette(context.Context, replay.Recording, replay.Cassette) error {
	return nil
}
func (*serviceMetadataStore) UpdateCassette(context.Context, replay.Recording, replay.Cassette) error {
	return nil
}
func (*serviceMetadataStore) GetCassette(context.Context, string) (replay.Cassette, error) {
	return replay.Cassette{}, replay.ErrCassetteNotFound
}
func (s *serviceMetadataStore) ListCassettes(
	_ context.Context,
	scopeID string,
) ([]replay.Cassette, error) {
	s.cassetteScope = scopeID
	return s.cassettes, nil
}
func (s *serviceMetadataStore) PutReplayRun(_ context.Context, run replay.ReplayRun) error {
	s.replayRun = run
	return nil
}
func (s *serviceMetadataStore) GetReplayRun(context.Context, string) (replay.ReplayRun, error) {
	if s.replayRun.ID == "" {
		return replay.ReplayRun{}, replay.ErrReplayRunNotFound
	}
	return s.replayRun, nil
}
func (*serviceMetadataStore) ListReplayRuns(context.Context, string) ([]replay.ReplayRun, error) {
	return nil, nil
}

type serviceFixtureStore struct{}

func (serviceFixtureStore) ResolveRootAgentSession(context.Context, string, string) (string, error) {
	return "session-1", nil
}
func (serviceFixtureStore) ExportAgentSessionGraph(context.Context, string, string, string) error {
	return nil
}
func (serviceFixtureStore) WaitAgentSessionGraphSettled(context.Context, string, string) error {
	return nil
}

type serviceRecorder struct{}

func (serviceRecorder) Arm(string, string) error { return nil }
func (serviceRecorder) Complete(string) error    { return nil }
func (serviceRecorder) Cancel(string) error      { return nil }

type activityEventArtifactStore struct{ events []replay.ActivityEvent }

func (*activityEventArtifactStore) Prepare(
	context.Context,
	replay.Recording,
) (replay.ArtifactLayout, error) {
	return replay.ArtifactLayout{StorageKey: "candidate", ProviderTapeKey: "provider"}, nil
}
func (*activityEventArtifactStore) LocateRecording(
	context.Context,
	replay.Recording,
) (replay.ArtifactLayout, error) {
	return replay.ArtifactLayout{StorageKey: "candidate", ProviderTapeKey: "provider"}, nil
}
func (*activityEventArtifactStore) WriteScenario(context.Context, replay.Recording, uint64) error {
	return nil
}
func (s *activityEventArtifactStore) AppendActivityEvent(
	_ context.Context,
	_ replay.Recording,
	value replay.ActivityEvent,
) error {
	s.events = append(s.events, value)
	return nil
}
func (*activityEventArtifactStore) CollectFixtureDependencies(
	context.Context,
	replay.Recording,
	replay.FixturePhase,
) error {
	return nil
}
func (*activityEventArtifactStore) Publish(
	context.Context,
	replay.Recording,
	string,
	uint64,
) (replay.Artifact, error) {
	return replay.Artifact{}, nil
}
func (*activityEventArtifactStore) RollbackPublish(
	context.Context,
	replay.Artifact,
	replay.Recording,
) error {
	return nil
}
func (*activityEventArtifactStore) Resolve(context.Context, replay.Cassette) (replay.Artifact, error) {
	return replay.Artifact{}, nil
}
func (*activityEventArtifactStore) RenameCassette(
	context.Context,
	replay.Cassette,
	string,
) (replay.Artifact, error) {
	return replay.Artifact{}, nil
}
func (*activityEventArtifactStore) DiscardRecording(context.Context, string) error {
	return nil
}
