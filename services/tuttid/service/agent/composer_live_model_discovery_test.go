package agent

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestClaudeModelCatalogDebugPayloadDropsSensitiveDiagnostics(t *testing.T) {
	payload := claudeModelCatalogDebugPayload("discovery_uncached_failed", map[string]any{
		"provider":          "claude-code",
		"modelOptionCount":  3,
		"cwd":               "/Users/private/repo",
		"error":             "token sk-secret failed for account@example.com",
		"modelOptionValues": []string{"private-model"},
	})
	if payload["provider"] != "claude-code" || payload["modelOptionCount"] != 3 {
		t.Fatalf("safe fields missing: %#v", payload)
	}
	for _, key := range []string{"cwd", "error", "modelOptionValues"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("sensitive field %q survived: %#v", key, payload)
		}
	}
	if payload["errorClass"] != "discovery_failed" {
		t.Fatalf("error class = %#v", payload["errorClass"])
	}
}

// cursorModelRuntimeContext mirrors the configOptions a live cursor-agent
// (2026.07) session advertises: parameterized model ids in {value, name}.
func cursorModelRuntimeContext() map[string]any {
	return map[string]any{
		"configOptions": []any{
			map[string]any{
				"id":           "model",
				"currentValue": "composer-2.5[fast=true]",
				"options": []any{
					map[string]any{"value": "default[]", "name": "Auto"},
					map[string]any{"value": "composer-2.5[fast=true]", "name": "composer-2.5"},
					map[string]any{"value": "gpt-5.2[reasoning=medium,fast=false]", "name": "gpt-5.2"},
				},
			},
		},
	}
}

func TestLiveModelOptionsFromRunningSessionFiltersProvider(t *testing.T) {
	t.Parallel()
	runtime := newFakeRuntime()
	runtime.sessions["claude-1"] = ProviderRuntimeSession{
		ID: "claude-1", WorkspaceID: "ws-1", Provider: "claude-code",
	}
	runtime.sessions["cursor-1"] = ProviderRuntimeSession{
		ID: "cursor-1", WorkspaceID: "ws-1", Provider: "cursor",
		RuntimeContext: cursorModelRuntimeContext(),
	}
	service := newIsolatedAgentService(runtime)

	options, hasSession := service.liveModelOptionsFromRunningSession("ws-1", "cursor")
	if !hasSession || len(options) != 3 {
		t.Fatalf("cursor options = %#v hasSession = %v, want 3 live models", options, hasSession)
	}
	if options[1].Value != "composer-2.5[fast=true]" || options[1].Label != "composer-2.5" {
		t.Fatalf("cursor option[1] = %#v, want parameterized value with display label", options[1])
	}
	if _, hasClaude := service.liveModelOptionsFromRunningSession("ws-1", "claude-code"); !hasClaude {
		t.Fatal("claude session must be detected")
	}
	if _, hasUnknown := service.liveModelOptionsFromRunningSession("ws-1", "unknown-provider"); hasUnknown {
		t.Fatal("unknown provider must not match cursor/claude sessions")
	}
}

func TestDiscoverLiveComposerModelsUncachedSkipsProbeForCursor(t *testing.T) {
	t.Parallel()
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)

	_, err := service.discoverLiveComposerModelsUncached(
		context.Background(), "cursor", "ws-1", "", ComposerSettings{},
	)
	if !errors.Is(err, errLiveModelDiscoveryAlreadyAttempted) {
		t.Fatalf("err = %v, want probe skipped for cursor", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %#v, cursor discovery must never spawn a hidden session", runtime.startCalls)
	}
}

