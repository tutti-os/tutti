package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

func TestFileSetupActionStoreRoundTripsAtStablePrivatePath(t *testing.T) {
	stateDir := t.TempDir()
	store := NewFileSetupActionStore(stateDir)
	scope := agentextensionbiz.SetupActionScope{
		AgentTargetID: "extension:gemini", ExtensionInstallationID: "gemini@1.0.0",
	}
	action := agentextensionbiz.SetupAction{
		ActionID: "action-1", ClientActionID: "client-1", Kind: agentextensionbiz.SetupActionInstall,
		WorkspaceID: "workspace-1", AgentTargetID: scope.AgentTargetID,
		ExtensionInstallationID: scope.ExtensionInstallationID, PlanDigest: "plan-1",
		Status: agentextensionbiz.SetupActionRunning, Phase: agentextensionbiz.SetupPhaseInstalling,
		CreatedAtUnixMS: 100, UpdatedAtUnixMS: 200,
	}
	if err := store.Put(context.Background(), scope, action); err != nil {
		t.Fatal(err)
	}

	digest := sha256.Sum256([]byte(scope.AgentTargetID + "\x00" + scope.ExtensionInstallationID))
	path := filepath.Join(stateDir, "agent", "extension-runtime-actions", hex.EncodeToString(digest[:])+".json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("action file permissions = %o, want 600", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("action directory permissions = %o, want 700", dirInfo.Mode().Perm())
	}

	loaded, err := store.Read(context.Background(), scope)
	if err != nil {
		t.Fatal(err)
	}
	if loaded == nil || !reflect.DeepEqual(*loaded, action) {
		t.Fatalf("loaded action = %#v, want %#v", loaded, action)
	}
}

func TestFileSetupActionStoreMissingAndInvalidScopeFailClosed(t *testing.T) {
	store := NewFileSetupActionStore(t.TempDir())
	scope := agentextensionbiz.SetupActionScope{
		AgentTargetID: "extension:gemini", ExtensionInstallationID: "gemini@1.0.0",
	}
	loaded, err := store.Read(context.Background(), scope)
	if err != nil || loaded != nil {
		t.Fatalf("missing action = %#v, error = %v", loaded, err)
	}
	action := agentextensionbiz.SetupAction{
		AgentTargetID: "extension:other", ExtensionInstallationID: scope.ExtensionInstallationID,
	}
	if err := store.Put(context.Background(), scope, action); err == nil {
		t.Fatal("Put() error = nil, want scope rejection")
	}
}

func TestFileSetupDiscoveryDirectoryEnsuresPrivateStablePath(t *testing.T) {
	stateDir := t.TempDir()
	directory := NewFileSetupDiscoveryDirectory(stateDir)
	root, err := directory.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(stateDir, "agent", "discovery", "agent-extensions")
	if root != want {
		t.Fatalf("discovery root = %q, want %q", root, want)
	}
	info, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("discovery directory permissions = %o, want 700", info.Mode().Perm())
	}
}
