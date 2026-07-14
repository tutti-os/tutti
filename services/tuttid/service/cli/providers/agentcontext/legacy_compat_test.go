package agentcontext

import (
	"context"
	"errors"
	"strings"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestAgentListUsesExtensionTargetAvailabilityWithoutProviderProbe(t *testing.T) {
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON("acp:gemini", agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: "gemini@1.0.0",
	})
	if err != nil {
		t.Fatalf("CanonicalLaunchRefJSON: %v", err)
	}
	extension := agenttargetbiz.Target{
		ID: "extension:gemini", Provider: "acp:gemini", LaunchRefJSON: launchRef,
		Name: "Gemini", Enabled: true, Source: agenttargetbiz.SourceSystem,
		AvailabilityStatus: "not_installed", AvailabilityReason: "compatible_runtime_not_installed",
	}
	sessions := &fakeAgentSessions{availabilityErr: errors.New("extension must not use provider availability")}
	provider := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions, nil, fakeAgentTargetList{targets: []agenttargetbiz.Target{extension}},
	)
	output, err := provider.newAgentsCommand().Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": extension.ID}, OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if len(sessions.availabilityIn) != 0 {
		t.Fatalf("provider availability calls = %#v", sessions.availabilityIn)
	}
	agent := output.Value["agents"].([]any)[0].(map[string]any)
	availability := agent["availability"].(map[string]any)
	if availability["status"] != "unavailable" || availability["reasonCode"] != "compatible_runtime_not_installed" {
		t.Fatalf("availability = %#v", availability)
	}
}

func TestAgentStartUsesExactExtensionTarget(t *testing.T) {
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON("acp:gemini", agenttargetbiz.LaunchRef{
		Type: agenttargetbiz.LaunchRefTypeAgentExtension, ExtensionInstallationID: "gemini@1.0.0",
	})
	if err != nil {
		t.Fatalf("CanonicalLaunchRefJSON: %v", err)
	}
	extension := agenttargetbiz.Target{
		ID: "extension:gemini", Provider: "acp:gemini", LaunchRefJSON: launchRef,
		Name: "Gemini", Enabled: true, Source: agenttargetbiz.SourceSystem,
	}
	sessions := &fakeAgentSessions{}
	provider := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		sessions, nil, fakeAgentTargetList{targets: []agenttargetbiz.Target{extension}},
	)
	if _, err := provider.newStartCommand().Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": extension.ID, "prompt": "review"},
	}); err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if sessions.createInput.AgentTargetID != extension.ID || sessions.createInput.Provider != extension.Provider {
		t.Fatalf("create input = %#v", sessions.createInput)
	}
}

func TestUnknownAgentErrorIncludesRecovery(t *testing.T) {
	provider := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeAgentSessions{})
	_, err := provider.newStartCommand().Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": "missing:agent", "prompt": "review"},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) || !strings.Contains(err.Error(), "missing:agent") || !strings.Contains(err.Error(), "agent list --json") {
		t.Fatalf("error = %v", err)
	}
}

func TestLegacyProviderCatalogMarksMultipleTargetsAmbiguous(t *testing.T) {
	targets := agenttargetbiz.DefaultSystemTargets(1)
	duplicate := targets[0]
	duplicate.ID = "user:reviewer"
	duplicate.Name = "Reviewer"
	duplicate.Source = agenttargetbiz.SourceUser
	targets = append([]agenttargetbiz.Target{targets[0], duplicate}, targets[1:]...)
	provider := NewProviderWithAgentTargets(
		fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}},
		&fakeAgentSessions{}, nil, fakeAgentTargetList{targets: targets},
	)
	command := provider.newLegacyProvidersCommand()
	if command.Capability.Output.DefaultMode != cliservice.OutputModeTable {
		t.Fatalf("default mode = %q", command.Capability.Output.DefaultMode)
	}
	table, err := command.Handler(context.Background(), cliservice.InvokeRequest{})
	if err != nil || table.Kind != cliservice.OutputModeTable || len(table.Rows) == 0 {
		t.Fatalf("table output = %#v, err = %v", table, err)
	}
	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{OutputMode: cliservice.OutputModeJSON})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Value["schemaVersion"] != 2 {
		t.Fatalf("output = %#v", output.Value)
	}
	for _, raw := range output.Value["providers"].([]any) {
		item := raw.(map[string]any)
		if item["providerId"] != "codex" {
			continue
		}
		if _, ok := item["agentTargetId"]; ok {
			t.Fatalf("ambiguous provider selected a target: %#v", item)
		}
		availability := item["availability"].(map[string]any)
		if availability["reasonCode"] != "agent_provider_ambiguous" {
			t.Fatalf("availability = %#v", availability)
		}
		return
	}
	t.Fatal("codex provider missing")
}

func TestDualSelectorsReturnTargetSchemaAndLegacySchema(t *testing.T) {
	sessions := &fakeAgentSessions{}
	provider := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions)
	composer := provider.newComposerOptionsCommand()

	targetOutput, err := composer.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"agent-id": agenttargetbiz.IDLocalCodex}, OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("target composer: %v", err)
	}
	if targetOutput.Value["schemaVersion"] != 2 || targetOutput.Value["agentTargetId"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("target composer output = %#v", targetOutput.Value)
	}

	legacyOutput, err := composer.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"provider": "codex"}, OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("legacy composer: %v", err)
	}
	if legacyOutput.Value["schemaVersion"] != 1 || legacyOutput.Value["provider"] != "codex" {
		t.Fatalf("legacy composer output = %#v", legacyOutput.Value)
	}
	if _, ok := legacyOutput.Value["agentTargetId"]; ok {
		t.Fatalf("legacy composer leaked v2 field: %#v", legacyOutput.Value)
	}

	_, err = composer.Handler(context.Background(), cliservice.InvokeRequest{Input: map[string]any{
		"agent-id": agenttargetbiz.IDLocalCodex, "provider": "codex",
	}})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("both selectors error = %v", err)
	}
}

func TestSkillBundleLegacySelectorDownConvertsSchema(t *testing.T) {
	sessions := &fakeAgentSessions{}
	command := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions).newSkillBundleCommand()
	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"provider": "codex"}, OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if output.Value["schemaVersion"] != 1 || output.Value["provider"] != "codex" {
		t.Fatalf("output = %#v", output.Value)
	}
	if _, ok := output.Value["agentTargetId"]; ok {
		t.Fatalf("legacy output leaked agentTargetId: %#v", output.Value)
	}
	if sessions.skillBundleIn.AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("service input = %#v", sessions.skillBundleIn)
	}
}

func TestLegacyStartAliasesResolveExactBuiltinTargets(t *testing.T) {
	sessions := &fakeAgentSessions{}
	provider := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions)
	for _, test := range []struct {
		command cliservice.Command
		wantID  string
	}{
		{command: provider.newLegacyCodexStartCommand(), wantID: agenttargetbiz.IDLocalCodex},
		{command: provider.newLegacyClaudeStartCommand(), wantID: agenttargetbiz.IDLocalClaudeCode},
	} {
		if _, err := test.command.Handler(context.Background(), cliservice.InvokeRequest{Input: map[string]any{"prompt": "review"}}); err != nil {
			t.Fatalf("Handler: %v", err)
		}
		if sessions.createInput.AgentTargetID != test.wantID {
			t.Fatalf("agentTargetId = %q, want %q", sessions.createInput.AgentTargetID, test.wantID)
		}
	}
}
