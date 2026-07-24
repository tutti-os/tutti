package runtimeprep

import (
	"strings"
	"testing"
)

func TestDefaultAgentWorkflowProfilePreservesTuttiGuidance(t *testing.T) {
	input := PrepareInput{
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		CLICommand:     "tutti-dev",
		Provider:       "codex",
	}

	cliSkill := tuttiCLISkill(input)
	handoffSkill := tuttiHandoffSkill(input)
	runtimePolicy := tuttiRuntimePolicy(input)
	for label, content := range map[string]string{"cli skill": cliSkill, "runtime policy": runtimePolicy} {
		if !strings.Contains(content, "--view turns") {
			t.Fatalf("%s missing default progressive get guidance", label)
		}
		if strings.Contains(content, "## Agent Host Command Contract") ||
			strings.Contains(content, "session-summary-and-state") {
			t.Fatalf("%s changed default Tutti workflow: %s", label, content)
		}
	}
	for _, want := range []string{
		"tutti-dev agent get --session-id <caller-session-id> --view turns --turns 20 --json",
		"images[].localPath",
		"--image <localPath>",
	} {
		if !strings.Contains(handoffSkill, want) {
			t.Fatalf("handoff skill missing default Tutti guidance %q", want)
		}
	}
	if strings.Contains(handoffSkill, "## Agent Host Command Contract") {
		t.Fatalf("handoff skill changed default Tutti workflow: %s", handoffSkill)
	}
}

func TestDeploymentAgentWorkflowRendersHostSpecificSkillsAndPolicy(t *testing.T) {
	preparer := NewDefaultPreparer(t.TempDir())
	profile := StandardProfile()
	profile.Name = "managed-vm"
	profile.AgentWorkflow = AgentWorkflowProfile{
		SessionContext:      AgentSessionContextSummaryAndState,
		TurnResources:       AgentTurnResourcesReadPath,
		Cancellation:        AgentCancellationSession,
		InteractionResponse: AgentInteractionResponseUnavailable,
		WorkspaceScope:      AgentWorkspaceScopeRoom,
		TargetContinuation: AgentTargetContinuationProfile{
			Mode:                        AgentTargetContinuationExceptPrefixes,
			UnsupportedTargetIDPrefixes: []string{"shared-agent:"},
		},
	}
	preparer.Profile = profile
	preparer.CLICommand = "tutti-dev"

	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local-agent:codex",
		Provider:       "codex",
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}

	cliSkill := skillBundleRecord(bundle.Skills, tuttiSkillName)
	handoffSkill := skillBundleRecord(bundle.Skills, tuttiHandoffSkillName)
	commandGuide, ok := skillBundleFileContent(cliSkill, commandGuideReferencePath)
	if !ok {
		t.Fatal("tutti-cli skill missing command guide")
	}
	policy := bundle.RecommendedSystemPrompt.Content

	for label, content := range map[string]string{
		"cli skill":     cliSkill.Content,
		"handoff skill": handoffSkill.Content,
		"command guide": commandGuide,
	} {
		for _, want := range []string{
			"agent session-summary",
			"agent get",
			"session state",
			"shared-agent:",
			"can be started",
			"do not support `agent send`, `agent get`, `agent wait`, cancellation, or `agent respond`",
		} {
			if !strings.Contains(content, want) {
				t.Fatalf("%s missing host workflow guidance %q: %s", label, want, content)
			}
		}
	}
	for _, want := range []string{
		"agent session-summary",
		"agent get",
		"only for state",
		"shared-agent:",
		"can be started",
		"do not support `agent send`, `agent get`, `agent wait`, cancellation, or `agent respond`",
	} {
		if !strings.Contains(policy, want) {
			t.Fatalf("runtime policy missing host workflow guidance %q: %s", want, policy)
		}
	}
	for _, want := range []string{
		"images[].readPath",
		"Do not pass a `readPath` to `--image`",
		"tutti-dev agent cancel --session-id <session-id> --json",
		"does not expose `agent respond`",
		"Do not add `--room-id`",
	} {
		if !strings.Contains(handoffSkill.Content, want) {
			t.Fatalf("handoff skill missing %q: %s", want, handoffSkill.Content)
		}
	}
	for label, content := range map[string]string{
		"handoff skill":  handoffSkill.Content,
		"command guide":  commandGuide,
		"runtime policy": policy,
	} {
		for _, forbidden := range []string{
			"--view turns --turns",
			"images[].localPath",
			"tutti-dev agent cancel-turn --session-id",
			"tutti-dev agent respond --help",
		} {
			if strings.Contains(content, forbidden) {
				t.Fatalf("%s contains incompatible command %q: %s", label, forbidden, content)
			}
		}
	}
}

func TestAgentWorkflowProfileRejectsInvalidTargetContinuation(t *testing.T) {
	profile := DeploymentProfile{
		Name: "invalid",
		AgentWorkflow: AgentWorkflowProfile{
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
