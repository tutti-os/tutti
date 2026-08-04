//go:build windows

package agentstatus

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func newInstallExecCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	extension := strings.ToLower(filepath.Ext(executable))
	if extension != ".cmd" && extension != ".bat" {
		return exec.CommandContext(ctx, executable, args...)
	}
	commandLine := windows.ComposeCommandLine(append([]string{executable}, args...))
	return exec.CommandContext(ctx, installCommandInterpreter(), "/D", "/S", "/C", commandLine)
}

func newInstallShellCommand(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, resolveInstallerShell(), "/D", "/S", "/C", command)
}

func platformExecutableFile(os.FileInfo) bool {
	return true
}

func resolveInstallerShell() string {
	if value := strings.TrimSpace(os.Getenv("ComSpec")); value != "" {
		return value
	}
	return "cmd.exe"
}

func installCommandInterpreter() string {
	return resolveInstallerShell()
}
