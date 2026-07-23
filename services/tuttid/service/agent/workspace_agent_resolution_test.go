package agent

import (
	"context"
	"errors"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

type staticWorkspaceAgentResolver struct {
	resolved workspaceagentbiz.Resolved
	err      error
}

func (s staticWorkspaceAgentResolver) Resolve(context.Context, string, string) (workspaceagentbiz.Resolved, error) {
	return s.resolved, s.err
}

type aliasingAgentTargetStore struct {
	targets map[string]agenttargetbiz.Target
	aliases map[string]string
}

func (s aliasingAgentTargetStore) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := s.targets[id]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

func (s aliasingAgentTargetStore) ResolveAgentTargetAlias(_ context.Context, id string) (string, bool) {
	canonicalID, ok := s.aliases[id]
	return canonicalID, ok
}

func TestResolveCreateSessionLaunchCanonicalizesExternalizedAgentTargetAlias(t *testing.T) {
	const extensionTargetID = "extension:kimi-code"
	launchRef, err := agenttargetbiz.CanonicalLaunchRefJSON("acp:kimi-code", agenttargetbiz.LaunchRef{
		Type:                    agenttargetbiz.LaunchRefTypeAgentExtension,
		ExtensionInstallationID: "kimi-code@1.0.1",
	})
	if err != nil {
		t.Fatalf("CanonicalLaunchRefJSON() error = %v", err)
	}
	service := &Service{
		AgentTargetStore: aliasingAgentTargetStore{
			targets: map[string]agenttargetbiz.Target{
				extensionTargetID: {
					ID:            extensionTargetID,
					Provider:      "acp:kimi-code",
					LaunchRefJSON: launchRef,
					Name:          "Kimi Code",
					Enabled:       true,
					Source:        agenttargetbiz.SourceSystem,
				},
			},
			aliases: map[string]string{"local:kimi-code": extensionTargetID},
		},
	}
	input := CreateSessionInput{
		AgentTargetID: "local:kimi-code",
		Provider:      "kimi-code",
	}

	launch, err := service.resolveCreateSessionLaunch(context.Background(), "ws", &input)
	if err != nil {
		t.Fatalf("resolveCreateSessionLaunch() error = %v", err)
	}
	if input.AgentTargetID != extensionTargetID || input.HarnessAgentTargetID != extensionTargetID {
		t.Fatalf("canonical target identity = %q / %q, want %q", input.AgentTargetID, input.HarnessAgentTargetID, extensionTargetID)
	}
	if launch.Provider != "acp:kimi-code" {
		t.Fatalf("launch provider = %q, want acp:kimi-code", launch.Provider)
	}
	if launch.ProviderTargetRef["kind"] != agenttargetbiz.LaunchRefTypeAgentExtension ||
		launch.ProviderTargetRef["extensionInstallationId"] != "kimi-code@1.0.1" {
		t.Fatalf("launch target ref = %#v", launch.ProviderTargetRef)
	}

	mismatched := CreateSessionInput{
		AgentTargetID: "local:kimi-code",
		Provider:      "claude-code",
	}
	if _, err := service.resolveCreateSessionLaunch(context.Background(), "ws", &mismatched); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("resolveCreateSessionLaunch(mismatched provider) error = %v, want ErrInvalidArgument", err)
	}
}

