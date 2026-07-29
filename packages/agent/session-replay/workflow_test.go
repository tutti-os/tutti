package sessionreplay

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

type workflowStore struct {
	recordings map[string]Recording
	cassettes  map[string]Cassette
	runs       map[string]ReplayRun
}

func newWorkflowStore() *workflowStore {
	return &workflowStore{
		recordings: map[string]Recording{},
		cassettes:  map[string]Cassette{},
		runs:       map[string]ReplayRun{},
	}
}

func (s *workflowStore) PutRecording(_ context.Context, value Recording) error {
	value.ArtifactKey = ""
	s.recordings[value.ID] = value
	return nil
}
func (s *workflowStore) DeleteRecording(_ context.Context, id string) error {
	delete(s.recordings, id)
	return nil
}
func (s *workflowStore) GetRecording(_ context.Context, id string) (Recording, error) {
	value, ok := s.recordings[id]
	if !ok {
		return Recording{}, ErrRecordingNotFound
	}
	return value, nil
}
func (s *workflowStore) ListRecordings(_ context.Context, scopeID string) ([]Recording, error) {
	var result []Recording
	for _, value := range s.recordings {
		if scopeID == "" || value.ScopeID == scopeID {
			result = append(result, value)
		}
	}
	return result, nil
}
func (s *workflowStore) PublishCassette(
	ctx context.Context,
	recording Recording,
	cassette Cassette,
) error {
	if err := s.PutRecording(ctx, recording); err != nil {
		return err
	}
	cassette.ArtifactKey = ""
	s.cassettes[cassette.ID] = cassette
	return nil
}
func (s *workflowStore) UpdateCassette(
	ctx context.Context,
	recording Recording,
	cassette Cassette,
) error {
	return s.PublishCassette(ctx, recording, cassette)
}
func (s *workflowStore) GetCassette(_ context.Context, id string) (Cassette, error) {
	value, ok := s.cassettes[id]
	if !ok {
		return Cassette{}, ErrCassetteNotFound
	}
	return value, nil
}
func (s *workflowStore) ListCassettes(_ context.Context, scopeID string) ([]Cassette, error) {
	var result []Cassette
	for _, value := range s.cassettes {
		if scopeID == "" || value.ScopeID == scopeID {
			result = append(result, value)
		}
	}
	return result, nil
}
func (s *workflowStore) PutReplayRun(_ context.Context, value ReplayRun) error {
	s.runs[value.ID] = value
	return nil
}
func (s *workflowStore) GetReplayRun(_ context.Context, id string) (ReplayRun, error) {
	value, ok := s.runs[id]
	if !ok {
		return ReplayRun{}, ErrReplayRunNotFound
	}
	return value, nil
}
func (s *workflowStore) ListReplayRuns(_ context.Context, cassetteID string) ([]ReplayRun, error) {
	var result []ReplayRun
	for _, value := range s.runs {
		if cassetteID == "" || value.CassetteID == cassetteID {
			result = append(result, value)
		}
	}
	return result, nil
}

type workflowFixtures struct {
	events *[]string
	root   string
}

func (f workflowFixtures) ResolveRootAgentSession(
	_ context.Context,
	_ string,
	sessionID string,
) (string, error) {
	if f.root != "" {
		return f.root, nil
	}
	return sessionID, nil
}
func (f workflowFixtures) ExportAgentSessionGraph(
	_ context.Context,
	_ string,
	_ string,
	destination string,
) error {
	*f.events = append(*f.events, "fixture:"+destination)
	return nil
}
func (f workflowFixtures) WaitAgentSessionGraphSettled(
	context.Context,
	string,
	string,
) error {
	*f.events = append(*f.events, "settle")
	return nil
}

type workflowArtifacts struct {
	events         *[]string
	activityEvents []ActivityEvent
	cassettes      map[string]Cassette
}

