package api

import (
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

func workspaceIssueResourceNotFoundError(err *apierrors.ProtocolError) tuttigenerated.WorkspaceIssueResourceNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceIssueResourceNotFoundErrorJSONResponse(protocolErrorResponse(err))
}

func workspaceIssueResourceExistsError(err *apierrors.ProtocolError) tuttigenerated.WorkspaceIssueResourceExistsErrorJSONResponse {
	return tuttigenerated.WorkspaceIssueResourceExistsErrorJSONResponse(protocolErrorResponse(err))
}

func issueManagerServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.WorkspaceIssueServiceUnavailable(
			apierrors.WithDeveloperMessage("workspace issue-manager service is unavailable"),
		),
	)
}

func writeListWorkspaceIssuesError(err error) tuttigenerated.ListWorkspaceIssuesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceIssues400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceIssues404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.ListWorkspaceIssues404JSONResponse{WorkspaceNotFoundErrorJSONResponse: tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(protocolErr))}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.ListWorkspaceIssues503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.ListWorkspaceIssues502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeSearchWorkspaceIssueReferencesError(err error) tuttigenerated.SearchWorkspaceIssueReferencesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.SearchWorkspaceIssueReferences400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.SearchWorkspaceIssueReferences404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.SearchWorkspaceIssueReferences404JSONResponse{WorkspaceNotFoundErrorJSONResponse: tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(protocolErr))}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.SearchWorkspaceIssueReferences503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.SearchWorkspaceIssueReferences502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeListWorkspaceIssueTopicsError(err error) tuttigenerated.ListWorkspaceIssueTopicsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceIssueTopics400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceIssueTopics404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.ListWorkspaceIssueTopics503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.ListWorkspaceIssueTopics502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCreateWorkspaceIssueTopicError(err error) tuttigenerated.CreateWorkspaceIssueTopicResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceIssueTopic400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.CreateWorkspaceIssueTopic404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.CreateWorkspaceIssueTopic409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CreateWorkspaceIssueTopic503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CreateWorkspaceIssueTopic502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeUpdateWorkspaceIssueTopicError(err error) tuttigenerated.UpdateWorkspaceIssueTopicResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UpdateWorkspaceIssueTopic400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.UpdateWorkspaceIssueTopic404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.UpdateWorkspaceIssueTopic503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.UpdateWorkspaceIssueTopic502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeDeleteWorkspaceIssueTopicError(err error) tuttigenerated.DeleteWorkspaceIssueTopicResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.DeleteWorkspaceIssueTopic400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.DeleteWorkspaceIssueTopic404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.DeleteWorkspaceIssueTopic409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.DeleteWorkspaceIssueTopic503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.DeleteWorkspaceIssueTopic502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCreateWorkspaceIssueError(err error) tuttigenerated.CreateWorkspaceIssueResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceIssue400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.CreateWorkspaceIssue404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CreateWorkspaceIssue404JSONResponse{WorkspaceNotFoundErrorJSONResponse: tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(protocolErr))}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.CreateWorkspaceIssue409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CreateWorkspaceIssue503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CreateWorkspaceIssue502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeRemoveWorkspaceIssueContextRefError(err error) tuttigenerated.RemoveWorkspaceIssueContextRefResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.RemoveWorkspaceIssueContextRef400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.RemoveWorkspaceIssueContextRef404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.RemoveWorkspaceIssueContextRef503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.RemoveWorkspaceIssueContextRef502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCancelWorkspaceIssueExecutionError(err error) tuttigenerated.CancelWorkspaceIssueExecutionResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CancelWorkspaceIssueExecution400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CancelWorkspaceIssueExecution404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CancelWorkspaceIssueExecution503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CancelWorkspaceIssueExecution502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeRemoveWorkspaceIssueTaskContextRefError(err error) tuttigenerated.RemoveWorkspaceIssueTaskContextRefResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.RemoveWorkspaceIssueTaskContextRef400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.RemoveWorkspaceIssueTaskContextRef404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.RemoveWorkspaceIssueTaskContextRef503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.RemoveWorkspaceIssueTaskContextRef502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeDeleteWorkspaceIssueError(err error) tuttigenerated.DeleteWorkspaceIssueResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.DeleteWorkspaceIssue400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.DeleteWorkspaceIssue404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.DeleteWorkspaceIssue503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.DeleteWorkspaceIssue502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeGetWorkspaceIssueDetailError(err error) tuttigenerated.GetWorkspaceIssueDetailResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceIssueDetail400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.GetWorkspaceIssueDetail404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.GetWorkspaceIssueDetail503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.GetWorkspaceIssueDetail502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeUpdateWorkspaceIssueError(err error) tuttigenerated.UpdateWorkspaceIssueResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UpdateWorkspaceIssue400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.UpdateWorkspaceIssue404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.UpdateWorkspaceIssue503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.UpdateWorkspaceIssue502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeAddWorkspaceIssueContextRefsError(err error) tuttigenerated.AddWorkspaceIssueContextRefsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.AddWorkspaceIssueContextRefs400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.AddWorkspaceIssueContextRefs404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.AddWorkspaceIssueContextRefs409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.AddWorkspaceIssueContextRefs503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.AddWorkspaceIssueContextRefs502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeListWorkspaceIssueTasksError(err error) tuttigenerated.ListWorkspaceIssueTasksResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceIssueTasks400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.ListWorkspaceIssueTasks404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.ListWorkspaceIssueTasks503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.ListWorkspaceIssueTasks502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCreateWorkspaceIssueTaskError(err error) tuttigenerated.CreateWorkspaceIssueTaskResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceIssueTask400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CreateWorkspaceIssueTask404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.CreateWorkspaceIssueTask409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CreateWorkspaceIssueTask503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CreateWorkspaceIssueTask502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCreateWorkspaceIssueTasksError(err error) tuttigenerated.CreateWorkspaceIssueTasksResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceIssueTasks400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CreateWorkspaceIssueTasks404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.CreateWorkspaceIssueTasks409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CreateWorkspaceIssueTasks503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CreateWorkspaceIssueTasks502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeDeleteWorkspaceIssueTaskError(err error) tuttigenerated.DeleteWorkspaceIssueTaskResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.DeleteWorkspaceIssueTask400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.DeleteWorkspaceIssueTask404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.DeleteWorkspaceIssueTask503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.DeleteWorkspaceIssueTask502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeGetWorkspaceIssueTaskDetailError(err error) tuttigenerated.GetWorkspaceIssueTaskDetailResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceIssueTaskDetail400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.GetWorkspaceIssueTaskDetail404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.GetWorkspaceIssueTaskDetail503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.GetWorkspaceIssueTaskDetail502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeUpdateWorkspaceIssueTaskError(err error) tuttigenerated.UpdateWorkspaceIssueTaskResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UpdateWorkspaceIssueTask400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.UpdateWorkspaceIssueTask404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.UpdateWorkspaceIssueTask503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.UpdateWorkspaceIssueTask502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeAddWorkspaceIssueTaskContextRefsError(err error) tuttigenerated.AddWorkspaceIssueTaskContextRefsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.AddWorkspaceIssueTaskContextRefs400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.AddWorkspaceIssueTaskContextRefs404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.AddWorkspaceIssueTaskContextRefs409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.AddWorkspaceIssueTaskContextRefs503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.AddWorkspaceIssueTaskContextRefs502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeListWorkspaceIssueRunsError(err error) tuttigenerated.ListWorkspaceIssueRunsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceIssueRuns400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.ListWorkspaceIssueRuns404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.ListWorkspaceIssueRuns503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.ListWorkspaceIssueRuns502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCreateWorkspaceIssueRunError(err error) tuttigenerated.CreateWorkspaceIssueRunResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceIssueRun400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CreateWorkspaceIssueRun404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.CreateWorkspaceIssueRun409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CreateWorkspaceIssueRun503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CreateWorkspaceIssueRun502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeGetWorkspaceIssueRunError(err error) tuttigenerated.GetWorkspaceIssueRunResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceIssueRun400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.GetWorkspaceIssueRun404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.GetWorkspaceIssueRun503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.GetWorkspaceIssueRun502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCompleteWorkspaceIssueRunError(err error) tuttigenerated.CompleteWorkspaceIssueRunResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CompleteWorkspaceIssueRun400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CompleteWorkspaceIssueRun404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CompleteWorkspaceIssueRun503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CompleteWorkspaceIssueRun502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeListWorkspaceIssueTaskRunsError(err error) tuttigenerated.ListWorkspaceIssueTaskRunsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceIssueTaskRuns400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.ListWorkspaceIssueTaskRuns404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.ListWorkspaceIssueTaskRuns503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.ListWorkspaceIssueTaskRuns502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCreateWorkspaceIssueTaskRunError(err error) tuttigenerated.CreateWorkspaceIssueTaskRunResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceIssueTaskRun400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CreateWorkspaceIssueTaskRun404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceExists:
		return tuttigenerated.CreateWorkspaceIssueTaskRun409JSONResponse{WorkspaceIssueResourceExistsErrorJSONResponse: workspaceIssueResourceExistsError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CreateWorkspaceIssueTaskRun503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CreateWorkspaceIssueTaskRun502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeGetWorkspaceIssueTaskRunError(err error) tuttigenerated.GetWorkspaceIssueTaskRunResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceIssueTaskRun400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.GetWorkspaceIssueTaskRun404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.GetWorkspaceIssueTaskRun503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.GetWorkspaceIssueTaskRun502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCompleteWorkspaceIssueTaskRunError(err error) tuttigenerated.CompleteWorkspaceIssueTaskRunResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CompleteWorkspaceIssueTaskRun400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	case tuttigenerated.WorkspaceIssueResourceNotFound:
		return tuttigenerated.CompleteWorkspaceIssueTaskRun404JSONResponse{WorkspaceIssueResourceNotFoundErrorJSONResponse: workspaceIssueResourceNotFoundError(protocolErr)}
	case tuttigenerated.ServiceUnavailable:
		return tuttigenerated.CompleteWorkspaceIssueTaskRun503JSONResponse{ServiceUnavailableErrorJSONResponse: serviceUnavailableError(protocolErr)}
	default:
		return tuttigenerated.CompleteWorkspaceIssueTaskRun502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}
