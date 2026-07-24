package runtimeprep

import (
	"strings"
	"testing"
)

func TestDefaultHostFactsRenderLocalAgentContract(t *testing.T) {
	preparer := newTestPreparer(t.TempDir())
	preparer.CLICommand = "tutti-dev"
	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
	})
	if err != nil {
		t.Fatal(err)
	}

	cli := skillBundleRecord(bundle.Skills, tuttiSkillName).Content
	handoff := skillBundleRecord(bundle.Skills, tuttiHandoffSkillName).Content
	for label, content := range map[string]string{"cli": cli, "handoff": handoff} {
		if !strings.Contains(content, "tutti-dev agent get --session-id <session-id> --view turns --json") {
			t.Fatalf("%s missing progressive get command: %s", label, content)
		}
	}
	for label, content := range map[string]string{"cli": cli, "handoff": handoff} {
		for _, want := range []string{
			"tutti-dev agent cancel-turn",
			"tutti-dev agent respond",
		} {
			if !strings.Contains(content, want) {
				t.Fatalf("%s missing snapshot-derived command %q: %s", label, want, content)
			}
		}
	}
	if !strings.Contains(handoff, "images[].localPath") {
		t.Fatalf("handoff missing default local-path resource fact: %s", handoff)
	}
}

func TestManagedHostFactsRenderManagedAgentContract(t *testing.T) {
	capabilities := testCommandCapabilities()
	filtered := make([]CommandCapability, 0, len(capabilities)+2)
	for _, capability := range capabilities {
		switch capability.ID {
		case "agent-context.agent.cancel-turn", "agent-context.agent.respond":
			continue
		case "agent-context.agent.get":
			capability.InputSchema = map[string]any{
				"type": "object",
				"properties": map[string]any{
					"session-id": map[string]any{"type": "string"},
				},
				"required": []string{"session-id"},
			}
		}
		filtered = append(filtered, capability)
	}
	filtered = append(filtered,
		CommandCapability{
			ID:      "agent-context.agent.session-summary",
			Path:    []string{"agent", "session-summary"},
			Summary: "Read Agent conversation",
			InputSchema: map[string]any{
				"properties": map[string]any{"session-id": map[string]any{"type": "string"}},
				"required":   []string{"session-id"},
			},
			Output: CommandCapabilityOutput{JSON: true},
		},
		CommandCapability{
			ID:      "agent-context.agent.cancel",
			Path:    []string{"agent", "cancel"},
			Summary: "Cancel Agent session",
			InputSchema: map[string]any{
				"properties": map[string]any{"session-id": map[string]any{"type": "string"}},
				"required":   []string{"session-id"},
			},
			Output: CommandCapabilityOutput{JSON: true},
		},
	)
	preparer := NewDefaultPreparer(t.TempDir())
	preparer.CommandCatalog = staticCommandCatalog(filtered)
	preparer.CLICommand = "tutti-dev"
	profile := StandardProfile()
	profile.Name = "managed-vm"
	profile.HostFacts = HostFacts{
		TurnResources:  AgentTurnResourcesReadPath,
		WorkspaceScope: AgentWorkspaceScopeRoom,
		TargetContinuation: AgentTargetContinuationProfile{
			Mode:                        AgentTargetContinuationExceptPrefixes,
			UnsupportedTargetIDPrefixes: []string{"shared-agent:"},
		},
	}
	preparer.Profile = profile

	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	cli := skillBundleRecord(bundle.Skills, tuttiSkillName).Content
	handoff := skillBundleRecord(bundle.Skills, tuttiHandoffSkillName).Content
	policy := bundle.RecommendedSystemPrompt.Content
	for label, content := range map[string]string{"cli": cli, "handoff": handoff, "policy": policy} {
		for _, want := range []string{
			"tutti-dev agent session-summary --session-id <session-id> --json",
			"shared-agent:",
		} {
			if !strings.Contains(content, want) {
				t.Fatalf("%s missing managed-host contract %q: %s", label, want, content)
			}
		}
		for _, forbidden := range []string{
			"--view turns",
			"agent cancel-turn",
			"agent respond",
			"--room-id",
		} {
			if strings.Contains(content, forbidden) {
				t.Fatalf("%s contains unsupported managed-host syntax %q: %s", label, forbidden, content)
			}
		}
	}
	for label, content := range map[string]string{"cli": cli, "handoff": handoff} {
		if !strings.Contains(content, "tutti-dev agent cancel --session-id <session-id> --json") {
			t.Fatalf("%s missing managed cancellation command: %s", label, content)
		}
	}
	if !strings.Contains(handoff, "images[].readPath") ||
		!strings.Contains(handoff, "Do not pass a `readPath`") {
		t.Fatalf("handoff missing managed read-path fact: %s", handoff)
	}
}

func TestHostFactsRejectInvalidTargetContinuation(t *testing.T) {
	profile := DeploymentProfile{
		Name: "invalid",
		HostFacts: HostFacts{
			TargetContinuation: AgentTargetContinuationProfile{
				Mode: AgentTargetContinuationExceptPrefixes,
			},
		},
		Packs: []CapabilityPack{CoreSkillsPack()},
	}
	_, err := Resolve(t.Context(), PrepareInput{Provider: "codex"}, profile)
	if err == nil || !strings.Contains(err.Error(), "requires at least one target id prefix") {
		t.Fatalf("Resolve() error = %v", err)
	}
}
