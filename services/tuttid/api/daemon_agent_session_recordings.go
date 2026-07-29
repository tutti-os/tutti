package api

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentsessionreplay "github.com/tutti-os/tutti/services/tuttid/service/agentsessionreplay"
)

type AgentSessionRecordingService interface {
	Start(context.Context, agentsessionreplay.StartInput) (agentsessionreplay.Recording, error)
	List(context.Context, string) ([]agentsessionreplay.Recording, error)
	Get(context.Context, string) (agentsessionreplay.Recording, error)
	Rename(context.Context, string, string) (agentsessionreplay.Recording, error)
	Complete(context.Context, string) (agentsessionreplay.Recording, error)
	Cancel(context.Context, string) (agentsessionreplay.Recording, error)
	Bind(context.Context, agentsessionreplay.BindInput) (agentsessionreplay.Recording, error)
	RecordActivityEvent(context.Context, agentsessionreplay.ActivityEvent) error
	RecordActivityEvents(context.Context, []agentsessionreplay.ActivityEvent) (uint64, error)
	PrepareReplayRun(context.Context, string) (agentsessionreplay.ReplayRequest, error)
	ListReplayRuns(context.Context, string) ([]agentsessionreplay.ReplayRun, error)
	GetReplayRun(context.Context, string) (agentsessionreplay.ReplayRun, error)
	GetCassette(context.Context, string) (agentsessionreplay.Cassette, error)
	ListCassettes(context.Context, string) ([]agentsessionreplay.Cassette, error)
	MarkReplayRunRunning(context.Context, string) (agentsessionreplay.ReplayRun, error)
	AdvanceReplayRunCheckpoint(context.Context, string, int64) (agentsessionreplay.ReplayRun, error)
	CancelReplayRun(context.Context, string) (agentsessionreplay.ReplayRun, error)
	CompleteReplayRun(context.Context, string, int64) (agentsessionreplay.ReplayRun, error)
	FailReplayRun(context.Context, string, int64, string, error) (agentsessionreplay.ReplayRun, error)
}

func (api DaemonAPI) ListAgentSessionRecordings(
	ctx context.Context,
	request tuttigenerated.ListAgentSessionRecordingsRequestObject,
) (tuttigenerated.ListAgentSessionRecordingsResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.ListAgentSessionRecordings503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	recordings, err := api.AgentSessionRecordingService.List(ctx, string(request.WorkspaceID))
	if err != nil {
		return tuttigenerated.ListAgentSessionRecordings503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_session_recording_list_failed",
					apierrors.WithCause(err),
				),
			),
		}, nil
	}
	generated := make([]tuttigenerated.AgentSessionRecording, 0, len(recordings))
	for _, recording := range recordings {
		item, generateErr := generatedAgentSessionRecording(recording)
		if generateErr != nil {
			return nil, generateErr
		}
		generated = append(generated, item)
	}
	return tuttigenerated.ListAgentSessionRecordings200JSONResponse{
		Recordings: generated,
	}, nil
}

func (api DaemonAPI) StartAgentSessionRecording(
	ctx context.Context,
	request tuttigenerated.StartAgentSessionRecordingRequestObject,
) (tuttigenerated.StartAgentSessionRecordingResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.StartAgentSessionRecording503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.StartAgentSessionRecording400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}
	recording, err := api.AgentSessionRecordingService.Start(ctx, agentsessionreplay.StartInput{
		WorkspaceID:    string(request.WorkspaceID),
		AgentTargetID:  request.Body.AgentTargetId,
		AgentSessionID: stringPtrValue(request.Body.AgentSessionId),
	})
	if err != nil {
		switch {
		case errors.Is(err, agentsessionreplay.ErrBusy):
			return tuttigenerated.StartAgentSessionRecording409JSONResponse(
				agentSessionRecordingError("agent_session_recording_busy", err),
			), nil
		case errors.Is(err, agentsessionreplay.ErrUnsupportedTarget),
			errors.Is(err, agentsessionreplay.ErrInvalidState):
			return tuttigenerated.StartAgentSessionRecording400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.MalformedRequest(apierrors.WithCause(err)),
				),
			}, nil
		default:
			return tuttigenerated.StartAgentSessionRecording503JSONResponse{
				ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
					apierrors.ServiceUnavailable(
						"agent_session_recording_start_failed",
						apierrors.WithCause(err),
					),
				),
			}, nil
		}
	}
	generated, err := generatedAgentSessionRecording(recording)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.StartAgentSessionRecording201JSONResponse(generated), nil
}

func (api DaemonAPI) GetAgentSessionRecording(
	ctx context.Context,
	request tuttigenerated.GetAgentSessionRecordingRequestObject,
) (tuttigenerated.GetAgentSessionRecordingResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.GetAgentSessionRecording503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	recording, err := api.AgentSessionRecordingService.Get(ctx, request.RecordingID.String())
	if err != nil {
		return tuttigenerated.GetAgentSessionRecording404JSONResponse(
			agentSessionRecordingError("agent_session_recording_not_found", err),
		), nil
	}
	if recording.ScopeID != string(request.WorkspaceID) {
		return tuttigenerated.GetAgentSessionRecording404JSONResponse(
			agentSessionRecordingError("agent_session_recording_not_found", agentsessionreplay.ErrNotFound),
		), nil
	}
	generated, err := generatedAgentSessionRecording(recording)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.GetAgentSessionRecording200JSONResponse(generated), nil
}

