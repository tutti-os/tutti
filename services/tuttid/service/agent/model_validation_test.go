package agent

import (
	"context"
	"errors"
	"testing"
)

type modelValidationCatalog struct {
	providers []string
	result    AgentModelCatalogResult
}

func (c *modelValidationCatalog) ListModels(_ context.Context, provider string) (AgentModelCatalogResult, error) {
	c.providers = append(c.providers, provider)
	return c.result, nil
}

func TestAvailableComposerModelsForValidationUsesProfileStrategy(t *testing.T) {
	catalog := &modelValidationCatalog{result: AgentModelCatalogResult{
		Models: []AgentModelOption{{ID: "model-a"}, {ID: "model-a"}, {ID: "model-b"}},
	}}
	service := &Service{ModelCatalog: catalog}
	models, ok, err := service.availableComposerModelsForValidationProfile(
		context.Background(),
		"future-provider",
		"workspace",
		"/repo",
		composerProfile{UsesModelCatalog: true},
	)
	if err != nil || !ok {
		t.Fatalf("availableComposerModelsForValidationProfile() = (%v, %v, %v)", models, ok, err)
	}
	if len(catalog.providers) != 1 || catalog.providers[0] != "future-provider" {
		t.Fatalf("catalog providers = %#v", catalog.providers)
	}
	if len(models) != 2 || models[0] != "model-a" || models[1] != "model-b" {
		t.Fatalf("models = %#v", models)
	}
}

func TestAvailableComposerModelsForValidationRejectsUnknownCatalogKind(t *testing.T) {
	service := &Service{}
	_, ok, err := service.availableComposerModelsForValidationProfile(
		context.Background(),
		"poison-provider",
		"workspace",
		"/repo",
		composerProfile{ModelCatalog: "poison"},
	)
	if err == nil || ok || !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("availableComposerModelsForValidationProfile() = (_, %v, %v), want invalid argument", ok, err)
	}
}

func TestAvailableComposerModelsForValidationRejectsAmbiguousProfile(t *testing.T) {
	service := &Service{}
	_, ok, err := service.availableComposerModelsForValidationProfile(
		context.Background(),
		"poison-provider",
		"workspace",
		"/repo",
		composerProfile{LiveModelDiscovery: true, UsesModelCatalog: true},
	)
	if err == nil || ok || !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("availableComposerModelsForValidationProfile() = (_, %v, %v), want invalid argument", ok, err)
	}
}
