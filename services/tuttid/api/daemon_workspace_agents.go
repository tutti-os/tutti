package api

import (
	"context"
	"errors"
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	workspaceagentservice "github.com/tutti-os/tutti/services/tuttid/service/workspaceagent"
)

type WorkspaceAgentService interface {
	List(context.Context, string) ([]workspaceagentbiz.View, error)
	Get(context.Context, string, string) (workspaceagentbiz.View, error)
	Create(context.Context, workspaceagentservice.PutInput) (workspaceagentbiz.View, error)
	GenerateConfiguration(context.Context, workspaceagentservice.GenerateInput) (workspaceagentservice.GeneratedConfiguration, error)
	Update(context.Context, workspaceagentservice.PutInput) (workspaceagentbiz.View, error)
	Delete(context.Context, string, string) error
}

func (api DaemonAPI) GenerateWorkspaceAgentDraft(ctx context.Context, request tuttigenerated.GenerateWorkspaceAgentDraftRequestObject) (tuttigenerated.GenerateWorkspaceAgentDraftResponseObject, error) {
	if api.WorkspaceAgentService == nil {
		return tuttigenerated.GenerateWorkspaceAgentDraft503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAgentServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.GenerateWorkspaceAgentDraft400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	generated, err := api.WorkspaceAgentService.GenerateConfiguration(ctx, workspaceagentservice.GenerateInput{
		WorkspaceID:          request.WorkspaceID,
		HarnessAgentTargetID: request.Body.HarnessAgentTargetId,
		ModelPlanID:          request.Body.ModelPlanId,
		Model:                stringValue(request.Body.Model),
		Requirements:         request.Body.Requirements,
	})
	if err != nil {
		switch {
		case errors.Is(err, workspaceagentservice.ErrGenerationUnavailable):
			return tuttigenerated.GenerateWorkspaceAgentDraft503JSONResponse{
				ServiceUnavailableErrorJSONResponse: workspaceAgentServiceUnavailable(),
			}, nil
		case errors.Is(err, workspacedata.ErrWorkspaceNotFound),
			errors.Is(err, workspacedata.ErrAgentTargetNotFound),
			errors.Is(err, workspacedata.ErrModelPlanNotFound):
			return tuttigenerated.GenerateWorkspaceAgentDraft404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceAgentDependencyNotFoundError(err),
			}, nil
		case isInvalidWorkspaceAgentError(err),
			errors.Is(err, workspaceagentservice.ErrHarnessDisabled),
			errors.Is(err, workspaceagentservice.ErrPlanNotUsable):
			return tuttigenerated.GenerateWorkspaceAgentDraft400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidWorkspaceAgentRequest(err),
			}, nil
		default:
			return tuttigenerated.GenerateWorkspaceAgentDraft502JSONResponse{
				WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
			}, nil
		}
	}
	return tuttigenerated.GenerateWorkspaceAgentDraft200JSONResponse(generatedWorkspaceAgentDraft(generated)), nil
}

func (api DaemonAPI) ListWorkspaceAgents(ctx context.Context, request tuttigenerated.ListWorkspaceAgentsRequestObject) (tuttigenerated.ListWorkspaceAgentsResponseObject, error) {
	if api.WorkspaceAgentService == nil {
		return tuttigenerated.ListWorkspaceAgents503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAgentServiceUnavailable(),
		}, nil
	}
	views, err := api.WorkspaceAgentService.List(ctx, request.WorkspaceID)
	if err != nil {
		if errors.Is(err, workspaceagentservice.ErrInvalidInput) {
			return tuttigenerated.ListWorkspaceAgents400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidWorkspaceAgentRequest(err),
			}, nil
		}
		return tuttigenerated.ListWorkspaceAgents502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	response := tuttigenerated.ListWorkspaceAgentsResponse{Agents: make([]tuttigenerated.WorkspaceAgent, 0, len(views))}
	for _, view := range views {
		response.Agents = append(response.Agents, generatedWorkspaceAgent(view))
	}
	return tuttigenerated.ListWorkspaceAgents200JSONResponse(response), nil
}

