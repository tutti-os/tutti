package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
)

// exposeUserCodexModelsCache gives every run-scoped CODEX_HOME one shared,
// process-default model cache. Codex refreshes models_cache.json before it emits
// thread.started; keeping that writable cache behind a symlink lets a refresh
// from one AgentGUI session remove the cold catalog request from later sessions.
//
// The link is installed even before the source exists. Codex treats the first
// read as a cache miss, then its normal write creates the source file through
// the link. An existing run-scoped cache remains authoritative for that run and
// is never replaced during resume preparation.
func exposeUserCodexModelsCache(codexHome, userCodexHome string) error {
	target := filepath.Join(codexHome, "models_cache.json")
	if _, err := os.Lstat(target); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect codex models cache: %w", err)
	}

	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		return fmt.Errorf("create shared codex home for models cache: %w", err)
	}
	source := filepath.Join(userCodexHome, "models_cache.json")
	symlinkErr := os.Symlink(source, target)
	if symlinkErr == nil {
		return nil
	}
	info, statErr := os.Stat(source)
	if os.IsNotExist(statErr) {
		// Platforms that cannot create the link have no cache to copy yet. The
		// run remains usable and Codex will create its ordinary local cache.
		return nil
	}
	if statErr != nil {
		return fmt.Errorf("inspect shared codex models cache after symlink failure: %w", statErr)
	}
	if info.IsDir() {
		return fmt.Errorf("shared codex models cache is a directory: %s", source)
	}
	if copyErr := copyFile(source, target, 0o600); copyErr != nil {
		return fmt.Errorf("expose codex models cache: symlink failed: %v; copy failed: %w", symlinkErr, copyErr)
	}
	return nil
}
