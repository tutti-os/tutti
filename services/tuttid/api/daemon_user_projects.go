package api

import (
	"context"
	"errors"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
)

type UserProjectService interface {
	CheckPath(context.Context, userprojectservice.CheckPathInput) (userprojectservice.PathCheck, error)
	Delete(context.Context, userprojectservice.DeleteInput) error
	List(context.Context) ([]userprojectbiz.Project, error)
	Move(context.Context, userprojectservice.MoveInput) ([]userprojectbiz.Project, error)
	Pin(context.Context, userprojectservice.PinInput) ([]userprojectbiz.Project, error)
	Use(context.Context, userprojectservice.UseInput) (userprojectbiz.Project, error)
	UseMany(context.Context, userprojectservice.UseManyInput) []error
}

func (api DaemonAPI) PinUserProject(ctx context.Context, request tuttigenerated.PinUserProjectRequestObject) (tuttigenerated.PinUserProjectResponseObject, error) {
	if api.UserProjectService == nil {
		return tuttigenerated.PinUserProject503JSONResponse{ServiceUnavailableErrorJSONResponse: userProjectServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.PinUserProject400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")))}, nil
	}
	projects, err := api.UserProjectService.Pin(ctx, userprojectservice.PinInput{
		ProjectID: request.Body.ProjectId,
		Pinned:    request.Body.Pinned,
	})
	if err != nil {
		if errors.Is(err, userprojectservice.ErrInvalidArgument) {
			return tuttigenerated.PinUserProject400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest(
				apierrors.ReasonMalformedRequest,
				apierrors.WithDeveloperMessage("user project pin references an unknown or invalid project"),
			))}, nil
		}
		return tuttigenerated.PinUserProject502JSONResponse{PreferencesOperationErrorJSONResponse: preferencesOperationError(apierrors.PreferencesOperationFailed(apierrors.WithCause(err)))}, nil
	}
	return tuttigenerated.PinUserProject200JSONResponse{Projects: generatedUserProjects(projects)}, nil
}

func (api DaemonAPI) MoveUserProject(ctx context.Context, request tuttigenerated.MoveUserProjectRequestObject) (tuttigenerated.MoveUserProjectResponseObject, error) {
	if api.UserProjectService == nil {
		return tuttigenerated.MoveUserProject503JSONResponse{ServiceUnavailableErrorJSONResponse: userProjectServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.MoveUserProject400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")))}, nil
	}
	projects, err := api.UserProjectService.Move(ctx, userprojectservice.MoveInput{
		ProjectID:       request.Body.ProjectId,
		BeforeProjectID: request.Body.BeforeProjectId,
	})
	if err != nil {
		if errors.Is(err, userprojectservice.ErrInvalidArgument) {
			return tuttigenerated.MoveUserProject400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest(
				apierrors.ReasonMalformedRequest,
				apierrors.WithDeveloperMessage("user project move references an unknown or invalid project"),
			))}, nil
		}
		return tuttigenerated.MoveUserProject502JSONResponse{PreferencesOperationErrorJSONResponse: preferencesOperationError(apierrors.PreferencesOperationFailed(apierrors.WithCause(err)))}, nil
	}
	return tuttigenerated.MoveUserProject200JSONResponse{Projects: generatedUserProjects(projects)}, nil
}