func (api DaemonAPI) RenameAgentSessionRecording(
	ctx context.Context,
	request tuttigenerated.RenameAgentSessionRecordingRequestObject,
) (tuttigenerated.RenameAgentSessionRecordingResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.RenameAgentSessionRecording503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.RenameAgentSessionRecording400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}
	existing, err := api.AgentSessionRecordingService.Get(ctx, request.RecordingID.String())
	if err != nil || existing.ScopeID != string(request.WorkspaceID) {
		return tuttigenerated.RenameAgentSessionRecording404JSONResponse(
			agentSessionRecordingError("agent_session_recording_not_found", agentsessionreplay.ErrNotFound),
		), nil
	}
	recording, err := api.AgentSessionRecordingService.Rename(
		ctx,
		request.RecordingID.String(),
		request.Body.Name,
	)
	if err != nil {
		if errors.Is(err, agentsessionreplay.ErrInvalidName) ||
			errors.Is(err, agentsessionreplay.ErrInvalidState) {
			return tuttigenerated.RenameAgentSessionRecording400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.MalformedRequest(apierrors.WithCause(err)),
				),
			}, nil
		}
		return tuttigenerated.RenameAgentSessionRecording503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_session_recording_rename_failed",
					apierrors.WithCause(err),
				),
			),
		}, nil
	}
	generated, err := generatedAgentSessionRecording(recording)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.RenameAgentSessionRecording200JSONResponse(generated), nil
}

func (api DaemonAPI) CompleteAgentSessionRecording(
	ctx context.Context,
	request tuttigenerated.CompleteAgentSessionRecordingRequestObject,
) (tuttigenerated.CompleteAgentSessionRecordingResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.CompleteAgentSessionRecording503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	existing, err := api.AgentSessionRecordingService.Get(ctx, request.RecordingID.String())
	if err != nil || existing.ScopeID != string(request.WorkspaceID) {
		return tuttigenerated.CompleteAgentSessionRecording404JSONResponse(
			agentSessionRecordingError("agent_session_recording_not_found", agentsessionreplay.ErrNotFound),
		), nil
	}
	recording, err := api.AgentSessionRecordingService.Complete(ctx, request.RecordingID.String())
	if err != nil {
		if errors.Is(err, agentsessionreplay.ErrNotFound) {
			return tuttigenerated.CompleteAgentSessionRecording404JSONResponse(
				agentSessionRecordingError("agent_session_recording_not_found", err),
			), nil
		}
		return tuttigenerated.CompleteAgentSessionRecording409JSONResponse(
			agentSessionRecordingError("agent_session_recording_not_ready", err),
		), nil
	}
	generated, err := generatedAgentSessionRecording(recording)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.CompleteAgentSessionRecording200JSONResponse(generated), nil
}

func (api DaemonAPI) AppendAgentSessionRecordingActivityEvents(
	ctx context.Context,
	request tuttigenerated.AppendAgentSessionRecordingActivityEventsRequestObject,
) (tuttigenerated.AppendAgentSessionRecordingActivityEventsResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.AppendAgentSessionRecordingActivityEvents503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	if request.Body == nil || len(request.Body.Events) == 0 {
		return tuttigenerated.AppendAgentSessionRecordingActivityEvents400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("activity events are required")),
			),
		}, nil
	}
	existing, err := api.AgentSessionRecordingService.Get(ctx, request.RecordingID.String())
	if err != nil || existing.ScopeID != string(request.WorkspaceID) {
		return tuttigenerated.AppendAgentSessionRecordingActivityEvents404JSONResponse(
			agentSessionRecordingError("agent_session_recording_not_found", agentsessionreplay.ErrNotFound),
		), nil
	}
	if existing.Status != agentsessionreplay.StatusRecording {
		return tuttigenerated.AppendAgentSessionRecordingActivityEvents409JSONResponse(
			agentSessionRecordingError("agent_session_recording_not_ready", agentsessionreplay.ErrInvalidState),
		), nil
	}
	events := make([]agentsessionreplay.ActivityEvent, 0, len(request.Body.Events))
	for _, event := range request.Body.Events {
		events = append(events, agentsessionreplay.ActivityEvent{
			Kind:            replayActivityEventKind(event.Kind),
			Type:            event.Type,
			EventID:         event.EventId,
			CorrelationID:   stringPtrValue(event.CorrelationId),
			CausedByEventID: stringPtrValue(event.CausedByEventId),
			WorkspaceID:     string(request.WorkspaceID),
			AgentSessionID:  stringPtrValue(event.AgentSessionId),
			Payload:         optionalPayloadMap(event.Payload),
			OccurredAtMS:    event.OccurredAtUnixMs,
		})
	}
	acceptedThrough, err := api.AgentSessionRecordingService.RecordActivityEvents(ctx, events)
	if err != nil {
		if errors.Is(err, agentsessionreplay.ErrInvalidState) {
			return tuttigenerated.AppendAgentSessionRecordingActivityEvents409JSONResponse(
				agentSessionRecordingError("agent_session_recording_not_ready", err),
			), nil
		}
		return tuttigenerated.AppendAgentSessionRecordingActivityEvents400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.AppendAgentSessionRecordingActivityEvents200JSONResponse{
		AcceptedThroughSequence: int64(acceptedThrough),
	}, nil
}

