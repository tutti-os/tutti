package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

const tuttiBundledRTKPathEnv = "TUTTI_BUNDLED_RTK_PATH"

func resolveTuttiRTKExecutable(
	ctx context.Context,
	resolver managedruntime.ProfileResolver,
) (string, error) {
	if bundled := strings.TrimSpace(os.Getenv(tuttiBundledRTKPathEnv)); bundled != "" {
		return validateTuttiRTKExecutable(bundled)
	}
	if resolver == nil {
		return "", errors.New("tutti-managed runtime resolver is unavailable")
	}
	resolved, err := resolver.ResolveProfile(ctx, managedruntime.RTKSaverProfile)
	if err != nil {
		return "", fmt.Errorf("resolve managed rtk runtime profile: %w", err)
	}
	return validateTuttiRTKExecutable(resolved.RTK)
}

func validateTuttiRTKExecutable(path string) (string, error) {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "." || !filepath.IsAbs(path) {
		return "", errors.New("tutti-managed rtk executable path must be absolute")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("inspect Tutti-managed rtk executable: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("tutti-managed rtk executable is not a regular file: %s", path)
	}
	return path, nil
}
