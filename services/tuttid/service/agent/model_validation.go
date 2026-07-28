package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type InvalidModelError struct {
	Provider        string
	Model           string
	AvailableModels []string
}

func (e *InvalidModelError) Error() string {
	if e == nil {
		return ""
	}
	provider := strings.TrimSpace(e.Provider)
	model := strings.TrimSpace(e.Model)
	available := strings.Join(e.AvailableModels, ", ")
	if available == "" {
		return fmt.Sprintf("invalid model %q for provider %q", model, provider)
	}
	return fmt.Sprintf("invalid model %q for provider %q; available models: %s", model, provider, available)
}

func (*InvalidModelError) Unwrap() error {
	return ErrInvalidArgument
}

func (s *Service) validateComposerModelForCreate(
	ctx context.Context,
	provider string,
	workspaceID string,
	cwd string,
	model string,
) error {
	provider = agentprovider.Normalize(provider)
	model = clampComposerModelForProvider(provider, model)
	if model == "" {
		return nil
	}
	availableModels, ok, err := s.availableComposerModelsForValidation(ctx, provider, workspaceID, cwd)
	if err != nil {
		return err
	}
	if !ok || len(availableModels) == 0 {
		return nil
	}
	for _, candidate := range availableModels {
		if strings.TrimSpace(candidate) == model {
			return nil
		}
	}
	return &InvalidModelError{
		Provider:        provider,
		Model:           model,
		AvailableModels: availableModels,
	}
}

// AvailableTaskAssignmentModels returns a freshly discovered, authoritative
// provider-native catalog for task-assignment validation when the provider
// requires that stronger check. Other providers and explicit Model Plans keep
// their existing validation path and return no catalog.
func (s *Service) AvailableTaskAssignmentModels(
	ctx context.Context,
	workspaceID string,
	agentTargetID string,
	modelPlanID string,
) ([]string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentTargetID = strings.TrimSpace(agentTargetID)
	if strings.TrimSpace(modelPlanID) != "" {
		return nil, nil
	}
	if workspaceID == "" {
		return nil, fmt.Errorf("%w: workspace is required for task model validation", ErrInvalidArgument)
	}
	if agentTargetID == "" {
		return nil, nil
	}
	launchInput := CreateSessionInput{AgentTargetID: agentTargetID}
	launch, err := s.resolveCreateSessionLaunch(ctx, workspaceID, &launchInput)
	if err != nil {
		return nil, err
	}
	provider := agentprovider.NormalizeOpen(launch.Provider)
	if !composerProfileFor(provider).Behavior.RefreshTaskAssignmentModelsOnDecision {
		return nil, nil
	}

	// A task decision is the last boundary before the selected model becomes
	// durable. Drop cached and persisted evidence so an account change cannot
	// validate against a catalog advertised by an older provider session.
	invalidationGeneration := s.invalidateLiveComposerModels(provider)
	options, err := s.GetComposerOptions(ctx, ComposerOptionsInput{
		AgentTargetID:                          agentTargetID,
		Provider:                               provider,
		WorkspaceID:                            workspaceID,
		IgnoreModelPlanBinding:                 true,
		requireFreshLiveModelCatalog:           true,
		liveModelCatalogInvalidationGeneration: invalidationGeneration,
	})
	if err != nil {
		return nil, fmt.Errorf("refresh %s task assignment models: %w", provider, err)
	}
	if s.liveModelInvalidationGenerationForProvider(provider) != invalidationGeneration {
		return nil, fmt.Errorf("%w: current %s model catalog was superseded", ErrInvalidArgument, provider)
	}
	if strings.TrimSpace(stringFromAny(options.RuntimeContext["modelCatalogSource"])) != runtimeLiveModelCatalogSource {
		return nil, fmt.Errorf("%w: current %s model catalog is unavailable", ErrInvalidArgument, provider)
	}
	models := make([]string, 0, len(options.ModelConfig.Options))
	seen := make(map[string]struct{}, len(options.ModelConfig.Options))
	for _, option := range options.ModelConfig.Options {
		if option.Requested {
			continue
		}
		model := strings.TrimSpace(option.Value)
		if model == "" {
			model = strings.TrimSpace(option.ID)
		}
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		models = append(models, model)
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("%w: current %s model catalog is empty", ErrInvalidArgument, provider)
	}
	return models, nil
}

func (s *Service) availableComposerModelsForValidation(
	ctx context.Context,
	provider string,
	workspaceID string,
	cwd string,
) ([]string, bool, error) {
	provider = agentprovider.Normalize(provider)
	profile := composerProfileFor(provider)
	return s.availableComposerModelsForValidationProfile(ctx, provider, workspaceID, cwd, profile)
}

func (s *Service) availableComposerModelsForValidationProfile(
	ctx context.Context,
	provider string,
	workspaceID string,
	cwd string,
	profile composerProfile,
) ([]string, bool, error) {
	switch profile.ModelCatalog {
	case "", providerregistry.ModelCatalogKindCodexCLI, providerregistry.ModelCatalogKindOpenCodeCLI, providerregistry.ModelCatalogKindTuttiCLI:
	default:
		return nil, false, fmt.Errorf(
			"provider %q model catalog kind %q is unsupported: %w",
			provider,
			profile.ModelCatalog,
			ErrInvalidArgument,
		)
	}
	if profile.LiveModelDiscovery && profile.UsesModelCatalog {
		return nil, false, fmt.Errorf(
			"provider %q declares both live model discovery and a model catalog: %w",
			provider,
			ErrInvalidArgument,
		)
	}
	if profile.LiveModelDiscovery {
		models, ok := s.getLiveComposerModelOptions(provider, workspaceID, cwd, time.Now().UTC())
		if !ok {
			return nil, false, nil
		}
		return composerConfigOptionModelValues(models), true, nil
	}
	if profile.UsesModelCatalog {
		if s.ModelCatalog == nil {
			return nil, false, nil
		}
		result, err := s.ModelCatalog.ListModels(ctx, AgentModelCatalogInput{Provider: provider, Cwd: cwd})
		if err != nil {
			return nil, false, nil
		}
		values := make([]string, 0, len(result.Models))
		seen := make(map[string]struct{}, len(result.Models))
		for _, model := range result.Models {
			id := strings.TrimSpace(model.ID)
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			values = append(values, id)
		}
		return values, true, nil
	}
	return nil, false, nil
}

func composerConfigOptionModelValues(options []ComposerConfigOptionValue) []string {
	if len(options) == 0 {
		return nil
	}
	values := make([]string, 0, len(options))
	seen := make(map[string]struct{}, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			value = strings.TrimSpace(option.ID)
		}
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}