func (a *workflowArtifacts) layout(recordingID string) ArtifactLayout {
	return ArtifactLayout{
		StorageKey:         "candidate/" + recordingID,
		ProviderTapeKey:    "candidate/" + recordingID + "/provider",
		SeedFixtureKey:     "candidate/" + recordingID + "/seed",
		ExpectedFixtureKey: "candidate/" + recordingID + "/expected",
	}
}
func (a *workflowArtifacts) Prepare(_ context.Context, recording Recording) (ArtifactLayout, error) {
	*a.events = append(*a.events, "prepare")
	return a.layout(recording.ID), nil
}
func (a *workflowArtifacts) LocateRecording(
	_ context.Context,
	recording Recording,
) (ArtifactLayout, error) {
	if recording.CassetteID != "" {
		layout := a.layout(recording.CassetteID)
		layout.StorageKey = "cassette/" + recording.CassetteID
		return layout, nil
	}
	return a.layout(recording.ID), nil
}
func (a *workflowArtifacts) WriteScenario(
	_ context.Context,
	_ Recording,
	count uint64,
) error {
	*a.events = append(*a.events, fmt.Sprintf("scenario:%d", count))
	return nil
}
func (a *workflowArtifacts) AppendActivityEvent(
	_ context.Context,
	_ Recording,
	event ActivityEvent,
) error {
	a.activityEvents = append(a.activityEvents, event)
	*a.events = append(*a.events, fmt.Sprintf("event:%d", event.Sequence))
	return nil
}
func (a *workflowArtifacts) CollectFixtureDependencies(
	_ context.Context,
	_ Recording,
	phase FixturePhase,
) error {
	*a.events = append(*a.events, "dependencies:"+string(phase))
	return nil
}
func (a *workflowArtifacts) Publish(
	_ context.Context,
	recording Recording,
	cassetteID string,
	_ uint64,
) (Artifact, error) {
	*a.events = append(*a.events, "publish")
	cassette := Cassette{
		ID:                 cassetteID,
		Name:               recording.Name,
		SourceRecordingID:  recording.ID,
		ScopeID:            recording.ScopeID,
		AgentTargetID:      recording.AgentTargetID,
		RootAgentSessionID: recording.RootAgentSessionID,
		Mode:               recording.Mode,
		ArtifactKey:        "cassette/" + cassetteID,
		CreatedAtUnixMS:    10,
	}
	if a.cassettes == nil {
		a.cassettes = map[string]Cassette{}
	}
	a.cassettes[cassette.ID] = cassette
	return Artifact{
		Cassette: cassette,
		Layout:   ArtifactLayout{StorageKey: cassette.ArtifactKey},
	}, nil
}
func (a *workflowArtifacts) RenameCassette(
	_ context.Context,
	requested Cassette,
	name string,
) (Artifact, error) {
	cassette, ok := a.cassettes[requested.ID]
	if !ok {
		return Artifact{}, ErrCassetteNotFound
	}
	cassette.Name = name
	cassette.ManifestSHA256 = "renamed"
	a.cassettes[cassette.ID] = cassette
	return Artifact{
		Cassette: cassette,
		Layout:   ArtifactLayout{StorageKey: cassette.ArtifactKey},
	}, nil
}
func (a *workflowArtifacts) RollbackPublish(
	_ context.Context,
	_ Artifact,
	_ Recording,
) error {
	*a.events = append(*a.events, "rollback-publish")
	return nil
}
func (a *workflowArtifacts) Resolve(_ context.Context, requested Cassette) (Artifact, error) {
	cassette, ok := a.cassettes[requested.ID]
	if !ok {
		return Artifact{}, ErrCassetteNotFound
	}
	return Artifact{
		Cassette: cassette,
		Layout:   ArtifactLayout{StorageKey: cassette.ArtifactKey},
	}, nil
}
func (a *workflowArtifacts) DiscardRecording(_ context.Context, id string) error {
	*a.events = append(*a.events, "discard:"+id)
	return nil
}

type workflowRecorder struct{ events *[]string }

func (r workflowRecorder) Arm(root, _ string) error {
	*r.events = append(*r.events, "arm:"+root)
	return nil
}
func (r workflowRecorder) Complete(root string) error {
	*r.events = append(*r.events, "transport-complete:"+root)
	return nil
}
func (r workflowRecorder) Cancel(root string) error {
	*r.events = append(*r.events, "transport-cancel:"+root)
	return nil
}

type workflowRuntime struct {
	started  []ReplayRequest
	canceled []string
}

func (r *workflowRuntime) Start(_ context.Context, request ReplayRequest) error {
	r.started = append(r.started, request)
	return nil
}
func (r *workflowRuntime) Cancel(_ context.Context, runID string) error {
	r.canceled = append(r.canceled, runID)
	return nil
}

func newWorkflowForTest(ids ...string) (*Workflow, *workflowStore, *workflowArtifacts, *[]string) {
	store := newWorkflowStore()
	events := &[]string{}
	artifacts := &workflowArtifacts{events: events}
	next := 0
	now := int64(1)
	return &Workflow{
		Fixtures:  workflowFixtures{events: events, root: "root-1"},
		Artifacts: artifacts,
		Transport: workflowRecorder{events: events},
		Store:     store,
		NewID: func() string {
			value := ids[next]
			next++
			return value
		},
		Now: func() time.Time {
			now++
			return time.UnixMilli(now)
		},
	}, store, artifacts, events
}

