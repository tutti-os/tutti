package agentextension

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPublishManagedRuntimeEntryRepointsStableLink(t *testing.T) {
	runtimeRoot := filepath.Join(t.TempDir(), "agent-runtimes")
	stablePath := filepath.Join(runtimeRoot, "generic", "bin", "generic-agent")
	userPath := filepath.Join(t.TempDir(), ".local", "bin", "generic-agent")
	firstExecutable := writeManagedRuntimeEntryExecutable(t, runtimeRoot, "generic", "1.0.0")
	secondExecutable := writeManagedRuntimeEntryExecutable(t, runtimeRoot, "generic", "2.0.0")

	first := managedRuntimeEntry{
		runtimeRoot: runtimeRoot, stablePath: stablePath, userPath: userPath, finalExecutable: firstExecutable,
	}
	if err := validateManagedRuntimeEntry(first); err != nil {
		t.Fatal(err)
	}
	if err := publishManagedRuntimeEntry(first); err != nil {
		t.Fatal(err)
	}
	userTarget, err := resolvedSymlinkTarget(userPath)
	if err != nil {
		t.Fatal(err)
	}
	if userTarget != stablePath {
		t.Fatalf("user entry target = %q, want stable path %q", userTarget, stablePath)
	}

	second := first
	second.finalExecutable = secondExecutable
	if err := validateManagedRuntimeEntry(second); err != nil {
		t.Fatal(err)
	}
	if err := publishManagedRuntimeEntry(second); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(userPath)
	if err != nil {
		t.Fatal(err)
	}
	wantResolved, err := filepath.EvalSymlinks(secondExecutable)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != wantResolved {
		t.Fatalf("repointed user entry = %q, want %q", resolved, wantResolved)
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
