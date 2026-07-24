package runtimeprep

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDefaultPreparerCodexWritesInstructionsSkillManifestAndEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "auth.json"), []byte(`{"token":"test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "models_cache.json"), []byte(`{"models":["cached"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	userCodexConfig := strings.Join([]string{
		`notify = ["say", "done"]`,
		`model_provider = "proxy"`,
		`model_catalog_json = "cc-switch-model-catalog.json"`,
		`service_tier = "default"`,
		"",
		"[model_providers.proxy]",
		`base_url = "https://openai.proxy.test/v1"`,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), []byte(userCodexConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "cc-switch-model-catalog.json"), []byte(`{"models":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "plugins", "cache", "sample", "plugin.txt"), "plugin cache")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "plugins", "data", "sample", "state.txt"), "plugin state")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "plugins", ".plugin-appserver", "codex"), "plugin server")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "skills", "caveman", "SKILL.md"), "---\nname: caveman\n---\nCaveman mode\n")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "skills", "grill-me", "SKILL.md"), "---\nname: grill-me\n---\nGrill me\n")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "skills", "broken-frontmatter", "SKILL.md"), "name: broken-frontmatter\n---\nBroken\n")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "skills", ".system", "hidden", "SKILL.md"), "---\nname: hidden\n---\nHidden\n")
	if err := os.MkdirAll(filepath.Join(userCodexHome, "skills", "invalid"), 0o755); err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	cwd := t.TempDir()
	agentsPath := filepath.Join(cwd, "AGENTS.md")
	if err := os.WriteFile(agentsPath, []byte("existing guidance\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            cwd,
		ExtraSkills: []ProviderSkillBundle{
			{
				Name: "app-factory",
				Files: map[string]string{
					"SKILL.md":                        "---\nname: app-factory\n---\nmention://workspace-app-factory/create\n",
					"references/manifest-contract.md": "manifest contract",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	content, err := os.ReadFile(agentsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "existing guidance\n" {
		t.Fatalf("cwd AGENTS.md content = %q, want user guidance unchanged", string(content))
	}
	codexHome := envValue(prepared.Env, "CODEX_HOME")
	if codexHome == "" {
		t.Fatalf("prepared env = %#v, want CODEX_HOME", prepared.Env)
	}
	codexAgents, err := os.ReadFile(filepath.Join(codexHome, "AGENTS.md"))
	if err != nil {
		t.Fatalf("codex AGENTS.md missing: %v", err)
	}
	const maxCodexAgentsChars = 6500
	if count := utf8.RuneCountInString(string(codexAgents)); count > maxCodexAgentsChars {
		t.Fatalf("codex AGENTS.md chars = %d, want <= %d", count, maxCodexAgentsChars)
	}
	if !strings.Contains(string(codexAgents), "`tutti <scope> --help`") ||
		!strings.Contains(string(codexAgents), "App id mapping") {
		t.Fatalf("codex AGENTS.md content = %q", string(codexAgents))
	}
	if strings.Contains(string(codexAgents), `Skill(skill="issue-manager", args="<full mention URI>")`) {
		t.Fatalf("codex AGENTS.md content = %q, want provider-neutral mention routing", string(codexAgents))
	}
	if strings.Contains(string(codexAgents), "CODEX_HOME/skills/<skill>/SKILL.md") ||
		strings.Contains(string(codexAgents), "`workspace-app/SKILL.md`") {
		t.Fatalf("codex AGENTS.md content = %q, want no guessed materialized skill paths", string(codexAgents))
	}
	if !strings.Contains(string(codexAgents), "# Host App Context") ||
		!strings.Contains(string(codexAgents), "Images/videos: use Markdown") ||
		!strings.Contains(string(codexAgents), "Native image generation results are rendered directly from `imageGeneration` tool output as generated-image artifacts.") ||
		!strings.Contains(string(codexAgents), "do not repeat generated images as Markdown image tags") ||
		strings.Contains(string(codexAgents), "Generated/edited image output: final response must include Markdown image tag.") ||
		!strings.Contains(string(codexAgents), "Prefer `$CODEX_HOME/generated_images/`") ||
		!strings.Contains(string(codexAgents), "never use unverified sandbox path") ||
		!strings.Contains(string(codexAgents), "No inline base64.") ||
		!strings.Contains(string(codexAgents), "use `[filename](/abs/path)` Markdown links") ||
		!strings.Contains(string(codexAgents), "No relative paths, line suffixes") ||
		!strings.Contains(string(codexAgents), "Web URLs: Markdown links") {
		t.Fatalf("codex AGENTS.md content = %q, want host app rendering guidance", string(codexAgents))
	}
	if _, err := os.Lstat(filepath.Join(codexHome, "auth.json")); err != nil {
		t.Fatalf("codex auth not exposed: %v", err)
	}
	modelsCachePath := filepath.Join(codexHome, "models_cache.json")
	modelsCacheInfo, err := os.Lstat(modelsCachePath)
	if err != nil {
		t.Fatalf("codex models cache not exposed: %v", err)
	}
	if modelsCacheInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("codex models cache should be a symlink, got mode %v", modelsCacheInfo.Mode())
	}
	modelsCacheTarget, err := os.Readlink(modelsCachePath)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(userCodexHome, "models_cache.json"); modelsCacheTarget != want {
		t.Fatalf("codex models cache symlink target = %q, want %q", modelsCacheTarget, want)
	}
	if err := os.WriteFile(modelsCachePath, []byte(`{"models":["refreshed"]}`), 0o600); err != nil {
		t.Fatalf("refresh run-scoped codex models cache: %v", err)
	}
	sharedModelsCache, err := os.ReadFile(filepath.Join(userCodexHome, "models_cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(sharedModelsCache), `{"models":["refreshed"]}`; got != want {
		t.Fatalf("shared codex models cache = %q, want %q", got, want)
	}
	secondPrepared, err := newTestPreparer(t.TempDir()).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-2",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("prepare second Codex session: %v", err)
	}
	secondModelsCachePath := filepath.Join(envValue(secondPrepared.Env, "CODEX_HOME"), "models_cache.json")
	secondModelsCache, err := os.ReadFile(secondModelsCachePath)
	if err != nil {
		t.Fatalf("read second session Codex models cache: %v", err)
	}
	if got, want := string(secondModelsCache), `{"models":["refreshed"]}`; got != want {
		t.Fatalf("second session Codex models cache = %q, want %q", got, want)
	}
	catalogLink, err := os.Lstat(filepath.Join(codexHome, "cc-switch-model-catalog.json"))
	if err != nil {
		t.Fatalf("codex model catalog not exposed: %v", err)
	}
	if catalogLink.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("codex model catalog should be a symlink, got mode %v", catalogLink.Mode())
	}
	for _, rel := range []string{
		filepath.Join("plugins", "cache"),
		filepath.Join("plugins", "data"),
		filepath.Join("plugins", ".plugin-appserver"),
	} {
		info, err := os.Lstat(filepath.Join(codexHome, rel))
		if err != nil {
			t.Fatalf("codex plugin state %s not exposed: %v", rel, err)
		}
		if info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("codex plugin state %s should be exposed as symlink", rel)
		}
	}
	if _, err := os.Stat(filepath.Join(cwd, ".tutti-codex-root")); !os.IsNotExist(err) {
		t.Fatalf("codex preparer should not create project root marker in cwd, err = %v", err)
	}
	codexConfigPath := filepath.Join(codexHome, "config.toml")
	codexConfigInfo, err := os.Lstat(codexConfigPath)
	if err != nil {
		t.Fatalf("codex config missing: %v", err)
	}
	if codexConfigInfo.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("codex config should be a session-scoped file, got symlink")
	}
	codexConfig, err := os.ReadFile(codexConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(codexConfig), codexProjectRootMarkersDisabledConfig) ||
		!strings.Contains(string(codexConfig), `notify = ["say", "done"]`) ||
		!strings.Contains(string(codexConfig), `model_provider = "proxy"`) ||
		!strings.Contains(string(codexConfig), "[model_providers.proxy]") {
		t.Fatalf("codex config = %q, want copied user config with project root markers disabled", string(codexConfig))
	}
	if strings.Contains(string(codexConfig), `service_tier = "default"`) {
		t.Fatalf("codex config = %q, want unsupported default service_tier removed", string(codexConfig))
	}
	userConfigAfterPrepare, err := os.ReadFile(filepath.Join(userCodexHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(userConfigAfterPrepare) != userCodexConfig {
		t.Fatalf("user codex config was modified: %q", string(userConfigAfterPrepare))
	}
	cavemanPath := filepath.Join(codexHome, "skills", "caveman")
	cavemanInfo, err := os.Lstat(cavemanPath)
	if err != nil {
		t.Fatalf("caveman skill not exposed: %v", err)
	}
	if cavemanInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("caveman skill mode = %v, want symlink", cavemanInfo.Mode())
	}
	cavemanTarget, err := os.Readlink(cavemanPath)
	if err != nil {
		t.Fatal(err)
	}
	if cavemanTarget != filepath.Join(userCodexHome, "skills", "caveman") {
		t.Fatalf("caveman symlink target = %q", cavemanTarget)
	}
	cavemanSkill, err := os.ReadFile(filepath.Join(cavemanPath, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cavemanSkill), "Caveman mode") {
		t.Fatalf("caveman skill = %q", string(cavemanSkill))
	}
	grillMeInfo, err := os.Lstat(filepath.Join(codexHome, "skills", "grill-me"))
	if err != nil {
		t.Fatalf("grill-me skill not exposed: %v", err)
	}
	if grillMeInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("grill-me skill mode = %v, want symlink", grillMeInfo.Mode())
	}
	if _, err := os.Lstat(filepath.Join(codexHome, "skills", ".system")); !os.IsNotExist(err) {
		t.Fatalf("hidden system skill exposed, err = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(codexHome, "skills", "invalid")); !os.IsNotExist(err) {
		t.Fatalf("invalid skill exposed, err = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(codexHome, "skills", "broken-frontmatter")); !os.IsNotExist(err) {
		t.Fatalf("broken-frontmatter skill exposed, err = %v", err)
	}
	skill, err := os.ReadFile(filepath.Join(codexHome, "skills", "tutti-cli", "SKILL.md"))
	if err != nil {
		t.Fatalf("tutti skill missing: %v", err)
	}
	if !strings.Contains(string(skill), "`tutti <scope> --help`") ||
		!strings.Contains(string(skill), "this skill's `command-guide.md`") ||
		!strings.Contains(string(skill), "mention://agent-target") ||
		!strings.Contains(string(skill), "handed off, not absorbed") {
		t.Fatalf("skill content = %q", string(skill))
	}
	commandGuideReference, err := os.ReadFile(filepath.Join(codexHome, "skills", "tutti-cli", commandGuideReferencePath))
	if err != nil {
		t.Fatalf("tutti command guide reference missing: %v", err)
	}
	if !strings.Contains(string(commandGuideReference), "tutti agent sessions") ||
		!strings.Contains(string(commandGuideReference), "tutti issue get --issue-id <issue-id> --json") {
		t.Fatalf("tutti command guide reference = %q", string(commandGuideReference))
	}
	if !strings.Contains(string(skill), "local Tutti daemon") ||
		!strings.Contains(string(skill), "localhost/IPC") ||
		!strings.Contains(string(skill), "execution environment") ||
		!strings.Contains(string(skill), "Issue execution sequencing belongs to `$issue-manager`") {
		t.Fatalf("skill content = %q, want local daemon environment guidance", string(skill))
	}
	if !strings.HasPrefix(string(skill), "---\nname: tutti-cli\n") {
		t.Fatalf("skill missing YAML frontmatter: %q", string(skill))
	}
	if strings.Contains(string(skill), "### Mention-driven issue handoff") {
		t.Fatalf("tutti skill should stay reference-focused: %q", string(skill))
	}
	issueSkill, err := os.ReadFile(filepath.Join(codexHome, "skills", "issue-manager", "SKILL.md"))
	if err != nil {
		t.Fatalf("issue-manager skill missing: %v", err)
	}
	if !strings.Contains(string(issueSkill), "mention://workspace-issue") ||
		!strings.Contains(string(issueSkill), "mode=breakdown") ||
		!strings.Contains(string(issueSkill), "command-guide.md") ||
		!strings.Contains(string(issueSkill), "## Inspection Mode") ||
		!strings.Contains(string(issueSkill), "Create the run yourself before doing the work") ||
		!strings.Contains(string(issueSkill), "tutti issue run create --issue-id <issue-id> --agent-provider codex --json") ||
		!strings.Contains(string(issueSkill), "with child tasks execute them in order") ||
		!strings.Contains(string(issueSkill), "Complete that same run") ||
		!strings.Contains(string(issueSkill), "Do not edit code, do not execute the task, and do not create or complete runs in breakdown mode") ||
		!strings.Contains(string(issueSkill), "**Done when:**") {
		t.Fatalf("issue-manager skill content = %q", string(issueSkill))
	}
	if strings.Contains(string(issueSkill), "--agent-session-id session-1") {
		t.Fatalf("issue-manager skill should not hard-code explicit session ids: %q", string(issueSkill))
	}
	if envValue(prepared.Env, "TUTTI_AGENT_PROVIDER") != "codex" {
		t.Fatalf("prepared env = %#v, want TUTTI_AGENT_PROVIDER", prepared.Env)
	}
	if envValue(prepared.Env, "TUTTI_AGENT_TARGET_ID") != "local:codex" {
		t.Fatalf("prepared env = %#v, want TUTTI_AGENT_TARGET_ID", prepared.Env)
	}
	if envValue(prepared.Env, "TUTTI_AGENT_CWD") != cwd {
		t.Fatalf("prepared env = %#v, want TUTTI_AGENT_CWD", prepared.Env)
	}
	workspaceAppSkill, err := os.ReadFile(filepath.Join(codexHome, "skills", "workspace-app", "SKILL.md"))
	if err != nil {
		t.Fatalf("workspace-app skill missing: %v", err)
	}
	if !strings.Contains(string(workspaceAppSkill), "mention://workspace-app") ||
		!strings.Contains(string(workspaceAppSkill), "appId") ||
		!strings.Contains(string(workspaceAppSkill), "use injected `$tutti-cli`") ||
		!strings.Contains(string(workspaceAppSkill), "command-guide.md") ||
		!strings.Contains(string(workspaceAppSkill), "Do not derive filesystem paths from the plugin directory, plugin name, or skill slug") ||
		!strings.Contains(string(workspaceAppSkill), "inherit the caller agent session working directory") {
		t.Fatalf("workspace-app skill content = %q", string(workspaceAppSkill))
	}
	if strings.Contains(string(workspaceAppSkill), "turn-resources") || strings.Contains(string(workspaceAppSkill), "--image <localPath>") {
		t.Fatalf("workspace-app skill owns agent image handoff guidance: %q", string(workspaceAppSkill))
	}
	if strings.Contains(string(workspaceAppSkill), "read the materialized sibling `tutti-cli/SKILL.md`") {
		t.Fatalf("workspace-app skill should not ask agents to guess sibling skill paths: %q", string(workspaceAppSkill))
	}
	if strings.Contains(string(workspaceAppSkill), "plugin root `tutti-cli/SKILL.md`") {
		t.Fatalf("workspace-app skill should not anchor agents to plugin-root paths: %q", string(workspaceAppSkill))
	}
	appFactorySkill, err := os.ReadFile(filepath.Join(codexHome, "skills", "app-factory", "SKILL.md"))
	if err != nil {
		t.Fatalf("app-factory skill missing: %v", err)
	}
	if !strings.Contains(string(appFactorySkill), "mention://workspace-app-factory/create") {
		t.Fatalf("app-factory skill content = %q", string(appFactorySkill))
	}
	appFactoryReference, err := os.ReadFile(filepath.Join(codexHome, "skills", "app-factory", "references", "manifest-contract.md"))
	if err != nil {
		t.Fatalf("app-factory reference missing: %v", err)
	}
	if string(appFactoryReference) != "manifest contract" {
		t.Fatalf("app-factory reference = %q", string(appFactoryReference))
	}
	rules, err := os.ReadFile(filepath.Join(codexHome, "rules", "default.rules"))
	if err != nil {
		t.Fatalf("codex approval rules missing: %v", err)
	}
	if !strings.Contains(string(rules), `prefix_rule(pattern=["tutti"], decision="allow")`) {
		t.Fatalf("codex approval rules = %q, want tutti allow rule", string(rules))
	}
	runtimeRoot, err := LocalStore{StateDir: stateDir}.RuntimeRoot("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(runtimeRoot, SidecarManifestFileName)
	if _, err := os.Stat(manifestPath); err != nil {
		t.Fatalf("manifest missing: %v", err)
	}
	manifestContent, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(manifestContent), `"workspaceId"`) {
		t.Fatalf("manifest leaks workspace id: %s", manifestContent)
	}
	if envValue(prepared.Env, "TUTTI_WORKSPACE_ID") != "workspace-1" {
		t.Fatalf("prepared env = %#v, want workspace id", prepared.Env)
	}
}

func TestExposeUserCodexModelsCacheSharesFirstRefreshAcrossSessions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	firstCodexHome := t.TempDir()
	if err := exposeUserCodexModelsCache(firstCodexHome, userCodexHome); err != nil {
		t.Fatal(err)
	}

	firstCachePath := filepath.Join(firstCodexHome, "models_cache.json")
	info, err := os.Lstat(firstCachePath)
	if err != nil {
		t.Fatalf("first session models cache link missing: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("first session models cache mode = %v, want symlink", info.Mode())
	}
	if _, err := os.Stat(filepath.Join(userCodexHome, "models_cache.json")); !os.IsNotExist(err) {
		t.Fatalf("shared models cache should not exist before first provider refresh, err = %v", err)
	}
	if err := os.WriteFile(firstCachePath, []byte(`{"models":["first-refresh"]}`), 0o600); err != nil {
		t.Fatalf("write first session models cache: %v", err)
	}

	secondCodexHome := t.TempDir()
	if err := exposeUserCodexModelsCache(secondCodexHome, userCodexHome); err != nil {
		t.Fatal(err)
	}
	secondCache, err := os.ReadFile(filepath.Join(secondCodexHome, "models_cache.json"))
	if err != nil {
		t.Fatalf("read second session models cache: %v", err)
	}
	if got, want := string(secondCache), `{"models":["first-refresh"]}`; got != want {
		t.Fatalf("second session models cache = %q, want %q", got, want)
	}
}

func TestDefaultPreparerCodexRefreshesRunConfigFromCurrentUserConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	userConfigPath := filepath.Join(userCodexHome, "config.toml")
	if err := os.WriteFile(userConfigPath, []byte("model = \"gpt-5.6-sol\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	input := PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            t.TempDir(),
	}
	first, err := newTestPreparer(stateDir).Prepare(t.Context(), input)
	if err != nil {
		t.Fatalf("first Prepare() error = %v", err)
	}
	codexConfigPath := filepath.Join(envValue(first.Env, "CODEX_HOME"), "config.toml")
	firstConfig, err := os.ReadFile(codexConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(firstConfig), `model = "gpt-5.6-sol"`) {
		t.Fatalf("first run config = %q, want initial user model", string(firstConfig))
	}

	if err := os.WriteFile(userConfigPath, []byte(strings.Join([]string{
		`model_provider = "custom"`,
		`model = "glm-5"`,
		"",
		"[model_providers.custom]",
		`base_url = "https://proxy.example/v1"`,
		"",
	}, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := newTestPreparer(stateDir).Prepare(t.Context(), input)
	if err != nil {
		t.Fatalf("second Prepare() error = %v", err)
	}
	if got, want := envValue(second.Env, "CODEX_HOME"), envValue(first.Env, "CODEX_HOME"); got != want {
		t.Fatalf("second CODEX_HOME = %q, want stable run home %q", got, want)
	}
	secondConfig, err := os.ReadFile(codexConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(secondConfig), `model_provider = "custom"`) ||
		!strings.Contains(string(secondConfig), `model = "glm-5"`) ||
		strings.Contains(string(secondConfig), `model = "gpt-5.6-sol"`) {
		t.Fatalf("second run config = %q, want refreshed custom provider config", string(secondConfig))
	}
	if !strings.Contains(string(secondConfig), codexProjectRootMarkersDisabledConfig) {
		t.Fatalf("second run config = %q, want runtime session overlay reapplied", string(secondConfig))
	}
}

func TestDefaultPreparerCodexRemovesRunConfigWhenUserConfigDisappears(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	userConfigPath := filepath.Join(userCodexHome, "config.toml")
	if err := os.WriteFile(userConfigPath, []byte("model = \"glm-5\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	input := PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            t.TempDir(),
	}
	first, err := newTestPreparer(stateDir).Prepare(t.Context(), input)
	if err != nil {
		t.Fatalf("first Prepare() error = %v", err)
	}
	codexConfigPath := filepath.Join(envValue(first.Env, "CODEX_HOME"), "config.toml")
	if err := os.Remove(userConfigPath); err != nil {
		t.Fatal(err)
	}
	if _, err := newTestPreparer(stateDir).Prepare(t.Context(), input); err != nil {
		t.Fatalf("second Prepare() error = %v", err)
	}
	config, err := os.ReadFile(codexConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), `model = "glm-5"`) {
		t.Fatalf("second run config retained removed user model: %q", string(config))
	}
	if !strings.Contains(string(config), codexProjectRootMarkersDisabledConfig) {
		t.Fatalf("second run config = %q, want runtime session config", string(config))
	}
}

func TestExposeUserCodexModelsCacheDropsUnfencedRunCache(t *testing.T) {
	userCodexHome := filepath.Join(t.TempDir(), ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), []byte(`model_provider = "custom"`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "models_cache.json"), []byte(`{"models":["shared-stale"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	codexHome := t.TempDir()
	target := filepath.Join(codexHome, "models_cache.json")
	if err := os.WriteFile(target, []byte(`{"models":["session-local"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := exposeUserCodexModelsCache(codexHome, userCodexHome); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("run cache mode = %v, want authority-scoped shared-cache symlink", info.Mode())
	}
	if _, err := os.Stat(filepath.Join(userCodexHome, "models_cache.json")); !os.IsNotExist(err) {
		t.Fatalf("unfenced shared cache should be removed, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(userCodexHome, codexModelsCacheAuthorityFile)); err != nil {
		t.Fatalf("models cache authority fence missing: %v", err)
	}
}

func TestExposeUserCodexModelsCacheInvalidatesWhenGlobalConfigChanges(t *testing.T) {
	userCodexHome := filepath.Join(t.TempDir(), ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(userCodexHome, "config.toml")
	if err := os.WriteFile(configPath, []byte("model_provider = \"first\"\nmodel = \"first-model\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	firstCodexHome := t.TempDir()
	if err := exposeUserCodexModelsCache(firstCodexHome, userCodexHome); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(firstCodexHome, "models_cache.json"), []byte(`{"models":["first"]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(configPath, []byte("model_provider = \"second\"\nmodel = \"second-model\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	secondCodexHome := t.TempDir()
	if err := exposeUserCodexModelsCache(secondCodexHome, userCodexHome); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(userCodexHome, "models_cache.json")); !os.IsNotExist(err) {
		t.Fatalf("cache from previous global config should be removed, err = %v", err)
	}
	if info, err := os.Lstat(filepath.Join(secondCodexHome, "models_cache.json")); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("second run cache link missing after config invalidation: info=%#v err=%v", info, err)
	}
}

func TestExposeUserCodexModelsCacheInvalidatesWhenGlobalCatalogChanges(t *testing.T) {
	home := t.TempDir()
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(userCodexHome, "config.toml")
	catalogPath := filepath.Join(userCodexHome, "catalog.json")
	if err := os.WriteFile(configPath, []byte("model_provider = \"first\"\nmodel_catalog_json = \"catalog.json\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(catalogPath, []byte(`{"models":[{"slug":"first"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	firstCodexHome := t.TempDir()
	if err := exposeUserCodexModelsCache(firstCodexHome, userCodexHome); err != nil {
		t.Fatal(err)
	}
	firstCache := filepath.Join(firstCodexHome, "models_cache.json")
	if err := os.WriteFile(firstCache, []byte(`{"models":["first"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	firstFence, err := os.ReadFile(filepath.Join(userCodexHome, codexModelsCacheAuthorityFile))
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(catalogPath, []byte(`{"models":[{"slug":"second"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	secondCodexHome := t.TempDir()
	if err := exposeUserCodexModelsCache(secondCodexHome, userCodexHome); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(userCodexHome, "models_cache.json")); !os.IsNotExist(err) {
		t.Fatalf("cache from previous global catalog should be removed, err = %v", err)
	}
	secondFence, err := os.ReadFile(filepath.Join(userCodexHome, codexModelsCacheAuthorityFile))
	if err != nil {
		t.Fatal(err)
	}
	if string(firstFence) == string(secondFence) {
		t.Fatalf("models cache authority fence did not change after global catalog update")
	}
	if info, err := os.Lstat(filepath.Join(secondCodexHome, "models_cache.json")); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("second run cache link missing after invalidation: info=%#v err=%v", info, err)
	}
}

func TestDefaultPreparerCodexExposesRelativeModelCatalogJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "auth.json"), []byte(`{"token":"test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	catalogName := "cc-switch-model-catalog.json"
	catalogBody := `{"models":[{"slug":"gpt-5.5","display_name":"gpt-5.5"}]}`
	if err := os.WriteFile(filepath.Join(userCodexHome, catalogName), []byte(catalogBody), 0o600); err != nil {
		t.Fatal(err)
	}
	userCodexConfig := strings.Join([]string{
		`model_catalog_json = "cc-switch-model-catalog.json"`,
		`model_provider = "proxy"`,
		"",
		"[model_providers.proxy]",
		`base_url = "https://openai.proxy.test/v1"`,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), []byte(userCodexConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	cwd := t.TempDir()
	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-catalog",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	codexHome := envValue(prepared.Env, "CODEX_HOME")
	if codexHome == "" {
		t.Fatalf("prepared env = %#v, want CODEX_HOME", prepared.Env)
	}
	sandboxCatalog := filepath.Join(codexHome, catalogName)
	info, err := os.Lstat(sandboxCatalog)
	if err != nil {
		t.Fatalf("relative model catalog not exposed into sandbox: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("sandbox model catalog mode = %v, want symlink", info.Mode())
	}
	linkTarget, err := os.Readlink(sandboxCatalog)
	if err != nil {
		t.Fatal(err)
	}
	if linkTarget != filepath.Join(userCodexHome, catalogName) {
		t.Fatalf("sandbox catalog symlink target = %q, want user catalog", linkTarget)
	}
	got, err := os.ReadFile(sandboxCatalog)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != catalogBody {
		t.Fatalf("sandbox catalog body = %q, want %q", string(got), catalogBody)
	}
}

func TestDefaultPreparerCodexUserSkillNameWinsBeforeTuttiInjection(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "skills", "tutti-cli", "SKILL.md"), "---\nname: tutti-cli\n---\nUser tutti skill\n")

	stateDir := t.TempDir()
	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	codexHome := envValue(prepared.Env, "CODEX_HOME")
	userSkillPath := filepath.Join(codexHome, "skills", "tutti-cli")
	userSkillInfo, err := os.Lstat(userSkillPath)
	if err != nil {
		t.Fatalf("user tutti-cli skill not exposed: %v", err)
	}
	if userSkillInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("user tutti-cli skill mode = %v, want symlink", userSkillInfo.Mode())
	}
	userSkill, err := os.ReadFile(filepath.Join(userSkillPath, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(userSkill), "User tutti skill") {
		t.Fatalf("user tutti-cli skill = %q", string(userSkill))
	}
	tuttiSkill, err := os.ReadFile(filepath.Join(codexHome, "skills", "tutti-cli-tutti", "SKILL.md"))
	if err != nil {
		t.Fatalf("tutti fallback skill missing: %v", err)
	}
	if !strings.Contains(string(tuttiSkill), "`tutti <scope> --help`") ||
		!strings.Contains(string(tuttiSkill), "this skill's `command-guide.md`") {
		t.Fatalf("tutti fallback skill = %q", string(tuttiSkill))
	}
	tuttiReference, err := os.ReadFile(filepath.Join(codexHome, "skills", "tutti-cli-tutti", commandGuideReferencePath))
	if err != nil {
		t.Fatalf("tutti fallback command guide reference missing: %v", err)
	}
	if !strings.Contains(string(tuttiReference), "tutti agent sessions") {
		t.Fatalf("tutti fallback command guide reference = %q", string(tuttiReference))
	}
}

func TestDefaultPreparerCodexWritesProjectRootMarkersDisabledConfigWithoutUserConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	stateDir := t.TempDir()
	cwd := t.TempDir()
	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	if _, err := os.Stat(filepath.Join(cwd, ".tutti-codex-root")); !os.IsNotExist(err) {
		t.Fatalf("codex preparer should not create project root marker in cwd, err = %v", err)
	}
	codexHome := envValue(prepared.Env, "CODEX_HOME")
	codexConfig, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		t.Fatalf("codex config missing: %v", err)
	}
	config := string(codexConfig)
	if !strings.Contains(config, codexProjectRootMarkersDisabledConfig) ||
		!strings.Contains(config, "[tutti]") ||
		!strings.Contains(config, `conversationDetailMode = "coding"`) ||
		strings.Contains(config, "### Non-technical UI") {
		t.Fatalf("codex config = %q, want project root markers disabled and Tutti coding marker only", config)
	}
}

func TestDefaultPreparerCodexWritesGeneralConversationDetailModeToSessionConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	stateDir := t.TempDir()
	cwd := t.TempDir()
	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:            "workspace-1",
		AgentSessionID:         "session-1",
		Provider:               "codex",
		Cwd:                    cwd,
		ConversationDetailMode: "general",
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	codexHome := envValue(prepared.Env, "CODEX_HOME")
	codexConfig, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		t.Fatalf("codex config missing: %v", err)
	}
	config := string(codexConfig)
	if !strings.Contains(config, "[tutti]") ||
		!strings.Contains(config, `conversationDetailMode = "general"`) ||
		!strings.Contains(config, `developer_instructions =`) ||
		!strings.Contains(config, "### Non-technical UI") ||
		!strings.Contains(config, "don't name bash commands you're running") ||
		!strings.Contains(config, "focus on outputs") {
		t.Fatalf("codex config = %q, want Tutti general marker and non-technical UI developer instructions", config)
	}
}

func TestCodexConfigWithTuttiConversationDetailModeUpdatesExistingMarker(t *testing.T) {
	input := strings.Join([]string{
		`project_root_markers = []`,
		"",
		"[tutti]",
		`conversationDetailMode = "coding"`,
		"",
		"[model_providers.proxy]",
		`base_url = "https://openai.proxy.test/v1"`,
	}, "\n")

	next, changed := codexConfigWithTuttiConversationDetailMode(input, "general")
	if !changed {
		t.Fatalf("codexConfigWithTuttiConversationDetailMode changed = false, want true")
	}
	if !strings.Contains(next, `[tutti]`) ||
		!strings.Contains(next, `conversationDetailMode = "general"`) ||
		strings.Contains(next, `conversationDetailMode = "coding"`) ||
		!strings.Contains(next, "[model_providers.proxy]") {
		t.Fatalf("merged config = %q, want updated Tutti conversation detail mode marker", next)
	}
}

func TestCodexConfigWithConversationDetailModeInstructionsAppendsExistingDeveloperInstructions(t *testing.T) {
	input := strings.Join([]string{
		`developer_instructions = "Existing guidance."`,
		`model = "gpt-5.5"`,
		"",
		"[model_providers.proxy]",
		`base_url = "https://openai.proxy.test/v1"`,
	}, "\n")

	next, changed := codexConfigWithConversationDetailModeInstructions(input, "general")
	if !changed {
		t.Fatalf("codexConfigWithConversationDetailModeInstructions changed = false, want true")
	}
	if !strings.Contains(next, "Existing guidance.") ||
		!strings.Contains(next, "### Non-technical UI") ||
		!strings.Contains(next, "[model_providers.proxy]") {
		t.Fatalf("merged config = %q, want existing developer instructions plus non-technical UI", next)
	}
}

func TestCodexConfigWithConversationDetailModeInstructionsRemovesManagedInstructionsForCoding(t *testing.T) {
	input := strings.Join([]string{
		`developer_instructions = ` + strconv.Quote("Existing guidance.\n\n"+nonTechnicalUIConversationDetailModeInstructions),
		`model = "gpt-5.5"`,
		"",
		"[tutti]",
		`conversationDetailMode = "general"`,
	}, "\n")

	next, changed := codexConfigWithConversationDetailModeInstructions(input, "coding")
	if !changed {
		t.Fatalf("codexConfigWithConversationDetailModeInstructions changed = false, want true")
	}
	if !strings.Contains(next, `developer_instructions = "Existing guidance."`) ||
		strings.Contains(next, "### Non-technical UI") ||
		!strings.Contains(next, "[tutti]") {
		t.Fatalf("merged config = %q, want existing developer instructions without non-technical UI", next)
	}
}

func TestCodexConfigWithConversationDetailModeInstructionsRemovesEmptyManagedKeyForCoding(t *testing.T) {
	input := strings.Join([]string{
		`developer_instructions = ` + strconv.Quote(nonTechnicalUIConversationDetailModeInstructions),
		`model = "gpt-5.5"`,
		"",
		"[tutti]",
		`conversationDetailMode = "general"`,
	}, "\n")

	next, changed := codexConfigWithConversationDetailModeInstructions(input, "coding")
	if !changed {
		t.Fatalf("codexConfigWithConversationDetailModeInstructions changed = false, want true")
	}
	if strings.Contains(next, `developer_instructions =`) ||
		strings.Contains(next, "### Non-technical UI") ||
		!strings.Contains(next, `model = "gpt-5.5"`) ||
		!strings.Contains(next, "[tutti]") {
		t.Fatalf("merged config = %q, want managed developer_instructions key removed", next)
	}
}

func TestCodexConfigWithProjectRootMarkersDisabledReplacesExistingRootMarkers(t *testing.T) {
	input := strings.Join([]string{
		`project_root_markers = [".git"]`,
		`model = "gpt-5.5"`,
		"",
		"[model_providers.proxy]",
		`base_url = "https://openai.proxy.test/v1"`,
	}, "\n")

	next, changed := codexConfigWithProjectRootMarkersDisabled(input)
	if !changed {
		t.Fatalf("codexConfigWithProjectRootMarkersDisabled changed = false, want true")
	}
	if !strings.Contains(next, codexProjectRootMarkersDisabledConfig) ||
		strings.Contains(next, `project_root_markers = [".git"]`) ||
		!strings.Contains(next, "[model_providers.proxy]") {
		t.Fatalf("merged config = %q", next)
	}
}

func TestCodexConfigWithProjectRootMarkersDisabledReplacesMultilineRootMarkers(t *testing.T) {
	input := strings.Join([]string{
		`project_root_markers = [ # allow project-local config discovery`,
		`  ".git",`,
		`  "path]with-bracket",`,
		`]`,
		`model = "gpt-5.5"`,
		"",
		"[model_providers.proxy]",
		`base_url = "https://openai.proxy.test/v1"`,
	}, "\n")

	next, changed := codexConfigWithProjectRootMarkersDisabled(input)
	if !changed {
		t.Fatalf("codexConfigWithProjectRootMarkersDisabled changed = false, want true")
	}
	if strings.Count(next, "project_root_markers") != 1 ||
		strings.Contains(next, `".git"`) ||
		strings.Contains(next, `"path]with-bracket"`) ||
		strings.Contains(next, "\n]\n") ||
		!strings.Contains(next, codexProjectRootMarkersDisabledConfig) ||
		!strings.Contains(next, `model = "gpt-5.5"`) ||
		!strings.Contains(next, "[model_providers.proxy]") {
		t.Fatalf("merged config = %q", next)
	}
}

func TestCodexConfigWithProjectRootMarkersDisabledKeepsExistingEmptyMarkers(t *testing.T) {
	input := codexProjectRootMarkersDisabledConfig + "\n\n" + `[model_providers.proxy]`

	next, changed := codexConfigWithProjectRootMarkersDisabled(input)
	if changed {
		t.Fatalf("codexConfigWithProjectRootMarkersDisabled changed = true, want false")
	}
	if next != input {
		t.Fatalf("merged config = %q, want original", next)
	}
}

func TestCodexConfigWithSupportedServiceTierSanitizesLegacyValues(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "removes default",
			in: strings.Join([]string{
				`model = "gpt-5.5"`,
				`service_tier = "default"`,
				`model_reasoning_effort = "high"`,
			}, "\n"),
			want: strings.Join([]string{
				`model = "gpt-5.5"`,
				`model_reasoning_effort = "high"`,
			}, "\n"),
		},
		{
			name: "normalizes priority",
			in: strings.Join([]string{
				`service_tier = "priority"`,
				`model = "gpt-5.5"`,
			}, "\n"),
			want: strings.Join([]string{
				`service_tier = "fast"`,
				`model = "gpt-5.5"`,
			}, "\n"),
		},
		{
			name: "keeps flex",
			in: strings.Join([]string{
				`service_tier = "flex"`,
				`model = "gpt-5.5"`,
			}, "\n"),
			want: strings.Join([]string{
				`service_tier = "flex"`,
				`model = "gpt-5.5"`,
			}, "\n"),
		},
		{
			name: "ignores nested config",
			in: strings.Join([]string{
				`model = "gpt-5.5"`,
				"",
				`[mcp_servers.example]`,
				`service_tier = "default"`,
			}, "\n"),
			want: strings.Join([]string{
				`model = "gpt-5.5"`,
				"",
				`[mcp_servers.example]`,
				`service_tier = "default"`,
			}, "\n"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := codexConfigWithSupportedServiceTier(tt.in)
			if got != tt.want {
				t.Fatalf("codexConfigWithSupportedServiceTier() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDefaultPreparerUsesStateRootCLIShimName(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	stateDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateDir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "bin", "tutti-dev"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()

	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	codexHome := envValue(prepared.Env, "CODEX_HOME")
	content, err := os.ReadFile(filepath.Join(codexHome, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "`tutti-dev <scope> --help`") ||
		!strings.Contains(string(content), "App id mapping") {
		t.Fatalf("codex AGENTS.md content = %q, want tutti-dev command", string(content))
	}
	pathEnv := envValue(prepared.Env, "PATH")
	wantPrefix := filepath.Join(stateDir, "bin") + string(os.PathListSeparator)
	if !strings.HasPrefix(pathEnv, wantPrefix) {
		t.Fatalf("PATH = %q, want prefix %q", pathEnv, wantPrefix)
	}
	rules, err := os.ReadFile(filepath.Join(codexHome, "rules", "default.rules"))
	if err != nil {
		t.Fatalf("codex approval rules missing: %v", err)
	}
	if !strings.Contains(string(rules), `prefix_rule(pattern=["tutti-dev"], decision="allow")`) {
		t.Fatalf("codex approval rules = %q, want tutti-dev allow rule", string(rules))
	}
}

func TestDefaultPreparerCleanupRemovesManagedBlocksAndRuntimeRoot(t *testing.T) {
	stateDir := t.TempDir()
	cwd := t.TempDir()
	agentsPath := filepath.Join(cwd, "AGENTS.md")
	if err := os.WriteFile(agentsPath, []byte("user guidance\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	preparer := newTestPreparer(stateDir)
	_, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	if err := preparer.Cleanup(t.Context(), CleanupInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatalf("Cleanup() error = %v", err)
	}
	content, err := os.ReadFile(agentsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "BEGIN TUTTI-RUNTIME") || !strings.Contains(string(content), "user guidance") {
		t.Fatalf("cleanup content = %q", string(content))
	}
	runtimeRoot, err := LocalStore{StateDir: stateDir}.RuntimeRoot("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(runtimeRoot); !os.IsNotExist(err) {
		t.Fatalf("runtime root still exists, err = %v", err)
	}
}

func TestDefaultPreparerCodexUsesSessionScopedInstructionFile(t *testing.T) {
	stateDir := t.TempDir()
	cwd := t.TempDir()
	preparer := newTestPreparer(stateDir)
	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	agentsPath := filepath.Join(cwd, "AGENTS.md")
	if _, err := os.Stat(agentsPath); !os.IsNotExist(err) {
		t.Fatalf("cwd AGENTS.md exists after prepare, err = %v", err)
	}
	codexHome := envValue(prepared.Env, "CODEX_HOME")
	if _, err := os.Stat(filepath.Join(codexHome, "AGENTS.md")); err != nil {
		t.Fatalf("codex AGENTS.md missing after prepare: %v", err)
	}
	if err := preparer.Cleanup(t.Context(), CleanupInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatalf("Cleanup() error = %v", err)
	}
	if _, err := os.Stat(codexHome); !os.IsNotExist(err) {
		t.Fatalf("codex home still exists, err = %v", err)
	}
}

func TestDefaultPreparerRejectsMissingCwd(t *testing.T) {
	stateDir := t.TempDir()
	missingCwd := filepath.Join(t.TempDir(), "deleted-project")

	_, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            missingCwd,
	})
	if !errors.Is(err, ErrCwdNotDirectory) {
		t.Fatalf("Prepare() error = %v, want ErrCwdNotDirectory", err)
	}
	if _, statErr := os.Stat(missingCwd); !os.IsNotExist(statErr) {
		t.Fatalf("missing cwd was recreated, stat err = %v", statErr)
	}
}

func TestDefaultPreparerClaudeCodeUsesSessionScopedSystemPrompt(t *testing.T) {
	stateDir := t.TempDir()
	cwd := t.TempDir()
	claudePath := filepath.Join(cwd, "CLAUDE.md")
	if err := os.WriteFile(claudePath, []byte("user claude guidance\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	userSkillPath := filepath.Join(cwd, ".claude", "skills", "tutti-cli", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(userSkillPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userSkillPath, []byte("user skill\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:            "workspace-1",
		AgentSessionID:         "session-1",
		Provider:               "claude-code",
		Cwd:                    cwd,
		ConversationDetailMode: "general",
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	content, err := os.ReadFile(userSkillPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "user skill\n" {
		t.Fatalf("user skill was overwritten: %q", string(content))
	}
	claudeContent, err := os.ReadFile(claudePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(claudeContent) != "user claude guidance\n" {
		t.Fatalf("cwd CLAUDE.md content = %q, want user guidance unchanged", string(claudeContent))
	}
	tuttiSkillPath := filepath.Join(cwd, ".claude", "skills", "tutti-cli-tutti", "SKILL.md")
	if _, err := os.Stat(tuttiSkillPath); !os.IsNotExist(err) {
		t.Fatalf("claude cwd tutti provider skill exists after prepare, err = %v", err)
	}
	issueSkillPath := filepath.Join(cwd, ".claude", "skills", "issue-manager", "SKILL.md")
	if _, err := os.Stat(issueSkillPath); !os.IsNotExist(err) {
		t.Fatalf("claude cwd issue-manager skill exists after prepare, err = %v", err)
	}
	workspaceAppSkillPath := filepath.Join(cwd, ".claude", "skills", "workspace-app", "SKILL.md")
	if _, err := os.Stat(workspaceAppSkillPath); !os.IsNotExist(err) {
		t.Fatalf("claude cwd workspace-app skill exists after prepare, err = %v", err)
	}
	systemPromptPath := envValue(prepared.Env, claudeSystemPromptFileEnv)
	if systemPromptPath == "" {
		t.Fatalf("prepared env = %#v, want %s", prepared.Env, claudeSystemPromptFileEnv)
	}
	if rel, err := filepath.Rel(cwd, systemPromptPath); err == nil && !strings.HasPrefix(rel, "..") {
		t.Fatalf("claude system prompt path = %q, want outside cwd %q", systemPromptPath, cwd)
	}
	systemPrompt, err := os.ReadFile(systemPromptPath)
	if err != nil {
		t.Fatalf("claude system prompt missing: %v", err)
	}
	if !strings.Contains(string(systemPrompt), "`tutti <scope> --help`") ||
		!strings.Contains(string(systemPrompt), "App id mapping") {
		t.Fatalf("claude system prompt content = %q", string(systemPrompt))
	}
	if !strings.Contains(string(systemPrompt), "### Non-technical UI") ||
		!strings.Contains(string(systemPrompt), "don't name bash commands you're running") ||
		!strings.Contains(string(systemPrompt), "focus on outputs") {
		t.Fatalf("claude system prompt content = %q, want non-technical UI guidance", string(systemPrompt))
	}
	if !strings.Contains(string(systemPrompt), "## Mention Routing") ||
		!strings.Contains(string(systemPrompt), "| URI") ||
		!strings.Contains(string(systemPrompt), "Fallback") ||
		!strings.Contains(string(systemPrompt), "`mention://workspace-issue/<issueId>?workspaceId=...`") ||
		!strings.Contains(string(systemPrompt), "`mention://workspace-app/<appId>?workspaceId=...`") ||
		!strings.Contains(string(systemPrompt), "`mention://workspace-reference/<id>?source=...&workspaceId=...`") ||
		!strings.Contains(string(systemPrompt), "`mention://agent-session/<sessionId>?workspaceId=...`") ||
		!strings.Contains(string(systemPrompt), "`mention://agent-target/<targetId>?workspaceId=...`") ||
		!strings.Contains(string(systemPrompt), "If a provider Skill tool exists, call the exact visible name") ||
		!strings.Contains(string(systemPrompt), "If the Skill is unavailable, read its materialized `SKILL.md`") ||
		!strings.Contains(string(systemPrompt), "Claude Code mention routing") ||
		!strings.Contains(string(systemPrompt), "Claude Code skill names may be namespaced") ||
		!strings.Contains(string(systemPrompt), "`tutti-cli:tutti-handoff`") ||
		!strings.Contains(string(systemPrompt), "`tutti-cli:issue-manager`") ||
		!strings.Contains(string(systemPrompt), "`tutti-cli:workspace-app`") ||
		!strings.Contains(string(systemPrompt), `Skill(skill="tutti-cli:workspace-app")`) ||
		!strings.Contains(string(systemPrompt), `Skill(skill="tutti-cli:tutti-handoff")`) ||
		!strings.Contains(string(systemPrompt), "Do not use `ToolSearch` to select Claude Code's native `SendMessage`") ||
		!strings.Contains(string(systemPrompt), "never pass a Tutti agent target id such as `local:opencode` to native `SendMessage`") ||
		!strings.Contains(string(systemPrompt), "Do not call a plain skill name that is not visible") ||
		!strings.Contains(string(systemPrompt), "Do not pass arguments to Skill") ||
		!strings.Contains(string(systemPrompt), "the skill reads the mention URI from the current user turn") ||
		!strings.Contains(string(systemPrompt), "Call the exact visible Skill tool when available") ||
		!strings.Contains(string(systemPrompt), "fall back to that materialized skill file") ||
		!strings.Contains(string(systemPrompt), "Do not guess a directory from the plain skill slug") ||
		!strings.Contains(string(systemPrompt), "issue get --issue-id <issue-id> --json") ||
		!strings.Contains(string(systemPrompt), "Claude Code `Monitor` tool is disabled") ||
		!strings.Contains(string(systemPrompt), "bounded shell/script") ||
		!strings.Contains(string(systemPrompt), "agent wait --session-id <session-id> --json") ||
		!strings.Contains(string(systemPrompt), "agent get --session-id <session-id> --json") ||
		!strings.Contains(string(systemPrompt), "Agent handoff decisions belong to `$tutti-handoff`") {
		t.Fatalf("claude system prompt content = %q, want mention handoff fallback guidance", string(systemPrompt))
	}
	if !strings.Contains(string(systemPrompt), "# Host App Context") ||
		!strings.Contains(string(systemPrompt), "Images/videos: use Markdown") ||
		!strings.Contains(string(systemPrompt), "Generated/edited image output: final response must include Markdown image tag.") ||
		!strings.Contains(string(systemPrompt), "Prefer `$CODEX_HOME/generated_images/`") ||
		!strings.Contains(string(systemPrompt), "never use unverified sandbox path") ||
		!strings.Contains(string(systemPrompt), "No inline base64.") ||
		!strings.Contains(string(systemPrompt), "use `[filename](/abs/path)` Markdown links") ||
		!strings.Contains(string(systemPrompt), "No relative paths, line suffixes") ||
		!strings.Contains(string(systemPrompt), "Web URLs: Markdown links") {
		t.Fatalf("claude system prompt content = %q, want host app rendering guidance", string(systemPrompt))
	}
	if !strings.Contains(string(systemPrompt), "Claude Code skill names may be namespaced") ||
		!strings.Contains(string(systemPrompt), "Claude Code skill listings can omit descriptions") ||
		!strings.Contains(string(systemPrompt), "If a provider Skill tool exists, call the exact visible name") ||
		!strings.Contains(string(systemPrompt), "If the Skill is unavailable, read its materialized `SKILL.md`") ||
		!strings.Contains(string(systemPrompt), "`mention://...` is internal data, not a URL or path") ||
		!strings.Contains(string(systemPrompt), "`mention://agent-target/<targetId>?workspaceId=...`") ||
		!strings.Contains(string(systemPrompt), "agent get --session-id <session-id> --json") ||
		!strings.Contains(string(systemPrompt), "issue get --issue-id <issue-id> --json") {
		t.Fatalf("claude system prompt content = %q, want strict Tutti mention routing", string(systemPrompt))
	}
	if strings.Contains(string(systemPrompt), "CODEX_HOME/skills/<skill>/SKILL.md") ||
		strings.Contains(string(systemPrompt), ".claude/skills/<skill>/SKILL.md") ||
		strings.Contains(string(systemPrompt), "`workspace-app/SKILL.md`") ||
		strings.Contains(string(systemPrompt), `args="<full mention URI>"`) ||
		strings.Contains(string(systemPrompt), "with the full mention URI") {
		t.Fatalf("claude system prompt content = %q, want no guessed materialized skill paths", string(systemPrompt))
	}
	pluginDir := envValue(prepared.Env, claudePluginDirEnv)
	if pluginDir == "" {
		t.Fatalf("prepared env = %#v, want %s", prepared.Env, claudePluginDirEnv)
	}
	if got := envValue(prepared.Env, claudeSkillListingBudgetEnv); got != claudeSkillListingBudgetChars {
		t.Fatalf("prepared env %s = %q, want %q", claudeSkillListingBudgetEnv, got, claudeSkillListingBudgetChars)
	}
	if rel, err := filepath.Rel(cwd, pluginDir); err == nil && !strings.HasPrefix(rel, "..") {
		t.Fatalf("claude plugin dir = %q, want outside cwd %q", pluginDir, cwd)
	}
	pluginManifest, err := os.ReadFile(filepath.Join(pluginDir, ".claude-plugin", "plugin.json"))
	if err != nil {
		t.Fatalf("claude plugin manifest missing: %v", err)
	}
	if !strings.Contains(string(pluginManifest), `"name": "tutti-cli"`) {
		t.Fatalf("claude plugin manifest = %q", string(pluginManifest))
	}
	if !strings.Contains(string(pluginManifest), `"author": {`) ||
		!strings.Contains(string(pluginManifest), `"name": "Tutti"`) {
		t.Fatalf("claude plugin manifest author = %q", string(pluginManifest))
	}
	pluginSkill, err := os.ReadFile(filepath.Join(pluginDir, "skills", "tutti-cli", "SKILL.md"))
	if err != nil {
		t.Fatalf("claude plugin skill missing: %v", err)
	}
	if !strings.Contains(string(pluginSkill), "`tutti <scope> --help`") ||
		!strings.Contains(string(pluginSkill), "this skill's `command-guide.md`") ||
		!strings.Contains(string(pluginSkill), "mention://agent-session") ||
		!strings.Contains(string(pluginSkill), "mention://agent-target") ||
		!strings.Contains(string(pluginSkill), "handed off, not absorbed") ||
		!strings.Contains(string(pluginSkill), "## Route First") ||
		!strings.Contains(string(pluginSkill), "## Call Protocol") ||
		!strings.Contains(string(pluginSkill), "invoke `$issue-manager`") ||
		!strings.Contains(string(pluginSkill), "invoke `$workspace-app`") {
		t.Fatalf("claude plugin skill content = %q", string(pluginSkill))
	}
	issuePluginSkill, err := os.ReadFile(filepath.Join(pluginDir, "skills", "issue-manager", "SKILL.md"))
	if err != nil {
		t.Fatalf("claude issue-manager plugin skill missing: %v", err)
	}
	if !strings.Contains(string(issuePluginSkill), "mention://workspace-issue") {
		t.Fatalf("claude issue-manager plugin skill content = %q", string(issuePluginSkill))
	}
	workspaceAppPluginSkill, err := os.ReadFile(filepath.Join(pluginDir, "skills", "workspace-app", "SKILL.md"))
	if err != nil {
		t.Fatalf("claude workspace-app plugin skill missing: %v", err)
	}
	if !strings.Contains(string(workspaceAppPluginSkill), "mention://workspace-app") {
		t.Fatalf("claude workspace-app plugin skill content = %q", string(workspaceAppPluginSkill))
	}
}

func TestDefaultPreparerClaudeCodeSetsFallbackExecutableFromPath(t *testing.T) {
	binDir := t.TempDir()
	claudePath := filepath.Join(binDir, "claude")
	if err := os.WriteFile(claudePath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("CLAUDE_CODE_EXECUTABLE", "")

	prepared, err := newTestPreparer(t.TempDir()).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "claude-code",
		Cwd:            t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	// A PATH-installed claude is only a fallback: the sidecar prefers a native
	// SDK binary and the tuttid-provisioned one, so it must arrive via the
	// fallback env, not the always-wins override.
	if got := envValue(prepared.Env, claudeCodeFallbackExecutableEnvName); got != claudePath {
		t.Fatalf("%s = %q, want %q", claudeCodeFallbackExecutableEnvName, got, claudePath)
	}
	if got := envValue(prepared.Env, claudeCodeExecutableEnvName); got != "" {
		t.Fatalf("%s = %q, want empty", claudeCodeExecutableEnvName, got)
	}
}

func TestDefaultPreparerClaudeCodePrefersManagedBinaryOverPath(t *testing.T) {
	binDir := t.TempDir()
	claudePath := filepath.Join(binDir, "claude")
	if err := os.WriteFile(claudePath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("CLAUDE_CODE_EXECUTABLE", "")
	stateDir := t.TempDir()
	managed := filepath.Join(stateDir, "agent-providers", "claude-code", "versions", "2.1.201", "claude")
	writeFakeExecutable(t, managed)
	writeManagedClaudePointer(t, stateDir, managed)

	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "claude-code",
		Cwd:            t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if got := envValue(prepared.Env, claudeCodeFallbackExecutableEnvName); got != managed {
		t.Fatalf("%s = %q, want managed binary %q", claudeCodeFallbackExecutableEnvName, got, managed)
	}
}

func TestDefaultPreparerCursorUsesRuntimePluginDir(t *testing.T) {
	stateDir := t.TempDir()
	cwd := t.TempDir()
	agentsPath := filepath.Join(cwd, "AGENTS.md")
	if err := os.WriteFile(agentsPath, []byte("user cursor guidance\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(cwd, ".cursor", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cwd, ".cursor", "skills", "user-skill"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	preparer := newTestPreparer(stateDir)
	preparer.CLICommand = "tutti-dev"
	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "cursor-session-1",
		AgentTargetID:  "local:cursor",
		Provider:       "cursor",
		Cwd:            cwd,
		BrowserUse:     true,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if prepared.Cwd != cwd {
		t.Fatalf("prepared cwd = %q, want %q", prepared.Cwd, cwd)
	}
	if _, err := os.Stat(filepath.Join(cwd, ".cursor", "skills", "tutti-cli")); !os.IsNotExist(err) {
		t.Fatalf("cursor cwd tutti skill exists after prepare, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, ".cursor", "skills", "user-skill")); err != nil {
		t.Fatalf("cursor user skill was modified or removed: %v", err)
	}
	agentsContent, err := os.ReadFile(agentsPath)
	if err != nil {
		t.Fatalf("cursor AGENTS.md missing after prepare: %v", err)
	}
	if string(agentsContent) != "user cursor guidance\n" {
		t.Fatalf("cursor AGENTS.md content = %q, want user guidance unchanged", string(agentsContent))
	}

	pluginDir := envValue(prepared.Env, cursorPluginDirEnv)
	if pluginDir == "" {
		t.Fatalf("prepared env = %#v, want %s", prepared.Env, cursorPluginDirEnv)
	}
	if rel, err := filepath.Rel(cwd, pluginDir); err == nil && !strings.HasPrefix(rel, "..") {
		t.Fatalf("cursor plugin dir = %q, want outside cwd %q", pluginDir, cwd)
	}
	pluginManifest, err := os.ReadFile(filepath.Join(pluginDir, ".cursor-plugin", "plugin.json"))
	if err != nil {
		t.Fatalf("cursor plugin manifest missing: %v", err)
	}
	if !strings.Contains(string(pluginManifest), `"name": "tutti-cli"`) ||
		!strings.Contains(string(pluginManifest), `"skills": "./skills/"`) ||
		!strings.Contains(string(pluginManifest), `"displayName": "Tutti CLI"`) {
		t.Fatalf("cursor plugin manifest = %q", string(pluginManifest))
	}
	if strings.Contains(string(pluginManifest), `"hooks"`) {
		t.Fatalf("cursor ACP plugin must not advertise unsupported plugin hooks: %q", string(pluginManifest))
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "hooks")); !os.IsNotExist(err) {
		t.Fatalf("cursor ACP plugin hooks should remain dormant, stat error = %v", err)
	}
	pluginSkill, err := os.ReadFile(filepath.Join(pluginDir, "skills", "tutti-cli", "SKILL.md"))
	if err != nil {
		t.Fatalf("cursor plugin skill missing: %v", err)
	}
	if !strings.Contains(string(pluginSkill), "`tutti-dev <scope> --help`") ||
		!strings.Contains(string(pluginSkill), "mention://agent-session") ||
		!strings.Contains(string(pluginSkill), "mention://agent-target") {
		t.Fatalf("cursor plugin skill content = %q", string(pluginSkill))
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "skills", "issue-manager", "SKILL.md")); err != nil {
		t.Fatalf("cursor issue-manager plugin skill missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "skills", "workspace-app", "SKILL.md")); err != nil {
		t.Fatalf("cursor workspace-app plugin skill missing: %v", err)
	}
}

// Plan mode must NOT override CLAUDE_CONFIG_DIR. Doing so points the CLI at a
// fresh config directory without the user's credentials, which made plan turns
// fail with "Not logged in · Please run /login" (-32000) for OAuth users while
// every other permission mode kept working. Plan mode is applied through the ACP
// `set_mode("plan")` call instead.
func TestDefaultPreparerClaudePlanModeDoesNotOverrideConfigDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userClaudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(userClaudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userClaudeDir, "settings.json"), []byte(`{
  "permissions": { "defaultMode": "default" }
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	cwd := t.TempDir()

	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "claude-code",
		Cwd:            cwd,
		PlanMode:       true,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	if got := envValue(prepared.Env, "CLAUDE_CONFIG_DIR"); got != "" {
		t.Fatalf("prepared env CLAUDE_CONFIG_DIR = %q, want unset so the CLI keeps the user's credentials", got)
	}
}

func TestTuttiAgentConfigWithLLMProviderPinsExistingRootProvider(t *testing.T) {
	input := strings.Join([]string{
		`model_provider = "custom"`,
		`model = "custom-model"`,
		``,
		`[model_providers.custom]`,
		`name = "Custom"`,
		`base_url = "https://example.invalid/v1"`,
	}, "\n")

	next, changed := tuttiAgentConfigWithLLMProvider(input)
	if !changed {
		t.Fatalf("changed = false, want true")
	}
	if strings.Contains(next, `model_provider = "custom"`) {
		t.Fatalf("next retained custom provider: %s", next)
	}
	if !strings.Contains(next, `model_provider = "tutti-llm"`) ||
		!strings.Contains(next, `model = "gpt-5.4"`) ||
		!strings.Contains(next, `[model_providers.tutti-llm]`) {
		t.Fatalf("next did not pin Tutti LLM provider: %s", next)
	}
	if !strings.Contains(next, `[model_providers.custom]`) {
		t.Fatalf("next removed user provider block: %s", next)
	}
}

func TestDefaultPreparerCleanupRemovesClaudeSystemPromptRuntimeRoot(t *testing.T) {
	stateDir := t.TempDir()
	cwd := t.TempDir()
	preparer := newTestPreparer(stateDir)
	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "claude-code",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	systemPromptPath := envValue(prepared.Env, claudeSystemPromptFileEnv)
	if _, err := os.Stat(systemPromptPath); err != nil {
		t.Fatalf("claude system prompt missing before cleanup: %v", err)
	}
	pluginDir := envValue(prepared.Env, claudePluginDirEnv)
	if _, err := os.Stat(filepath.Join(pluginDir, ".claude-plugin", "plugin.json")); err != nil {
		t.Fatalf("claude plugin manifest missing before cleanup: %v", err)
	}
	projectClaudeDir := filepath.Join(cwd, ".claude")
	if _, err := os.Stat(projectClaudeDir); !os.IsNotExist(err) {
		t.Fatalf("cwd .claude exists after prepare, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("cwd CLAUDE.md exists after prepare, err = %v", err)
	}

	if err := preparer.Cleanup(t.Context(), CleanupInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
	}); err != nil {
		t.Fatalf("Cleanup() error = %v", err)
	}
	if _, err := os.Stat(systemPromptPath); !os.IsNotExist(err) {
		t.Fatalf("claude system prompt still exists, err = %v", err)
	}
	if _, err := os.Stat(pluginDir); !os.IsNotExist(err) {
		t.Fatalf("claude plugin dir still exists, err = %v", err)
	}
	if _, err := os.Stat(projectClaudeDir); !os.IsNotExist(err) {
		t.Fatalf("cwd .claude exists after cleanup, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("cwd CLAUDE.md exists after cleanup, err = %v", err)
	}
}

func TestCodexPreparerSkipsUserBrowserSkillWhenBrowserUseEnabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(browserUseSwitchEnv, "")
	userCodexHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "auth.json"), []byte(`{"token":"test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "skills", "browser", "SKILL.md"), "---\nname: browser\n---\nExternal browser\n")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "skills", "caveman", "SKILL.md"), "---\nname: caveman\n---\nCaveman mode\n")

	stateDir := t.TempDir()
	cwd := t.TempDir()
	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            cwd,
		BrowserUse:     true,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	codexHome := envValue(prepared.Env, "CODEX_HOME")
	if codexHome == "" {
		t.Fatalf("prepared env = %#v, want CODEX_HOME", prepared.Env)
	}
	if _, err := os.Stat(filepath.Join(codexHome, "skills", "browser")); !os.IsNotExist(err) {
		t.Fatalf("external browser skill should be omitted when browser-use is enabled, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(codexHome, "skills", "caveman")); err != nil {
		t.Fatalf("unrelated user skill should still be exposed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(codexHome, "skills", "browser-use", "SKILL.md")); err != nil {
		t.Fatalf("browser-use skill missing: %v", err)
	}
	codexAgents, err := os.ReadFile(filepath.Join(codexHome, "AGENTS.md"))
	if err != nil {
		t.Fatalf("codex AGENTS.md missing: %v", err)
	}
	if !strings.Contains(string(codexAgents), "`$browser-use`") {
		t.Fatalf("codex AGENTS.md content = %q, want browser-use policy", string(codexAgents))
	}
}

func TestExposeCodexImportedRolloutFileSymlinksMatchingRelativePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	rel := filepath.Join("sessions", "2026", "07", "04", "rollout-abc.jsonl")
	sourcePath := filepath.Join(home, ".codex", rel)
	writeSidecarTestFile(t, sourcePath, `{"type":"session_meta"}`)

	codexHome := t.TempDir()
	if err := exposeCodexImportedRolloutFile(codexHome, sourcePath); err != nil {
		t.Fatalf("exposeCodexImportedRolloutFile() error = %v", err)
	}

	target := filepath.Join(codexHome, rel)
	info, err := os.Lstat(target)
	if err != nil {
		t.Fatalf("imported rollout file not exposed: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("imported rollout file mode = %v, want symlink", info.Mode())
	}
	linkTarget, err := os.Readlink(target)
	if err != nil {
		t.Fatal(err)
	}
	if linkTarget != sourcePath {
		t.Fatalf("symlink target = %q, want %q", linkTarget, sourcePath)
	}
}

func TestExposeCodexImportedRolloutFileNoopWhenSourcePathEmpty(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	codexHome := t.TempDir()
	if err := exposeCodexImportedRolloutFile(codexHome, ""); err != nil {
		t.Fatalf("exposeCodexImportedRolloutFile() error = %v", err)
	}
	entries, err := os.ReadDir(codexHome)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("codexHome entries = %#v, want none created for empty source path", entries)
	}
}

func TestExposeCodexImportedRolloutFileGracefulWhenSourceFileMissing(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	sourcePath := filepath.Join(home, ".codex", "sessions", "2026", "07", "04", "rollout-gone.jsonl")

	codexHome := t.TempDir()
	if err := exposeCodexImportedRolloutFile(codexHome, sourcePath); err != nil {
		t.Fatalf("exposeCodexImportedRolloutFile() error = %v, want graceful nil when source is gone", err)
	}
	if _, err := os.Lstat(filepath.Join(codexHome, "sessions", "2026", "07", "04", "rollout-gone.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("expected no symlink for a missing source rollout, err = %v", err)
	}
}

func TestExposeCodexImportedRolloutFileGracefulWhenSourceOutsideRealCodexHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	outsidePath := filepath.Join(t.TempDir(), "rollout.jsonl")
	writeSidecarTestFile(t, outsidePath, `{"type":"session_meta"}`)

	codexHome := t.TempDir()
	if err := exposeCodexImportedRolloutFile(codexHome, outsidePath); err != nil {
		t.Fatalf("exposeCodexImportedRolloutFile() error = %v, want graceful nil for a path outside ~/.codex", err)
	}
	entries, err := os.ReadDir(codexHome)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("codexHome entries = %#v, want none created for a source path outside ~/.codex", entries)
	}
}

func TestDefaultPreparerCodexExposesImportedRolloutFileFromPrepareInput(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	rel := filepath.Join("sessions", "2026", "07", "04", "rollout-abc.jsonl")
	sourcePath := filepath.Join(home, ".codex", rel)
	writeSidecarTestFile(t, sourcePath, `{"type":"session_meta"}`)

	stateDir := t.TempDir()
	cwd := t.TempDir()
	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:               "workspace-1",
		AgentSessionID:            "session-1",
		AgentTargetID:             "local:codex",
		Provider:                  "codex",
		Cwd:                       cwd,
		ExternalRolloutSourcePath: sourcePath,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	codexHome := envValue(prepared.Env, "CODEX_HOME")
	if codexHome == "" {
		t.Fatalf("prepared env = %#v, want CODEX_HOME", prepared.Env)
	}
	target := filepath.Join(codexHome, rel)
	info, err := os.Lstat(target)
	if err != nil {
		t.Fatalf("imported rollout file not exposed via Prepare(): %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("imported rollout file mode = %v, want symlink", info.Mode())
	}
}

func TestDefaultPreparerCodexSkipsRolloutExposureForNonImportedSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	stateDir := t.TempDir()
	cwd := t.TempDir()
	prepared, err := newTestPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	codexHome := envValue(prepared.Env, "CODEX_HOME")
	if codexHome == "" {
		t.Fatalf("prepared env = %#v, want CODEX_HOME", prepared.Env)
	}
	if _, err := os.Stat(filepath.Join(codexHome, "sessions")); !os.IsNotExist(err) {
		t.Fatalf("non-imported session should not create a sessions dir, err = %v", err)
	}
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}

func writeSidecarTestFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
