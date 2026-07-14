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
