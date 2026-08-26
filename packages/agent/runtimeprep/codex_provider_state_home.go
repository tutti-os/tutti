package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func resolveCodexProviderStateHome(input PrepareInput) (string, error) {
	configured := strings.TrimSpace(input.ProviderStateHome)
	if configured == "" {
		userHome, err := os.UserHomeDir()
		if err != nil || strings.TrimSpace(userHome) == "" {
			// Preserve the existing Host behavior: an unavailable native user
			// home omits optional Codex state projection without preventing the
			// run-scoped runtime from being prepared.
			return "", nil
		}
		// The implicit Host path keeps native filesystem semantics, including
		// an existing ~/.codex symlink. Strict shape checks below apply only to
		// an embedder-provided provider state root.
		return filepath.Join(userHome, ".codex"), nil
	}
	configured = filepath.Clean(configured)
	if !filepath.IsAbs(configured) || configured == string(filepath.Separator) {
		return "", fmt.Errorf("codex provider state home must be an absolute non-root path: %q", input.ProviderStateHome)
	}
	info, err := os.Lstat(configured)
	if err != nil {
		return "", fmt.Errorf("inspect Codex provider state home: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", fmt.Errorf("codex provider state home must be a real directory: %s", configured)
	}
	return configured, nil
}
