package runtimeprep

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	ConfigDependencyFailureInvalid           = "invalid"
	ConfigDependencyFailureMissing           = "missing"
	ConfigDependencyFailureMaterializeFailed = "materialize_failed"
)

// ConfigDependencyUnavailableError describes a provider configuration file
// reference that cannot be preserved inside a run-scoped provider home.
// DependencyPath is safe to expose over the local API and never contains the
// parent directory of an absolute user path.
type ConfigDependencyUnavailableError struct {
	Provider       string
	ConfigKey      string
	DependencyPath string
	FailureKind    string
	cause          error
}

func (e *ConfigDependencyUnavailableError) Error() string {
	return fmt.Sprintf("%s configuration dependency %s is unavailable", e.Provider, e.ConfigKey)
}

func (e *ConfigDependencyUnavailableError) Unwrap() error {
	return e.cause
}

func materializeCodexConfigRelativeFile(codexHome, userCodexHome, key string) error {
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
		if !codexConfigLineHasKey(trimmed, key) {
			continue
		}
		value, ok := codexConfigStringAssignmentValue(trimmed, key)
		if !ok {
			return codexConfigDependencyError(key, "", ConfigDependencyFailureInvalid, nil)
		}
		return materializeCodexConfigDependency(codexHome, userCodexHome, key, value)
	}
	return nil
}

func materializeCodexConfigDependency(codexHome, userCodexHome, key, rawPath string) error {
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" || strings.ContainsAny(rawPath, "\x00\r\n") {
		return codexConfigDependencyError(key, rawPath, ConfigDependencyFailureInvalid, nil)
	}
	if filepath.IsAbs(rawPath) {
		if err := validateCodexConfigDependencyFile(rawPath); err != nil {
			return codexConfigDependencyFileError(key, rawPath, err)
		}
		return nil
	}
	cleanPath := filepath.Clean(rawPath)
	if cleanPath == "." || codexConfigDependencyPathHasTraversal(rawPath) {
		return codexConfigDependencyError(key, rawPath, ConfigDependencyFailureInvalid, nil)
	}
	sourcePath := filepath.Join(userCodexHome, cleanPath)
	if err := validateCodexConfigDependencyFile(sourcePath); err != nil {
		return codexConfigDependencyFileError(key, rawPath, err)
	}
	targetPath := filepath.Join(codexHome, cleanPath)
	if !codexConfigDependencyPathWithinRoot(codexHome, targetPath) {
		return codexConfigDependencyError(key, rawPath, ConfigDependencyFailureInvalid, nil)
	}
	if err := exposeCodexConfigDependencyFile(sourcePath, targetPath); err != nil {
		return codexConfigDependencyError(key, rawPath, ConfigDependencyFailureMaterializeFailed, err)
	}
	return nil
}

func codexConfigDependencyPathHasTraversal(path string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(path), "/") {
		if segment == "." || segment == ".." {
			return true
		}
	}
	return false
}

func codexConfigDependencyPathWithinRoot(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

var errCodexConfigDependencyNotRegular = errors.New("configuration dependency is not a regular file")

func validateCodexConfigDependencyFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errCodexConfigDependencyNotRegular
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	return file.Close()
}

func exposeCodexConfigDependencyFile(source, target string) error {
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return validateCodexConfigDependencyFile(target)
		}
		linkTarget, readErr := os.Readlink(target)
		if readErr != nil {
			return readErr
		}
		if !filepath.IsAbs(linkTarget) {
			linkTarget = filepath.Join(filepath.Dir(target), linkTarget)
		}
		if filepath.Clean(linkTarget) == filepath.Clean(source) {
			return nil
		}
		if err := os.Remove(target); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	if err := os.Symlink(source, target); err != nil {
		if copyErr := copyFile(source, target, 0o600); copyErr != nil {
			return fmt.Errorf("symlink failed: %v; copy failed: %w", err, copyErr)
		}
	}
	return nil
}

func codexConfigDependencyFileError(key, rawPath string, err error) error {
	failureKind := ConfigDependencyFailureMaterializeFailed
	if os.IsNotExist(err) {
		failureKind = ConfigDependencyFailureMissing
	} else if errors.Is(err, errCodexConfigDependencyNotRegular) {
		failureKind = ConfigDependencyFailureInvalid
	}
	return codexConfigDependencyError(key, rawPath, failureKind, err)
}

func codexConfigDependencyError(key, rawPath, failureKind string, cause error) error {
	return &ConfigDependencyUnavailableError{
		Provider:       "codex",
		ConfigKey:      strings.TrimSpace(key),
		DependencyPath: safeCodexConfigDependencyPath(rawPath),
		FailureKind:    failureKind,
		cause:          cause,
	}
}

func safeCodexConfigDependencyPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if filepath.IsAbs(path) {
		return filepath.Base(filepath.Clean(path))
	}
	return filepath.Clean(path)
}

func exposeUserCodexModelCatalog(codexHome, userCodexHome string) error {
	return materializeCodexConfigRelativeFile(codexHome, userCodexHome, "model_catalog_json")
}

func exposeUserCodexInstructionsFile(codexHome, userCodexHome string) error {
	return materializeCodexConfigRelativeFile(codexHome, userCodexHome, "model_instructions_file")
}
