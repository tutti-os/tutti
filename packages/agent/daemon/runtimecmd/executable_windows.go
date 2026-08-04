//go:build windows

package runtimecmd

import (
	"os"
	"path/filepath"
	"strings"
)

const defaultWindowsPathExt = ".COM;.EXE;.BAT;.CMD"

func executableNameCandidates(command string, env []string) []string {
	if filepath.Ext(command) != "" {
		return []string{command}
	}
	pathExt := strings.TrimSpace(envValue(env, "PATHEXT"))
	if pathExt == "" {
		pathExt = defaultWindowsPathExt
	}
	// Keep the explicit extensionless path first for compatibility with managed
	// launchers, then follow normal Windows PATHEXT lookup for .exe/.cmd files.
	result := make([]string, 0, 5)
	seen := map[string]struct{}{strings.ToLower(command): {}}
	result = append(result, command)
	for _, extension := range strings.Split(pathExt, ";") {
		extension = strings.TrimSpace(extension)
		if extension == "" {
			continue
		}
		if !strings.HasPrefix(extension, ".") {
			extension = "." + extension
		}
		candidate := command + extension
		key := strings.ToLower(candidate)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, candidate)
	}
	return result
}

func isExecutableFile(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir()
}
