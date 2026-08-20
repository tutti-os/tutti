package agentstatus

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type recordingUserPathAdapter struct {
	directory string
}

func TestPublishDetectedManagedBinaryDirsAdoptsLegacyWindowsPackage(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows user PATH publication")
	}
	home := t.TempDir()
	legacyPrefix := filepath.Join(home, ".local")
	packageDir := filepath.Join(legacyPrefix, "node_modules", "@openai", "codex")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "package.json"), []byte(`{"name":"@openai/codex"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	legacyBinary := filepath.Join(legacyPrefix, "codex.cmd")
	if err := os.WriteFile(legacyBinary, []byte("@echo off\r\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	adapter := &recordingUserPathAdapter{}
	service := Service{
		HomeDir:         func() (string, error) { return home, nil },
		UserPathAdapter: adapter,
	}
	service.publishDetectedManagedBinaryDirs(
		context.Background(),
		[]ProviderSpec{{Update: ProviderUpdateSpec{PackageName: "@openai/codex"}}},
		[]ProviderStatus{{
			Provider:     "codex",
			Availability: Availability{Status: AvailabilityReady},
			CLI:          CLIStatus{BinaryPath: legacyBinary},
		}},
	)
	if adapter.directory != legacyPrefix {
		t.Fatalf("published directory = %q, want adopted legacy prefix %q", adapter.directory, legacyPrefix)
	}
}

func (a *recordingUserPathAdapter) Ensure(_ context.Context, directory string) error {
	a.directory = directory
	return nil
}

func TestPublishManagedInstallBinaryDirUsesKnownWindowsDirs(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows user PATH publication")
	}
	home := t.TempDir()
	adapter := &recordingUserPathAdapter{}
	service := Service{
		HomeDir:         func() (string, error) { return home, nil },
		UserPathAdapter: adapter,
	}
	managedBinary := filepath.Join(home, ".local", "bin", "codex.cmd")
	if err := service.publishManagedInstallBinaryDir(context.Background(), managedBinary); err != nil {
		t.Fatalf("publishManagedInstallBinaryDir() error = %v", err)
	}
	want := filepath.Join(home, ".local", "bin")
	if adapter.directory != want {
		t.Fatalf("published directory = %q, want %q", adapter.directory, want)
	}

	legacyBinary := filepath.Join(home, ".local", "tutti-agent.cmd")
	if err := service.publishManagedInstallBinaryDir(context.Background(), legacyBinary); err != nil {
		t.Fatalf("publishManagedInstallBinaryDir() for legacy binary error = %v", err)
	}
	want = filepath.Join(home, ".local")
	if adapter.directory != want {
		t.Fatalf("published legacy directory = %q, want %q", adapter.directory, want)
	}

	adapter.directory = ""
	if err := service.publishManagedInstallBinaryDir(context.Background(), filepath.Join(home, "AppData", "Roaming", "npm", "codex.cmd")); err != nil {
		t.Fatalf("publishManagedInstallBinaryDir() for unmanaged binary error = %v", err)
	}
	if adapter.directory != "" {
		t.Fatalf("published unmanaged directory = %q, want no publication", adapter.directory)
	}
}