func (api DaemonAPI) GetWorkspaceAgent(ctx context.Context, request tuttigenerated.GetWorkspaceAgentRequestObject) (tuttigenerated.GetWorkspaceAgentResponseObject, error) {
	if api.WorkspaceAgentService == nil {
		return tuttigenerated.GetWorkspaceAgent503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAgentServiceUnavailable(),
		}, nil
	}
	view, err := api.WorkspaceAgentService.Get(ctx, request.WorkspaceID, request.WorkspaceAgentID)
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrWorkspaceAgentNotFound):
			return tuttigenerated.GetWorkspaceAgent404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceAgentNotFoundError(),
			}, nil
		case errors.Is(err, workspaceagentservice.ErrInvalidInput):
			return tuttigenerated.GetWorkspaceAgent400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidWorkspaceAgentRequest(err),
			}, nil
		}
		return tuttigenerated.GetWorkspaceAgent502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.GetWorkspaceAgent200JSONResponse(generatedWorkspaceAgent(view)), nil
}

func (api DaemonAPI) CreateWorkspaceAgent(ctx context.Context, request tuttigenerated.CreateWorkspaceAgentRequestObject) (tuttigenerated.CreateWorkspaceAgentResponseObject, error) {
	if api.WorkspaceAgentService == nil {
		return tuttigenerated.CreateWorkspaceAgent503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAgentServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceAgent400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	view, err := api.WorkspaceAgentService.Create(ctx, workspaceAgentPutInput(request.WorkspaceID, "", *request.Body))
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrWorkspaceNotFound),
			errors.Is(err, workspacedata.ErrAgentTargetNotFound),
			errors.Is(err, workspacedata.ErrModelPlanNotFound):
			return tuttigenerated.CreateWorkspaceAgent404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceAgentDependencyNotFoundError(err),
			}, nil
		case isInvalidWorkspaceAgentError(err):
			return tuttigenerated.CreateWorkspaceAgent400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidWorkspaceAgentRequest(err),
			}, nil
		}
		return tuttigenerated.CreateWorkspaceAgent502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.CreateWorkspaceAgent201JSONResponse(generatedWorkspaceAgent(view)), nil
}

func (api DaemonAPI) UpdateWorkspaceAgent(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentRequestObject) (tuttigenerated.UpdateWorkspaceAgentResponseObject, error) {
	if api.WorkspaceAgentService == nil {
		return tuttigenerated.UpdateWorkspaceAgent503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAgentServiceUnavailable(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgent400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	view, err := api.WorkspaceAgentService.Update(ctx, workspaceAgentPutInput(request.WorkspaceID, request.WorkspaceAgentID, *request.Body))
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrWorkspaceAgentNotFound):
			return tuttigenerated.UpdateWorkspaceAgent404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceAgentNotFoundError(),
			}, nil
		case errors.Is(err, workspacedata.ErrWorkspaceNotFound),
			errors.Is(err, workspacedata.ErrAgentTargetNotFound),
			errors.Is(err, workspacedata.ErrModelPlanNotFound):
			return tuttigenerated.UpdateWorkspaceAgent404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceAgentDependencyNotFoundError(err),
			}, nil
		case isInvalidWorkspaceAgentError(err):
			return tuttigenerated.UpdateWorkspaceAgent400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidWorkspaceAgentRequest(err),
			}, nil
		}
		return tuttigenerated.UpdateWorkspaceAgent502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.UpdateWorkspaceAgent200JSONResponse(generatedWorkspaceAgent(view)), nil
}

