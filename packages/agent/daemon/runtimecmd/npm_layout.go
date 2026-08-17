package runtimecmd

import (
	"path/filepath"
	"runtime"
)

// NPMGlobalLayout describes npm's platform-specific global prefix layout.
type NPMGlobalLayout struct {
	PrefixDir string
	BinDir    string
}

// ResolveNPMGlobalLayout keeps npm install and executable discovery on the
// same platform contract. installBinDir is the directory that must contain
// the user-facing npm launcher.
func ResolveNPMGlobalLayout(installBinDir string) NPMGlobalLayout {
	if runtime.GOOS == "windows" {
		// Windows npm writes global command shims directly into its prefix (not
		// <prefix>/bin). The requested directory is therefore both the prefix
		// and the executable directory so a managed install produces, for
		// example, %USERPROFILE%\\.local\\bin\\codex.cmd.
		return NPMGlobalLayout{PrefixDir: installBinDir, BinDir: installBinDir}
	}
	prefixDir := filepath.Dir(installBinDir)
	return NPMGlobalLayout{PrefixDir: prefixDir, BinDir: installBinDir}
}

// UserManagedNPMExecutableDirs returns Tutti's current user-level npm launcher
// directory followed by any backward-compatible directory that older Tutti
// releases used. Callers use this list for discovery only; fresh installs still
// target the first entry.
func UserManagedNPMExecutableDirs(home string) []string {
	installBinDir := filepath.Join(home, ".local", "bin")
	dirs := []string{ResolveNPMGlobalLayout(installBinDir).BinDir}
	if runtime.GOOS == "windows" {
		// Older Windows releases passed %USERPROFILE%\.local as npm's prefix,
		// so npm placed codex.cmd/tutti-agent.cmd directly in that directory.
		dirs = append(dirs, filepath.Join(home, ".local"))
	}
	return dirs
}
