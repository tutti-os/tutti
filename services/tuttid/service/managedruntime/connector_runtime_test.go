package managedruntime

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var connectorRuntimeTestNow = time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)

func TestConnectorRuntimeResolverRequiresPinnedHTTPSAndKey(t *testing.T) {
	_, err := NewConnectorRuntimeResolver(ConnectorRuntimeResolverConfig{
		RuntimeRoot: t.TempDir(), CatalogURL: "http://runtime.test/catalog.json",
	})
	if err == nil || !strings.Contains(err.Error(), "app-pinned HTTPS") {
		t.Fatalf("NewConnectorRuntimeResolver() error = %v", err)
	}
}

func TestConnectorRuntimeResolverVerifiesSignedCatalogReceiptAndLaunchIdentity(t *testing.T) {
	resolver, catalog := signedConnectorNodeResolver(t)
	resolver.readCatalog = func(context.Context) ([]byte, error) { return catalog, nil }

	resolved, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Node == nil || !strings.Contains(resolved.Node.Path, filepath.Join("connector-v3", appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH))) {
		t.Fatalf("resolved connector runtime = %#v", resolved)
	}
	verified, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node")
	if err != nil || verified != *resolved.Node {
		t.Fatalf("VerifyLaunch() = %#v, %v", verified, err)
	}

	if err := os.WriteFile(resolved.Node.Path, []byte("tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node"); err == nil ||
		(!strings.Contains(err.Error(), "launch identity") && !strings.Contains(err.Error(), "not signed")) {
		t.Fatalf("tampered VerifyLaunch() error = %v", err)
	}
}

func TestConnectorRuntimeResolverRejectsInvalidCatalogSignature(t *testing.T) {
	resolver, catalog := signedConnectorNodeResolver(t)
	var envelope connectorCatalogEnvelope
	if err := json.Unmarshal(catalog, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Signature.Value = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	catalog, _ = json.Marshal(envelope)
	resolver.readCatalog = func(context.Context) ([]byte, error) { return catalog, nil }
	if _, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("ResolveProfile() error = %v", err)
	}
}

func TestConnectorRuntimeReceiptCannotAuthorizeChangedExecutableIdentity(t *testing.T) {
	resolver, catalog := signedConnectorNodeResolver(t)
	resolver.readCatalog = func(context.Context) ([]byte, error) { return catalog, nil }
	if _, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile); err != nil {
		t.Fatal(err)
	}
	receiptPath := resolver.receiptPath(ConnectorNodeProfile)
	data, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	var receipt connectorRuntimeReceipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	changed := receipt.Executables["node"]
	changed.SHA256 = strings.Repeat("0", 64)
	receipt.Executables["node"] = changed
	data, _ = json.Marshal(receipt)
	if err := os.WriteFile(receiptPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node"); err == nil || !strings.Contains(err.Error(), "not signed") {
		t.Fatalf("VerifyLaunch() error = %v", err)
	}
}

func TestConnectorRuntimeResolverRejectsProfilePathInjection(t *testing.T) {
	resolver, _ := signedConnectorNodeResolver(t)
	if _, err := resolver.VerifyLaunch("../connector-node-static", "node"); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("VerifyLaunch() error = %v, want unsupported profile", err)
	}
}

func TestConnectorRuntimeResolverRejectsCatalogRollbackAndEquivocation(t *testing.T) {
	resolver, catalog := signedConnectorNodeResolver(t)
	resolver.readCatalog = func(context.Context) ([]byte, error) { return catalog, nil }
	if _, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile); err != nil {
		t.Fatal(err)
	}

	var envelope connectorCatalogEnvelope
	if err := json.Unmarshal(catalog, &envelope); err != nil {
		t.Fatal(err)
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var payload connectorCatalogPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		t.Fatal(err)
	}
	payload.ApplicationVersion = "different-build"
	changedPayload, _ := json.Marshal(payload)
	envelope.Payload = base64.StdEncoding.EncodeToString(changedPayload)
	// A deliberately invalid signature must fail before an attacker can exploit
	// an equal sequence with different bytes.
	changedCatalog, _ := json.Marshal(envelope)
	if _, _, err := resolver.verifyCatalogEnvelope(changedCatalog); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("equivocated unsigned catalog error = %v", err)
	}

	state, err := resolver.readCatalogTrustState()
	if err != nil {
		t.Fatal(err)
	}
	state.PayloadSHA256 = strings.Repeat("0", 64)
	if err := resolver.writeCatalogTrustState(state); err != nil {
		t.Fatal(err)
	}
	if _, _, err := resolver.verifyCatalogEnvelope(catalog); err == nil || !strings.Contains(err.Error(), "equivocated") {
		t.Fatalf("equivocated catalog error = %v", err)
	}
	state.Sequence++
	if err := resolver.writeCatalogTrustState(state); err != nil {
		t.Fatal(err)
	}
	if _, _, err := resolver.verifyCatalogEnvelope(catalog); err == nil || !strings.Contains(err.Error(), "rolled back") {
		t.Fatalf("rolled back catalog error = %v", err)
	}
}