func (api DaemonAPI) DeleteWorkspaceAgent(ctx context.Context, request tuttigenerated.DeleteWorkspaceAgentRequestObject) (tuttigenerated.DeleteWorkspaceAgentResponseObject, error) {
	if api.WorkspaceAgentService == nil {
		return tuttigenerated.DeleteWorkspaceAgent503JSONResponse{
			ServiceUnavailableErrorJSONResponse: workspaceAgentServiceUnavailable(),
		}, nil
	}
	if err := api.WorkspaceAgentService.Delete(ctx, request.WorkspaceID, request.WorkspaceAgentID); err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrWorkspaceAgentNotFound):
			return tuttigenerated.DeleteWorkspaceAgent404JSONResponse{
				WorkspaceNotFoundErrorJSONResponse: workspaceAgentNotFoundError(),
			}, nil
		case errors.Is(err, workspaceagentservice.ErrInvalidInput):
			return tuttigenerated.DeleteWorkspaceAgent400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidWorkspaceAgentRequest(err),
			}, nil
		}
		return tuttigenerated.DeleteWorkspaceAgent502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.DeleteWorkspaceAgent200JSONResponse{
		WorkspaceAgentId: request.WorkspaceAgentID,
	}, nil
}

func workspaceAgentPutInput(workspaceID string, agentID string, body tuttigenerated.PutWorkspaceAgentRequest) workspaceagentservice.PutInput {
	return workspaceagentservice.PutInput{
		WorkspaceID:          workspaceID,
		AgentID:              agentID,
		Name:                 body.Name,
		Purpose:              body.Purpose,
		HarnessAgentTargetID: body.HarnessAgentTargetId,
		ModelPlanID:          stringValue(body.ModelPlanId),
		DefaultModel:         stringValue(body.DefaultModel),
		ModelFallbacks:       bizWorkspaceAgentModelRefs(body.ModelFallbacks),
		Instructions:         body.Instructions,
		CallConditions:       append([]string(nil), body.CallConditions...),
		CapabilitiesExplicit: body.CapabilitiesExplicit,
		Skills:               append([]string(nil), body.Skills...),
		Tools:                append([]string(nil), body.Tools...),
		Permissions:          append([]string(nil), body.Permissions...),
		Enabled:              body.Enabled,
	}
}

func generatedWorkspaceAgent(view workspaceagentbiz.View) tuttigenerated.WorkspaceAgent {
	agent := view.Agent
	result := tuttigenerated.WorkspaceAgent{
		Id:            agent.ID,
		AgentTargetId: agent.ID,
		WorkspaceId:   agent.WorkspaceID,
		Name:          agent.Name,
		Purpose:       agent.Purpose,
		Harness: tuttigenerated.WorkspaceAgentHarness{
			AgentTargetId: view.Harness.AgentTargetID,
			Available:     view.Harness.Available,
		},
		Instructions:         agent.Instructions,
		CallConditions:       append([]string{}, agent.CallConditions...),
		CapabilitiesExplicit: agent.CapabilitiesExplicit,
		Skills:               append([]string{}, agent.Skills...),
		Tools:                append([]string{}, agent.Tools...),
		Permissions:          append([]string{}, agent.Permissions...),
		ModelFallbacks:       generatedWorkspaceAgentModelRefs(agent.ModelFallbacks),
		Enabled:              agent.Enabled,
		Source:               tuttigenerated.WorkspaceAgentSource(agent.Source),
		Revision:             agent.Revision,
		CreatedAt:            agent.CreatedAt,
		UpdatedAt:            agent.UpdatedAt,
	}
	if agent.ModelPlanID != "" {
		result.ModelPlanId = stringPointer(agent.ModelPlanID)
	}
	if agent.DefaultModel != "" {
		result.DefaultModel = stringPointer(agent.DefaultModel)
	}
	if view.Harness.Available {
		provider := tuttigenerated.AgentTargetProvider(view.Harness.Provider)
		result.Harness.Provider = &provider
		result.Harness.Name = stringPointer(view.Harness.Name)
		result.Harness.IconKey = stringPointer(view.Harness.IconKey)
		result.Harness.Enabled = boolPointer(view.Harness.Enabled)
	}
	return result
}

