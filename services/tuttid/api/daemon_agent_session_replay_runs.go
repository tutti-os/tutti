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

type AgentSessionReplayVerifier interface {
	Verify(context.Context) error
	PlaybackState(context.Context) (AgentSessionReplayPlaybackState, error)
	SetPlaybackSpeed(context.Context, float64) (AgentSessionReplayPlaybackState, error)
	SetPlaybackPaused(context.Context, bool) (AgentSessionReplayPlaybackState, error)
	SetPlaybackFastForward(context.Context, bool) (AgentSessionReplayPlaybackState, error)
}

type AgentSessionReplayPlaybackState struct {
	Speed             float64
	PlaybackElapsedMS float64
	Drained           bool
	Paused            bool
	FastForward       bool
}

func (api DaemonAPI) VerifyAgentSessionReplayTransport(
	ctx context.Context,
	_ tuttigenerated.VerifyAgentSessionReplayTransportRequestObject,
) (tuttigenerated.VerifyAgentSessionReplayTransportResponseObject, error) {
	if api.AgentSessionReplayVerifier == nil {
		return tuttigenerated.VerifyAgentSessionReplayTransport503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("agent_session_replay_verifier_unavailable"),
			),
		}, nil
	}
	if err := api.AgentSessionReplayVerifier.Verify(ctx); err != nil {
		return tuttigenerated.VerifyAgentSessionReplayTransport409JSONResponse(
			agentSessionRecordingError("agent_session_replay_transport_mismatch", err),
		), nil
	}
	return tuttigenerated.VerifyAgentSessionReplayTransport204Response{}, nil
}

func (api DaemonAPI) GetAgentSessionReplayTransportPlayback(
	ctx context.Context,
	_ tuttigenerated.GetAgentSessionReplayTransportPlaybackRequestObject,
) (tuttigenerated.GetAgentSessionReplayTransportPlaybackResponseObject, error) {
	if api.AgentSessionReplayVerifier == nil {
		return agentSessionReplayPlaybackUnavailable(), nil
	}
	state, err := api.AgentSessionReplayVerifier.PlaybackState(ctx)
	if err != nil {
		return agentSessionReplayPlaybackUnavailable(), nil
	}
	return tuttigenerated.GetAgentSessionReplayTransportPlayback200JSONResponse(
		generatedAgentSessionReplayTransportPlayback(state),
	), nil
}

func (api DaemonAPI) UpdateAgentSessionReplayTransportPlayback(
	ctx context.Context,
	request tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestObject,
) (tuttigenerated.UpdateAgentSessionReplayTransportPlaybackResponseObject, error) {
	if !validAgentSessionReplayPlaybackCommand(request.Body) {
		return tuttigenerated.UpdateAgentSessionReplayTransportPlayback400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.MalformedRequest()),
		}, nil
	}
	if api.AgentSessionReplayVerifier == nil {
		return agentSessionReplayPlaybackUpdateUnavailable(), nil
	}
	var (
		state AgentSessionReplayPlaybackState
		err   error
	)
	switch request.Body.Command {
	case tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandSetSpeed:
		state, err = api.AgentSessionReplayVerifier.SetPlaybackSpeed(ctx, float64(*request.Body.Speed))
	case tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandPause:
		state, err = api.AgentSessionReplayVerifier.SetPlaybackPaused(ctx, true)
	case tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandResume:
		state, err = api.AgentSessionReplayVerifier.SetPlaybackPaused(ctx, false)
	case tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandSetTimingMode:
		state, err = api.AgentSessionReplayVerifier.SetPlaybackFastForward(
			ctx,
			*request.Body.TimingMode ==
				tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestTimingModeFastForward,
		)
	}
	if err != nil {
		return agentSessionReplayPlaybackUpdateUnavailable(), nil
	}
	return tuttigenerated.UpdateAgentSessionReplayTransportPlayback200JSONResponse(
		generatedAgentSessionReplayTransportPlayback(state),
	), nil
}

func validAgentSessionReplayPlaybackCommand(
	body *tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequest,
) bool {
	if body == nil || !body.Command.Valid() {
		return false
	}
	switch body.Command {
	case tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandSetSpeed:
		return body.Speed != nil && body.Speed.Valid() && body.TimingMode == nil
	case tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandPause,
		tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandResume:
		return body.Speed == nil && body.TimingMode == nil
	case tuttigenerated.UpdateAgentSessionReplayTransportPlaybackRequestCommandSetTimingMode:
		return body.Speed == nil && body.TimingMode != nil && body.TimingMode.Valid()
	default:
		return false
	}
}

