package agentsidecar

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceAppSkillUsesPreparedCLICommandForAgentLaunchers(t *testing.T) {
	skill := workspaceAppSkill(PrepareInput{CLICommand: "tutti-dev"})

	for _, want := range []string{
		"tutti-dev codex start --model <model> --prompt <task> --show --json",
		"tutti-dev claude start --model <model> --prompt <task> --show --json",
		"`tutti-dev <scope> <command>`",
	} {
		if !strings.Contains(skill, want) {
			t.Fatalf("workspace app skill missing %q: %q", want, skill)
		}
	}
	if strings.Contains(skill, "{{CLI_COMMAND}}") || strings.Contains(skill, "tutti codex start") {
		t.Fatalf("workspace app skill used unresolved or production CLI command: %q", skill)
	}
}

func TestTuttiCLIPolicyUsesPreparedCLICommandForAgentLauncherFallback(t *testing.T) {
	policy := tuttiCLIPolicy(PrepareInput{
		AgentSessionID: "session-1",
		CLICommand:     "tutti-dev",
		Provider:       "codex",
	})

	for _, want := range []string{
		"tutti-dev codex start --model <model> --prompt <task> --show --json",
		"tutti-dev claude start --model <model> --prompt <task> --show --json",
	} {
		if !strings.Contains(policy, want) {
			t.Fatalf("tutti CLI policy missing %q: %q", want, policy)
		}
	}
	if strings.Contains(policy, "{{CLI_COMMAND}}") || strings.Contains(policy, "tutti codex start") {
		t.Fatalf("tutti CLI policy used unresolved or production CLI command: %q", policy)
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
