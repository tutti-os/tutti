package api

import (
	"context"
	"errors"
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	automationruleservice "github.com/tutti-os/tutti/services/tuttid/service/automationrule"
)

type AutomationRuleService interface {
	ListRules(context.Context, string) ([]automationrulebiz.Rule, error)
	GetRule(context.Context, string, string) (automationrulebiz.Rule, error)
	CreateRule(context.Context, automationruleservice.PutRuleInput) (automationrulebiz.Rule, error)
	UpdateRule(context.Context, automationruleservice.PutRuleInput) (automationrulebiz.Rule, error)
	DeleteRule(context.Context, string, string) error
	GetSessionOverride(context.Context, string, string) (automationrulebiz.SessionOverride, bool, error)
	SetSessionOverride(context.Context, automationrulebiz.SessionOverride) (automationrulebiz.SessionOverride, error)
}

func (api DaemonAPI) ListAutomationRules(ctx context.Context, request tuttigenerated.ListAutomationRulesRequestObject) (tuttigenerated.ListAutomationRulesResponseObject, error) {
	if api.AutomationRuleService == nil {
		return tuttigenerated.ListAutomationRules503JSONResponse{ServiceUnavailableErrorJSONResponse: automationRuleServiceUnavailable()}, nil
	}
	rules, err := api.AutomationRuleService.ListRules(ctx, request.WorkspaceID)
	if err != nil {
		return tuttigenerated.ListAutomationRules502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)))}, nil
	}
	response := tuttigenerated.ListAutomationRulesResponse{Rules: make([]tuttigenerated.AutomationRule, 0, len(rules))}
	for _, rule := range rules {
		response.Rules = append(response.Rules, generatedAutomationRule(rule))
	}
	return tuttigenerated.ListAutomationRules200JSONResponse(response), nil
}

func (api DaemonAPI) CreateAutomationRule(ctx context.Context, request tuttigenerated.CreateAutomationRuleRequestObject) (tuttigenerated.CreateAutomationRuleResponseObject, error) {
	if !api.automationRulesWritesEnabled(ctx) {
		return tuttigenerated.CreateAutomationRule400JSONResponse{InvalidRequestErrorJSONResponse: automationRulesWriteDisabledError()}, nil
	}
	if api.AutomationRuleService == nil {
		return tuttigenerated.CreateAutomationRule503JSONResponse{ServiceUnavailableErrorJSONResponse: automationRuleServiceUnavailable()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateAutomationRule400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody())}, nil
	}
	rule, err := api.AutomationRuleService.CreateRule(ctx, automationRulePutInput(request.WorkspaceID, "", *request.Body))
	if err != nil {
		return createAutomationRuleError(err), nil
	}
	return tuttigenerated.CreateAutomationRule201JSONResponse(generatedAutomationRule(rule)), nil
}

func (api DaemonAPI) GetAutomationRule(ctx context.Context, request tuttigenerated.GetAutomationRuleRequestObject) (tuttigenerated.GetAutomationRuleResponseObject, error) {
	if api.AutomationRuleService == nil {
		return tuttigenerated.GetAutomationRule503JSONResponse{ServiceUnavailableErrorJSONResponse: automationRuleServiceUnavailable()}, nil
	}
	rule, err := api.AutomationRuleService.GetRule(ctx, request.WorkspaceID, request.AutomationRuleID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrAutomationRuleNotFound) {
			return tuttigenerated.GetAutomationRule404JSONResponse{WorkspaceNotFoundErrorJSONResponse: automationRuleNotFoundError()}, nil
		}
		return tuttigenerated.GetAutomationRule502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)))}, nil
	}
	return tuttigenerated.GetAutomationRule200JSONResponse(generatedAutomationRule(rule)), nil
}

func (api DaemonAPI) UpdateAutomationRule(ctx context.Context, request tuttigenerated.UpdateAutomationRuleRequestObject) (tuttigenerated.UpdateAutomationRuleResponseObject, error) {
	if !api.automationRulesWritesEnabled(ctx) {
		return tuttigenerated.UpdateAutomationRule400JSONResponse{InvalidRequestErrorJSONResponse: automationRulesWriteDisabledError()}, nil
	}
	if api.AutomationRuleService == nil {
		return tuttigenerated.UpdateAutomationRule503JSONResponse{ServiceUnavailableErrorJSONResponse: automationRuleServiceUnavailable()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateAutomationRule400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody())}, nil
	}
	rule, err := api.AutomationRuleService.UpdateRule(ctx, automationRulePutInput(request.WorkspaceID, request.AutomationRuleID, *request.Body))
	if err != nil {
		if errors.Is(err, workspacedata.ErrAutomationRuleNotFound) {
			return tuttigenerated.UpdateAutomationRule404JSONResponse{WorkspaceNotFoundErrorJSONResponse: automationRuleNotFoundError()}, nil
		}
		if errors.Is(err, automationruleservice.ErrInvalidRuleInput) {
			return tuttigenerated.UpdateAutomationRule400JSONResponse{InvalidRequestErrorJSONResponse: invalidAutomationRuleRequest(err)}, nil
		}
		return tuttigenerated.UpdateAutomationRule502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)))}, nil
	}
	return tuttigenerated.UpdateAutomationRule200JSONResponse(generatedAutomationRule(rule)), nil
}

