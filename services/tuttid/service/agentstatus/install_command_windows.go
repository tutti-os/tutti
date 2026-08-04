//go:build windows

package agentstatus

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func newInstallExecCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	extension := strings.ToLower(filepath.Ext(executable))
	if extension != ".cmd" && extension != ".bat" {
		return exec.CommandContext(ctx, executable, args...)
	}
	// Batch files cannot be passed directly to CreateProcess. Pass the argv
	// pieces to cmd.exe separately so Go performs the Windows quoting exactly
	// once. ComposeCommandLine produced a quoted command string and then exec
	// quoted that string again while building cmd.exe's process command line;
	// cmd consequently treated the leading quote as part of the executable
	// name (notably for npm.cmd under "C:\\Program Files"). `call` also keeps
	// cmd's batch-file semantics explicit when the script invokes another
	// batch file.
	return exec.CommandContext(
		ctx,
		installCommandInterpreter(),
		append([]string{"/D", "/S", "/C", "call", executable}, args...)...,
	)
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

func managedNPMInstallRunner() string {
	return "cmd.exe /D /S /C call"
}
