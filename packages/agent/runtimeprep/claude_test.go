package runtimeprep

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeManagedClaudePointer(t *testing.T, stateDir string, executable string) {
	t.Helper()
	pointerPath := filepath.Join(stateDir, filepath.FromSlash(claudeCodeManagedPointerRelPath))
	if err := os.MkdirAll(filepath.Dir(pointerPath), 0o755); err != nil {
		t.Fatal(err)
	}
	content, err := json.Marshal(map[string]string{
		"version":    "2.1.201",
		"executable": executable,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pointerPath, content, 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeFakeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeCodeExecutableEnvPrefersExplicitOverride(t *testing.T) {
	stateDir := t.TempDir()
	managed := filepath.Join(stateDir, "claude-managed")
	writeFakeExecutable(t, managed)
	writeManagedClaudePointer(t, stateDir, managed)
	t.Setenv(claudeCodeExecutableEnvName, "/custom/claude")

	env := ClaudeCodePreparer{StateDir: stateDir}.claudeCodeExecutableEnv()
	if len(env) != 1 || env[0] != claudeCodeExecutableEnvName+"=/custom/claude" {
		t.Fatalf("env = %v, want explicit override", env)
	}
}

func TestClaudeCodeExecutableEnvUsesManagedPointer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable-bit checks do not apply on windows")
	}
	stateDir := t.TempDir()
	managed := filepath.Join(stateDir, "agent-providers", "claude-code", "versions", "2.1.201", "claude")
	writeFakeExecutable(t, managed)
	writeManagedClaudePointer(t, stateDir, managed)
	t.Setenv(claudeCodeExecutableEnvName, "")

	env := ClaudeCodePreparer{StateDir: stateDir}.claudeCodeExecutableEnv()
	if len(env) != 1 || env[0] != claudeCodeFallbackExecutableEnvName+"="+managed {
		t.Fatalf("env = %v, want managed fallback %s", env, managed)
	}
}

func TestClaudeCodeExecutableEnvIgnoresDanglingPointer(t *testing.T) {
	stateDir := t.TempDir()
	writeManagedClaudePointer(t, stateDir, filepath.Join(stateDir, "missing-binary"))
	t.Setenv(claudeCodeExecutableEnvName, "")
	// Force PATH lookup to fail so the dangling pointer would be the only
	// candidate; the result must then be empty.
	t.Setenv("PATH", t.TempDir())

	env := ClaudeCodePreparer{StateDir: stateDir}.claudeCodeExecutableEnv()
	if len(env) != 0 {
		t.Fatalf("env = %v, want empty for dangling pointer", env)
	}
}

func TestClaudeCodeExecutableEnvFallsBackToPathClaude(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PATH shim helper writes a shell script")
	}
	binDir := t.TempDir()
	claudePath := filepath.Join(binDir, "claude")
	writeFakeExecutable(t, claudePath)
	t.Setenv(claudeCodeExecutableEnvName, "")
	t.Setenv("PATH", binDir)

	env := ClaudeCodePreparer{StateDir: t.TempDir()}.claudeCodeExecutableEnv()
	if len(env) != 1 || !strings.HasSuffix(env[0], "="+claudePath) ||
		!strings.HasPrefix(env[0], claudeCodeFallbackExecutableEnvName+"=") {
		t.Fatalf("env = %v, want PATH fallback %s", env, claudePath)
	}
}

func TestClaudePrepareExposesPersonalSkillsAsAdditionalDirectory(t *testing.T) {
	personalSkillRoot := filepath.Join(t.TempDir(), "shared", "skills")
	skillPath := filepath.Join(personalSkillRoot, "shared-skill", "SKILL.md")
	writeSidecarTestFile(t, skillPath, "---\nname: shared-skill\n---\nshared\n")

	preparer := newTestPreparer(t.TempDir())
	preparer.RegisterProvider(ClaudeCodePreparer{PersonalSkillRoot: personalSkillRoot})
	prepared, err := preparer.Prepare(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:claude-code",
		Provider:       "claude-code",
		Cwd:            t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	var directories []string
	if err := json.Unmarshal([]byte(envValue(prepared.Env, claudeAdditionalDirectoriesEnv)), &directories); err != nil {
		t.Fatalf("decode Claude additional directories: %v", err)
	}
	if len(directories) != 1 {
		t.Fatalf("Claude additional directories = %#v, want one projection", directories)
	}
	projectedSkill := filepath.Join(directories[0], ".claude", "skills", "shared-skill", "SKILL.md")
	projectedInfo, err := os.Stat(projectedSkill)
	if err != nil {
		t.Fatalf("projected Claude personal Skill missing: %v", err)
	}
	sourceInfo, err := os.Stat(skillPath)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(projectedInfo, sourceInfo) {
		t.Fatal("Claude personal Skill projection is not backed by the stable source")
	}
}