func generatedAgentSessionReplayTransportPlayback(
	state AgentSessionReplayPlaybackState,
) tuttigenerated.AgentSessionReplayTransportPlayback {
	timingMode := tuttigenerated.AgentSessionReplayTransportPlaybackTimingModeRealtime
	if state.FastForward {
		timingMode = tuttigenerated.AgentSessionReplayTransportPlaybackTimingModeFastForward
	}
	return tuttigenerated.AgentSessionReplayTransportPlayback{
		Drained:           state.Drained,
		Paused:            state.Paused,
		PlaybackElapsedMs: state.PlaybackElapsedMS,
		Speed:             tuttigenerated.AgentSessionReplayTransportPlaybackSpeed(state.Speed),
		TimingMode:        timingMode,
	}
}

func agentSessionReplayPlaybackUnavailable() tuttigenerated.GetAgentSessionReplayTransportPlayback503JSONResponse {
	return tuttigenerated.GetAgentSessionReplayTransportPlayback503JSONResponse{
		ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
			apierrors.ServiceUnavailable("agent_session_replay_playback_unavailable"),
		),
	}
}

func agentSessionReplayPlaybackUpdateUnavailable() tuttigenerated.UpdateAgentSessionReplayTransportPlayback503JSONResponse {
	return tuttigenerated.UpdateAgentSessionReplayTransportPlayback503JSONResponse{
		ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
			apierrors.ServiceUnavailable("agent_session_replay_playback_unavailable"),
		),
	}
}

func (api DaemonAPI) PrepareAgentSessionReplayRun(
	ctx context.Context,
	request tuttigenerated.PrepareAgentSessionReplayRunRequestObject,
) (tuttigenerated.PrepareAgentSessionReplayRunResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.PrepareAgentSessionReplayRun503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	prepared, err := api.AgentSessionRecordingService.PrepareReplayRun(
		ctx,
		request.CassetteID.String(),
	)
	if err != nil {
		if errors.Is(err, agentsessionreplay.ErrCassetteNotFound) {
			return tuttigenerated.PrepareAgentSessionReplayRun404JSONResponse(
				agentSessionRecordingError("agent_session_cassette_not_found", err),
			), nil
		}
		return tuttigenerated.PrepareAgentSessionReplayRun409JSONResponse(
			agentSessionRecordingError("agent_session_cassette_invalid", err),
		), nil
	}
	if prepared.Artifact.Cassette.ScopeID != string(request.WorkspaceID) {
		return tuttigenerated.PrepareAgentSessionReplayRun404JSONResponse(
			agentSessionRecordingError(
				"agent_session_cassette_not_found",
				agentsessionreplay.ErrCassetteNotFound,
			),
		), nil
	}
	run, err := generatedAgentSessionReplayRun(prepared.Run)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.PrepareAgentSessionReplayRun201JSONResponse{
		Run:               run,
		CassetteDirectory: prepared.Artifact.Layout.StorageKey,
	}, nil
}

func (api DaemonAPI) ListAgentSessionCassettes(
	ctx context.Context,
	request tuttigenerated.ListAgentSessionCassettesRequestObject,
) (tuttigenerated.ListAgentSessionCassettesResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.ListAgentSessionCassettes503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	cassettes, err := api.AgentSessionRecordingService.ListCassettes(
		ctx,
		string(request.WorkspaceID),
	)
	if err != nil {
		return tuttigenerated.ListAgentSessionCassettes503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_session_cassette_list_failed",
					apierrors.WithCause(err),
				),
			),
		}, nil
	}
	generated := make([]tuttigenerated.AgentSessionCassette, 0, len(cassettes))
	for _, cassette := range cassettes {
		item, generateErr := generatedAgentSessionCassette(cassette)
		if generateErr != nil {
			return nil, generateErr
		}
		generated = append(generated, item)
	}
	return tuttigenerated.ListAgentSessionCassettes200JSONResponse{
		Cassettes: generated,
	}, nil
}

func (api DaemonAPI) ListAgentSessionReplayRuns(
	ctx context.Context,
	request tuttigenerated.ListAgentSessionReplayRunsRequestObject,
) (tuttigenerated.ListAgentSessionReplayRunsResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.ListAgentSessionReplayRuns503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	cassette, err := api.AgentSessionRecordingService.GetCassette(
		ctx,
		request.CassetteID.String(),
	)
	if err != nil || cassette.ScopeID != string(request.WorkspaceID) {
		return tuttigenerated.ListAgentSessionReplayRuns404JSONResponse(
			agentSessionRecordingError(
				"agent_session_cassette_not_found",
				agentsessionreplay.ErrCassetteNotFound,
			),
		), nil
	}
	runs, err := api.AgentSessionRecordingService.ListReplayRuns(ctx, cassette.ID)
	if err != nil {
		return tuttigenerated.ListAgentSessionReplayRuns503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable(
					"agent_session_replay_run_list_failed",
					apierrors.WithCause(err),
				),
			),
		}, nil
	}
	generated := make([]tuttigenerated.AgentSessionReplayRun, 0, len(runs))
	for _, run := range runs {
		item, generateErr := generatedAgentSessionReplayRun(run)
		if generateErr != nil {
			return nil, generateErr
		}
		generated = append(generated, item)
	}
	return tuttigenerated.ListAgentSessionReplayRuns200JSONResponse{Runs: generated}, nil
}

