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

func TestFileAccountUsageCompanionFailureStoreRoundTripsPrivateState(t *testing.T) {
	stateDir := t.TempDir()
	store := NewFileAccountUsageCompanionFailureStore(stateDir)
	scope := agentextensionbiz.AccountUsageCompanionFailureScope{
		AgentTargetID: "extension:kimi-code", ExtensionInstallationID: "kimi-code@1.0.11",
	}
	failure := agentextensionbiz.AccountUsageCompanionFailure{
		SchemaVersion: agentextensionbiz.AccountUsageCompanionFailureSchemaVersion,
		AgentTargetID: scope.AgentTargetID, ExtensionInstallationID: scope.ExtensionInstallationID,
		RuntimeIdentity: "account-usage-runtime", ErrorCode: "install_failed", ConsecutiveFailures: 2,
		LastAttemptAtUnixMS: 100, NextAttemptAtUnixMS: 2100,
	}
	if err := store.Put(context.Background(), scope, failure); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(scope.AgentTargetID + "\x00" + scope.ExtensionInstallationID))
	path := filepath.Join(
		stateDir, "agent", "extension-account-usage-companion-failures", hex.EncodeToString(digest[:])+".json",
	)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("failure file permissions = %o, want 600", info.Mode().Perm())
	}
	if dirInfo, err := os.Stat(filepath.Dir(path)); err != nil || dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("failure directory = %#v, error = %v", dirInfo, err)
	}
	loaded, err := store.Read(context.Background(), scope)
	if err != nil || loaded == nil || !reflect.DeepEqual(*loaded, failure) {
		t.Fatalf("loaded failure = %#v, error = %v", loaded, err)
	}
	if err := store.Delete(context.Background(), scope); err != nil {
		t.Fatal(err)
	}
	if loaded, err := store.Read(context.Background(), scope); err != nil || loaded != nil {
		t.Fatalf("deleted failure = %#v, error = %v", loaded, err)
	}
}

func TestFileAccountUsageCompanionFailureStoreRejectsSensitiveOrMismatchedState(t *testing.T) {
	store := NewFileAccountUsageCompanionFailureStore(t.TempDir())
	scope := agentextensionbiz.AccountUsageCompanionFailureScope{
		AgentTargetID: "extension:kimi-code", ExtensionInstallationID: "kimi-code@1.0.11",
	}
	failure := agentextensionbiz.AccountUsageCompanionFailure{
		SchemaVersion: agentextensionbiz.AccountUsageCompanionFailureSchemaVersion,
		AgentTargetID: scope.AgentTargetID, ExtensionInstallationID: scope.ExtensionInstallationID,
		RuntimeIdentity: "account-usage-runtime", ErrorCode: "provider said secret token=abc",
		ConsecutiveFailures: 1, LastAttemptAtUnixMS: 100, NextAttemptAtUnixMS: 1100,
	}
	if err := store.Put(context.Background(), scope, failure); err == nil {
		t.Fatal("Put() error = nil, want stable error-code rejection")
	}
	failure.ErrorCode = "install_failed"
	failure.AgentTargetID = "extension:other"
	if err := store.Put(context.Background(), scope, failure); err == nil {
		t.Fatal("Put() error = nil, want scope rejection")
	}
}
