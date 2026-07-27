package agentstatus

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestScanCodexPackageLayoutRecognizesNestedAndHoisted(t *testing.T) {
	platform, ok := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	if !ok {
		t.Skip("unsupported platform")
	}
	triple, ok := codexPlatformTargetTriple(runtime.GOOS, runtime.GOARCH)
	if !ok {
		t.Skip("unsupported platform triple")
	}
	for _, tc := range []struct{ name, layout string }{{"nested", "npm_nested"}, {"hoisted", "npm_or_bun_hoisted"}} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			pkg := filepath.Join(root, "node_modules", "@openai", "codex")
			writePackageManifest(t, pkg, "@openai/codex", "0.142.0")
			launcher := filepath.Join(pkg, "bin", "codex")
			writeExecutable(t, launcher, "#!/bin/sh\n")
			var platformRoot string
			if tc.layout == "npm_nested" {
				platformRoot = filepath.Join(pkg, "node_modules", "@openai", platform)
			} else {
				platformRoot = filepath.Join(filepath.Dir(pkg), platform)
			}
			binary := filepath.Join(platformRoot, "vendor", triple, "bin", "codex")
			writeExecutable(t, binary, "#!/bin/sh\n")
			scan := (Service{IsExecutableFile: isTestExecutable}).scanCodexPackageLayout(launcher)
			if scan.LayoutType != tc.layout || !scan.PlatformBinaryExecutable {
				t.Fatalf("scan = %#v, want %s executable", scan, tc.layout)
			}
		})
	}
}

func TestScanCodexPackageLayoutRecognizesPnpmVirtualStore(t *testing.T) {
	platform, platformOK := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	triple, tripleOK := codexPlatformTargetTriple(runtime.GOOS, runtime.GOARCH)
	if !platformOK || !tripleOK {
		t.Skip("unsupported platform")
	}
	root := t.TempDir()
	storePkg := filepath.Join(root, "node_modules", ".pnpm", "@openai+codex@0.142.0", "node_modules", "@openai", "codex")
	pkg := filepath.Join(root, "node_modules", "@openai", "codex")
	writePackageManifest(t, storePkg, "@openai/codex", "0.142.0")
	if err := os.MkdirAll(filepath.Dir(pkg), 0o755); err != nil {
		t.Fatalf("mkdir pnpm scope: %v", err)
	}
	if err := os.Symlink(storePkg, pkg); err != nil {
		t.Fatalf("symlink node_modules @openai/codex: %v", err)
	}
	launcher := filepath.Join(storePkg, "bin", "codex")
	writeExecutable(t, launcher, "#!/bin/sh\n")
	visibleLauncher := filepath.Join(root, "node_modules", ".bin", "codex")
	if err := os.MkdirAll(filepath.Dir(visibleLauncher), 0o755); err != nil {
		t.Fatalf("mkdir pnpm .bin: %v", err)
	}
	if err := os.Symlink(launcher, visibleLauncher); err != nil {
		t.Fatalf("symlink pnpm launcher: %v", err)
	}
	binary := filepath.Join(filepath.Dir(storePkg), platform, "vendor", triple, "bin", "codex")
	writeExecutable(t, binary, "#!/bin/sh\n")
	scan := (Service{IsExecutableFile: isTestExecutable}).scanCodexPackageLayout(visibleLauncher)
	if scan.LayoutType != "pnpm_virtual_store" || !scan.PlatformBinaryExecutable {
		t.Fatalf("scan = %#v, want pnpm virtual-store executable", scan)
	}
}

func TestScanCodexPackageLayoutUsesAncestorNodeModulesResolution(t *testing.T) {
	platform, platformOK := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	triple, tripleOK := codexPlatformTargetTriple(runtime.GOOS, runtime.GOARCH)
	if !platformOK || !tripleOK {
		t.Skip("unsupported platform")
	}
	root := t.TempDir()
	pkg := filepath.Join(
		root,
		"node_modules",
		".bun",
		"@openai+codex@0.142.0",
		"node_modules",
		"@openai",
		"codex",
	)
	writePackageManifest(t, pkg, "@openai/codex", "0.142.0")
	launcher := filepath.Join(pkg, "bin", "codex")
	writeExecutable(t, launcher, "#!/bin/sh\n")

	platformRoot := filepath.Join(root, "node_modules", "@openai", platform)
	binary := filepath.Join(platformRoot, "vendor", triple, "bin", "codex")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	writeExecutable(t, binary, "#!/bin/sh\n")

	scan := (Service{IsExecutableFile: isTestExecutable}).scanCodexPackageLayout(launcher)
	resolvedPlatformRoot, err := filepath.EvalSymlinks(platformRoot)
	if err != nil {
		t.Fatalf("resolve platform root: %v", err)
	}
	if scan.PlatformPackagePath != resolvedPlatformRoot || !scan.PlatformBinaryExecutable {
		t.Fatalf("scan = %#v, want platform package resolved from ancestor node_modules %q", scan, resolvedPlatformRoot)
	}
}

