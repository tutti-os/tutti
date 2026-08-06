//go:build windows

package runtimecmd

import (
	"os"
	"path/filepath"
	"strings"
)

const defaultWindowsPathExt = ".COM;.EXE;.BAT;.CMD;.PS1"

func executableNameCandidates(command string, env []string) []string {
	if filepath.Ext(command) != "" {
		return []string{command}
	}
	pathExt := strings.TrimSpace(envValue(env, "PATHEXT"))
	if pathExt == "" {
		pathExt = defaultWindowsPathExt
	}
	// Prefer Windows PATHEXT launchers before an extensionless file. npm writes
	// both a POSIX `opencode` shim and a Windows `opencode.cmd` shim into the
	// same prefix; choosing the POSIX shim makes ACP probes hang or fail on
	// Windows. Keep the extensionless candidate as a final fallback for managed
	// PE launchers such as the Tutti agent binary.
	result := make([]string, 0, 6)
	seen := map[string]struct{}{}
	extensions := strings.Split(pathExt, ";")
	hasPowerShell := false
	for _, extension := range extensions {
		if strings.EqualFold(strings.TrimSpace(extension), ".PS1") {
			hasPowerShell = true
			break
		}
	}
	if !hasPowerShell {
		extensions = append(extensions, ".PS1")
	}
	for _, extension := range extensions {
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
	if _, ok := seen[strings.ToLower(command)]; !ok {
		result = append(result, command)
	}
	return result
}

func isExecutableFile(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir()
}
