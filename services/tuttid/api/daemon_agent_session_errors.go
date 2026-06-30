package api

import (
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

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

func writeClearWorkspaceAgentSessionsError(err error) tuttigenerated.ClearWorkspaceAgentSessionsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ClearWorkspaceAgentSessions404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ClearWorkspaceAgentSessions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ClearWorkspaceAgentSessions502JSONResponse{
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

func writeScanWorkspaceExternalAgentSessionImportsError(err error) tuttigenerated.ScanWorkspaceExternalAgentSessionImportsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ScanWorkspaceExternalAgentSessionImports404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ScanWorkspaceExternalAgentSessionImports400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ScanWorkspaceExternalAgentSessionImports502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeImportWorkspaceExternalAgentSessionsError(err error) tuttigenerated.ImportWorkspaceExternalAgentSessionsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ImportWorkspaceExternalAgentSessions404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ImportWorkspaceExternalAgentSessions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ImportWorkspaceExternalAgentSessions502JSONResponse{
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

func writeResolveWorkspaceGitPatchSupportError(err error) tuttigenerated.ResolveWorkspaceGitPatchSupportResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ResolveWorkspaceGitPatchSupport404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ResolveWorkspaceGitPatchSupport400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ResolveWorkspaceGitPatchSupport502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeApplyWorkspaceGitPatchError(err error) tuttigenerated.ApplyWorkspaceGitPatchResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ApplyWorkspaceGitPatch404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ApplyWorkspaceGitPatch400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ApplyWorkspaceGitPatch502JSONResponse{
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

func writeUpdateWorkspaceAgentSessionVisibilityError(err error) tuttigenerated.UpdateWorkspaceAgentSessionVisibilityResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.UpdateWorkspaceAgentSessionVisibility404JSONResponse{
			WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.UpdateWorkspaceAgentSessionVisibility400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.UpdateWorkspaceAgentSessionVisibility502JSONResponse{
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
