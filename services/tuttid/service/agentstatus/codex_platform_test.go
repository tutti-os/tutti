package agentstatus

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestCodexNpmPlatformDir(t *testing.T) {
	cases := []struct {
		goos   string
		goarch string
		want   string
		ok     bool
	}{
		{"darwin", "arm64", "codex-darwin-arm64", true},
		{"darwin", "amd64", "codex-darwin-x64", true},
		{"linux", "amd64", "codex-linux-x64", true},
		{"linux", "arm64", "codex-linux-arm64", true},
		{"windows", "amd64", "codex-win32-x64", true},
		{"freebsd", "riscv64", "", false},
	}
	for _, tc := range cases {
		got, ok := codexNpmPlatformDir(tc.goos, tc.goarch)
		if ok != tc.ok || got != tc.want {
			t.Fatalf("codexNpmPlatformDir(%q,%q)=(%q,%v), want (%q,%v)", tc.goos, tc.goarch, got, ok, tc.want, tc.ok)
		}
	}
}

// requireTestCodexPlatformBinaryPath is a test fixture helper. Production
// layout resolution belongs to scanCodexPackageLayout, which also covers Bun
// and pnpm rather than recreating the retired npm-nested-only helper.
func requireTestCodexPlatformBinaryPath(t *testing.T, pkgDir string) string {
	t.Helper()
	platform, ok := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	if !ok {
		t.Skipf("unsupported Codex platform %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	triple, ok := codexPlatformTargetTriple(runtime.GOOS, runtime.GOARCH)
	if !ok {
		t.Skipf("unsupported Codex target %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	bin := "codex"
	if runtime.GOOS == "windows" {
		bin = "codex.exe"
	}
	return filepath.Join(pkgDir, "node_modules", "@openai", platform, "vendor", triple, "bin", bin)
}
