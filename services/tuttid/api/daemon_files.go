package api

import (
	"context"
	"encoding/base64"
	"strings"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspaceapi "github.com/tutti-os/tutti/services/tuttid/api/workspace"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
)

func (api DaemonAPI) ListWorkspaceFileDirectory(
	ctx context.Context,
	request tuttigenerated.ListWorkspaceFileDirectoryRequestObject,
) (tuttigenerated.ListWorkspaceFileDirectoryResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.ListWorkspaceFileDirectory503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.ListWorkspaceFileDirectory400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	path := ""
	if request.Params.Path != nil {
		path = strings.TrimSpace(*request.Params.Path)
	}
	includeHidden := false
	if request.Params.IncludeHidden != nil {
		includeHidden = *request.Params.IncludeHidden
	}
	listing, err := api.FileService.ListDirectory(ctx, workspaceID, workspacefiles.DirectoryListInput{
		IncludeHidden: includeHidden,
		Path:          path,
	})
	if err != nil {
		return writeListWorkspaceFileDirectoryError(err), nil
	}

	return tuttigenerated.ListWorkspaceFileDirectory200JSONResponse(
		workspaceapi.GeneratedFileDirectoryResponseFromDomain(listing),
	), nil
}

func (api DaemonAPI) CreateWorkspaceFileDirectory(
	ctx context.Context,
	request tuttigenerated.CreateWorkspaceFileDirectoryRequestObject,
) (tuttigenerated.CreateWorkspaceFileDirectoryResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.CreateWorkspaceFileDirectory503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.CreateWorkspaceFileDirectory400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceFileDirectory400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	entry, err := api.FileService.CreateDirectory(ctx, workspaceID, request.Body.Path)
	if err != nil {
		return writeCreateWorkspaceFileDirectoryError(err), nil
	}
	root, err := api.workspaceFileResponseRoot(ctx, workspaceID)
	if err != nil {
		return writeCreateWorkspaceFileDirectoryError(err), nil
	}

	return tuttigenerated.CreateWorkspaceFileDirectory200JSONResponse(
		workspaceapi.GeneratedFileEntryResponseFromDomain(
			workspaceID,
			root,
			entry,
		),
	), nil
}

func (api DaemonAPI) GetWorkspaceFileTreeSnapshot(
	ctx context.Context,
	request tuttigenerated.GetWorkspaceFileTreeSnapshotRequestObject,
) (tuttigenerated.GetWorkspaceFileTreeSnapshotResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.GetWorkspaceFileTreeSnapshot503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.GetWorkspaceFileTreeSnapshot400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	path := ""
	if request.Params.Path != nil {
		path = strings.TrimSpace(*request.Params.Path)
	}
	includeHidden := false
	if request.Params.IncludeHidden != nil {
		includeHidden = *request.Params.IncludeHidden
	}
	prefetchDepth := 0
	if request.Params.PrefetchDepth != nil {
		prefetchDepth = int(*request.Params.PrefetchDepth)
	}
	prefetchBudget := time.Duration(0)
	if request.Params.PrefetchBudgetMs != nil {
		prefetchBudget = time.Duration(*request.Params.PrefetchBudgetMs) * time.Millisecond
	}

	snapshot, err := api.FileService.GetDirectoryTreeSnapshot(
		ctx,
		workspaceID,
		workspacefiles.DirectoryTreeSnapshotInput{
			IncludeHidden:  includeHidden,
			Path:           path,
			PrefetchBudget: prefetchBudget,
			PrefetchDepth:  prefetchDepth,
		},
	)
	if err != nil {
		return writeGetWorkspaceFileTreeSnapshotError(err), nil
	}

	return tuttigenerated.GetWorkspaceFileTreeSnapshot200JSONResponse(
		workspaceapi.GeneratedFileTreeSnapshotResponseFromDomain(snapshot),
	), nil
}

func (api DaemonAPI) ListWorkspaceRecentFiles(
	ctx context.Context,
	request tuttigenerated.ListWorkspaceRecentFilesRequestObject,
) (tuttigenerated.ListWorkspaceRecentFilesResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.ListWorkspaceRecentFiles503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.ListWorkspaceRecentFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	limit := 0
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	listing, err := api.FileService.ListRecent(ctx, workspaceID, workspacefiles.RecentListInput{
		Limit: limit,
	})
	if err != nil {
		return writeListWorkspaceRecentFilesError(err), nil
	}

	return tuttigenerated.ListWorkspaceRecentFiles200JSONResponse(
		workspaceapi.GeneratedFileDirectoryResponseFromDomain(listing),
	), nil
}

