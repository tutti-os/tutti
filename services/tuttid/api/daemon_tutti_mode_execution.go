package api

import (
	"context"
	"errors"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

type TuttiModeExecutionService interface {
	Archive(context.Context, tuttimodeexecutionservice.ArchiveInput) (executionbiz.ArchiveOperation, error)
	GetArchive(context.Context, string, string) (executionbiz.ArchiveOperation, error)
}

func (api DaemonAPI) CancelTuttiModeExecution(
	ctx context.Context,
	request tuttigenerated.CancelTuttiModeExecutionRequestObject,
) (tuttigenerated.CancelTuttiModeExecutionResponseObject, error) {
	if api.IssueExecutionService == nil {
		return tuttigenerated.CancelTuttiModeExecution503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("issue_execution_service_unavailable"),
			),
		}, nil
	}
	canceled, err := api.IssueExecutionService.CancelTuttiModeIssueExecution(
		ctx,
		string(request.WorkspaceID),
		string(request.IssueID),
	)
	if err != nil {
		return cancelTuttiModeExecutionError(err), nil
	}
	return tuttigenerated.CancelTuttiModeExecution200JSONResponse{
		CanceledRunCount: canceled,
	}, nil
}

func (api DaemonAPI) ArchiveTuttiModeExecution(
	ctx context.Context,
	request tuttigenerated.ArchiveTuttiModeExecutionRequestObject,
) (tuttigenerated.ArchiveTuttiModeExecutionResponseObject, error) {
	if api.TuttiModeExecutionService == nil {
		return tuttigenerated.ArchiveTuttiModeExecution503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("tutti_mode_execution_service_unavailable"),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.ArchiveTuttiModeExecution400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.InvalidRequest(apierrors.ReasonMalformedRequest),
			),
		}, nil
	}
	operation, err := api.TuttiModeExecutionService.Archive(ctx, tuttimodeexecutionservice.ArchiveInput{
		WorkspaceID: string(request.WorkspaceID), IssueID: string(request.IssueID),
		RequestID: request.Body.RequestId, RequestedBy: authenticatedLocalOperatorActorID,
		Reason: request.Body.Reason,
	})
	if err != nil && operation.OperationID == "" {
		return archiveTuttiModeExecutionError(err), nil
	}
	return tuttigenerated.ArchiveTuttiModeExecution200JSONResponse(
		generatedTuttiModeArchiveOperation(operation),
	), nil
}

func cancelTuttiModeExecutionError(
	err error,
) tuttigenerated.CancelTuttiModeExecutionResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CancelTuttiModeExecution400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CancelTuttiModeExecution404JSONResponse{
			WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr),
		}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CancelTuttiModeExecution503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr),
		}
	default:
		return tuttigenerated.CancelTuttiModeExecution502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func (api DaemonAPI) GetTuttiModeArchiveOperation(
	ctx context.Context,
	request tuttigenerated.GetTuttiModeArchiveOperationRequestObject,
) (tuttigenerated.GetTuttiModeArchiveOperationResponseObject, error) {
	if api.TuttiModeExecutionService == nil {
		return tuttigenerated.GetTuttiModeArchiveOperation503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.ServiceUnavailable("tutti_mode_execution_service_unavailable"),
			),
		}, nil
	}
	operation, err := api.TuttiModeExecutionService.GetArchive(
		ctx, string(request.WorkspaceID), request.Params.OperationId,
	)
	if err != nil {
		if errors.Is(err, executionbiz.ErrExecutionNotFound) {
			protocolErr := apierrors.New(
				apierrors.StatusWorkspaceIssueNotFound,
				tuttigenerated.WorkspaceIssueResourceNotFound,
				apierrors.ReasonWorkspaceIssueNotFound,
				apierrors.WithCause(err),
			)
			return tuttigenerated.GetTuttiModeArchiveOperation404JSONResponse{
				WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr),
			}, nil
		}
		return tuttigenerated.GetTuttiModeArchiveOperation502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.Classify(err)),
		}, nil
	}
	if operation.IssueID != string(request.IssueID) {
		protocolErr := apierrors.New(
			apierrors.StatusWorkspaceIssueNotFound,
			tuttigenerated.WorkspaceIssueResourceNotFound,
			apierrors.ReasonWorkspaceIssueNotFound,
			apierrors.WithCause(executionbiz.ErrExecutionNotFound),
		)
		return tuttigenerated.GetTuttiModeArchiveOperation404JSONResponse{
			WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr),
		}, nil
	}
	return tuttigenerated.GetTuttiModeArchiveOperation200JSONResponse(
		generatedTuttiModeArchiveOperation(operation),
	), nil
}

func generatedTuttiModeArchiveOperation(
	operation executionbiz.ArchiveOperation,
) tuttigenerated.TuttiModeArchiveOperation {
	return tuttigenerated.TuttiModeArchiveOperation{
		WorkspaceId: operation.WorkspaceID, ExecutionId: operation.ExecutionID,
		IssueId: operation.IssueID, OperationId: operation.OperationID,
		RequestId:   operation.RequestID,
		Status:      tuttigenerated.TuttiModeArchiveOperationStatus(operation.Status),
		RequestedBy: operation.RequestedBy, Reason: operation.Reason,
		AttemptCount: operation.AttemptCount, LastError: operation.LastError,
		CreatedAtUnixMs:   operation.CreatedAt.UnixMilli(),
		UpdatedAtUnixMs:   operation.UpdatedAt.UnixMilli(),
		CompletedAtUnixMs: archiveOperationUnixMilli(operation.CompletedAt),
	}
}

func archiveOperationUnixMilli(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UnixMilli()
}

func archiveTuttiModeExecutionError(
	err error,
) tuttigenerated.ArchiveTuttiModeExecutionResponseObject {
	if errors.Is(err, executionbiz.ErrInvalidExecution) {
		return tuttigenerated.ArchiveTuttiModeExecution400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.Classify(err)),
		}
	}
	if errors.Is(err, executionbiz.ErrExecutionNotFound) {
		protocolErr := apierrors.New(
			apierrors.StatusWorkspaceIssueNotFound,
			tuttigenerated.WorkspaceIssueResourceNotFound,
			apierrors.ReasonWorkspaceIssueNotFound,
			apierrors.WithCause(err),
		)
		return tuttigenerated.ArchiveTuttiModeExecution404JSONResponse{
			WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr),
		}
	}
	if errors.Is(err, executionbiz.ErrExecutionConflict) {
		protocolErr := apierrors.New(
			apierrors.StatusWorkspaceIssueExists,
			tuttigenerated.TuttiModeArchiveConflict,
			"tutti_archive_request_conflict",
			apierrors.WithCause(err),
		)
		return tuttigenerated.ArchiveTuttiModeExecution409JSONResponse{
			TuttiModeArchiveConflictErrorJSONResponse: tuttigenerated.TuttiModeArchiveConflictErrorJSONResponse(
				protocolErrorResponse(protocolErr),
			),
		}
	}
	return tuttigenerated.ArchiveTuttiModeExecution502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.Classify(err)),
	}
}
