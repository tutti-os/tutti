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
// same platform contract. installBinDir is the conventional Unix bin target.
func ResolveNPMGlobalLayout(installBinDir string) NPMGlobalLayout {
	prefixDir := filepath.Dir(installBinDir)
	binDir := installBinDir
	if runtime.GOOS == "windows" {
		binDir = prefixDir
	}
	return NPMGlobalLayout{PrefixDir: prefixDir, BinDir: binDir}
}
