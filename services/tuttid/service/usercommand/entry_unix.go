//go:build !windows

package usercommand

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func platformEntryName(commandName string) string { return commandName }

func platformSamePath(left, right string) bool { return left == right }

func validatePlatformEntry(path, runtimeRoot, label string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("%s is already occupied: %s", label, path)
	}
	target, err := resolvedSymlinkTarget(path)
	if err != nil {
		return err
	}
	if !pathWithin(target, runtimeRoot) {
		return fmt.Errorf("%s points outside runtime root: %s", label, path)
	}
	return nil
}

func validateExactPlatformEntry(path, expectedTarget, label string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("%s is already occupied: %s", label, path)
	}
	target, err := resolvedSymlinkTarget(path)
	if err != nil {
		return err
	}
	if !samePath(target, expectedTarget) {
		return fmt.Errorf("%s is not owned by Tutti: %s", label, path)
	}
	return nil
}

func ensurePlatformEntry(path, target string) (bool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	if _, err := os.Lstat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.Symlink(target, path); err != nil {
		return false, err
	}
	return true, nil
}

func replacePlatformEntry(path, target string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	relativeTarget, err := filepath.Rel(dir, target)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, ".runtime-entry-*")
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
	return replaceFile(path, temporaryPath)
}

func resolvePlatformEntry(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}

func resolvePlatformFinalExecutable(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("managed command executable is a directory: %s", resolved)
	}
	return resolved, nil
}

func isPlatformManagedExecutable(executable, runtimeRoot string) bool {
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

func replaceFile(path, temporaryPath string) error {
	return os.Rename(temporaryPath, path)
}
