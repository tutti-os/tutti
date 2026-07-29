package api

import (
	"context"
	"errors"
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
)

type CollaborationRunService interface {
	StartConsult(ctx context.Context, input collabrunservice.StartConsultInput) (collabrunbiz.Run, error)
	RecordRun(ctx context.Context, input collabrunservice.RecordRunInput) (collabrunbiz.Run, error)
	SetAdoption(ctx context.Context, workspaceID string, runID string, adoption string) (collabrunbiz.Run, error)
	CancelConsult(ctx context.Context, workspaceID string, runID string) (collabrunbiz.Run, error)
	ListRuns(ctx context.Context, workspaceID string, sourceSessionID string, limit int) ([]collabrunbiz.Run, error)
}

func (api DaemonAPI) ListCollaborationRuns(ctx context.Context, request tuttigenerated.ListCollaborationRunsRequestObject) (tuttigenerated.ListCollaborationRunsResponseObject, error) {
	if api.CollaborationRunService == nil {
		return tuttigenerated.ListCollaborationRuns503JSONResponse{
			ServiceUnavailableErrorJSONResponse: collaborationRunServiceUnavailable(),
		}, nil
	}
	sourceSessionID := stringValue(request.Params.SourceSessionId)
	limit := 0
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	runs, err := api.CollaborationRunService.ListRuns(ctx, request.WorkspaceID, sourceSessionID, limit)
	if err != nil {
		return tuttigenerated.ListCollaborationRuns502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	response := tuttigenerated.ListCollaborationRunsResponse{Runs: make([]tuttigenerated.CollaborationRun, 0, len(runs))}
	for _, run := range runs {
		response.Runs = append(response.Runs, generatedCollaborationRun(run))
	}
	return tuttigenerated.ListCollaborationRuns200JSONResponse(response), nil
}

func (api DaemonAPI) CreateCollaborationRun(ctx context.Context, request tuttigenerated.CreateCollaborationRunRequestObject) (tuttigenerated.CreateCollaborationRunResponseObject, error) {
	if !api.automationRulesWritesEnabled(ctx) {
		return tuttigenerated.CreateCollaborationRun400JSONResponse{InvalidRequestErrorJSONResponse: automationRulesWriteDisabledError()}, nil
	}
	if api.CollaborationRunService == nil {
		return tuttigenerated.CreateCollaborationRun503JSONResponse{
			ServiceUnavailableErrorJSONResponse: collaborationRunServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateCollaborationRun400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	var run collabrunbiz.Run
	var err error
	if request.Body.Mode == tuttigenerated.Consult {
		maxTokens := 0
		if request.Body.MaxTokens != nil {
			maxTokens = *request.Body.MaxTokens
		}
		run, err = api.CollaborationRunService.StartConsult(ctx, collabrunservice.StartConsultInput{
			WorkspaceID:     request.WorkspaceID,
			SourceSessionID: stringValue(request.Body.SourceSessionId),
			ModelPlanID:     stringValue(request.Body.ModelPlanId),
			Model:           stringValue(request.Body.Model),
			Question:        stringValue(request.Body.Question),
			ContextText:     derefString(request.Body.ContextText),
			TriggerSource:   string(request.Body.TriggerSource),
			TriggerReason:   stringValue(request.Body.TriggerReason),
			MaxTokens:       maxTokens,
		})
	} else {
		run, err = api.CollaborationRunService.RecordRun(ctx, collabrunservice.RecordRunInput{
			WorkspaceID:         request.WorkspaceID,
			Mode:                string(request.Body.Mode),
			SourceSessionID:     stringValue(request.Body.SourceSessionId),
			TargetSessionID:     stringValue(request.Body.TargetSessionId),
			TargetAgentTargetID: stringValue(request.Body.TargetAgentTargetId),
			ModelPlanID:         stringValue(request.Body.ModelPlanId),
			Model:               stringValue(request.Body.Model),
			ContextScope:        stringValue(request.Body.ContextScope),
			TriggerSource:       string(request.Body.TriggerSource),
			TriggerReason:       stringValue(request.Body.TriggerReason),
		})
	}
	if err != nil {
		switch {
		case errors.Is(err, collabrunservice.ErrPlanNotUsable), errors.Is(err, workspacedata.ErrModelPlanNotFound):
			return tuttigenerated.CreateCollaborationRun404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: collaborationRunPlanNotFoundError(),
			}, nil
		case errors.Is(err, collabrunservice.ErrConsultLimitReached):
			return tuttigenerated.CreateCollaborationRun400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("consult_limit_reached", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		case errors.Is(err, collabrunservice.ErrInvalidRunInput), errors.Is(err, collabrunservice.ErrModelNotInPlan):
			return tuttigenerated.CreateCollaborationRun400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_collaboration_run", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.CreateCollaborationRun502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.CreateCollaborationRun200JSONResponse(generatedCollaborationRun(run)), nil
}

func (api DaemonAPI) SetCollaborationRunAdoption(ctx context.Context, request tuttigenerated.SetCollaborationRunAdoptionRequestObject) (tuttigenerated.SetCollaborationRunAdoptionResponseObject, error) {
	if !api.automationRulesWritesEnabled(ctx) {
		return tuttigenerated.SetCollaborationRunAdoption400JSONResponse{InvalidRequestErrorJSONResponse: automationRulesWriteDisabledError()}, nil
	}
	if api.CollaborationRunService == nil {
		return tuttigenerated.SetCollaborationRunAdoption503JSONResponse{
			ServiceUnavailableErrorJSONResponse: collaborationRunServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SetCollaborationRunAdoption400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	run, err := api.CollaborationRunService.SetAdoption(ctx, request.WorkspaceID, request.CollaborationRunID, string(request.Body.Adoption))
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrCollaborationRunNotFound):
			return tuttigenerated.SetCollaborationRunAdoption404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: collaborationRunNotFoundError(),
			}, nil
		case errors.Is(err, collabrunservice.ErrInvalidAdoption):
			return tuttigenerated.SetCollaborationRunAdoption400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_collaboration_run_adoption", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.SetCollaborationRunAdoption502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.SetCollaborationRunAdoption200JSONResponse(generatedCollaborationRun(run)), nil
}

func (api DaemonAPI) CancelCollaborationRun(ctx context.Context, request tuttigenerated.CancelCollaborationRunRequestObject) (tuttigenerated.CancelCollaborationRunResponseObject, error) {
	if !api.automationRulesWritesEnabled(ctx) {
		return tuttigenerated.CancelCollaborationRun400JSONResponse{InvalidRequestErrorJSONResponse: automationRulesWriteDisabledError()}, nil
	}
	if api.CollaborationRunService == nil {
		return tuttigenerated.CancelCollaborationRun503JSONResponse{
			ServiceUnavailableErrorJSONResponse: collaborationRunServiceUnavailable(),
		}, nil
	}
	run, err := api.CollaborationRunService.CancelConsult(ctx, request.WorkspaceID, request.CollaborationRunID)
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrCollaborationRunNotFound):
			return tuttigenerated.CancelCollaborationRun404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: collaborationRunNotFoundError(),
			}, nil
		case errors.Is(err, collabrunservice.ErrInvalidRunInput):
			return tuttigenerated.CancelCollaborationRun400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_collaboration_run_cancel", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.CancelCollaborationRun502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.CancelCollaborationRun200JSONResponse(generatedCollaborationRun(run)), nil
}

func generatedCollaborationRun(run collabrunbiz.Run) tuttigenerated.CollaborationRun {
	result := tuttigenerated.CollaborationRun{
		Id:            run.ID,
		WorkspaceId:   run.WorkspaceID,
		Mode:          tuttigenerated.CollaborationRunMode(run.Mode),
		TriggerSource: tuttigenerated.CollaborationRunTriggerSource(run.TriggerSource),
		Status:        tuttigenerated.CollaborationRunStatus(run.Status),
		Adoption:      tuttigenerated.CollaborationRunAdoption(run.Adoption),
		Usage: tuttigenerated.CollaborationRunUsage{
			InputTokens:  run.Usage.InputTokens,
			OutputTokens: run.Usage.OutputTokens,
		},
		DurationMs: run.DurationMs,
		CreatedAt:  run.CreatedAt,
		UpdatedAt:  run.UpdatedAt,
	}
	if run.TriggerReason != "" {
		result.TriggerReason = stringPointer(run.TriggerReason)
	}
	if run.SourceSessionID != "" {
		result.SourceSessionId = stringPointer(run.SourceSessionID)
	}
	if run.TargetSessionID != "" {
		result.TargetSessionId = stringPointer(run.TargetSessionID)
	}
	if run.TargetAgentTargetID != "" {
		result.TargetAgentTargetId = stringPointer(run.TargetAgentTargetID)
	}
	if run.ModelPlanID != "" {
		result.ModelPlanId = stringPointer(run.ModelPlanID)
	}
	if run.Model != "" {
		result.Model = stringPointer(run.Model)
	}
	if run.ContextScope != "" {
		result.ContextScope = stringPointer(run.ContextScope)
	}
	if run.Prompt != "" {
		result.Prompt = stringPointer(run.Prompt)
	}
	if run.ResultText != "" {
		result.ResultText = stringPointer(run.ResultText)
	}
	if run.FailureReason != "" {
		result.FailureReason = stringPointer(run.FailureReason)
	}
	if !run.StartedAt.IsZero() {
		startedAt := run.StartedAt
		result.StartedAt = &startedAt
	}
	if !run.CompletedAt.IsZero() {
		completedAt := run.CompletedAt
		result.CompletedAt = &completedAt
	}
	return result
}

func collaborationRunServiceUnavailable() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable(
		"collaboration_run_service_unavailable",
		apierrors.WithDeveloperMessage("collaboration run service is unavailable"),
	))
}

func collaborationRunNotFoundError() tuttigenerated.WorkspaceNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(
		apierrors.New(http.StatusNotFound, tuttigenerated.CollaborationRunNotFound, "collaboration_run_not_found", apierrors.WithDeveloperMessage("collaboration run not found")),
	))
}

func collaborationRunPlanNotFoundError() tuttigenerated.WorkspaceNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(
		apierrors.New(http.StatusNotFound, tuttigenerated.ModelPlanNotFound, "model_plan_not_found", apierrors.WithDeveloperMessage("model plan not found")),
	))
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
