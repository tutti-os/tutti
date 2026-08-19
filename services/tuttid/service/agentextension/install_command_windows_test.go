//go:build windows

package agentextension

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestAgentExtensionCommandUsesCmdForNPMShim(t *testing.T) {
	t.Setenv("ComSpec", `C:\Windows\System32\cmd.exe`)
	command := newAgentExtensionCommand(
		context.Background(),
		`C:\Program Files\nodejs\npm.cmd`,
		"install", "--prefix", `C:\runtime root`, "@example/probe@1.0.0",
	)
	want := []string{
		`C:\Windows\System32\cmd.exe`, "/D", "/S", "/C", "call",
		`C:\Program Files\nodejs\npm.cmd`, "install", "--prefix", `C:\runtime root`, "@example/probe@1.0.0",
	}
	if command.Path != want[0] || !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("Windows npm command = path %q args %#v, want %#v", command.Path, command.Args, want)
	}
}

func TestAgentExtensionCommandExecutesBatchLauncher(t *testing.T) {
	launcher := filepath.Join(t.TempDir(), "generic-agent.cmd")
	if err := os.WriteFile(launcher, []byte("@echo off\r\necho 1.2.3\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := newAgentExtensionCommand(context.Background(), launcher, "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("execute Windows batch launcher: %v; output=%q", err, output)
	}
	if strings.TrimSpace(string(output)) != "1.2.3" {
		t.Fatalf("Windows batch launcher output = %q, want 1.2.3", output)
	}
}
