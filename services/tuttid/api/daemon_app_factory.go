package api

import (
	"context"
	"encoding/json"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspaceapi "github.com/tutti-os/tutti/services/tuttid/api/workspace"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type AppFactoryService interface {
	Cancel(context.Context, string, string) (workspacebiz.AppFactoryJob, error)
	Create(context.Context, string, workspaceservice.CreateAppFactoryJobInput) (workspacebiz.AppFactoryJob, error)
	Delete(context.Context, string, string) error
	Fix(context.Context, string, string, workspaceservice.FixAppFactoryJobInput) (workspacebiz.AppFactoryJob, error)
	Get(context.Context, string, string) (workspacebiz.AppFactoryJob, error)
	GetProviderComposerOptions(context.Context, string, workspaceservice.AppFactoryProviderComposerOptionsInput) (agentservice.ComposerOptions, error)
	List(context.Context, string) ([]workspacebiz.AppFactoryJob, error)
	PrepareModification(context.Context, string, string) (workspacebiz.AppFactoryJob, error)
	Publish(context.Context, string, string) (workspacebiz.AppFactoryJob, workspacebiz.WorkspaceApp, error)
	RetryValidation(context.Context, string, string) (workspacebiz.AppFactoryJob, error)
}

func workspaceAppFactoryServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.WorkspaceAppServiceUnavailable(
			apierrors.WithDeveloperMessage("workspace app factory service is unavailable"),
		),
	)
}

func (api DaemonAPI) ListWorkspaceAppFactoryJobs(ctx context.Context, request tuttigenerated.ListWorkspaceAppFactoryJobsRequestObject) (tuttigenerated.ListWorkspaceAppFactoryJobsResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.ListWorkspaceAppFactoryJobs503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.ListWorkspaceAppFactoryJobs400JSONResponse{InvalidRequestErrorJSONResponse: invalidWorkspaceIDError()}, nil
	}
	jobs, err := api.AppFactoryService.List(ctx, workspaceID)
	if err != nil {
		return writeListWorkspaceAppFactoryJobsError(err), nil
	}
	return tuttigenerated.ListWorkspaceAppFactoryJobs200JSONResponse{
		WorkspaceId: workspaceID,
		Jobs:        generatedAppFactoryJobs(jobs),
	}, nil
}

func (api DaemonAPI) CreateWorkspaceAppFactoryJob(ctx context.Context, request tuttigenerated.CreateWorkspaceAppFactoryJobRequestObject) (tuttigenerated.CreateWorkspaceAppFactoryJobResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.CreateWorkspaceAppFactoryJob503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.CreateWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidWorkspaceIDError()}, nil
	}
	if request.Body == nil || strings.TrimSpace(request.Body.Prompt) == "" {
		return tuttigenerated.CreateWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.MalformedRequest(apierrors.WithDeveloperMessage("app factory prompt is required")))}, nil
	}
	if strings.TrimSpace(request.Body.DisplayName) == "" {
		return tuttigenerated.CreateWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.MalformedRequest(apierrors.WithDeveloperMessage("app factory display name is required")))}, nil
	}
	job, err := api.AppFactoryService.Create(ctx, workspaceID, workspaceservice.CreateAppFactoryJobInput{
		Prompt:      request.Body.Prompt,
		DisplayName: request.Body.DisplayName,
		Description: optionalStringValue(request.Body.Description),
		Provider:    optionalStringValue(request.Body.Provider),
		Model:       optionalStringValue(request.Body.Model),
		PermissionModeID: optionalStringValue(
			request.Body.PermissionModeId,
		),
		ReasoningEffort: optionalStringValue(request.Body.ReasoningEffort),
	})
	if err != nil {
		return writeCreateWorkspaceAppFactoryJobError(err), nil
	}
	return tuttigenerated.CreateWorkspaceAppFactoryJob201JSONResponse{
		WorkspaceId: workspaceID,
		Job:         generatedAppFactoryJob(job),
	}, nil
}

