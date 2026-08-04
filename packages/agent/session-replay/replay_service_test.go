package sessionreplay

import (
	"context"
	"errors"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestServiceKeepsTuttiTargetPolicyOutsideSharedWorkflow(t *testing.T) {
	service := &Service{}
	_, err := service.Start(context.Background(), StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:cursor",
	})
	if !errors.Is(err, ErrUnsupportedTarget) {
		t.Fatalf("Cursor error = %v", err)
	}
	_, err = service.Start(context.Background(), StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:claude-code",
	})
	if errors.Is(err, ErrUnsupportedTarget) {
		t.Fatalf("Claude Code remains unsupported: %v", err)
	}
}

func TestServiceMapsWorkspaceActivityEventToSharedScope(t *testing.T) {
	artifacts := &activityEventArtifactStore{}
	store := &serviceMetadataStore{}
	service := &Service{Workflow: &Workflow{
		States:    serviceFixtureStore{},
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
	if err := service.RecordActivityEvent(context.Background(), RecordingActivityEvent{
		Kind: ActivityEventKindDirectStimulus, Type: "session.send",
		EventID: "event-1", WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.events) != 1 || artifacts.events[0].ScopeID != "workspace-1" {
		t.Fatalf("events = %#v", artifacts.events)
	}
}

func TestServiceAcceptsProviderObservationSynchronousWithArm(t *testing.T) {
	ctx := context.Background()
	artifacts := &activityEventArtifactStore{}
	store := &serviceMetadataStore{}
	recorder := &serviceCallbackRecorder{}
	service := &Service{Workflow: &Workflow{
		States:    serviceFixtureStore{},
		Artifacts: artifacts,
		Transport: recorder,
		Store:     store,
		NewID:     func() string { return "recording-1" },
	}}
	recorder.onArm = func(recordingID string) error {
		return service.ObserveProviderObservations(
			ctx,
			"workspace-1",
			"session-1",
			[]ProviderObservationBatch{{
				RecordingID:  recordingID,
				ConnectionID: "connection-1",
				ChunkSeq:     1,
				UnitIndex:    1,
				UnitKind:     string(ProviderInputUnitProtocolMessage),
				Events: []ProviderObservationEvent{{
					EventIndex:     1,
					Type:           "turn.started",
					AgentSessionID: "session-1",
					TurnID:         "turn-1",
					TurnPhase:      "working",
				}},
			}},
		)
	}
	recording, err := service.Start(ctx, StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Bind(ctx, BindInput{
		RecordingID:    recording.ID,
		WorkspaceID:    "workspace-1",
		AgentTargetID:  "local:codex",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.journalEntries) != 1 || len(artifacts.plans) != 1 {
		t.Fatalf(
			"synchronous Arm observation writes: journal=%d plans=%d",
			len(artifacts.journalEntries),
			len(artifacts.plans),
		)
	}
}

func TestServiceKeepsFirstCommitForConfirmedProviderObservation(t *testing.T) {
	ctx := context.Background()
	artifacts := &activityEventArtifactStore{}
	service := &Service{Workflow: &Workflow{
		States:    serviceFixtureStore{},
		Artifacts: artifacts,
		Transport: serviceRecorder{},
		Store:     &serviceMetadataStore{},
		NewID:     func() string { return "recording-1" },
	}}
	recording, err := service.Start(ctx, StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Bind(ctx, BindInput{
		RecordingID: recording.ID, WorkspaceID: "workspace-1",
		AgentTargetID: "local:codex", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	batch := ProviderObservationBatch{
		RecordingID:  recording.ID,
		ConnectionID: "connection-1",
		ChunkSeq:     1,
		UnitIndex:    1,
		UnitKind:     string(ProviderInputUnitProtocolMessage),
		Events: []ProviderObservationEvent{{
			EventIndex:     1,
			Type:           "turn.started",
			AgentSessionID: "session-1",
			TurnID:         "turn-1",
			TurnPhase:      "working",
		}},
	}
	if err := service.ObserveProviderObservations(
		ctx, "workspace-1", "session-1",
		[]ProviderObservationBatch{batch},
	); err != nil {
		t.Fatal(err)
	}
	commit := func(transactionID string) error {
		return service.ObserveReplayCommitted(
			ctx,
			agenthost.CommittedDelta{
				TransactionID: transactionID,
				ActivityState: &agenthost.ActivityStateCommitted{
					Input: canonical.ReportSessionStateInput{
						WorkspaceID: "workspace-1",
						State: canonical.WorkspaceAgentSessionStateUpdate{
							Turn: &canonical.WorkspaceAgentTurnStateUpdate{
								TurnID: "turn-1",
								Phase:  "running",
							},
						},
					},
				},
				ProjectionDirty: []agenthost.CanonicalProjectionDirty{{
					EntityKind: "turn",
					EntityID:   "turn-1",
				}},
			},
			ProviderObservationCommitContext{
				RecordingID: recording.ID,
				Batches:     []ProviderObservationBatch{batch},
			},
		)
	}
	if err := commit("transaction-1"); err != nil {
		t.Fatal(err)
	}
	if err := commit("transaction-2"); err != nil {
		t.Fatal(err)
	}
	entry := service.checkpoints.pending[ProviderUnitPosition{
		ConnectionID: "connection-1", ChunkSeq: 1, UnitIndex: 1,
	}]
	if len(entry.Correlations) != 1 ||
		!entry.Correlations[0].Confirmed ||
		entry.Correlations[0].TransactionID != "transaction-1" {
		t.Fatalf("confirmed correlation = %#v", entry.Correlations)
	}
}

func TestServiceIgnoresLateProviderCallbacksFromCanceledRecording(t *testing.T) {
	ctx := context.Background()
	artifacts := &activityEventArtifactStore{}
	store := &serviceMetadataStore{}
	recordingIDs := []string{"recording-1", "recording-2"}
	nextRecording := 0
	service := &Service{Workflow: &Workflow{
		States:    serviceFixtureStore{},
		Artifacts: artifacts,
		Transport: serviceRecorder{},
		Store:     store,
		NewID: func() string {
			id := recordingIDs[nextRecording]
			nextRecording++
			return id
		},
	}}
	first, err := service.Start(ctx, StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Bind(ctx, BindInput{
		RecordingID: first.ID, WorkspaceID: "workspace-1",
		AgentTargetID: "local:codex", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Cancel(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	second, err := service.Start(ctx, StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Bind(ctx, BindInput{
		RecordingID: second.ID, WorkspaceID: "workspace-1",
		AgentTargetID: "local:codex", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	batch := ProviderObservationBatch{
		RecordingID:  first.ID,
		ConnectionID: "connection-1",
		ChunkSeq:     1,
		UnitIndex:    1,
		UnitKind:     string(ProviderInputUnitProtocolMessage),
		Events: []ProviderObservationEvent{{
			EventIndex: 1, Type: "turn.started",
			AgentSessionID: "session-1",
			TurnID:         "turn-from-old-recording",
			TurnPhase:      "working",
		}},
	}
	missingGeneration := batch
	missingGeneration.RecordingID = ""
	if err := service.ObserveProviderObservations(
		ctx,
		"workspace-1",
		"session-1",
		[]ProviderObservationBatch{missingGeneration},
	); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("missing Provider callback generation error = %v", err)
	}
	if err := service.ObserveReplayCommitted(
		ctx,
		agenthost.CommittedDelta{
			TransactionID: "transaction-missing-generation",
			ActivityState: &agenthost.ActivityStateCommitted{
				Input: canonical.ReportSessionStateInput{
					WorkspaceID: "workspace-1",
				},
			},
		},
		ProviderObservationCommitContext{
			Batches: []ProviderObservationBatch{missingGeneration},
		},
	); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("missing commit generation error = %v", err)
	}
	if err := service.ObserveProviderObservations(
		ctx,
		"workspace-1",
		"session-1",
		[]ProviderObservationBatch{batch},
	); err != nil {
		t.Fatal(err)
	}
	if err := service.ObserveReplayCommitted(
		ctx,
		agenthost.CommittedDelta{
			TransactionID: "transaction-old",
			ActivityState: &agenthost.ActivityStateCommitted{
				Input: canonical.ReportSessionStateInput{
					WorkspaceID: "workspace-1",
				},
			},
		},
		ProviderObservationCommitContext{
			RecordingID: first.ID,
			Batches:     []ProviderObservationBatch{batch},
		},
	); err != nil {
		t.Fatal(err)
	}
	if service.checkpoints.recordingID != second.ID ||
		len(service.checkpoints.pending) != 0 ||
		len(artifacts.journalEntries) != 0 ||
		len(artifacts.plans) != 0 {
		t.Fatalf(
			"late callbacks mutated new recording: recorder=%q pending=%d journal=%d plans=%d",
			service.checkpoints.recordingID,
			len(service.checkpoints.pending),
			len(artifacts.journalEntries),
			len(artifacts.plans),
		)
	}
}

func TestActivityBoundaryCursorCoversHandledUnitsBeyondObservationLane(
	t *testing.T,
) {
	ctx := context.Background()
	artifacts := &activityEventArtifactStore{}
	store := &serviceMetadataStore{}
	service := &Service{Workflow: &Workflow{
		States:    serviceFixtureStore{},
		Artifacts: artifacts,
		Transport: serviceRecorder{},
		Store:     store,
		NewID:     func() string { return "recording-1" },
	}}
	recording, err := service.Start(ctx, StartInput{
		WorkspaceID: "workspace-1", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Bind(ctx, BindInput{
		RecordingID: recording.ID, WorkspaceID: "workspace-1",
		AgentTargetID: "local:codex", AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	// The observation lane stops at the compaction turn start: the interrupt
	// round trip settles the turn without checkpoint observation events.
	if err := service.ObserveProviderObservations(
		ctx,
		"workspace-1",
		"session-1",
		[]ProviderObservationBatch{{
			RecordingID:  recording.ID,
			ConnectionID: "connection-1",
			ChunkSeq:     59,
			UnitIndex:    1,
			UnitKind:     string(ProviderInputUnitProtocolMessage),
			Events: []ProviderObservationEvent{{
				EventIndex:     1,
				Type:           "turn.started",
				AgentSessionID: "session-1",
				TurnID:         "turn-1",
				TurnPhase:      "working",
			}},
		}},
	); err != nil {
		t.Fatal(err)
	}
	// Units from another Recording generation must not advance the lane.
	service.ObserveProviderInputUnit(
		"recording-stale",
		ProviderUnitPosition{
			ConnectionID: "connection-1", ChunkSeq: 99, UnitIndex: 1,
		},
	)
	for _, position := range []ProviderUnitPosition{
		{ConnectionID: "connection-1", ChunkSeq: 60, UnitIndex: 1},
		{ConnectionID: "connection-1", ChunkSeq: 62, UnitIndex: 2},
		{ConnectionID: "connection-1", ChunkSeq: 63, UnitIndex: 1},
		// Connections without observations stay out of boundary cursors.
		{ConnectionID: "probe-connection", ChunkSeq: 4, UnitIndex: 1},
	} {
		service.ObserveProviderInputUnit(recording.ID, position)
	}
	if err := service.RecordActivityEvent(ctx, RecordingActivityEvent{
		Kind: ActivityEventKindIntent, Type: "session/stopRequested",
		EventID: "event-1", WorkspaceID: "workspace-1",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.RecordActivityEvent(ctx, RecordingActivityEvent{
		Kind: ActivityEventKindEffect, Type: "turn/cancel",
		EventID: "event-2", CausedByEventID: "event-1",
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Payload: map[string]any{
			"outcome": "succeeded",
			"turnId":  "turn-1",
		},
	}); err != nil {
		t.Fatal(err)
	}
	plan := service.checkpoints.plan
	if len(plan.Checkpoints) < 2 {
		t.Fatalf("plan checkpoints = %#v", plan.Checkpoints)
	}
	canceled := plan.Checkpoints[len(plan.Checkpoints)-1]
	if canceled.Kind != "turn.canceled" {
		t.Fatalf("last checkpoint kind = %q", canceled.Kind)
	}
	wantCursor := []ProviderUnitPosition{{
		ConnectionID: "connection-1", ChunkSeq: 63, UnitIndex: 1,
	}}
	if len(canceled.Cursor.ProviderConnections) != 1 ||
		canceled.Cursor.ProviderConnections[0] != wantCursor[0] {
		t.Fatalf(
			"turn.canceled cursor = %#v, want %#v",
			canceled.Cursor.ProviderConnections,
			wantCursor,
		)
	}
	working := plan.Checkpoints[len(plan.Checkpoints)-2]
	if working.Kind != "turn.working" ||
		len(working.Cursor.ProviderConnections) != 1 ||
		working.Cursor.ProviderConnections[0].ChunkSeq != 59 {
		t.Fatalf(
			"turn.working checkpoint = %q cursor %#v, want observation lane 59",
			working.Kind,
			working.Cursor.ProviderConnections,
		)
	}
}

func TestServiceListsCassettesByWorkspaceScope(t *testing.T) {
	store := &serviceMetadataStore{
		cassettes: []Cassette{{ID: "cassette-1"}},
	}
	service := &Service{Workflow: &Workflow{Store: store}}
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

func TestServiceImportsCassetteAsCompletedWorkspaceRecording(t *testing.T) {
	const (
		cassetteID  = "277377ed-af34-454f-a8b9-1047b4064e74"
		recordingID = "54f46b5c-34e5-40e2-8147-361bb0d046dc"
	)
	store := &serviceMetadataStore{}
	artifacts := &activityEventArtifactStore{
		importErrors: map[string]error{
			"/tmp/bad-tape": errors.New("corrupt cassette"),
		},
		imported: Artifact{
			Cassette: Cassette{
				ID: cassetteID, SourceRecordingID: recordingID,
				Name: "imported", AgentTargetID: "local:codex",
				RootAgentSessionID: "session-1",
				Mode:               ScenarioModeCreateSession,
				CreatedAtUnixMS:    10,
			},
			Layout: ArtifactLayout{StorageKey: "cassette/" + cassetteID},
		},
	}
	service := &Service{Workflow: &Workflow{
		Artifacts: artifacts,
		Store:     store,
		Now:       func() time.Time { return time.UnixMilli(20) },
	}}
	result, err := service.Import(context.Background(), ImportInput{
		WorkspaceID: " workspace-1 ",
		SourceDirectories: []string{
			"/tmp/bad-tape",
			"/tmp/good-tape",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Failures) != 1 ||
		result.Failures[0].SourceDirectory != "/tmp/bad-tape" ||
		len(result.Recordings) != 1 ||
		result.Recordings[0].Status != StatusComplete ||
		result.Recordings[0].ScopeID != "workspace-1" ||
		result.Recordings[0].CassetteID != cassetteID ||
		result.Recordings[0].UpdatedAtUnixMS != 20 {
		t.Fatalf("result = %#v", result)
	}
	if store.recording.ID != recordingID ||
		store.cassetteByID[cassetteID].ID != cassetteID {
		t.Fatalf("stored recording=%#v cassettes=%#v", store.recording, store.cassetteByID)
	}
}

func TestServiceRejectsImportedCursorCassette(t *testing.T) {
	if validImportedCassette(Cassette{
		ID:                "277377ed-af34-454f-a8b9-1047b4064e74",
		SourceRecordingID: "54f46b5c-34e5-40e2-8147-361bb0d046dc",
		AgentTargetID:     "local:cursor",
	}) {
		t.Fatal("Cursor cassette should be rejected")
	}
}

func TestServiceMapsReplayWorkspaceBatchToCassettes(t *testing.T) {
	cassette := Cassette{
		ID:                 "cassette-1",
		RootAgentSessionID: "session-1",
	}
	store := &serviceMetadataStore{
		cassetteByID: map[string]Cassette{cassette.ID: cassette},
	}
	service := &Service{Workflow: &Workflow{
		Artifacts: &activityEventArtifactStore{},
		Store:     store,
	}}
	prepared, err := service.PrepareReplayWorkspace(
		context.Background(),
		" workspace-1 ",
		[]string{"cassette-1"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.Cassettes) != 1 ||
		prepared.Cassettes[0].Cassette.ID != "cassette-1" ||
		prepared.Cassettes[0].Layout.StorageKey != "cassette/cassette-1" {
		t.Fatalf("prepared=%#v", prepared)
	}
}

type serviceMetadataStore struct {
	recording     Recording
	cassettes     []Cassette
	cassetteByID  map[string]Cassette
	cassetteScope string
}

func (s *serviceMetadataStore) PutRecording(_ context.Context, value Recording) error {
	s.recording = value
	return nil
}
func (s *serviceMetadataStore) DeleteRecording(context.Context, string) error {
	s.recording = Recording{}
	return nil
}
func (s *serviceMetadataStore) GetRecording(_ context.Context, id string) (Recording, error) {
	if s.recording.ID != id {
		return Recording{}, ErrRecordingNotFound
	}
	return s.recording, nil
}
func (s *serviceMetadataStore) ListRecordings(context.Context, string) ([]Recording, error) {
	return []Recording{s.recording}, nil
}
func (s *serviceMetadataStore) PublishCassette(
	_ context.Context,
	recording Recording,
	cassette Cassette,
) error {
	s.recording = recording
	if s.cassetteByID == nil {
		s.cassetteByID = map[string]Cassette{}
	}
	s.cassetteByID[cassette.ID] = cassette
	return nil
}
func (*serviceMetadataStore) UpdateCassette(context.Context, Recording, Cassette) error {
	return nil
}
func (s *serviceMetadataStore) GetCassette(
	_ context.Context,
	id string,
) (Cassette, error) {
	cassette, ok := s.cassetteByID[id]
	if !ok {
		return Cassette{}, ErrCassetteNotFound
	}
	return cassette, nil
}
func (s *serviceMetadataStore) ListCassettes(
	_ context.Context,
	scopeID string,
) ([]Cassette, error) {
	s.cassetteScope = scopeID
	return s.cassettes, nil
}

type serviceFixtureStore struct{}

func (serviceFixtureStore) ResolveRootAgentSession(context.Context, string, string) (string, error) {
	return "session-1", nil
}
func (serviceFixtureStore) CaptureReplayState(context.Context, string, string) ([]byte, error) {
	return []byte(`{"schemaVersion":1}`), nil
}
func (serviceFixtureStore) WaitAgentSessionGraphSettled(context.Context, string, string) error {
	return nil
}

type serviceRecorder struct{}

func (serviceRecorder) Arm(string, string, string) error { return nil }
func (serviceRecorder) Complete(string) error            { return nil }
func (serviceRecorder) Cancel(string) error              { return nil }

type serviceCallbackRecorder struct {
	onArm func(recordingID string) error
}

func (r *serviceCallbackRecorder) Arm(_, recordingID, _ string) error {
	return r.onArm(recordingID)
}
func (*serviceCallbackRecorder) Complete(string) error { return nil }
func (*serviceCallbackRecorder) Cancel(string) error   { return nil }

type activityEventArtifactStore struct {
	events         []ActivityEvent
	plans          []CheckpointPlan
	journalEntries []ObservationJournalEntry
	imported       Artifact
	importErrors   map[string]error
	discarded      []string
}

func (s *activityEventArtifactStore) WriteCheckpointPlan(
	_ context.Context,
	_ Recording,
	plan CheckpointPlan,
) error {
	s.plans = append(s.plans, plan)
	return nil
}

func (s *activityEventArtifactStore) Import(
	_ context.Context,
	sourceDirectory string,
) (Artifact, error) {
	if err := s.importErrors[sourceDirectory]; err != nil {
		return Artifact{}, err
	}
	return s.imported, nil
}

func (s *activityEventArtifactStore) DiscardCassette(
	_ context.Context,
	cassetteID string,
) error {
	s.discarded = append(s.discarded, cassetteID)
	return nil
}

func (*activityEventArtifactStore) Prepare(
	context.Context,
	Recording,
) (ArtifactLayout, error) {
	return ArtifactLayout{StorageKey: "candidate", ProviderTapeKey: "provider"}, nil
}
func (*activityEventArtifactStore) LocateRecording(
	context.Context,
	Recording,
) (ArtifactLayout, error) {
	return ArtifactLayout{StorageKey: "candidate", ProviderTapeKey: "provider"}, nil
}
func (s *activityEventArtifactStore) AppendActivityEvent(
	_ context.Context,
	_ Recording,
	value ActivityEvent,
) error {
	s.events = append(s.events, value)
	return nil
}
func (s *activityEventArtifactStore) AppendObservationJournalEntry(
	_ context.Context,
	_ Recording,
	entry ObservationJournalEntry,
) error {
	s.journalEntries = append(s.journalEntries, entry)
	return nil
}
func (*activityEventArtifactStore) WriteReplayState(
	context.Context,
	Recording,
	ReplayStatePhase,
	[]byte,
) error {
	return nil
}
func (*activityEventArtifactStore) Publish(
	context.Context,
	Recording,
	string,
	uint64,
) (Artifact, error) {
	return Artifact{}, nil
}
func (*activityEventArtifactStore) RollbackPublish(
	context.Context,
	Artifact,
	Recording,
) error {
	return nil
}
func (*activityEventArtifactStore) Resolve(
	_ context.Context,
	cassette Cassette,
) (Artifact, error) {
	return Artifact{
		Cassette: cassette,
		Layout: ArtifactLayout{
			StorageKey: "cassette/" + cassette.ID,
		},
	}, nil
}
func (*activityEventArtifactStore) RenameCassette(
	context.Context,
	Cassette,
	string,
) (Artifact, error) {
	return Artifact{}, nil
}
func (*activityEventArtifactStore) DiscardRecording(context.Context, string) error {
	return nil
}
