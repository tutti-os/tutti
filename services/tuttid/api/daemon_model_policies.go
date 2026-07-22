package api

import (
	"context"
	"errors"
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	modelpolicyservice "github.com/tutti-os/tutti/services/tuttid/service/modelpolicy"
)

type ModelPolicyService interface {
	ListPolicies(ctx context.Context, workspaceID string) ([]modelpolicybiz.Policy, error)
	GetPolicy(ctx context.Context, workspaceID string, policyID string) (modelpolicybiz.Policy, error)
	PutPolicy(ctx context.Context, input modelpolicyservice.PutPolicyInput) (modelpolicybiz.Policy, error)
	DeletePolicy(ctx context.Context, workspaceID string, policyID string) error
	GetSessionOverride(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.SessionOverride, bool, error)
	SetSessionOverride(ctx context.Context, override modelpolicybiz.SessionOverride) (modelpolicybiz.SessionOverride, error)
	GetAcceptance(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.Acceptance, bool, error)
	MarkUserAccepted(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.Acceptance, error)
}

func (api DaemonAPI) ListModelPolicies(ctx context.Context, request tuttigenerated.ListModelPoliciesRequestObject) (tuttigenerated.ListModelPoliciesResponseObject, error) {
	if api.ModelPolicyService == nil {
		return tuttigenerated.ListModelPolicies503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	policies, err := api.ModelPolicyService.ListPolicies(ctx, request.WorkspaceID)
	if err != nil {
		return tuttigenerated.ListModelPolicies502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	response := tuttigenerated.ListModelPoliciesResponse{Policies: make([]tuttigenerated.ModelUsagePolicy, 0, len(policies))}
	for _, policy := range policies {
		response.Policies = append(response.Policies, generatedModelPolicy(policy))
	}
	return tuttigenerated.ListModelPolicies200JSONResponse(response), nil
}

func (api DaemonAPI) CreateModelPolicy(ctx context.Context, request tuttigenerated.CreateModelPolicyRequestObject) (tuttigenerated.CreateModelPolicyResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.CreateModelPolicy400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPolicyService == nil {
		return tuttigenerated.CreateModelPolicy503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateModelPolicy400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	policy, err := api.ModelPolicyService.PutPolicy(ctx, putModelPolicyInputFromRequest(request.WorkspaceID, "", *request.Body))
	if err != nil {
		if errors.Is(err, modelpolicyservice.ErrInvalidPolicyInput) {
			return tuttigenerated.CreateModelPolicy400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_model_policy", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.CreateModelPolicy502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.CreateModelPolicy200JSONResponse(generatedModelPolicy(policy)), nil
}

func (api DaemonAPI) GetModelPolicy(ctx context.Context, request tuttigenerated.GetModelPolicyRequestObject) (tuttigenerated.GetModelPolicyResponseObject, error) {
	if api.ModelPolicyService == nil {
		return tuttigenerated.GetModelPolicy503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	policy, err := api.ModelPolicyService.GetPolicy(ctx, request.WorkspaceID, request.ModelPolicyID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrModelPolicyNotFound) {
			return tuttigenerated.GetModelPolicy404JSONResponse{WorkspaceNotFoundErrorJSONResponse: modelPolicyNotFoundError()}, nil
		}
		return tuttigenerated.GetModelPolicy502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.GetModelPolicy200JSONResponse(generatedModelPolicy(policy)), nil
}

func (api DaemonAPI) UpdateModelPolicy(ctx context.Context, request tuttigenerated.UpdateModelPolicyRequestObject) (tuttigenerated.UpdateModelPolicyResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.UpdateModelPolicy400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPolicyService == nil {
		return tuttigenerated.UpdateModelPolicy503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateModelPolicy400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	if _, err := api.ModelPolicyService.GetPolicy(ctx, request.WorkspaceID, request.ModelPolicyID); err != nil {
		if errors.Is(err, workspacedata.ErrModelPolicyNotFound) {
			return tuttigenerated.UpdateModelPolicy404JSONResponse{WorkspaceNotFoundErrorJSONResponse: modelPolicyNotFoundError()}, nil
		}
		return tuttigenerated.UpdateModelPolicy502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	policy, err := api.ModelPolicyService.PutPolicy(ctx, putModelPolicyInputFromRequest(request.WorkspaceID, request.ModelPolicyID, *request.Body))
	if err != nil {
		if errors.Is(err, modelpolicyservice.ErrInvalidPolicyInput) {
			return tuttigenerated.UpdateModelPolicy400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_model_policy", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.UpdateModelPolicy502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.UpdateModelPolicy200JSONResponse(generatedModelPolicy(policy)), nil
}

func (api DaemonAPI) DeleteModelPolicy(ctx context.Context, request tuttigenerated.DeleteModelPolicyRequestObject) (tuttigenerated.DeleteModelPolicyResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.DeleteModelPolicy400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPolicyService == nil {
		return tuttigenerated.DeleteModelPolicy503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	if err := api.ModelPolicyService.DeletePolicy(ctx, request.WorkspaceID, request.ModelPolicyID); err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrModelPolicyNotFound):
			return tuttigenerated.DeleteModelPolicy404JSONResponse{WorkspaceNotFoundErrorJSONResponse: modelPolicyNotFoundError()}, nil
		case errors.Is(err, modelpolicyservice.ErrPolicyReferenced):
			return tuttigenerated.DeleteModelPolicy409JSONResponse{
				ModelPolicyReferencedErrorJSONResponse: tuttigenerated.ModelPolicyReferencedErrorJSONResponse(protocolErrorResponse(
					apierrors.New(http.StatusConflict, tuttigenerated.ModelPolicyReferenced, "model_policy_referenced", apierrors.WithDeveloperMessage(err.Error())),
				)),
			}, nil
		}
		return tuttigenerated.DeleteModelPolicy502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.DeleteModelPolicy200JSONResponse(tuttigenerated.DeleteModelPolicyResponse{ModelPolicyId: request.ModelPolicyID}), nil
}

func (api DaemonAPI) GetAgentSessionModelPolicyOverride(ctx context.Context, request tuttigenerated.GetAgentSessionModelPolicyOverrideRequestObject) (tuttigenerated.GetAgentSessionModelPolicyOverrideResponseObject, error) {
	if api.ModelPolicyService == nil {
		return tuttigenerated.GetAgentSessionModelPolicyOverride503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	override, ok, err := api.ModelPolicyService.GetSessionOverride(ctx, request.WorkspaceID, request.AgentSessionID)
	if err != nil {
		return tuttigenerated.GetAgentSessionModelPolicyOverride502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	if !ok {
		override = modelpolicybiz.SessionOverride{WorkspaceID: request.WorkspaceID, AgentSessionID: request.AgentSessionID}
	}
	return tuttigenerated.GetAgentSessionModelPolicyOverride200JSONResponse(generatedSessionPolicyOverride(override)), nil
}

func (api DaemonAPI) SetAgentSessionModelPolicyOverride(ctx context.Context, request tuttigenerated.SetAgentSessionModelPolicyOverrideRequestObject) (tuttigenerated.SetAgentSessionModelPolicyOverrideResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.SetAgentSessionModelPolicyOverride400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPolicyService == nil {
		return tuttigenerated.SetAgentSessionModelPolicyOverride503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SetAgentSessionModelPolicyOverride400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody()),
		}, nil
	}
	override, err := api.ModelPolicyService.SetSessionOverride(ctx, modelpolicybiz.SessionOverride{
		WorkspaceID:    request.WorkspaceID,
		AgentSessionID: request.AgentSessionID,
		Disabled:       request.Body.Disabled,
		ModelPolicyID:  stringValue(request.Body.ModelPolicyId),
	})
	if err != nil {
		switch {
		case errors.Is(err, workspacedata.ErrModelPolicyNotFound):
			return tuttigenerated.SetAgentSessionModelPolicyOverride404JSONResponse{WorkspaceNotFoundErrorJSONResponse: modelPolicyNotFoundError()}, nil
		case errors.Is(err, modelpolicyservice.ErrInvalidPolicyInput):
			return tuttigenerated.SetAgentSessionModelPolicyOverride400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_model_policy_override", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.SetAgentSessionModelPolicyOverride502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	return tuttigenerated.SetAgentSessionModelPolicyOverride200JSONResponse(generatedSessionPolicyOverride(override)), nil
}

func (api DaemonAPI) GetAgentSessionAcceptance(ctx context.Context, request tuttigenerated.GetAgentSessionAcceptanceRequestObject) (tuttigenerated.GetAgentSessionAcceptanceResponseObject, error) {
	if api.ModelPolicyService == nil {
		return tuttigenerated.GetAgentSessionAcceptance503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	acceptance, ok, err := api.ModelPolicyService.GetAcceptance(ctx, request.WorkspaceID, request.AgentSessionID)
	if err != nil {
		return tuttigenerated.GetAgentSessionAcceptance502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	response := tuttigenerated.AgentSessionAcceptanceResponse{}
	if ok {
		generated := generatedSessionAcceptance(acceptance)
		response.Acceptance = &generated
	}
	return tuttigenerated.GetAgentSessionAcceptance200JSONResponse(response), nil
}

func (api DaemonAPI) AcceptAgentSessionWork(ctx context.Context, request tuttigenerated.AcceptAgentSessionWorkRequestObject) (tuttigenerated.AcceptAgentSessionWorkResponseObject, error) {
	if !api.modelPlansWritesEnabled(ctx) {
		return tuttigenerated.AcceptAgentSessionWork400JSONResponse{
			InvalidRequestErrorJSONResponse: modelPlansWriteDisabledError(),
		}, nil
	}
	if api.ModelPolicyService == nil {
		return tuttigenerated.AcceptAgentSessionWork503JSONResponse{ServiceUnavailableErrorJSONResponse: modelPolicyServiceUnavailable()}, nil
	}
	acceptance, err := api.ModelPolicyService.MarkUserAccepted(ctx, request.WorkspaceID, request.AgentSessionID)
	if err != nil {
		if errors.Is(err, modelpolicyservice.ErrInvalidPolicyInput) {
			return tuttigenerated.AcceptAgentSessionWork400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest("invalid_acceptance_request", apierrors.WithDeveloperMessage(err.Error()))),
			}, nil
		}
		return tuttigenerated.AcceptAgentSessionWork502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(apierrors.WorkspaceOperationFailed(apierrors.WithCause(err))),
		}, nil
	}
	generated := generatedSessionAcceptance(acceptance)
	return tuttigenerated.AcceptAgentSessionWork200JSONResponse(tuttigenerated.AgentSessionAcceptanceResponse{Acceptance: &generated}), nil
}

func putModelPolicyInputFromRequest(workspaceID string, policyID string, body tuttigenerated.PutModelPolicyRequest) modelpolicyservice.PutPolicyInput {
	input := modelpolicyservice.PutPolicyInput{
		WorkspaceID: workspaceID,
		PolicyID:    policyID,
		Name:        body.Name,
	}
	input.Execution = bizPlanModelRef(body.Execution)
	input.Planning = bizPlanModelRef(body.Planning)
	input.Review = bizPlanModelRef(body.Review)
	if body.ReviewRule != nil {
		input.ReviewRule = modelpolicybiz.ReviewRule{Enabled: body.ReviewRule.Enabled}
		if body.ReviewRule.Trigger != nil {
			input.ReviewRule.Trigger = modelpolicybiz.ReviewTrigger(*body.ReviewRule.Trigger)
		}
		if body.ReviewRule.MaxRunsPerSession != nil {
			input.ReviewRule.MaxRunsPerSession = *body.ReviewRule.MaxRunsPerSession
		}
		if body.ReviewRule.MaxTotalTokensPerSession != nil {
			input.ReviewRule.MaxTotalTokensPerSession = *body.ReviewRule.MaxTotalTokensPerSession
		}
	}
	return input
}

func bizPlanModelRef(ref *tuttigenerated.PlanModelRef) modelpolicybiz.PlanModelRef {
	if ref == nil {
		return modelpolicybiz.PlanModelRef{}
	}
	return modelpolicybiz.PlanModelRef{
		ModelPlanID: stringValue(ref.ModelPlanId),
		Model:       stringValue(ref.Model),
	}
}

func generatedModelPolicy(policy modelpolicybiz.Policy) tuttigenerated.ModelUsagePolicy {
	result := tuttigenerated.ModelUsagePolicy{
		Id:          policy.ID,
		WorkspaceId: policy.WorkspaceID,
		Name:        policy.Name,
		ReviewRule:  generatedReviewRule(policy.ReviewRule),
		CreatedAt:   policy.CreatedAt,
		UpdatedAt:   policy.UpdatedAt,
	}
	if !policy.Execution.IsZero() {
		ref := generatedPlanModelRef(policy.Execution)
		result.Execution = &ref
	}
	if !policy.Planning.IsZero() {
		ref := generatedPlanModelRef(policy.Planning)
		result.Planning = &ref
	}
	if !policy.Review.IsZero() {
		ref := generatedPlanModelRef(policy.Review)
		result.Review = &ref
	}
	return result
}

func generatedPlanModelRef(ref modelpolicybiz.PlanModelRef) tuttigenerated.PlanModelRef {
	result := tuttigenerated.PlanModelRef{}
	if ref.ModelPlanID != "" {
		result.ModelPlanId = stringPointer(ref.ModelPlanID)
	}
	if ref.Model != "" {
		result.Model = stringPointer(ref.Model)
	}
	return result
}

func generatedReviewRule(rule modelpolicybiz.ReviewRule) tuttigenerated.ModelPolicyReviewRule {
	result := tuttigenerated.ModelPolicyReviewRule{Enabled: rule.Enabled}
	if rule.Trigger != "" {
		trigger := tuttigenerated.ModelPolicyReviewRuleTrigger(rule.Trigger)
		result.Trigger = &trigger
	}
	if rule.MaxRunsPerSession > 0 {
		maxRuns := rule.MaxRunsPerSession
		result.MaxRunsPerSession = &maxRuns
	}
	if rule.MaxTotalTokensPerSession > 0 {
		maxTokens := rule.MaxTotalTokensPerSession
		result.MaxTotalTokensPerSession = &maxTokens
	}
	return result
}

func generatedSessionPolicyOverride(override modelpolicybiz.SessionOverride) tuttigenerated.AgentSessionModelPolicyOverride {
	result := tuttigenerated.AgentSessionModelPolicyOverride{
		WorkspaceId:    override.WorkspaceID,
		AgentSessionId: override.AgentSessionID,
		Disabled:       override.Disabled,
	}
	if override.ModelPolicyID != "" {
		result.ModelPolicyId = stringPointer(override.ModelPolicyID)
	}
	if !override.UpdatedAt.IsZero() {
		updatedAt := override.UpdatedAt
		result.UpdatedAt = &updatedAt
	}
	return result
}

func generatedSessionAcceptance(acceptance modelpolicybiz.Acceptance) tuttigenerated.AgentSessionAcceptance {
	result := tuttigenerated.AgentSessionAcceptance{
		WorkspaceId:    acceptance.WorkspaceID,
		AgentSessionId: acceptance.AgentSessionID,
		State:          tuttigenerated.AgentSessionAcceptanceState(acceptance.State),
	}
	if acceptance.ReviewRunID != "" {
		result.ReviewRunId = stringPointer(acceptance.ReviewRunID)
	}
	if !acceptance.UpdatedAt.IsZero() {
		updatedAt := acceptance.UpdatedAt
		result.UpdatedAt = &updatedAt
	}
	return result
}

func modelPolicyServiceUnavailable() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(apierrors.ServiceUnavailable(
		"model_policy_service_unavailable",
		apierrors.WithDeveloperMessage("model policy service is unavailable"),
	))
}

func modelPolicyNotFoundError() tuttigenerated.WorkspaceNotFoundErrorJSONResponse {
	return workspaceNotFoundError(apierrors.New(
		http.StatusNotFound,
		tuttigenerated.WorkspaceNotFound,
		"model_policy_not_found",
		apierrors.WithDeveloperMessage("model usage policy not found"),
	))
}