func (api DaemonAPI) GetWorkspaceAppFactoryProviderComposerOptions(ctx context.Context, request tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptionsRequestObject) (tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptionsResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptions503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID := strings.TrimSpace(string(request.WorkspaceID))
	if workspaceID == "" {
		return tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptions400JSONResponse{InvalidRequestErrorJSONResponse: invalidWorkspaceIDError()}, nil
	}
	provider := strings.TrimSpace(string(request.Provider))
	if provider == "" {
		return tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.MalformedRequest(
				apierrors.WithDeveloperMessage("agent provider is required"),
				apierrors.WithParams(map[string]any{"field": "provider"}),
			)),
		}, nil
	}
	settings := api.composerDefaultsForProvider(ctx, provider)
	if request.Body != nil && request.Body.Settings != nil {
		settings = mergeComposerSettings(settings, composerSettingsFromGenerated(*request.Body.Settings))
	}
	locale := api.composerDefaultLocale(ctx)
	if request.Body != nil && request.Body.Locale != nil {
		locale = string(*request.Body.Locale)
	}
	options, err := api.AppFactoryService.GetProviderComposerOptions(ctx, workspaceID, workspaceservice.AppFactoryProviderComposerOptionsInput{
		Locale:   locale,
		Provider: provider,
		Settings: settings,
	})
	if err != nil {
		return writeGetWorkspaceAppFactoryProviderComposerOptionsError(err), nil
	}
	return tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptions200JSONResponse(
		generatedAgentProviderComposerOptions(options),
	), nil
}

