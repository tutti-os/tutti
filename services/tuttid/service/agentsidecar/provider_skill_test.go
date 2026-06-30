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
		"When image context may be useful",
		"turn-resources",
		"tutti-dev agent session-summary --session-id <caller-session-id> --json",
		"discover candidate turn ids",
		"tutti-dev agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json",
		"Images remain grouped under their source message",
		"the calling agent decides which turn ids to query",
		"`--image <localPath>`",
		"Do not scan the workspace",
		"tutti-dev app open --app-id <appId> --json",
		"Built-in app ids include",
		"tutti-onboarding",
		"Do not call `app open` or app-specific open commands",
		"Do not ask for a missing model",
		"If `appId` is `issue-manager` and the user asks issue/task work",
		"`tutti-dev <scope> <command>`",
		"render it inline with Markdown instead of opening the app",
		"tutti-dev <scope> read --json",
		"Prefer command scopes that match the mentioned app",
		"Do not assume they are equal",
		"This skill is not a CLI scope",
		"Do not invent `tutti-dev workspace-app ...` unless that exact command appears in the command guide",
		"Do not derive a command path from the skill slug",
		"The actual CLI prefix is `tutti-dev`",
		"App id: <appId>",
		"use the injected `tutti-cli` command reference",
		"call the exact visible skill name with no arguments",
		"`tutti-cli:tutti-cli`",
		"Do not derive filesystem paths from the plugin directory, plugin name, or skill slug",
		"snapshot rendered for the current agent runtime or skill bundle",
		"preserves `App id:` metadata",
		"Do not use CLI help alone",
	} {
		if !strings.Contains(skill, want) {
			t.Fatalf("workspace app skill missing %q: %q", want, skill)
		}
	}
	if strings.Contains(skill, "read the materialized sibling `tutti-cli/SKILL.md`") {
		t.Fatalf("workspace app skill should not ask agents to guess sibling skill paths: %q", skill)
	}
	if strings.Contains(skill, "workspace-app commands listed in the command guide") ||
		strings.Contains(skill, "discover, inspect, or invoke CLI-enabled Tutti workspace app commands") {
		t.Fatalf("workspace app skill should avoid command-scope wording: %q", skill)
	}
	if strings.Contains(skill, "plugin root `tutti-cli/SKILL.md`") {
		t.Fatalf("workspace app skill should not anchor agents to plugin-root paths: %q", skill)
	}
	if strings.Contains(skill, "{{") || strings.Contains(skill, "tutti codex start") {
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
		"When image context may be useful",
		"tutti-dev agent session-summary --session-id <caller-session-id> --json",
		"discover candidate turn ids",
		"inspect the active turn and any recent user turns",
		"tutti-dev agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json",
		"`--image <localPath>`",
		"tutti-dev app open --app-id <appId> --json",
		"Built-in app ids include",
		"tutti-onboarding",
		"Do not use `app open` or app-specific open commands",
		"do not ask for a missing model",
		"If it is `issue-manager` and the user asks issue/task work",
		"The Claude Code `Monitor` tool is disabled in Tutti AgentGUI sessions",
		"prefer one self-contained Bash command or script",
		"checks the CLI first",
		"polls with bounded sleeps",
		"public web URL points directly to an image",
		"returns an image URL on `127.0.0.1`, `localhost`, or another machine-local host",
		"download it to a readable local image file first",
		"app-specific open commands such as `tutti-dev <scope> open`",
		"render it inline with Markdown instead of opening the app",
		"`workspace-app`: workspace app mention routing and app-id-to-command-guide mapping",
		"it is not a CLI scope",
		"Do not invent `tutti-dev workspace-app ...` unless that exact command is listed",
		"match command guide entries by `App id: <appId>`",
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
	if strings.Contains(policy, "workspace-app commands listed in the command guide") ||
		strings.Contains(policy, "workspace app mention discovery, inspection, and invocation guidance") {
		t.Fatalf("tutti CLI policy should avoid command-scope wording: %q", policy)
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
		"do not treat this dynamic skill bundle by itself as routing intent",
		"unless the user explicitly asks for Tutti",
		"Do not choose Tutti routing, Tutti skills, or a shell-mediated Tutti CLI call merely because this bundle or command guide is present.",
		"This guidance does not restrict host-application tools that are needed for the user's non-Tutti task.",
		"agent session id: `run-1`",
		"provider: `codex`",
		"tutti-dev issue list --topic-id <topic-id>",
		"`mention://workspace-app/<appId>?workspaceId=...` -> use `workspace-app`.",
		"`group-chat`; do not look for a `group-chat` skill",
		"If provider-native Skill tools are available",
		"using the exact skill name exposed by the provider",
		"If no exact provider-native Skill tool is available",
		"first read the materialized `SKILL.md` for the matching skill slug",
		"Do not infer a fixed filesystem path from the skill slug",
		"Do not read app `AGENTS.md`, `COMMANDS.md`, source files, or run shell commands before following the matching Tutti skill.",
		"`workspace-app`: workspace app mention routing and app-id-to-command-guide mapping",
		"it is not a CLI scope",
		"Do not invent `tutti-dev workspace-app ...` unless that exact command is listed",
		"match command guide entries by `App id: <appId>`",
	} {
		if !strings.Contains(bundle.RecommendedSystemPrompt.Content, want) {
			t.Fatalf("recommended system prompt missing %q: %q", want, bundle.RecommendedSystemPrompt.Content)
		}
	}
	if strings.Contains(bundle.RecommendedSystemPrompt.Content, "CODEX_HOME/skills/<skill>/SKILL.md") ||
		strings.Contains(bundle.RecommendedSystemPrompt.Content, "`workspace-app/SKILL.md`") {
		t.Fatalf("recommended system prompt should not guess materialized skill paths: %q", bundle.RecommendedSystemPrompt.Content)
	}
	if strings.Contains(bundle.RecommendedSystemPrompt.Content, "does not contain any `mention://...` URI, do not use Tutti CLI") {
		t.Fatalf("recommended system prompt should not ban explicit no-mention Tutti requests: %q", bundle.RecommendedSystemPrompt.Content)
	}
	if strings.Contains(bundle.RecommendedSystemPrompt.Content, "workspace-app commands listed in the command guide") ||
		strings.Contains(bundle.RecommendedSystemPrompt.Content, "workspace app mention discovery, inspection, and invocation guidance") {
		t.Fatalf("recommended system prompt should avoid command-scope wording: %q", bundle.RecommendedSystemPrompt.Content)
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
		"## Dynamic Command Snapshot",
		"not a stable inventory of every command",
		"tutti-dev <scope> --help",
		"preserves `App id:` metadata",
		"older materialized command guide",
		"`workspace-app` is a skill and mention kind, not a CLI scope",
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
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, `Skill(skill="tutti-cli:workspace-app")`) ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "Do not call a plain skill name that is not visible") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "Do not pass arguments to Skill") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "the skill reads the mention URI from the current user turn") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "Call the exact visible Skill tool for `workspace-app`") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "fall back to that materialized skill file") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "Do not guess a directory from the plain skill slug") {
		t.Fatalf("recommended system prompt = %#v", bundle.RecommendedSystemPrompt)
	}
	if strings.Contains(bundle.RecommendedSystemPrompt.Content, "`workspace-app/SKILL.md`") ||
		strings.Contains(bundle.RecommendedSystemPrompt.Content, `args="<full mention URI>"`) ||
		strings.Contains(bundle.RecommendedSystemPrompt.Content, "with the full mention URI") {
		t.Fatalf("recommended system prompt should not guess materialized skill paths: %#v", bundle.RecommendedSystemPrompt)
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
