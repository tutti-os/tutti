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