func (api DaemonAPI) GetWorkspaceAppFactoryJob(ctx context.Context, request tuttigenerated.GetWorkspaceAppFactoryJobRequestObject) (tuttigenerated.GetWorkspaceAppFactoryJobResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.GetWorkspaceAppFactoryJob503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID, jobID, errResponse := validateWorkspaceAppFactoryJobPath(request.WorkspaceID, request.JobID)
	if errResponse != nil {
		return tuttigenerated.GetWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	job, err := api.AppFactoryService.Get(ctx, workspaceID, jobID)
	if err != nil {
		return writeGetWorkspaceAppFactoryJobError(err), nil
	}
	return tuttigenerated.GetWorkspaceAppFactoryJob200JSONResponse{
		WorkspaceId: workspaceID,
		Job:         generatedAppFactoryJob(job),
	}, nil
}

func (api DaemonAPI) DeleteWorkspaceAppFactoryJob(ctx context.Context, request tuttigenerated.DeleteWorkspaceAppFactoryJobRequestObject) (tuttigenerated.DeleteWorkspaceAppFactoryJobResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.DeleteWorkspaceAppFactoryJob503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID, jobID, errResponse := validateWorkspaceAppFactoryJobPath(request.WorkspaceID, request.JobID)
	if errResponse != nil {
		return tuttigenerated.DeleteWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	if err := api.AppFactoryService.Delete(ctx, workspaceID, jobID); err != nil {
		return writeDeleteWorkspaceAppFactoryJobError(err), nil
	}
	jobs, err := api.AppFactoryService.List(ctx, workspaceID)
	if err != nil {
		return writeDeleteWorkspaceAppFactoryJobError(err), nil
	}
	return tuttigenerated.DeleteWorkspaceAppFactoryJob200JSONResponse{
		WorkspaceId: workspaceID,
		Jobs:        generatedAppFactoryJobs(jobs),
	}, nil
}

func (api DaemonAPI) CancelWorkspaceAppFactoryJob(ctx context.Context, request tuttigenerated.CancelWorkspaceAppFactoryJobRequestObject) (tuttigenerated.CancelWorkspaceAppFactoryJobResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.CancelWorkspaceAppFactoryJob503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID, jobID, errResponse := validateWorkspaceAppFactoryJobPath(request.WorkspaceID, request.JobID)
	if errResponse != nil {
		return tuttigenerated.CancelWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	job, err := api.AppFactoryService.Cancel(ctx, workspaceID, jobID)
	if err != nil {
		return writeCancelWorkspaceAppFactoryJobError(err), nil
	}
	return tuttigenerated.CancelWorkspaceAppFactoryJob200JSONResponse{
		WorkspaceId: workspaceID,
		Job:         generatedAppFactoryJob(job),
	}, nil
}

func (api DaemonAPI) RetryWorkspaceAppFactoryJobValidation(ctx context.Context, request tuttigenerated.RetryWorkspaceAppFactoryJobValidationRequestObject) (tuttigenerated.RetryWorkspaceAppFactoryJobValidationResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.RetryWorkspaceAppFactoryJobValidation503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID, jobID, errResponse := validateWorkspaceAppFactoryJobPath(request.WorkspaceID, request.JobID)
	if errResponse != nil {
		return tuttigenerated.RetryWorkspaceAppFactoryJobValidation400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	job, err := api.AppFactoryService.RetryValidation(ctx, workspaceID, jobID)
	if err != nil {
		return writeRetryWorkspaceAppFactoryJobValidationError(err), nil
	}
	return tuttigenerated.RetryWorkspaceAppFactoryJobValidation200JSONResponse{
		WorkspaceId: workspaceID,
		Job:         generatedAppFactoryJob(job),
	}, nil
}

func (api DaemonAPI) FixWorkspaceAppFactoryJob(ctx context.Context, request tuttigenerated.FixWorkspaceAppFactoryJobRequestObject) (tuttigenerated.FixWorkspaceAppFactoryJobResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.FixWorkspaceAppFactoryJob503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID, jobID, errResponse := validateWorkspaceAppFactoryJobPath(request.WorkspaceID, request.JobID)
	if errResponse != nil {
		return tuttigenerated.FixWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	if request.Body == nil || strings.TrimSpace(request.Body.Prompt) == "" {
		return tuttigenerated.FixWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.MalformedRequest(apierrors.WithDeveloperMessage("app factory fix prompt is required")))}, nil
	}
	job, err := api.AppFactoryService.Fix(ctx, workspaceID, jobID, workspaceservice.FixAppFactoryJobInput{Prompt: request.Body.Prompt})
	if err != nil {
		return writeFixWorkspaceAppFactoryJobError(err), nil
	}
	return tuttigenerated.FixWorkspaceAppFactoryJob200JSONResponse{
		WorkspaceId: workspaceID,
		Job:         generatedAppFactoryJob(job),
	}, nil
}

func (api DaemonAPI) PrepareWorkspaceAppFactoryJobModification(ctx context.Context, request tuttigenerated.PrepareWorkspaceAppFactoryJobModificationRequestObject) (tuttigenerated.PrepareWorkspaceAppFactoryJobModificationResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.PrepareWorkspaceAppFactoryJobModification503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID, jobID, errResponse := validateWorkspaceAppFactoryJobPath(request.WorkspaceID, request.JobID)
	if errResponse != nil {
		return tuttigenerated.PrepareWorkspaceAppFactoryJobModification400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	job, err := api.AppFactoryService.PrepareModification(ctx, workspaceID, jobID)
	if err != nil {
		return writePrepareWorkspaceAppFactoryJobModificationError(err), nil
	}
	return tuttigenerated.PrepareWorkspaceAppFactoryJobModification200JSONResponse{
		WorkspaceId: workspaceID,
		Job:         generatedAppFactoryJob(job),
	}, nil
}

func (api DaemonAPI) PublishWorkspaceAppFactoryJob(ctx context.Context, request tuttigenerated.PublishWorkspaceAppFactoryJobRequestObject) (tuttigenerated.PublishWorkspaceAppFactoryJobResponseObject, error) {
	if api.AppFactoryService == nil {
		return tuttigenerated.PublishWorkspaceAppFactoryJob503JSONResponse{ServiceUnavailableErrorJSONResponse: workspaceAppFactoryServiceUnavailableError()}, nil
	}
	workspaceID, jobID, errResponse := validateWorkspaceAppFactoryJobPath(request.WorkspaceID, request.JobID)
	if errResponse != nil {
		return tuttigenerated.PublishWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: *errResponse}, nil
	}
	job, app, err := api.AppFactoryService.Publish(ctx, workspaceID, jobID)
	if err != nil {
		return writePublishWorkspaceAppFactoryJobError(err), nil
	}
	return tuttigenerated.PublishWorkspaceAppFactoryJob200JSONResponse{
		WorkspaceId: workspaceID,
		Job:         generatedAppFactoryJob(job),
		App:         workspaceapi.GeneratedAppFromBiz(app),
	}, nil
}

func generatedAppFactoryJobs(jobs []workspacebiz.AppFactoryJob) []tuttigenerated.WorkspaceAppFactoryJob {
	result := make([]tuttigenerated.WorkspaceAppFactoryJob, 0, len(jobs))
	for _, job := range jobs {
		result = append(result, generatedAppFactoryJob(job))
	}
	return result
}

func generatedAppFactoryJob(job workspacebiz.AppFactoryJob) tuttigenerated.WorkspaceAppFactoryJob {
	return tuttigenerated.WorkspaceAppFactoryJob{
		AgentSessionId:   nullableGeneratedString(job.AgentSessionID),
		AppId:            nullableGeneratedString(job.AppID),
		CreatedAtUnixMs:  job.CreatedAtUnixMs,
		Description:      nullableGeneratedString(job.Description),
		DisplayName:      strings.TrimSpace(job.DisplayName),
		FailureReason:    nullableGeneratedString(job.FailureReason),
		JobId:            job.JobID,
		Model:            nullableGeneratedString(job.Model),
		Prompt:           job.Prompt,
		Provider:         nullableGeneratedString(job.Provider),
		ReasoningEffort:  nullableGeneratedString(job.ReasoningEffort),
		PublishedVersion: nullableGeneratedString(job.PublishedVersion),
		Status:           tuttigenerated.WorkspaceAppFactoryJobStatus(job.Status),
		UpdatedAtUnixMs:  job.UpdatedAtUnixMs,
		ValidationResult: generatedValidationResult(job.ValidationResultJSON),
		WorkspaceId:      job.WorkspaceID,
	}
}

func generatedValidationResult(raw string) *map[string]interface{} {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var result map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil
	}
	return &result
}

func nullableGeneratedString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func validateWorkspaceAppFactoryJobPath(workspaceIDValue tuttigenerated.WorkspaceID, jobIDValue tuttigenerated.WorkspaceAppFactoryJobID) (string, string, *tuttigenerated.InvalidRequestErrorJSONResponse) {
	workspaceID := strings.TrimSpace(string(workspaceIDValue))
	if workspaceID == "" {
		response := invalidWorkspaceIDError()
		return "", "", &response
	}
	jobID := strings.TrimSpace(string(jobIDValue))
	if jobID == "" {
		response := invalidRequestError(apierrors.MalformedRequest(apierrors.WithDeveloperMessage("app factory job id is required"), apierrors.WithParams(map[string]any{"field": "jobId"})))
		return "", "", &response
	}
	return workspaceID, jobID, nil
}

func invalidWorkspaceIDError() tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.MissingWorkspaceID(apierrors.WithDeveloperMessage("workspace id is required"), apierrors.WithParams(map[string]any{"field": "workspaceId"})))
}

