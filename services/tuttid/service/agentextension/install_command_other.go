//go:build !windows

package agentextension

import (
	"context"
	"os/exec"
)

func newAgentExtensionInstallCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, executable, args...)
}
