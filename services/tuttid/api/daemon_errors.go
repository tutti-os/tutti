package api

import (
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

func invalidRequestError(err *apierrors.ProtocolError) tuttigenerated.InvalidRequestErrorJSONResponse {
	return tuttigenerated.InvalidRequestErrorJSONResponse(protocolErrorResponse(err))
}

func serviceUnavailableError(err *apierrors.ProtocolError) tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return tuttigenerated.ServiceUnavailableErrorJSONResponse(protocolErrorResponse(err))
}

func workspaceNotFoundError(err *apierrors.ProtocolError) tuttigenerated.WorkspaceNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(err))
}

func workspaceFileNotFoundError(err *apierrors.ProtocolError) tuttigenerated.WorkspaceFileNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceFileNotFoundErrorJSONResponse(protocolErrorResponse(err))
}

func workspaceTerminalNotFoundError(err *apierrors.ProtocolError) tuttigenerated.WorkspaceTerminalNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceTerminalNotFoundErrorJSONResponse(protocolErrorResponse(err))
}

func workspaceAppNotFoundError(err *apierrors.ProtocolError) tuttigenerated.WorkspaceAppNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceAppNotFoundErrorJSONResponse(protocolErrorResponse(err))
}

func workspaceOperationError(err *apierrors.ProtocolError) tuttigenerated.WorkspaceOperationErrorJSONResponse {
	return tuttigenerated.WorkspaceOperationErrorJSONResponse(protocolErrorResponse(err))
}

func preferencesOperationError(err *apierrors.ProtocolError) tuttigenerated.PreferencesOperationErrorJSONResponse {
	return tuttigenerated.PreferencesOperationErrorJSONResponse(protocolErrorResponse(err))
}

func protocolErrorResponse(err *apierrors.ProtocolError) tuttigenerated.ApiErrorResponse {
	if err == nil {
		err = apierrors.WorkspaceOperationFailed()
	}

	response := tuttigenerated.ApiErrorResponse{
		Error: tuttigenerated.ApiErrorDetails{
			Code: err.Code,
		},
	}
	if err.Reason != "" {
		response.Error.Reason = stringPointer(err.Reason)
	}
	if len(err.Params) > 0 {
		params := make(map[string]interface{}, len(err.Params))
		for key, value := range err.Params {
			params[key] = value
		}
		response.Error.Params = &params
	}
	if err.Retryable {
		response.Error.Retryable = boolPointer(true)
	}
	if err.DeveloperMessage != "" {
		response.Error.DeveloperMessage = stringPointer(err.DeveloperMessage)
	}
	if err.CorrelationID != "" {
		response.Error.CorrelationId = stringPointer(err.CorrelationID)
	}
	return response
}

func writeCreateWorkspaceError(err error) tuttigenerated.CreateWorkspaceResponseObject {
	protocolErr := apierrors.Classify(err)
	return tuttigenerated.CreateWorkspace502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}

func writeDeleteWorkspaceError(err error) tuttigenerated.DeleteWorkspaceResponseObject {
	protocolErr := apierrors.Classify(err)
	if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
		return tuttigenerated.DeleteWorkspace404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	}

	return tuttigenerated.DeleteWorkspace502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}

func writeGetWorkspaceError(err error) tuttigenerated.GetWorkspaceResponseObject {
	protocolErr := apierrors.Classify(err)
	if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
		return tuttigenerated.GetWorkspace404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	}

	return tuttigenerated.GetWorkspace502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}

func writeOpenWorkspaceError(err error) tuttigenerated.OpenWorkspaceResponseObject {
	protocolErr := apierrors.Classify(err)
	if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
		return tuttigenerated.OpenWorkspace404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	}

	return tuttigenerated.OpenWorkspace502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}

func writeUpdateWorkspaceError(err error) tuttigenerated.UpdateWorkspaceResponseObject {
	protocolErr := apierrors.Classify(err)
	if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
		return tuttigenerated.UpdateWorkspace404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	}

	return tuttigenerated.UpdateWorkspace502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}

func writeGetWorkspaceWorkbenchError(err error) tuttigenerated.GetWorkspaceWorkbenchResponseObject {
	protocolErr := apierrors.Classify(err)
	if protocolErr.Code == tuttigenerated.WorkspaceNotFound {
		return tuttigenerated.GetWorkspaceWorkbench404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	}

	return tuttigenerated.GetWorkspaceWorkbench502JSONResponse{
		WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
	}
}

