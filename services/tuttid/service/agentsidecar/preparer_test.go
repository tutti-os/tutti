package agentsidecar

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentsidecarbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentsidecar"
	agentsidecardata "github.com/tutti-os/tutti/services/tuttid/data/agentsidecar"
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
	userCodexConfig := strings.Join([]string{
		`notify = ["say", "done"]`,
		`model_provider = "proxy"`,
		`service_tier = "default"`,
		"",
		"[model_providers.proxy]",
		`base_url = "https://openai.proxy.test/v1"`,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), []byte(userCodexConfig), 0o600); err != nil {
		t.Fatal(err)
	}
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

	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		Cwd:            cwd,
		ExtraSkills: []ProviderSkillBundle{
			{
				Name: "app-factory",
				Files: map[string]string{
					"SKILL.md":                        "---\nname: app-factory\n---\nmention://workspace-app-factory\n",
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
	if !strings.Contains(string(codexAgents), "tutti issue list") {
		t.Fatalf("codex AGENTS.md content = %q", string(codexAgents))
	}
	if strings.Contains(string(codexAgents), `Skill(skill="issue-manager", args="<full mention URI>")`) {
		t.Fatalf("codex AGENTS.md content = %q, want provider-neutral mention routing", string(codexAgents))
	}
	if !strings.Contains(string(codexAgents), "# Host App Context") ||
		!strings.Contains(string(codexAgents), "standard Markdown syntax, for example `![alt](/absolute/path.png)`") ||
		!strings.Contains(string(codexAgents), "you MUST include that image in your final response using Markdown image syntax") ||
		!strings.Contains(string(codexAgents), "Prefer final image paths under `$CODEX_HOME/generated_images/`") ||
		!strings.Contains(string(codexAgents), "Do not use unverified tool sandbox paths such as `/mnt/data/...`") ||
		!strings.Contains(string(codexAgents), "Do not include inline base64 image data in responses") ||
		!strings.Contains(string(codexAgents), "Return web URLs as Markdown links, for example") {
		t.Fatalf("codex AGENTS.md content = %q, want host app rendering guidance", string(codexAgents))
	}
	if _, err := os.Lstat(filepath.Join(codexHome, "auth.json")); err != nil {
		t.Fatalf("codex auth not exposed: %v", err)
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
	if !strings.Contains(string(skill), "tutti agent sessions") {
		t.Fatalf("skill content = %q", string(skill))
	}
	if !strings.Contains(string(skill), "local Tutti daemon") ||
		!strings.Contains(string(skill), "localhost/IPC") ||
		!strings.Contains(string(skill), "execution environment") ||
		!strings.Contains(string(skill), "Issue execution sequencing belongs to the `issue-manager` skill") {
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
		!strings.Contains(string(issueSkill), "Use the injected `tutti-cli` skill as the command reference") ||
		!strings.Contains(string(issueSkill), "## Inspection Mode") ||
		!strings.Contains(string(issueSkill), "Create the run yourself before doing the work") ||
		!strings.Contains(string(issueSkill), "If the mention does not include `taskId`, inspect the issue tasks before creating a run") ||
		!strings.Contains(string(issueSkill), "execute each child task in issue order") ||
		!strings.Contains(string(issueSkill), "--agent-provider codex --agent-session-id session-1") ||
		!strings.Contains(string(issueSkill), "complete that same run") ||
		!strings.Contains(string(issueSkill), "Do not edit code, do not execute the task, and do not create or complete runs in breakdown mode") {
		t.Fatalf("issue-manager skill content = %q", string(issueSkill))
	}
	if envValue(prepared.Env, "TUTTI_AGENT_PROVIDER") != "codex" {
		t.Fatalf("prepared env = %#v, want TUTTI_AGENT_PROVIDER", prepared.Env)
	}
	workspaceAppSkill, err := os.ReadFile(filepath.Join(codexHome, "skills", "workspace-app", "SKILL.md"))
	if err != nil {
		t.Fatalf("workspace-app skill missing: %v", err)
	}
	if !strings.Contains(string(workspaceAppSkill), "mention://workspace-app") ||
		!strings.Contains(string(workspaceAppSkill), "appId") ||
		!strings.Contains(string(workspaceAppSkill), "Use the injected `tutti-cli` skill as the command reference") {
		t.Fatalf("workspace-app skill content = %q", string(workspaceAppSkill))
	}
	appFactorySkill, err := os.ReadFile(filepath.Join(codexHome, "skills", "app-factory", "SKILL.md"))
	if err != nil {
		t.Fatalf("app-factory skill missing: %v", err)
	}
	if !strings.Contains(string(appFactorySkill), "mention://workspace-app-factory") {
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
	runtimeRoot, err := agentsidecardata.LocalStore{StateDir: stateDir}.RuntimeRoot("workspace-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(runtimeRoot, agentsidecarbiz.SidecarManifestFileName)); err != nil {
		t.Fatalf("manifest missing: %v", err)
	}
	if envValue(prepared.Env, "TUTTI_WORKSPACE_ID") != "workspace-1" {
		t.Fatalf("prepared env = %#v, want workspace id", prepared.Env)
	}
}

func TestDefaultPreparerCodexUserSkillNameWinsBeforeTuttiInjection(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userCodexHome := filepath.Join(home, ".codex")
	writeSidecarTestFile(t, filepath.Join(userCodexHome, "skills", "tutti-cli", "SKILL.md"), "---\nname: tutti-cli\n---\nUser tutti skill\n")

	stateDir := t.TempDir()
	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
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
	if !strings.Contains(string(tuttiSkill), "tutti agent sessions") {
		t.Fatalf("tutti fallback skill = %q", string(tuttiSkill))
	}
}

func TestDefaultPreparerCodexWritesProjectRootMarkersDisabledConfigWithoutUserConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	stateDir := t.TempDir()
	cwd := t.TempDir()
	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
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
	if strings.TrimSpace(string(codexConfig)) != codexProjectRootMarkersDisabledConfig {
		t.Fatalf("codex config = %q, want project root markers disabled", string(codexConfig))
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

	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
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
	if !strings.Contains(string(content), "tutti-dev issue list") {
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
	preparer := NewDefaultPreparer(stateDir)
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
	runtimeRoot, err := agentsidecardata.LocalStore{StateDir: stateDir}.RuntimeRoot("workspace-1", "session-1")
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
	preparer := NewDefaultPreparer(stateDir)
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

	_, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
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

	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "claude-code",
		Cwd:            cwd,
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
	tuttiSkill, err := os.ReadFile(tuttiSkillPath)
	if err != nil {
		t.Fatalf("claude cwd tutti provider skill missing: %v", err)
	}
	if !strings.Contains(string(tuttiSkill), "tutti issue list") {
		t.Fatalf("claude cwd tutti provider skill content = %q", string(tuttiSkill))
	}
	if !strings.Contains(string(tuttiSkill), "fallback router") ||
		!strings.Contains(string(tuttiSkill), "`mention://workspace-issue?...` -> `issue-manager`") ||
		!strings.Contains(string(tuttiSkill), "`mention://workspace-app?...` -> `workspace-app`") ||
		!strings.Contains(string(tuttiSkill), "`mention://agent-session?...` -> `tutti-cli`") {
		t.Fatalf("claude cwd tutti provider skill content = %q, want mention router guidance", string(tuttiSkill))
	}
	issueSkillPath := filepath.Join(cwd, ".claude", "skills", "issue-manager", "SKILL.md")
	issueSkill, err := os.ReadFile(issueSkillPath)
	if err != nil {
		t.Fatalf("claude cwd issue-manager skill missing: %v", err)
	}
	if !strings.Contains(string(issueSkill), "mention://workspace-issue") {
		t.Fatalf("claude cwd issue-manager skill content = %q", string(issueSkill))
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
	if !strings.Contains(string(systemPrompt), "tutti issue list") {
		t.Fatalf("claude system prompt content = %q", string(systemPrompt))
	}
	if !strings.Contains(string(systemPrompt), "First, if provider-native skills are visible") ||
		!strings.Contains(string(systemPrompt), "Provider-native skill names may be namespaced") ||
		!strings.Contains(string(systemPrompt), "Claude Code mention routing") ||
		!strings.Contains(string(systemPrompt), "`tutti-cli:issue-manager`") ||
		!strings.Contains(string(systemPrompt), "`tutti-cli:workspace-app`") ||
		!strings.Contains(string(systemPrompt), `Skill(skill="issue-manager", args="<full mention URI>")`) ||
		!strings.Contains(string(systemPrompt), `Skill(skill="workspace-app", args="<full mention URI>")`) ||
		!strings.Contains(string(systemPrompt), `Skill(skill="tutti-cli", args="<full mention URI>")`) ||
		!strings.Contains(string(systemPrompt), "Do not call Bash, Read, ls, WebFetch, browser, MCP lookup, file search, or raw CLI commands before this skill call") ||
		!strings.Contains(string(systemPrompt), "Treat mention routing as higher priority than guessing the source platform from the display label") ||
		!strings.Contains(string(systemPrompt), "you MUST use the relevant injected skill") ||
		!strings.Contains(string(systemPrompt), "Treat `mention://...` links as internal Tutti references") ||
		!strings.Contains(string(systemPrompt), "Do not try to open `mention://...` links in a browser") ||
		!strings.Contains(string(systemPrompt), "If no matching skill is visible") ||
		!strings.Contains(string(systemPrompt), "`mention://workspace-issue?...`") ||
		!strings.Contains(string(systemPrompt), "issue get --issue-id <issue-id> --json") ||
		!strings.Contains(string(systemPrompt), "`mention://agent-session?...`") ||
		!strings.Contains(string(systemPrompt), "agent session-summary --session-id <session-id> --json") {
		t.Fatalf("claude system prompt content = %q, want mention handoff fallback guidance", string(systemPrompt))
	}
	if !strings.Contains(string(systemPrompt), "# Host App Context") ||
		!strings.Contains(string(systemPrompt), "standard Markdown syntax, for example `![alt](/absolute/path.png)`") ||
		!strings.Contains(string(systemPrompt), "you MUST include that image in your final response using Markdown image syntax") ||
		!strings.Contains(string(systemPrompt), "Prefer final image paths under `$CODEX_HOME/generated_images/`") ||
		!strings.Contains(string(systemPrompt), "Do not use unverified tool sandbox paths such as `/mnt/data/...`") ||
		!strings.Contains(string(systemPrompt), "Do not include inline base64 image data in responses") ||
		!strings.Contains(string(systemPrompt), "Return web URLs as Markdown links, for example") {
		t.Fatalf("claude system prompt content = %q, want host app rendering guidance", string(systemPrompt))
	}
	if !strings.Contains(string(systemPrompt), "Provider-native skill names may be namespaced") ||
		!strings.Contains(string(systemPrompt), "Claude Code skill listings can omit descriptions") ||
		!strings.Contains(string(systemPrompt), "you MUST use the relevant injected skill") ||
		!strings.Contains(string(systemPrompt), "Do not open `mention://...` links in a browser") ||
		!strings.Contains(string(systemPrompt), "agent session-summary --session-id <session-id> --json") ||
		!strings.Contains(string(systemPrompt), "issue get --issue-id <issue-id> --json") {
		t.Fatalf("claude system prompt content = %q, want strict Tutti mention routing", string(systemPrompt))
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
	if !strings.Contains(string(pluginSkill), "tutti issue list") ||
		!strings.Contains(string(pluginSkill), "mention://agent-session") ||
		!strings.Contains(string(pluginSkill), "`mention://workspace-issue?...` belongs to `issue-manager`") ||
		!strings.Contains(string(pluginSkill), "`mention://workspace-app?...` belongs to `workspace-app`") {
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

func TestDefaultPreparerClaudePlanModeWritesSessionConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userClaudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(userClaudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userClaudeDir, "settings.json"), []byte(`{
  "model": "sonnet",
  "env": {
    "ANTHROPIC_BASE_URL": "https://anthropic.proxy.test"
  },
  "permissions": {
    "allow": ["Read"],
    "defaultMode": "default"
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	cwd := t.TempDir()

	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "claude-code",
		Cwd:            cwd,
		PlanMode:       true,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}

	configDir := envValue(prepared.Env, claudeConfigDirEnv)
	if configDir == "" {
		t.Fatalf("prepared env = %#v, want %s", prepared.Env, claudeConfigDirEnv)
	}
	if rel, err := filepath.Rel(cwd, configDir); err == nil && !strings.HasPrefix(rel, "..") {
		t.Fatalf("claude config dir = %q, want outside cwd %q", configDir, cwd)
	}
	content, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
	if err != nil {
		t.Fatalf("read claude settings: %v", err)
	}
	var settings map[string]any
	if err := json.Unmarshal(content, &settings); err != nil {
		t.Fatalf("claude settings JSON = %q: %v", string(content), err)
	}
	if got := settings["model"]; got != "sonnet" {
		t.Fatalf("claude settings model = %#v, want preserved user setting", got)
	}
	env, _ := settings["env"].(map[string]any)
	if got := env["ANTHROPIC_BASE_URL"]; got != "https://anthropic.proxy.test" {
		t.Fatalf("claude settings env base URL = %#v, want preserved user env", got)
	}
	permissions, _ := settings["permissions"].(map[string]any)
	if got := permissions["defaultMode"]; got != "plan" {
		t.Fatalf("claude settings permissions.defaultMode = %#v, want plan", got)
	}
	allow, _ := permissions["allow"].([]any)
	if len(allow) != 1 || allow[0] != "Read" {
		t.Fatalf("claude settings permissions.allow = %#v, want preserved user permissions", permissions["allow"])
	}
}

func TestDefaultPreparerCleanupRemovesClaudeSystemPromptRuntimeRoot(t *testing.T) {
	stateDir := t.TempDir()
	cwd := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
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
	issueSkillPath := filepath.Join(cwd, ".claude", "skills", "issue-manager", "SKILL.md")
	if _, err := os.Stat(issueSkillPath); err != nil {
		t.Fatalf("claude cwd issue-manager skill missing before cleanup: %v", err)
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
	if _, err := os.Stat(issueSkillPath); !os.IsNotExist(err) {
		t.Fatalf("claude cwd issue-manager skill still exists, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("cwd CLAUDE.md exists after cleanup, err = %v", err)
	}
}

func TestDefaultPreparerGeminiUsesSessionScopedHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userGeminiDir := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(userGeminiDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userGeminiDir, "settings.json"), []byte(`{"model":{"name":"gemini-test"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	cwd := t.TempDir()
	geminiPath := filepath.Join(cwd, "GEMINI.md")
	if err := os.WriteFile(geminiPath, []byte("user gemini guidance\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "gemini",
		Cwd:            cwd,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	content, err := os.ReadFile(geminiPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "user gemini guidance\n" {
		t.Fatalf("cwd GEMINI.md content = %q, want user guidance unchanged", string(content))
	}
	if _, err := os.Stat(filepath.Join(cwd, ".gemini")); !os.IsNotExist(err) {
		t.Fatalf("cwd .gemini exists after prepare, err = %v", err)
	}
	geminiHome := envValue(prepared.Env, "HOME")
	if geminiHome == "" {
		t.Fatalf("prepared env = %#v, want HOME", prepared.Env)
	}
	if rel, err := filepath.Rel(cwd, geminiHome); err == nil && !strings.HasPrefix(rel, "..") {
		t.Fatalf("gemini home = %q, want outside cwd %q", geminiHome, cwd)
	}
	sessionGemini, err := os.ReadFile(filepath.Join(geminiHome, ".gemini", "GEMINI.md"))
	if err != nil {
		t.Fatalf("session GEMINI.md missing: %v", err)
	}
	if !strings.Contains(string(sessionGemini), "tutti issue list") {
		t.Fatalf("session GEMINI.md content = %q", string(sessionGemini))
	}
	settings, err := os.ReadFile(filepath.Join(geminiHome, ".gemini", "settings.json"))
	if err != nil {
		t.Fatalf("session gemini settings missing: %v", err)
	}
	if !strings.Contains(string(settings), "gemini-test") {
		t.Fatalf("session gemini settings = %q", string(settings))
	}
	skill, err := os.ReadFile(filepath.Join(geminiHome, ".gemini", "skills", "tutti-cli", "SKILL.md"))
	if err != nil {
		t.Fatalf("session gemini skill missing: %v", err)
	}
	if !strings.Contains(string(skill), "tutti agent sessions") {
		t.Fatalf("session gemini skill = %q", string(skill))
	}
	issueSkill, err := os.ReadFile(filepath.Join(geminiHome, ".gemini", "skills", "issue-manager", "SKILL.md"))
	if err != nil {
		t.Fatalf("session gemini issue-manager skill missing: %v", err)
	}
	if !strings.Contains(string(issueSkill), "mention://workspace-issue") {
		t.Fatalf("session gemini issue-manager skill = %q", string(issueSkill))
	}
	workspaceAppSkill, err := os.ReadFile(filepath.Join(geminiHome, ".gemini", "skills", "workspace-app", "SKILL.md"))
	if err != nil {
		t.Fatalf("session gemini workspace-app skill missing: %v", err)
	}
	if !strings.Contains(string(workspaceAppSkill), "mention://workspace-app") {
		t.Fatalf("session gemini workspace-app skill = %q", string(workspaceAppSkill))
	}
}

func TestCodexPreparerSkipsUserBrowserSkillWhenBrowserUseEnabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
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
	prepared, err := NewDefaultPreparer(stateDir).Prepare(t.Context(), PrepareInput{
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
	if !strings.Contains(string(codexAgents), "`browser-use`") {
		t.Fatalf("codex AGENTS.md content = %q, want browser-use policy", string(codexAgents))
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
