package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	market "github.com/tutti-os/tutti/packages/connector/host"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func TestServiceGetsComposerOptionsWithoutStartingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.CapabilityLister = &recordingComposerCapabilityLister{}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			Model:            " gpt-5 ",
			PermissionModeID: " auto ",
			ReasoningEffort:  " high ",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
	if options.Provider != "codex" {
		t.Fatalf("provider = %q, want codex", options.Provider)
	}
	if options.EffectiveSettings.Model != "gpt-5" || options.EffectiveSettings.PermissionModeID != "auto" || options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings = %#v", options.EffectiveSettings)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if len(configOptions) != 3 {
		t.Fatalf("len(configOptions) = %d, want 3", len(configOptions))
	}
	if configOptions[0]["id"] != "model" || configOptions[0]["currentValue"] != "gpt-5" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	if configOptions[1]["id"] != "reasoning_effort" || configOptions[1]["currentValue"] != "high" {
		t.Fatalf("reasoning option = %#v", configOptions[1])
	}
	if configOptions[2]["id"] != "service_tier" || configOptions[2]["currentValue"] != "standard" {
		t.Fatalf("speed option = %#v", configOptions[2])
	}
	if options.SpeedConfig.CurrentValue != "standard" || len(options.SpeedConfig.Options) != 2 {
		t.Fatalf("speedConfig = %#v", options.SpeedConfig)
	}
	if options.ModelConfig.CurrentValue != "gpt-5" || len(options.ModelConfig.Options) != 1 {
		t.Fatalf("modelConfig = %#v", options.ModelConfig)
	}
	if options.ReasoningConfig.CurrentValue != "high" || len(options.ReasoningConfig.Options) == 0 {
		t.Fatalf("reasoningConfig = %#v", options.ReasoningConfig)
	}
	if options.PermissionConfig.DefaultValue != "auto" || len(options.PermissionConfig.Modes) != 3 {
		t.Fatalf("permissionConfig = %#v", options.PermissionConfig)
	}
	if options.PermissionConfig.Modes[1].Label != "Approve for me" {
		t.Fatalf("permission label = %#v, want Approve for me", options.PermissionConfig.Modes[1])
	}
	capabilities, ok := options.RuntimeContext["capabilities"].([]string)
	if !ok || !slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceGetComposerOptionsResolvesProviderFromAgentTargetID(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.CapabilityLister = &recordingComposerCapabilityLister{}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: agenttargetbiz.IDLocalCodex,
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.Provider != "codex" {
		t.Fatalf("provider = %q, want codex", options.Provider)
	}
	if options.RuntimeContext["agentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("runtimeContext agentTargetId = %#v, want %q", options.RuntimeContext["agentTargetId"], agenttargetbiz.IDLocalCodex)
	}
}

