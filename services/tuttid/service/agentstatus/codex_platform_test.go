package agentstatus

import (
	"os"
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

func TestCodexPlatformBinaryCandidatePaths(t *testing.T) {
	pkg := "/home/u/.npm/lib/node_modules/@openai/codex"
	got := codexPlatformBinaryCandidatePaths(pkg, "darwin", "arm64")
	want := filepath.Join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex")
	if len(got) != 1 || got[0] != want {
		t.Fatalf("codexPlatformBinaryCandidatePaths darwin/arm64 = %#v, want [%q]", got, want)
	}
	winGot := codexPlatformBinaryCandidatePaths(pkg, "windows", "amd64")
	winWant := filepath.Join(pkg, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
	if len(winGot) != 1 || winGot[0] != winWant {
		t.Fatalf("codexPlatformBinaryCandidatePaths windows = %#v, want [%q]", winGot, winWant)
	}
	if got := codexPlatformBinaryCandidatePaths(pkg, "plan9", "mips"); len(got) != 0 {
		t.Fatalf("codexPlatformBinaryCandidatePaths unsupported platform = %#v, want empty", got)
	}
}

func requireTestCodexPlatformBinaryPath(t *testing.T, pkgDir string) string {
	t.Helper()
	paths := codexPlatformBinaryCandidatePaths(pkgDir, runtime.GOOS, runtime.GOARCH)
	if len(paths) == 0 {
		t.Skipf("codex platform package unavailable for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	return paths[0]
}

func TestServiceCodexPlatformBinaryComplete(t *testing.T) {
	pkg := t.TempDir()
	binPath := filepath.Join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex")

	svc := Service{IsExecutableFile: func(p string) bool {
		info, err := os.Stat(p)
		return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
	}}

	// Missing subpackage binary -> incomplete (this is the report's ENOENT root cause).
	if path, complete := svc.codexPlatformBinaryComplete(pkg, "darwin", "arm64"); complete {
		t.Fatalf("expected incomplete when binary missing, got complete (path=%q)", path)
	}

	// Present but not executable -> still incomplete.
	if err := os.MkdirAll(filepath.Dir(binPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binPath, []byte("bin"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, complete := svc.codexPlatformBinaryComplete(pkg, "darwin", "arm64"); complete {
		t.Fatalf("expected incomplete when binary not executable")
	}

	// Present and executable -> complete.
	if err := os.Chmod(binPath, 0o755); err != nil {
		t.Fatal(err)
	}
	path, complete := svc.codexPlatformBinaryComplete(pkg, "darwin", "arm64")
	if !complete || path != binPath {
		t.Fatalf("expected complete with path=%q, got (%q,%v)", binPath, path, complete)
	}
}

func TestServiceCodexPlatformBinaryCompleteRejectsLegacyBinaryPath(t *testing.T) {
	pkg := t.TempDir()
	legacyBinPath := filepath.Join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "codex")
	if err := os.MkdirAll(filepath.Dir(legacyBinPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyBinPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}

	svc := Service{IsExecutableFile: func(p string) bool {
		info, err := os.Stat(p)
		return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
	}}
	path, complete := svc.codexPlatformBinaryComplete(pkg, "darwin", "arm64")
	if complete {
		t.Fatalf("expected incomplete with legacy path=%q, got complete at %q", legacyBinPath, path)
	}
}