func TestGetComposerOptionsMergesLiveCursorModels(t *testing.T) {
	t.Parallel()
	runtime := newFakeRuntime()
	runtime.sessions["cursor-1"] = ProviderRuntimeSession{
		ID: "cursor-1", WorkspaceID: "ws-1", Provider: "cursor",
		RuntimeContext: cursorModelRuntimeContext(),
	}
	service := newIsolatedAgentService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "cursor",
		WorkspaceID: "ws-1",
		Settings: ComposerSettings{
			Model:            "composer-2.5[fast=true]",
			PermissionModeID: "agent",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if !options.ModelConfig.Configurable {
		t.Fatal("cursor model config must be configurable")
	}
	if len(options.ModelConfig.Options) != 3 {
		t.Fatalf("model options = %#v, want the 3 live models", options.ModelConfig.Options)
	}
	if options.ModelConfig.Options[0].Value != "default[]" || options.ModelConfig.Options[0].Label != "Auto" {
		t.Fatalf("model option[0] = %#v, want live Auto entry", options.ModelConfig.Options[0])
	}
	if options.ModelConfig.CurrentValue != "composer-2.5[fast=true]" {
		t.Fatalf("model current value = %q", options.ModelConfig.CurrentValue)
	}
}

// After a daemon restart the runtime session and the in-memory cache are both
// gone; the model list a past cursor conversation persisted in its runtime
// context must restore the picker instead of collapsing it to the single
// selected model (Cursor has no probe session to re-discover with).
func TestGetComposerOptionsRestoresCursorModelsFromPersistedSessions(t *testing.T) {
	t.Parallel()
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:cursor-old": {
				ID:                     "cursor-old",
				WorkspaceID:            "ws-1",
				Provider:               "cursor",
				InternalRuntimeContext: cursorModelRuntimeContext(),
				UpdatedAtUnixMS:        1000,
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider:    "cursor",
		WorkspaceID: "ws-1",
		Cwd:         "/repo",
		Settings: ComposerSettings{
			Model:            "composer-2.5[fast=true]",
			PermissionModeID: "agent",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(options.ModelConfig.Options) != 3 {
		t.Fatalf("model options = %#v, want the 3 persisted models", options.ModelConfig.Options)
	}
	if options.ModelConfig.CurrentValue != "composer-2.5[fast=true]" {
		t.Fatalf("model current value = %q", options.ModelConfig.CurrentValue)
	}
	if options.RuntimeContext["modelCatalogSource"] != runtimeLiveModelCatalogSource {
		t.Fatalf("modelCatalogSource = %#v, want %s", options.RuntimeContext["modelCatalogSource"], runtimeLiveModelCatalogSource)
	}
	// The restored list must seed the cache so later fetches skip the scan.
	if cached, ok := service.getLiveComposerModelOptions("cursor", "ws-1", "/repo", time.Now().UTC()); !ok || len(cached) != 3 {
		t.Fatalf("cache after persisted fallback = %#v ok = %v, want 3 entries", cached, ok)
	}
}

// countingSessionReader wraps fakeSessionReader to count ListSessions calls:
// the persisted-session scan reads every session row in the workspace, so a
// workspace with nothing to restore must not rescan on every fetch.
type countingSessionReader struct {
	fakeSessionReader
	listCalls int
}

func (r *countingSessionReader) ListSessions(workspaceID string) ([]PersistedSession, bool) {
	r.listCalls++
	return r.fakeSessionReader.ListSessions(workspaceID)
}

func TestPersistedLiveModelFallbackMemoizesScanMisses(t *testing.T) {
	t.Parallel()
	service := newIsolatedAgentService(newFakeRuntime())
	reader := &countingSessionReader{}
	service.SessionReader = reader

	now := time.Now().UTC()
	if _, ok := service.persistedLiveModelFallback("ws-1", "/repo", "cursor", now); ok {
		t.Fatal("fallback with no persisted sessions returned options")
	}
	if _, ok := service.persistedLiveModelFallback("ws-1", "/repo", "cursor", now.Add(time.Minute)); ok {
		t.Fatal("fallback with no persisted sessions returned options")
	}
	if reader.listCalls != 1 {
		t.Fatalf("ListSessions calls = %d, want the second miss served from the memo", reader.listCalls)
	}

	// The memo expires: a later fetch rescans and restores newly persisted
	// sessions.
	reader.sessions = map[string]PersistedSession{
		"ws-1:cursor-new": {
			ID: "cursor-new", WorkspaceID: "ws-1", Provider: "cursor",
			InternalRuntimeContext: cursorModelRuntimeContext(), UpdatedAtUnixMS: 900,
		},
	}
	options, ok := service.persistedLiveModelFallback("ws-1", "/repo", "cursor", now.Add(persistedLiveModelScanMissTTL+time.Minute))
	if !ok || len(options) != 3 {
		t.Fatalf("fallback after memo expiry = %#v ok = %v, want the 3 persisted models", options, ok)
	}
	if reader.listCalls != 2 {
		t.Fatalf("ListSessions calls = %d, want exactly one rescan after memo expiry", reader.listCalls)
	}
}

func TestLiveModelOptionsFromPersistedSessionsPicksNewestAndSkipsStale(t *testing.T) {
	t.Parallel()
	service := newIsolatedAgentService(newFakeRuntime())
	oldContext := map[string]any{
		"configOptions": []any{
			map[string]any{
				"id": "model",
				"options": []any{
					map[string]any{"value": "composer-2[fast=true]", "name": "composer-2"},
				},
			},
		},
	}
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:older": {
				ID: "older", WorkspaceID: "ws-1", Provider: "cursor",
				InternalRuntimeContext: oldContext, UpdatedAtUnixMS: 500,
			},
			"ws-1:newer": {
				ID: "newer", WorkspaceID: "ws-1", Provider: "cursor",
				InternalRuntimeContext: cursorModelRuntimeContext(), UpdatedAtUnixMS: 900,
			},
			"ws-1:hidden": {
				ID: "hidden", WorkspaceID: "ws-1", Provider: "cursor",
				InternalRuntimeContext: map[string]any{"hiddenLiveModelDiscovery": true},
				UpdatedAtUnixMS:        2000,
			},
			"ws-1:other-provider": {
				ID: "other-provider", WorkspaceID: "ws-1", Provider: "claude-code",
				InternalRuntimeContext: oldContext, UpdatedAtUnixMS: 3000,
			},
		},
	}

	options := service.liveModelOptionsFromPersistedSessions("ws-1", "cursor")
	if len(options) != 3 {
		t.Fatalf("options = %#v, want the newer session's 3 models", options)
	}

	// Sessions persisted before an auth/config invalidation are stale.
	service.InvalidateLiveComposerModels("cursor")
	if got := service.liveModelOptionsFromPersistedSessions("ws-1", "cursor"); got != nil {
		t.Fatalf("options after invalidation = %#v, want nil", got)
	}
}

