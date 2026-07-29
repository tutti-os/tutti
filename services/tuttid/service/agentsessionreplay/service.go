package agentsessionreplay

import (
	"context"
	"errors"
	"strings"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

type Service struct {
	Workflow *replay.Workflow
}

func (s *Service) Start(ctx context.Context, input StartInput) (Recording, error) {
	if strings.TrimSpace(input.AgentTargetID) != "local:codex" {
		return Recording{}, ErrUnsupportedTarget
	}
	if s == nil || s.Workflow == nil {
		return Recording{}, errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Start(ctx, replay.StartRecordingInput{
		ScopeID:        strings.TrimSpace(input.WorkspaceID),
		AgentTargetID:  strings.TrimSpace(input.AgentTargetID),
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
	})
}

func (s *Service) Bind(ctx context.Context, input BindInput) (Recording, error) {
	if s == nil || s.Workflow == nil {
		return Recording{}, errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Bind(ctx, replay.BindRecordingInput{
		RecordingID:    strings.TrimSpace(input.RecordingID),
		ScopeID:        strings.TrimSpace(input.WorkspaceID),
		AgentTargetID:  strings.TrimSpace(input.AgentTargetID),
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
	})
}

func (s *Service) RecordActivityEvent(ctx context.Context, input ActivityEvent) error {
	if s == nil || s.Workflow == nil {
		return errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.RecordActivityEvent(ctx, sharedActivityEvent(input))
}

func (s *Service) RecordActivityEvents(
	ctx context.Context,
	inputs []ActivityEvent,
) (uint64, error) {
	if s == nil || s.Workflow == nil {
		return 0, errors.New("agent session recording service is unavailable")
	}
	events := make([]replay.ActivityEvent, 0, len(inputs))
	for _, input := range inputs {
		events = append(events, sharedActivityEvent(input))
	}
	return s.Workflow.RecordActivityEvents(ctx, events)
}

func sharedActivityEvent(input ActivityEvent) replay.ActivityEvent {
	return replay.ActivityEvent{
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

func (s *Service) Recover(ctx context.Context) error {
	if s == nil || s.Workflow == nil {
		return errors.New("agent session recording service is unavailable")
	}
	return s.Workflow.Recover(ctx)
}

func (s *Service) PrepareReplayRun(
	ctx context.Context,
	cassetteID string,
) (replay.ReplayRequest, error) {
	if s == nil || s.Workflow == nil {
		return replay.ReplayRequest{}, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.PrepareReplayRun(ctx, cassetteID)
}

func (s *Service) ListReplayRuns(
	ctx context.Context,
	cassetteID string,
) ([]ReplayRun, error) {
	if s == nil || s.Workflow == nil {
		return nil, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.ListReplayRuns(ctx, strings.TrimSpace(cassetteID))
}

func (s *Service) GetReplayRun(ctx context.Context, runID string) (ReplayRun, error) {
	if s == nil || s.Workflow == nil {
		return ReplayRun{}, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.GetReplayRun(ctx, runID)
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

func (s *Service) MarkReplayRunRunning(
	ctx context.Context,
	runID string,
) (ReplayRun, error) {
	if s == nil || s.Workflow == nil {
		return ReplayRun{}, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.MarkReplayRunRunning(ctx, runID)
}

func (s *Service) AdvanceReplayRunCheckpoint(
	ctx context.Context,
	runID string,
	checkpoint int64,
) (ReplayRun, error) {
	if s == nil || s.Workflow == nil {
		return ReplayRun{}, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.AdvanceReplayRunCheckpoint(ctx, runID, checkpoint)
}

func (s *Service) CancelReplayRun(ctx context.Context, runID string) (ReplayRun, error) {
	if s == nil || s.Workflow == nil {
		return ReplayRun{}, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.CancelReplayRun(ctx, runID)
}

func (s *Service) CompleteReplayRun(
	ctx context.Context,
	runID string,
	checkpoint int64,
) (ReplayRun, error) {
	if s == nil || s.Workflow == nil {
		return ReplayRun{}, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.CompleteReplayRun(ctx, runID, checkpoint)
}

func (s *Service) FailReplayRun(
	ctx context.Context,
	runID string,
	checkpoint int64,
	code string,
	cause error,
) (ReplayRun, error) {
	if s == nil || s.Workflow == nil {
		return ReplayRun{}, errors.New("agent session replay service is unavailable")
	}
	return s.Workflow.FailReplayRun(ctx, runID, checkpoint, code, cause)
}