func (api DaemonAPI) SearchWorkspaceFiles(
	ctx context.Context,
	request tuttigenerated.SearchWorkspaceFilesRequestObject,
) (tuttigenerated.SearchWorkspaceFilesResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.SearchWorkspaceFiles503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.SearchWorkspaceFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	limit := 0
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	includeHidden := false
	if request.Params.IncludeHidden != nil {
		includeHidden = *request.Params.IncludeHidden
	}
	var filters []string
	if request.Params.Filters != nil {
		filters = *request.Params.Filters
	}
	within := ""
	if request.Params.Within != nil {
		within = *request.Params.Within
	}
	result, err := api.FileService.Search(ctx, workspaceID, workspacefiles.SearchInput{
		Query:         string(request.Params.Query),
		Limit:         limit,
		IncludeKinds:  workspaceapi.DomainSearchKindsFromGenerated(request.Params.IncludeKinds),
		IncludeHidden: includeHidden,
		Filters:       filters,
		Within:        within,
	})
	if err != nil {
		return writeSearchWorkspaceFilesError(err), nil
	}

	return tuttigenerated.SearchWorkspaceFiles200JSONResponse(
		workspaceapi.GeneratedFileSearchResponseFromDomain(result),
	), nil
}

func (api DaemonAPI) CreateWorkspaceFile(
	ctx context.Context,
	request tuttigenerated.CreateWorkspaceFileRequestObject,
) (tuttigenerated.CreateWorkspaceFileResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.CreateWorkspaceFile503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.CreateWorkspaceFile400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceFile400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	entry, err := api.FileService.CreateFile(ctx, workspaceID, request.Body.Path)
	if err != nil {
		return writeCreateWorkspaceFileError(err), nil
	}
	root, err := api.workspaceFileResponseRoot(ctx, workspaceID)
	if err != nil {
		return writeCreateWorkspaceFileError(err), nil
	}

	return tuttigenerated.CreateWorkspaceFile200JSONResponse(
		workspaceapi.GeneratedFileEntryResponseFromDomain(
			workspaceID,
			root,
			entry,
		),
	), nil
}

func (api DaemonAPI) ReadWorkspaceFilePreview(
	ctx context.Context,
	request tuttigenerated.ReadWorkspaceFilePreviewRequestObject,
) (tuttigenerated.ReadWorkspaceFilePreviewResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.ReadWorkspaceFilePreview503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.ReadWorkspaceFilePreview400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}

	path := workspacefiles.DefaultLogicalRoot
	if request.Params.Path != nil {
		path = strings.TrimSpace(*request.Params.Path)
	}
	content, err := api.FileService.ReadFile(ctx, workspaceID, path, workspacefiles.DefaultReadFileMaxBytes)
	if err != nil {
		return writeReadWorkspaceFilePreviewError(err), nil
	}
	root, err := api.workspaceFileResponseRoot(ctx, workspaceID)
	if err != nil {
		return writeReadWorkspaceFilePreviewError(err), nil
	}

	return tuttigenerated.ReadWorkspaceFilePreview200JSONResponse{
		BytesBase64: base64.StdEncoding.EncodeToString(content.Bytes),
		Name:        content.Name,
		Path:        content.Path.String(),
		Root:        root.String(),
		SizeBytes:   content.SizeBytes,
		WorkspaceId: workspaceID,
	}, nil
}

func (api DaemonAPI) WriteWorkspaceFileText(
	ctx context.Context,
	request tuttigenerated.WriteWorkspaceFileTextRequestObject,
) (tuttigenerated.WriteWorkspaceFileTextResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.WriteWorkspaceFileText503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.WriteWorkspaceFileText400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.WriteWorkspaceFileText400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	entry, err := api.FileService.WriteTextFile(ctx, workspaceID, request.Body.Path, request.Body.Content)
	if err != nil {
		return writeWriteWorkspaceFileTextError(err), nil
	}
	root, err := api.workspaceFileResponseRoot(ctx, workspaceID)
	if err != nil {
		return writeWriteWorkspaceFileTextError(err), nil
	}

	return tuttigenerated.WriteWorkspaceFileText200JSONResponse(
		workspaceapi.GeneratedFileEntryResponseFromDomain(
			workspaceID,
			root,
			entry,
		),
	), nil
}

func (api DaemonAPI) DeleteWorkspaceFileEntry(
	ctx context.Context,
	request tuttigenerated.DeleteWorkspaceFileEntryRequestObject,
) (tuttigenerated.DeleteWorkspaceFileEntryResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.DeleteWorkspaceFileEntry503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.DeleteWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.DeleteWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	path := strings.TrimSpace(request.Body.Path)
	if err := api.FileService.DeleteEntry(
		ctx,
		workspaceID,
		path,
		workspaceapi.DomainEntryKindFromGenerated(request.Body.Kind),
	); err != nil {
		return writeDeleteWorkspaceFileEntryError(err), nil
	}

	normalizedPath, err := workspacefiles.NormalizeLogicalPath(path)
	if err != nil {
		normalizedPath = workspacefiles.LogicalPath(path)
	}
	return tuttigenerated.DeleteWorkspaceFileEntry200JSONResponse{
		WorkspaceId: workspaceID,
		Path:        normalizedPath.String(),
	}, nil
}

