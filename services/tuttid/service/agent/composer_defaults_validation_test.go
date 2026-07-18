package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func TestValidateAgentComposerDefaultsPatchUsesObservedExtensionTargetCatalog(t *testing.T) {
	ctx := context.Background()
	runtime, service := newExtensionComposerValidationService(t)
	cwdA := resolvedComposerValidationCwd(t, service, t.TempDir())
	cwdB := resolvedComposerValidationCwd(t, service, t.TempDir())
	configureCwdSensitiveExtensionModels(runtime, map[string]string{
		cwdA: "gemini-project-a",
		cwdB: "gemini-project-b",
	})

	for _, input := range []struct {
		cwd       string
		model     string
		workspace string
	}{
		{cwd: cwdA, model: "gemini-project-a", workspace: "workspace-a"},
		{cwd: cwdB, model: "gemini-project-b", workspace: "workspace-b"},
	} {
		options, err := service.GetComposerOptions(ctx, ComposerOptionsInput{
			AgentTargetID: extensionComposerValidationTargetID,
			Provider:      "acp:gemini",
			WorkspaceID:   input.workspace,
			Cwd:           input.cwd,
		})
		if err != nil {
			t.Fatalf("GetComposerOptions(%s) error = %v", input.workspace, err)
		}
		if !composerValidationConfigHasValue(options.ModelConfig, input.model) {
			t.Fatalf("model config for %s = %#v, want %q", input.workspace, options.ModelConfig, input.model)
		}
		if err := validateExtensionModelDefault(service, input.model); err != nil {
			t.Fatalf("ValidateAgentComposerDefaultsPatch(%q) error = %v", input.model, err)
		}
	}

	service.setLiveComposerModelOptionsForScope(
		newComposerLiveModelScope("acp:gemini", "workspace-other", cwdA, "extension:other-target"),
		time.Now().UTC(),
		[]ComposerConfigOptionValue{{Value: "other-target-only"}},
	)
	for _, model := range []string{"not-advertised", "other-target-only"} {
		if err := validateExtensionModelDefault(service, model); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("ValidateAgentComposerDefaultsPatch(%q) error = %v, want ErrInvalidArgument", model, err)
		}
	}
	service.InvalidateLiveComposerModels("acp:gemini")
	if err := validateExtensionModelDefault(service, "gemini-project-a"); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("validation after catalog invalidation error = %v, want ErrInvalidArgument", err)
	}
}

func TestValidateAgentComposerDefaultsPatchRetainsExtensionTargetCatalogAfterDisplayTTL(t *testing.T) {
	_, service := newExtensionComposerValidationService(t)
	cachedAt := time.Unix(1_000, 0).UTC()
	scope := newComposerLiveModelScope(
		"acp:gemini",
		"workspace-stale-menu",
		t.TempDir(),
		extensionComposerValidationTargetID,
	)
	service.LiveModelCacheTTL = time.Minute
	service.setLiveComposerModelOptionsForScope(scope, cachedAt, []ComposerConfigOptionValue{
		{Value: "gemini-menu-selection", Label: "Gemini Menu Selection"},
	})

	if _, ok := service.getLiveComposerModelOptionsForScope(scope, cachedAt.Add(2*time.Minute)); ok {
		t.Fatal("display cache hit after TTL, want expired")
	}
	if err := validateExtensionModelDefault(service, "gemini-menu-selection"); err != nil {
		t.Fatalf("validation after display cache TTL error = %v", err)
	}
}

func TestServiceCreateRevalidatesObservedExtensionDefaultForActualCwd(t *testing.T) {
	ctx := context.Background()
	runtime, service := newExtensionComposerValidationService(t)
	cwdA := resolvedComposerValidationCwd(t, service, t.TempDir())
	cwdB := resolvedComposerValidationCwd(t, service, t.TempDir())
	configureCwdSensitiveExtensionModels(runtime, map[string]string{
		cwdA: "gemini-project-a",
		cwdB: "gemini-project-b",
	})
	if _, err := service.GetComposerOptions(ctx, ComposerOptionsInput{
		AgentTargetID: extensionComposerValidationTargetID,
		Provider:      "acp:gemini",
		WorkspaceID:   "workspace-menu-a",
		Cwd:           cwdA,
	}); err != nil {
		t.Fatalf("GetComposerOptions() error = %v", err)
	}
	if err := validateExtensionModelDefault(service, "gemini-project-a"); err != nil {
		t.Fatalf("ValidateAgentComposerDefaultsPatch() error = %v", err)
	}
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		extensionComposerValidationTargetID: {Model: "gemini-project-a"},
	}
	_, err := service.Create(ctx, "workspace-create-b", CreateSessionInput{
		AgentTargetID: extensionComposerValidationTargetID,
		Cwd:           &cwdB,
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Create() error = %v, want ErrInvalidArgument", err)
	}
	if starts := visibleRuntimeStarts(runtime.startCalls); len(starts) != 0 {
		t.Fatalf("visible starts = %#v, want none", starts)
	}
}

func validateExtensionModelDefault(service *Service, model string) error {
	return service.ValidateAgentComposerDefaultsPatch(
		context.Background(),
		extensionComposerValidationTargetID,
		preferencesbiz.AgentComposerDefaultsPatch{
			preferencesbiz.AgentComposerDefaultsFieldModel: &model,
		},
	)
}

func composerValidationConfigHasValue(config ComposerConfigOption, value string) bool {
	for _, option := range config.Options {
		if option.Value == value {
			return true
		}
	}
	return false
}

func resolvedComposerValidationCwd(t *testing.T, service *Service, cwd string) string {
	t.Helper()
	resolved, err := service.resolveCwd(context.Background(), &cwd)
	if err != nil {
		t.Fatalf("resolveCwd(%q) error = %v", cwd, err)
	}
	return normalizeComposerProjectScope(resolved)
}

func configureCwdSensitiveExtensionModels(runtime *fakeRuntime, modelsByCwd map[string]string) {
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible == nil || *input.Visible {
			return session
		}
		model := modelsByCwd[input.Cwd]
		if model == "" {
			return session
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{map[string]any{
				"id":      "model",
				"options": []any{map[string]any{"value": model, "name": model}},
			}},
		}
		return session
	}
}
