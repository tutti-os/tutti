package agentstatus

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// scanCodexPackageLayout follows the resolved launcher back to its package
// manifest and then examines only package-relative candidates. It never probes
// fixed Bun, pnpm, Homebrew, or home-directory locations.
func (s Service) scanCodexPackageLayout(binaryPath string) CodexPackageLayoutEvidence {
	evidence := CodexPackageLayoutEvidence{
		LayoutType:              "unknown",
		PlatformPackagePresence: CodexPathUnknown,
		PlatformBinaryPresence:  CodexPathUnknown,
	}
	binaryPath = strings.TrimSpace(binaryPath)
	if binaryPath == "" {
		return evidence
	}
	realPath := binaryPath
	if resolved, err := filepath.EvalSymlinks(binaryPath); err == nil {
		realPath = resolved
	}
	pkgRoot := codexPackageDirForBinary(realPath)
	if pkgRoot == "" {
		if s.executableFile(realPath) {
			evidence.LayoutType = "homebrew_or_standalone"
			evidence.PlatformPackagePresence = CodexPathNotApplicable
			evidence.PlatformBinaryPresence = CodexPathNotApplicable
			evidence.PlatformBinaryDetailCode = "platform_binary_not_applicable"
		}
		return evidence
	}
	evidence.PackageRoot = pkgRoot
	evidence.PackageManager = codexPackageManagerForRoot(pkgRoot)
	platformName, ok := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	if !ok {
		return evidence
	}
	evidence.PlatformPackageName = "@openai/" + platformName
	triple, tripleOK := codexPlatformTargetTriple(runtime.GOOS, runtime.GOARCH)
	if !tripleOK {
		return evidence
	}
	bin := "codex"
	if runtime.GOOS == "windows" {
		bin = "codex.exe"
	}

	candidates := codexPlatformPackageCandidates(pkgRoot, platformName)
	for _, candidate := range candidates {
		binary := filepath.Join(candidate.dir, "vendor", triple, "bin", bin)
		packagePresence := codexPathPresence(candidate.dir)
		binaryPresence := codexPathPresence(binary)
		if packagePresence == CodexPathPresent || binaryPresence == CodexPathPresent {
			evidence.LayoutType = candidate.kind
			evidence.PlatformPackagePath = candidate.dir
			evidence.ExpectedPlatformBinaryPath = binary
			evidence.PlatformPackagePresence = packagePresence
			evidence.PlatformBinaryPresence = binaryPresence
			evidence.PlatformBinaryExists = binaryPresence == CodexPathPresent
			evidence.PlatformBinaryExecutable = binaryPresence == CodexPathPresent && s.executableFile(binary)
			evidence.PlatformBinaryDetailCode = codexPlatformBinaryDetail(evidence)
			return evidence
		}
		if packagePresence == CodexPathInaccessible || binaryPresence == CodexPathInaccessible ||
			packagePresence == CodexPathUnknown || binaryPresence == CodexPathUnknown {
			// An unreadable candidate is not evidence that a platform dependency is
			// absent. Preserve it as unknown and never authorize repair from it.
			evidence.PlatformPackagePath = candidate.dir
			evidence.ExpectedPlatformBinaryPath = binary
			evidence.PlatformPackagePresence = packagePresence
			evidence.PlatformBinaryPresence = binaryPresence
			evidence.PlatformBinaryDetailCode = codexPlatformBinaryDetail(evidence)
			return evidence
		}
	}
	if strings.Contains(filepath.ToSlash(pkgRoot), "/node_modules/") {
		evidence.LayoutType = "package_found_platform_missing"
		evidence.PlatformPackagePath = filepath.Join(pkgRoot, "node_modules", "@openai", platformName)
		evidence.ExpectedPlatformBinaryPath = filepath.Join(evidence.PlatformPackagePath, "vendor", triple, "bin", bin)
		evidence.PlatformPackagePresence = CodexPathMissing
		evidence.PlatformBinaryPresence = CodexPathMissing
		evidence.PlatformBinaryDetailCode = "platform_package_missing"
	}
	return evidence
}

