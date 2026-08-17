package runtimeprep

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"
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
	preparer := newTestPreparer(t.TempDir())
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
	codexPolicy, err := hostAppContextPolicy(PrepareInput{Provider: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(codexPolicy, "rendered directly from `imageGeneration` tool output") ||
		!strings.Contains(codexPolicy, "do not repeat generated images as Markdown image tags") ||
		!strings.Contains(codexPolicy, "[title](mentionUri)") ||
		!strings.Contains(codexPolicy, "never return only `agentSessionId`") ||
		strings.Contains(codexPolicy, "final response must include Markdown image tag") {
		t.Fatalf("codex host policy = %q, want native generated-image artifact contract", codexPolicy)
	}

	claudePolicy, err := hostAppContextPolicy(PrepareInput{Provider: "claude-code"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(claudePolicy, "Generated/edited image output: final response must include Markdown image tag.") ||
		!strings.Contains(claudePolicy, "Multiple final images: one Markdown image tag each.") ||
		strings.Contains(claudePolicy, "rendered directly from `imageGeneration` tool output") {
		t.Fatalf("claude host policy = %q, want Markdown image fallback contract", claudePolicy)
	}
}

func TestVerifiedEndpointOutputPackIsNarrowAndProviderRuntimeOnly(t *testing.T) {
	t.Parallel()

	input := PrepareInput{Provider: "codex", CLICommand: "tutti"}
	resolved, err := resolveCapabilities(t.Context(), input, DeploymentProfile{
		Name:  "managed-vm",
		Packs: []CapabilityPack{VerifiedEndpointOutputPack()},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.PolicySections) != 1 {
		t.Fatalf("policy section count = %d, want 1", len(resolved.PolicySections))
	}
	section := resolved.PolicySections[0]
	if section.Delivery != PolicyDeliveryProviderRuntime {
		t.Fatalf("policy delivery = %q, want %q", section.Delivery, PolicyDeliveryProviderRuntime)
	}
	for _, required := range []string{
		"verified user-reachable HTTP(S) endpoint",
		"Markdown link using `[label](url)`",
		"Do not wrap a user-reachable URL or its Markdown link in backticks",
		"Never invent, guess, or assume a port or URL",
		"provide the verified listening address and port as inline code",
	} {
		if !strings.Contains(section.Body, required) {
			t.Errorf("verified endpoint policy missing %q: %s", required, section.Body)
		}
	}
	for _, forbidden := range []string{
		"Tutti desktop app host",
		"sandbox_permissions",
		"Images/videos",
		"generated_images",
		"Code/workspace files",
	} {
		if strings.Contains(section.Body, forbidden) {
			t.Errorf("verified endpoint policy inherited %q: %s", forbidden, section.Body)
		}
	}
	if size := utf8.RuneCountInString(section.Body); size > 800 {
		t.Fatalf("verified endpoint policy size = %d runes, want <= 800", size)
	}

	input.resolved = resolved
	if providerPolicy := renderPolicySections(input, PolicyAnchorSpecialized, PolicyDeliveryProviderRuntime); providerPolicy != section.Body {
		t.Fatalf("provider policy = %q, want %q", providerPolicy, section.Body)
	}
	if skillBundlePolicy := renderPolicySections(input, PolicyAnchorSpecialized, PolicyDeliverySkillBundle); skillBundlePolicy != "" {
		t.Fatalf("skill bundle policy = %q, want empty", skillBundlePolicy)
	}
	providerPrompt, err := tuttiRuntimePolicy(input)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(providerPrompt, section.Body) {
		t.Fatalf("provider prompt missing verified endpoint policy: %s", providerPrompt)
	}
	skillBundlePrompt, err := tuttiSkillBundleRecommendedPolicy(input)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(skillBundlePrompt, "## Local Server Output") {
		t.Fatalf("skill bundle prompt inherited verified endpoint policy: %s", skillBundlePrompt)
	}
}

func TestStandardProfileIncludesVerifiedEndpointOutputOnce(t *testing.T) {
	t.Parallel()

	bundle, err := Resolve(t.Context(), PrepareInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex", CLICommand: "tutti",
	}, StandardProfile())
	if err != nil {
		t.Fatal(err)
	}
	if count := strings.Count(bundle.SystemPrompt, "## Local Server Output"); count != 1 {
		t.Fatalf("local server output policy count = %d, want 1", count)
	}
	if !strings.Contains(bundle.SystemPrompt, "Do not wrap a user-reachable URL or its Markdown link in backticks") {
		t.Fatalf("standard profile missing verified endpoint output contract: %s", bundle.SystemPrompt)
	}
}

func TestDesktopProviderExecutionDoesNotLeakIntoSkillBundle(t *testing.T) {
	t.Parallel()

	input := PrepareInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex", CLICommand: "tutti",
	}
	resolved, err := resolveCapabilities(t.Context(), input, StandardProfile(), nil)
	if err != nil {
		t.Fatal(err)
	}
	input.resolved = resolved
	providerPrompt, err := tuttiRuntimePolicy(input)
	if err != nil {
		t.Fatal(err)
	}
	skillBundlePrompt, err := tuttiSkillBundleRecommendedPolicy(input)
	if err != nil {
		t.Fatal(err)
	}
	const providerExecution = "sandbox_permissions=require_escalated"
	if !strings.Contains(providerPrompt, providerExecution) {
		t.Fatalf("provider prompt missing desktop execution policy: %s", providerPrompt)
	}
	if strings.Contains(skillBundlePrompt, providerExecution) {
		t.Fatalf("skill bundle inherited provider execution policy: %s", skillBundlePrompt)
	}
}

func TestAgentSessionMentionReadsConversationWithoutWaiting(t *testing.T) {
	t.Parallel()

	input := testResolvedInput(t, PrepareInput{Provider: "codex", CLICommand: "tutti"})
	providerPrompt, err := tuttiRuntimePolicy(input)
	if err != nil {
		t.Fatal(err)
	}
	skillBundlePrompt, err := tuttiSkillBundleRecommendedPolicy(input)
	if err != nil {
		t.Fatal(err)
	}
	for name, prompt := range map[string]string{"provider": providerPrompt, "skill bundle": skillBundlePrompt} {
		if !strings.Contains(prompt, "Agent-session mention") && !strings.Contains(prompt, "mention://agent-session") {
			t.Fatalf("%s prompt missing agent-session route: %s", name, prompt)
		}
		if !strings.Contains(prompt, "tutti agent get --session-id <session-id>") {
			t.Fatalf("%s prompt does not recover agent-session conversation with get: %s", name, prompt)
		}
		if strings.Contains(prompt, "Agent-session mention: `tutti agent wait") {
			t.Fatalf("%s prompt treats a context reference as a wait instruction: %s", name, prompt)
		}
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
	preparer := newTestPreparer(t.TempDir())
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

func TestResolveCapabilitiesSkipsSkillSourcesForModelProbe(t *testing.T) {
	called := false
	_, err := resolveCapabilities(t.Context(), PrepareInput{
		Provider:   "codex",
		SkipSkills: true,
	}, StandardProfile(), []SkillSource{countingSkillSource{called: &called}})
	if err != nil {
		t.Fatalf("resolveCapabilities() error = %v", err)
	}
	if called {
		t.Fatal("model-only capability resolution called a Skill source")
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

func staticCapability(skill SkillSpec) func(context.Context, PrepareInput) (CapabilityContribution, error) {
	return func(context.Context, PrepareInput) (CapabilityContribution, error) {
		return CapabilityContribution{Enabled: true, Skills: []SkillSpec{skill}}, nil
	}
}

type staticSkillSource []SkillSpec

func (s staticSkillSource) Skills(context.Context, SkillContext) ([]SkillSpec, error) {
	return append([]SkillSpec(nil), s...), nil
}

type countingSkillSource struct {
	called *bool
}

func (s countingSkillSource) Skills(context.Context, SkillContext) ([]SkillSpec, error) {
	*s.called = true
	return nil, nil
}
