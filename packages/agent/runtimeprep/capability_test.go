package runtimeprep

import (
	"context"
	"strings"
	"testing"
)

func TestDefaultPreparerResolvesInjectedPackAcrossPolicySkillsAndEnv(t *testing.T) {
	profile := StandardProfile()
	profile.Packs = append(profile.Packs, CapabilityPack{
		Name: "deployment-docs",
		Resolve: func(context.Context, PrepareInput) (CapabilityContribution, error) {
			return CapabilityContribution{
				Enabled: true,
				Skills: []SkillSpec{{
					ID: "deployment/docs", Name: "deployment-docs",
					Files: map[string]string{"SKILL.md": "# Deployment Docs\n"},
				}},
				PolicySections: []PolicySection{{
					Anchor: PolicyAnchorSpecialized, Key: "docs", Body: "## Deployment Docs\n\nUse the injected deployment docs skill.",
				}},
				EnvOverlay: []string{"TUTTI_DEPLOYMENT_DOCS=1"},
			}, nil
		},
	})
	preparer := NewDefaultPreparer(t.TempDir())
	preparer.Profile = profile

	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", AgentTargetID: "local:codex", Provider: "codex",
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}
	if skillBundleRecord(bundle.Skills, "deployment-docs").SkillID != "deployment/docs" {
		t.Fatalf("injected skill missing from bundle: %#v", bundle.Skills)
	}
	if bundle.RecommendedSystemPrompt == nil || !strings.Contains(bundle.RecommendedSystemPrompt.Content, "Use the injected deployment docs skill") {
		t.Fatalf("recommended prompt missing injected policy: %#v", bundle.RecommendedSystemPrompt)
	}

	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "unknown", Cwd: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if envValue(prepared.Env, "TUTTI_DEPLOYMENT_DOCS") != "1" {
		t.Fatalf("prepared env missing pack overlay: %#v", prepared.Env)
	}
}

func TestHostAppContextUsesNativeGeneratedImageArtifactsOnlyForSupportedProviders(t *testing.T) {
	codexPolicy := hostAppContextPolicy(PrepareInput{Provider: "codex"})
	if !strings.Contains(codexPolicy, "rendered directly from `imageGeneration` tool output") ||
		!strings.Contains(codexPolicy, "do not repeat generated images as Markdown image tags") ||
		strings.Contains(codexPolicy, "final response must include Markdown image tag") {
		t.Fatalf("codex host policy = %q, want native generated-image artifact contract", codexPolicy)
	}

	claudePolicy := hostAppContextPolicy(PrepareInput{Provider: "claude-code"})
	if !strings.Contains(claudePolicy, "Generated/edited image output: final response must include Markdown image tag.") ||
		!strings.Contains(claudePolicy, "Multiple final images: one Markdown image tag each.") ||
		strings.Contains(claudePolicy, "rendered directly from `imageGeneration` tool output") {
		t.Fatalf("claude host policy = %q, want Markdown image fallback contract", claudePolicy)
	}
}

func TestCustomDeploymentProfileDoesNotInheritTuttiDesktopHostPolicy(t *testing.T) {
	t.Parallel()

	bundle, err := Resolve(t.Context(), PrepareInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex", CLICommand: "tutti",
	}, DeploymentProfile{
		Name:  "managed-vm",
		Title: "Managed VM",
		Intro: "Runs in a managed VM.",
		Packs: []CapabilityPack{CoreSkillsPack()},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"# Host App Context",
		"Tutti desktop app host",
		"sandbox_permissions=require_escalated",
		"`tutti-dev`",
	} {
		if strings.Contains(bundle.SystemPrompt, forbidden) {
			t.Fatalf("managed VM prompt inherited desktop host policy %q: %s", forbidden, bundle.SystemPrompt)
		}
	}
	if len(bundle.Skills) != 6 {
		t.Fatalf("managed VM core skill count = %d, want 6", len(bundle.Skills))
	}
}

func TestResolveCapabilitiesRejectsDuplicateSkillIDs(t *testing.T) {
	profile := DeploymentProfile{Name: "test", Packs: []CapabilityPack{
		{Name: "one", Resolve: staticCapability(SkillSpec{ID: "shared/skill", Name: "one", Files: map[string]string{"SKILL.md": "one"}})},
		{Name: "two", Resolve: staticCapability(SkillSpec{ID: "shared/skill", Name: "two", Files: map[string]string{"SKILL.md": "two"}})},
	}}
	_, err := resolveCapabilities(t.Context(), PrepareInput{Provider: "codex"}, profile, nil)
	if err == nil || !strings.Contains(err.Error(), "skill id \"shared/skill\" is duplicated") {
		t.Fatalf("resolveCapabilities() error = %v", err)
	}
}

func TestDefaultPreparerIncludesHostSkillSources(t *testing.T) {
	preparer := NewDefaultPreparer(t.TempDir())
	preparer.SkillSources = []SkillSource{staticSkillSource{{
		ID: "host/reviewer", Name: "reviewer", Files: map[string]string{"SKILL.md": "# Reviewer\n"},
	}}}
	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", AgentTargetID: "local:claude-code", Provider: "claude-code",
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}
	if skillBundleRecord(bundle.Skills, "reviewer").SkillID != "host/reviewer" {
		t.Fatalf("host skill source missing from bundle: %#v", bundle.Skills)
	}
}

func TestResolveCapabilitiesRejectsSkillPathTraversal(t *testing.T) {
	profile := DeploymentProfile{Name: "test", Packs: []CapabilityPack{{
		Name: "unsafe", Resolve: staticCapability(SkillSpec{
			ID: "unsafe/skill", Name: "unsafe", Files: map[string]string{"../secret": "nope"},
		}),
	}}}
	_, err := resolveCapabilities(t.Context(), PrepareInput{Provider: "codex"}, profile, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid file path") {
		t.Fatalf("resolveCapabilities() error = %v", err)
	}
}

func TestRenderTemplateRejectsMissingTemplateValuesButPreservesValueContent(t *testing.T) {
	if _, err := RenderTemplate("hello {{NAME}}", nil); err == nil {
		t.Fatal("RenderTemplate() error = nil, want unresolved placeholder error")
	}
	rendered, err := RenderTemplate("hello {{NAME}}", map[string]string{"{{NAME}}": "{{literal}}"})
	if err != nil {
		t.Fatalf("RenderTemplate() error = %v", err)
	}
	if rendered != "hello {{literal}}" {
		t.Fatalf("RenderTemplate() = %q", rendered)
	}
}

func staticCapability(skill SkillSpec) func(context.Context, PrepareInput) (CapabilityContribution, error) {
	return func(context.Context, PrepareInput) (CapabilityContribution, error) {
		return CapabilityContribution{Enabled: true, Skills: []SkillSpec{skill}}, nil
	}
}

type staticSkillSource []SkillSpec

func (s staticSkillSource) Skills(context.Context, SkillContext) ([]SkillSpec, error) {
	return append([]SkillSpec(nil), s...), nil
}
