package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
)

// exposeUserCodexAgentsFile seeds the run-scoped instruction file with the
// user's global Codex instructions. The session-owned file must be a copy:
// WriteManagedBlock adds Tutti's managed policy to it and must never mutate the
// user's real ~/.codex/AGENTS.md.
func exposeUserCodexAgentsFile(codexHome string, userCodexHome string) error {
	source := filepath.Join(userCodexHome, "AGENTS.md")
	sourceContent, sourceExists, err := readRegularCodexAgentsFile(source)
	if err != nil {
		return err
	}

	target := filepath.Join(codexHome, "AGENTS.md")
	targetInfo, err := os.Lstat(target)
	if os.IsNotExist(err) {
		if !sourceExists {
			return nil
		}
		if err := writeRegularCodexAgentsFile(target, sourceContent); err != nil {
			return fmt.Errorf("copy user codex AGENTS.md: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect session codex AGENTS.md: %w", err)
	}

	// Always replace a pre-existing link with a private regular file. This
	// prevents WriteManagedBlock from following a symlink or mutating a hardlink
	// to the user's real ~/.codex/AGENTS.md on the next line of Prepare.
	if targetInfo.Mode()&os.ModeSymlink != 0 {
		if sourceExists {
			if err := writeRegularCodexAgentsFile(target, sourceContent); err != nil {
				return fmt.Errorf("replace session codex AGENTS.md link: %w", err)
			}
			return nil
		}
		if err := os.Remove(target); err != nil {
			return fmt.Errorf("remove session codex AGENTS.md link: %w", err)
		}
		return nil
	}
	if !targetInfo.Mode().IsRegular() {
		return fmt.Errorf("session codex AGENTS.md is not a regular file")
	}

	// Re-materialize an existing regular file too. A hardlink has regular-file
	// mode, so an atomic replacement is what guarantees a new inode without
	// discarding any session-local content already present in the file.
	existing, err := os.ReadFile(target)
	if err != nil {
		return fmt.Errorf("read session codex AGENTS.md: %w", err)
	}
	if err := writeRegularCodexAgentsFile(target, existing); err != nil {
		return fmt.Errorf("isolate session codex AGENTS.md: %w", err)
	}
	return nil
}

func readRegularCodexAgentsFile(path string) ([]byte, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("inspect user codex AGENTS.md: %w", err)
	}
	if !info.Mode().IsRegular() {
		// AGENTS.md is optional. Ignore directories, FIFOs, and other special
		// files instead of blocking runtime preparation while reading them.
		return nil, false, nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, false, fmt.Errorf("read user codex AGENTS.md: %w", err)
	}
	return content, true, nil
}

func writeRegularCodexAgentsFile(path string, content []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".codex-agents-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(content); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
