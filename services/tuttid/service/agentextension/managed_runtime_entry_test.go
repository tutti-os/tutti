package agentextension

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

type recordingExtensionUserPathAdapter struct{ directory string }

func (a *recordingExtensionUserPathAdapter) Ensure(_ context.Context, directory string) error {
	a.directory = directory
	return nil
}

func TestManagerPublishesRuntimeBinDirectoryToUserPath(t *testing.T) {
	adapter := &recordingExtensionUserPathAdapter{}
	binDir := filepath.Join(t.TempDir(), ".local", "bin")
	manager := Manager{RuntimeBinDir: binDir, UserPathAdapter: adapter}
	if err := manager.ensureUserCommandPath(context.Background()); err != nil {
		t.Fatal(err)
	}
	if adapter.directory != binDir {
		t.Fatalf("published directory = %q, want %q", adapter.directory, binDir)
	}
}

func TestPublishManagedRuntimeEntryRepointsStableLink(t *testing.T) {
	runtimeRoot := filepath.Join(t.TempDir(), "agent-runtimes")
	userBinDir := filepath.Join(t.TempDir(), ".local", "bin")
	firstExecutable := writeManagedRuntimeEntryExecutable(t, runtimeRoot, "generic", "1.0.0")
	secondExecutable := writeManagedRuntimeEntryExecutable(t, runtimeRoot, "generic", "2.0.0")
	manager := Manager{RuntimeInstallDir: runtimeRoot, RuntimeBinDir: userBinDir}
	installation := Installation{AgentKey: "generic"}

	first, err := manager.managedRuntimeEntry(installation, filepath.Dir(filepath.Dir(firstExecutable)), "${installRoot}/bin/generic-agent", "bin/generic-agent")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateManagedRuntimeEntry(first); err != nil {
		t.Fatal(err)
	}
	published, err := publishManagedRuntimeEntry(first)
	if err != nil {
		t.Fatal(err)
	}
	if !published {
		t.Fatal("first publish reported a skipped user entry")
	}
	if err := verifyManagedRuntimeEntry(first); err != nil {
		t.Fatal(err)
	}

	second, err := manager.managedRuntimeEntry(installation, filepath.Dir(filepath.Dir(secondExecutable)), "${installRoot}/bin/generic-agent", "bin/generic-agent")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateManagedRuntimeEntry(second); err != nil {
		t.Fatal(err)
	}
	published, err = publishManagedRuntimeEntry(second)
	if err != nil {
		t.Fatal(err)
	}
	if !published {
		t.Fatal("upgrade publish reported a skipped user entry")
	}
	if err := verifyManagedRuntimeEntry(second); err != nil {
		t.Fatal(err)
	}
}

func writeManagedRuntimeEntryExecutable(t *testing.T, runtimeRoot, agentKey, version string) string {
	t.Helper()
	executable := filepath.Join(runtimeRoot, agentKey, version, "bin", "generic-agent")
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return executable
}
