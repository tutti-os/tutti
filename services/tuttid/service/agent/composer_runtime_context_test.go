package agent

import (
	"slices"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
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
