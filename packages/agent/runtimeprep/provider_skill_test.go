package runtimeprep

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestProviderSkillsRenderFromCommandSnapshot(t *testing.T) {
	input := testInputWithCommands(t, PrepareInput{
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		CLICommand:     "tutti-dev",
		Provider:       "codex",
	})
	handoff, err := tuttiHandoffSkill(input)
	if err != nil {
		t.Fatal(err)
	}
	workspaceApp, err := workspaceAppSkill(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"tutti-dev agent list --json",
		"tutti-dev agent start --agent-id <agent-id> --prompt <prompt> --show --json",
		"tutti-dev agent get --session-id <session-id> --view turns --json",
		"tutti-dev agent turn-resources --session-id <session-id> --turn-id <turn-id> --json",
		"images[].localPath",
	} {
		if !strings.Contains(handoff, want) {
			t.Fatalf("handoff skill missing %q: %s", want, handoff)
		}
	}
	for _, want := range []string{
		"Agent launching is not a workspace-app workflow",
		"tutti-dev app open --app-id <appId> --json",
		"Do not call `app open`",
		"App id: <appId>",
		"command-guide.md",
	} {
		if !strings.Contains(workspaceApp, want) {
			t.Fatalf("workspace-app skill missing %q: %s", want, workspaceApp)
		}
	}
	for label, content := range map[string]string{"handoff": handoff, "workspace-app": workspaceApp} {
		if strings.Contains(content, "{{") {
			t.Fatalf("%s contains unresolved template syntax: %s", label, content)
		}
	}
}