func TestResolveCreateSessionLaunchHydratesWorkspaceAgentRuntimeConfiguration(t *testing.T) {
	plan := modelplanbiz.Plan{
		ID:           "mp-one",
		WorkspaceID:  "ws",
		Revision:     4,
		Protocol:     modelplanbiz.ProtocolOpenAI,
		Models:       []modelplanbiz.Model{{ID: "gpt-5", Name: "GPT-5"}},
		DefaultModel: "gpt-5",
		Enabled:      true,
	}
	service := &Service{
		WorkspaceAgentResolver: staticWorkspaceAgentResolver{resolved: workspaceagentbiz.Resolved{
			Agent: workspaceagentbiz.Agent{
				ID:                   "workspace-agent:writer",
				WorkspaceID:          "ws",
				Name:                 "Focused Writer",
				Description:          "Make narrow code changes.",
				HarnessAgentTargetID: "local:codex",
				Instructions:         "Keep changes focused.",
				CapabilitiesExplicit: true,
				Skills:               []string{"go"},
				Tools:                []string{"shell"},
				Revision:             3,
			},
			HarnessTarget: agenttargetbiz.Target{
				ID:            "local:codex",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Source:        agenttargetbiz.SourceSystem,
				Enabled:       true,
			},
			ModelPlan:      &plan,
			EffectiveModel: "gpt-5",
		}},
	}
	input := CreateSessionInput{AgentTargetID: "workspace-agent:writer"}
	launch, err := service.resolveCreateSessionLaunch(context.Background(), "ws", &input)
	if err != nil {
		t.Fatalf("resolveCreateSessionLaunch() error = %v", err)
	}
	if launch.Provider != "codex" || launch.ProviderTargetRef["targetId"] != "local:codex" {
		t.Fatalf("resolveCreateSessionLaunch() launch = %#v", launch)
	}
	if input.WorkspaceAgentRevision != 3 || input.HarnessAgentTargetID != "local:codex" {
		t.Fatalf("resolveCreateSessionLaunch() identity = %#v", input)
	}
	if input.ResolvedModelPlan == nil || input.ResolvedModelPlan.Revision != 4 || value(input.Model) != "gpt-5" {
		t.Fatalf("resolveCreateSessionLaunch() model = %#v / %q", input.ResolvedModelPlan, value(input.Model))
	}
	if input.AgentInstructions != "Keep changes focused." || len(input.AgentSkills) != 1 || len(input.AgentTools) != 1 {
		t.Fatalf("resolveCreateSessionLaunch() Agent definition = %#v", input)
	}
	if !input.AgentCapabilitiesExplicit {
		t.Fatal("resolveCreateSessionLaunch() lost explicit capability selection")
	}
	if input.AgentName != "Focused Writer" || input.AgentDescription != "Make narrow code changes." {
		t.Fatalf("resolveCreateSessionLaunch() name/description = %q/%q", input.AgentName, input.AgentDescription)
	}
	if input.BrowserUse == nil || *input.BrowserUse || input.ComputerUse == nil || *input.ComputerUse {
		t.Fatalf("resolveCreateSessionLaunch() capability defaults = browser %#v computer %#v, want explicit false", input.BrowserUse, input.ComputerUse)
	}
}

func TestResolveCreateSessionLaunchPreservesExplicitWorkspaceAgentModel(t *testing.T) {
	plan := modelplanbiz.Plan{ID: "mp-one", Revision: 2, Enabled: true}
	service := &Service{
		WorkspaceAgentResolver: staticWorkspaceAgentResolver{resolved: workspaceagentbiz.Resolved{
			Agent: workspaceagentbiz.Agent{ID: "workspace-agent:writer", Revision: 1},
			HarnessTarget: agenttargetbiz.Target{
				ID:            "local:codex",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Source:        agenttargetbiz.SourceSystem,
				Enabled:       true,
			},
			ModelPlan:      &plan,
			EffectiveModel: "gpt-5",
		}},
	}
	explicit := "gpt-5-mini"
	input := CreateSessionInput{AgentTargetID: "workspace-agent:writer", Model: &explicit}
	if _, err := service.resolveCreateSessionLaunch(context.Background(), "ws", &input); err != nil {
		t.Fatalf("resolveCreateSessionLaunch() error = %v", err)
	}
	if value(input.Model) != explicit {
		t.Fatalf("resolveCreateSessionLaunch() model = %q, want explicit %q", value(input.Model), explicit)
	}
}

