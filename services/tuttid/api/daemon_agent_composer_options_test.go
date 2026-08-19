package api

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

// Requested-origin model entries (warm-catalog append of the requested model,
// bootstrap echo) must keep their provenance across the API projection so
// clients can exclude them from catalog testimony; catalog entries omit the
// field entirely (backward-compatible optional).
func TestGeneratedComposerConfigOptionKeepsRequestedProvenance(t *testing.T) {
	generated := generatedComposerConfigOption(agentservice.ComposerConfigOption{
		Configurable:   true,
		CurrentValue:   "default",
		EffectiveValue: "claude-haiku-4-5-20251001",
		Options: []agentservice.ComposerConfigOptionValue{
			{ID: "gpt-5.6-sol", Label: "GPT-5.6 Sol", Value: "gpt-5.6-sol"},
			{ID: "x-ai/grok-4.5", Label: "x-ai/grok-4.5", Value: "x-ai/grok-4.5", Requested: true},
		},
	})
	if len(generated.Options) != 2 {
		t.Fatalf("expected both options, got %d", len(generated.Options))
	}
	if generated.Options[0].Requested != nil {
		t.Fatal("catalog entry must omit the requested field")
	}
	if generated.Options[1].Requested == nil || !*generated.Options[1].Requested {
		t.Fatal("requested-origin entry must project requested=true")
	}
	if generated.CurrentValue == nil || *generated.CurrentValue != "default" {
		t.Fatalf("current value = %#v, want default", generated.CurrentValue)
	}
	if generated.EffectiveValue == nil ||
		*generated.EffectiveValue != "claude-haiku-4-5-20251001" {
		t.Fatalf("effective value = %#v, want resolved Haiku model", generated.EffectiveValue)
	}
}

