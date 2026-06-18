package api

import (
	"context"
	"strings"
	"unicode/utf8"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspaceapi "github.com/tutti-os/tutti/services/tuttid/api/workspace"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

const (
	appReferenceListRequestTextMaxRunes    = 200
	appReferenceListRequestGroupIDMaxRunes = 2048
	appReferenceListRequestCursorMaxRunes  = 2048
	appReferenceListRequestLimitMin        = 1
	appReferenceListRequestLimitMax        = 200
)

func (api DaemonAPI) ListWorkspaceAppReferences(ctx context.Context, request tuttigenerated.ListWorkspaceAppReferencesRequestObject) (tuttigenerated.ListWorkspaceAppReferencesResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.ListWorkspaceAppReferences503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.ListWorkspaceAppReferences400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	if request.Body == nil {
		return tuttigenerated.ListWorkspaceAppReferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list request body is required"),
					apierrors.WithParams(map[string]any{"field": "body"}),
				),
			),
		}, nil
	}

	input, validationErr := validateAppReferenceListRequest(*request.Body)
	if validationErr != nil {
		return tuttigenerated.ListWorkspaceAppReferences400JSONResponse{InvalidRequestErrorJSONResponse: *validationErr}, nil
	}

	result, err := api.AppCenterService.ListReferences(ctx, workspaceID, appID, input)
	if err != nil {
		return writeListWorkspaceAppReferencesError(err), nil
	}

	return tuttigenerated.ListWorkspaceAppReferences200JSONResponse(
		workspaceapi.GeneratedAppReferenceListResultFromBiz(workspaceID, appID, result),
	), nil
}

func (api DaemonAPI) SearchWorkspaceAppReferences(ctx context.Context, request tuttigenerated.SearchWorkspaceAppReferencesRequestObject) (tuttigenerated.SearchWorkspaceAppReferencesResponseObject, error) {
	if api.AppCenterService == nil {
		return tuttigenerated.SearchWorkspaceAppReferences503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAppServiceUnavailableError(),
		}, nil
	}

	workspaceID, appID, errResponse := validateWorkspaceAppPath(request.WorkspaceID, request.AppID)
	if errResponse != nil {
		return tuttigenerated.SearchWorkspaceAppReferences400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SearchWorkspaceAppReferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference search request body is required"),
					apierrors.WithParams(map[string]any{"field": "body"}),
				),
			),
		}, nil
	}

	input, validationErr := validateAppReferenceSearchRequest(*request.Body)
	if validationErr != nil {
		return tuttigenerated.SearchWorkspaceAppReferences400JSONResponse{InvalidRequestErrorJSONResponse: *validationErr}, nil
	}

	result, err := api.AppCenterService.SearchReferences(ctx, workspaceID, appID, input)
	if err != nil {
		return writeSearchWorkspaceAppReferencesError(err), nil
	}

	return tuttigenerated.SearchWorkspaceAppReferences200JSONResponse(
		workspaceapi.GeneratedAppReferenceSearchResultFromBiz(workspaceID, appID, result),
	), nil
}

