package agentstatus

import (
	"path/filepath"
	"runtime"
	"strings"
)

// codexNpmPlatformDir returns the @openai npm optional-subpackage directory
// name that holds the platform-specific codex binary, e.g.
// "codex-darwin-arm64". ok is false for platforms codex does not publish.
//
// The @openai/codex npm package is only a JS launcher; the real binary lives
// in a per-platform optionalDependency subpackage. A missing/incomplete
// subpackage is the root cause of the spawn ENOENT seen in the field.
func codexNpmPlatformDir(goos, goarch string) (string, bool) {
	var nodeOS string
	switch goos {
	case "darwin":
		nodeOS = "darwin"
	case "linux":
		nodeOS = "linux"
	case "windows":
		nodeOS = "win32"
	default:
		return "", false
	}
	var nodeArch string
	switch goarch {
	case "arm64":
		nodeArch = "arm64"
	case "amd64":
		nodeArch = "x64"
	case "386":
		nodeArch = "ia32"
	default:
		return "", false
	}
	return "codex-" + nodeOS + "-" + nodeArch, true
}

func codexPlatformTargetTriple(goos, goarch string) (string, bool) {
	switch goos {
	case "darwin":
		switch goarch {
		case "arm64":
			return "aarch64-apple-darwin", true
		case "amd64":
			return "x86_64-apple-darwin", true
		}
	case "linux":
		switch goarch {
		case "arm64":
			return "aarch64-unknown-linux-musl", true
		case "amd64":
			return "x86_64-unknown-linux-musl", true
		}
	case "windows":
		switch goarch {
		case "arm64":
			return "aarch64-pc-windows-msvc", true
		case "amd64":
			return "x86_64-pc-windows-msvc", true
		}
	}
	return "", false
}

func codexPlatformBinaryCandidatePaths(codexPkgDir, goos, goarch string) []string {
	binName := "codex"
	if goos == "windows" {
		binName = "codex.exe"
	}
	dir, dirOK := codexNpmPlatformDir(goos, goarch)
	if !dirOK {
		return nil
	}
	targetTriple, ok := codexPlatformTargetTriple(goos, goarch)
	if !ok {
		return nil
	}
	return []string{
		filepath.Join(codexPkgDir, "node_modules", "@openai", dir, "vendor", targetTriple, "bin", binName),
	}
}

// codexPlatformBinaryComplete reports whether the platform-specific codex
// binary is present and executable inside the given @openai/codex package
// directory. It returns the resolved binary path alongside the verdict.
func (s Service) codexPlatformBinaryComplete(codexPkgDir, goos, goarch string) (string, bool) {
	paths := codexPlatformBinaryCandidatePaths(codexPkgDir, goos, goarch)
	if len(paths) == 0 {
		return "", false
	}
	for _, path := range paths {
		if s.executableFile(path) {
			return path, true
		}
	}
	return paths[0], false
}

func codexPackageDirForBinary(binaryPath string) string {
	packageJSONPath := findAdapterPackageJSON(binaryPath, "@openai/codex")
	if packageJSONPath == "" {
		return ""
	}
	return filepath.Dir(packageJSONPath)
}

func npmGlobalPrefixFromPackageDir(pkgDir string) string {
	pkgDir = strings.TrimSpace(pkgDir)
	if pkgDir == "" {
		return ""
	}
	// pkgDir = .../node_modules/@openai/codex
	nodeModulesDir := filepath.Dir(filepath.Dir(pkgDir))
	if filepath.Base(nodeModulesDir) != "node_modules" {
		return ""
	}
	parent := filepath.Dir(nodeModulesDir)
	if filepath.Base(parent) == "lib" {
		parent = filepath.Dir(parent)
	}
	// Reject a degenerate/root prefix (e.g. pkgDir was "/node_modules/..." or
	// "C:\node_modules\..." or "\\server\share\node_modules\...") so we never
	// hand npm a `--prefix /` (or a drive/UNC root) and clobber the filesystem
	// root. A path is a root when its own parent is itself; this is cross-platform
	// (catches "/", "C:\", "\\server\share") and also covers "." / empty.
	cleaned := filepath.Clean(parent)
	if cleaned == "." || filepath.Dir(cleaned) == cleaned {
		return ""
	}
	return parent
}

// codexPlatformPackageMissingPath returns the platform-specific binary path we
// expected to exist but didn't, for diagnostics. Returns empty when the codex
// package directory cannot be located or the platform is unsupported.
func (s Service) codexPlatformPackageMissingPath(binaryPath string) string {
	binaryPath = strings.TrimSpace(binaryPath)
	if binaryPath == "" {
		return ""
	}
	pkgDir := codexPackageDirForBinary(binaryPath)
	if pkgDir == "" {
		return ""
	}
	paths := codexPlatformBinaryCandidatePaths(pkgDir, runtime.GOOS, runtime.GOARCH)
	if len(paths) == 0 {
		return ""
	}
	expectedPath := paths[0]
	if s.executableFile(expectedPath) {
		return ""
	}
	return expectedPath
}
