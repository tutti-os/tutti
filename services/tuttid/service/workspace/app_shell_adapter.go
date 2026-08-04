package workspace

import (
	"context"
	"os/exec"
)

// AppShellAdapter adapts the stable POSIX script contract to the host
// platform. Callers own lifecycle and environment setup; implementations only
// decide how a package script is invoked.
type AppShellAdapter interface {
	ValidateScript(string) error
	Command(context.Context, string) (command *exec.Cmd, binDirs []string, err error)
	EnvironmentOverrides() []string
}

type platformAppShellAdapter struct{}

func NewPlatformAppShellAdapter() AppShellAdapter {
	return platformAppShellAdapter{}
}

func resolveAppShellAdapter(adapter AppShellAdapter) AppShellAdapter {
	if adapter != nil {
		return adapter
	}
	return platformAppShellAdapter{}
}