func (api DaemonAPI) DeleteAutomationRule(ctx context.Context, request tuttigenerated.DeleteAutomationRuleRequestObject) (tuttigenerated.DeleteAutomationRuleResponseObject, error) {
	if !api.automationRulesWritesEnabled(ctx) {
		return tuttigenerated.DeleteAutomationRule400JSONResponse{InvalidRequestErrorJSONResponse: automationRulesWriteDisabledError()}, nil
	}
	if api.AutomationRuleService == nil {
		return tuttigenerated.DeleteAutomationRule503JSONResponse{ServiceUnavailableErrorJSONResponse: automationRuleServiceUnavailable()}, nil
	}
	if err := api.AutomationRuleService.DeleteRule(ctx, request.WorkspaceID, request.AutomationRuleID); err != nil {
		if errors.Is(err, workspacedata.ErrAutomationRuleNotFound) {
			return tuttigenerated.DeleteAutomationRule404JSONResponse{WorkspaceNotFoundErrorJSONResponse: automationRuleNotFoundError()}, nil
		}
		return tuttigenerated.DeleteAutomationRule502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)))}, nil
	}
	return tuttigenerated.DeleteAutomationRule200JSONResponse{AutomationRuleId: request.AutomationRuleID}, nil
}

func (api DaemonAPI) GetAgentSessionAutomationRuleOverride(ctx context.Context, request tuttigenerated.GetAgentSessionAutomationRuleOverrideRequestObject) (tuttigenerated.GetAgentSessionAutomationRuleOverrideResponseObject, error) {
	if api.AutomationRuleService == nil {
		return tuttigenerated.GetAgentSessionAutomationRuleOverride503JSONResponse{ServiceUnavailableErrorJSONResponse: automationRuleServiceUnavailable()}, nil
	}
	override, ok, err := api.AutomationRuleService.GetSessionOverride(ctx, request.WorkspaceID, request.AgentSessionID)
	if err != nil {
		return tuttigenerated.GetAgentSessionAutomationRuleOverride502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)))}, nil
	}
	if !ok {
		override = automationrulebiz.SessionOverride{WorkspaceID: request.WorkspaceID, AgentSessionID: request.AgentSessionID}
	}
	return tuttigenerated.GetAgentSessionAutomationRuleOverride200JSONResponse(generatedAutomationRuleOverride(override)), nil
}

func (api DaemonAPI) SetAgentSessionAutomationRuleOverride(ctx context.Context, request tuttigenerated.SetAgentSessionAutomationRuleOverrideRequestObject) (tuttigenerated.SetAgentSessionAutomationRuleOverrideResponseObject, error) {
	if !api.automationRulesWritesEnabled(ctx) {
		return tuttigenerated.SetAgentSessionAutomationRuleOverride400JSONResponse{InvalidRequestErrorJSONResponse: automationRulesWriteDisabledError()}, nil
	}
	if api.AutomationRuleService == nil {
		return tuttigenerated.SetAgentSessionAutomationRuleOverride503JSONResponse{ServiceUnavailableErrorJSONResponse: automationRuleServiceUnavailable()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SetAgentSessionAutomationRuleOverride400JSONResponse{InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody())}, nil
	}
	override, err := api.AutomationRuleService.SetSessionOverride(ctx, automationrulebiz.SessionOverride{
		WorkspaceID: request.WorkspaceID, AgentSessionID: request.AgentSessionID,
		Disabled: request.Body.Disabled, RuleIDs: append([]string(nil), request.Body.RuleIds...),
	})
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrAutomationRuleNotFound):
			return tuttigenerated.SetAgentSessionAutomationRuleOverride404JSONResponse{WorkspaceNotFoundErrorJSONResponse: automationRuleNotFoundError()}, nil
		case errors.Is(err, automationruleservice.ErrInvalidRuleInput):
			return tuttigenerated.SetAgentSessionAutomationRuleOverride400JSONResponse{InvalidRequestErrorJSONResponse: invalidAutomationRuleRequest(err)}, nil
		}
		return tuttigenerated.SetAgentSessionAutomationRuleOverride502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)))}, nil
	}
	return tuttigenerated.SetAgentSessionAutomationRuleOverride200JSONResponse(generatedAutomationRuleOverride(override)), nil
}

