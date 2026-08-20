package agentextension

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

func TestFileInstallationStoreRoundTripUsesPrivateStablePaths(t *testing.T) {
	stateDir := t.TempDir()
	store := NewFileInstallationStore(stateDir)
	packageDir, err := store.PackageDir("generic", "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	installation := agentextensionbiz.Installation{
		SchemaVersion: "tutti.agent.installation.v1",
		ID:            "generic@1.2.3", AgentKey: "generic", Version: "1.2.3",
		Provider: "acp:generic", PackageDir: packageDir,
	}
	installation.Manifest.AgentKey = "generic"
	installation.Manifest.Version = "1.2.3"
	if err := store.PutActive(installation); err != nil {
		t.Fatal(err)
	}

	byID, err := store.ReadInstallation(installation.ID)
	if err != nil {
		t.Fatal(err)
	}
	active, err := store.ReadActive("generic")
	if err != nil {
		t.Fatal(err)
	}
	if byID.ID != installation.ID || active.ID != installation.ID || byID.PackageDir != packageDir {
		t.Fatalf("records = byID %#v active %#v", byID, active)
	}
	for _, path := range []string{
		filepath.Join(packageDir, "installation.json"),
		filepath.Join(filepath.Dir(packageDir), "active.json"),
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %o", path, info.Mode().Perm())
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte("preferManagedRuntime")) {
			t.Fatalf("%s persisted a derived managed Runtime preference", path)
		}
	}
	info, err := os.Stat(filepath.Dir(packageDir))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("installation root mode = %o", info.Mode().Perm())
	}
}

func TestFileInstallationStoreRejectsTraversalAndUnknownFields(t *testing.T) {
	store := NewFileInstallationStore(t.TempDir())
	if _, err := store.PackageDir("../escape", "1.2.3"); err == nil {
		t.Fatal("unsafe key accepted")
	}
	packageDir, err := store.PackageDir("generic", "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(packageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "installation.json"), []byte(`{"id":"generic@1.2.3","unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadInstallation("generic@1.2.3"); err == nil {
		t.Fatal("unknown field accepted")
	}
}

func TestFileInstallationStoreAcceptsButClearsLegacyManagedRuntimePreference(t *testing.T) {
	store := NewFileInstallationStore(t.TempDir())
	packageDir, err := store.PackageDir("generic", "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(packageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(packageDir, "installation.json"),
		[]byte(`{"id":"generic@1.2.3","preferManagedRuntime":true}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	installation, err := store.ReadInstallation("generic@1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if installation.LegacyPreferManagedRuntime {
		t.Fatal("legacy managed runtime preference remained authoritative after decode")
	}
}