func TestConnectorRuntimeReceiptRefreshesAtNextUpdateAndExpiresClosed(t *testing.T) {
	resolver, catalog := signedConnectorNodeResolver(t)
	resolver.readCatalog = func(context.Context) ([]byte, error) { return catalog, nil }
	if _, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile); err != nil {
		t.Fatal(err)
	}
	resolver.now = func() time.Time { return connectorRuntimeTestNow.Add(2 * time.Hour) }
	if _, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile); err != nil {
		t.Fatalf("refresh using still-valid catalog: %v", err)
	}
	resolver.now = func() time.Time { return connectorRuntimeTestNow.Add(25 * time.Hour) }
	if _, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node"); err == nil || !strings.Contains(err.Error(), "not currently valid") {
		t.Fatalf("expired VerifyLaunch() error = %v", err)
	}
}

func TestConnectorRuntimeReceiptRequiresCompleteExecutableSet(t *testing.T) {
	resolver, catalog := signedConnectorNodeResolver(t)
	resolver.readCatalog = func(context.Context) ([]byte, error) { return catalog, nil }
	if _, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile); err != nil {
		t.Fatal(err)
	}
	receiptPath := resolver.receiptPath(ConnectorNodeProfile)
	data, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	var receipt connectorRuntimeReceipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	delete(receipt.Executables, "node")
	data, _ = json.Marshal(receipt)
	if err := os.WriteFile(receiptPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node"); err == nil || !strings.Contains(err.Error(), "executable set") {
		t.Fatalf("VerifyLaunch() error = %v, want executable set rejection", err)
	}
}

func TestConnectorRuntimeReceiptCannotResetMissingDurableTrustState(t *testing.T) {
	resolver, catalog := signedConnectorNodeResolver(t)
	resolver.readCatalog = func(context.Context) ([]byte, error) { return catalog, nil }
	if _, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(resolver.catalogTrustStatePath()); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.VerifyLaunch(ConnectorNodeProfile, "node"); err == nil || !strings.Contains(err.Error(), "no durable catalog trust state") {
		t.Fatalf("VerifyLaunch() missing trust error = %v", err)
	}
	// Resolve must go back through the online signed catalog path and recreate
	// trust instead of promoting the orphaned receipt.
	if _, err := resolver.ResolveProfile(context.Background(), ConnectorNodeProfile); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.readCatalogTrustState(); err != nil {
		t.Fatalf("durable trust was not recreated: %v", err)
	}
}

func signedConnectorNodeResolver(t *testing.T) (*ConnectorRuntimeResolver, []byte) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	artifactPath := createManagedRuntimeComponentArchiveForTest(t, "node")
	artifactSHA, _, err := fileSHA256AndSize(artifactPath)
	if err != nil {
		t.Fatal(err)
	}
	executableSHA, executableSize := zipEntryIdentity(t, artifactPath, filepath.ToSlash(filepath.Join("node", "bin", nodeBinaryName())))
	entry := appRuntimeCatalogEntry{
		Version: "test-v3",
		Components: map[string]appRuntimeCatalogComponent{
			"node": {
				Version:        "test-node-v3",
				ArtifactURL:    artifactPath,
				ArtifactSHA256: artifactSHA,
				Executables: map[string]appRuntimeCatalogExecutable{
					"node": {Path: filepath.ToSlash(filepath.Join("bin", nodeBinaryName())), SHA256: executableSHA, SizeBytes: executableSize},
				},
			},
		},
		Profiles: map[string][]string{
			appRuntimeBaselineProfile: {"node"},
			ConnectorNodeProfile:      {"node"},
		},
		ProfileABIs: map[string]string{ConnectorNodeProfile: "node20-" + runtime.GOOS + "-" + runtime.GOARCH},
	}
	payload, err := json.Marshal(connectorCatalogPayload{
		Sequence:           1,
		IssuedAt:           connectorRuntimeTestNow.Add(-time.Hour).Format(time.RFC3339),
		NextUpdateAt:       connectorRuntimeTestNow.Add(time.Hour).Format(time.RFC3339),
		ExpiresAt:          connectorRuntimeTestNow.Add(24 * time.Hour).Format(time.RFC3339),
		ApplicationVersion: "test-app-v1",
		Runtimes:           map[string]appRuntimeCatalogEntry{appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH): entry},
	})
	if err != nil {
		t.Fatal(err)
	}
	envelope := connectorCatalogEnvelope{
		SchemaVersion: ConnectorRuntimeCatalogSchemaVersion,
		Payload:       base64.StdEncoding.EncodeToString(payload),
		Signature: connectorCatalogSignature{
			Algorithm: "ed25519", KeyID: "test-key", Value: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload)),
		},
	}
	catalog, _ := json.Marshal(envelope)
	resolver, err := NewConnectorRuntimeResolver(ConnectorRuntimeResolverConfig{
		RuntimeRoot: t.TempDir(), CatalogURL: "https://runtime.test/catalog.json", CatalogPublicKey: publicKey, CatalogKeyID: "test-key",
		ApplicationVersion: "test-app-v1", Now: func() time.Time { return connectorRuntimeTestNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	return resolver, catalog
}

func zipEntryIdentity(t *testing.T, archivePath, name string) (string, int64) {
	t.Helper()
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for _, entry := range reader.File {
		if strings.TrimSuffix(entry.Name, "/") != name {
			continue
		}
		body, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.New()
		size, err := io.Copy(hash, body)
		_ = body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return hex.EncodeToString(hash.Sum(nil)), size
	}
	t.Fatalf("zip entry %q is missing", name)
	return "", 0
}