func validateAppReferenceListRequest(body tuttigenerated.AppReferenceListRequest) (workspacebiz.AppReferenceListInput, *tuttigenerated.InvalidRequestErrorJSONResponse) {
	input := workspacebiz.AppReferenceListInput{}
	if body.ParentGroupId != nil {
		parentGroupID := strings.TrimSpace(*body.ParentGroupId)
		if parentGroupID == "" || utf8.RuneCountInString(parentGroupID) > appReferenceListRequestGroupIDMaxRunes {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list parentGroupId is invalid"),
					apierrors.WithParams(map[string]any{"field": "parentGroupId"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.ParentGroupID = parentGroupID
	}
	if body.FilterText != nil {
		filterText := strings.TrimSpace(*body.FilterText)
		if utf8.RuneCountInString(filterText) > appReferenceListRequestTextMaxRunes {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list filterText is too long"),
					apierrors.WithParams(map[string]any{"field": "filterText"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.FilterText = filterText
	}
	if body.Limit != nil {
		if *body.Limit < appReferenceListRequestLimitMin || *body.Limit > appReferenceListRequestLimitMax {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list limit is out of range"),
					apierrors.WithParams(map[string]any{"field": "limit"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.Limit = *body.Limit
	}
	if body.Cursor != nil {
		cursor := strings.TrimSpace(*body.Cursor)
		if utf8.RuneCountInString(cursor) > appReferenceListRequestCursorMaxRunes {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list cursor is too long"),
					apierrors.WithParams(map[string]any{"field": "cursor"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.Cursor = cursor
	}
	if body.Kinds != nil {
		kinds, ok := generatedAppReferenceKindsToBiz(*body.Kinds)
		if !ok {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference list kind is unsupported"),
					apierrors.WithParams(map[string]any{"field": "kinds"}),
				),
			)
			return workspacebiz.AppReferenceListInput{}, &response
		}
		input.Kinds = kinds
	}
	if body.TimeRange != nil {
		timeRange, response := validateAppReferenceListTimeRange(*body.TimeRange)
		if response != nil {
			return workspacebiz.AppReferenceListInput{}, response
		}
		input.TimeRange = timeRange
	}
	return input, nil
}

// appReferenceFiltersMax 限定单次请求传入的筛选分类数量上限(防滥用)。
const appReferenceFiltersMax = 32

// normalizeAppReferenceFilters trims、去重、丢弃空白筛选分类 id,并截断到上限。
func normalizeAppReferenceFilters(filters []string) []string {
	if len(filters) == 0 {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(filters))
	for _, filter := range filters {
		filter = strings.TrimSpace(filter)
		if filter == "" || seen[filter] {
			continue
		}
		seen[filter] = true
		out = append(out, filter)
		if len(out) >= appReferenceFiltersMax {
			break
		}
	}
	return out
}

func validateAppReferenceSearchRequest(body tuttigenerated.AppReferenceSearchRequest) (workspacebiz.AppReferenceSearchInput, *tuttigenerated.InvalidRequestErrorJSONResponse) {
	input := workspacebiz.AppReferenceSearchInput{}
	query := strings.TrimSpace(body.Query)
	// 筛选与搜索是同一能力:query 可空、filters 非空时即按类型查。
	var filters []string
	if body.Filters != nil {
		filters = normalizeAppReferenceFilters(*body.Filters)
	}
	if utf8.RuneCountInString(query) > appReferenceListRequestTextMaxRunes ||
		(query == "" && len(filters) == 0) {
		response := invalidRequestError(
			apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("workspace app reference search query is invalid"),
				apierrors.WithParams(map[string]any{"field": "query"}),
			),
		)
		return workspacebiz.AppReferenceSearchInput{}, &response
	}
	input.Query = query
	input.Filters = filters
	if body.Limit != nil {
		if *body.Limit < appReferenceListRequestLimitMin || *body.Limit > appReferenceListRequestLimitMax {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference search limit is out of range"),
					apierrors.WithParams(map[string]any{"field": "limit"}),
				),
			)
			return workspacebiz.AppReferenceSearchInput{}, &response
		}
		input.Limit = *body.Limit
	}
	if body.Cursor != nil {
		cursor := strings.TrimSpace(*body.Cursor)
		if utf8.RuneCountInString(cursor) > appReferenceListRequestCursorMaxRunes {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference search cursor is too long"),
					apierrors.WithParams(map[string]any{"field": "cursor"}),
				),
			)
			return workspacebiz.AppReferenceSearchInput{}, &response
		}
		input.Cursor = cursor
	}
	if body.Kinds != nil {
		kinds, ok := generatedAppReferenceKindsToBiz(*body.Kinds)
		if !ok {
			response := invalidRequestError(
				apierrors.MalformedRequest(
					apierrors.WithDeveloperMessage("workspace app reference search kind is unsupported"),
					apierrors.WithParams(map[string]any{"field": "kinds"}),
				),
			)
			return workspacebiz.AppReferenceSearchInput{}, &response
		}
		input.Kinds = kinds
	}
	if body.TimeRange != nil {
		timeRange, response := validateAppReferenceListTimeRange(*body.TimeRange)
		if response != nil {
			return workspacebiz.AppReferenceSearchInput{}, response
		}
		input.TimeRange = timeRange
	}
	return input, nil
}

func validateAppReferenceListTimeRange(body tuttigenerated.AppReferenceListTimeRange) (*workspacebiz.AppReferenceListTimeRange, *tuttigenerated.InvalidRequestErrorJSONResponse) {
	if body.FromMs != nil && *body.FromMs < 0 {
		response := invalidRequestError(
			apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("workspace app reference list timeRange.fromMs is out of range"),
				apierrors.WithParams(map[string]any{"field": "timeRange.fromMs"}),
			),
		)
		return nil, &response
	}
	if body.ToMs != nil && *body.ToMs < 0 {
		response := invalidRequestError(
			apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("workspace app reference list timeRange.toMs is out of range"),
				apierrors.WithParams(map[string]any{"field": "timeRange.toMs"}),
			),
		)
		return nil, &response
	}
	if body.FromMs != nil && body.ToMs != nil && *body.FromMs > *body.ToMs {
		response := invalidRequestError(
			apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("workspace app reference list timeRange.fromMs must be less than or equal to timeRange.toMs"),
				apierrors.WithParams(map[string]any{"field": "timeRange"}),
			),
		)
		return nil, &response
	}
	if body.FromMs == nil && body.ToMs == nil {
		return nil, nil
	}
	return &workspacebiz.AppReferenceListTimeRange{
		FromMs: body.FromMs,
		ToMs:   body.ToMs,
	}, nil
}

func generatedAppReferenceKindsToBiz(kinds []tuttigenerated.AppReferenceKind) ([]workspacebiz.AppReferenceKind, bool) {
	result := make([]workspacebiz.AppReferenceKind, 0, len(kinds))
	for _, kind := range kinds {
		if kind == tuttigenerated.AppReferenceKindFile {
			result = append(result, workspacebiz.AppReferenceKindFile)
			continue
		}
		return nil, false
	}
	return result, true
}

func writeListWorkspaceAppReferencesError(err error) tuttigenerated.ListWorkspaceAppReferencesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.ListWorkspaceAppReferences404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceAppReferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.ListWorkspaceAppReferences502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}

func writeSearchWorkspaceAppReferencesError(err error) tuttigenerated.SearchWorkspaceAppReferencesResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.SearchWorkspaceAppReferences404JSONResponse{
			WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr),
		}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.SearchWorkspaceAppReferences400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr),
		}
	default:
		return tuttigenerated.SearchWorkspaceAppReferences502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr),
		}
	}
}