func TestRecordingWorkflowOwnsCreateBindStimuliAndCompleteOrder(t *testing.T) {
	workflow, store, artifacts, events := newWorkflowForTest("recording-1", "cassette-1")
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if recording.Status != RecordingStatusReady {
		t.Fatalf("recording = %#v", recording)
	}
	recording, err = workflow.Bind(context.Background(), BindRecordingInput{
		RecordingID: "recording-1", ScopeID: "scope-1",
		AgentTargetID: "target-1", AgentSessionID: "root-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	batch := []ActivityEvent{
		{
			Kind: ActivityEventKindIntent, Type: "submit/requested",
			EventID: "submit-root-1", ScopeID: "scope-1", AgentSessionID: "root-1",
		},
		{
			Kind: ActivityEventKindEffect, Type: "queue/sendPrompt",
			EventID: "send-root-1", CausedByEventID: "submit-root-1",
			ScopeID: "scope-1", AgentSessionID: "child-1",
		},
	}
	acceptedThrough, err := workflow.RecordActivityEvents(context.Background(), batch)
	if err != nil {
		t.Fatal(err)
	}
	if acceptedThrough != 2 {
		t.Fatalf("accepted through = %d, want 2", acceptedThrough)
	}
	acceptedThrough, err = workflow.RecordActivityEvents(context.Background(), batch)
	if err != nil || acceptedThrough != 2 || len(artifacts.activityEvents) != 2 {
		t.Fatalf(
			"idempotent batch: accepted=%d events=%d error=%v",
			acceptedThrough,
			len(artifacts.activityEvents),
			err,
		)
	}
	conflict := batch[0]
	conflict.Type = "queue/removed"
	if err := workflow.RecordActivityEvent(context.Background(), conflict); err == nil ||
		!strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("conflicting retry error = %v", err)
	}
	if err := workflow.RecordActivityEvent(context.Background(), ActivityEvent{
		Type: "session.send", ScopeID: "other-scope", AgentSessionID: "root-1",
	}); err != nil {
		t.Fatal(err)
	}
	recording, err = workflow.Complete(context.Background(), recording.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recording.Status != RecordingStatusComplete ||
		recording.CassetteID != "cassette-1" ||
		len(artifacts.activityEvents) != 2 ||
		artifacts.activityEvents[0].Sequence != 1 ||
		artifacts.activityEvents[1].Sequence != 2 {
		t.Fatalf("recording=%#v activityEvents=%#v", recording, artifacts.activityEvents)
	}
	if recording.Name != "1970-01-01T00:00:00.002Z" {
		t.Fatalf("recording name = %q", recording.Name)
	}
	if _, ok := store.cassettes["cassette-1"]; !ok {
		t.Fatal("cassette metadata was not committed")
	}
	wantOrder := []string{
		"prepare",
		"arm:root-1",
		"scenario:0",
		"event:1",
		"event:2",
		"settle",
		"transport-complete:root-1",
		"scenario:2",
		"fixture:candidate/recording-1/expected",
		"dependencies:expected",
		"publish",
	}
	if !slices.Equal(*events, wantOrder) {
		t.Fatalf("events = %#v, want %#v", *events, wantOrder)
	}
}

func TestRecordingWorkflowRenamesCompletedCassette(t *testing.T) {
	workflow, store, artifacts, _ := newWorkflowForTest("recording-1", "cassette-1")
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1", AgentSessionID: "root-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	recording, err = workflow.Complete(context.Background(), recording.ID)
	if err != nil {
		t.Fatal(err)
	}
	recording, err = workflow.Rename(context.Background(), recording.ID, "checkout regression")
	if err != nil {
		t.Fatal(err)
	}
	if recording.Name != "checkout regression" ||
		store.cassettes[recording.CassetteID].Name != "checkout regression" ||
		artifacts.cassettes[recording.CassetteID].Name != "checkout regression" {
		t.Fatalf("renamed recording = %#v", recording)
	}
}

func TestRecordingWorkflowCapturesContinueSeedBeforeArm(t *testing.T) {
	workflow, _, _, events := newWorkflowForTest("recording-1")
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1", AgentSessionID: "child-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if recording.Mode != ScenarioModeContinueSession ||
		recording.Status != RecordingStatusRecording {
		t.Fatalf("recording = %#v", recording)
	}
	want := []string{
		"prepare",
		"fixture:candidate/recording-1/seed",
		"dependencies:seed",
		"arm:root-1",
		"scenario:0",
	}
	if !slices.Equal(*events, want) {
		t.Fatalf("events = %#v, want %#v", *events, want)
	}
}

func TestRecordingWorkflowSingleActiveCancelAndRecover(t *testing.T) {
	workflow, store, _, events := newWorkflowForTest("recording-1", "recording-2")
	first, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	}); !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent Start error = %v", err)
	}
	if _, err := workflow.Cancel(context.Background(), first.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.recordings[first.ID]; ok {
		t.Fatalf("canceled recording %q was persisted", first.ID)
	}
	recordings, err := workflow.List(context.Background(), first.ScopeID)
	if err != nil {
		t.Fatal(err)
	}
	if len(recordings) != 0 {
		t.Fatalf("recordings after cancel = %#v", recordings)
	}
	second, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	restarted := &Workflow{
		Artifacts: workflow.Artifacts,
		Store:     store,
		Now:       workflow.Now,
	}
	if err := restarted.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := store.recordings[second.ID]
	if got.Status != RecordingStatusIncomplete || got.ErrorCode != "daemon_restarted" {
		t.Fatalf("recovered recording = %#v", got)
	}
	if !slices.Contains(*events, "discard:"+second.ID) {
		t.Fatalf("events = %#v", *events)
	}
}

