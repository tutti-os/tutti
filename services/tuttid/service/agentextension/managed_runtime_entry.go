package agentextension

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/service/usercommand"
)

type managedRuntimeEntry = usercommand.Entry

func (m *Manager) managedRuntimeEntry(
	installation Installation,
	finalRoot string,
	declaredExecutable string,
	relativeExecutable string,
) (managedRuntimeEntry, error) {
	commandName := filepath.Base(filepath.Clean(declaredExecutable))
	finalRoot = filepath.Clean(finalRoot)
	finalExecutable := filepath.Clean(filepath.Join(finalRoot, filepath.FromSlash(relativeExecutable)))
	if !pathWithin(finalExecutable, finalRoot) {
		return managedRuntimeEntry{}, errors.New("managed runtime executable entry escapes install root")
	}
	runtimeRoot := filepath.Join(strings.TrimSpace(m.RuntimeInstallDir), installation.AgentKey)
	return usercommand.NewEntry(runtimeRoot, strings.TrimSpace(m.RuntimeBinDir), commandName, finalExecutable)
}

func (m *Manager) isManagedRuntimeExecutable(executable string) bool {
	return usercommand.IsManagedExecutable(executable, strings.TrimSpace(m.RuntimeInstallDir))
}

func validateManagedRuntimeEntry(entry managedRuntimeEntry) error { return entry.Validate() }

func verifyManagedRuntimeEntry(entry managedRuntimeEntry) error { return entry.Verify() }

func publishManagedRuntimeEntry(entry managedRuntimeEntry) error { return entry.Publish() }

func (m *Manager) ensureUserCommandPath(ctx context.Context) error {
	if m.UserPathAdapter == nil {
		return nil
	}
	return m.UserPathAdapter.Ensure(ctx, strings.TrimSpace(m.RuntimeBinDir))
}

func (m *Manager) repairUserCommandPath(ctx context.Context) {
	if err := m.ensureUserCommandPath(ctx); err != nil {
		slog.Warn("agent extension user PATH update failed", "directory", m.RuntimeBinDir, "error", err)
	}
}