func TestTuttiCLIPolicyUsesPreparedCLIAndProviderRules(t *testing.T) {
	codex, err := tuttiCLIPolicy(testInputWithCommands(t, PrepareInput{
		AgentSessionID: "session-1",
		CLICommand:     "tutti-dev",
		Provider:       "codex",
	}))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"tutti-dev agent list --json",
		"tutti-dev agent start --agent-id <agent-id> --prompt <prompt> --show --json",
		"tutti-dev agent wait --session-id <session-id> --json",
		"tutti-dev app open --app-id <appId> --json",
		"sandbox_permissions=require_escalated",
		"# Host App Context",
	} {
		if !strings.Contains(codex, want) {
			t.Fatalf("codex policy missing %q: %s", want, codex)
		}
	}

	claude, err := tuttiCLIPolicy(testInputWithCommands(t, PrepareInput{
		AgentSessionID: "session-1",
		CLICommand:     "tutti-dev",
		Provider:       "claude-code",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(claude, "Claude Code `Monitor` tool is disabled") ||
		!strings.Contains(claude, "localhost/IPC") ||
		strings.Contains(claude, "sandbox_permissions=require_escalated") {
		t.Fatalf("claude policy has wrong provider execution rules: %s", claude)
	}
}

func TestProviderSkillRootDoesNotExposeClaudeCodeProjectSkills(t *testing.T) {
	cwd := filepath.Join("workspace", "repo")
	if root := providerSkillRoot(cwd, "claude-code"); root != "" {
		t.Fatalf("providerSkillRoot() for claude-code = %q", root)
	}
	if root := providerSkillRoot(cwd, "hermes"); root != filepath.Join(cwd, ".agent_context", "skills") {
		t.Fatalf("providerSkillRoot() for hermes = %q", root)
	}
	if root := providerSkillRoot(cwd, "open-claw"); root != filepath.Join(cwd, ".openclaw", "skills") {
		t.Fatalf("providerSkillRoot() for open-claw = %q", root)
	}
}

func TestRenderSkillBundleIncludesGuideAndOptionalSkills(t *testing.T) {
	t.Setenv(browserUseSwitchEnv, "")
	t.Setenv(computerUseSwitchEnv, "")
	preparer := newTestPreparer(t.TempDir())
	preparer.CLICommand = "tutti-dev"
	preparer.ComputerUseAvailable = func() bool { return true }

	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		BrowserUse:     true,
		ComputerUse:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if bundle.SchemaVersion != 2 || bundle.CLICommand != "tutti-dev" {
		t.Fatalf("bundle metadata = %#v", bundle)
	}
	wantSlugs := "tutti-cli,tutti-handoff,issue-manager,workspace-app,reference,browser-use,computer-use"
	if got := strings.Join(skillBundleSlugs(bundle.Skills), ","); got != wantSlugs {
		t.Fatalf("skill slugs = %q", got)
	}
	tuttiSkill := skillBundleRecord(bundle.Skills, tuttiSkillName)
	guide, ok := skillBundleFileContent(tuttiSkill, commandGuideReferencePath)
	if !ok || !strings.Contains(guide, "tutti-dev issue get --issue-id <issue-id> --json") {
		t.Fatalf("command guide = %q", guide)
	}
	browser := skillBundleRecord(bundle.Skills, browserUseSkillName).Content
	computer := skillBundleRecord(bundle.Skills, computerUseSkillName).Content
	if !strings.Contains(browser, "tutti-dev browser navigate --url <url> --json") {
		t.Fatalf("browser skill missing rendered command: %s", browser)
	}
	for _, want := range []string{
		"tutti-dev computer screenshot --json",
		"tutti-dev computer tool describe --name <tool> --json",
		`{"capture_scope":"desktop"}`,
		"element_token",
	} {
		if !strings.Contains(computer, want) {
			t.Fatalf("computer skill missing %q: %s", want, computer)
		}
	}
}

func TestRenderSkillBundleOmitsUnavailableComputerUse(t *testing.T) {
	t.Setenv(browserUseSwitchEnv, "")
	t.Setenv(computerUseSwitchEnv, "")
	preparer := newTestPreparer(t.TempDir())
	preparer.ComputerUseAvailable = func() bool { return false }

	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		ComputerUse:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(skillBundleSlugs(bundle.Skills), ","), "computer-use") {
		t.Fatalf("computer-use should be unavailable: %#v", bundle.Skills)
	}
}

func TestRenderProviderSkillBundleIncludesClaudeRouting(t *testing.T) {
	input := testInputWithCommands(t, PrepareInput{
		AgentSessionID: "session-1",
		AgentTargetID:  "local:claude",
		CLICommand:     "tutti-dev",
		Provider:       "claude",
	})
	resolved, err := resolveCapabilities(t.Context(), input, StandardProfile(), nil)
	if err != nil {
		t.Fatal(err)
	}
	input.resolved = resolved
	bundle, err := renderProviderSkillBundle(input)
	if err != nil {
		t.Fatal(err)
	}
	if bundle.RecommendedSystemPrompt == nil {
		t.Fatal("missing recommended system prompt")
	}
	for _, want := range []string{
		"Claude Code mention routing",
		`Skill(skill="tutti-cli:workspace-app")`,
		`Skill(skill="tutti-cli:tutti-handoff")`,
		"Do not use `ToolSearch`",
	} {
		if !strings.Contains(bundle.RecommendedSystemPrompt.Content, want) {
			t.Fatalf("recommended prompt missing %q: %s", want, bundle.RecommendedSystemPrompt.Content)
		}
	}
}

func skillBundleSlugs(skills []SkillMaterializationRecord) []string {
	slugs := make([]string, 0, len(skills))
	for _, skill := range skills {
		slugs = append(slugs, skill.Slug)
	}
	return slugs
}

func skillBundleRecord(skills []SkillMaterializationRecord, slug string) SkillMaterializationRecord {
	for _, skill := range skills {
		if skill.Slug == slug {
			return skill
		}
	}
	return SkillMaterializationRecord{}
}

func skillBundleFileContent(skill SkillMaterializationRecord, path string) (string, bool) {
	for _, file := range skill.Files {
		if file.Path == path {
			return file.Content, true
		}
	}
	return "", false
}
