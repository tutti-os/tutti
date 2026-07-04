package agentstatus

import (
	"os"
	"path/filepath"
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

func TestCodexPlatformBinaryPath(t *testing.T) {
	pkg := "/home/u/.npm/lib/node_modules/@openai/codex"
	got, ok := codexPlatformBinaryPath(pkg, "darwin", "arm64")
	want := filepath.Join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex")
	if !ok || got != want {
		t.Fatalf("codexPlatformBinaryPath darwin/arm64 = (%q,%v), want (%q,true)", got, ok, want)
	}
	winGot, ok := codexPlatformBinaryPath(pkg, "windows", "amd64")
	winWant := filepath.Join(pkg, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
	if !ok || winGot != winWant {
		t.Fatalf("codexPlatformBinaryPath windows = (%q,%v), want (%q,true)", winGot, ok, winWant)
	}
	if _, ok := codexPlatformBinaryPath(pkg, "plan9", "mips"); ok {
		t.Fatalf("codexPlatformBinaryPath unsupported platform should be ok=false")
	}
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