func generatedWorkspaceAgentDraft(generated workspaceagentservice.GeneratedConfiguration) tuttigenerated.WorkspaceAgentDraftGeneration {
	rules := make([]tuttigenerated.WorkspaceAgentGeneratedAutomationRule, 0, len(generated.AutomationRules))
	for _, rule := range generated.AutomationRules {
		item := tuttigenerated.WorkspaceAgentGeneratedAutomationRule{
			Action:                   tuttigenerated.WorkspaceAgentGeneratedAutomationRuleAction(rule.Action),
			MaxRunsPerSession:        rule.MaxRunsPerSession,
			MaxTotalTokensPerSession: rule.MaxTotalTokensPerSession,
			ModelPlanId:              rule.ModelPlanID,
			Name:                     rule.Name,
			Prompt:                   rule.Prompt,
			Trigger:                  tuttigenerated.AutomationRuleTrigger(rule.Trigger),
		}
		if rule.Model != "" {
			item.Model = stringPointer(rule.Model)
		}
		rules = append(rules, item)
	}
	return tuttigenerated.WorkspaceAgentDraftGeneration{
		AutomationRules: rules,
		CallConditions:  append([]string{}, generated.CallConditions...),
		Instructions:    generated.Instructions,
		Name:            generated.Name,
		Purpose:         generated.Purpose,
		Skills:          append([]string{}, generated.Skills...),
		Usage: tuttigenerated.WorkspaceAgentGenerationUsage{
			InputTokens:  generated.Usage.InputTokens,
			OutputTokens: generated.Usage.OutputTokens,
		},
		UsedModel:       generated.UsedModel,
		UsedModelPlanId: generated.UsedModelPlanID,
	}
}

func bizWorkspaceAgentModelRefs(values *[]tuttigenerated.WorkspaceAgentModelRef) []workspaceagentbiz.ModelRef {
	if values == nil {
		return []workspaceagentbiz.ModelRef{}
	}
	result := make([]workspaceagentbiz.ModelRef, 0, len(*values))
	for _, value := range *values {
		result = append(result, workspaceagentbiz.ModelRef{
			ModelPlanID: value.ModelPlanId,
			Model:       stringValue(value.Model),
		})
	}
	return result
}

func generatedWorkspaceAgentModelRefs(values []workspaceagentbiz.ModelRef) []tuttigenerated.WorkspaceAgentModelRef {
	result := make([]tuttigenerated.WorkspaceAgentModelRef, 0, len(values))
	for _, value := range values {
		generated := tuttigenerated.WorkspaceAgentModelRef{ModelPlanId: value.ModelPlanID}
		if value.Model != "" {
			generated.Model = stringPointer(value.Model)
		}
		result = append(result, generated)
	}
	return result
}

func isInvalidWorkspaceAgentError(err error) bool {
	return errors.Is(err, workspaceagentservice.ErrInvalidInput) ||
		errors.Is(err, workspaceagentservice.ErrModelNotInPlan) ||
		errors.Is(err, workspaceagentservice.ErrHarnessPlanProtocolMismatch)
}

func invalidWorkspaceAgentRequest(err error) tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.InvalidRequest(
		"invalid_workspace_agent",
		apierrors.WithDeveloperMessage(err.Error()),
	))
}

func workspaceAgentServiceUnavailable() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable(
		"workspace_agent_service_unavailable",
		apierrors.WithDeveloperMessage("workspace agent service is unavailable"),
	))
}

func workspaceAgentNotFoundError() tuttigenerated.WorkspaceNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(
		apierrors.New(
			http.StatusNotFound,
			tuttigenerated.WorkspaceAgentNotFound,
			"workspace_agent_not_found",
			apierrors.WithDeveloperMessage("workspace agent not found"),
		),
	))
}

func workspaceAgentDependencyNotFoundError(err error) tuttigenerated.WorkspaceNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(
		apierrors.New(
			http.StatusNotFound,
			tuttigenerated.WorkspaceAgentNotFound,
			"workspace_agent_dependency_not_found",
			apierrors.WithCause(err),
		),
	))
}
