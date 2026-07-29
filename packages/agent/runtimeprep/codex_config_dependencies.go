package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// materializeCodexConfigRelativeFile reads a top-level string key from
// codexHome/config.toml. When the value is a relative path the referenced file
// is materialized into the run-scoped CODEX_HOME so Codex can resolve it at
// startup. Absolute paths are left as-is (readable from the host filesystem).
//
// When requireFile is true, a missing, unreadable, or illegal relative
// dependency stops preparation with a diagnostic error. When false the
// function silently skips missing sources (backward-compatible with the
// existing model_catalog_json behavior).
func materializeCodexConfigRelativeFile(codexHome, userCodexHome, key string, requireFile bool) error {
	configPath := filepath.Join(codexHome, "config.toml")
	contentBytes, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read codex config for %s: %w", key, err)
	}
	lines := strings.Split(strings.ReplaceAll(string(contentBytes), "\r\n", "\n"), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		value, ok := codexConfigStringAssignmentValue(trimmed, key)
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" || filepath.IsAbs(value) {
			return nil
		}
		cleanRel := filepath.Clean(value)
		if cleanRel == "." || cleanRel == ".." || strings.HasPrefix(cleanRel, ".."+string(filepath.Separator)) {
			if requireFile {
				return fmt.Errorf("codex config %s: illegal relative path %q", key, value)
			}
			return nil
		}
		source := filepath.Join(userCodexHome, cleanRel)
		if info, err := os.Stat(source); err != nil || info.IsDir() {
			if requireFile {
				if err != nil {
					return fmt.Errorf("codex config %s: %q not found or unreadable: %w", key, value, err)
				}
				return fmt.Errorf("codex config %s: %q is a directory, not a file", key, value)
			}
			return nil
		}
		target := filepath.Join(codexHome, cleanRel)
		if _, err := os.Lstat(target); err == nil {
			return nil
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect codex %s: %w", key, err)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return fmt.Errorf("create codex %s parent: %w", key, err)
		}
		if err := os.Symlink(source, target); err != nil {
			if copyErr := copyFile(source, target, 0o600); copyErr != nil {
				return fmt.Errorf("expose codex %s %s: symlink failed: %v; copy failed: %w", key, cleanRel, err, copyErr)
			}
		}
		return nil
	}
	return nil
}

// exposeUserCodexModelCatalog mirrors a relative model_catalog_json path into
// the run-scoped CODEX_HOME. Tutti copies config.toml alone; tools such as
// CC Switch write model_catalog_json = "cc-switch-model-catalog.json", which
// Codex resolves against CODEX_HOME. Without the catalog file, thread/start
// fails with ENOENT and Tutti surfaces "agent session is not connected".
//
// Absolute catalog paths stay readable from the host filesystem and need no
// mirror. Missing keys or missing source files are no-ops (backward-compatible
// behavior; CC Switch may write catalog paths before the file is populated).
func exposeUserCodexModelCatalog(codexHome string, userCodexHome string) error {
	return materializeCodexConfigRelativeFile(codexHome, userCodexHome, "model_catalog_json", false)
}

// exposeUserCodexInstructionsFile mirrors a relative model_instructions_file
// path into the run-scoped CODEX_HOME. Like model_catalog_json, Codex resolves
// relative paths against CODEX_HOME, so a user-configured instructions file
// must be materialized together with config.toml.
//
// Unlike model_catalog_json this requires the file to exist: the user
// explicitly configured it and a missing or unreadable file is a diagnosable
// configuration error rather than a transient tool state.
func exposeUserCodexInstructionsFile(codexHome string, userCodexHome string) error {
	return materializeCodexConfigRelativeFile(codexHome, userCodexHome, "model_instructions_file", true)
}
