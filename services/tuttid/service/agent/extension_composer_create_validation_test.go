package agent

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

const extensionComposerValidationTargetID = "extension:gemini-validation"

func TestExtensionComposerModelValidationDegradesWhileLiveCatalogDiscoveryIsPending(t *testing.T) {
	runtime := newFakeRuntime()
	started := make(chan struct{})
	release := make(chan struct{})
	closed := make(chan struct{})
	refreshed := make(chan string, 1)
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			close(started)
			<-release
			session.RuntimeContext["configOptions"] = []any{map[string]any{
				"id": "model", "options": []any{
					map[string]any{"value": "gemini-pro", "name": "Gemini Pro"},
				},
			}}
		}
		return session
	}
	runtime.closeHook = func(RuntimeCloseInput) { close(closed) }
	service := newIsolatedAgentService(runtime)
	service.LiveModelCatalogUpdated = func(provider string) {
		refreshed <- provider
	}
	service.liveModelDiscoveryWaitTimeout = 10 * time.Millisecond
	input := extensionComposerDiscoveryInput(t.TempDir())
	input.Settings.Model = "gemini-pro"
	input.extensionComposerProfile.ModelConfigOptionID = "model"
	base := ComposerOptions{
		Provider:          input.Provider,
		EffectiveSettings: input.Settings,
		ModelConfig: ComposerConfigOption{
			CurrentValue: "gemini-pro",
			DefaultValue: "gemini-pro",
			Options:      composerSelectedModelOptions("gemini-pro"),
		},
		RuntimeContext: map[string]any{},
	}

	type mergeResult struct {
		options ComposerOptions
		err     error
	}
	result := make(chan mergeResult, 1)
	go func() {
		options, err := service.mergeLiveComposerModelsForComposerOptions(
			context.Background(), input, input.Settings, base,
		)
		result <- mergeResult{options: options, err: err}
	}()
	<-started
	merged := <-result
	if merged.err != nil {
		t.Fatalf("mergeLiveComposerModelsForComposerOptions() error = %v", merged.err)
	}
	if !merged.options.liveModelDiscoveryPending {
		t.Fatal("live model discovery pending state was not preserved")
	}
	if err := validateExtensionComposerModelForCreate("gemini-pro", merged.options); err != nil {
		t.Fatalf("pending live catalog rejected selected model: %v", err)
	}

	close(release)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for hidden discovery cleanup")
	}
	select {
	case provider := <-refreshed:
		if provider != input.Provider {
			t.Fatalf("refreshed provider = %q, want %q", provider, input.Provider)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for live model catalog refresh notification")
	}
}

func TestExtensionComposerModelValidationRemainsStrictWithAdvertisedCatalog(t *testing.T) {
	options := ComposerOptions{
		liveModelDiscoveryPending: true,
		ModelConfig: ComposerConfigOption{
			Configurable: true,
			Options: []ComposerConfigOptionValue{
				{Value: "gemini-pro"},
				{Value: "gemini-fast"},
			},
		},
	}
	if err := validateExtensionComposerModelForCreate("unknown-model", options); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("advertised catalog validation error = %v, want ErrInvalidArgument", err)
	}
}

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

