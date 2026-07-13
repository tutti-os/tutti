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
	model = normalizeComposerModelForProvider(provider, clampComposerModelForProvider(provider, model))
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
		result, err := s.ModelCatalog.ListModels(ctx, provider)
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
