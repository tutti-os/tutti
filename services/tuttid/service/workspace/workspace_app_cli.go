package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func workspaceAppCLIPath() (string, error) {
	return workspaceAppCLIPathForPlatform(runtime.GOOS)
}

func workspaceAppCLIPathForPlatform(platform string) (string, error) {
	if platform != "windows" {
		return tuttiCLIShimPathForPlatform(platform), nil
	}

	configured := strings.TrimSpace(os.Getenv("TUTTI_WORKSPACE_APP_CLI_PATH"))
	if configured == "" {
		return "", fmt.Errorf("native Tutti CLI path is not configured")
	}
	if !filepath.IsAbs(configured) {
		return "", fmt.Errorf("native Tutti CLI path must be absolute")
	}
	if !strings.EqualFold(filepath.Ext(configured), ".exe") {
		return "", fmt.Errorf("native Tutti CLI path must point to an .exe")
	}
	info, err := os.Stat(configured)
	if err != nil {
		return "", fmt.Errorf("inspect native Tutti CLI: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("native Tutti CLI path must point to a regular file")
	}
	return configured, nil
}

func workspaceAppCLIEnvOverrides(platform string, cliPath string) []string {
	overrides := []string{"TUTTI_CLI=" + cliPath}
	if platform == "windows" {
		overrides = append(overrides, "TUTTID_LISTENER_INFO_PATH="+tuttitypes.TuttidListenerInfoPath())
	}
	return overrides
}
