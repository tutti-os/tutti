package sessionreplay

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Service struct {
	Workflow    *Workflow
	checkpoints checkpointRecorder
}

func (s *Service) Start(ctx context.Context, input StartInput) (Recording, error) {
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if _, ok := FindProviderReplayByTarget(agentTargetID); !ok {
		return Recording{}, ErrUnsupportedTarget
	}
	if s == nil || s.Workflow == nil {
		return Recording{}, errors.New("agent session recording service is unavailable")
	}
	recording, err := s.Workflow.Start(ctx, StartRecordingInput{
		ScopeID:             strings.TrimSpace(input.WorkspaceID),
		AgentTargetID:       agentTargetID,
		AgentSessionID:      strings.TrimSpace(input.AgentSessionID),
		ReplayPrerequisites: input.ReplayPrerequisites,
	})
	if err == nil {
		if initializeErr := s.ensureCheckpointRecorder(
			recording,
		); initializeErr != nil {
			_, _ = s.Workflow.Cancel(ctx, recording.ID)
			return Recording{}, initializeErr
		}
	}
	return recording, err
}

func (s *Service) Bind(ctx context.Context, input BindInput) (Recording, error) {
	if s == nil || s.Workflow == nil {
		return Recording{}, errors.New("agent session recording service is unavailable")
	}
	recording, err := s.Workflow.Bind(ctx, BindRecordingInput{
		RecordingID:    strings.TrimSpace(input.RecordingID),
		ScopeID:        strings.TrimSpace(input.WorkspaceID),
		AgentTargetID:  strings.TrimSpace(input.AgentTargetID),
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
	})
	if err == nil {
		if initializeErr := s.ensureCheckpointRecorder(
			recording,
		); initializeErr != nil {
			_, _ = s.Workflow.Cancel(ctx, recording.ID)
			return Recording{}, initializeErr
		}
	}
	return recording, err
}

func (s *Service) ensureCheckpointRecorder(
	recording Recording,
) error {
	var initialState []byte
	if recording.Mode == ScenarioModeContinueSession {
		var found bool
		initialState, found =
			s.Workflow.InitialReplayStateSnapshot(recording.ID)
		if !found {
			return errors.New(
				"continue-session recording initial state is unavailable",
			)
		}
	}
	return s.checkpoints.ensureInitialized(recording, initialState)
}

func (s *Service) RecordActivityEvent(ctx context.Context, input RecordingActivityEvent) error {
	if s == nil || s.Workflow == nil {
		return errors.New("agent session recording service is unavailable")
	}
	event := sharedActivityEvent(input)
	if err := s.Workflow.RecordActivityEvent(ctx, event); err != nil {
		return err
	}
	snapshot, active := s.Workflow.RecordingCursorSnapshot()
	if !active {
		return nil
	}
	accepted, found := s.Workflow.AcceptedActivityEvent(event.EventID)
	if !found {
		return ErrInvalidState
	}
	return s.recordActivityBoundary(
		ctx,
		snapshot,
		[]ActivityEvent{accepted},
	)
}

func (s *Service) RecordActivityEvents(
	ctx context.Context,
	inputs []RecordingActivityEvent,
) (uint64, error) {
	if s == nil || s.Workflow == nil {
		return 0, errors.New("agent session recording service is unavailable")
	}
	events := make([]ActivityEvent, 0, len(inputs))
	for _, input := range inputs {
		events = append(events, sharedActivityEvent(input))
	}
	acceptedThrough, err := s.Workflow.RecordActivityEvents(ctx, events)
	if err != nil {
		return acceptedThrough, err
	}
	snapshot, active := s.Workflow.RecordingCursorSnapshot()
	if active {
		accepted := make([]ActivityEvent, 0, len(events))
		for _, event := range events {
			canonical, found :=
				s.Workflow.AcceptedActivityEvent(event.EventID)
			if !found {
				return acceptedThrough, ErrInvalidState
			}
			accepted = append(accepted, canonical)
		}
		err = s.recordActivityBoundary(ctx, snapshot, accepted)
	}
	return acceptedThrough, err
}

