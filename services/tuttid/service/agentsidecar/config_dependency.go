package agentsidecar

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	agentsidecarbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentsidecar"
)

const (
	ConfigDependencyFailureInvalid           = "invalid"
	ConfigDependencyFailureMissing           = "missing"
	ConfigDependencyFailureMaterializeFailed = "materialize_failed"
)

type ConfigDependencyUnavailableError struct {
	Provider       string
	ConfigKey      string
	DependencyPath string
	FailureKind    string
	cause          error
}

func (e *ConfigDependencyUnavailableError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s configuration dependency %s is unavailable", strings.TrimSpace(e.Provider), strings.TrimSpace(e.ConfigKey))
}

func (e *ConfigDependencyUnavailableError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

type configDependencyMaterializeInput struct {
	Provider   string
	ConfigKey  string
	RawPath    string
	SourceRoot string
	TargetRoot string
	Manifest   *agentsidecarbiz.Manifest
}

func materializeConfigDependency(input configDependencyMaterializeInput) error {
	rawPath := strings.TrimSpace(input.RawPath)
	if rawPath == "" || strings.ContainsAny(rawPath, "\x00\r\n") {
		return configDependencyError(input, "", ConfigDependencyFailureInvalid, nil)
	}
	if filepath.IsAbs(rawPath) {
		if err := validateConfigDependencyFile(rawPath); err != nil {
			return configDependencyFileError(input, rawPath, err)
		}
		return nil
	}
	cleanPath := filepath.Clean(rawPath)
	if cleanPath == "." || configDependencyPathHasTraversal(rawPath) {
		return configDependencyError(input, filepath.Join(input.SourceRoot, cleanPath), ConfigDependencyFailureInvalid, nil)
	}
	sourcePath := filepath.Join(input.SourceRoot, cleanPath)
	if err := validateConfigDependencyFile(sourcePath); err != nil {
		return configDependencyFileError(input, sourcePath, err)
	}
	targetPath := filepath.Join(input.TargetRoot, cleanPath)
	rel, err := filepath.Rel(input.TargetRoot, targetPath)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return configDependencyError(input, sourcePath, ConfigDependencyFailureInvalid, nil)
	}
	created, err := exposeConfigDependencyFile(sourcePath, targetPath)
	if err != nil {
		return configDependencyError(input, sourcePath, ConfigDependencyFailureMaterializeFailed, err)
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(targetPath, "provider-config-dependency", created)
	}
	return nil
}

func configDependencyPathHasTraversal(path string) bool {
	for _, segment := range strings.Split(path, string(filepath.Separator)) {
		if segment == "." || segment == ".." {
			return true
		}
	}
	return false
}

var errConfigDependencyNotRegular = errors.New("configuration dependency is not a regular file")

func validateConfigDependencyFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errConfigDependencyNotRegular
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	return file.Close()
}

func configDependencyFileError(input configDependencyMaterializeInput, sourcePath string, err error) error {
	kind := ConfigDependencyFailureMaterializeFailed
	if os.IsNotExist(err) {
		kind = ConfigDependencyFailureMissing
	} else if errors.Is(err, errConfigDependencyNotRegular) {
		kind = ConfigDependencyFailureInvalid
	}
	return configDependencyError(input, sourcePath, kind, err)
}

func configDependencyError(input configDependencyMaterializeInput, sourcePath string, failureKind string, cause error) error {
	err := &ConfigDependencyUnavailableError{
		Provider:       strings.TrimSpace(input.Provider),
		ConfigKey:      strings.TrimSpace(input.ConfigKey),
		DependencyPath: safeConfigDependencyPath(input.RawPath),
		FailureKind:    failureKind,
		cause:          cause,
	}
	args := []any{"provider", err.Provider, "config_key", err.ConfigKey, "dependency_path", err.DependencyPath, "failure_kind", err.FailureKind}
	if sourcePath != "" {
		args = append(args, "source_path", sourcePath)
	}
	if cause != nil {
		args = append(args, "error", cause)
	}
	slog.Error("agent configuration dependency unavailable", args...)
	return err
}

func safeConfigDependencyPath(path string) string {
	path = strings.TrimSpace(path)
	if filepath.IsAbs(path) {
		return filepath.Base(filepath.Clean(path))
	}
	return filepath.Clean(path)
}

func exposeConfigDependencyFile(source string, target string) (bool, error) {
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			linkTarget, readErr := os.Readlink(target)
			if readErr != nil {
				return false, readErr
			}
			if !filepath.IsAbs(linkTarget) {
				linkTarget = filepath.Join(filepath.Dir(target), linkTarget)
			}
			if filepath.Clean(linkTarget) == filepath.Clean(source) {
				return false, nil
			}
			if err := os.Remove(target); err != nil {
				return false, err
			}
		} else {
			if err := validateConfigDependencyFile(target); err != nil {
				return false, err
			}
			return false, nil
		}
	} else if !os.IsNotExist(err) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return false, err
	}
	if err := os.Symlink(source, target); err != nil {
		if copyErr := copyFile(source, target, 0o600); copyErr != nil {
			return false, fmt.Errorf("symlink failed: %v; copy failed: %w", err, copyErr)
		}
	}
	return true, nil
}
