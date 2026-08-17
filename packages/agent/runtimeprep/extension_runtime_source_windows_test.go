package runtimeprep

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveExtensionRuntimeSourceHomeUsesWindowsUserCacheFallback(t *testing.T) {
	userHome := t.TempDir()
	localAppData := t.TempDir()
	t.Setenv("USERPROFILE", userHome)
	t.Setenv("LOCALAPPDATA", localAppData)
	t.Setenv("HERMES_HOME", "")

	windowsHome := filepath.Join(localAppData, "hermes")
	if err := os.MkdirAll(windowsHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(windowsHome, ".env"), []byte("OPENAI_API_KEY=test\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := resolveExtensionRuntimeSourceHome(*hermesRuntimePrep().Home)
	if got != windowsHome {
		t.Fatalf("resolve source home = %q, want %q", got, windowsHome)
	}
}

func TestResolveExtensionRuntimeSourceHomePrefersWindowsUserCacheDefault(t *testing.T) {
	userHome := t.TempDir()
	localAppData := t.TempDir()
	t.Setenv("USERPROFILE", userHome)
	t.Setenv("LOCALAPPDATA", localAppData)
	t.Setenv("HERMES_HOME", "")

	literalHome := filepath.Join(userHome, ".hermes")
	windowsHome := filepath.Join(localAppData, "hermes")
	for _, dir := range []string{literalHome, windowsHome} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	got := resolveExtensionRuntimeSourceHome(*hermesRuntimePrep().Home)
	if got != windowsHome {
		t.Fatalf("resolve source home = %q, want %q", got, windowsHome)
	}
}

func TestResolveExtensionRuntimeSourceHomeFallsBackToLiteralUserHomeDefault(t *testing.T) {
	userHome := t.TempDir()
	localAppData := t.TempDir()
	t.Setenv("USERPROFILE", userHome)
	t.Setenv("LOCALAPPDATA", localAppData)
	t.Setenv("HERMES_HOME", "")

	literalHome := filepath.Join(userHome, ".hermes")
	if err := os.MkdirAll(literalHome, 0o700); err != nil {
		t.Fatal(err)
	}

	got := resolveExtensionRuntimeSourceHome(*hermesRuntimePrep().Home)
	if got != literalHome {
		t.Fatalf("resolve source home = %q, want %q", got, literalHome)
	}
}

func TestResolveExtensionRuntimeSourceHomePrefersExplicitEnvironment(t *testing.T) {
	explicitHome := t.TempDir()
	t.Setenv("HERMES_HOME", explicitHome)

	got := resolveExtensionRuntimeSourceHome(*hermesRuntimePrep().Home)
	if got != explicitHome {
		t.Fatalf("resolve source home = %q, want %q", got, explicitHome)
	}
}