func TestDaemonAPIGeneratedRoutesGetAgentProviderComposerOptions(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			composerOptionsFn: func(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
				if input.Locale != "zh-CN" {
					t.Fatalf("locale = %q, want zh-CN", input.Locale)
				}
				if input.Provider != "codex" {
					t.Fatalf("provider = %q, want codex", input.Provider)
				}
				if input.Cwd != "/workspace/project" {
					t.Fatalf("cwd = %q, want /workspace/project", input.Cwd)
				}
				if input.Settings.Model != "gpt-5" || input.Settings.ReasoningEffort != "high" {
					t.Fatalf("settings = %#v", input.Settings)
				}
				if input.Section != agentservice.ComposerOptionsSectionCore {
					t.Fatalf("section = %q, want core", input.Section)
				}
				if !input.WaitForFreshModelCatalog {
					t.Fatal("waitForFreshModelCatalog = false, want true")
				}
				return agentservice.ComposerOptions{
					Capabilities: []string{"imageInput", "planMode", "browserUse"},
					Commands: []agentservice.ComposerCommandOption{{
						Name:        "memory",
						Description: "Manage memory",
						InputHint:   "show | refresh",
					}},
					EffectiveSettings: input.Settings,
					ModelConfig: agentservice.ComposerConfigOption{
						Configurable: true,
						CurrentValue: "gpt-5",
						DefaultValue: "gpt-5",
						Options: []agentservice.ComposerConfigOptionValue{{
							ID:    "gpt-5",
							Label: "GPT-5",
							Value: "gpt-5",
						}},
					},
					PermissionConfig: agentservice.PermissionConfig{
						Configurable: true,
						DefaultValue: "auto",
						Modes: []agentservice.PermissionModeOption{{
							ID:          "auto",
							Label:       "替我审批",
							Description: "仅对检测到的风险操作请求批准",
							Semantic:    agentservice.PermissionModeSemanticAuto,
						}},
					},
					Provider: input.Provider,
					ReasoningConfig: agentservice.ComposerConfigOption{
						Configurable: true,
						CurrentValue: "high",
						DefaultValue: "high",
						Options: []agentservice.ComposerConfigOptionValue{{
							ID:    "high",
							Label: "高",
							Value: "high",
						}},
					},
					ReasoningOptionsByModel: map[string]agentservice.ComposerReasoningProfile{
						"gpt-5": {
							DefaultValue: "high",
							Options: []agentservice.ComposerConfigOptionValue{{
								ID: "high", Label: "高", Value: "high",
							}},
						},
					},
					RuntimeContext: map[string]any{
						"configOptions": []map[string]any{
							{
								"currentValue": "gpt-5",
								"id":           "model",
								"options": []map[string]string{
									{"name": "GPT-5", "value": "gpt-5"},
								},
							},
						},
					},
					Skills: []agentservice.ComposerSkillOption{{
						Name:        "architecture-review",
						Trigger:     "$architecture-review",
						SourceKind:  "project",
						Description: "Review architecture changes",
					}},
					Behavior: providerregistry.ComposerBehaviorDescriptor{
						ModelOptionsAuthoritative:           true,
						RefreshModelOptionsAfterSettings:    true,
						PrewarmDraftSession:                 true,
						PlanModeExclusiveWithPermissionMode: true,
					},
					SlashCommandPolicy: &providerregistry.SlashCommandPolicyDescriptor{
						FallbackCommands:            []string{"compact", "goal"},
						CommandCatalogAuthoritative: true,
						CommandEffects: []providerregistry.SlashCommandEffectDescriptor{
							{Command: "compact", Effect: providerregistry.SlashCommandEffectSubmitImmediate},
							{Command: "goal", Effect: providerregistry.SlashCommandEffectActivateGoalMode},
						},
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/codex/composer-options", map[string]any{
		"cwd":                      "/workspace/project",
		"locale":                   "zh-CN",
		"section":                  "core",
		"waitForFreshModelCatalog": true,
		"settings": map[string]any{
			"model":            "gpt-5",
			"permissionModeId": "auto",
			"reasoningEffort":  "high",
		},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderComposerOptionsResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Provider != tuttigenerated.WorkspaceAgentProvider("codex") {
		t.Fatalf("provider = %q, want codex", response.Provider)
	}
	if response.Capabilities == nil || !response.Capabilities.ImageInput || !response.Capabilities.PlanMode || !response.Capabilities.BrowserUse || response.Capabilities.ComputerUse {
		t.Fatalf("capabilities = %#v", response.Capabilities)
	}
	if response.EffectiveSettings.Model == nil || *response.EffectiveSettings.Model != "gpt-5" {
		t.Fatalf("model = %#v, want gpt-5", response.EffectiveSettings.Model)
	}
	if response.ModelConfig.CurrentValue == nil || *response.ModelConfig.CurrentValue != "gpt-5" {
		t.Fatalf("modelConfig = %#v", response.ModelConfig)
	}
	if response.PermissionConfig.DefaultValue == nil || *response.PermissionConfig.DefaultValue != "auto" || response.PermissionConfig.Modes[0].Label != "替我审批" {
		t.Fatalf("permissionConfig = %#v", response.PermissionConfig)
	}
	if response.ReasoningConfig.Options[0].Label != "高" {
		t.Fatalf("reasoningConfig = %#v", response.ReasoningConfig)
	}
	if profile, ok := response.ReasoningOptionsByModel["gpt-5"]; !ok || profile.DefaultValue == nil || *profile.DefaultValue != "high" || len(profile.Options) != 1 {
		t.Fatalf("reasoningOptionsByModel = %#v", response.ReasoningOptionsByModel)
	}
	if len(response.Commands) != 1 || response.Commands[0].Name != "memory" || response.Commands[0].Description == nil || *response.Commands[0].Description != "Manage memory" {
		t.Fatalf("commands = %#v", response.Commands)
	}
	if response.RuntimeContext["configOptions"] == nil {
		t.Fatalf("runtimeContext = %#v", response.RuntimeContext)
	}
	if len(response.Skills) != 1 || response.Skills[0].Trigger != "$architecture-review" || response.Skills[0].SourceKind != tuttigenerated.AgentProviderSkillOptionSourceKindProject {
		t.Fatalf("skills = %#v", response.Skills)
	}
	if !response.Behavior.ModelOptionsAuthoritative ||
		!response.Behavior.RefreshModelOptionsAfterSettings || !response.Behavior.PrewarmDraftSession ||
		!response.Behavior.PlanModeExclusiveWithPermissionMode {
		t.Fatalf("behavior = %#v", response.Behavior)
	}
	if response.SlashCommandPolicy == nil ||
		!slices.Equal(response.SlashCommandPolicy.FallbackCommands, []string{"compact", "goal"}) ||
		len(response.SlashCommandPolicy.CommandEffects) != 2 ||
		response.SlashCommandPolicy.CommandEffects[1].Effect != tuttigenerated.ActivateGoalMode ||
		response.SlashCommandPolicy.CommandCatalogAuthoritative == nil ||
		!*response.SlashCommandPolicy.CommandCatalogAuthoritative {
		t.Fatalf("slashCommandPolicy = %#v", response.SlashCommandPolicy)
	}
}

func TestDaemonAPIGeneratedRoutesGetAgentProviderComposerOptionsPassesAgentTargetID(t *testing.T) {
	var gotAgentTargetID string
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			composerOptionsFn: func(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
				gotAgentTargetID = input.AgentTargetID
				return agentservice.ComposerOptions{Provider: input.Provider}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/codex/composer-options", map[string]any{
		"agentTargetId": "shared-agent:abc",
		"workspaceId":   "ws-1",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if gotAgentTargetID != "shared-agent:abc" {
		t.Fatalf("agentTargetID = %q, want shared-agent:abc", gotAgentTargetID)
	}
}

func TestDaemonAPIGeneratedRoutesGetAgentProviderComposerOptionsLeavesTargetDefaultsToAgentService(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			composerOptionsFn: func(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
				if input.Settings.Model != "" ||
					input.Settings.PermissionModeID != "" ||
					input.Settings.ReasoningEffort != "" {
					t.Fatalf("settings = %#v", input.Settings)
				}
				return agentservice.ComposerOptions{
					EffectiveSettings: input.Settings,
					ModelConfig: agentservice.ComposerConfigOption{
						Configurable: true,
						CurrentValue: input.Settings.Model,
						DefaultValue: input.Settings.Model,
						Options: []agentservice.ComposerConfigOptionValue{{
							ID:    input.Settings.Model,
							Label: "GPT-5",
							Value: input.Settings.Model,
						}},
					},
					PermissionConfig: agentservice.PermissionConfig{
						Configurable: true,
						DefaultValue: input.Settings.PermissionModeID,
						Modes: []agentservice.PermissionModeOption{{
							ID:       input.Settings.PermissionModeID,
							Label:    "Full access",
							Semantic: agentservice.PermissionModeSemanticFullAccess,
						}},
					},
					Provider: input.Provider,
					ReasoningConfig: agentservice.ComposerConfigOption{
						Configurable: true,
						CurrentValue: input.Settings.ReasoningEffort,
						DefaultValue: input.Settings.ReasoningEffort,
						Options: []agentservice.ComposerConfigOptionValue{{
							ID:    input.Settings.ReasoningEffort,
							Label: "High",
							Value: input.Settings.ReasoningEffort,
						}},
					},
					RuntimeContext: map[string]any{},
				}, nil
			},
		},
		PreferencesService: stubPreferencesService{
			getFn: func(context.Context) (preferencesbiz.DesktopPreferences, error) {
				return preferencesbiz.DesktopPreferences{
					AgentComposerDefaultsByAgentTarget: map[string]preferencesbiz.AgentComposerDefaults{
						"local:codex": {
							Model:            "gpt-5",
							PermissionModeID: "full-access",
							ReasoningEffort:  "high",
						},
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/codex/composer-options", map[string]any{})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderComposerOptionsResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.EffectiveSettings.PermissionModeId != nil {
		t.Fatalf("effectiveSettings = %#v", response.EffectiveSettings)
	}
	if response.PermissionConfig.DefaultValue != nil {
		t.Fatalf("permissionConfig = %#v", response.PermissionConfig)
	}
}

func TestGeneratedAgentProviderCapabilityOptionsProjectsIconURL(t *testing.T) {
	options := generatedAgentProviderCapabilityOptions([]agentservice.ComposerCapabilityOption{{
		ID:         "connector:github",
		Kind:       "connector",
		Name:       "github",
		Label:      "GitHub",
		IconURL:    "https://cdn.example.test/tutti/connector-market/github/1.0.0/github-1.0.0-icon.svg",
		Status:     "available",
		Invocation: "textTrigger",
	}})
	if len(options) != 1 || options[0].IconUrl == nil || *options[0].IconUrl != "https://cdn.example.test/tutti/connector-market/github/1.0.0/github-1.0.0-icon.svg" {
		t.Fatalf("options = %#v, want connector icon URL", options)
	}
}
