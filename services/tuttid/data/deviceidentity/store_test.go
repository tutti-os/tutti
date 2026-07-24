package deviceidentity

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileStoreCreatesAndReusesOneIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mobile-remote", "device-identity.json")
	store := NewFileStore(path, "device-1")
	store.now = func() time.Time {
		return time.Date(2026, time.July, 23, 5, 0, 0, 0, time.UTC)
	}

	first, err := store.LoadOrCreate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.LoadOrCreate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.DeviceID != "device-1" || first.CreatedAt != store.now() {
		t.Fatalf("identity metadata = %#v", first)
	}
	if len(first.PrivateKey) != ed25519.PrivateKeySize || len(first.PublicKey) != ed25519.PublicKeySize {
		t.Fatalf("identity key lengths = %d/%d", len(first.PrivateKey), len(first.PublicKey))
	}
	if string(first.PrivateKey) != string(second.PrivateKey) || string(first.PublicKey) != string(second.PublicKey) {
		t.Fatal("device identity changed between reads")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("identity file mode = %o, want 600", info.Mode().Perm())
	}
}

func TestFileStoreFailsClosedForMismatchedDeviceIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device-identity.json")
	first := NewFileStore(path, "device-1")
	if _, err := first.LoadOrCreate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFileStore(path, "device-2").LoadOrCreate(context.Background()); err == nil {
		t.Fatal("mismatched stable device id unexpectedly replaced the identity")
	}
}

func TestFileStoreFailsClosedForCorruptPrivateKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device-identity.json")
	if err := os.WriteFile(path, []byte(`{
		"schemaVersion": 1,
		"deviceId": "device-1",
		"algorithm": "ed25519",
		"privateKey": "not-a-private-key",
		"createdAt": "2026-07-23T05:00:00Z"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFileStore(path, "device-1").LoadOrCreate(context.Background()); err == nil {
		t.Fatal("corrupt private key unexpectedly regenerated")
	}
	var stored map[string]any
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &stored); err != nil || stored["privateKey"] != "not-a-private-key" {
		t.Fatalf("corrupt identity was overwritten: %#v, %v", stored, err)
	}
}