func TestResolveWorkspaceAgentLaunchAppliesAutomationToolRestriction(t *testing.T) {
	service := &Service{
		WorkspaceAgentResolver: staticWorkspaceAgentResolver{resolved: workspaceagentbiz.Resolved{
			Agent: workspaceagentbiz.Agent{
				ID:       "workspace-agent:operator",
				Revision: 2,
				Tools:    []string{"browser", "computer", "shell"},
			},
			HarnessTarget: agenttargetbiz.Target{
				ID:            "local:codex",
				Provider:      "codex",
				LaunchRefJSON: agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
				Name:          "Codex",
				Source:        agenttargetbiz.SourceSystem,
				Enabled:       true,
			},
		}},
	}
	input := CreateSessionInput{
		AgentTargetID: "workspace-agent:operator",
		// AutomationRule can only narrow the target Agent's configured tools.
		AgentTools: []string{"browser", "not-configured"},
	}
	if _, err := service.resolveCreateSessionLaunch(context.Background(), "ws", &input); err != nil {
		t.Fatalf("resolveCreateSessionLaunch() error = %v", err)
	}
	if len(input.AgentTools) != 1 || input.AgentTools[0] != "browser" {
		t.Fatalf("AgentTools = %#v, want browser intersection", input.AgentTools)
	}
	if input.BrowserUse == nil || !*input.BrowserUse || input.ComputerUse == nil || *input.ComputerUse {
		t.Fatalf("capability defaults = browser %#v computer %#v", input.BrowserUse, input.ComputerUse)
	}
}

func TestFilterWorkspaceAgentComposerSkills(t *testing.T) {
	options := []ComposerSkillOption{
		{Name: "reviewer", Trigger: "$reviewer", SourceKind: composerSkillSourcePersonal},
		{Name: "deployer", Trigger: "$deployer", SourceKind: composerSkillSourceProject},
		{Name: "tutti-cli", Trigger: "$tutti-cli", SourceKind: composerSkillSourceTuttiInjected},
	}
	filtered := filterWorkspaceAgentComposerSkills(options, []string{"reviewer"}, true)
	if len(filtered) != 2 || filtered[0].Name != "reviewer" || filtered[1].Name != "tutti-cli" {
		t.Fatalf("filtered skills = %#v", filtered)
	}
}

func TestFilterWorkspaceAgentComposerSkillsSupportsExplicitNone(t *testing.T) {
	options := []ComposerSkillOption{
		{Name: "reviewer", Trigger: "$reviewer", SourceKind: composerSkillSourcePersonal},
		{Name: "tutti-cli", Trigger: "$tutti-cli", SourceKind: composerSkillSourceTuttiInjected},
	}
	filtered := filterWorkspaceAgentComposerSkills(options, nil, true)
	if len(filtered) != 1 || filtered[0].Name != "tutti-cli" {
		t.Fatalf("filtered skills = %#v, want only trusted injected skill", filtered)
	}
}

func TestFilterWorkspaceAgentComposerCapabilitiesUsesExplicitToolAllowlist(t *testing.T) {
	options := []ComposerCapabilityOption{
		{ID: "skill:reviewer", Kind: "skill", Name: "reviewer"},
		{ID: "connector:github", Kind: "connector", Name: "github"},
		{ID: "connector:slack", Kind: "connector", Name: "slack"},
		{ID: "mcpServer:files", Kind: "mcpServer", Name: "files", ServerName: "files"},
		{ID: "mcpTool:files/read", Kind: "mcpTool", Name: "read", ServerName: "files"},
	}
	filtered := filterWorkspaceAgentComposerCapabilities(
		options,
		[]string{"connector:github", "mcpServer:files"},
		true,
	)
	if len(filtered) != 4 || filtered[1].ID != "connector:github" || filtered[3].ID != "mcpTool:files/read" {
		t.Fatalf("filtered capabilities = %#v", filtered)
	}
}

func TestConstrainWorkspaceAgentToolsTurnsAutomaticSelectionIntoRuleAllowlist(t *testing.T) {
	tools, explicit := constrainWorkspaceAgentTools(nil, []string{"browser"}, false)
	if !explicit || len(tools) != 1 || tools[0] != "browser" {
		t.Fatalf("tools = %#v explicit = %v", tools, explicit)
	}
}

func TestApplyWorkspaceAgentCapabilityDefaultsIgnoresCatalogIDs(t *testing.T) {
	input := CreateSessionInput{
		AgentCapabilitiesExplicit: true,
		AgentTools:                []string{"connector:github"},
	}
	applyWorkspaceAgentCapabilityDefaults(&input)
	if input.BrowserUse != nil || input.ComputerUse != nil {
		t.Fatalf("catalog ids changed daemon capabilities: browser=%#v computer=%#v", input.BrowserUse, input.ComputerUse)
	}
}