func TestExtractModelOptionsFromRuntimeContext(t *testing.T) {
	options := extractModelOptionsFromRuntimeContext(map[string]any{
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
				"id": "effort",
			},
		},
	})
	if len(options) != 2 {
		t.Fatalf("len(options) = %d, want 2", len(options))
	}
	if options[0].Value != "default" || options[1].Value != "sonnet" {
		t.Fatalf("options = %#v, want default and sonnet", options)
	}
}

func TestMergeLiveModelsIntoComposerOptionsUpdatesRuntimeContext(t *testing.T) {
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider: "claude-code",
		EffectiveSettings: ComposerSettings{
			Model: "default",
		},
		RuntimeContext: map[string]any{
			"configOptions": []map[string]any{
				{
					"id":           "effort",
					"currentValue": "high",
				},
			},
		},
	}, []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet"},
	})
	if !merged.ModelConfig.Configurable || len(merged.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v", merged.ModelConfig)
	}
	if merged.RuntimeContext["modelCatalogSource"] != runtimeLiveModelCatalogSource {
		t.Fatalf("modelCatalogSource = %#v, want %s", merged.RuntimeContext["modelCatalogSource"], runtimeLiveModelCatalogSource)
	}
	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) != 2 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model + effort", merged.RuntimeContext["configOptions"])
	}
}

func TestMergeLiveModelsIntoComposerOptionsKeepsModelDescriptionInRuntimeContext(t *testing.T) {
	// Regression: the desktop composer projection prefers the model list in
	// RuntimeContext["configOptions"] over ModelConfig.Options, so the per-model
	// description must survive into the runtime configOptions or the hover
	// detail disappears.
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider:          "claude-code",
		EffectiveSettings: ComposerSettings{Model: "default"},
		RuntimeContext:    map[string]any{},
	}, []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default", Description: "Opus 4.8 with 1M context · Best for everyday, complex tasks"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet", Description: "Sonnet 4.6 · Efficient for routine tasks"},
	})

	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model option", merged.RuntimeContext["configOptions"])
	}
	options, ok := configOptions[0]["options"].([]map[string]any)
	if !ok || len(options) != 2 {
		t.Fatalf("model options = %#v, want 2 entries", configOptions[0]["options"])
	}
	if got := options[0]["description"]; got != "Opus 4.8 with 1M context · Best for everyday, complex tasks" {
		t.Fatalf("default description = %q, want the Opus description", got)
	}
	if got := options[1]["description"]; got != "Sonnet 4.6 · Efficient for routine tasks" {
		t.Fatalf("sonnet description = %q, want the Sonnet description", got)
	}
}