func sharedActivityEvent(input RecordingActivityEvent) ActivityEvent {
	return ActivityEvent{
		SchemaVersion:   input.SchemaVersion,
		Sequence:        input.Sequence,
		Kind:            input.Kind,
		Type:            input.Type,
		EventID:         input.EventID,
		CorrelationID:   input.CorrelationID,
		CausedByEventID: input.CausedByEventID,
		ScopeID:         input.WorkspaceID,
		AgentSessionID:  input.AgentSessionID,
		Payload:         input.Payload,
		OccurredAtMS:    input.OccurredAtMS,
	}
}

func (s *Service) Complete(ctx context.Context, recordingID string) (Recording, error) {
	if s == nil || s.Workflow == nil {
		return Recording{}, errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Complete(ctx, recordingID)
}

func (s *Service) Cancel(ctx context.Context, recordingID string) (Recording, error) {
	if s == nil || s.Workflow == nil {
		return Recording{}, errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Cancel(ctx, recordingID)
}

func (s *Service) Delete(ctx context.Context, recordingID string) error {
	if s == nil || s.Workflow == nil {
		return errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Delete(ctx, recordingID)
}

func (s *Service) Get(ctx context.Context, recordingID string) (Recording, error) {
	if s == nil || s.Workflow == nil {
		return Recording{}, errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Get(ctx, recordingID)
}

func (s *Service) Rename(ctx context.Context, recordingID, name string) (Recording, error) {
	if s == nil || s.Workflow == nil {
		return Recording{}, errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Rename(ctx, recordingID, name)
}

func (s *Service) List(ctx context.Context, workspaceID string) ([]Recording, error) {
	if s == nil || s.Workflow == nil {
		return nil, errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.List(ctx, workspaceID)
}

type cassetteImporter interface {
	Import(context.Context, string) (Artifact, error)
	DiscardCassette(context.Context, string) error
}

func (s *Service) Import(
	ctx context.Context,
	input ImportInput,
) (ImportResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if s == nil || s.Workflow == nil || s.Workflow.Store == nil || workspaceID == "" {
		return ImportResult{}, ErrInvalidImport
	}
	importer, ok := s.Workflow.Artifacts.(cassetteImporter)
	if !ok {
		return ImportResult{}, errors.New("agent session cassette import is unavailable")
	}
	if len(input.SourceDirectories) == 0 || len(input.SourceDirectories) > 100 {
		return ImportResult{}, ErrInvalidImport
	}
	seenDirectories := make(map[string]struct{}, len(input.SourceDirectories))
	result := ImportResult{
		Failures:   []ImportFailure{},
		Recordings: []Recording{},
	}
	fail := func(sourceDirectory, code string) {
		result.Failures = append(result.Failures, ImportFailure{
			Code:            code,
			SourceDirectory: sourceDirectory,
		})
	}
	for _, sourceDirectory := range input.SourceDirectories {
		sourceDirectory = strings.TrimSpace(sourceDirectory)
		if sourceDirectory == "" {
			fail(sourceDirectory, "invalid")
			continue
		}
		if _, exists := seenDirectories[sourceDirectory]; exists {
			fail(sourceDirectory, "invalid")
			continue
		}
		seenDirectories[sourceDirectory] = struct{}{}
		artifact, err := importer.Import(ctx, sourceDirectory)
		if err != nil {
			code := "invalid"
			if errors.Is(err, ErrInvalidState) {
				code = "conflict"
			}
			fail(sourceDirectory, code)
			continue
		}
		cassette := artifact.Cassette
		if !validImportedCassette(cassette) {
			_ = importer.DiscardCassette(ctx, cassette.ID)
			fail(sourceDirectory, "invalid")
			continue
		}
		if _, err := s.Workflow.Store.GetCassette(ctx, cassette.ID); err == nil {
			_ = importer.DiscardCassette(ctx, cassette.ID)
			fail(sourceDirectory, "conflict")
			continue
		} else if !errors.Is(err, ErrCassetteNotFound) {
			_ = importer.DiscardCassette(ctx, cassette.ID)
			fail(sourceDirectory, "failed")
			continue
		}
		if _, err := s.Workflow.Store.GetRecording(ctx, cassette.SourceRecordingID); err == nil {
			_ = importer.DiscardCassette(ctx, cassette.ID)
			fail(sourceDirectory, "conflict")
			continue
		} else if !errors.Is(err, ErrRecordingNotFound) {
			_ = importer.DiscardCassette(ctx, cassette.ID)
			fail(sourceDirectory, "failed")
			continue
		}
		now := time.Now().UTC()
		if s.Workflow.Now != nil {
			now = s.Workflow.Now().UTC()
		}
		recording := Recording{
			ID:                 cassette.SourceRecordingID,
			Name:               cassette.Name,
			CassetteID:         cassette.ID,
			ScopeID:            workspaceID,
			AgentTargetID:      cassette.AgentTargetID,
			Mode:               cassette.Mode,
			RootAgentSessionID: cassette.RootAgentSessionID,
			Status:             StatusComplete,
			ArtifactKey:        artifact.Layout.StorageKey,
			CreatedAtUnixMS:    cassette.CreatedAtUnixMS,
			RecordingAtUnixMS:  cassette.CreatedAtUnixMS,
			StoppedAtUnixMS:    cassette.CreatedAtUnixMS,
			UpdatedAtUnixMS:    now.UnixMilli(),
		}
		if err := s.Workflow.Store.PublishCassette(ctx, recording, cassette); err != nil {
			_ = importer.DiscardCassette(ctx, cassette.ID)
			fail(sourceDirectory, "failed")
			continue
		}
		result.Recordings = append(result.Recordings, recording)
	}
	return result, nil
}

func validImportedCassette(cassette Cassette) bool {
	if _, err := uuid.Parse(cassette.ID); err != nil {
		return false
	}
	if _, err := uuid.Parse(cassette.SourceRecordingID); err != nil {
		return false
	}
	_, supported := FindProviderReplayByTarget(cassette.AgentTargetID)
	return supported
}

func (s *Service) Recover(ctx context.Context) error {
	if s == nil || s.Workflow == nil {
		return errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Recover(ctx)
}

func (s *Service) PrepareReplayWorkspace(
	ctx context.Context,
	_ string,
	cassetteIDs []string,
) (ReplayWorkspaceRequest, error) {
	if s == nil || s.Workflow == nil {
		return ReplayWorkspaceRequest{}, errors.New("agent session replay service is unavailable")
	}
	prepared, err := s.Workflow.PrepareReplayBatch(ctx, PrepareReplayBatchInput{
		CassetteIDs: cassetteIDs,
	})
	if err != nil {
		return ReplayWorkspaceRequest{}, err
	}
	cassettes := make([]ReplayWorkspaceCassette, 0, len(prepared.Requests))
	for _, request := range prepared.Requests {
		cassettes = append(cassettes, ReplayWorkspaceCassette{
			Cassette: request.Artifact.Cassette,
			Layout:   request.Artifact.Layout,
		})
	}
	return ReplayWorkspaceRequest{
		Cassettes: cassettes,
	}, nil
}

func (s *Service) GetCassette(ctx context.Context, cassetteID string) (Cassette, error) {
	if s == nil || s.Workflow == nil {
		return Cassette{}, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.GetCassette(ctx, cassetteID)
}

func (s *Service) ListCassettes(ctx context.Context, workspaceID string) ([]Cassette, error) {
	if s == nil || s.Workflow == nil || s.Workflow.Store == nil {
		return nil, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.Store.ListCassettes(ctx, strings.TrimSpace(workspaceID))
}
