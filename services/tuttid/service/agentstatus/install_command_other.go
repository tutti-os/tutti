//go:build !windows

package agentstatus

import (
	"context"
	"os"
	"os/exec"
	"strings"
)

func newInstallExecCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, executable, args...)
}

func newInstallShellCommand(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, resolveInstallerShell(), "-lc", command)
}

func resolveInstallerShell() string {
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	return "/bin/zsh"
}

func platformExecutableFile(info os.FileInfo) bool {
	return info.Mode().Perm()&0o111 != 0
}