func writeListWorkspaceAppFactoryJobsError(err error) tuttigenerated.ListWorkspaceAppFactoryJobsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.ListWorkspaceAppFactoryJobs404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.ListWorkspaceAppFactoryJobs400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.ListWorkspaceAppFactoryJobs502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCreateWorkspaceAppFactoryJobError(err error) tuttigenerated.CreateWorkspaceAppFactoryJobResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.CreateWorkspaceAppFactoryJob404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CreateWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.CreateWorkspaceAppFactoryJob502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeGetWorkspaceAppFactoryProviderComposerOptionsError(err error) tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptionsResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound:
		return tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptions404JSONResponse{WorkspaceNotFoundErrorJSONResponse: workspaceNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptions400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.GetWorkspaceAppFactoryProviderComposerOptions502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeGetWorkspaceAppFactoryJobError(err error) tuttigenerated.GetWorkspaceAppFactoryJobResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.GetWorkspaceAppFactoryJob404JSONResponse{WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.GetWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.GetWorkspaceAppFactoryJob502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeCancelWorkspaceAppFactoryJobError(err error) tuttigenerated.CancelWorkspaceAppFactoryJobResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.CancelWorkspaceAppFactoryJob404JSONResponse{WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.CancelWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.CancelWorkspaceAppFactoryJob502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeDeleteWorkspaceAppFactoryJobError(err error) tuttigenerated.DeleteWorkspaceAppFactoryJobResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.DeleteWorkspaceAppFactoryJob404JSONResponse{WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.DeleteWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.DeleteWorkspaceAppFactoryJob502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeRetryWorkspaceAppFactoryJobValidationError(err error) tuttigenerated.RetryWorkspaceAppFactoryJobValidationResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.RetryWorkspaceAppFactoryJobValidation404JSONResponse{WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.RetryWorkspaceAppFactoryJobValidation400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.RetryWorkspaceAppFactoryJobValidation502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writeFixWorkspaceAppFactoryJobError(err error) tuttigenerated.FixWorkspaceAppFactoryJobResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.FixWorkspaceAppFactoryJob404JSONResponse{WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.FixWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.FixWorkspaceAppFactoryJob502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writePrepareWorkspaceAppFactoryJobModificationError(err error) tuttigenerated.PrepareWorkspaceAppFactoryJobModificationResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.PrepareWorkspaceAppFactoryJobModification404JSONResponse{WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.PrepareWorkspaceAppFactoryJobModification400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.PrepareWorkspaceAppFactoryJobModification502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}

func writePublishWorkspaceAppFactoryJobError(err error) tuttigenerated.PublishWorkspaceAppFactoryJobResponseObject {
	protocolErr := apierrors.Classify(err)
	switch protocolErr.Code {
	case tuttigenerated.WorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound:
		return tuttigenerated.PublishWorkspaceAppFactoryJob404JSONResponse{WorkspaceAppNotFoundErrorJSONResponse: workspaceAppNotFoundError(protocolErr)}
	case tuttigenerated.InvalidRequest:
		return tuttigenerated.PublishWorkspaceAppFactoryJob400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(protocolErr)}
	default:
		return tuttigenerated.PublishWorkspaceAppFactoryJob502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(protocolErr)}
	}
}