func (api DaemonAPI) MarkAgentSessionReplayRunRunning(
	ctx context.Context,
	request tuttigenerated.MarkAgentSessionReplayRunRunningRequestObject,
) (tuttigenerated.MarkAgentSessionReplayRunRunningResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.MarkAgentSessionReplayRunRunning503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	if _, err := api.replayRunForWorkspace(ctx, request.RunID.String(), string(request.WorkspaceID)); err != nil {
		return tuttigenerated.MarkAgentSessionReplayRunRunning404JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_found", err),
		), nil
	}
	run, err := api.AgentSessionRecordingService.MarkReplayRunRunning(ctx, request.RunID.String())
	if err != nil {
		return tuttigenerated.MarkAgentSessionReplayRunRunning409JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_startable", err),
		), nil
	}
	generated, err := generatedAgentSessionReplayRun(run)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.MarkAgentSessionReplayRunRunning200JSONResponse(generated), nil
}

func (api DaemonAPI) AdvanceAgentSessionReplayRunCheckpoint(
	ctx context.Context,
	request tuttigenerated.AdvanceAgentSessionReplayRunCheckpointRequestObject,
) (tuttigenerated.AdvanceAgentSessionReplayRunCheckpointResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.AdvanceAgentSessionReplayRunCheckpoint503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	if request.Body == nil || request.Body.Checkpoint < 0 {
		return tuttigenerated.AdvanceAgentSessionReplayRunCheckpoint400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.MalformedRequest()),
		}, nil
	}
	if _, err := api.replayRunForWorkspace(
		ctx,
		request.RunID.String(),
		string(request.WorkspaceID),
	); err != nil {
		return tuttigenerated.AdvanceAgentSessionReplayRunCheckpoint404JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_found", err),
		), nil
	}
	run, err := api.AgentSessionRecordingService.AdvanceReplayRunCheckpoint(
		ctx,
		request.RunID.String(),
		request.Body.Checkpoint,
	)
	if err != nil {
		return tuttigenerated.AdvanceAgentSessionReplayRunCheckpoint409JSONResponse(
			agentSessionRecordingError("agent_session_replay_checkpoint_not_advanceable", err),
		), nil
	}
	generated, err := generatedAgentSessionReplayRun(run)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.AdvanceAgentSessionReplayRunCheckpoint200JSONResponse(generated), nil
}

func (api DaemonAPI) CancelAgentSessionReplayRun(
	ctx context.Context,
	request tuttigenerated.CancelAgentSessionReplayRunRequestObject,
) (tuttigenerated.CancelAgentSessionReplayRunResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.CancelAgentSessionReplayRun503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	if _, err := api.replayRunForWorkspace(
		ctx,
		request.RunID.String(),
		string(request.WorkspaceID),
	); err != nil {
		return tuttigenerated.CancelAgentSessionReplayRun404JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_found", err),
		), nil
	}
	run, err := api.AgentSessionRecordingService.CancelReplayRun(ctx, request.RunID.String())
	if err != nil {
		return tuttigenerated.CancelAgentSessionReplayRun409JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_cancelable", err),
		), nil
	}
	generated, err := generatedAgentSessionReplayRun(run)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.CancelAgentSessionReplayRun200JSONResponse(generated), nil
}

func (api DaemonAPI) CompleteAgentSessionReplayRun(
	ctx context.Context,
	request tuttigenerated.CompleteAgentSessionReplayRunRequestObject,
) (tuttigenerated.CompleteAgentSessionReplayRunResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.CompleteAgentSessionReplayRun503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	run, err := api.replayRunForWorkspace(ctx, request.RunID.String(), string(request.WorkspaceID))
	if err != nil {
		return tuttigenerated.CompleteAgentSessionReplayRun404JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_found", err),
		), nil
	}
	run, err = api.AgentSessionRecordingService.CompleteReplayRun(ctx, run.ID, run.Checkpoint)
	if err != nil {
		return tuttigenerated.CompleteAgentSessionReplayRun409JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_completable", err),
		), nil
	}
	generated, err := generatedAgentSessionReplayRun(run)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.CompleteAgentSessionReplayRun200JSONResponse(generated), nil
}

