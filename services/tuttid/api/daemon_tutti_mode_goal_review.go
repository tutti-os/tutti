package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const authenticatedLocalOperatorActorID = "local-daemon-operator"

type TuttiModeGoalReviewService interface {
	SwitchReviewToSelf(
		context.Context,
		tuttimodeexecutionservice.SwitchReviewToSelfInput,
	) (tuttimodeexecutionservice.SwitchReviewToSelfResult, error)
}

func registerTuttiModeGoalReviewRoutes(
	mux *http.ServeMux,
	wrapper *tuttigenerated.ServerInterfaceWrapper,
) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/issues/{issueID}/tutti-mode-review/self", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SwitchTuttiModeGoalReviewToSelf(w, r)
	})
}

func (api DaemonAPI) SwitchTuttiModeGoalReviewToSelf(
	ctx context.Context,
	request tuttigenerated.SwitchTuttiModeGoalReviewToSelfRequestObject,
) (tuttigenerated.SwitchTuttiModeGoalReviewToSelfResponseObject, error) {
	if request.Body == nil {
		return goalReviewInvalidRequest(apierrors.EmptyBody()), nil
	}
	body := request.Body
	if strings.TrimSpace(body.CheckpointId) == "" ||
		body.ExpectedGraphRevision < 1 ||
		strings.TrimSpace(body.RequestId) == "" ||
		strings.TrimSpace(body.Reason) == "" {
		return goalReviewInvalidRequest(
			apierrors.MalformedRequest(apierrors.WithDeveloperMessage("checkpointId, expectedGraphRevision, requestId, and reason are required")),
		), nil
	}
	if api.TuttiModeGoalReviewService == nil {
		return tuttigenerated.SwitchTuttiModeGoalReviewToSelf503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				goalReviewProtocolError(
					apierrors.StatusServiceUnavailable,
					tuttigenerated.TuttiModeGoalReviewServiceUnavailable,
					"tutti_goal_review_service_unavailable",
				),
			),
		}, nil
	}
	result, err := api.TuttiModeGoalReviewService.SwitchReviewToSelf(
		ctx,
		tuttimodeexecutionservice.SwitchReviewToSelfInput{
			WorkspaceID:           strings.TrimSpace(request.WorkspaceID),
			IssueID:               strings.TrimSpace(request.IssueID),
			CheckpointID:          strings.TrimSpace(body.CheckpointId),
			ExpectedGraphRevision: body.ExpectedGraphRevision,
			RequestID:             strings.TrimSpace(body.RequestId),
			Reason:                strings.TrimSpace(body.Reason),
			RequestedByActorID:    authenticatedLocalOperatorActorID,
		},
	)
	if err != nil {
		return goalReviewFallbackError(err), nil
	}
	return tuttigenerated.SwitchTuttiModeGoalReviewToSelf200JSONResponse{
		ExecutionId: result.ExecutionID,
		ReviewId:    result.ReviewID,
		ReviewMode:  tuttigenerated.Self,
		Replayed:    result.Replayed,
	}, nil
}

func goalReviewInvalidRequest(err *apierrors.ProtocolError) tuttigenerated.SwitchTuttiModeGoalReviewToSelfResponseObject {
	return tuttigenerated.SwitchTuttiModeGoalReviewToSelf400JSONResponse{
		InvalidRequestErrorJSONResponse: invalidRequestError(err),
	}
}

func goalReviewFallbackError(err error) tuttigenerated.SwitchTuttiModeGoalReviewToSelfResponseObject {
	switch {
	case errors.Is(err, tuttimodeexecutionservice.ErrExecutionNotFound):
		return tuttigenerated.SwitchTuttiModeGoalReviewToSelf404JSONResponse{
			TuttiModeGoalReviewNotFoundErrorJSONResponse: tuttigenerated.TuttiModeGoalReviewNotFoundErrorJSONResponse(
				protocolErrorResponse(goalReviewProtocolError(
					apierrors.StatusWorkspaceNotFound,
					tuttigenerated.TuttiModeGoalReviewNotFound,
					"tutti_goal_review_not_found",
				)),
			),
		}
	case errors.Is(err, tuttimodeexecutionservice.ErrSwitchReviewToSelfRejected),
		errors.Is(err, tuttimodeexecutionservice.ErrSwitchReviewToSelfMutationConflict),
		errors.Is(err, tuttimodeexecutionservice.ErrExecutionConflict):
		return tuttigenerated.SwitchTuttiModeGoalReviewToSelf409JSONResponse{
			TuttiModeGoalReviewConflictErrorJSONResponse: tuttigenerated.TuttiModeGoalReviewConflictErrorJSONResponse(
				protocolErrorResponse(goalReviewProtocolError(
					apierrors.StatusWorkspaceIssueExists,
					tuttigenerated.TuttiModeGoalReviewConflict,
					"tutti_goal_review_conflict",
				)),
			),
		}
	case errors.Is(err, tuttimodeexecutionservice.ErrServiceUnavailable):
		return tuttigenerated.SwitchTuttiModeGoalReviewToSelf503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				goalReviewProtocolError(
					apierrors.StatusServiceUnavailable,
					tuttigenerated.TuttiModeGoalReviewServiceUnavailable,
					"tutti_goal_review_service_unavailable",
				),
			),
		}
	default:
		return tuttigenerated.SwitchTuttiModeGoalReviewToSelf502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(
				goalReviewProtocolError(
					apierrors.StatusWorkspaceOperationFailed,
					tuttigenerated.TuttiModeGoalReviewOperationFailed,
					"tutti_goal_review_operation_failed",
				),
			),
		}
	}
}

func goalReviewProtocolError(
	status int,
	code tuttigenerated.ApiErrorDetailsCode,
	reason string,
) *apierrors.ProtocolError {
	return apierrors.New(status, code, reason)
}
