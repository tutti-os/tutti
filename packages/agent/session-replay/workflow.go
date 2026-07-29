package sessionreplay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"
)

type Workflow struct {
	Fixtures  FixtureStore
	Artifacts ArtifactStore
	Transport ProcessRecorder
	Store     MetadataStore
	Runtime   ReplayRuntime
	NewID     IDGenerator
	Now       Clock

	mu                   sync.Mutex
	active               *Recording
	nextActivityEventSeq uint64
	activityEventsByID   map[string]ActivityEvent
}

func (w *Workflow) Start(ctx context.Context, input StartRecordingInput) (Recording, error) {
	scopeID := strings.TrimSpace(input.ScopeID)
	targetID := strings.TrimSpace(input.AgentTargetID)
	selectedSessionID := strings.TrimSpace(input.AgentSessionID)
	if scopeID == "" || targetID == "" || w.Fixtures == nil ||
		w.Artifacts == nil || w.Transport == nil || w.Store == nil ||
		w.NewID == nil {
		return Recording{}, ErrInvalidState
	}

	w.mu.Lock()
	if w.active != nil && IsRecordingActive(w.active.Status) {
		w.mu.Unlock()
		return Recording{}, ErrBusy
	}
	createdAt := w.now()
	now := createdAt.UnixMilli()
	recording := &Recording{
		ID:              strings.TrimSpace(w.NewID()),
		Name:            DefaultRecordingName(createdAt),
		ScopeID:         scopeID,
		AgentTargetID:   targetID,
		Mode:            ScenarioModeCreateSession,
		Status:          RecordingStatusPreparing,
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	if recording.ID == "" {
		w.mu.Unlock()
		return Recording{}, ErrInvalidState
	}
	if selectedSessionID != "" {
		recording.Mode = ScenarioModeContinueSession
	}
	w.active = recording
	w.nextActivityEventSeq = 0
	w.activityEventsByID = make(map[string]ActivityEvent)
	w.mu.Unlock()

	layout, err := w.Artifacts.Prepare(ctx, *recording)
	if err != nil {
		return w.fail(ctx, recording.ID, "artifact_prepare_failed", err)
	}
	recording.ArtifactKey = layout.StorageKey
	if err := w.Store.PutRecording(ctx, *recording); err != nil {
		return w.fail(ctx, recording.ID, "metadata_write_failed", err)
	}
	if selectedSessionID == "" {
		if err := w.transitionAndPersist(ctx, recording, RecordingTransition{
			Status:   RecordingStatusReady,
			AtUnixMS: w.now().UnixMilli(),
		}); err != nil {
			return w.fail(ctx, recording.ID, "recording_transition_failed", err)
		}
		return cloneRecording(recording), nil
	}

	rootID, err := w.Fixtures.ResolveRootAgentSession(ctx, scopeID, selectedSessionID)
	if err != nil {
		return w.fail(ctx, recording.ID, "session_graph_resolve_failed", err)
	}
	w.mu.Lock()
	recording.RootAgentSessionID = strings.TrimSpace(rootID)
	w.mu.Unlock()
	if recording.RootAgentSessionID == "" {
		return w.fail(ctx, recording.ID, "session_graph_resolve_failed", errors.New("resolved root session id is empty"))
	}
	if err := w.captureFixture(ctx, recording, layout.SeedFixtureKey, FixturePhaseSeed); err != nil {
		return w.fail(ctx, recording.ID, "seed_export_failed", err)
	}
	if err := w.begin(ctx, recording, layout); err != nil {
		return w.fail(ctx, recording.ID, "transport_arm_failed", err)
	}
	return cloneRecording(recording), nil
}

func (w *Workflow) Bind(ctx context.Context, input BindRecordingInput) (Recording, error) {
	recordingID := strings.TrimSpace(input.RecordingID)
	rootID := strings.TrimSpace(input.AgentSessionID)
	if recordingID == "" || rootID == "" {
		return Recording{}, ErrInvalidState
	}
	w.mu.Lock()
	recording := w.active
	if recording == nil || recording.ID != recordingID {
		w.mu.Unlock()
		return Recording{}, ErrRecordingNotFound
	}
	if recording.Status != RecordingStatusReady ||
		recording.Mode != ScenarioModeCreateSession ||
		recording.ScopeID != strings.TrimSpace(input.ScopeID) ||
		recording.AgentTargetID != strings.TrimSpace(input.AgentTargetID) {
		w.mu.Unlock()
		return Recording{}, ErrInvalidState
	}
	recording.RootAgentSessionID = rootID
	w.mu.Unlock()
	layout, err := w.Artifacts.LocateRecording(ctx, *recording)
	if err != nil {
		return w.fail(ctx, recordingID, "artifact_locate_failed", err)
	}
	if err := w.begin(ctx, recording, layout); err != nil {
		return w.fail(ctx, recordingID, "transport_arm_failed", err)
	}
	return cloneRecording(recording), nil
}

func (w *Workflow) begin(
	ctx context.Context,
	recording *Recording,
	layout ArtifactLayout,
) error {
	if err := w.Transport.Arm(recording.RootAgentSessionID, layout.ProviderTapeKey); err != nil {
		return err
	}
	if err := w.transitionAndPersist(ctx, recording, RecordingTransition{
		Status:   RecordingStatusRecording,
		AtUnixMS: w.now().UnixMilli(),
	}); err != nil {
		_ = w.Transport.Cancel(recording.RootAgentSessionID)
		return err
	}
	if err := w.Artifacts.WriteScenario(ctx, *recording, w.nextActivityEventSeq); err != nil {
		_ = w.Transport.Cancel(recording.RootAgentSessionID)
		return err
	}
	return nil
}

func (w *Workflow) RecordActivityEvent(ctx context.Context, input ActivityEvent) error {
	w.mu.Lock()
	recording := w.active
	if recording == nil || recording.Status != RecordingStatusRecording ||
		strings.TrimSpace(input.ScopeID) != recording.ScopeID {
		w.mu.Unlock()
		return nil
	}
	rootID := recording.RootAgentSessionID
	sessionID := strings.TrimSpace(input.AgentSessionID)
	snapshot := cloneRecording(recording)
	w.mu.Unlock()

	if sessionID != "" && sessionID != rootID {
		resolvedRoot, err := w.Fixtures.ResolveRootAgentSession(ctx, snapshot.ScopeID, sessionID)
		if err != nil || strings.TrimSpace(resolvedRoot) != rootID {
			return nil
		}
	}

	w.mu.Lock()
	recording = w.active
	if recording == nil || recording.Status != RecordingStatusRecording ||
		recording.RootAgentSessionID != rootID {
		w.mu.Unlock()
		return nil
	}
	normalizeActivityEventFields(&input)
	canonicalInput, err := cloneActivityEvent(input)
	if err != nil {
		w.mu.Unlock()
		return err
	}
	input = canonicalInput
	eventID := input.EventID
	if accepted, exists := w.activityEventsByID[eventID]; exists {
		input.SchemaVersion = accepted.SchemaVersion
		input.Sequence = accepted.Sequence
		input.ScopeID = accepted.ScopeID
		if input.OccurredAtMS == 0 {
			input.OccurredAtMS = accepted.OccurredAtMS
		}
		if !reflect.DeepEqual(input, accepted) {
			w.mu.Unlock()
			return fmt.Errorf("activity event id %q conflicts with an accepted event", eventID)
		}
		w.mu.Unlock()
		return nil
	}
	w.nextActivityEventSeq++
	input.SchemaVersion = CassetteSchemaVersion
	input.Sequence = w.nextActivityEventSeq
	input.ScopeID = recording.ScopeID
	if input.OccurredAtMS == 0 {
		input.OccurredAtMS = w.now().UnixMilli()
	}
	if err := ValidateActivityEvent(input); err != nil {
		w.nextActivityEventSeq--
		w.mu.Unlock()
		return err
	}
	if input.Kind == ActivityEventKindEffect {
		cause, ok := w.activityEventsByID[input.CausedByEventID]
		if !ok || cause.Kind != ActivityEventKindIntent {
			w.nextActivityEventSeq--
			w.mu.Unlock()
			return fmt.Errorf(
				"effect activity event %q must reference an earlier intent",
				eventID,
			)
		}
		if input.CorrelationID != "" && cause.CorrelationID != "" &&
			input.CorrelationID != cause.CorrelationID {
			w.nextActivityEventSeq--
			w.mu.Unlock()
			return fmt.Errorf(
				"effect activity event %q conflicts with its intent correlation",
				eventID,
			)
		}
	}
	err = w.Artifacts.AppendActivityEvent(ctx, *recording, input)
	if err == nil {
		w.activityEventsByID[eventID] = input
	} else {
		w.nextActivityEventSeq--
	}
	w.mu.Unlock()
	if err != nil {
		_ = w.Transport.Cancel(rootID)
		_, _ = w.fail(ctx, recording.ID, "activity_event_write_failed", err)
	}
	return err
}

func normalizeActivityEventFields(event *ActivityEvent) {
	event.Type = strings.TrimSpace(event.Type)
	event.EventID = strings.TrimSpace(event.EventID)
	event.CorrelationID = strings.TrimSpace(event.CorrelationID)
	event.CausedByEventID = strings.TrimSpace(event.CausedByEventID)
	event.AgentSessionID = strings.TrimSpace(event.AgentSessionID)
}

func cloneActivityEvent(event ActivityEvent) (ActivityEvent, error) {
	if event.Payload == nil {
		return event, nil
	}
	raw, err := json.Marshal(event.Payload)
	if err != nil {
		return ActivityEvent{}, err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ActivityEvent{}, err
	}
	event.Payload = payload
	return event, nil
}

// RecordActivityEvents appends one renderer batch in order. Caller event ids
// remain stable; the Workflow assigns the portable Cassette sequence. The
// returned sequence is a flush acknowledgement for every event accepted so
// far, including a partial batch when an append fails.
func (w *Workflow) RecordActivityEvents(
	ctx context.Context,
	inputs []ActivityEvent,
) (uint64, error) {
	for _, input := range inputs {
		if err := w.RecordActivityEvent(ctx, input); err != nil {
			w.mu.Lock()
			acceptedThrough := w.nextActivityEventSeq
			w.mu.Unlock()
			return acceptedThrough, err
		}
	}
	w.mu.Lock()
	acceptedThrough := w.nextActivityEventSeq
	w.mu.Unlock()
	return acceptedThrough, nil
}

func (w *Workflow) Complete(ctx context.Context, recordingID string) (Recording, error) {
	recordingID = strings.TrimSpace(recordingID)
	w.mu.Lock()
	recording := w.active
	if recording == nil || recording.ID != recordingID {
		w.mu.Unlock()
		return Recording{}, ErrRecordingNotFound
	}
	if recording.Status == RecordingStatusComplete {
		result := cloneRecording(recording)
		w.mu.Unlock()
		return result, nil
	}
	if recording.Status != RecordingStatusRecording ||
		strings.TrimSpace(recording.RootAgentSessionID) == "" {
		w.mu.Unlock()
		return Recording{}, ErrInvalidState
	}
	if err := TransitionRecording(recording, RecordingTransition{
		Status:   RecordingStatusFinalizing,
		AtUnixMS: w.now().UnixMilli(),
	}); err != nil {
		w.mu.Unlock()
		return Recording{}, err
	}
	rootID := recording.RootAgentSessionID
	snapshot := cloneRecording(recording)
	sequence := w.nextActivityEventSeq
	w.mu.Unlock()
	if err := w.Store.PutRecording(ctx, snapshot); err != nil {
		return w.fail(ctx, recordingID, "metadata_write_failed", err)
	}

	finalizeCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := w.Fixtures.WaitAgentSessionGraphSettled(
		finalizeCtx,
		snapshot.ScopeID,
		rootID,
	); err != nil {
		return w.fail(ctx, recordingID, "session_graph_settle_failed", err)
	}
	if err := w.Transport.Complete(rootID); err != nil {
		return w.fail(ctx, recordingID, "transport_finalize_failed", err)
	}
	layout, err := w.Artifacts.LocateRecording(ctx, snapshot)
	if err != nil {
		return w.fail(ctx, recordingID, "artifact_locate_failed", err)
	}
	if err := w.Artifacts.WriteScenario(ctx, snapshot, sequence); err != nil {
		return w.fail(ctx, recordingID, "scenario_write_failed", err)
	}
	if err := w.captureFixture(
		ctx,
		&snapshot,
		layout.ExpectedFixtureKey,
		FixturePhaseExpected,
	); err != nil {
		return w.fail(ctx, recordingID, "expected_state_export_failed", err)
	}
	cassetteID := strings.TrimSpace(w.NewID())
	if cassetteID == "" {
		return w.fail(ctx, recordingID, "cassette_identity_failed", ErrInvalidState)
	}
	artifact, err := w.Artifacts.Publish(ctx, snapshot, cassetteID, sequence)
	if err != nil {
		return w.fail(ctx, recordingID, "cassette_publish_failed", err)
	}
	completed := snapshot
	completed.ArtifactKey = artifact.Layout.StorageKey
	if err := TransitionRecording(&completed, RecordingTransition{
		Status:     RecordingStatusComplete,
		AtUnixMS:   w.now().UnixMilli(),
		CassetteID: artifact.Cassette.ID,
	}); err != nil {
		_ = w.Artifacts.RollbackPublish(ctx, artifact, snapshot)
		return w.fail(ctx, recordingID, "recording_transition_failed", err)
	}
	if err := w.Store.PublishCassette(ctx, completed, artifact.Cassette); err != nil {
		_ = w.Artifacts.RollbackPublish(ctx, artifact, snapshot)
		return w.fail(ctx, recordingID, "metadata_write_failed", err)
	}
	w.mu.Lock()
	*w.active = completed
	w.mu.Unlock()
	return completed, nil
}

func (w *Workflow) captureFixture(
	ctx context.Context,
	recording *Recording,
	destination string,
	phase FixturePhase,
) error {
	if err := w.Fixtures.ExportAgentSessionGraph(
		ctx,
		recording.ScopeID,
		recording.RootAgentSessionID,
		destination,
	); err != nil {
		return err
	}
	return w.Artifacts.CollectFixtureDependencies(ctx, *recording, phase)
}

func (w *Workflow) Cancel(ctx context.Context, recordingID string) (Recording, error) {
	recordingID = strings.TrimSpace(recordingID)
	w.mu.Lock()
	recording := w.active
	if recording == nil || recording.ID != recordingID {
		w.mu.Unlock()
		return Recording{}, ErrRecordingNotFound
	}
	if !IsRecordingActive(recording.Status) &&
		recording.Status != RecordingStatusCanceled {
		result := cloneRecording(recording)
		w.mu.Unlock()
		return result, nil
	}
	rootID := recording.RootAgentSessionID
	if recording.Status != RecordingStatusCanceled {
		if err := TransitionRecording(recording, RecordingTransition{
			Status:   RecordingStatusCanceled,
			AtUnixMS: w.now().UnixMilli(),
		}); err != nil {
			w.mu.Unlock()
			return Recording{}, err
		}
	}
	result := cloneRecording(recording)
	w.mu.Unlock()
	if rootID != "" {
		_ = w.Transport.Cancel(rootID)
	}
	if err := w.Artifacts.DiscardRecording(ctx, recordingID); err != nil {
		return Recording{}, fmt.Errorf("discard canceled recording: %w", err)
	}
	if err := w.Store.DeleteRecording(ctx, recordingID); err != nil {
		return Recording{}, fmt.Errorf("delete canceled recording metadata: %w", err)
	}
	return result, nil
}

func (w *Workflow) Get(ctx context.Context, recordingID string) (Recording, error) {
	recordingID = strings.TrimSpace(recordingID)
	w.mu.Lock()
	if w.active != nil && w.active.ID == recordingID {
		result := cloneRecording(w.active)
		w.mu.Unlock()
		return result, nil
	}
	w.mu.Unlock()
	if recordingID == "" {
		return Recording{}, ErrRecordingNotFound
	}
	recording, err := w.Store.GetRecording(ctx, recordingID)
	if err != nil {
		return Recording{}, err
	}
	return w.hydrateRecording(ctx, recording)
}

func (w *Workflow) Rename(
	ctx context.Context,
	recordingID string,
	name string,
) (Recording, error) {
	name, err := NormalizeRecordingName(name)
	if err != nil {
		return Recording{}, err
	}
	recording, err := w.Get(ctx, recordingID)
	if err != nil {
		return Recording{}, err
	}
	if recording.Status != RecordingStatusComplete ||
		strings.TrimSpace(recording.CassetteID) == "" {
		return Recording{}, ErrInvalidState
	}
	cassette, err := w.Store.GetCassette(ctx, recording.CassetteID)
	if err != nil {
		return Recording{}, err
	}
	previousName := cassette.Name
	artifact, err := w.Artifacts.RenameCassette(ctx, cassette, name)
	if err != nil {
		return Recording{}, err
	}
	recording.Name = name
	recording.ArtifactKey = artifact.Layout.StorageKey
	recording.UpdatedAtUnixMS = w.now().UnixMilli()
	if err := w.Store.UpdateCassette(ctx, recording, artifact.Cassette); err != nil {
		_, rollbackErr := w.Artifacts.RenameCassette(ctx, artifact.Cassette, previousName)
		return Recording{}, errors.Join(err, rollbackErr)
	}
	w.mu.Lock()
	if w.active != nil && w.active.ID == recording.ID {
		*w.active = recording
	}
	w.mu.Unlock()
	return recording, nil
}

func (w *Workflow) List(ctx context.Context, scopeID string) ([]Recording, error) {
	recordings, err := w.Store.ListRecordings(ctx, strings.TrimSpace(scopeID))
	if err != nil {
		return nil, err
	}
	for index := range recordings {
		recordings[index], err = w.hydrateRecording(ctx, recordings[index])
		if err != nil {
			return nil, err
		}
	}
	return recordings, nil
}

func (w *Workflow) Recover(ctx context.Context) error {
	recordings, err := w.Store.ListRecordings(ctx, "")
	if err != nil {
		return err
	}
	for index := range recordings {
		recording := &recordings[index]
		if !IsRecordingActive(recording.Status) {
			continue
		}
		if err := TransitionRecording(recording, RecordingTransition{
			Status:       RecordingStatusIncomplete,
			AtUnixMS:     w.now().UnixMilli(),
			ErrorCode:    "daemon_restarted",
			ErrorMessage: "Recording was interrupted by a daemon restart.",
		}); err != nil {
			return err
		}
		_ = w.Artifacts.DiscardRecording(ctx, recording.ID)
		if err := w.Store.PutRecording(ctx, *recording); err != nil {
			return err
		}
	}
	runs, err := w.Store.ListReplayRuns(ctx, "")
	if err != nil {
		return err
	}
	for index := range runs {
		run := &runs[index]
		if run.Status != ReplayRunStatusStarting &&
			run.Status != ReplayRunStatusRunning {
			continue
		}
		if err := TransitionReplayRun(run, ReplayRunTransition{
			Status:       ReplayRunStatusFailed,
			AtUnixMS:     w.now().UnixMilli(),
			Checkpoint:   run.Checkpoint,
			ErrorCode:    "daemon_restarted",
			ErrorMessage: "Replay was interrupted by a daemon restart.",
		}); err != nil {
			return err
		}
		if err := w.Store.PutReplayRun(ctx, *run); err != nil {
			return err
		}
	}
	return nil
}

func (w *Workflow) hydrateRecording(ctx context.Context, recording Recording) (Recording, error) {
	layout, err := w.Artifacts.LocateRecording(ctx, recording)
	if err != nil {
		return Recording{}, err
	}
	recording.ArtifactKey = layout.StorageKey
	return recording, nil
}

func (w *Workflow) transitionAndPersist(
	ctx context.Context,
	recording *Recording,
	transition RecordingTransition,
) error {
	w.mu.Lock()
	err := TransitionRecording(recording, transition)
	result := cloneRecording(recording)
	w.mu.Unlock()
	if err != nil {
		return err
	}
	return w.Store.PutRecording(ctx, result)
}

func (w *Workflow) fail(
	ctx context.Context,
	recordingID string,
	code string,
	cause error,
) (Recording, error) {
	w.mu.Lock()
	recording := w.active
	if recording == nil || recording.ID != recordingID {
		w.mu.Unlock()
		return Recording{}, cause
	}
	if err := TransitionRecording(recording, RecordingTransition{
		Status:       RecordingStatusFailed,
		AtUnixMS:     w.now().UnixMilli(),
		ErrorCode:    code,
		ErrorMessage: cause.Error(),
	}); err != nil {
		w.mu.Unlock()
		return Recording{}, errors.Join(cause, err)
	}
	result := cloneRecording(recording)
	w.mu.Unlock()
	_ = w.Store.PutRecording(ctx, result)
	return result, cause
}

func (w *Workflow) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func cloneRecording(recording *Recording) Recording {
	if recording == nil {
		return Recording{}
	}
	return *recording
}
