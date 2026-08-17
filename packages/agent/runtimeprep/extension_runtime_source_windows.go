//go:build windows

package runtimeprep

import (
	"os"
	"path/filepath"
	"strings"
)

func extensionRuntimePlatformSourceHome(rel string) string {
	clean := filepath.Clean(filepath.FromSlash(strings.TrimSpace(rel)))
	parts := strings.Split(clean, string(filepath.Separator))
	if len(parts) == 0 || len(parts[0]) < 2 || !strings.HasPrefix(parts[0], ".") || strings.HasPrefix(parts[0], "..") {
		return ""
	}
	parts[0] = strings.TrimPrefix(parts[0], ".")
	cacheHome, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(cacheHome) == "" {
		return ""
	}
	return filepath.Join(append([]string{cacheHome}, parts...)...)
}
