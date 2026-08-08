package agentstatus

import (
	"context"
	"path/filepath"
	"runtime"
	"testing"
)

type recordingUserPathAdapter struct {
	directory string
}

func (a *recordingUserPathAdapter) Ensure(_ context.Context, directory string) error {
	a.directory = directory
	return nil
}

func TestPublishManagedInstallBinaryDirUsesOnlyCanonicalWindowsDir(t *testing.T) {
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

	adapter.directory = ""
	if err := service.publishManagedInstallBinaryDir(context.Background(), filepath.Join(home, "AppData", "Roaming", "npm", "codex.cmd")); err != nil {
		t.Fatalf("publishManagedInstallBinaryDir() for unmanaged binary error = %v", err)
	}
	if adapter.directory != "" {
		t.Fatalf("published unmanaged directory = %q, want no publication", adapter.directory)
	}
}