func TestScanCodexPackageLayoutStandaloneIsNotApplicable(t *testing.T) {
	root := t.TempDir()
	launcher := filepath.Join(root, "codex")
	writeExecutable(t, launcher, "#!/bin/sh\n")
	scan := (Service{IsExecutableFile: isTestExecutable}).scanCodexPackageLayout(launcher)
	if scan.LayoutType != "homebrew_or_standalone" || scan.PlatformPackageName != "" || scan.PlatformBinaryPresence != CodexPathNotApplicable {
		t.Fatalf("scan = %#v, want standalone without platform claim", scan)
	}
}

func TestScanCodexPackageLayoutSeparatesPackageBinaryAndExecutableEvidence(t *testing.T) {
	platform, platformOK := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	triple, tripleOK := codexPlatformTargetTriple(runtime.GOOS, runtime.GOARCH)
	if !platformOK || !tripleOK {
		t.Skip("unsupported platform")
	}
	for _, test := range []struct {
		name       string
		setup      func(t *testing.T, packageRoot, binary string)
		wantDetail string
		wantRepair bool
	}{
		{
			name:       "package missing",
			setup:      func(_ *testing.T, _ string, _ string) {},
			wantDetail: "platform_package_missing",
			wantRepair: true,
		},
		{
			name: "binary missing",
			setup: func(t *testing.T, packageRoot, _ string) {
				if err := os.MkdirAll(packageRoot, 0o755); err != nil {
					t.Fatal(err)
				}
			},
			wantDetail: "platform_binary_missing",
			wantRepair: true,
		},
		{
			name: "binary non executable",
			setup: func(t *testing.T, packageRoot, binary string) {
				if err := os.MkdirAll(packageRoot, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(binary, []byte("not executable"), 0o644); err != nil {
					t.Fatal(err)
				}
			},
			wantDetail: "platform_binary_not_executable",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			pkg := filepath.Join(root, "node_modules", "@openai", "codex")
			writePackageManifest(t, pkg, "@openai/codex", "0.142.0")
			launcher := filepath.Join(pkg, "bin", "codex")
			writeExecutable(t, launcher, "#!/bin/sh\n")
			platformRoot := filepath.Join(pkg, "node_modules", "@openai", platform)
			binary := filepath.Join(platformRoot, "vendor", triple, "bin", "codex")
			if runtime.GOOS == "windows" {
				binary += ".exe"
			}
			test.setup(t, platformRoot, binary)
			scan := (Service{IsExecutableFile: isTestExecutable}).scanCodexPackageLayout(launcher)
			if scan.PlatformBinaryDetailCode != test.wantDetail {
				t.Fatalf("detail = %q, want %q; scan=%#v", scan.PlatformBinaryDetailCode, test.wantDetail, scan)
			}
		})
	}
}

func TestCodexPathPresenceBrokenSymlinkIsUnknown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "broken")
	if err := os.Symlink(filepath.Join(filepath.Dir(path), "missing"), path); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if got := codexPathPresence(path); got != CodexPathUnknown {
		t.Fatalf("presence = %q, want unknown", got)
	}
}

func TestCodexPathPresenceInaccessibleIsNotMissing(t *testing.T) {
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	if err := os.MkdirAll(locked, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(locked, "platform-binary")
	if err := os.WriteFile(path, []byte("binary"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0); err != nil {
		t.Skipf("cannot create inaccessible directory: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })
	if got := codexPathPresence(path); got != CodexPathInaccessible {
		t.Fatalf("presence = %q, want inaccessible (never missing)", got)
	}
}
