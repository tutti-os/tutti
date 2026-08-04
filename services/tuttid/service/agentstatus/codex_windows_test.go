//go:build windows

package agentstatus

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMaterializeCodexWindowsAppsLauncherCopiesToWritableCache(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "Program Files", "WindowsApps", "OpenAI.Codex_1.0.0_x64__test", "app", "resources", "codex.exe")
	if err := os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		t.Fatalf("create source directory: %v", err)
	}
	content := []byte("codex-test-binary")
	if err := os.WriteFile(source, content, 0o755); err != nil {
		t.Fatalf("write source: %v", err)
	}

	destination := materializeCodexWindowsAppsLauncherAt(source, filepath.Join(root, "runtime-cache"))
	if destination == source {
		t.Fatal("materializeCodexWindowsAppsLauncherAt() returned protected source path")
	}
	if got, err := os.ReadFile(destination); err != nil {
		t.Fatalf("read materialized launcher: %v", err)
	} else if string(got) != string(content) {
		t.Fatalf("materialized launcher = %q, want %q", got, content)
	}
	if filepath.Dir(destination) == filepath.Dir(source) {
		t.Fatalf("materialized launcher stayed beside protected source: %q", destination)
	}

	if got := materializeCodexWindowsAppsLauncherAt(source, filepath.Join(root, "runtime-cache")); got != destination {
		t.Fatalf("second materialization = %q, want cached destination %q", got, destination)
	}
}
