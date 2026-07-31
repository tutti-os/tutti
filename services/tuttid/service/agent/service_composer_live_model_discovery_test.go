package agent

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestGetComposerOptionsClaudeCodeReusesRunningSessionLiveModels(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
						map[string]any{"name": "Sonnet", "value": "sonnet"},
					},
				},
				map[string]any{
					"id":           "effort",
					"currentValue": "high",
					"options": []any{
						map[string]any{"name": "High", "value": "high"},
					},
				},
			},
		},
	}
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want no hidden discovery", len(runtime.startCalls))
	}
	if len(runtime.closeCalls) != 0 {
		t.Fatalf("close calls = %d, want no hidden discovery cleanup", len(runtime.closeCalls))
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v, want discovered model options", options.ModelConfig)
	}
	if options.RuntimeContext["modelCatalogSource"] != runtimeLiveModelCatalogSource {
		t.Fatalf("modelCatalogSource = %#v, want %s", options.RuntimeContext["modelCatalogSource"], runtimeLiveModelCatalogSource)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model option merged into runtime context", options.RuntimeContext["configOptions"])
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsSanitizesUnsupportedSelectedModel(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
						map[string]any{"name": "Sonnet", "value": "sonnet"},
						map[string]any{"name": "Opus", "value": "opus"},
						map[string]any{"name": "Haiku", "value": "haiku"},
					},
				},
			},
		},
	}
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
		Settings: ComposerSettings{
			Model: "claude-sonnet-4-20250514",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "default" {
		t.Fatalf("effectiveSettings.model = %q, want default", options.EffectiveSettings.Model)
	}
	if options.ModelConfig.CurrentValue != "default" || options.ModelConfig.DefaultValue != "default" {
		t.Fatalf("modelConfig = %#v, want default current/default", options.ModelConfig)
	}
	for _, option := range options.ModelConfig.Options {
		if option.Value == "claude-sonnet-4-20250514" {
			t.Fatalf("modelConfig options = %#v, want no unsupported selected model", options.ModelConfig.Options)
		}
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model option merged into runtime context", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["currentValue"] != "default" {
		t.Fatalf("model runtime option = %#v, want default currentValue", configOptions[0])
	}
	runtimeModelOptions, ok := configOptions[0]["options"].([]map[string]any)
	if !ok {
		t.Fatalf("runtime model options = %#v", configOptions[0]["options"])
	}
	for _, option := range runtimeModelOptions {
		if option["value"] == "claude-sonnet-4-20250514" {
			t.Fatalf("runtime model options = %#v, want no unsupported selected model", runtimeModelOptions)
		}
	}
}

func TestGetComposerOptionsClaudeCodeSkipsDiscoveryBesideRunningSession(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
			"capabilities": []any{"imageInput"},
		},
	}
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want no hidden discovery next to running session", len(runtime.startCalls))
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 4 {
		t.Fatalf("modelConfig = %#v, want static Claude model config when running session has no models", options.ModelConfig)
	}
	if options.RuntimeContext["modelCatalogSource"] != "claude-static" {
		t.Fatalf("modelCatalogSource = %#v, want claude-static", options.RuntimeContext["modelCatalogSource"])
	}
}

func TestGetComposerOptionsClaudeCodeSkipsStaleRunningSessionModelsAfterInvalidation(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "claude-code",
		Status:          "ready",
		CreatedAtUnixMS: 100,
		UpdatedAtUnixMS: 100,
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "sonnet",
					"options": []any{
						map[string]any{"name": "Sonnet", "value": "sonnet"},
						map[string]any{"name": "Opus", "value": "opus"},
					},
				},
			},
		},
	}
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Provider != "claude-code" {
			t.Fatalf("start provider = %q, want claude-code", input.Provider)
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "MiniMax-M2.7",
					"options": []any{
						map[string]any{"name": "MiniMax M2.7", "value": "MiniMax-M2.7"},
					},
				},
			},
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.LiveModelDiscoveryDeleteDelay = time.Hour

	service.InvalidateLiveComposerModels("claude-code")
	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want hidden discovery after invalidation", len(runtime.startCalls))
	}
	if got := options.ModelConfig.CurrentValue; got != "MiniMax-M2.7" {
		t.Fatalf("current model = %q, want MiniMax-M2.7", got)
	}
	if len(options.ModelConfig.Options) != 1 || options.ModelConfig.Options[0].Value != "MiniMax-M2.7" {
		t.Fatalf("model options = %#v, want freshly discovered MiniMax model", options.ModelConfig.Options)
	}
}