func (api DaemonAPI) MoveWorkspaceFileEntry(
	ctx context.Context,
	request tuttigenerated.MoveWorkspaceFileEntryRequestObject,
) (tuttigenerated.MoveWorkspaceFileEntryResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.MoveWorkspaceFileEntry503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.MoveWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.MoveWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	entry, err := api.FileService.MoveEntry(
		ctx,
		workspaceID,
		request.Body.Path,
		request.Body.TargetDirectoryPath,
	)
	if err != nil {
		return writeMoveWorkspaceFileEntryError(err), nil
	}
	root, err := api.workspaceFileResponseRoot(ctx, workspaceID)
	if err != nil {
		return writeMoveWorkspaceFileEntryError(err), nil
	}

	return tuttigenerated.MoveWorkspaceFileEntry200JSONResponse(
		workspaceapi.GeneratedFileEntryResponseFromDomain(
			workspaceID,
			root,
			entry,
		),
	), nil
}

func (api DaemonAPI) RenameWorkspaceFileEntry(
	ctx context.Context,
	request tuttigenerated.RenameWorkspaceFileEntryRequestObject,
) (tuttigenerated.RenameWorkspaceFileEntryResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.RenameWorkspaceFileEntry503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.RenameWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.RenameWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	entry, err := api.FileService.RenameEntry(
		ctx,
		workspaceID,
		request.Body.Path,
		request.Body.NewName,
	)
	if err != nil {
		return writeRenameWorkspaceFileEntryError(err), nil
	}
	root, err := api.workspaceFileResponseRoot(ctx, workspaceID)
	if err != nil {
		return writeRenameWorkspaceFileEntryError(err), nil
	}

	return tuttigenerated.RenameWorkspaceFileEntry200JSONResponse(
		workspaceapi.GeneratedFileEntryResponseFromDomain(
			workspaceID,
			root,
			entry,
		),
	), nil
}

func (api DaemonAPI) CopyWorkspaceFileEntry(
	ctx context.Context,
	request tuttigenerated.CopyWorkspaceFileEntryRequestObject,
) (tuttigenerated.CopyWorkspaceFileEntryResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.CopyWorkspaceFileEntry503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.CopyWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CopyWorkspaceFileEntry400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	entry, err := api.FileService.CopyEntry(ctx, workspaceID, request.Body.Path)
	if err != nil {
		return writeCopyWorkspaceFileEntryError(err), nil
	}
	root, err := api.workspaceFileResponseRoot(ctx, workspaceID)
	if err != nil {
		return writeCopyWorkspaceFileEntryError(err), nil
	}

	return tuttigenerated.CopyWorkspaceFileEntry200JSONResponse(
		workspaceapi.GeneratedFileEntryResponseFromDomain(
			workspaceID,
			root,
			entry,
		),
	), nil
}

func (api DaemonAPI) workspaceFileResponseRoot(
	ctx context.Context,
	workspaceID string,
) (workspacefiles.LogicalPath, error) {
	root, err := api.FileService.ResolveWorkspaceRoot(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	return workspacefiles.NormalizeLogicalRoot(root.LogicalRoot), nil
}

func (api DaemonAPI) UploadWorkspaceFiles(
	ctx context.Context,
	request tuttigenerated.UploadWorkspaceFilesRequestObject,
) (tuttigenerated.UploadWorkspaceFilesResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.UploadWorkspaceFiles503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.UploadWorkspaceFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UploadWorkspaceFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	result, err := api.FileService.UploadFiles(ctx, workspaceID, workspacefiles.UploadInput{
		Overwrite:           request.Body.Overwrite != nil && *request.Body.Overwrite,
		SourcePaths:         request.Body.SourcePaths,
		TargetDirectoryPath: request.Body.TargetDirectoryPath,
	})
	if err != nil {
		return writeUploadWorkspaceFilesError(err), nil
	}

	return tuttigenerated.UploadWorkspaceFiles200JSONResponse(
		workspaceapi.GeneratedFileUploadResponseFromDomain(result),
	), nil
}

func (api DaemonAPI) PreflightUploadWorkspaceFiles(
	ctx context.Context,
	request tuttigenerated.PreflightUploadWorkspaceFilesRequestObject,
) (tuttigenerated.PreflightUploadWorkspaceFilesResponseObject, error) {
	if api.FileService == nil {
		return tuttigenerated.PreflightUploadWorkspaceFiles503JSONResponse{
			ServiceUnavailableErrorJSONResponse: serviceUnavailableError(
				apierrors.WorkspaceFileServiceUnavailable(apierrors.WithDeveloperMessage("workspace file service is unavailable")),
			),
		}, nil
	}

	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.PreflightUploadWorkspaceFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MissingWorkspaceID(
					apierrors.WithDeveloperMessage("workspace id is required"),
					apierrors.WithParams(map[string]any{"field": "workspaceId"}),
				),
			),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.PreflightUploadWorkspaceFiles400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")),
			),
		}, nil
	}

	result, err := api.FileService.PreflightUploadFiles(ctx, workspaceID, workspacefiles.PreflightUploadInput{
		SourcePaths:         request.Body.SourcePaths,
		TargetDirectoryPath: request.Body.TargetDirectoryPath,
	})
	if err != nil {
		return writePreflightUploadWorkspaceFilesError(err), nil
	}

	return tuttigenerated.PreflightUploadWorkspaceFiles200JSONResponse(
		workspaceapi.GeneratedFilePreflightUploadResponseFromDomain(result),
	), nil
}
