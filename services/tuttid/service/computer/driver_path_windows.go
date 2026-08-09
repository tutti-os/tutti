//go:build windows

package computer

import (
	"os"
	"path/filepath"
)

func resolveInstalledComputerDriver() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	userProfile := os.Getenv("USERPROFILE")
	candidates := make([]string, 0, 5)
	if localAppData != "" {
		candidates = append(candidates,
			filepath.Join(localAppData, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe"),
			filepath.Join(localAppData, "Programs", "Cua", "cua-driver.exe"),
			filepath.Join(localAppData, "cua-driver", "cua-driver.exe"),
		)
	}
	if userProfile != "" {
		candidates = append(candidates,
			filepath.Join(userProfile, ".cua-driver", "packages", "current", "cua-driver.exe"),
			filepath.Join(userProfile, ".local", "bin", "cua-driver.exe"),
		)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}