func TestGetComposerOptionsClaudeCodeStartsHiddenDiscoveryOnceAcrossWorkspacesAndCallerCwds(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	closed := make(chan RuntimeCloseInput, 1)
	runtime := &closeSignalRuntime{
		fakeRuntime: newFakeRuntime(),
		closed:      closed,
	}
	runtime.startHook = func(input RuntimeStartInput, session ProviderRuntimeSession) ProviderRuntimeSession {
		if input.Provider != "claude-code" {
			t.Fatalf("start provider = %q, want claude-code", input.Provider)
		}
		if input.Visible == nil || *input.Visible {
			t.Fatalf("visible = %#v, want hidden discovery session", input.Visible)
		}
		if input.RuntimeContext["hiddenLiveModelDiscovery"] != true {
			t.Fatalf("runtime context = %#v, want hidden discovery marker", input.RuntimeContext)
		}
		session.RuntimeContext = map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "sonnet",
					"options": []any{
						map[string]any{"name": "Sonnet", "value": "sonnet"},
						map[string]any{"name": "Opus", "value": "opus"},
					},
				},
			},
		}
		return session
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.LiveModelDiscoveryDeleteDelay = 2 * time.Second

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Provider:      "claude-code",
		WorkspaceID:   "ws-1",
		Cwd:           "/",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want one hidden discovery", len(runtime.startCalls))
	}
	wantDiscoveryCwd := filepath.Join(stateDir, "agent", "discovery", "claude-code")
	if runtime.startCalls[0].Cwd != wantDiscoveryCwd {
		t.Fatalf("discovery cwd = %q, want %q", runtime.startCalls[0].Cwd, wantDiscoveryCwd)
	}
	if runtime.startCalls[0].AgentTargetID != agenttargetbiz.IDLocalClaudeCode ||
		runtime.startCalls[0].ProviderTargetRef["targetId"] != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("discovery target = %q / %#v", runtime.startCalls[0].AgentTargetID, runtime.startCalls[0].ProviderTargetRef)
	}
	discoverySessionID := runtime.startCalls[0].AgentSessionID
	persisted := &fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:" + discoverySessionID: {
			ID: discoverySessionID, WorkspaceID: "ws-1", Provider: "claude-code",
			Metadata:               agentactivitybiz.SessionMetadata{Visible: false},
			InternalRuntimeContext: map[string]any{"hiddenLiveModelDiscovery": true},
		},
	}}
	// Model discovery sessions are reported asynchronously in production. Seed
	// the canonical observation after startup so the delayed cleanup must close
	// the runtime and remove the canonical row through Host.
	service.SessionReader = persisted
	select {
	case input := <-closed:
		t.Fatalf("unexpected immediate hidden discovery cleanup: %#v", input)
	default:
	}
	if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v, want discovered Claude model config", options.ModelConfig)
	}
	if options.RuntimeContext["modelCatalogSource"] != runtimeLiveModelCatalogSource {
		t.Fatalf("modelCatalogSource = %#v, want %s", options.RuntimeContext["modelCatalogSource"], runtimeLiveModelCatalogSource)
	}

	second, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Provider:      "claude-code",
		WorkspaceID:   "ws-2",
		Cwd:           "/Users/example/project",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions second returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want hidden discovery only once", len(runtime.startCalls))
	}
	if !second.ModelConfig.Configurable || len(second.ModelConfig.Options) != 2 {
		t.Fatalf("second modelConfig = %#v, want cached discovered model config", second.ModelConfig)
	}

	select {
	case input := <-closed:
		if input.AgentSessionID != runtime.startCalls[0].AgentSessionID {
			t.Fatalf("close input = %#v, want delayed cleanup for hidden discovery session %q", input, runtime.startCalls[0].AgentSessionID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for delayed hidden discovery cleanup")
	}
	deadline := time.Now().Add(time.Second)
	for {
		if _, exists := persisted.sessions["ws-1:"+discoverySessionID]; !exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("hidden discovery session still persisted after delayed cleanup")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestGetComposerOptionsClaudeCodeLiveModelsUsesCache(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "default",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
					},
				},
			},
		},
	}
	service := newIsolatedAgentService(runtime)

	for index := range 2 {
		options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
			Provider:    "claude-code",
			WorkspaceID: "ws-1",
			Cwd:         "/repo",
		})
		if err != nil {
			t.Fatalf("GetComposerOptions returned error: %v", err)
		}
		if !options.ModelConfig.Configurable || len(options.ModelConfig.Options) != 1 {
			t.Fatalf("modelConfig = %#v, want cached live models", options.ModelConfig)
		}
		if index == 0 {
			delete(runtime.sessions, "ws-1:session-1")
		}
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want no hidden discovery", len(runtime.startCalls))
	}
	if len(runtime.closeCalls) != 0 {
		t.Fatalf("close calls = %d, want no hidden discovery cleanup", len(runtime.closeCalls))
	}
}

