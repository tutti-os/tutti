package agent

import (
	"slices"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestExtensionCapabilitiesFallbackPrefersNewestLiveSession(t *testing.T) {
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@1.0.0"}
	scope := newComposerLiveModelScopeForInput(ComposerOptionsInput{
		Provider:          "acp:example",
		WorkspaceID:       "workspace-1",
		Cwd:               t.TempDir(),
		AgentTargetID:     "extension:example-a",
		providerTargetRef: ref,
	}, ComposerSettings{PermissionModeID: "ask-before-write"})
	runtime := newFakeRuntime()
	add := func(id, target, installation string, capabilities []string, created int64) {
		context := stampAgentExtensionComposerScope(map[string]any{
			"capabilities": capabilities,
		}, map[string]any{"kind": "agent_extension", "extensionInstallationId": installation}, t.TempDir(), ComposerSettings{})
		runtime.sessions["workspace-1:"+id] = ProviderRuntimeSession{
			ID: id, WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: target,
			RuntimeContext: context, CreatedAtUnixMS: created,
		}
	}
	add("old", "extension:example-a", "example@1.0.0", []string{"interrupt"}, 100)
	add("new", "extension:example-a", "example@1.0.0", []string{"imageInput", "interrupt"}, 200)
	add("wrong-target", "extension:example-b", "example@1.0.0", []string{"planMode"}, 500)
	// A reinstall rotates the installation id; capability evidence still applies.
	add("reinstalled", "extension:example-a", "example@2.0.0", []string{"planMode"}, 150)

	got := newIsolatedAgentService(runtime).extensionSessionCapabilitiesFallback(scope)
	if !slices.Equal(got, []string{"imageInput", "interrupt"}) {
		t.Fatalf("fallback capabilities = %#v, want newest live session of the same target", got)
	}
}

func TestExtensionCapabilitiesFallbackReadsPersistedMetadataCapabilities(t *testing.T) {
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@1.0.0"}
	scope := newComposerLiveModelScopeForInput(ComposerOptionsInput{
		Provider:          "acp:example",
		WorkspaceID:       "workspace-1",
		Cwd:               t.TempDir(),
		AgentTargetID:     "extension:example-a",
		providerTargetRef: ref,
	}, ComposerSettings{})
	stamped := stampAgentExtensionComposerScope(map[string]any{}, ref, t.TempDir(), ComposerSettings{})
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:older": {
			ID: "older", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example-a",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"interrupt"}},
			InternalRuntimeContext: stamped, CreatedAtUnixMS: 100,
		},
		"workspace-1:newer": {
			ID: "newer", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example-a",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"imageInput", "interrupt"}},
			InternalRuntimeContext: stamped, CreatedAtUnixMS: 200,
		},
		"workspace-1:stale-but-recently-read": {
			// Read-side writes bump updatedAt without a new handshake; the
			// stale capability list from an older session must not win.
			ID: "stale-but-recently-read", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example-a",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"interrupt"}},
			InternalRuntimeContext: stamped, CreatedAtUnixMS: 150, UpdatedAtUnixMS: 999,
		},
		"workspace-1:other-target": {
			ID: "other-target", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example-b",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"planMode"}},
			InternalRuntimeContext: stamped, CreatedAtUnixMS: 500,
		},
	}}

	got := service.extensionSessionCapabilitiesFallback(scope)
	if !slices.Equal(got, []string{"imageInput", "interrupt"}) {
		t.Fatalf("fallback capabilities = %#v, want newest persisted metadata capabilities", got)
	}
}

func TestExtensionCapabilitiesFallbackEmptyWithoutEvidence(t *testing.T) {
	scope := newComposerLiveModelScopeForInput(ComposerOptionsInput{
		Provider:      "acp:example",
		WorkspaceID:   "workspace-1",
		Cwd:           t.TempDir(),
		AgentTargetID: "extension:example-a",
		providerTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"extensionInstallationId": "example@1.0.0",
		},
	}, ComposerSettings{})
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{}}
	if got := service.extensionSessionCapabilitiesFallback(scope); len(got) != 0 {
		t.Fatalf("fallback capabilities = %#v, want empty without session evidence", got)
	}
}

func TestComposerRuntimeContextPersistedFallbackRejoinsMetadataCapabilities(t *testing.T) {
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
	exact := stampAgentExtensionComposerScope(map[string]any{
		"availableCommands": []any{map[string]any{"name": "compact"}},
	}, ref, project, settings)
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:exact": {
			ID: "exact", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
			Metadata:               agentactivitybiz.SessionMetadata{Capabilities: []string{"imageInput", "interrupt"}},
			InternalRuntimeContext: exact, UpdatedAtUnixMS: 100,
		},
	}}

	context := service.composerRuntimeContextFromSession(scope)
	if got := stringSliceFromAny(context["capabilities"]); !slices.Equal(got, []string{"imageInput", "interrupt"}) {
		t.Fatalf("persisted capabilities = %#v, want metadata capabilities rejoined", got)
	}
}

func TestMergeRuntimeComposerContextUsesCapabilityFallbackWithoutScopeMatch(t *testing.T) {
	ref := map[string]any{"kind": "agent_extension", "extensionInstallationId": "example@1.0.0"}
	runtime := newFakeRuntime()
	runtime.sessions["workspace-1:live"] = ProviderRuntimeSession{
		ID: "live", WorkspaceID: "workspace-1", Provider: "acp:example", AgentTargetID: "extension:example",
		RuntimeContext: stampAgentExtensionComposerScope(map[string]any{
			"capabilities": []any{"imageInput", "interrupt"},
		}, ref, t.TempDir(), ComposerSettings{}),
		CreatedAtUnixMS: 100,
	}
	service := newIsolatedAgentService(runtime)
	options, err := service.mergeRuntimeComposerContextForComposerOptions(
		ComposerOptionsInput{
			Provider:          "acp:example",
			WorkspaceID:       "workspace-1",
			Cwd:               t.TempDir(),
			AgentTargetID:     "extension:example",
			providerTargetRef: ref,
		},
		ComposerSettings{PermissionModeID: "ask-before-write"},
		"en",
		ExtensionComposerProfile{},
		"",
		ComposerOptions{RuntimeContext: map[string]any{}},
	)
	if err != nil {
		t.Fatalf("mergeRuntimeComposerContextForComposerOptions error = %v", err)
	}
	if got := stringSliceFromAny(options.RuntimeContext["capabilities"]); !slices.Equal(got, []string{"imageInput", "interrupt"}) {
		t.Fatalf("merged capabilities = %#v, want installation fallback from live session", got)
	}
}
