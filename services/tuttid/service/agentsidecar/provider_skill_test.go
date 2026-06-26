package agentsidecar

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceAppSkillUsesPreparedCLICommandForAgentLaunchers(t *testing.T) {
	skill := workspaceAppSkill(PrepareInput{CLICommand: "tutti-dev"})

	for _, want := range []string{
		"tutti-dev codex start --prompt <task> --show --json",
		"tutti-dev claude start --prompt <task> --show --json",
		"tutti-dev app open --app-id <appId> --json",
		"Built-in app ids include",
		"tutti-onboarding",
		"Do not call `app open` by default",
		"Do not ask for a missing model",
		"If `appId` is `issue-manager` and the user asks issue/task work",
		"`tutti-dev <scope> <command>`",
	} {
		if !strings.Contains(skill, want) {
			t.Fatalf("workspace app skill missing %q: %q", want, skill)
		}
	}
	if strings.Contains(skill, "{{CLI_COMMAND}}") || strings.Contains(skill, "tutti codex start") {
		t.Fatalf("workspace app skill used unresolved or production CLI command: %q", skill)
	}
	if strings.Contains(skill, "ask for missing `model`") ||
		strings.Contains(skill, "codex start --model <model>") ||
		strings.Contains(skill, "claude start --model <model>") {
		t.Fatalf("workspace app skill still requires model: %q", skill)
	}
}

func TestTuttiCLIPolicyUsesPreparedCLICommandForAgentLauncherFallback(t *testing.T) {
	policy := tuttiCLIPolicy(PrepareInput{
		AgentSessionID: "session-1",
		CLICommand:     "tutti-dev",
		Provider:       "codex",
	})

	for _, want := range []string{
		"tutti-dev codex start --prompt <task> --show --json",
		"tutti-dev claude start --prompt <task> --show --json",
		"tutti-dev app open --app-id <appId> --json",
		"Built-in app ids include",
		"tutti-onboarding",
		"Do not use `app open` by default",
		"do not ask for a missing model",
		"if it is `issue-manager` and the user asks issue/task work",
	} {
		if !strings.Contains(policy, want) {
			t.Fatalf("tutti CLI policy missing %q: %q", want, policy)
		}
	}
	if strings.Contains(policy, "{{CLI_COMMAND}}") || strings.Contains(policy, "tutti codex start") {
		t.Fatalf("tutti CLI policy used unresolved or production CLI command: %q", policy)
	}
	if strings.Contains(policy, "Ask for missing `model`") ||
		strings.Contains(policy, "codex start --model <model>") ||
		strings.Contains(policy, "claude start --model <model>") {
		t.Fatalf("tutti CLI policy still requires model: %q", policy)
	}
	if !strings.Contains(policy, "# Host App Context") ||
		!strings.Contains(policy, "The app displays images and videos using standard Markdown syntax") {
		t.Fatalf("tutti CLI policy missing host app context: %q", policy)
	}
}

func TestProviderSkillRootDoesNotExposeClaudeCodeProjectSkills(t *testing.T) {
	cwd := filepath.Join("workspace", "repo")

	if root := providerSkillRoot(cwd, "claude-code"); root != "" {
		t.Fatalf("providerSkillRoot() for claude-code = %q, want empty", root)
	}
	if root := providerSkillRoot(cwd, "gemini"); root != filepath.Join(cwd, ".gemini", "skills") {
		t.Fatalf("providerSkillRoot() for gemini = %q, want project skill root", root)
	}
}