func TestReplayWorkflowCreatesManyRunsForOneCassette(t *testing.T) {
	workflow, store, artifacts, _ := newWorkflowForTest("run-1", "run-2")
	runtime := &workflowRuntime{}
	workflow.Runtime = runtime
	cassette := Cassette{ID: "cassette-1", ScopeID: "scope-1", ArtifactKey: "cassette/cassette-1"}
	store.cassettes[cassette.ID] = cassette
	artifacts.cassettes = map[string]Cassette{cassette.ID: cassette}

	first, err := workflow.CreateReplayRun(context.Background(), cassette.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := workflow.CreateReplayRun(context.Background(), cassette.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID || first.CassetteID != second.CassetteID {
		t.Fatalf("runs = %#v %#v", first, second)
	}
	first, err = workflow.StartReplayRun(context.Background(), first.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err = workflow.StartReplayRun(context.Background(), second.ID)
	if err != nil {
		t.Fatal(err)
	}
	first, err = workflow.CompleteReplayRun(context.Background(), first.ID, 9)
	if err != nil {
		t.Fatal(err)
	}
	second, err = workflow.CancelReplayRun(context.Background(), second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != ReplayRunStatusComplete ||
		second.Status != ReplayRunStatusCanceled ||
		len(runtime.started) != 2 ||
		!slices.Equal(runtime.canceled, []string{"run-2"}) {
		t.Fatalf("first=%#v second=%#v runtime=%#v", first, second, runtime)
	}
}

func TestReplayWorkflowPreparesAndMarksExternalRuntime(t *testing.T) {
	workflow, store, artifacts, _ := newWorkflowForTest("run-1")
	cassette := Cassette{
		ID:          "cassette-1",
		ArtifactKey: "cassette-key",
	}
	store.cassettes[cassette.ID] = cassette
	artifacts.cassettes = map[string]Cassette{cassette.ID: cassette}
	request, err := workflow.PrepareReplayRun(context.Background(), "cassette-1")
	if err != nil {
		t.Fatal(err)
	}
	if request.Run.Status != ReplayRunStatusStarting ||
		request.Artifact.Layout.StorageKey != "cassette-key" {
		t.Fatalf("prepared request = %#v", request)
	}
	run, err := workflow.MarkReplayRunRunning(context.Background(), request.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ReplayRunStatusRunning {
		t.Fatalf("run status = %q, want running", run.Status)
	}
}

func TestReplayWorkflowAdvancesOnlyRunningRunCheckpoint(t *testing.T) {
	workflow, store, _, _ := newWorkflowForTest()
	store.runs["run-1"] = ReplayRun{
		ID: "run-1", CassetteID: "cassette-1", Status: ReplayRunStatusRunning,
		CreatedAtUnixMS: 1, StartedAtUnixMS: 2, UpdatedAtUnixMS: 2,
	}
	run, err := workflow.AdvanceReplayRunCheckpoint(
		context.Background(),
		"run-1",
		2,
	)
	if err != nil {
		t.Fatal(err)
	}
	if run.Checkpoint != 2 || store.runs["run-1"].Checkpoint != 2 {
		t.Fatalf("run = %#v stored = %#v", run, store.runs["run-1"])
	}
	if _, err := workflow.AdvanceReplayRunCheckpoint(
		context.Background(),
		"run-1",
		1,
	); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("backward advance error = %v", err)
	}
	run = store.runs["run-1"]
	run.Status = ReplayRunStatusComplete
	store.runs["run-1"] = run
	if _, err := workflow.AdvanceReplayRunCheckpoint(
		context.Background(),
		"run-1",
		3,
	); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("terminal advance error = %v", err)
	}
}

func TestWorkflowRecoveryFailsInterruptedReplayRuns(t *testing.T) {
	workflow, store, _, _ := newWorkflowForTest()
	store.runs["run-1"] = ReplayRun{
		ID: "run-1", CassetteID: "cassette-1", Status: ReplayRunStatusRunning,
		CreatedAtUnixMS: 1, StartedAtUnixMS: 2, UpdatedAtUnixMS: 2,
	}
	if err := workflow.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := store.runs["run-1"]
	if got.Status != ReplayRunStatusFailed || got.ErrorCode != "daemon_restarted" {
		t.Fatalf("recovered run = %#v", got)
	}
}