func TestMergeLiveModelsIntoComposerOptionsKeepsSupportsImageInput(t *testing.T) {
	imageSupported := true
	imageUnsupported := false
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider:          "cursor",
		EffectiveSettings: ComposerSettings{Model: "gpt-5.5[context=272k,reasoning=medium,fast=false]"},
		RuntimeContext:    map[string]any{},
	}, []ComposerConfigOptionValue{
		{
			ID:                 "gpt-5.5[context=272k,reasoning=medium,fast=false]",
			Label:              "GPT-5.5",
			Value:              "gpt-5.5[context=272k,reasoning=medium,fast=false]",
			SupportsImageInput: &imageSupported,
		},
		{
			ID:                 "glm-5.2[reasoning=high]",
			Label:              "GLM-5.2",
			Value:              "glm-5.2[reasoning=high]",
			SupportsImageInput: &imageUnsupported,
		},
	})

	if len(merged.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig options = %#v, want 2 entries", merged.ModelConfig.Options)
	}
	if got := merged.ModelConfig.Options[0].SupportsImageInput; got == nil || !*got {
		t.Fatalf("modelConfig gpt supportsImageInput = %#v, want true", got)
	}
	if got := merged.ModelConfig.Options[1].SupportsImageInput; got == nil || *got {
		t.Fatalf("modelConfig glm supportsImageInput = %#v, want false", got)
	}
	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model option", merged.RuntimeContext["configOptions"])
	}
	options, ok := configOptions[0]["options"].([]map[string]any)
	if !ok || len(options) != 2 {
		t.Fatalf("runtime model options = %#v, want 2 entries", configOptions[0]["options"])
	}
	if got := options[0]["supportsImageInput"]; got != true {
		t.Fatalf("runtime gpt supportsImageInput = %#v, want true", got)
	}
	if got := options[1]["supportsImageInput"]; got != false {
		t.Fatalf("runtime glm supportsImageInput = %#v, want false", got)
	}
}

func TestMergeLiveModelsIntoComposerOptionsDoesNotAppendUnsupportedSelectedModel(t *testing.T) {
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider: "claude-code",
		EffectiveSettings: ComposerSettings{
			Model: "claude-sonnet-4-20250514",
		},
		RuntimeContext: map[string]any{},
	}, []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet"},
		{ID: "opus", Label: "Opus", Value: "opus"},
		{ID: "haiku", Label: "Haiku", Value: "haiku"},
	})

	if merged.ModelConfig.CurrentValue != "default" || merged.ModelConfig.DefaultValue != "default" {
		t.Fatalf("modelConfig = %#v, want default current/default", merged.ModelConfig)
	}
	if merged.EffectiveSettings.Model != "default" {
		t.Fatalf("effectiveSettings.model = %q, want default", merged.EffectiveSettings.Model)
	}
	for _, option := range merged.ModelConfig.Options {
		if option.Value == "claude-sonnet-4-20250514" {
			t.Fatalf("modelConfig options = %#v, want no unsupported selected model", merged.ModelConfig.Options)
		}
	}
	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v, want model option", merged.RuntimeContext["configOptions"])
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
	if merged.RuntimeContext["model"] != "default" {
		t.Fatalf("runtime model = %#v, want default", merged.RuntimeContext["model"])
	}
}

func TestMergeLiveModelsIntoComposerOptionsKeepsSelectedAlias(t *testing.T) {
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider: "claude-code",
		EffectiveSettings: ComposerSettings{
			Model: "sonnet",
		},
		RuntimeContext: map[string]any{},
	}, []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet"},
		{ID: "opus", Label: "Opus", Value: "opus"},
		{ID: "haiku", Label: "Haiku", Value: "haiku"},
	})

	if merged.ModelConfig.CurrentValue != "sonnet" || merged.ModelConfig.DefaultValue != "sonnet" {
		t.Fatalf("modelConfig = %#v, want selected alias current/default", merged.ModelConfig)
	}
	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v, want model option", merged.RuntimeContext["configOptions"])
	}
	if configOptions[0]["currentValue"] != "sonnet" {
		t.Fatalf("model runtime option = %#v, want selected alias currentValue", configOptions[0])
	}
}