func automationRulePutInput(workspaceID string, ruleID string, body tuttigenerated.PutAutomationRuleRequest) automationruleservice.PutRuleInput {
	return automationruleservice.PutRuleInput{
		WorkspaceID: workspaceID, RuleID: ruleID, Name: body.Name, Enabled: body.Enabled,
		Trigger:                automationrulebiz.Trigger(body.Trigger),
		SourceWorkspaceAgentID: stringValue(body.SourceWorkspaceAgentId),
		Target: automationrulebiz.Target{
			Kind: automationrulebiz.TargetKind(body.Target.Kind), WorkspaceAgentID: stringValue(body.Target.WorkspaceAgentId),
			ModelPlanID: stringValue(body.Target.ModelPlanId), Model: stringValue(body.Target.Model),
			RequiredCapabilities: append([]string(nil), body.Target.RequiredCapabilities...),
		},
		Permissions: automationrulebiz.PermissionPolicy{
			PermissionModeID: stringValue(body.Permissions.PermissionModeId), AllowedTools: append([]string(nil), body.Permissions.AllowedTools...),
		},
		Budget: automationrulebiz.Budget{
			MaxRunsPerSession: body.Budget.MaxRunsPerSession, MaxTotalTokensPerSession: body.Budget.MaxTotalTokensPerSession,
		},
		Prompt: body.Prompt,
	}
}

func generatedAutomationRule(rule automationrulebiz.Rule) tuttigenerated.AutomationRule {
	result := tuttigenerated.AutomationRule{
		Id: rule.ID, WorkspaceId: rule.WorkspaceID, Name: rule.Name, Enabled: rule.Enabled,
		Trigger: tuttigenerated.AutomationRuleTrigger(rule.Trigger), Prompt: rule.Prompt,
		Target: tuttigenerated.AutomationRuleTarget{
			Kind: tuttigenerated.AutomationRuleTargetKind(rule.Target.Kind), RequiredCapabilities: append([]string{}, rule.Target.RequiredCapabilities...),
		},
		Permissions: tuttigenerated.AutomationRulePermissions{AllowedTools: append([]string{}, rule.Permissions.AllowedTools...)},
		Budget:      tuttigenerated.AutomationRuleBudget{MaxRunsPerSession: rule.Budget.MaxRunsPerSession, MaxTotalTokensPerSession: rule.Budget.MaxTotalTokensPerSession},
		CreatedAt:   rule.CreatedAt, UpdatedAt: rule.UpdatedAt,
	}
	if rule.SourceWorkspaceAgentID != "" {
		result.SourceWorkspaceAgentId = stringPointer(rule.SourceWorkspaceAgentID)
	}
	if rule.Target.WorkspaceAgentID != "" {
		result.Target.WorkspaceAgentId = stringPointer(rule.Target.WorkspaceAgentID)
	}
	if rule.Target.ModelPlanID != "" {
		result.Target.ModelPlanId = stringPointer(rule.Target.ModelPlanID)
	}
	if rule.Target.Model != "" {
		result.Target.Model = stringPointer(rule.Target.Model)
	}
	if rule.Permissions.PermissionModeID != "" {
		result.Permissions.PermissionModeId = stringPointer(rule.Permissions.PermissionModeID)
	}
	return result
}

func generatedAutomationRuleOverride(override automationrulebiz.SessionOverride) tuttigenerated.AgentSessionAutomationRuleOverride {
	result := tuttigenerated.AgentSessionAutomationRuleOverride{
		WorkspaceId: override.WorkspaceID, AgentSessionId: override.AgentSessionID,
		Disabled: override.Disabled, RuleIds: append([]string{}, override.RuleIDs...),
	}
	if !override.UpdatedAt.IsZero() {
		updatedAt := override.UpdatedAt
		result.UpdatedAt = &updatedAt
	}
	return result
}

func createAutomationRuleError(err error) tuttigenerated.CreateAutomationRuleResponseObject {
	if errors.Is(err, automationruleservice.ErrInvalidRuleInput) {
		return tuttigenerated.CreateAutomationRule400JSONResponse{InvalidRequestErrorJSONResponse: invalidAutomationRuleRequest(err)}
	}
	return tuttigenerated.CreateAutomationRule502JSONResponse{WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)))}
}

func invalidAutomationRuleRequest(err error) tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.InvalidRequest("invalid_automation_rule", apierrors.WithDeveloperMessage(err.Error())))
}

func automationRuleServiceUnavailable() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable("automation_rule_service_unavailable", apierrors.WithDeveloperMessage("automation rule service is unavailable")))
}

func automationRuleNotFoundError() tuttigenerated.WorkspaceNotFoundErrorJSONResponse {
	return tuttigenerated.WorkspaceNotFoundErrorJSONResponse(protocolErrorResponse(apierrors.New(
		http.StatusNotFound, tuttigenerated.AutomationRuleNotFound, "automation_rule_not_found", apierrors.WithDeveloperMessage("automation rule not found"),
	)))
}