func TestServiceGetsComposerOptionsLeavesUnresolvedProviderModelUnset(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "openclaw",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "" {
		t.Fatalf("effectiveSettings.model = %q, want empty", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want empty", options.EffectiveSettings.ReasoningEffort)
	}
	if capabilities, ok := options.RuntimeContext["capabilities"].([]string); ok &&
		slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want no imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceUpdateSettingsPreservesCodexModelCatalogReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		Provider:    "codex",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "high",
		},
	}
	service := newIsolatedAgentService(runtime)
	seedPersistedLiveSettingsSession(service, runtime.sessions["ws-1:session-1"])
	reasoningEffort := "minimal"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		ReasoningEffort: &reasoningEffort,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "minimal" {
		t.Fatalf("session settings = %#v, want reasoningEffort minimal", session.Settings)
	}
}

func TestServiceUpdateSettingsPreservesAdvertisedReasoningEffort(t *testing.T) {
	for _, effort := range []string{"minimal", "none"} {
		t.Run(effort, func(t *testing.T) {
			runtime := newFakeRuntime()
			runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
				ID:          "session-1",
				Provider:    "codex",
				WorkspaceID: "ws-1",
				Status:      "working",
				Settings: &ComposerSettings{
					Model:           "gpt-catalog",
					ReasoningEffort: "high",
				},
			}
			service := NewService(runtime)
			seedPersistedLiveSettingsSession(service, runtime.sessions["ws-1:session-1"])
			service.ModelCatalog = fakeModelCatalog{
				result: AgentModelCatalogResult{
					Provider: "codex",
					Source:   "codex-cli",
					Models: []AgentModelOption{{
						ID:                         "gpt-catalog",
						DefaultReasoningEffort:     "high",
						ReasoningEffortsAdvertised: true,
						SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
							{Value: "minimal"}, {Value: "none"}, {Value: "high"},
						},
					}},
				},
			}

			configureTestApplicationHost(service)
			session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
				ReasoningEffort: stringRef(effort),
			})
			if err != nil {
				t.Fatalf("UpdateSettings returned error: %v", err)
			}
			if session.Settings == nil || session.Settings.ReasoningEffort != effort {
				t.Fatalf("session settings = %#v, want reasoning %q", session.Settings, effort)
			}
		})
	}
}

func TestServiceUpdateSettingsDefersModelChangeReasoningClampToLiveRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		Provider:    "codex",
		WorkspaceID: "ws-1",
		Status:      "ready",
		Settings: &ComposerSettings{
			Model:           "gpt-5.6-sol",
			ReasoningEffort: "ultra",
		},
	}
	service := NewService(runtime)
	seedPersistedLiveSettingsSession(service, runtime.sessions["ws-1:session-1"])
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "gpt-5.6-sol",
					DefaultReasoningEffort:     "high",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"}, {Value: "medium"}, {Value: "high"},
						{Value: "xhigh"}, {Value: "max"}, {Value: "ultra"},
					},
				},
				{
					ID:                         "gpt-5.6-luna",
					DefaultReasoningEffort:     "high",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "low"}, {Value: "medium"}, {Value: "high"},
						{Value: "xhigh"}, {Value: "max"},
					},
				},
			},
		},
	}
	configureTestApplicationHost(service)
	model := "gpt-5.6-luna"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		Model: &model,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	// The daemon-side catalog intentionally lacks Luna/ultra, while a live
	// target may advertise it. The service must not downgrade before the live
	// adapter gets a chance to resolve its fresher model/list snapshot.
	if session.Settings == nil || session.Settings.Model != model || session.Settings.ReasoningEffort != "ultra" {
		t.Fatalf("session settings = %#v, want unclamped Luna/ultra runtime input", session.Settings)
	}
}

func TestServiceUpdateSettingsNormalizesClaudeMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "high",
		},
	}
	service := newIsolatedAgentService(runtime)
	seedPersistedLiveSettingsSession(service, runtime.sessions["ws-1:session-1"])
	reasoningEffort := "minimal"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		ReasoningEffort: &reasoningEffort,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "high" {
		t.Fatalf("session settings = %#v, want reasoningEffort high", session.Settings)
	}
}
