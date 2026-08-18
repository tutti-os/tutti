//go:build windows

package agentextension

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func newAgentExtensionCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	switch strings.ToLower(filepath.Ext(executable)) {
	case ".cmd", ".bat":
		// npm and pnpm are batch launchers on Windows and cannot be passed
		// directly to CreateProcess. Preserve structured argv through cmd.exe.
		return exec.CommandContext(
			ctx,
			agentExtensionCommandInterpreter(),
			append([]string{"/D", "/S", "/C", "call", executable}, args...)...,
		)
	default:
		return exec.CommandContext(ctx, executable, args...)
	}
}

func agentExtensionCommandInterpreter() string {
	if value := strings.TrimSpace(os.Getenv("ComSpec")); value != "" {
		return value
	}
	return "cmd.exe"
}