func TestServiceCreateRoundTripsCodeBuddyLikeRuntimePermissionID(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			session.RuntimeContext = map[string]any{
				"configOptions": []any{
					map[string]any{
						"id":           "model",
						"currentValue": "glm-5.2",
						"options": []any{
							map[string]any{"value": "glm-5.2", "name": "GLM-5.2"},
						},
					},
					map[string]any{
						"id":           "approval-mode",
						"currentValue": "default",
						"options": []any{
							map[string]any{"value": "default", "name": "Default"},
							map[string]any{"value": "bypassPermissions", "name": "Full access"},
							map[string]any{"value": "fullAccess", "name": "Full access"},
						},
					},
				},
			}
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		"extension:codebuddy": {
			ID:            "extension:codebuddy",
			Provider:      "acp:codebuddy",
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"codebuddy@2.0.3"}`,
			Name:          "CodeBuddy",
			Enabled:       true,
			Source:        agenttargetbiz.SourceSystem,
		},
	}}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{
		profile: ExtensionComposerProfile{
			ModelConfigOptionID:      "model",
			PermissionConfigOptionID: "approval-mode",
			PermissionModeIDPolicy:   ExtensionPermissionModeIDPolicyRuntime,
			PermissionModes: []ExtensionComposerPermissionMode{
				{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
				{RuntimeID: "fullAccess", Semantic: PermissionModeSemanticFullAccess},
			},
		},
	}
	cwd := t.TempDir()
	settings := ComposerSettings{Model: "glm-5.2", PermissionModeID: "bypassPermissions"}
	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: "extension:codebuddy",
		WorkspaceID:   "workspace-codebuddy",
		Cwd:           cwd,
		Settings:      settings,
	})
	if err != nil {
		t.Fatalf("GetComposerOptions() error = %v", err)
	}
	if options.EffectiveSettings.PermissionModeID != "bypassPermissions" {
		t.Fatalf("effective permission = %q, want explicit runtime id", options.EffectiveSettings.PermissionModeID)
	}
	if got := permissionModeIDs(options.PermissionConfig); !slices.Equal(got, []string{"default", "bypassPermissions", "fullAccess"}) {
		t.Fatalf("permission ids = %#v", got)
	}

	model := settings.Model
	permission := settings.PermissionModeID
	if _, err := service.Create(context.Background(), "workspace-codebuddy", CreateSessionInput{
		AgentTargetID:    "extension:codebuddy",
		Cwd:              &cwd,
		Model:            &model,
		PermissionModeID: &permission,
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	visibleStarts := visibleRuntimeStarts(runtime.startCalls)
	if len(visibleStarts) != 1 || visibleStarts[0].PermissionModeID != "bypassPermissions" {
		t.Fatalf("visible starts = %#v, want exact runtime permission id", visibleStarts)
	}
	for _, start := range runtime.startCalls {
		if start.PermissionModeID != "bypassPermissions" {
			t.Fatalf("runtime start permission = %q, want exact selected id", start.PermissionModeID)
		}
	}
}

func TestServiceGetComposerOptionsRejectsSemanticAliasBeforeRuntimeDiscovery(t *testing.T) {
	runtime, service := newExtensionComposerValidationService(t)
	_, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: extensionComposerValidationTargetID,
		WorkspaceID:   "workspace-extension",
		Cwd:           t.TempDir(),
		Settings: ComposerSettings{
			PermissionModeID: "full-access",
		},
	})
	var unsupported *UnsupportedPermissionModeIDError
	if !errors.As(err, &unsupported) {
		t.Fatalf("GetComposerOptions() error = %v, want UnsupportedPermissionModeIDError", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("runtime starts = %#v, want invalid id rejected before discovery", runtime.startCalls)
	}
}

func TestServiceGetComposerOptionsIgnoresStalePersistedPermissionDefault(t *testing.T) {
	runtime, service := newExtensionComposerValidationService(t)
	cwd := t.TempDir()
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		extensionComposerValidationTargetID: {PermissionModeID: "full-access"},
	}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{
		profile: ExtensionComposerProfile{
			DefaultPermissionModeID: "default",
			PermissionModeIDPolicy:  ExtensionPermissionModeIDPolicyRuntime,
			PermissionModes: []ExtensionComposerPermissionMode{
				{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
				{RuntimeID: "fullAccess", Semantic: PermissionModeSemanticFullAccess},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: extensionComposerValidationTargetID,
		WorkspaceID:   "workspace-extension",
		Cwd:           cwd,
	})
	if err != nil {
		t.Fatalf("GetComposerOptions() error = %v", err)
	}
	if options.EffectiveSettings.PermissionModeID != "default" ||
		!slices.Equal(permissionModeIDs(options.PermissionConfig), []string{"default", "bypassPermissions", "fullAccess"}) {
		t.Fatalf("options = %#v, want stale default ignored and current contract advertised", options)
	}
	if len(runtime.startCalls) == 0 {
		t.Fatal("runtime discovery did not run")
	}
	if _, err := service.Create(context.Background(), "workspace-extension", CreateSessionInput{
		AgentTargetID: extensionComposerValidationTargetID,
		Cwd:           &cwd,
	}); err != nil {
		t.Fatalf("Create() with stale persisted default error = %v", err)
	}
	visibleStarts := visibleRuntimeStarts(runtime.startCalls)
	if len(visibleStarts) != 1 || visibleStarts[0].PermissionModeID != "default" {
		t.Fatalf("visible starts = %#v, want recovered profile default", visibleStarts)
	}
}

func TestServiceGetComposerOptionsUsesRuntimeCurrentBeforeSemanticProfileDefault(t *testing.T) {
	runtime, service := newExtensionComposerValidationService(t)
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			session.RuntimeContext = map[string]any{"configOptions": []any{map[string]any{
				"id": "approval-mode", "currentValue": "all", "options": []any{
					map[string]any{"value": "ask", "name": "Ask"},
					map[string]any{"value": "all", "name": "Full access"},
				},
			}}}
		}
		return session
	}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{
		profile: ExtensionComposerProfile{
			DefaultPermissionModeID:  "ask-before-write",
			PermissionConfigOptionID: "approval-mode",
			PermissionModeIDPolicy:   ExtensionPermissionModeIDPolicySemantic,
			PermissionModes: []ExtensionComposerPermissionMode{
				{RuntimeID: "ask", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "all", Semantic: PermissionModeSemanticFullAccess},
			},
		},
	}
	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: extensionComposerValidationTargetID,
		WorkspaceID:   "workspace-extension",
		Cwd:           t.TempDir(),
	})
	if err != nil {
		t.Fatalf("GetComposerOptions() error = %v", err)
	}
	if options.EffectiveSettings.PermissionModeID != "full-access" {
		t.Fatalf("effective permission = %q, want runtime current", options.EffectiveSettings.PermissionModeID)
	}
}

func TestServiceCreateRejectsExtensionSettingsOutsideDescriptor(t *testing.T) {
	tests := []struct {
		name     string
		defaults preferencesbiz.AgentComposerDefaults
		input    CreateSessionInput
	}{
		{
			name: "model override",
			input: CreateSessionInput{
				Model: stringPointer("unknown-model"),
			},
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

func TestServiceCreateIgnoresRetiredExtensionModelDefault(t *testing.T) {
	runtime, service := newExtensionComposerValidationService(t)
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			session.RuntimeContext = map[string]any{
				"configOptions": []any{map[string]any{
					"id":           "model",
					"currentValue": "gemini-fast",
					"options": []any{
						map[string]any{"value": "gemini-pro", "name": "Gemini Pro"},
						map[string]any{"value": "gemini-fast", "name": "Gemini Fast"},
					},
				}},
			}
		}
		return session
	}
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		extensionComposerValidationTargetID: {Model: "retired-model"},
	}

	created, err := service.Create(context.Background(), "workspace-extension", CreateSessionInput{
		AgentTargetID: extensionComposerValidationTargetID,
		Cwd:           stringPointer(t.TempDir()),
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.Settings == nil || created.Settings.Model != "gemini-fast" {
		t.Fatalf("created settings = %#v, want runtime current model", created.Settings)
	}
	visibleStarts := visibleRuntimeStarts(runtime.startCalls)
	if len(visibleStarts) != 1 || visibleStarts[0].Model != "gemini-fast" {
		t.Fatalf("visible starts = %#v, want runtime current model", visibleStarts)
	}
}

func TestServiceCreateResolvesReasoningDefaultAfterRetiredExtensionModel(t *testing.T) {
	runtime, service := newExtensionComposerValidationService(t)
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			session.RuntimeContext = map[string]any{
				"configOptions": []any{map[string]any{
					"id":           "model",
					"currentValue": "gemini-fast",
					"options": []any{
						map[string]any{"value": "gemini-pro", "name": "Gemini Pro"},
						map[string]any{
							"value":                   "gemini-fast",
							"name":                    "Gemini Fast",
							"reasoningEffort":         "low",
							"supportsReasoningEffort": true,
							"reasoningEfforts": []any{
								map[string]any{"value": "low", "name": "Low", "default": true},
							},
						},
					},
				}},
			}
		}
		return session
	}
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		extensionComposerValidationTargetID: {
			Model:           "retired-model",
			ReasoningEffort: "high",
		},
	}

	created, err := service.Create(context.Background(), "workspace-extension", CreateSessionInput{
		AgentTargetID: extensionComposerValidationTargetID,
		Cwd:           stringPointer(t.TempDir()),
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.Settings == nil ||
		created.Settings.Model != "gemini-fast" ||
		created.Settings.ReasoningEffort != "low" {
		t.Fatalf("created settings = %#v, want runtime model reasoning default", created.Settings)
	}
	visibleStarts := visibleRuntimeStarts(runtime.startCalls)
	if len(visibleStarts) != 1 ||
		visibleStarts[0].Model != "gemini-fast" ||
		visibleStarts[0].ReasoningEffort != "low" {
		t.Fatalf("visible starts = %#v, want resolved runtime model settings", visibleStarts)
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
