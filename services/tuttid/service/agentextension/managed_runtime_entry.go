package agentextension

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type managedRuntimeEntry struct {
	runtimeRoot     string
	stablePath      string
	userPath        string
	finalExecutable string
}

func (m *Manager) managedRuntimeEntry(
	installation Installation,
	declaredExecutable string,
	relativeExecutable string,
) (managedRuntimeEntry, error) {
	runtimeRoot := strings.TrimSpace(m.RuntimeInstallDir)
	userBinDir := strings.TrimSpace(m.RuntimeBinDir)
	if runtimeRoot == "" || userBinDir == "" {
		return managedRuntimeEntry{}, errors.New("managed runtime executable directories are not configured")
	}
	commandName := filepath.Base(filepath.Clean(declaredExecutable))
	if commandName == "" || commandName == "." || commandName == string(filepath.Separator) {
		return managedRuntimeEntry{}, errors.New("managed runtime executable name is invalid")
	}
	finalRoot := m.managedRuntimeRoot(installation)
	finalExecutable := filepath.Clean(filepath.Join(finalRoot, filepath.FromSlash(relativeExecutable)))
	if !pathWithin(finalExecutable, finalRoot) {
		return managedRuntimeEntry{}, errors.New("managed runtime executable entry escapes install root")
	}
	return managedRuntimeEntry{
		runtimeRoot:     filepath.Clean(runtimeRoot),
		stablePath:      filepath.Join(runtimeRoot, installation.AgentKey, "bin", commandName),
		userPath:        filepath.Join(userBinDir, commandName),
		finalExecutable: finalExecutable,
	}, nil
}

func (m *Manager) isManagedRuntimeExecutable(executable string) bool {
	runtimeRoot := strings.TrimSpace(m.RuntimeInstallDir)
	if runtimeRoot == "" {
		return false
	}
	resolvedExecutable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return false
	}
	resolvedRuntimeRoot, err := filepath.EvalSymlinks(runtimeRoot)
	if err != nil {
		return false
	}
	return pathWithin(resolvedExecutable, resolvedRuntimeRoot)
}

func validateManagedRuntimeEntry(entry managedRuntimeEntry) error {
	if err := validateStableRuntimeEntry(entry); err != nil {
		return err
	}
	info, err := os.Lstat(entry.userPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("user executable path is already occupied: %s", entry.userPath)
	}
	target, err := resolvedSymlinkTarget(entry.userPath)
	if err != nil {
		return err
	}
	if filepath.Clean(target) != filepath.Clean(entry.stablePath) {
		return fmt.Errorf("user executable symlink is not owned by Tutti: %s", entry.userPath)
	}
	return nil
}

func verifyManagedRuntimeEntry(entry managedRuntimeEntry) error {
	if err := validateManagedRuntimeEntry(entry); err != nil {
		return err
	}
	for label, path := range map[string]string{
		"managed runtime entry": entry.stablePath,
		"user executable entry": entry.userPath,
	} {
		info, err := os.Lstat(path)
		if err != nil {
			return fmt.Errorf("%s is unavailable: %w", label, err)
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return fmt.Errorf("%s is not a symlink: %s", label, path)
		}
	}
	resolved, err := filepath.EvalSymlinks(entry.userPath)
	if err != nil {
		return fmt.Errorf("resolve user executable entry: %w", err)
	}
	expected, err := filepath.EvalSymlinks(entry.finalExecutable)
	if err != nil {
		return fmt.Errorf("resolve managed runtime executable: %w", err)
	}
	if filepath.Clean(resolved) != filepath.Clean(expected) {
		return fmt.Errorf("user executable entry resolves to unexpected runtime: %s", entry.userPath)
	}
	return nil
}

func validateStableRuntimeEntry(entry managedRuntimeEntry) error {
	info, err := os.Lstat(entry.stablePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("managed runtime entry is already occupied: %s", entry.stablePath)
	}
	target, err := resolvedSymlinkTarget(entry.stablePath)
	if err != nil {
		return err
	}
	if !pathWithin(target, entry.runtimeRoot) {
		return fmt.Errorf("managed runtime entry points outside runtime root: %s", entry.stablePath)
	}
	return nil
}

func publishManagedRuntimeEntry(entry managedRuntimeEntry) error {
	createdUserEntry, err := ensureUserRuntimeEntry(entry)
	if err != nil {
		return err
	}
	if err := replaceStableRuntimeEntry(entry); err != nil {
		if createdUserEntry {
			_ = os.Remove(entry.userPath)
		}
		return err
	}
	return nil
}

func ensureUserRuntimeEntry(entry managedRuntimeEntry) (bool, error) {
	if err := os.MkdirAll(filepath.Dir(entry.userPath), 0o755); err != nil {
		return false, err
	}
	if _, err := os.Lstat(entry.userPath); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.Symlink(entry.stablePath, entry.userPath); err != nil {
		return false, err
	}
	return true, nil
}

func replaceStableRuntimeEntry(entry managedRuntimeEntry) error {
	stableDir := filepath.Dir(entry.stablePath)
	if err := os.MkdirAll(stableDir, 0o755); err != nil {
		return err
	}
	relativeTarget, err := filepath.Rel(stableDir, entry.finalExecutable)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(stableDir, ".runtime-entry-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	if closeErr := temporary.Close(); closeErr != nil {
		_ = os.Remove(temporaryPath)
		return closeErr
	}
	if err := os.Remove(temporaryPath); err != nil {
		return err
	}
	defer os.Remove(temporaryPath)
	if err := os.Symlink(relativeTarget, temporaryPath); err != nil {
		return err
	}

	backupPath := temporaryPath + ".previous"
	hadPrevious := false
	if _, err := os.Lstat(entry.stablePath); err == nil {
		if err := os.Rename(entry.stablePath, backupPath); err != nil {
			return err
		}
		hadPrevious = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(temporaryPath, entry.stablePath); err != nil {
		if hadPrevious {
			_ = os.Rename(backupPath, entry.stablePath)
		}
		return err
	}
	if hadPrevious {
		_ = os.Remove(backupPath)
	}
	return nil
}

func resolvedSymlinkTarget(path string) (string, error) {
	target, err := os.Readlink(path)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(path), target)
	}
	return filepath.Clean(target), nil
}
