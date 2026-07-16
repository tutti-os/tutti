package managedcredentials

import (
	"context"
	"strings"

	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

func (s *Service) credentialForPlan(ctx context.Context, grant managedcredentialsbiz.Grant, modelPlanID string, provider managedcredentialsbiz.ProviderID, model string) (CredentialResult, error) {
	plan, err := s.usablePlan(ctx, grant.WorkspaceID, modelPlanID)
	if err != nil {
		return CredentialResult{}, err
	}
	if providerForProtocol(plan.Protocol) != provider || (model != "" && !planModelsContain(plan.Models, model)) {
		return CredentialResult{}, ErrModelPlanNotConfigured
	}
	models := managedModelsForPlan(plan)
	return CredentialResult{
		ExpiresAt: grant.ExpiresAt,
		Credential: managedcredentialsbiz.ProviderCredential{
			Provider:      provider,
			APIKey:        plan.APIKey,
			BaseURL:       plan.BaseURL,
			ModelPlanID:   plan.ID,
			ModelPlanName: plan.Name,
			Models:        models,
		},
		GrantModels: models,
	}, nil
}

// ListModelPlanReferences makes active workspace App grants visible to model-
// range impact previews and deletion guards.
func (s *Service) ListModelPlanReferences(ctx context.Context, workspaceID string, modelPlanID string) ([]modelplanbiz.Reference, error) {
	grants, err := s.Store.ListManagedModelGrants(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, err
	}
	now := s.now()
	seen := map[string]bool{}
	references := []modelplanbiz.Reference{}
	for _, grant := range grants {
		if grant.RevokedAt != nil || !grant.ExpiresAt.After(now) || !containsString(grant.ModelPlanIDs, strings.TrimSpace(modelPlanID)) {
			continue
		}
		appID := strings.TrimSpace(grant.AppID)
		if appID == "" || seen[appID] {
			continue
		}
		seen[appID] = true
		references = append(references, modelplanbiz.Reference{
			Kind: modelplanbiz.ReferenceWorkspaceApp,
			ID:   appID,
			Name: appID,
			Role: "managed-ai-models",
		})
	}
	return references, nil
}

func (s *Service) modelsForGrant(ctx context.Context, grant managedcredentialsbiz.Grant) []managedcredentialsbiz.Model {
	models := s.modelsForProviders(ctx, grant.WorkspaceID, grant.ProviderIDs)
	for _, modelPlanID := range grant.ModelPlanIDs {
		plan, err := s.usablePlan(ctx, grant.WorkspaceID, modelPlanID)
		if err == nil {
			models = append(models, managedModelsForPlan(plan)...)
		}
	}
	return models
}

func (s *Service) defaultUsableModelPlanIDs(ctx context.Context, workspaceID string) ([]string, error) {
	if s.Plans == nil {
		return nil, nil
	}
	plans, err := s.Plans.ListModelPlans(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, plan := range plans {
		if modelPlanUsable(plan) {
			ids = append(ids, plan.ID)
		}
	}
	return normalizeIDs(ids), nil
}

func (s *Service) preferModelPlansForProviders(ctx context.Context, workspaceID string, providers []managedcredentialsbiz.ProviderID) ([]string, []managedcredentialsbiz.ProviderID, error) {
	if s.Plans == nil {
		return nil, providers, nil
	}
	plans, err := s.Plans.ListModelPlans(ctx, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	modelPlanIDs := []string{}
	legacyProviders := []managedcredentialsbiz.ProviderID{}
	for _, provider := range providers {
		matched := false
		for _, plan := range plans {
			if modelPlanUsable(plan) && providerForProtocol(plan.Protocol) == provider {
				modelPlanIDs = append(modelPlanIDs, plan.ID)
				matched = true
			}
		}
		if !matched {
			legacyProviders = append(legacyProviders, provider)
		}
	}
	return normalizeIDs(modelPlanIDs), legacyProviders, nil
}

func (s *Service) usablePlansByID(ctx context.Context, workspaceID string, modelPlanIDs []string) ([]modelplanbiz.Plan, error) {
	plans := make([]modelplanbiz.Plan, 0, len(modelPlanIDs))
	for _, modelPlanID := range modelPlanIDs {
		plan, err := s.usablePlan(ctx, workspaceID, modelPlanID)
		if err != nil {
			return nil, err
		}
		plans = append(plans, plan)
	}
	return plans, nil
}

func (s *Service) usablePlan(ctx context.Context, workspaceID string, modelPlanID string) (modelplanbiz.Plan, error) {
	if s.Plans == nil {
		return modelplanbiz.Plan{}, ErrModelPlanNotConfigured
	}
	plan, err := s.Plans.GetModelPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(modelPlanID))
	if err != nil || !modelPlanUsable(plan) {
		return modelplanbiz.Plan{}, ErrModelPlanNotConfigured
	}
	return plan, nil
}

func modelPlanUsable(plan modelplanbiz.Plan) bool {
	return plan.Enabled && strings.TrimSpace(plan.APIKey) != "" && plan.Status() == modelplanbiz.StatusReady
}

func managedModelsForPlan(plan modelplanbiz.Plan) []managedcredentialsbiz.Model {
	provider := providerForProtocol(plan.Protocol)
	models := make([]managedcredentialsbiz.Model, 0, len(plan.Models))
	for _, model := range plan.Models {
		id := strings.TrimSpace(model.ID)
		if id == "" {
			continue
		}
		name := strings.TrimSpace(model.Name)
		if name == "" {
			name = id
		}
		models = append(models, managedcredentialsbiz.Model{
			ID:            id,
			Name:          name,
			Provider:      provider,
			ModelPlanID:   plan.ID,
			ModelPlanName: plan.Name,
		})
	}
	return models
}

func providerForProtocol(protocol modelplanbiz.Protocol) managedcredentialsbiz.ProviderID {
	if protocol == modelplanbiz.ProtocolAnthropic {
		return managedcredentialsbiz.ProviderAnthropic
	}
	return managedcredentialsbiz.ProviderOpenAI
}

func planModelsContain(models []modelplanbiz.Model, modelID string) bool {
	for _, model := range models {
		if strings.TrimSpace(model.ID) == modelID {
			return true
		}
	}
	return false
}

func normalizeIDs(values []string) []string {
	seen := map[string]bool{}
	ids := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		ids = append(ids, value)
	}
	return ids
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if strings.TrimSpace(candidate) == value {
			return true
		}
	}
	return false
}