func TestServiceGetComposerOptionsPreservesGenericExtensionTargetAndProjectsSignedLiveComposerData(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Visible != nil && !*input.Visible {
			runtimeContext := clonePayload(session.RuntimeContext)
			for key, value := range map[string]any{
				"configOptions": []any{
					map[string]any{
						"currentValue": "example-pro",
						"id":           "model-choice",
						"options": []any{
							map[string]any{"value": "example-pro", "name": "Example Pro"},
						},
					},
					map[string]any{
						"currentValue": "default",
						"id":           "approval-mode",
						"options": []any{
							map[string]any{"value": "default", "name": "Default"},
							map[string]any{"value": "acceptEdits", "name": "Accept edits"},
							map[string]any{"value": "auto", "name": "Auto"},
							map[string]any{"value": "dontAsk", "name": "Don't ask"},
							map[string]any{"value": "bypassPermissions", "name": "Bypass permissions"},
							map[string]any{"value": "fullAccess", "name": "Full access"},
							map[string]any{"value": "plan", "name": "Plan"},
						},
					},
					map[string]any{
						"currentValue": "enabled",
						"id":           "reasoning_effort",
						"runtimeId":    "thought_level",
						"options": []any{
							map[string]any{"value": "disabled", "name": "Off"},
							map[string]any{"value": "enabled", "name": "On"},
							map[string]any{"value": "deep", "name": "Deep"},
						},
					},
					map[string]any{
						"currentValue": "false",
						"id":           "sandbox",
						"options": []any{
							map[string]any{"value": "false", "name": "Off"},
							map[string]any{"value": "true", "name": "On"},
						},
					},
				},
				"capabilities": []any{"compact", "compact", "planMode", "unknown"},
				"availableCommands": []any{
					map[string]any{"name": "compact", "description": "Compact history", "inputHint": "optional focus"},
					map[string]any{"name": "status", "description": "Show status"},
					map[string]any{"name": "goal", "description": "Set goal"},
					map[string]any{"name": "plan", "description": "Toggle plan"},
					map[string]any{"name": "review", "description": "Review code"},
					map[string]any{"name": "effort", "description": "Set thinking effort"},
				},
			} {
				runtimeContext[key] = value
			}
			session.RuntimeContext = runtimeContext
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		"extension:example": {
			ID:            "extension:example",
			Provider:      "acp:example",
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"example@1.0.0"}`,
			Name:          "Example Agent",
			Enabled:       true,
			Source:        agenttargetbiz.SourceSystem,
		},
	}}
	service.CapabilityLister = &recordingComposerCapabilityLister{}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{
		profile: ExtensionComposerProfile{
			Capabilities:             []string{"compact", "compact", "planMode", "unknown"},
			ModelConfigOptionID:      "model-choice",
			PermissionConfigOptionID: "approval-mode",
			ReasoningConfigOptionID:  "thought_level",
			PermissionModes: []ExtensionComposerPermissionMode{
				{RuntimeID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
				{RuntimeID: "acceptEdits", Semantic: PermissionModeSemanticAcceptEdits},
				{RuntimeID: "auto", Semantic: PermissionModeSemanticAuto},
				{RuntimeID: "dontAsk", Semantic: PermissionModeSemanticLockedDown},
				{RuntimeID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
				{RuntimeID: "fullAccess", Semantic: PermissionModeSemanticFullAccess},
			},
			SlashCommandCatalogAuthoritative: true,
			SlashCommands: []ExtensionComposerSlashCommand{
				{Name: "compact", Effect: string(providerregistry.SlashCommandEffectSubmitImmediate)},
				{Name: "status", Effect: string(providerregistry.SlashCommandEffectShowStatus)},
				{Name: "goal", Effect: string(providerregistry.SlashCommandEffectActivateGoalMode)},
				{Name: "plan", Effect: string(providerregistry.SlashCommandEffectTogglePlanMode)},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: "extension:example",
		Provider:      "acp:example",
		WorkspaceID:   "workspace-1",
		Cwd:           t.TempDir(),
		Settings: ComposerSettings{
			PermissionModeID: "default",
			ReasoningEffort:  "deep",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.Provider != "acp:example" {
		t.Fatalf("provider = %q, want acp:example", options.Provider)
	}
	if options.RuntimeContext["agentTargetId"] != "extension:example" {
		t.Fatalf("runtimeContext agentTargetId = %#v, want extension:example", options.RuntimeContext["agentTargetId"])
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 1 || options.ModelConfig.Options[0].Value != "example-pro" {
		t.Fatalf("modelConfig = %#v, want live extension model options", options.ModelConfig)
	}
	if !options.PermissionConfig.Configurable ||
		options.PermissionConfig.DefaultValue != "default" ||
		len(options.PermissionConfig.Modes) != 6 ||
		options.PermissionConfig.Modes[1].Semantic != PermissionModeSemanticAcceptEdits ||
		options.PermissionConfig.Modes[4].Semantic != PermissionModeSemanticFullAccess ||
		options.PermissionConfig.Modes[5].Semantic != PermissionModeSemanticFullAccess {
		t.Fatalf("permissionConfig = %#v, want runtime extension permission modes", options.PermissionConfig)
	}
	permissionModeIDs := make([]string, 0, len(options.PermissionConfig.Modes))
	for _, mode := range options.PermissionConfig.Modes {
		permissionModeIDs = append(permissionModeIDs, mode.ID)
	}
	if !slices.Equal(permissionModeIDs, []string{"default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "fullAccess"}) {
		t.Fatalf("permission mode ids = %#v, want exact runtime ids", permissionModeIDs)
	}
	if !options.ReasoningConfig.Configurable ||
		options.ReasoningConfig.CurrentValue != "enabled" ||
		len(options.ReasoningConfig.Options) != 3 ||
		options.ReasoningConfig.Options[2].Value != "deep" {
		t.Fatalf("reasoningConfig = %#v, want runtime extension thought_level options", options.ReasoningConfig)
	}
	if !slices.Equal(options.Capabilities, []string{"compact", "planMode"}) {
		t.Fatalf("capabilities = %#v, want deduplicated signed/live known capabilities", options.Capabilities)
	}
	if options.SlashCommandPolicy == nil ||
		!options.SlashCommandPolicy.CommandCatalogAuthoritative ||
		!slices.Equal(options.SlashCommandPolicy.FallbackCommands, []string{"compact", "status", "goal", "plan"}) ||
		len(options.SlashCommandPolicy.CommandEffects) != 4 ||
		options.SlashCommandPolicy.CommandEffects[2].Effect != providerregistry.SlashCommandEffectActivateGoalMode {
		t.Fatalf("slashCommandPolicy = %#v, want extension slash command profile", options.SlashCommandPolicy)
	}
	commands := options.Commands
	if len(commands) != 4 || commands[0].Name != "compact" || commands[0].Description != "Compact history" || commands[0].InputHint != "optional focus" || commands[3].Name != "plan" {
		t.Fatalf("commands = %#v, want filtered runtime commands", commands)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) != 5 ||
		configOptions[0]["id"] != "model" ||
		configOptions[1]["id"] != "model-choice" ||
		configOptions[2]["id"] != "approval-mode" ||
		configOptions[3]["id"] != "reasoning_effort" ||
		configOptions[3]["runtimeId"] != "thought_level" ||
		configOptions[4]["id"] != "sandbox" {
		t.Fatalf("configOptions = %#v, want model + runtime extension config options", options.RuntimeContext["configOptions"])
	}
	if len(runtime.startCalls) != 1 || runtime.startCalls[0].ProviderTargetRef["kind"] != "agent_extension" {
		t.Fatalf("runtime start calls = %#v, want one target-scoped extension discovery", runtime.startCalls)
	}
	if runtime.startCalls[0].PermissionModeID != "default" || runtime.startCalls[0].ReasoningEffort != "deep" {
		t.Fatalf("runtime start settings = %#v, want exact runtime permission and requested reasoning", runtime.startCalls[0])
	}
	if len(runtime.closeCalls) != 1 || len(runtime.sessions) != 0 {
		t.Fatalf("runtime cleanup = calls %#v sessions %#v, want hidden discovery closed immediately", runtime.closeCalls, runtime.sessions)
	}
}

func TestServiceGetComposerOptionsDoesNotCarryConversationDetailMode(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			ConversationDetailMode: "general",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if got := options.EffectiveSettings.ConversationDetailMode; got != "" {
		t.Fatalf("effectiveSettings.conversationDetailMode = %q, want empty", got)
	}
	payload := ComposerSettingsToMap(options.EffectiveSettings)
	if _, ok := payload["conversationDetailMode"]; ok {
		t.Fatalf("effectiveSettings payload includes conversationDetailMode: %#v", payload)
	}
}

type recordingComposerCapabilityLister struct {
	callCount int
}

func (l *recordingComposerCapabilityLister) ListComposerCapabilityOptions(
	_ context.Context,
	_ string,
	_ string,
	_ []ComposerSkillOption,
) ([]ComposerCapabilityOption, []string) {
	l.callCount++
	return []ComposerCapabilityOption{{
		ID:         "connector:github",
		Kind:       "connector",
		Name:       "github",
		Label:      "GitHub",
		Status:     "available",
		Invocation: "promptItem",
	}}, nil
}

func TestServiceGetComposerOptionsSkipsCapabilityCatalogWhenDisabled(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := newIsolatedAgentService(runtime)
	service.CapabilityLister = lister
	includeCapabilityCatalog := false

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:                 "codex",
		IncludeCapabilityCatalog: &includeCapabilityCatalog,
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if lister.callCount != 0 {
		t.Fatalf("capability lister calls = %d, want 0", lister.callCount)
	}
	if len(options.CapabilityCatalog) != 0 {
		t.Fatalf("capability catalog = %#v, want empty when disabled", options.CapabilityCatalog)
	}
}

func TestServiceGetComposerOptionsIncludesConnectorCatalogWhenLabFlagEnabled(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := newIsolatedAgentService(runtime)
	service.CapabilityLister = lister
	service.DesktopPreferencesReader = connectorCatalogPreferencesReader(true)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if lister.callCount != 1 {
		t.Fatalf("capability lister calls = %d, want 1", lister.callCount)
	}
	if len(options.CapabilityCatalog) != 1 || options.CapabilityCatalog[0].ID != "connector:github" {
		t.Fatalf("capability catalog = %#v", options.CapabilityCatalog)
	}
}

func TestServiceGetComposerOptionsHidesConnectorCatalogByDefault(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := newIsolatedAgentService(runtime)
	service.CapabilityLister = lister

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if lister.callCount != 1 {
		t.Fatalf("capability lister calls = %d, want 1", lister.callCount)
	}
	if len(options.CapabilityCatalog) != 0 {
		t.Fatalf("capability catalog = %#v, want connectors hidden", options.CapabilityCatalog)
	}
}

func TestServiceGetComposerOptionsHidesConnectorCatalogWhenPreferencesAreUnavailable(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := newIsolatedAgentService(runtime)
	service.CapabilityLister = lister
	service.DesktopPreferencesReader = fakeDesktopPreferencesReader{
		err: errors.New("preferences unavailable"),
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(options.CapabilityCatalog) != 0 {
		t.Fatalf("capability catalog = %#v, want connectors hidden", options.CapabilityCatalog)
	}
	errors, ok := options.RuntimeContext["capabilityCatalogErrors"].([]string)
	if !ok || len(errors) != 1 || errors[0] != "load connector visibility: preferences unavailable" {
		t.Fatalf("capability catalog errors = %#v", options.RuntimeContext["capabilityCatalogErrors"])
	}
}

func TestServiceGetComposerOptionsUsesLocalInstalledConnectorCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := newIsolatedAgentService(runtime)
	service.CapabilityLister = lister
	service.DesktopPreferencesReader = connectorCatalogPreferencesReader(true)
	service.ConnectorMarketSnapshots = connectorMarketSnapshotStub{
		snapshot: market.Snapshot{Connectors: []market.Connector{
			localConnectorFixture(
				"notion",
				market.InstallationStateInstalled,
				market.AuthorizationStateDisconnected,
				market.CompatibilityStateSupported,
			),
		}},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(options.CapabilityCatalog) != 1 {
		t.Fatalf("capability catalog = %#v, want only local DB connector", options.CapabilityCatalog)
	}
	connector := options.CapabilityCatalog[0]
	if connector.ID != "connector:notion" || connector.Source != "local-db" || connector.Status != "authRequired" {
		t.Fatalf("connector = %#v", connector)
	}
}

func TestServiceGetComposerOptionsUsesCurrentAccountConnectorAuthorization(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.DesktopPreferencesReader = connectorCatalogPreferencesReader(true)
	snapshots := &scopedConnectorMarketSnapshotStub{
		snapshot: market.Snapshot{Connectors: []market.Connector{
			localConnectorFixture(
				"github",
				market.InstallationStateInstalled,
				market.AuthorizationStateDisconnected,
				market.CompatibilityStateSupported,
			),
		}},
		scopedSnapshot: market.Snapshot{Connectors: []market.Connector{
			localConnectorFixture(
				"github",
				market.InstallationStateInstalled,
				market.AuthorizationStateConnected,
				market.CompatibilityStateSupported,
			),
		}},
	}
	service.ConnectorMarketSnapshots = snapshots
	service.ConnectorMarketCurrentScope = func() market.OperationScope {
		return market.OperationScope{AccountID: "account-1"}
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(options.CapabilityCatalog) != 1 || options.CapabilityCatalog[0].Status != "available" {
		t.Fatalf("capability catalog = %#v, want current account connector available", options.CapabilityCatalog)
	}
	if snapshots.requestedScope.AccountID != "account-1" {
		t.Fatalf("connector snapshot scope = %#v, want current account", snapshots.requestedScope)
	}
}

func TestServiceGetComposerOptionsCachesCapabilityCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	lister := &recordingComposerCapabilityLister{}
	service := newIsolatedAgentService(runtime)
	service.CapabilityLister = lister
	service.DesktopPreferencesReader = connectorCatalogPreferencesReader(true)

	first, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions first returned error: %v", err)
	}
	first.CapabilityCatalog[0].ID = "mutated"
	second, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions second returned error: %v", err)
	}
	if lister.callCount != 1 {
		t.Fatalf("capability lister calls = %d, want 1", lister.callCount)
	}
	if len(second.CapabilityCatalog) != 1 || second.CapabilityCatalog[0].ID != "connector:github" {
		t.Fatalf("cached capability catalog = %#v, want unmutated github connector", second.CapabilityCatalog)
	}
}

func connectorCatalogPreferencesReader(enabled bool) fakeDesktopPreferencesReader {
	return fakeDesktopPreferencesReader{
		preferences: preferencesbiz.DesktopPreferences{
			FeatureFlags: map[string]bool{
				preferencesbiz.LabFlagConnectors: enabled,
			},
		},
	}
}

func TestServiceGetsComposerOptionsLocalizesDisplayLabels(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Locale:   "zh-CN",
		Provider: "claude-code",
		Settings: ComposerSettings{
			PermissionModeID: "dontAsk",
			ReasoningEffort:  "xhigh",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.ReasoningConfig.Options[len(options.ReasoningConfig.Options)-1].Label != "超高" {
		t.Fatalf("reasoningConfig = %#v, want zh-CN xhigh label", options.ReasoningConfig)
	}
	var dontAsk PermissionModeOption
	for _, mode := range options.PermissionConfig.Modes {
		if mode.ID == "dontAsk" {
			dontAsk = mode
		}
	}
	if dontAsk.Label != "不再询问" || dontAsk.Description == "" {
		t.Fatalf("dontAsk = %#v, want localized label and description", dontAsk)
	}
	capabilities, ok := options.RuntimeContext["capabilities"].([]string)
	if !ok || !slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceGetsComposerOptionsFromCodexModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "gpt-5",
					DisplayName:                "GPT-5",
					DefaultReasoningEffort:     "minimal",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts:  []AgentModelReasoningEffortOption{{Value: "minimal"}},
				},
				{ID: "gpt-5.1", DisplayName: "GPT-5.1"},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			Model:           "gpt-5.2-custom",
			ReasoningEffort: "medium",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	modelOptions, ok := configOptions[0]["options"].([]map[string]any)
	if !ok {
		t.Fatalf("model options = %#v", configOptions[0]["options"])
	}
	if len(modelOptions) != 3 {
		t.Fatalf("len(modelOptions) = %d, want catalog models plus selected custom model", len(modelOptions))
	}
	if modelOptions[0]["value"] != "gpt-5" || modelOptions[1]["value"] != "gpt-5.1" || modelOptions[2]["value"] != "gpt-5.2-custom" {
		t.Fatalf("modelOptions = %#v", modelOptions)
	}
	if options.RuntimeContext["modelCatalogSource"] != "codex-cli" {
		t.Fatalf("modelCatalogSource = %#v, want codex-cli", options.RuntimeContext["modelCatalogSource"])
	}
	reasoningProfiles := options.ReasoningOptionsByModel
	gpt5Reasoning, ok := reasoningProfiles["gpt-5"]
	if !ok || gpt5Reasoning.DefaultValue != "minimal" {
		t.Fatalf("gpt-5 reasoning profile = %#v", reasoningProfiles["gpt-5"])
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
}

func TestServiceGetsComposerOptionsFromTuttiAgentModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "tutti-agent",
			Source:   "tutti-agent-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5.4", DisplayName: "GPT-5.4", IsDefault: true},
				{ID: "nova-micro", DisplayName: "Nova Micro"},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "tutti-agent",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "gpt-5.4" {
		t.Fatalf("effectiveSettings.model = %q, want gpt-5.4", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "" || options.EffectiveSettings.Speed != "" {
		t.Fatalf("provider-wide hidden controls leaked into effectiveSettings: %#v", options.EffectiveSettings)
	}
	if options.ModelConfig.CurrentValue != "gpt-5.4" || len(options.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v, want catalog-backed tutti-agent models", options.ModelConfig)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) != 1 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "model" || configOptions[0]["currentValue"] != "gpt-5.4" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	if len(options.ReasoningOptionsByModel) != 0 ||
		options.ReasoningConfig.Configurable ||
		options.SpeedConfig.Configurable {
		t.Fatalf("provider-wide hidden controls leaked into composer options: %#v", options)
	}
	if options.RuntimeContext["modelCatalogSource"] != "tutti-agent-cli" {
		t.Fatalf("modelCatalogSource = %#v, want tutti-agent-cli", options.RuntimeContext["modelCatalogSource"])
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
}

func TestServiceGetsComposerOptionsFromOpenCodeModelCatalogWithReasoning(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	imageSupported := true
	catalogInputs := []AgentModelCatalogInput{}
	service.ModelCatalog = fakeModelCatalog{
		inputs: &catalogInputs,
		result: AgentModelCatalogResult{
			Provider: "opencode",
			Source:   "opencode-cli",
			Models: []AgentModelOption{
				{
					ID:                         "openai/gpt-5.3-codex-spark",
					DisplayName:                "GPT-5.3 Codex Spark",
					IsDefault:                  true,
					SupportsImageInput:         &imageSupported,
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"}, {Value: "medium"}, {Value: "high"}, {Value: "max"},
					},
				},
				{ID: "opencode/big-pickle", DisplayName: "Big Pickle", ReasoningEffortsAdvertised: true},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "opencode",
		Cwd:      "/workspace",
		Settings: ComposerSettings{
			ReasoningEffort: "none",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(catalogInputs) != 1 || catalogInputs[0].Provider != "opencode" || catalogInputs[0].Cwd != "/workspace" {
		t.Fatalf("model catalog inputs = %#v, want one workspace-scoped OpenCode lookup", catalogInputs)
	}
	if options.EffectiveSettings.Model != "openai/gpt-5.3-codex-spark" {
		t.Fatalf("effectiveSettings.model = %q, want openai/gpt-5.3-codex-spark", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "low" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want low", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) != 1 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "model" || configOptions[0]["currentValue"] != "openai/gpt-5.3-codex-spark" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	modelOptions, ok := configOptions[0]["options"].([]map[string]any)
	if !ok || len(modelOptions) == 0 || modelOptions[0]["supportsImageInput"] != true {
		t.Fatalf("model options = %#v, want supportsImageInput true", configOptions[0]["options"])
	}
	profiles := options.ReasoningOptionsByModel
	sparkProfile, ok := profiles["openai/gpt-5.3-codex-spark"]
	if !ok || sparkProfile.DefaultValue != "low" {
		t.Fatalf("spark reasoning profile = %#v", sparkProfile)
	}
	bigPickleProfile, ok := profiles["opencode/big-pickle"]
	if !ok {
		t.Fatalf("Big Pickle reasoning profile = %#v", profiles["opencode/big-pickle"])
	}
	if len(bigPickleProfile.Options) != 0 {
		t.Fatalf("Big Pickle reasoning options = %#v, want empty", bigPickleProfile.Options)
	}
	if options.RuntimeContext["modelCatalogSource"] != "opencode-cli" {
		t.Fatalf("modelCatalogSource = %#v, want opencode-cli", options.RuntimeContext["modelCatalogSource"])
	}
	capabilities, ok := options.RuntimeContext["capabilities"].([]string)
	if !ok || !slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want imageInput", options.RuntimeContext["capabilities"])
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
}

func TestServiceGetsComposerOptionsWithResolvedCodexDefaultModel(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5.5", DisplayName: "GPT-5.5", IsDefault: true},
				{ID: "gpt-5.4", DisplayName: "GPT-5.4"},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "gpt-5.5" {
		t.Fatalf("effectiveSettings.model = %q, want gpt-5.5", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["currentValue"] != "gpt-5.5" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	if len(configOptions) < 2 || configOptions[1]["currentValue"] != "high" {
		t.Fatalf("reasoning option = %#v", configOptions)
	}
}

func TestServiceGetsComposerOptionsPreservesCodexModelCatalogReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "gpt-5.6-sol",
					DisplayName:                "GPT-5.6-Sol",
					DefaultReasoningEffort:     "low",
					IsDefault:                  true,
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"},
						{Value: "ultra"},
					},
				},
				{
					ID:                         "gpt-5.6-luna",
					DisplayName:                "GPT-5.6-Luna",
					DefaultReasoningEffort:     "medium",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"},
						{Value: "medium"},
						{Value: "high"},
						{Value: "xhigh"},
						{Value: "max"},
					},
				},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			Model:           "gpt-5.6-luna",
			ReasoningEffort: "ultra",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "medium" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want medium", options.EffectiveSettings.ReasoningEffort)
	}
	values := make([]string, 0, len(options.ReasoningConfig.Options))
	for _, option := range options.ReasoningConfig.Options {
		values = append(values, option.Value)
	}
	if !slices.Equal(values, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("reasoningConfig values = %#v, want selected Luna model capabilities", values)
	}
	profiles := options.ReasoningOptionsByModel
	solProfile := profiles["gpt-5.6-sol"]
	lunaProfile := profiles["gpt-5.6-luna"]
	if len(solProfile.Options) != 2 || len(lunaProfile.Options) != 5 {
		t.Fatalf("reasoning profiles = %#v, want model-specific option counts", profiles)
	}
}

func TestServiceGetsComposerOptionsPreservesAdvertisedEmptyReasoningEfforts(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "no-reasoning",
					DisplayName:                "No Reasoning",
					IsDefault:                  true,
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts:  []AgentModelReasoningEffortOption{},
				},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "" || len(options.ReasoningConfig.Options) != 0 {
		t.Fatalf("reasoningConfig = %#v, want authoritative empty options", options.ReasoningConfig)
	}
	profiles := options.ReasoningOptionsByModel
	profile, ok := profiles["no-reasoning"]
	if !ok {
		t.Fatalf("no-reasoning profile = %#v", profiles["no-reasoning"])
	}
	if len(profile.Options) != 0 {
		t.Fatalf("no-reasoning profile options = %#v, want empty", profile.Options)
	}
}

func TestServiceGetsComposerOptionsPreservesAdvertisedMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "minimal-only",
					DisplayName:                "Minimal Only",
					DefaultReasoningEffort:     "minimal",
					IsDefault:                  true,
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "minimal"},
					},
				},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "minimal" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want minimal", options.EffectiveSettings.ReasoningEffort)
	}
	if options.ReasoningConfig.CurrentValue != "minimal" {
		t.Fatalf("reasoningConfig.currentValue = %q, want minimal", options.ReasoningConfig.CurrentValue)
	}
	if len(options.ReasoningConfig.Options) != 1 || options.ReasoningConfig.Options[0].Value != "minimal" {
		t.Fatalf("reasoningConfig.options = %#v, want only minimal", options.ReasoningConfig.Options)
	}
}

func TestServiceGetsComposerOptionsPreservesSelectedAdvertisedReasoningEffort(t *testing.T) {
	for _, effort := range []string{"minimal", "none"} {
		t.Run(effort, func(t *testing.T) {
			service := NewService(newFakeRuntime())
			service.ModelCatalog = fakeModelCatalog{
				result: AgentModelCatalogResult{
					Provider: "codex",
					Source:   "codex-cli",
					Models: []AgentModelOption{{
						ID:                         "gpt-catalog",
						DefaultReasoningEffort:     "high",
						IsDefault:                  true,
						ReasoningEffortsAdvertised: true,
						SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
							{Value: "minimal"}, {Value: "none"}, {Value: "high"},
						},
					}},
				},
			}

			options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
				Provider: "codex",
				Settings: ComposerSettings{Model: "gpt-catalog", ReasoningEffort: effort},
			})
			if err != nil {
				t.Fatalf("GetComposerOptions returned error: %v", err)
			}
			if options.EffectiveSettings.ReasoningEffort != effort || options.ReasoningConfig.CurrentValue != effort {
				t.Fatalf("composer reasoning = %#v, want %q", options.ReasoningConfig, effort)
			}
		})
	}
}

func TestServiceGetsComposerOptionsNormalizesCodexMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			ReasoningEffort: "minimal",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "minimal" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want minimal", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) < 1 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	var reasoningOption map[string]any
	for _, option := range configOptions {
		if option["id"] == "reasoning_effort" {
			reasoningOption = option
			break
		}
	}
	if reasoningOption == nil {
		t.Fatalf("configOptions = %#v, want reasoning_effort option", configOptions)
	}
	reasoningOptions, ok := reasoningOption["options"].([]map[string]string)
	if !ok {
		t.Fatalf("reasoning options = %#v", reasoningOption["options"])
	}
	if len(reasoningOptions) != 1 || reasoningOptions[0]["value"] != "minimal" {
		t.Fatalf("reasoning options = %#v, want selected model-catalog value preserved", reasoningOptions)
	}
}

func TestServiceGetsComposerOptionsNormalizesClaudeMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
		Settings: ComposerSettings{
			ReasoningEffort: "minimal",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) < 1 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	var reasoningOption map[string]any
	for _, option := range configOptions {
		if option["id"] == "effort" {
			reasoningOption = option
			break
		}
	}
	if reasoningOption == nil {
		t.Fatalf("configOptions = %#v, want effort option", configOptions)
	}
	reasoningOptions, ok := reasoningOption["options"].([]map[string]string)
	if !ok {
		t.Fatalf("reasoning options = %#v", reasoningOption["options"])
	}
	for _, option := range reasoningOptions {
		if option["value"] == "minimal" {
			t.Fatalf("reasoning options = %#v, want claude minimal filtered out", reasoningOptions)
		}
	}
}

func TestServiceGetsComposerOptionsUsesClaudeStaticModelsWithoutModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "claude-code",
			Source:   "test-ignored",
			Models: []AgentModelOption{
				{ID: "sonnet", DisplayName: "sonnet"},
				{ID: "default", DisplayName: "default", IsDefault: true},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "default" {
		t.Fatalf("effectiveSettings.model = %q, want static default", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	if options.RuntimeContext["modelCatalogSource"] != "claude-static" {
		t.Fatalf("modelCatalogSource = %#v, want claude-static", options.RuntimeContext["modelCatalogSource"])
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want static Claude model option first", configOptions)
	}
	modelOptions, ok := configOptions[0]["options"].([]map[string]any)
	if !ok || len(modelOptions) != 4 {
		t.Fatalf("model options = %#v, want Claude static aliases", configOptions[0]["options"])
	}
	for _, option := range modelOptions {
		if option["value"] == "test-ignored" {
			t.Fatalf("model options = %#v, want no daemon ModelCatalog models for Claude", modelOptions)
		}
	}
}

func TestGetComposerOptionsClaudeCodeWithoutWorkspaceUsesStaticModels(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
		Cwd:      "/repo",
		Settings: ComposerSettings{
			Model: "claude-sonnet-4-20250514",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "claude-sonnet-4-20250514" {
		t.Fatalf("effectiveSettings.model = %q, want requested custom model", options.EffectiveSettings.Model)
	}
	if options.RuntimeContext["model"] != "claude-sonnet-4-20250514" {
		t.Fatalf("runtime model = %#v, want requested custom model", options.RuntimeContext["model"])
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 5 {
		t.Fatalf("modelConfig = %#v, want static Claude models plus requested custom model", options.ModelConfig)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want static Claude model option first", configOptions)
	}
	if options.RuntimeContext["modelCatalogSource"] != "claude-static" {
		t.Fatalf("modelCatalogSource = %#v, want claude-static", options.RuntimeContext["modelCatalogSource"])
	}
}

func TestGetComposerOptionsClaudeCodeIncludesSettingsJSONModel(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), []byte(`{"model":"claude-opus-4-6"}`), 0o600); err != nil {
		t.Fatalf("write Claude settings: %v", err)
	}
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
		Cwd:      "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "claude-opus-4-6" {
		t.Fatalf("effectiveSettings.model = %q, want settings.json model", options.EffectiveSettings.Model)
	}
	found := false
	for _, option := range options.ModelConfig.Options {
		if option.Value == "claude-opus-4-6" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("modelConfig options = %#v, want settings.json model included", options.ModelConfig.Options)
	}
	if options.RuntimeContext["modelCatalogSource"] != "claude-static" {
		t.Fatalf("modelCatalogSource = %#v, want claude-static", options.RuntimeContext["modelCatalogSource"])
	}
}