func (api DaemonAPI) FailAgentSessionReplayRun(
	ctx context.Context,
	request tuttigenerated.FailAgentSessionReplayRunRequestObject,
) (tuttigenerated.FailAgentSessionReplayRunResponseObject, error) {
	if api.AgentSessionRecordingService == nil {
		return tuttigenerated.FailAgentSessionReplayRun503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionRecordingUnavailableError(),
		}, nil
	}
	if request.Body == nil ||
		strings.TrimSpace(request.Body.ErrorCode) == "" ||
		strings.TrimSpace(request.Body.ErrorMessage) == "" {
		return tuttigenerated.FailAgentSessionReplayRun400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(),
			),
		}, nil
	}
	run, err := api.replayRunForWorkspace(ctx, request.RunID.String(), string(request.WorkspaceID))
	if err != nil {
		return tuttigenerated.FailAgentSessionReplayRun404JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_found", err),
		), nil
	}
	checkpoint := run.Checkpoint
	if request.Body.Checkpoint != nil {
		checkpoint = *request.Body.Checkpoint
	}
	run, err = api.AgentSessionRecordingService.FailReplayRun(
		ctx,
		run.ID,
		checkpoint,
		request.Body.ErrorCode,
		errors.New(request.Body.ErrorMessage),
	)
	if err != nil {
		return tuttigenerated.FailAgentSessionReplayRun409JSONResponse(
			agentSessionRecordingError("agent_session_replay_run_not_failable", err),
		), nil
	}
	generated, err := generatedAgentSessionReplayRun(run)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.FailAgentSessionReplayRun200JSONResponse(generated), nil
}

func (api DaemonAPI) replayRunForWorkspace(
	ctx context.Context,
	runID string,
	workspaceID string,
) (agentsessionreplay.ReplayRun, error) {
	run, err := api.AgentSessionRecordingService.GetReplayRun(ctx, runID)
	if err != nil {
		return agentsessionreplay.ReplayRun{}, err
	}
	cassette, err := api.AgentSessionRecordingService.GetCassette(ctx, run.CassetteID)
	if err != nil || cassette.ScopeID != workspaceID {
		return agentsessionreplay.ReplayRun{}, agentsessionreplay.ErrReplayRunNotFound
	}
	return run, nil
}

func generatedAgentSessionCassette(
	cassette agentsessionreplay.Cassette,
) (tuttigenerated.AgentSessionCassette, error) {
	id, err := uuid.Parse(cassette.ID)
	if err != nil {
		return tuttigenerated.AgentSessionCassette{}, err
	}
	sourceRecordingID, err := uuid.Parse(cassette.SourceRecordingID)
	if err != nil {
		return tuttigenerated.AgentSessionCassette{}, err
	}
	return tuttigenerated.AgentSessionCassette{
		Id:                 id,
		Name:               cassette.Name,
		SourceRecordingId:  sourceRecordingID,
		WorkspaceId:        cassette.ScopeID,
		AgentTargetId:      cassette.AgentTargetID,
		RootAgentSessionId: cassette.RootAgentSessionID,
		Mode:               tuttigenerated.AgentSessionCassetteMode(cassette.Mode),
		TotalBytes:         cassette.TotalBytes,
		CreatedAtUnixMs:    cassette.CreatedAtUnixMS,
	}, nil
}

func generatedAgentSessionReplayRun(
	run agentsessionreplay.ReplayRun,
) (tuttigenerated.AgentSessionReplayRun, error) {
	id, err := uuid.Parse(run.ID)
	if err != nil {
		return tuttigenerated.AgentSessionReplayRun{}, err
	}
	cassetteID, err := uuid.Parse(run.CassetteID)
	if err != nil {
		return tuttigenerated.AgentSessionReplayRun{}, err
	}
	result := tuttigenerated.AgentSessionReplayRun{
		Id:              id,
		CassetteId:      cassetteID,
		Status:          tuttigenerated.AgentSessionReplayRunStatus(run.Status),
		Checkpoint:      run.Checkpoint,
		CreatedAtUnixMs: run.CreatedAtUnixMS,
		UpdatedAtUnixMs: run.UpdatedAtUnixMS,
	}
	if run.StartedAtUnixMS > 0 {
		result.StartedAtUnixMs = &run.StartedAtUnixMS
	}
	if run.CompletedAtUnixMS > 0 {
		result.CompletedAtUnixMs = &run.CompletedAtUnixMS
	}
	if run.ErrorCode != "" {
		result.ErrorCode = &run.ErrorCode
	}
	if run.ErrorMessage != "" {
		result.ErrorMessage = &run.ErrorMessage
	}
	return result, nil
}