func (api DaemonAPI) CheckUserProjectPath(ctx context.Context, request tuttigenerated.CheckUserProjectPathRequestObject) (tuttigenerated.CheckUserProjectPathResponseObject, error) {
	if api.UserProjectService == nil {
		return tuttigenerated.CheckUserProjectPath503JSONResponse{
			ServiceUnavailableErrorJSONResponse: userProjectServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CheckUserProjectPath400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	check, err := api.UserProjectService.CheckPath(ctx, userprojectservice.CheckPathInput{
		Path: request.Body.Path,
	})
	if err != nil {
		if errors.Is(err, userprojectservice.ErrInvalidArgument) {
			return tuttigenerated.CheckUserProjectPath400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest(
						apierrors.ReasonInvalidPath,
						apierrors.WithDeveloperMessage("user project path is invalid"),
						apierrors.WithParams(map[string]any{"field": "path"}),
					),
				),
			}, nil
		}
		return tuttigenerated.CheckUserProjectPath502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.CheckUserProjectPath200JSONResponse{
		Exists:      check.Exists,
		IsDirectory: check.IsDirectory,
		Path:        check.Path,
	}, nil
}

func (api DaemonAPI) ListUserProjects(ctx context.Context, _ tuttigenerated.ListUserProjectsRequestObject) (tuttigenerated.ListUserProjectsResponseObject, error) {
	if api.UserProjectService == nil {
		return tuttigenerated.ListUserProjects503JSONResponse{
			ServiceUnavailableErrorJSONResponse: userProjectServiceUnavailableError(),
		}, nil
	}
	projects, err := api.UserProjectService.List(ctx)
	if err != nil {
		return tuttigenerated.ListUserProjects502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.ListUserProjects200JSONResponse{
		Projects: generatedUserProjects(projects),
	}, nil
}

func (api DaemonAPI) DeleteUserProject(ctx context.Context, request tuttigenerated.DeleteUserProjectRequestObject) (tuttigenerated.DeleteUserProjectResponseObject, error) {
	if api.UserProjectService == nil {
		return tuttigenerated.DeleteUserProject503JSONResponse{
			ServiceUnavailableErrorJSONResponse: userProjectServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.DeleteUserProject400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	err := api.UserProjectService.Delete(ctx, userprojectservice.DeleteInput{
		Path: request.Body.Path,
	})
	if err != nil {
		if errors.Is(err, userprojectservice.ErrInvalidArgument) {
			return tuttigenerated.DeleteUserProject400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest(
						apierrors.ReasonInvalidPath,
						apierrors.WithDeveloperMessage("user project path is invalid"),
						apierrors.WithParams(map[string]any{"field": "path"}),
					),
				),
			}, nil
		}
		return tuttigenerated.DeleteUserProject502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.DeleteUserProject204Response{}, nil
}

func (api DaemonAPI) UseUserProject(ctx context.Context, request tuttigenerated.UseUserProjectRequestObject) (tuttigenerated.UseUserProjectResponseObject, error) {
	if api.UserProjectService == nil {
		return tuttigenerated.UseUserProject503JSONResponse{
			ServiceUnavailableErrorJSONResponse: userProjectServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UseUserProject400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	project, err := api.UserProjectService.Use(ctx, userprojectservice.UseInput{
		Path: request.Body.Path,
	})
	if err != nil {
		if errors.Is(err, userprojectservice.ErrInvalidArgument) ||
			errors.Is(err, userprojectservice.ErrNotDirectory) {
			return tuttigenerated.UseUserProject400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(
					apierrors.InvalidRequest(
						apierrors.ReasonInvalidPath,
						apierrors.WithDeveloperMessage("user project path is invalid"),
						apierrors.WithParams(map[string]any{"field": "path"}),
					),
				),
			}, nil
		}
		return tuttigenerated.UseUserProject502JSONResponse{
			PreferencesOperationErrorJSONResponse: preferencesOperationError(
				apierrors.PreferencesOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	return tuttigenerated.UseUserProject201JSONResponse{
		Project: generatedUserProject(project),
	}, nil
}

func userProjectServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.PreferencesServiceUnavailable(
			apierrors.WithDeveloperMessage("user project service is unavailable"),
		),
	)
}

func generatedUserProjects(projects []userprojectbiz.Project) []tuttigenerated.UserProject {
	result := make([]tuttigenerated.UserProject, 0, len(projects))
	for _, project := range projects {
		result = append(result, generatedUserProject(project))
	}
	return result
}

func generatedUserProject(project userprojectbiz.Project) tuttigenerated.UserProject {
	return tuttigenerated.UserProject{
		CreatedAtUnixMs:  project.CreatedAtUnixMS,
		Id:               project.ID,
		Label:            project.Label,
		LastUsedAtUnixMs: project.LastUsedAtUnixMS,
		Path:             project.Path,
		PinnedAtUnixMs:   project.PinnedAtUnixMS,
		SectionKey:       userprojectbiz.SectionKeyFromPath(project.Path),
		UpdatedAtUnixMs:  project.UpdatedAtUnixMS,
	}
}
