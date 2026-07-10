package agentstatus

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServiceRunActionUpdatesClaudeCodeWithOfficialCLICommand(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	claudePath := filepath.Join(binDir, "claude")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	writeExecutable(t, claudePath, `#!/bin/sh
if [ "$1" = "--version" ]; then echo '2.1.100 (Claude Code)'; exit 0; fi
sleep 1
`)
	t.Setenv(claudeSDKSidecarCommandEnv, claudePath)

	var updateCommand string
	service := Service{
		Environ: func() []string { return []string{"PATH=" + binDir} },
		HomeDir: func() (string, error) { return home, nil },
		LookPath: func(name string) (string, error) {
			if name == "claude" || name == claudePath {
				return claudePath, nil
			}
			return "", errors.New("not found")
		},
		IsExecutableFile: isTestExecutable,
		InstallCommand: func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
			updateCommand = input.Command
			return InstallCommandResult{ExitCode: 0, Stdout: "updated"}, nil
		},
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthAuthenticated}, true
		},
		Now:             func() time.Time { return time.Date(2026, 7, 10, 8, 0, 0, 0, time.UTC) },
		ProbeReadyAfter: 10 * time.Millisecond,
		ProbeTimeout:    100 * time.Millisecond,
	}

	result, err := service.RunAction(context.Background(), RunActionInput{
		Provider: "claude-code",
		ActionID: ActionUpdate,
	})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if result.Status != RunActionCompleted {
		t.Fatalf("Status = %q, want completed; result=%#v", result.Status, result)
	}
	if !strings.Contains(updateCommand, claudePath) || !strings.HasSuffix(updateCommand, " update") {
		t.Fatalf("update command = %q, want resolved Claude CLI update", updateCommand)
	}
	if result.Probe == nil || result.Probe.Status != ProbeReady {
		t.Fatalf("Probe = %#v, want ready", result.Probe)
	}
	if action := activeActionForProvider("claude-code"); action != nil {
		t.Fatalf("active action = %#v, want cleared", action)
	}
}

func TestCodexUpdateFallsBackToManagedInstallerWhenNativeCommandFails(t *testing.T) {
	commands := []string{}
	service := Service{
		Environ: func() []string { return nil },
		HomeDir: func() (string, error) { return t.TempDir(), nil },
		InstallCommand: func(_ context.Context, input InstallCommandInput) (InstallCommandResult, error) {
			commands = append(commands, input.Command)
			if strings.Contains(input.Command, " update") {
				return InstallCommandResult{ExitCode: 2, Stderr: "unknown subcommand update"}, nil
			}
			return InstallCommandResult{ExitCode: 0, Stdout: "installed from npm"}, nil
		},
	}
	spec := ProviderSpec{
		Provider: "codex",
		Install: InstallerSpec{
			Kind:           InstallerKindShellCommand,
			DisplayCommand: "npm install -g @openai/codex",
			ShellCommand:   "npm install -g @openai/codex",
		},
	}
	runtimeResolution := providerRuntimeResolution{CLIPath: "/opt/homebrew/bin/codex"}

	command, result, err := service.executeCLIUpdateInstaller(
		context.Background(),
		spec,
		&runtimeResolution,
	)
	if err != nil {
		t.Fatalf("executeCLIUpdateInstaller() error = %v", err)
	}
	if len(commands) != 2 {
		t.Fatalf("commands = %#v, want native update then managed fallback", commands)
	}
	if !strings.Contains(command, "codex update") || !strings.Contains(command, "npm install") {
		t.Fatalf("reported command = %q, want both attempts", command)
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "installed from npm") {
		t.Fatalf("result = %#v, want successful fallback", result)
	}
	if !strings.Contains(result.Stderr, "unknown subcommand update") {
		t.Fatalf("stderr = %q, want native failure retained", result.Stderr)
	}
}