func replayActivityEventKind(
	kind tuttigenerated.AgentSessionRecordingActivityEventInputKind,
) agentsessionreplay.ActivityEventKind {
	switch string(kind) {
	case string(agentsessionreplay.ActivityEventKindIntent):
		return agentsessionreplay.ActivityEventKindIntent
	case string(agentsessionreplay.ActivityEventKindEffect):
		return agentsessionreplay.ActivityEventKindEffect
	case string(agentsessionreplay.ActivityEventKindDirectStimulus):
		return agentsessionreplay.ActivityEventKindDirectStimulus
	default:
		return agentsessionreplay.ActivityEventKind(kind)
	}
}

func (api DaemonAPI) CancelAgentSessionRecording(
	ctx context.Context,
	request tuttigenerated.CancelAgentSessionRecordingRequestObject,
) (tuttigenerated.CancelAgentSessionRecordingResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.CancelAgentSessionRecording503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	existing, err := api.AgentSessionRecordingService.Get(ctx, request.RecordingID.String())
	if err != nil || existing.ScopeID != string(request.WorkspaceID) {
		return tuttigenerated.CancelAgentSessionRecording404JSONResponse(
			agentSessionRecordingError("agent_session_recording_not_found", agentsessionreplay.ErrNotFound),
		), nil
	}
	recording, err := api.AgentSessionRecordingService.Cancel(ctx, request.RecordingID.String())
	if err != nil {
		return tuttigenerated.CancelAgentSessionRecording503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("agent_session_recording_cancel_failed", apierrors.WithCause(err)),
			),
		}, nil
	}
	generated, err := generatedAgentSessionRecording(recording)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.CancelAgentSessionRecording200JSONResponse(generated), nil
}

func generatedAgentSessionRecording(
	recording agentsessionreplay.Recording,
) (tuttigenerated.AgentSessionRecording, error) {
	id, err := uuid.Parse(recording.ID)
	if err != nil {
		return tuttigenerated.AgentSessionRecording{}, err
	}
	result := tuttigenerated.AgentSessionRecording{
		Id:              id,
		Name:            recording.Name,
		WorkspaceId:     recording.ScopeID,
		AgentTargetId:   recording.AgentTargetID,
		Mode:            tuttigenerated.AgentSessionRecordingMode(recording.Mode),
		Status:          tuttigenerated.AgentSessionRecordingStatus(recording.Status),
		Directory:       recording.ArtifactKey,
		CreatedAtUnixMs: recording.CreatedAtUnixMS,
		UpdatedAtUnixMs: recording.UpdatedAtUnixMS,
	}
	if value := strings.TrimSpace(recording.RootAgentSessionID); value != "" {
		result.RootAgentSessionId = &value
	}
	if value := strings.TrimSpace(recording.CassetteID); value != "" {
		parsed, parseErr := uuid.Parse(value)
		if parseErr != nil {
			return tuttigenerated.AgentSessionRecording{}, parseErr
		}
		result.CassetteId = &parsed
	}
	if recording.ErrorCode != "" {
		result.ErrorCode = &recording.ErrorCode
	}
	if recording.ErrorMessage != "" {
		result.ErrorMessage = &recording.ErrorMessage
	}
	return result, nil
}

func agentSessionRecordingUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.ServiceUnavailable(
			"agent_session_recording_service_unavailable",
			apierrors.WithDeveloperMessage("agent session recording service is unavailable"),
		),
	)
}

func agentSessionRecordingError(code string, err error) tuttigenerated.ApiErrorResponse {
	return protocolErrorResponse(
		apierrors.New(
			409,
			tuttigenerated.ApiErrorDetailsCode(code),
			code,
			apierrors.WithCause(err),
		),
	)
}

func (api DaemonAPI) recordAgentStimulus(
	ctx context.Context,
	kind string,
	workspaceID string,
	agentSessionID string,
	payload map[string]any,
) {
	if api.AgentSessionRecordingService == nil {
		return
	}
	_ = api.AgentSessionRecordingService.RecordActivityEvent(ctx, agentsessionreplay.ActivityEvent{
		Kind:           agentsessionreplay.ActivityEventKindDirectStimulus,
		Type:           kind,
		EventID:        uuid.NewString(),
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Payload:        payload,
	})
}
