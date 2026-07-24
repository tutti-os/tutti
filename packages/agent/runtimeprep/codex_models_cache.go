package runtimeprep

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const codexModelsCacheAuthorityFile = ".models_cache.authority.sha256"

var codexModelsCacheAuthorityMu sync.Mutex

// exposeUserCodexModelsCache gives every run-scoped CODEX_HOME one shared,
// process-default model cache. Codex refreshes models_cache.json before it emits
// thread.started; keeping that writable cache behind a symlink lets a refresh
// from one AgentGUI session remove the cold catalog request from later sessions.
//
// Cache reuse is fenced by the current global config, auth and referenced model
// catalog. Codex's own cache file does not record provider identity, so carrying
// it across a global input change can expose another provider's model list. The
// link is installed even before the source exists; Codex treats that as a cache
// miss and writes the new authority-scoped cache through the link.
func exposeUserCodexModelsCache(codexHome, userCodexHome string) error {
	codexModelsCacheAuthorityMu.Lock()
	defer codexModelsCacheAuthorityMu.Unlock()

	target := filepath.Join(codexHome, "models_cache.json")
	if err := reconcileUserCodexModelsCacheAuthority(target, userCodexHome); err != nil {
		return err
	}
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

func reconcileUserCodexModelsCacheAuthority(target, userCodexHome string) error {
	authority, err := userCodexModelsCacheAuthority(userCodexHome)
	if err != nil {
		return err
	}
	fencePath := filepath.Join(userCodexHome, codexModelsCacheAuthorityFile)
	if existing, readErr := os.ReadFile(fencePath); readErr == nil && strings.TrimSpace(string(existing)) == authority {
		return nil
	} else if readErr != nil && !os.IsNotExist(readErr) {
		return fmt.Errorf("read codex models cache authority: %w", readErr)
	}

	sharedCache := filepath.Join(userCodexHome, "models_cache.json")
	if err := removeCodexModelsCacheFile(sharedCache); err != nil {
		return err
	}
	if info, statErr := os.Lstat(target); statErr == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			if err := removeCodexModelsCacheFile(target); err != nil {
				return err
			}
		}
	} else if !os.IsNotExist(statErr) {
		return fmt.Errorf("inspect run-scoped codex models cache: %w", statErr)
	}
	return writeCodexModelsCacheAuthority(fencePath, authority)
}

func userCodexModelsCacheAuthority(userCodexHome string) (string, error) {
	digest := sha256.New()
	configPath := filepath.Join(userCodexHome, "config.toml")
	config, err := hashCodexModelsCacheAuthorityFile(digest, "config", configPath)
	if err != nil {
		return "", err
	}
	if _, err := hashCodexModelsCacheAuthorityFile(digest, "auth", filepath.Join(userCodexHome, "auth.json")); err != nil {
		return "", err
	}
	if catalogPath := codexModelCatalogPath(config, userCodexHome); catalogPath != "" {
		if _, err := hashCodexModelsCacheAuthorityFile(digest, "model_catalog", catalogPath); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func hashCodexModelsCacheAuthorityFile(digest io.Writer, label, path string) ([]byte, error) {
	content, err := os.ReadFile(path)
	switch {
	case err == nil:
		_, _ = io.WriteString(digest, label+"\x00present\x00")
		_, _ = digest.Write(content)
		_, _ = io.WriteString(digest, "\x00")
		return content, nil
	case os.IsNotExist(err):
		_, _ = io.WriteString(digest, label+"\x00missing\x00")
		return nil, nil
	default:
		return nil, fmt.Errorf("read codex models cache authority %s: %w", label, err)
	}
}

func codexModelCatalogPath(config []byte, userCodexHome string) string {
	lines := strings.Split(strings.ReplaceAll(string(config), "\r\n", "\n"), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			return ""
		}
		value, ok := codexConfigStringAssignmentValue(trimmed, "model_catalog_json")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" {
			return ""
		}
		if filepath.IsAbs(value) {
			return filepath.Clean(value)
		}
		cleanRel := filepath.Clean(value)
		if cleanRel == "." || cleanRel == ".." || strings.HasPrefix(cleanRel, ".."+string(filepath.Separator)) {
			return ""
		}
		return filepath.Join(userCodexHome, cleanRel)
	}
	return ""
}

func removeCodexModelsCacheFile(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect codex models cache %s: %w", path, err)
	}
	if info.IsDir() {
		return fmt.Errorf("codex models cache is a directory: %s", path)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove stale codex models cache %s: %w", path, err)
	}
	return nil
}

func writeCodexModelsCacheAuthority(path, authority string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create codex models cache authority directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".models-cache-authority-*.tmp")
	if err != nil {
		return fmt.Errorf("create codex models cache authority: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("chmod codex models cache authority: %w", err)
	}
	if _, err := temporary.WriteString(authority + "\n"); err != nil {
		return fmt.Errorf("write codex models cache authority: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close codex models cache authority: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("commit codex models cache authority: %w", err)
	}
	return nil
}
