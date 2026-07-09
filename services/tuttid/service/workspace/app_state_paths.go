package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func (s *AppCenterService) packageCacheDir(appID string, version string) string {
	return filepath.Join(s.packageCacheRoot(), safeAppPathSegment(appID), safeAppPathSegment(version))
}

func (s *AppCenterService) packageCacheRoot() string {
	return appPackageCacheRoot(s.stateDir())
}

func (s *AppCenterService) packageCacheTrashRoot() string {
	return appPackageTrashRoot(s.stateDir())
}

func appPackageCacheRoot(stateDir string) string {
	return filepath.Join(stateDir, "apps", "packages")
}

func appPackageTrashRoot(stateDir string) string {
	return filepath.Join(appPackageCacheRoot(stateDir), ".trash")
}

func (s *AppCenterService) workspaceAppStateRoot(workspaceID string, appID string) string {
	return filepath.Join(
		s.stateDir(),
		"apps",
		"installations",
		safeAppPathSegment(appID),
		workspaceAppScopeSegment(workspaceID, appID),
	)
}

func (s *AppCenterService) removeWorkspaceAppStateRoot(workspaceID string, appID string) error {
	if err := os.RemoveAll(s.workspaceAppStateRoot(workspaceID, appID)); err != nil {
		return fmt.Errorf("delete workspace app state dir: %w", err)
	}
	return nil
}

func (s *AppCenterService) removeAllWorkspaceAppStateRoots(appID string) error {
	stateRoot := filepath.Join(s.stateDir(), "apps", "installations", safeAppPathSegment(appID))
	if err := os.RemoveAll(stateRoot); err != nil {
		return fmt.Errorf("delete workspace app state dir: %w", err)
	}
	return nil
}

func workspaceAppScopeSegment(workspaceID string, appID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(appID)))
	return hex.EncodeToString(sum[:])[:16]
}

func (s *AppCenterService) stateDir() string {
	if strings.TrimSpace(s.StateDir) != "" {
		return s.StateDir
	}
	if value := strings.TrimSpace(os.Getenv("TUTTI_STATE_DIR")); value != "" {
		return value
	}
	return tuttitypes.DefaultStateDir()
}

func safeAppPathSegment(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "_"
	}

	var builder strings.Builder
	for _, char := range value {
		switch {
		case char == '-' || char == '_' || char == '.':
			builder.WriteRune(char)
		case unicode.IsLetter(char) || unicode.IsDigit(char):
			builder.WriteRune(char)
		default:
			builder.WriteRune('_')
		}
	}
	result := builder.String()
	if result == "" {
		return "_"
	}
	return result
}
