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

// codexPlatformBinaryPath returns the absolute path to the platform-specific
// codex binary inside an installed @openai/codex package directory.
func codexPlatformBinaryPath(codexPkgDir, goos, goarch string) (string, bool) {
	paths := codexPlatformBinaryCandidatePaths(codexPkgDir, goos, goarch)
	if len(paths) == 0 {
		return "", false
	}
	return paths[0], true
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

// codexNPMPrefixFromPackageDir derives the npm global prefix that owns an
// installed @openai/codex package directory, so an incomplete install can be
// repaired in place instead of duplicated in a lower-priority directory.
//
// npm lays out global packages as <prefix>/lib/node_modules/@openai/codex on
// Unix and <prefix>/node_modules/@openai/codex on Windows. The prefix is the
// directory above the node_modules dir, skipping the intermediate "lib" on Unix.
// Returns "" when pkgDir does not match that layout (e.g. a pnpm content store
// or a standalone binary), in which case the caller falls back to ~/.local.
func codexNPMPrefixFromPackageDir(pkgDir string) string {
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

// codexRepairInstallPrefix returns the npm global prefix owning the existing
// (incomplete or outdated) @openai/codex installation, so it can be repaired in
// place. ok is false when there is no existing install, its package directory
// cannot be located, or it does not match npm's global package layout — in all
// those cases the caller installs a fresh copy in ~/.local instead.
func codexRepairInstallPrefix(existingCLIPath string) (string, bool) {
	existingCLIPath = strings.TrimSpace(existingCLIPath)
	if existingCLIPath == "" {
		return "", false
	}
	pkgDir := codexPackageDirForBinary(existingCLIPath)
	if pkgDir == "" {
		return "", false
	}
	prefix := codexNPMPrefixFromPackageDir(pkgDir)
	if prefix == "" {
		return "", false
	}
	return prefix, true
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
