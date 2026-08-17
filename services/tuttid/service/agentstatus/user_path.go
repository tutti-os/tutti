package agentstatus

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
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

// publishManagedInstallBinaryDir registers a known Windows managed-agent
// directory only after the installed binary has passed the caller's runtime
// verification. Fresh installs use .local\bin; existing installations from
// older Tutti releases may remain in the legacy .local npm prefix. Keeping the
// allowlist here prevents a provider-specific installer or a custom InstallDir
// from writing an arbitrary directory to the user's PATH.
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
	binaryDir := filepath.Clean(filepath.Dir(binaryPath))
	managedDir := ""
	for _, candidate := range runtimecmd.UserManagedNPMExecutableDirs(home) {
		if sameWindowsPath(binaryDir, candidate) {
			managedDir = filepath.Clean(candidate)
			break
		}
	}
	if managedDir == "" {
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

// publishDetectedManagedBinaryDirs makes an already-installed Tutti-managed npm
// CLI available to new Windows processes without reinstalling or relocating it.
// Status detection has already verified the runtime; the package lookup below
// additionally proves that the launcher belongs to the provider's managed npm
// package before any user PATH mutation is attempted.
func (s Service) publishDetectedManagedBinaryDirs(ctx context.Context, specs []ProviderSpec, statuses []ProviderStatus) {
	if s.UserPathAdapter == nil || runtime.GOOS != "windows" {
		return
	}
	for index := range min(len(specs), len(statuses)) {
		status := statuses[index]
		if status.Availability.Status != AvailabilityReady && status.Availability.Status != AvailabilityAuthRequired {
			continue
		}
		binaryPath := strings.TrimSpace(status.CLI.BinaryPath)
		packageName := strings.TrimSpace(specs[index].Update.PackageName)
		if binaryPath == "" || packageName == "" || !providerRuntimeUsesManagedNPM(binaryPath, packageName) {
			continue
		}
		if err := s.publishManagedInstallBinaryDir(ctx, binaryPath); err != nil {
			// Read-only status remains available even when Windows rejects the
			// best-effort environment repair. Explicit install/update actions
			// still surface the same failure to the caller.
			slog.Warn(
				"agent provider detected user PATH update failed",
				"provider", status.Provider,
				"binaryPath", binaryPath,
				"error", err,
			)
		}
	}
}

func sameWindowsPath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(strings.TrimSpace(left)), filepath.Clean(strings.TrimSpace(right)))
}