type codexPlatformPackageCandidate struct {
	kind string
	dir  string
}

// codexPlatformPackageCandidates mirrors Node's ancestor node_modules lookup.
// This covers npm's nested/hoisted layouts, Bun's hoisted and isolated .bun
// stores, and pnpm's virtual store without assuming a fixed global directory.
func codexPlatformPackageCandidates(pkgRoot, platformName string) []codexPlatformPackageCandidate {
	result := []codexPlatformPackageCandidate{}
	seen := map[string]struct{}{}
	appendCandidate := func(kind, dir string) {
		key := filepath.Clean(dir)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		result = append(result, codexPlatformPackageCandidate{kind: kind, dir: dir})
	}

	nestedModules := filepath.Join(pkgRoot, "node_modules")
	appendCandidate("npm_nested", filepath.Join(nestedModules, "@openai", platformName))
	for _, nodeModulesDir := range nodeModuleResolutionDirs(pkgRoot) {
		if filepath.Clean(nodeModulesDir) == filepath.Clean(nestedModules) {
			continue
		}
		appendCandidate(codexResolvedLayoutKind(pkgRoot), filepath.Join(nodeModulesDir, "@openai", platformName))
	}
	return result
}

func nodeModuleResolutionDirs(start string) []string {
	result := []string{}
	for dir := filepath.Clean(start); ; dir = filepath.Dir(dir) {
		if filepath.Base(dir) == "node_modules" {
			result = append(result, dir)
		} else {
			result = append(result, filepath.Join(dir, "node_modules"))
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	return result
}

func codexResolvedLayoutKind(pkgRoot string) string {
	slashed := filepath.ToSlash(pkgRoot)
	switch {
	case strings.Contains(slashed, "/.pnpm/"):
		return "pnpm_virtual_store"
	case strings.Contains(slashed, "/.bun/"):
		return "bun_isolated"
	default:
		return "npm_or_bun_hoisted"
	}
}

func codexPackageManagerForRoot(pkgRoot string) string {
	slashed := filepath.ToSlash(pkgRoot)
	switch {
	case strings.Contains(slashed, "/.pnpm/"):
		return "pnpm"
	case strings.Contains(slashed, "/.bun/"):
		return "bun"
	case strings.Contains(slashed, "/node_modules/"):
		return "npm"
	default:
		return ""
	}
}

func codexPathPresence(path string) CodexPathPresence {
	if strings.TrimSpace(path) == "" {
		return CodexPathUnknown
	}
	_, err := os.Stat(path)
	if err == nil {
		return CodexPathPresent
	}
	if errors.Is(err, fs.ErrNotExist) {
		// A broken symlink means the relation could not be followed; it is not
		// proof that the optional dependency was never installed.
		if info, lerr := os.Lstat(path); lerr == nil && info.Mode()&os.ModeSymlink != 0 {
			return CodexPathUnknown
		}
		return CodexPathMissing
	}
	if errors.Is(err, fs.ErrPermission) {
		return CodexPathInaccessible
	}
	return CodexPathUnknown
}

func codexPlatformBinaryDetail(evidence CodexPackageLayoutEvidence) string {
	switch {
	case evidence.PlatformPackagePresence == CodexPathNotApplicable:
		return "platform_binary_not_applicable"
	case evidence.PlatformPackagePresence == CodexPathMissing:
		return "platform_package_missing"
	case evidence.PlatformBinaryPresence == CodexPathMissing:
		return "platform_binary_missing"
	case evidence.PlatformBinaryPresence == CodexPathInaccessible:
		return "platform_binary_inaccessible"
	case evidence.PlatformBinaryPresence != CodexPathPresent:
		return "platform_binary_presence_unknown"
	case !evidence.PlatformBinaryExecutable:
		return "platform_binary_not_executable"
	default:
		return "platform_binary_ready"
	}
}
