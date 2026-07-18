package agent

import (
	"context"
	"errors"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

const extensionComposerValidationTargetID = "extension:gemini-validation"

func TestServiceCreateValidatesExtensionDefaultsAndExplicitOverrides(t *testing.T) {
	runtime, service := newExtensionComposerValidationService(t)
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		extensionComposerValidationTargetID: {
			Model:            "gemini-pro",
			PermissionModeID: "yolo",
		},
	}
	explicitModel := "gemini-fast"
	if _, err := service.Create(context.Background(), "workspace-extension", CreateSessionInput{
		AgentTargetID: extensionComposerValidationTargetID,
		Cwd:           stringPointer(t.TempDir()),
		Model:         &explicitModel,
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	visibleStarts := visibleRuntimeStarts(runtime.startCalls)
	if len(visibleStarts) != 1 {
		t.Fatalf("visible starts = %#v, want one", visibleStarts)
	}
	if visibleStarts[0].Model != "gemini-fast" || visibleStarts[0].PermissionModeID != "yolo" {
		t.Fatalf("visible settings = %#v", visibleStarts[0])
	}
}

func TestServiceCreateRejectsExtensionSettingsOutsideDescriptor(t *testing.T) {
	tests := []struct {
		name     string
		defaults preferencesbiz.AgentComposerDefaults
		input    CreateSessionInput
	}{
		{
			name:     "default model",
			defaults: preferencesbiz.AgentComposerDefaults{Model: "unknown-model"},
		},
		{
			name: "permission override",
			input: CreateSessionInput{
				Model:            stringPointer("gemini-pro"),
				PermissionModeID: stringPointer("unknown-permission"),
			},
		},
		{
			name: "undeclared reasoning",
			input: CreateSessionInput{
				Model:           stringPointer("gemini-pro"),
				ReasoningEffort: stringPointer("high"),
			},
		},
		{
			name: "undeclared speed",
			input: CreateSessionInput{
				Model: stringPointer("gemini-pro"),
				Speed: stringPointer("fast"),
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runtime, service := newExtensionComposerValidationService(t)
			service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
				extensionComposerValidationTargetID: test.defaults,
			}
			input := test.input
			input.AgentTargetID = extensionComposerValidationTargetID
			input.Cwd = stringPointer(t.TempDir())
			_, err := service.Create(context.Background(), "workspace-extension", input)
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("Create() error = %v, want ErrInvalidArgument", err)
			}
			if starts := visibleRuntimeStarts(runtime.startCalls); len(starts) != 0 {
				t.Fatalf("visible starts = %#v, want none", starts)
			}
		})
	}
}

func newExtensionComposerValidationService(t *testing.T) (*fakeRuntime, *Service) {
	t.Helper()
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			session.RuntimeContext = map[string]any{
				"configOptions": []any{map[string]any{
					"id": "model",
					"options": []any{
						map[string]any{"value": "gemini-pro", "name": "Gemini Pro"},
						map[string]any{"value": "gemini-fast", "name": "Gemini Fast"},
					},
				}},
			}
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		extensionComposerValidationTargetID: {
			ID:            extensionComposerValidationTargetID,
			Provider:      "acp:gemini",
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"gemini@1.0.0"}`,
			Name:          "Gemini CLI",
			Enabled:       true,
			Source:        agenttargetbiz.SourceSystem,
		},
	}}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{
		profile: ExtensionComposerProfile{PermissionModes: []ExtensionComposerPermissionMode{
			{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
			{RuntimeID: "yolo", Semantic: PermissionModeSemanticFullAccess},
		}},
	}
	return runtime, service
}

func visibleRuntimeStarts(starts []RuntimeStartInput) []RuntimeStartInput {
	result := make([]RuntimeStartInput, 0, len(starts))
	for _, start := range starts {
		if start.Visible == nil || *start.Visible {
			result = append(result, start)
		}
	}
	return result
}
