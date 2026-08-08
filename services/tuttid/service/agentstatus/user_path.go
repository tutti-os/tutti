package agentstatus

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"strings"
)

// UserPathAdapter publishes a Tutti-owned executable directory to the current
// user's command search path. The platform implementation owns the native
// persistence and environment-refresh details; installer workflows only name
// the directory they actually used.
type UserPathAdapter interface {
	Ensure(context.Context, string) error
}

// NewUserPathAdapter selects the platform implementation at the daemon
// composition boundary. Non-Windows builds intentionally return nil because
// their existing shell PATH contract is unchanged.
func NewUserPathAdapter() UserPathAdapter {
	return newUserPathAdapter()
}

// publishManagedInstallBinaryDir registers the canonical Windows managed-agent
// directory only after the installed binary has passed the caller's runtime
// verification. Keeping the policy here prevents a provider-specific
// installer or a custom InstallDir from writing an arbitrary directory to the
// user's PATH.
func (s Service) publishManagedInstallBinaryDir(ctx context.Context, binaryPath string) error {
	adapter := s.UserPathAdapter
	if adapter == nil || runtime.GOOS != "windows" {
		return nil
	}
	binaryPath = strings.TrimSpace(binaryPath)
	if binaryPath == "" {
		return nil
	}
	home, err := s.homeDir()
	if err != nil {
		return fmt.Errorf("resolve user home for PATH update: %w", err)
	}
	if strings.TrimSpace(home) == "" {
		return fmt.Errorf("resolve user home for PATH update: home directory is empty")
	}
	managedDir := filepath.Clean(filepath.Join(home, ".local", "bin"))
	if !sameWindowsPath(filepath.Dir(binaryPath), managedDir) {
		// Version-manager and user-managed installs remain outside Tutti's PATH
		// ownership boundary.
		return nil
	}
	if err := adapter.Ensure(ctx, managedDir); err != nil {
		slog.Warn(
			"agent provider user PATH update failed",
			"directory", managedDir,
			"error", err,
		)
		return err
	}
	return nil
}

func sameWindowsPath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(strings.TrimSpace(left)), filepath.Clean(strings.TrimSpace(right)))
}
