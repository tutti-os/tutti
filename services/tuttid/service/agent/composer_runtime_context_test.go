package agent

import (
	"slices"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestComposerRuntimeContextRejoinsExactPersistedMetadataCapabilities(t *testing.T) {
	project := t.TempDir()
	settings := ComposerSettings{ReasoningEffort: "high"}
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@1.0.0"}
	scope := newComposerLiveModelScopeForInput(ComposerOptionsInput{
		Provider:          "acp:example",
		WorkspaceID:       "workspace-1",
		Cwd:               project,
		AgentTargetID:     "extension:example",
		providerTargetRef: ref,
	}, settings)
	exact := stampAgentExtensionComposerScope(map[string]any{}, ref, project, settings)
	wrongInstallation := stampAgentExtensionComposerScope(
		map[string]any{},
		map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@2.0.0"},
		project,
		settings,
	)
	wrongProject := stampAgentExtensionComposerScope(map[string]any{}, ref, t.TempDir(), settings)
	wrongSettings := stampAgentExtensionComposerScope(
		map[string]any{},
		ref,
		project,
		ComposerSettings{ReasoningEffort: "low"},
	)
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:exact": {
			ID: "exact", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"imageInput", "interrupt"}},
			InternalRuntimeContext: exact, UpdatedAtUnixMS: 100,
		},
		"workspace-1:wrong-installation": {
			ID: "wrong-installation", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"planMode"}},
			InternalRuntimeContext: wrongInstallation, UpdatedAtUnixMS: 500,
		},
		"workspace-1:wrong-project": {
			ID: "wrong-project", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"planMode"}},
			InternalRuntimeContext: wrongProject, UpdatedAtUnixMS: 600,
		},
		"workspace-1:wrong-settings": {
			ID: "wrong-settings", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"planMode"}},
			InternalRuntimeContext: wrongSettings, UpdatedAtUnixMS: 700,
		},
		"workspace-1:wrong-target": {
			ID: "wrong-target", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:other",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"planMode"}},
			InternalRuntimeContext: exact, UpdatedAtUnixMS: 800,
		},
	}}

	context := service.composerRuntimeContextFromSession(scope)
	if got := stringSliceFromAny(context["capabilities"]); !slices.Equal(got, []string{"imageInput", "interrupt"}) {
		t.Fatalf("persisted capabilities = %#v, want metadata capabilities rejoined", got)
	}
}

func TestMergeRuntimeComposerContextFailsClosedWithoutExactCapabilityEvidence(t *testing.T) {
	sessionProject := t.TempDir()
	sessionSettings := ComposerSettings{PermissionModeID: "ask-before-write"}
	sessionRef := map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@1.0.0"}
	tests := []struct {
		name     string
		project  string
		target   string
		ref      map[string]any
		settings ComposerSettings
	}{
		{
			name:     "installation",
			project:  sessionProject,
			target:   "extension:example",
			ref:      map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@2.0.0"},
			settings: sessionSettings,
		},
		{
			name:     "project",
			project:  t.TempDir(),
			target:   "extension:example",
			ref:      sessionRef,
			settings: sessionSettings,
		},
		{
			name:     "settings",
			project:  sessionProject,
			target:   "extension:example",
			ref:      sessionRef,
			settings: ComposerSettings{PermissionModeID: "full-access"},
		},
		{
			name:     "target",
			project:  sessionProject,
			target:   "extension:other",
			ref:      sessionRef,
			settings: sessionSettings,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runtime := newFakeRuntime()
			runtime.sessions["workspace-1:live"] = ProviderRuntimeSession{
				ID: "live", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
				RuntimeContext: stampAgentExtensionComposerScope(map[string]any{
					"capabilities": []any{"imageInput", "interrupt"},
				}, sessionRef, sessionProject, sessionSettings),
				CreatedAtUnixMS: 100,
			}
			service := newIsolatedAgentService(runtime)
			profile := ExtensionComposerProfile{Capabilities: []string{"imageInput", "interrupt"}}
			options, err := service.mergeRuntimeComposerContextForComposerOptions(
				ComposerOptionsInput{
					Provider:          "acp:example",
					WorkspaceID:       "workspace-1",
					Cwd:               tt.project,
					AgentTargetID:     tt.target,
					providerTargetRef: tt.ref,
				},
				tt.settings,
				"en",
				profile,
				"",
				ComposerOptions{RuntimeContext: map[string]any{}},
			)
			if err != nil {
				t.Fatalf("mergeRuntimeComposerContextForComposerOptions error = %v", err)
			}
			options = applyExtensionComposerCapabilities(options, profile, false)
			if got := options.Capabilities; len(got) != 0 {
				t.Fatalf("capabilities = %#v, want fail-closed result for mismatched %s identity", got, tt.name)
			}
		})
	}
}

func TestMergeRuntimeComposerContextRoutesUnlistedCommandsToSkills(t *testing.T) {
	project := t.TempDir()
	ref := map[string]any{
		"kind":                    "agent_extension",
		"extensionInstallationId": "example@1.0.0",
	}
	runtime := newFakeRuntime()
	runtime.sessions["workspace-1:live"] = ProviderRuntimeSession{
		ID:            "live",
		WorkspaceID:   "workspace-1",
		Provider:      "acp:example",
		AgentTargetID: "extension:example",
		RuntimeContext: stampAgentExtensionComposerScope(map[string]any{
			"availableCommands": []any{
				map[string]any{"name": "status", "description": "Show status"},
				map[string]any{"name": "custom-theme", "description": "Edit a theme"},
				map[string]any{"name": "skill:browser-use", "description": "Use browser"},
			},
		}, ref, project, ComposerSettings{}),
		CreatedAtUnixMS: 100,
	}
	service := newIsolatedAgentService(runtime)
	profile := ExtensionComposerProfile{
		Skills: &ExtensionComposerSkillProfile{
			Invocation:               "textTrigger",
			RuntimeCommandProjection: "unlisted-as-skills",
		},
		SlashCommands: []ExtensionComposerSlashCommand{{
			Name:   "status",
			Effect: string(providerregistry.SlashCommandEffectShowStatus),
		}},
		SlashCommandCatalogAuthoritative: true,
	}
	policy := composerSlashCommandPolicyFromExtensionProfile(profile)
	options, err := service.mergeRuntimeComposerContextForComposerOptions(
		ComposerOptionsInput{
			Provider:          "acp:example",
			WorkspaceID:       "workspace-1",
			Cwd:               project,
			AgentTargetID:     "extension:example",
			providerTargetRef: ref,
		},
		ComposerSettings{},
		"en",
		profile,
		"",
		ComposerOptions{
			RuntimeContext:     map[string]any{},
			SlashCommandPolicy: policy,
		},
	)
	if err != nil {
		t.Fatalf("mergeRuntimeComposerContextForComposerOptions error = %v", err)
	}
	if len(options.Commands) != 1 || options.Commands[0].Name != "status" {
		t.Fatalf("commands = %#v, want only signed core command", options.Commands)
	}
	if len(options.Skills) != 1 ||
		options.Skills[0].Name != "custom-theme" ||
		options.Skills[0].Trigger != "/custom-theme" ||
		options.Skills[0].SourceKind != composerSkillSourceBundled ||
		options.Skills[0].Description != "Edit a theme" {
		t.Fatalf("skills = %#v, want unlisted runtime command projected as a Skill", options.Skills)
	}
	if got := runtimeConfigOptionsAsMapSlice(options.RuntimeContext["skills"]); len(got) != 1 {
		t.Fatalf("runtime skills = %#v, want typed projection mirrored for diagnostics", options.RuntimeContext["skills"])
	}
}