func writeListWorkspaceAgentSessionsError(err error) tuttigenerated.ListWorkspaceAgentSessionsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceAgentSessions404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceAgentSessions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceAgentSessions502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeCreateWorkspaceAgentSessionError(err error) tuttigenerated.CreateWorkspaceAgentSessionResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.CreateWorkspaceAgentSession404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.CreateWorkspaceAgentSession502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeGetAgentProviderComposerOptionsError(err error) tuttigenerated.GetAgentProviderComposerOptionsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetAgentProviderComposerOptions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.GetAgentProviderComposerOptions502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeGetWorkspaceAgentSessionError(err error) tuttigenerated.GetWorkspaceAgentSessionResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.GetWorkspaceAgentSession404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceAgentSession502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeDeleteWorkspaceAgentSessionError(err error) tuttigenerated.DeleteWorkspaceAgentSessionResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.DeleteWorkspaceAgentSession404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.DeleteWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.DeleteWorkspaceAgentSession502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeListWorkspaceAgentSessionMessagesError(err error) tuttigenerated.ListWorkspaceAgentSessionMessagesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceAgentSessionMessages404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceAgentSessionMessages400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceAgentSessionMessages502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeCancelWorkspaceAgentSessionError(err error) tuttigenerated.CancelWorkspaceAgentSessionResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.CancelWorkspaceAgentSession404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CancelWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.CancelWorkspaceAgentSession502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeSendWorkspaceAgentSessionInputError(err error) tuttigenerated.SendWorkspaceAgentSessionInputResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.SendWorkspaceAgentSessionInput404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.SendWorkspaceAgentSessionInput400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.SendWorkspaceAgentSessionInput502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeReadWorkspaceAgentSessionAttachmentError(err error) tuttigenerated.ReadWorkspaceAgentSessionAttachmentResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ReadWorkspaceAgentSessionAttachment404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ReadWorkspaceAgentSessionAttachment400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ReadWorkspaceAgentSessionAttachment502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeListWorkspaceAgentSessionGitBranchesError(err error) tuttigenerated.ListWorkspaceAgentSessionGitBranchesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceAgentSessionGitBranches404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceAgentSessionGitBranches400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceAgentSessionGitBranches502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeListWorkspaceGitBranchesError(err error) tuttigenerated.ListWorkspaceGitBranchesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceGitBranches404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceGitBranches400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceGitBranches502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeUpdateWorkspaceAgentSessionSettingsError(err error) tuttigenerated.UpdateWorkspaceAgentSessionSettingsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.UpdateWorkspaceAgentSessionSettings404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UpdateWorkspaceAgentSessionSettings400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.UpdateWorkspaceAgentSessionSettings502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeUpdateWorkspaceAgentSessionPinError(err error) tuttigenerated.UpdateWorkspaceAgentSessionPinResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.UpdateWorkspaceAgentSessionPin404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UpdateWorkspaceAgentSessionPin400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.UpdateWorkspaceAgentSessionPin502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writePutWorkspaceWorkbenchError(err error) tuttigenerated.PutWorkspaceWorkbenchResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.PutWorkspaceWorkbench400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.PutWorkspaceWorkbench404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	default:
		return tuttigenerated.PutWorkspaceWorkbench502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeListWorkspaceFileDirectoryError(err error) tuttigenerated.ListWorkspaceFileDirectoryResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.ListWorkspaceFileDirectory404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceFileDirectory400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceFileDirectory502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeListWorkspaceRecentFilesError(err error) tuttigenerated.ListWorkspaceRecentFilesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.ListWorkspaceRecentFiles404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceRecentFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceRecentFiles502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeCreateWorkspaceFileDirectoryError(err error) tuttigenerated.CreateWorkspaceFileDirectoryResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.CreateWorkspaceFileDirectory404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceFileDirectory400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.CreateWorkspaceFileDirectory502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeGetWorkspaceFileTreeSnapshotError(err error) tuttigenerated.GetWorkspaceFileTreeSnapshotResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.GetWorkspaceFileTreeSnapshot404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceFileTreeSnapshot400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceFileTreeSnapshot502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeSubmitWorkspaceAgentInteractiveError(err error) tuttigenerated.SubmitWorkspaceAgentInteractiveResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.SubmitWorkspaceAgentInteractive404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.SubmitWorkspaceAgentInteractive400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.SubmitWorkspaceAgentInteractive502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeListWorkspaceTerminalsError(err error) tuttigenerated.ListWorkspaceTerminalsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceTerminals404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceTerminals400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceTerminals502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeCreateWorkspaceTerminalError(err error) tuttigenerated.CreateWorkspaceTerminalResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.CreateWorkspaceTerminal404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceTerminal400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.CreateWorkspaceTerminal502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeGetWorkspaceTerminalError(err error) tuttigenerated.GetWorkspaceTerminalResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceTerminalNotFound:
		return tuttigenerated.GetWorkspaceTerminal404JSONResponse{
			WorkspaceTerminalNotFoundErrorJSONResponse: workspaceTerminalNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceTerminal400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceTerminal502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeTerminateWorkspaceTerminalError(err error) tuttigenerated.TerminateWorkspaceTerminalResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceTerminalNotFound:
		return tuttigenerated.TerminateWorkspaceTerminal404JSONResponse{
			WorkspaceTerminalNotFoundErrorJSONResponse: workspaceTerminalNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.TerminateWorkspaceTerminal400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.TerminateWorkspaceTerminal502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeCheckWorkspaceTerminalCloseGuardError(err error) tuttigenerated.CheckWorkspaceTerminalCloseGuardResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceTerminalNotFound:
		return tuttigenerated.CheckWorkspaceTerminalCloseGuard404JSONResponse{
			WorkspaceTerminalNotFoundErrorJSONResponse: workspaceTerminalNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CheckWorkspaceTerminalCloseGuard400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.CheckWorkspaceTerminalCloseGuard502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeResizeWorkspaceTerminalError(err error) tuttigenerated.ResizeWorkspaceTerminalResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceTerminalNotFound:
		return tuttigenerated.ResizeWorkspaceTerminal404JSONResponse{
			WorkspaceTerminalNotFoundErrorJSONResponse: workspaceTerminalNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ResizeWorkspaceTerminal400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ResizeWorkspaceTerminal502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeGetWorkspaceTerminalSnapshotError(err error) tuttigenerated.GetWorkspaceTerminalSnapshotResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceTerminalNotFound:
		return tuttigenerated.GetWorkspaceTerminalSnapshot404JSONResponse{
			WorkspaceTerminalNotFoundErrorJSONResponse: workspaceTerminalNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceTerminalSnapshot400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.GetWorkspaceTerminalSnapshot502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeSearchWorkspaceFilesError(err error) tuttigenerated.SearchWorkspaceFilesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.SearchWorkspaceFiles404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.SearchWorkspaceFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.SearchWorkspaceFiles502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeCreateWorkspaceFileError(err error) tuttigenerated.CreateWorkspaceFileResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.CreateWorkspaceFile404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceFile400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.CreateWorkspaceFile502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeReadWorkspaceFilePreviewError(err error) tuttigenerated.ReadWorkspaceFilePreviewResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.ReadWorkspaceFilePreview404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ReadWorkspaceFilePreview400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ReadWorkspaceFilePreview502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeWriteWorkspaceFileTextError(err error) tuttigenerated.WriteWorkspaceFileTextResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.WriteWorkspaceFileText404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.WriteWorkspaceFileText400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.WriteWorkspaceFileText502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeDeleteWorkspaceFileEntryError(err error) tuttigenerated.DeleteWorkspaceFileEntryResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.DeleteWorkspaceFileEntry404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.DeleteWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.DeleteWorkspaceFileEntry502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeMoveWorkspaceFileEntryError(err error) tuttigenerated.MoveWorkspaceFileEntryResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.MoveWorkspaceFileEntry404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.MoveWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.MoveWorkspaceFileEntry502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeRenameWorkspaceFileEntryError(err error) tuttigenerated.RenameWorkspaceFileEntryResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.RenameWorkspaceFileEntry404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.RenameWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.RenameWorkspaceFileEntry502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeCopyWorkspaceFileEntryError(err error) tuttigenerated.CopyWorkspaceFileEntryResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.CopyWorkspaceFileEntry404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CopyWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.CopyWorkspaceFileEntry502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeUploadWorkspaceFilesError(err error) tuttigenerated.UploadWorkspaceFilesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.UploadWorkspaceFiles404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UploadWorkspaceFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.UploadWorkspaceFiles502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writePreflightUploadWorkspaceFilesError(err error) tuttigenerated.PreflightUploadWorkspaceFilesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceFileNotFound:
		return tuttigenerated.PreflightUploadWorkspaceFiles404JSONResponse{
			WorkspaceFileNotFoundErrorJSONResponse: workspaceFileNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.PreflightUploadWorkspaceFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.PreflightUploadWorkspaceFiles502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func boolPointer(value bool) *bool {
	return &value
}

func stringPointer(value string) *string {
	return &value
}
