package runtimeprep

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestTuttiHandoffSkillUsesCurrentAgentCatalog(t *testing.T) {
	skill := tuttiHandoffSkill(PrepareInput{CLICommand: "tutti-dev"})

	for _, want := range []string{
		"tutti-dev agent list --json",
		"tutti-dev agent start --agent-id <agent-id>",
		"tutti-dev agent session-summary --session-id <caller-session-id> --json",
		"tutti-dev agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json",
		"--image <localPath>",
		"selected agent id and failure reason",
		"another currently available agent",
	} {
		if !strings.Contains(skill, want) {
			t.Fatalf("tutti handoff skill missing %q: %q", want, skill)
		}
	}

	lowerSkill := strings.ToLower(skill)
	for _, forbidden := range []string{
		"codex start",
		"claude start",
		"tutti-agent start",
		"provider is unavailable",
		"@codex",
		"@claude",
	} {
		if strings.Contains(lowerSkill, forbidden) {
			t.Fatalf("tutti handoff skill retains fixed provider guidance %q: %q", forbidden, skill)
		}
	}
}

func TestWorkspaceAppSkillDefersAgentHandoffs(t *testing.T) {
	skill := workspaceAppSkill(PrepareInput{CLICommand: "tutti-dev"})

	for _, want := range []string{
		"Agent launching is not a workspace-app workflow",
		"mention://agent-target/...",
		"never translate an app id into a provider-specific agent command",
		"tutti-dev app open --app-id <appId> --json",
		"Do not call `app open` or app-specific open commands",
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
		"use injected `$tutti-cli`",
		"command-guide.md",
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
	if strings.Contains(skill, "turn-resources") || strings.Contains(skill, "--image <localPath>") {
		t.Fatalf("workspace app skill owns agent image handoff guidance: %q", skill)
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
	if strings.Contains(skill, "{{") ||
		strings.Contains(skill, "tutti-dev codex start") ||
		strings.Contains(skill, "tutti-dev claude start") ||
		strings.Contains(skill, "tutti-dev tutti-agent start") {
		t.Fatalf("workspace app skill used unresolved or production CLI command: %q", skill)
	}
	if strings.Contains(skill, "ask for missing `model`") ||
		strings.Contains(skill, "codex start --model <model>") ||
		strings.Contains(skill, "claude start --model <model>") {
		t.Fatalf("workspace app skill still requires model: %q", skill)
	}
}

func TestTuttiCLIPolicyUsesPreparedCLICommandForAgentCatalogHandoff(t *testing.T) {
	policy := tuttiCLIPolicy(PrepareInput{
		AgentSessionID: "session-1",
		CLICommand:     "tutti-dev",
		Provider:       "codex",
	})

	for _, want := range []string{
		"tutti-dev agent list --json",
		"agents[].id",
		"tutti-dev agent start --agent-id <agent-id> --prompt <task> --show --json",
		"tutti-dev agent wait",
		"tutti-dev agent session-summary",
		"does not fetch execution messages",
		"full compact context helper or turn discovery",
		"tutti-dev agent turn-resources",
		"`mention://agent-target/<targetId>?workspaceId=...`",
		"verify with `agent list`",
		"hand off, do not do it yourself",
		"--image <localPath>",
		"tutti-dev app open --app-id <appId> --json",
		"Ask for the task prompt, not a provider or model.",
		"download to readable local file",
		"Do not invent `tutti-dev workspace-app ...`.",
		"match `App id: <appId>` in command guide",
		"### Rules",
		"Do not skip skill because CLI command is listed.",
		"## Execution Environment",
		"`tutti-dev` talks to local daemon over localhost/IPC.",
		"Do not change global sandbox settings yourself.",
		"Codex: `tutti-dev` needs localhost/IPC.",
		"sandbox_permissions=require_escalated",
		"rerun once with `sandbox_permissions=require_escalated`",
		"## CLI Reference",
		"`tutti-dev <scope> --help`",
		"App id mapping: read `command-guide.md` from visible `$tutti-cli` skill files.",
	} {
		if !strings.Contains(policy, want) {
			t.Fatalf("tutti CLI policy missing %q: %q", want, policy)
		}
	}
	if strings.Contains(policy, "tutti-dev issue list --topic-id <topic-id>") {
		t.Fatalf("tutti CLI policy should not inline full command guide: %q", policy)
	}
	if strings.Contains(policy, "Claude Code `Monitor` tool is disabled") ||
		strings.Contains(policy, "bounded shell/script") {
		t.Fatalf("codex Tutti CLI policy should not include Claude Code Monitor guidance: %q", policy)
	}
	if strings.Contains(policy, "{{CLI_COMMAND}}") ||
		strings.Contains(policy, "tutti-dev codex start") ||
		strings.Contains(policy, "tutti-dev claude start") ||
		strings.Contains(policy, "tutti-dev tutti-agent start") {
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
		!strings.Contains(policy, "Images/videos: use Markdown") ||
		!strings.Contains(policy, "use `[filename](/abs/path)` Markdown links") ||
		!strings.Contains(policy, "No relative paths, line suffixes") {
		t.Fatalf("tutti CLI policy missing host app context: %q", policy)
	}

	claudePolicy := tuttiCLIPolicy(PrepareInput{
		AgentSessionID: "session-1",
		CLICommand:     "tutti-dev",
		Provider:       "claude-code",
	})
	if !strings.Contains(claudePolicy, "Claude Code `Monitor` tool is disabled") ||
		!strings.Contains(claudePolicy, "bounded shell/script") ||
		!strings.Contains(claudePolicy, "do not invent Codex `sandbox_permissions`") ||
		!strings.Contains(claudePolicy, "localhost/IPC") {
		t.Fatalf("claude Tutti CLI policy missing Monitor guidance: %q", claudePolicy)
	}
	if strings.Contains(claudePolicy, "sandbox_permissions=require_escalated") {
		t.Fatalf("claude Tutti CLI policy should not include Codex escalation syntax: %q", claudePolicy)
	}

	hermesPolicy := tuttiCLIPolicy(PrepareInput{
		AgentSessionID: "session-1",
		CLICommand:     "tutti-dev",
		Provider:       "hermes",
	})
	if !strings.Contains(hermesPolicy, "execution environment with localhost/IPC access") ||
		strings.Contains(hermesPolicy, "sandbox_permissions=require_escalated") {
		t.Fatalf("hermes Tutti CLI policy should use generic daemon environment guidance: %q", hermesPolicy)
	}
}

func TestProviderSkillRootDoesNotExposeClaudeCodeProjectSkills(t *testing.T) {
	cwd := filepath.Join("workspace", "repo")

	if root := providerSkillRoot(cwd, "claude-code"); root != "" {
		t.Fatalf("providerSkillRoot() for claude-code = %q, want empty", root)
	}
	if root := providerSkillRoot(cwd, "cursor"); root != "" {
		t.Fatalf("providerSkillRoot() for cursor = %q, want empty", root)
	}
	if root := providerSkillRoot(cwd, "hermes"); root != filepath.Join(cwd, ".agent_context", "skills") {
		t.Fatalf("providerSkillRoot() for hermes = %q, want project skill root", root)
	}
	if root := providerSkillRoot(cwd, "open-claw"); root != filepath.Join(cwd, ".openclaw", "skills") {
		t.Fatalf("providerSkillRoot() for open-claw = %q, want project skill root", root)
	}
	if root := providerSkillRoot(cwd, "tutti"); root != filepath.Join(cwd, ".nexight", "skills") {
		t.Fatalf("providerSkillRoot() for historical tutti alias = %q, want Nexight project skill root", root)
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
		AgentTargetID:  "local:codex",
		Provider:       "codex",
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}
	if catalog.context.Source != "agent-runtime" || catalog.context.WorkspaceID != "workspace-1" {
		t.Fatalf("catalog context = %#v", catalog.context)
	}
	if bundle.SchemaVersion != 2 ||
		bundle.AgentTargetID != "local:codex" ||
		bundle.Provider != "codex" ||
		bundle.AgentSessionID != "run-1" ||
		bundle.CLICommand != "tutti-dev" {
		t.Fatalf("bundle metadata = %#v", bundle)
	}
	if got := skillBundleSlugs(bundle.Skills); strings.Join(got, ",") != "tutti-cli,tutti-handoff,issue-manager,workspace-app,reference" {
		t.Fatalf("skill slugs = %#v", got)
	}
	if bundle.RecommendedSystemPrompt == nil ||
		bundle.RecommendedSystemPrompt.Format != "text/markdown" {
		t.Fatalf("recommended system prompt = %#v", bundle.RecommendedSystemPrompt)
	}
	for _, want := range []string{
		"Without `mention://...`, do not treat this bundle alone as intent.",
		"Use Tutti only when user explicitly asks for Tutti",
		"Runtime context: session `run-1`, provider `codex`.",
		"`mention://workspace-app/<appId>?workspaceId=...` -> `$workspace-app`",
		"`<appId>` is not a skill name",
		"If provider-native Skill tools exist",
		"read materialized `SKILL.md`",
		"Do not infer fixed filesystem paths from slugs",
		"Do not read app `AGENTS.md`, `COMMANDS.md`, source files, or run shell before matching Tutti skill.",
		"Do not invent `tutti-dev workspace-app ...`.",
		"match `App id: <appId>` in `command-guide.md`",
		"CLI reference:",
		"`tutti-dev <scope> --help`",
		"App id mapping: read `command-guide.md` from visible `$tutti-cli` skill files.",
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
		strings.Contains(bundle.RecommendedSystemPrompt.Content, "standard Markdown syntax") {
		t.Fatalf("recommended system prompt should not include host app context: %q", bundle.RecommendedSystemPrompt.Content)
	}
	if strings.Contains(bundle.RecommendedSystemPrompt.Content, "tutti-dev issue list --topic-id <topic-id>") {
		t.Fatalf("recommended system prompt should not inline full command guide: %q", bundle.RecommendedSystemPrompt.Content)
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
		"## Dynamic Command Snapshot",
		"not a stable inventory of every command",
		"tutti-dev <scope> --help",
		"preserves `App id:` metadata",
		"older materialized command guide",
		"`$workspace-app` is a skill and mention kind, not a CLI scope",
		"The current AgentGUI session is `run-1`.",
		"The current AgentGUI provider is `codex`.",
		"`tutti-dev <scope> --help`",
		"this skill's `command-guide.md`",
	} {
		if !strings.Contains(tuttiSkill.Content, want) {
			t.Fatalf("tutti skill content missing %q: %q", want, tuttiSkill.Content)
		}
	}
	if strings.Contains(tuttiSkill.Content, "{{") {
		t.Fatalf("tutti skill content has unresolved placeholder: %q", tuttiSkill.Content)
	}
	commandGuideReference, ok := skillBundleFileContent(tuttiSkill, commandGuideReferencePath)
	if !ok {
		t.Fatalf("tutti skill missing command guide reference: %#v", tuttiSkill.Files)
	}
	if !strings.Contains(commandGuideReference, "tutti-dev issue list --topic-id <topic-id>") {
		t.Fatalf("command guide reference = %q", commandGuideReference)
	}
	if strings.Contains(tuttiSkill.Content, "tutti-dev issue list --topic-id <topic-id>") {
		t.Fatalf("tutti skill content should not inline full command guide: %q", tuttiSkill.Content)
	}
}

func TestRenderProviderSkillBundleGatesOptionalSkills(t *testing.T) {
	t.Setenv(browserUseSwitchEnv, "")
	t.Setenv(computerUseSwitchEnv, "")
	preparer := NewDefaultPreparer(t.TempDir())
	preparer.ComputerUseAvailable = func() bool { return true }

	withoutOptional, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "run-1",
		AgentTargetID:  "local:codex",
		CLICommand:     "tutti-dev",
		Provider:       "codex",
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}
	if got := strings.Join(skillBundleSlugs(withoutOptional.Skills), ","); got != "tutti-cli,tutti-handoff,issue-manager,workspace-app,reference" {
		t.Fatalf("skill slugs without optional = %q", got)
	}

	withOptional, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "run-1",
		AgentTargetID:  "local:codex",
		BrowserUse:     true,
		CLICommand:     "tutti-dev",
		ComputerUse:    true,
		Provider:       "codex",
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}
	wantSlugs := "tutti-cli,tutti-handoff,issue-manager,workspace-app,reference,browser-use,computer-use"
	if got := strings.Join(skillBundleSlugs(withOptional.Skills), ","); got != wantSlugs {
		t.Fatalf("skill slugs with optional = %q", got)
	}
	wantPromptFragments := []string{"tutti-dev browser", "tutti-dev computer"}
	if withOptional.RecommendedSystemPrompt == nil ||
		!containsAll(withOptional.RecommendedSystemPrompt.Content, wantPromptFragments...) {
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

func TestRenderProviderSkillBundleOmitsComputerUseWhenUnavailable(t *testing.T) {
	t.Setenv(browserUseSwitchEnv, "")
	t.Setenv(computerUseSwitchEnv, "")
	preparer := NewDefaultPreparer(t.TempDir())
	preparer.ComputerUseAvailable = func() bool { return false }

	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "run-1",
		AgentTargetID:  "local:codex",
		BrowserUse:     true,
		CLICommand:     "tutti-dev",
		ComputerUse:    true,
		Provider:       "codex",
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}

	if got := strings.Join(skillBundleSlugs(bundle.Skills), ","); strings.Contains(got, "computer-use") {
		t.Fatalf("skill slugs with unavailable computer-use = %q", got)
	}
	if bundle.RecommendedSystemPrompt != nil && strings.Contains(bundle.RecommendedSystemPrompt.Content, "tutti-dev computer") {
		t.Fatalf("recommended system prompt = %#v, want no computer policy", bundle.RecommendedSystemPrompt)
	}
}

func containsAll(content string, fragments ...string) bool {
	for _, fragment := range fragments {
		if !strings.Contains(content, fragment) {
			return false
		}
	}
	return true
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
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "mention://agent-target/<targetId>?workspaceId=...") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "handed off, not absorbed") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, `Skill(skill="tutti-cli:workspace-app")`) ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "Do not call a plain skill name that is not visible") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "Do not pass arguments to Skill") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "the skill reads the mention URI from the current user turn") ||
		!strings.Contains(bundle.RecommendedSystemPrompt.Content, "Call the exact visible Skill tool when available") ||
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

func skillBundleFileContent(skill SkillMaterializationRecord, path string) (string, bool) {
	for _, file := range skill.Files {
		if file.Path == path {
			return file.Content, true
		}
	}
	return "", false
}