func TestDefaultPreparerRenderSkillBundleUsesDynamicGuide(t *testing.T) {
	catalog := fakeCommandCatalog{}
	preparer := NewDefaultPreparer(t.TempDir())
	preparer.CLICommand = "tutti-dev"
	preparer.CommandCatalog = &catalog

	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "run-1",
		Provider:       "codex",
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}
	if catalog.context.Source != "agent-runtime" || catalog.context.WorkspaceID != "workspace-1" {
		t.Fatalf("catalog context = %#v", catalog.context)
	}
	if bundle.SchemaVersion != 1 ||
		bundle.Provider != "codex" ||
		bundle.AgentSessionID != "run-1" ||
		bundle.CLICommand != "tutti-dev" {
		t.Fatalf("bundle metadata = %#v", bundle)
	}
	if got := skillBundleSlugs(bundle.Skills); strings.Join(got, ",") != "tutti-cli,issue-manager,workspace-app,reference" {
		t.Fatalf("skill slugs = %#v", got)
	}
	if bundle.RecommendedSystemPrompt == nil ||
		bundle.RecommendedSystemPrompt.Format != "text/markdown" {
		t.Fatalf("recommended system prompt = %#v", bundle.RecommendedSystemPrompt)
	}
	for _, want := range []string{
		"agent session id: `run-1`",
		"provider: `codex`",
		"tutti-dev issue list --topic-id <topic-id>",
		"`mention://workspace-app/<appId>?workspaceId=...` -> use `workspace-app`.",
		"`group-chat`; do not look for a `group-chat` skill",
		"first read the materialized `SKILL.md` for the matching skill slug",
		"Do not read app `AGENTS.md`, `COMMANDS.md`, source files, or run shell commands before following the matching Tutti skill.",
	} {
		if !strings.Contains(bundle.RecommendedSystemPrompt.Content, want) {
			t.Fatalf("recommended system prompt missing %q: %q", want, bundle.RecommendedSystemPrompt.Content)
		}
	}
	if strings.Contains(bundle.RecommendedSystemPrompt.Content, "# Host App Context") ||
		strings.Contains(bundle.RecommendedSystemPrompt.Content, "The app displays images and videos using standard Markdown syntax") {
		t.Fatalf("recommended system prompt should not include host app context: %q", bundle.RecommendedSystemPrompt.Content)
	}
	if strings.Contains(bundle.RecommendedSystemPrompt.Content, "{{") {
		t.Fatalf("recommended system prompt has unresolved placeholder: %q", bundle.RecommendedSystemPrompt.Content)
	}
	tuttiSkill := skillBundleRecord(bundle.Skills, "tutti-cli")
	if tuttiSkill.SkillID != "tutti/tutti-cli" ||
		tuttiSkill.DeliveryMode != "materialized-files" ||
		tuttiSkill.MaterializedPath != "" {
		t.Fatalf("tutti skill record = %#v", tuttiSkill)
	}
	for _, want := range []string{
		"tutti-dev issue list --topic-id <topic-id>",
		"The current AgentGUI session is `run-1`.",
		"The current AgentGUI provider is `codex`.",
	} {
		if !strings.Contains(tuttiSkill.Content, want) {
			t.Fatalf("tutti skill content missing %q: %q", want, tuttiSkill.Content)
		}
	}
	if strings.Contains(tuttiSkill.Content, "{{") {
		t.Fatalf("tutti skill content has unresolved placeholder: %q", tuttiSkill.Content)
	}
}

func TestRenderProviderSkillBundleGatesOptionalSkills(t *testing.T) {
	t.Setenv(browserUseSwitchEnv, "")
	t.Setenv(computerUseSwitchEnv, "")

	withoutOptional := renderProviderSkillBundle(PrepareInput{
		AgentSessionID: "run-1",
		CLICommand:     "tutti-dev",
		Provider:       "codex",
	})
	if got := strings.Join(skillBundleSlugs(withoutOptional.Skills), ","); got != "tutti-cli,issue-manager,workspace-app,reference" {
		t.Fatalf("skill slugs without optional = %q", got)
	}

	withOptional := renderProviderSkillBundle(PrepareInput{
		AgentSessionID: "run-1",
		BrowserUse:     true,
		CLICommand:     "tutti-dev",
		ComputerUse:    true,
		Provider:       "codex",
	})
	if got := strings.Join(skillBundleSlugs(withOptional.Skills), ","); got != "tutti-cli,issue-manager,workspace-app,reference,browser-use,computer-use" {
		t.Fatalf("skill slugs with optional = %q", got)
	}
	if withOptional.RecommendedSystemPrompt == nil ||
		!strings.Contains(withOptional.RecommendedSystemPrompt.Content, "tutti-dev browser") ||
		!strings.Contains(withOptional.RecommendedSystemPrompt.Content, "tutti-dev computer") {
		t.Fatalf("recommended system prompt = %#v", withOptional.RecommendedSystemPrompt)
	}
	browserSkill := skillBundleRecord(withOptional.Skills, "browser-use")
	if !strings.Contains(browserSkill.Content, "tutti-dev browser navigate") ||
		strings.Contains(browserSkill.Content, "{{CLI_COMMAND}}") ||
		strings.Contains(browserSkill.Content, "tutti browser") {
		t.Fatalf("browser skill content = %q", browserSkill.Content)
	}
	computerSkill := skillBundleRecord(withOptional.Skills, "computer-use")
	if !strings.Contains(computerSkill.Content, "tutti-dev computer screenshot") ||
		strings.Contains(computerSkill.Content, "{{CLI_COMMAND}}") ||
		strings.Contains(computerSkill.Content, "tutti computer") {
		t.Fatalf("computer skill content = %q", computerSkill.Content)
	}
}

func TestRenderProviderSkillBundleIncludesClaudeRoutingForAlias(t *testing.T) {
	bundle := renderProviderSkillBundle(PrepareInput{
		AgentSessionID: "run-1",
		CLICommand:     "tutti-dev",
		Provider:       "claude",
	})
	if bundle.Provider != "claude" {
		t.Fatalf("bundle provider = %q, want claude", bundle.Provider)
	}
	if bundle.RecommendedSystemPrompt == nil ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "Claude Code mention routing") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, `Skill(skill="workspace-app", args="<full mention URI>")`) {
		t.Fatalf("recommended system prompt = %#v", bundle.RecommendedSystemPrompt)
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
