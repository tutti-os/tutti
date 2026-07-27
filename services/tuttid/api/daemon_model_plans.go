package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
)

type ModelPlanService interface {
	ListPlans(ctx context.Context, workspaceID string) ([]modelplanbiz.PublicPlan, error)
	GetPlan(ctx context.Context, workspaceID string, planID string) (modelplanbiz.PublicPlan, error)
	CreatePlan(ctx context.Context, input modelplanservice.PutPlanInput) (modelplanbiz.PublicPlan, error)
	UpdatePlan(ctx context.Context, input modelplanservice.PutPlanInput) (modelplanbiz.PublicPlan, error)
	DuplicatePlan(ctx context.Context, workspaceID string, planID string, name string) (modelplanbiz.PublicPlan, error)
	SetPlanEnabled(ctx context.Context, workspaceID string, planID string, enabled bool) (modelplanbiz.PublicPlan, error)
	DeletePlan(ctx context.Context, workspaceID string, planID string) error
	PlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error)
	Detect(ctx context.Context, input modelplanservice.DetectInput) (modelplanservice.DetectResult, error)
}

func (api DaemonAPI) ListModelPlans(ctx context.Context, request tuttigenerated.ListModelPlansRequestObject) (tuttigenerated.ListModelPlansResponseObject, error) {
	if api.ModelPlanService == nil {
		return tuttigenerated.ListModelPlans503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	plans, err := api.ModelPlanService.ListPlans(ctx, request.WorkspaceID)
	if err != nil {
		return tuttigenerated.ListModelPlans502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	response := tuttigenerated.ListModelPlansResponse{Plans: make([]tuttigenerated.ModelPlan, 0, len(plans))}
	for _, plan := range plans {
		response.Plans = append(response.Plans, generatedModelPlan(plan))
	}
	return tuttigenerated.ListModelPlans200JSONResponse(response), nil
}

func (api DaemonAPI) GetModelPlan(ctx context.Context, request tuttigenerated.GetModelPlanRequestObject) (tuttigenerated.GetModelPlanResponseObject, error) {
	if api.ModelPlanService == nil {
		return tuttigenerated.GetModelPlan503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	plan, err := api.ModelPlanService.GetPlan(ctx, request.WorkspaceID, request.ModelPlanID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrModelPlanNotFound) {
			return tuttigenerated.GetModelPlan404JSONResponse{
				ModelPlanNotFoundErrorJSONResponse: modelPlanNotFoundError(),
			}, nil
		}
		return tuttigenerated.GetModelPlan502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.GetModelPlan200JSONResponse(generatedModelPlan(plan)), nil
}

func (api DaemonAPI) CreateModelPlan(ctx context.Context, request tuttigenerated.CreateModelPlanRequestObject) (tuttigenerated.CreateModelPlanResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.CreateModelPlan400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPlanService == nil {
		return tuttigenerated.CreateModelPlan503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateModelPlan400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	plan, err := api.ModelPlanService.CreatePlan(ctx, putPlanInputFromRequest(request.WorkspaceID, "", *request.Body))
	if err != nil {
		if errors.Is(err, modelplanservice.ErrInvalidPlanInput) {
			return tuttigenerated.CreateModelPlan400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_model_plan", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.CreateModelPlan502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.CreateModelPlan200JSONResponse(generatedModelPlan(plan)), nil
}

func (api DaemonAPI) UpdateModelPlan(ctx context.Context, request tuttigenerated.UpdateModelPlanRequestObject) (tuttigenerated.UpdateModelPlanResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.UpdateModelPlan400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPlanService == nil {
		return tuttigenerated.UpdateModelPlan503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateModelPlan400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	plan, err := api.ModelPlanService.UpdatePlan(ctx, putPlanInputFromRequest(request.WorkspaceID, request.ModelPlanID, *request.Body))
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrModelPlanNotFound):
			return tuttigenerated.UpdateModelPlan404JSONResponse{
				ModelPlanNotFoundErrorJSONResponse: modelPlanNotFoundError(),
			}, nil
		case errors.Is(err, modelplanservice.ErrInvalidPlanInput):
			return tuttigenerated.UpdateModelPlan400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_model_plan", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.UpdateModelPlan502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.UpdateModelPlan200JSONResponse(generatedModelPlan(plan)), nil
}

func (api DaemonAPI) DeleteModelPlan(ctx context.Context, request tuttigenerated.DeleteModelPlanRequestObject) (tuttigenerated.DeleteModelPlanResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.DeleteModelPlan400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPlanService == nil {
		return tuttigenerated.DeleteModelPlan503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	if err := api.ModelPlanService.DeletePlan(ctx, request.WorkspaceID, request.ModelPlanID); err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrModelPlanNotFound):
			return tuttigenerated.DeleteModelPlan404JSONResponse{
				ModelPlanNotFoundErrorJSONResponse: modelPlanNotFoundError(),
			}, nil
		case errors.Is(err, modelplanservice.ErrPlanReferenced):
			return tuttigenerated.DeleteModelPlan409JSONResponse{
				ModelPlanReferencedErrorJSONResponse: tuttigenerated.ModelPlanReferencedErrorJSONResponse(protocolErrorResponse(
					apierrors.New(http.StatusConflict, tuttigenerated.ModelPlanReferenced, "model_plan_referenced", apierrors.WithDeveloperMessage(err.Error())),
				)),
			}, nil
		}
		return tuttigenerated.DeleteModelPlan502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.DeleteModelPlan200JSONResponse(tuttigenerated.DeleteModelPlanResponse{ModelPlanId: request.ModelPlanID}), nil
}

func (api DaemonAPI) DuplicateModelPlan(ctx context.Context, request tuttigenerated.DuplicateModelPlanRequestObject) (tuttigenerated.DuplicateModelPlanResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.DuplicateModelPlan400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPlanService == nil {
		return tuttigenerated.DuplicateModelPlan503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	name := ""
	if request.Body != nil && request.Body.Name != nil {
		name = *request.Body.Name
	}
	plan, err := api.ModelPlanService.DuplicatePlan(ctx, request.WorkspaceID, request.ModelPlanID, name)
	if err != nil {
		if errors.Is(err, workspacedata.ErrModelPlanNotFound) {
			return tuttigenerated.DuplicateModelPlan404JSONResponse{
				ModelPlanNotFoundErrorJSONResponse: modelPlanNotFoundError(),
			}, nil
		}
		return tuttigenerated.DuplicateModelPlan502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.DuplicateModelPlan200JSONResponse(generatedModelPlan(plan)), nil
}

func (api DaemonAPI) SetModelPlanEnabled(ctx context.Context, request tuttigenerated.SetModelPlanEnabledRequestObject) (tuttigenerated.SetModelPlanEnabledResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.SetModelPlanEnabled400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPlanService == nil {
		return tuttigenerated.SetModelPlanEnabled503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	if request.Body == nil || request.Body.Enabled == nil {
		return tuttigenerated.SetModelPlanEnabled400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_model_plan_enabled_update", apierrors.WithDeveloperMessage("enabled is required"))),
		}, nil
	}
	plan, err := api.ModelPlanService.SetPlanEnabled(ctx, request.WorkspaceID, request.ModelPlanID, *request.Body.Enabled)
	if err != nil {
		if errors.Is(err, workspacedata.ErrModelPlanNotFound) {
			return tuttigenerated.SetModelPlanEnabled404JSONResponse{
				ModelPlanNotFoundErrorJSONResponse: modelPlanNotFoundError(),
			}, nil
		}
		return tuttigenerated.SetModelPlanEnabled502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.SetModelPlanEnabled200JSONResponse(generatedModelPlan(plan)), nil
}

func (api DaemonAPI) ListModelPlanReferences(ctx context.Context, request tuttigenerated.ListModelPlanReferencesRequestObject) (tuttigenerated.ListModelPlanReferencesResponseObject, error) {
	if api.ModelPlanService == nil {
		return tuttigenerated.ListModelPlanReferences503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	references, err := api.ModelPlanService.PlanReferences(ctx, request.WorkspaceID, request.ModelPlanID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrModelPlanNotFound) {
			return tuttigenerated.ListModelPlanReferences404JSONResponse{
				ModelPlanNotFoundErrorJSONResponse: modelPlanNotFoundError(),
			}, nil
		}
		return tuttigenerated.ListModelPlanReferences502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	response := tuttigenerated.ModelPlanReferencesResponse{References: make([]tuttigenerated.ModelPlanReference, 0, len(references))}
	for _, reference := range references {
		response.References = append(response.References, generatedModelPlanReference(reference))
	}
	return tuttigenerated.ListModelPlanReferences200JSONResponse(response), nil
}

func (api DaemonAPI) DetectModelPlan(ctx context.Context, request tuttigenerated.DetectModelPlanRequestObject) (tuttigenerated.DetectModelPlanResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.DetectModelPlan400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPlanService == nil {
		return tuttigenerated.DetectModelPlan503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelPlanServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.DetectModelPlan400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	templateKind := ""
	if request.Body.TemplateKind != nil {
		templateKind = string(*request.Body.TemplateKind)
	}
	input := modelplanservice.DetectInput{
		WorkspaceID:  request.WorkspaceID,
		PlanID:       stringValue(request.Body.PlanId),
		TemplateKind: templateKind,
		Protocol:     string(protocolValue(request.Body.Protocol)),
		BaseURL:      stringValue(request.Body.BaseUrl),
		APIKey:       request.Body.ApiKey,
		Models:       bizModelPlanModels(request.Body.Models),
		Model:        stringValue(request.Body.Model),
	}
	result, err := api.ModelPlanService.Detect(ctx, input)
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrModelPlanNotFound):
			return tuttigenerated.DetectModelPlan404JSONResponse{
				ModelPlanNotFoundErrorJSONResponse: modelPlanNotFoundError(),
			}, nil
		case errors.Is(err, modelplanservice.ErrDetectionInput):
			return tuttigenerated.DetectModelPlan400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_model_plan_detection", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.DetectModelPlan502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	response := tuttigenerated.DetectModelPlanResponse{
		Detection:        generatedModelPlanDetection(result.Detection),
		DiscoveredModels: generatedModelPlanModels(result.DiscoveredModels),
	}
	return tuttigenerated.DetectModelPlan200JSONResponse(response), nil
}

func putPlanInputFromRequest(workspaceID string, planID string, body tuttigenerated.PutModelPlanRequest) modelplanservice.PutPlanInput {
	templateKind := ""
	if body.TemplateKind != nil {
		templateKind = string(*body.TemplateKind)
	}
	enabled := false
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	return modelplanservice.PutPlanInput{
		WorkspaceID:  workspaceID,
		PlanID:       planID,
		Name:         body.Name,
		TemplateKind: templateKind,
		Protocol:     string(body.Protocol),
		APIKey:       body.ApiKey,
		BaseURL:      stringValue(body.BaseUrl),
		Models:       bizModelPlanModels(body.Models),
		DefaultModel: stringValue(body.DefaultModel),
		Enabled:      enabled,
	}
}

func bizModelPlanModels(models *[]tuttigenerated.ModelPlanModel) []modelplanbiz.Model {
	if models == nil {
		return nil
	}
	result := make([]modelplanbiz.Model, 0, len(*models))
	for _, model := range *models {
		capabilities := []string(nil)
		if model.Capabilities != nil {
			capabilities = *model.Capabilities
		}
		result = append(result, modelplanbiz.Model{ID: model.Id, Name: model.Name, Capabilities: capabilities})
	}
	return result
}

func generatedModelPlan(plan modelplanbiz.PublicPlan) tuttigenerated.ModelPlan {
	result := tuttigenerated.ModelPlan{
		Id:           plan.ID,
		WorkspaceId:  plan.WorkspaceID,
		Revision:     int64(plan.Revision),
		Name:         plan.Name,
		TemplateKind: tuttigenerated.ModelPlanTemplateKind(plan.TemplateKind),
		Protocol:     tuttigenerated.ModelPlanProtocol(plan.Protocol),
		HasApiKey:    plan.HasAPIKey,
		Models:       generatedModelPlanModels(plan.Models),
		Enabled:      plan.Enabled,
		Status:       tuttigenerated.ModelPlanStatus(plan.Status),
		Detection:    generatedModelPlanDetection(plan.Detection),
		CreatedAt:    plan.CreatedAt,
		UpdatedAt:    plan.UpdatedAt,
	}
	if plan.BaseURL != "" {
		result.BaseUrl = stringPointer(plan.BaseURL)
	}
	if plan.DefaultModel != "" {
		result.DefaultModel = stringPointer(plan.DefaultModel)
	}
	return result
}

func generatedModelPlanModels(models []modelplanbiz.Model) []tuttigenerated.ModelPlanModel {
	result := make([]tuttigenerated.ModelPlanModel, 0, len(models))
	for _, model := range models {
		generated := tuttigenerated.ModelPlanModel{Id: model.ID, Name: model.Name}
		if len(model.Capabilities) > 0 {
			capabilities := append([]string(nil), model.Capabilities...)
			generated.Capabilities = &capabilities
		}
		result = append(result, generated)
	}
	return result
}

func generatedModelPlanDetection(detection modelplanbiz.DetectionSnapshot) tuttigenerated.ModelPlanDetection {
	result := tuttigenerated.ModelPlanDetection{
		Stages: make([]tuttigenerated.ModelPlanStageResult, 0, len(detection.Stages)),
	}
	if !detection.CheckedAt.IsZero() {
		checkedAt := detection.CheckedAt
		result.CheckedAt = &checkedAt
	}
	if detection.Model != "" {
		result.Model = stringPointer(detection.Model)
	}
	for _, stage := range detection.Stages {
		generated := tuttigenerated.ModelPlanStageResult{
			Stage:  tuttigenerated.ModelPlanDetectionStage(stage.Stage),
			Status: tuttigenerated.ModelPlanStageStatus(stage.Status),
		}
		if stage.LatencyMs > 0 {
			latency := stage.LatencyMs
			generated.LatencyMs = &latency
		}
		if stage.FailureReason != "" {
			generated.FailureReason = stringPointer(stage.FailureReason)
		}
		if stage.Remedy != "" {
			generated.Remedy = stringPointer(stage.Remedy)
		}
		if stage.Detail != "" {
			generated.Detail = stringPointer(stage.Detail)
		}
		if !stage.CheckedAt.IsZero() {
			checkedAt := stage.CheckedAt
			generated.CheckedAt = &checkedAt
		}
		result.Stages = append(result.Stages, generated)
	}
	return result
}

func generatedModelPlanReference(reference modelplanbiz.Reference) tuttigenerated.ModelPlanReference {
	result := tuttigenerated.ModelPlanReference{
		Kind: tuttigenerated.ModelPlanReferenceKind(reference.Kind),
		Id:   reference.ID,
	}
	if reference.Name != "" {
		result.Name = stringPointer(reference.Name)
	}
	if reference.Role != "" {
		result.Role = stringPointer(reference.Role)
	}
	return result
}

func modelPlanServiceUnavailable() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable(
		"model_plan_service_unavailable",
		apierrors.WithDeveloperMessage("model plan service is unavailable"),
	))
}

func modelPlanNotFoundError() tuttigenerated.ModelPlanNotFoundErrorJSONResponse {
	return tuttigenerated.ModelPlanNotFoundErrorJSONResponse(protocolErrorResponse(
		apierrors.New(http.StatusNotFound, tuttigenerated.ModelPlanNotFound, "model_plan_not_found", apierrors.WithDeveloperMessage("model plan not found")),
	))
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func protocolValue(value *tuttigenerated.ModelPlanProtocol) tuttigenerated.ModelPlanProtocol {
	if value == nil {
		return ""
	}
	return *value
}
