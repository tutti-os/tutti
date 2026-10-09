package main

import (
	"slices"
	"testing"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestApplyAgentExtensionComposerCompatibilityPolicyHidesCodeBuddyGoalControl(t *testing.T) {
	profile := agentservice.ExtensionComposerProfile{
		SlashCommandCatalogAuthoritative: true,
		SlashCommands: []agentservice.ExtensionComposerSlashCommand{
			{Name: "compact", Effect: "submitImmediate"},
			{Name: " goal ", Effect: "activateGoalMode"},
			{Name: "plan", Effect: "togglePlanMode"},
		},
	}

	got := applyAgentExtensionComposerCompatibilityPolicy("codebuddy@2.0.3", profile)
	want := []agentservice.ExtensionComposerSlashCommand{
		{Name: "compact", Effect: "submitImmediate"},
		{Name: "plan", Effect: "togglePlanMode"},
	}
	if !slices.Equal(got.SlashCommands, want) {
		t.Fatalf("slash commands = %#v, want %#v", got.SlashCommands, want)
	}
	if !got.SlashCommandCatalogAuthoritative {
		t.Fatal("authoritative command catalog must be preserved")
	}
	if len(profile.SlashCommands) != 3 {
		t.Fatalf("input profile was mutated: %#v", profile.SlashCommands)
	}
}

func TestApplyAgentExtensionComposerCompatibilityPolicyKeepsOtherGoalCommands(t *testing.T) {
	tests := []struct {
		name           string
		installationID string
		effect         string
	}{
		{name: "other extension", installationID: "example@1.0.0", effect: "activateGoalMode"},
		{name: "provider owned CodeBuddy command", installationID: "codebuddy@2.0.3", effect: "submitImmediate"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			command := agentservice.ExtensionComposerSlashCommand{Name: "goal", Effect: test.effect}
			profile := agentservice.ExtensionComposerProfile{
				SlashCommands: []agentservice.ExtensionComposerSlashCommand{command},
			}

			got := applyAgentExtensionComposerCompatibilityPolicy(test.installationID, profile)
			if !slices.Equal(got.SlashCommands, []agentservice.ExtensionComposerSlashCommand{command}) {
				t.Fatalf("slash commands = %#v, want goal command preserved", got.SlashCommands)
			}
		})
	}
}
