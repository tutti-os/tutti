package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func (api DaemonAPI) RemoveWorkspaceIssueContextRef(
	ctx context.Context,
	request tuttigenerated.RemoveWorkspaceIssueContextRefRequestObject,
) (tuttigenerated.RemoveWorkspaceIssueContextRefResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.RemoveWorkspaceIssueContextRef503JSONResponse{
			ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError(),
		}, nil
	}
	removed, err := api.IssueService.RemoveIssueContextRef(
		ctx,
		string(request.WorkspaceID),
		string(request.IssueID),
		string(request.ContextRefID),
	)
	if err != nil {
		return writeRemoveWorkspaceIssueContextRefError(err), nil
	}
	return tuttigenerated.RemoveWorkspaceIssueContextRef200JSONResponse{
		Removed: removed,
	}, nil
}

func (api DaemonAPI) ReadWorkspaceIssueAttachment(
	ctx context.Context,
	request tuttigenerated.ReadWorkspaceIssueAttachmentRequestObject,
) (tuttigenerated.ReadWorkspaceIssueAttachmentResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.ReadWorkspaceIssueAttachment503JSONResponse{
			ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError(),
		}, nil
	}
	attachment, err := api.IssueService.ReadIssueAttachment(
		ctx,
		string(request.WorkspaceID),
		string(request.IssueID),
		string(request.ContextRefID),
	)
	if err != nil {
		return writeReadWorkspaceIssueAttachmentError(err), nil
	}
	return tuttigenerated.ReadWorkspaceIssueAttachment200JSONResponse{
		ContextRefId: attachment.ContextRefID,
		MimeType: tuttigenerated.IssueManagerAttachmentContentResponseMimeType(
			attachment.MimeType,
		),
		DisplayName: attachment.DisplayName,
		Data:        attachment.Data,
	}, nil
}
