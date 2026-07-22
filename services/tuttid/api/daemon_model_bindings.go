package api

import (
	"context"
	"errors"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	modelbindingservice "github.com/tutti-os/tutti/services/tuttid/service/modelbinding"
)

type AgentModelBindingService interface {
	ListBindings(ctx context.Context, workspaceID string) ([]modelbindingbiz.Binding, error)
	SetBinding(ctx context.Context, input modelbindingservice.SetBindingInput) (modelbindingbiz.Binding, error)
}

func (api DaemonAPI) ListAgentModelBindings(ctx context.Context, request tuttigenerated.ListAgentModelBindingsRequestObject) (tuttigenerated.ListAgentModelBindingsResponseObject, error) {
	if api.AgentModelBindingService == nil {
		return tuttigenerated.ListAgentModelBindings503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelBindingServiceUnavailable(),
		}, nil
	}
	bindings, err := api.AgentModelBindingService.ListBindings(ctx, request.WorkspaceID)
	if err != nil {
		return tuttigenerated.ListAgentModelBindings502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	response := tuttigenerated.ListAgentModelBindingsResponse{Bindings: make([]tuttigenerated.AgentModelBinding, 0, len(bindings))}
	for _, binding := range bindings {
		response.Bindings = append(response.Bindings, generatedAgentModelBinding(binding))
	}
	return tuttigenerated.ListAgentModelBindings200JSONResponse(response), nil
}

func (api DaemonAPI) SetAgentModelBinding(ctx context.Context, request tuttigenerated.SetAgentModelBindingRequestObject) (tuttigenerated.SetAgentModelBindingResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.SetAgentModelBinding400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.AgentModelBindingService == nil {
		return tuttigenerated.SetAgentModelBinding503JSONResponse{
			ServiceUnavailableErrorJSONResponse: modelBindingServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SetAgentModelBinding400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	binding, err := api.AgentModelBindingService.SetBinding(ctx, modelbindingservice.SetBindingInput{
		WorkspaceID:   request.WorkspaceID,
		AgentTargetID: request.AgentTargetID,
		ModelPlanID:   stringValue(request.Body.ModelPlanId),
		DefaultModel:  stringValue(request.Body.DefaultModel),
		ModelPolicyID: stringValue(request.Body.ModelPolicyId),
	})
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrAgentTargetNotFound):
			return tuttigenerated.SetAgentModelBinding404JSONResponse{
				AgentTargetNotFoundErrorJSONResponse: agentTargetNotFoundError(),
			}, nil
		case errors.Is(err, modelbindingservice.ErrInvalidBindingInput),
			errors.Is(err, modelbindingservice.ErrPlanNotUsable),
			errors.Is(err, modelbindingservice.ErrModelNotInPlan),
			errors.Is(err, modelbindingservice.ErrPolicyNotUsable),
			errors.Is(err, modelbindingservice.ErrBindingReferenceUnusable):
			return tuttigenerated.SetAgentModelBinding400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_agent_model_binding", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.SetAgentModelBinding502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.SetAgentModelBinding200JSONResponse(generatedAgentModelBinding(binding)), nil
}

func generatedAgentModelBinding(binding modelbindingbiz.Binding) tuttigenerated.AgentModelBinding {
	result := tuttigenerated.AgentModelBinding{
		WorkspaceId:   binding.WorkspaceID,
		AgentTargetId: binding.AgentTargetID,
	}
	if binding.ModelPlanID != "" {
		result.ModelPlanId = stringPointer(binding.ModelPlanID)
	}
	if binding.DefaultModel != "" {
		result.DefaultModel = stringPointer(binding.DefaultModel)
	}
	if binding.ModelPolicyID != "" {
		result.ModelPolicyId = stringPointer(binding.ModelPolicyID)
	}
	if !binding.UpdatedAt.IsZero() {
		updatedAt := binding.UpdatedAt
		result.UpdatedAt = &updatedAt
	}
	return result
}

func agentTargetNotFoundError() tuttigenerated.AgentTargetNotFoundErrorJSONResponse {
	return tuttigenerated.AgentTargetNotFoundErrorJSONResponse(protocolErrorResponse(
		apierrors.New(404, tuttigenerated.AgentTargetNotFound, "agent_target_not_found", apierrors.WithDeveloperMessage("agent target not found")),
	))
}

func modelBindingServiceUnavailable() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable(
		"agent_model_binding_service_unavailable",
		apierrors.WithDeveloperMessage("agent model binding service is unavailable"),
	))
}
