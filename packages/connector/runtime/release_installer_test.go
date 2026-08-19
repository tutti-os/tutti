package runtime

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorartifact "github.com/tutti-os/tutti/packages/connector/runtime/artifact"
)

type releaseArtifactStub struct {
	prepared         market.PreparedArtifactReceipt
	releaseRemoves   int
	connectorRemoves int
}

func (stub *releaseArtifactStub) Prepare(_ context.Context, request market.PrepareArtifactRequest) (market.PreparedArtifactReceipt, error) {
	receipt := stub.prepared
	receipt.OperationID = request.OperationID
	return receipt, nil
}

func (stub *releaseArtifactStub) ResolvePrepared(_ context.Context, release market.Release) (market.PreparedArtifactReceipt, error) {
	receipt := stub.prepared
	receipt.ConnectorKey = release.ConnectorKey
	receipt.Version = release.Version
	receipt.ReleaseDigest = release.ReleaseDigest
	receipt.ArtifactSHA256 = release.Artifact.SHA256
	return receipt, nil
}

func (stub *releaseArtifactStub) Remove(context.Context, market.RemoveArtifactRequest) error {
	stub.releaseRemoves++
	return nil
}

func (stub *releaseArtifactStub) RemoveConnector(context.Context, market.RemoveConnectorInstallationRequest) error {
	stub.connectorRemoves++
	return nil
}

func TestReleaseInstallerDoesNotActivateRuntime(t *testing.T) {
	release := runtimeTestRelease()
	artifacts := &releaseArtifactStub{prepared: market.PreparedArtifactReceipt{
		ConnectorKey: release.ConnectorKey, Version: release.Version, ReleaseDigest: release.ReleaseDigest,
		ArtifactSHA256: release.Artifact.SHA256,
	}}
	installer, err := NewReleaseInstaller(artifacts, nil)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := installer.InstallRelease(context.Background(), market.InstallReleaseRequest{
		OperationID: "install-1", Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ReleaseDigest != release.ReleaseDigest || receipt.CLIInstallation != nil {
		t.Fatalf("receipt = %#v", receipt)
	}
}

func TestReleaseInstallerUninstallRemovesPreparedArtifact(t *testing.T) {
	release := runtimeTestRelease()
	artifacts := &releaseArtifactStub{}
	installer, err := NewReleaseInstaller(artifacts, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := installer.UninstallRelease(context.Background(), market.UninstallReleaseRequest{
		OperationID: "uninstall-1",
		Release:     release,
	}); err != nil {
		t.Fatal(err)
	}
	if artifacts.connectorRemoves != 1 || artifacts.releaseRemoves != 0 {
		t.Fatalf("artifact connector/release removes = %d/%d, want 1/0", artifacts.connectorRemoves, artifacts.releaseRemoves)
	}
}

func TestReleaseInstallerUninstallRemovesReleaseWithObsoleteIcon(t *testing.T) {
	release := runtimeTestRelease()
	release.Manifest.IconURL = "data:image/png;base64,iVBORw0KGgo="
	artifacts := &releaseArtifactStub{}
	installer, err := NewReleaseInstaller(artifacts, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := installer.UninstallRelease(context.Background(), market.UninstallReleaseRequest{
		OperationID: "uninstall-obsolete-icon",
		Release:     release,
	}); err != nil {
		t.Fatal(err)
	}
	if artifacts.connectorRemoves != 1 {
		t.Fatalf("artifact connector removes = %d, want 1", artifacts.connectorRemoves)
	}
}

func TestReleaseInstallerUninstallRemovesEveryConnectorRelease(t *testing.T) {
	runtimeRoot := t.TempDir()
	nodePath := filepath.Join(runtimeRoot, "node", "bin", "node")
	corepackPath := filepath.Join(runtimeRoot, "node", "lib", "node_modules", "corepack", "dist", "corepack.js")
	for _, path := range []string{nodePath, corepackPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("managed"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"lark"}`)
	firstArchive := releaseInstallerTestZIP(t, manifest, "v1")
	secondArchive := releaseInstallerTestZIP(t, manifest, "v2")
	first := releaseInstallerNodeRelease("1.0.0", strings.Repeat("1", 64), firstArchive, manifest)
	second := releaseInstallerNodeRelease("2.0.0", strings.Repeat("2", 64), secondArchive, manifest)
	stateRoot := t.TempDir()
	artifacts, err := connectorartifact.NewPreparer(connectorartifact.Config{
		RootDir: filepath.Join(stateRoot, "artifacts"),
		Fetcher: releaseInstallerFetcher{archives: map[string][]byte{
			first.ReleaseDigest: firstArchive, second.ReleaseDigest: secondArchive,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cliRoot := filepath.Join(stateRoot, "node-packages")
	cli, err := NewNodePackageInstaller(NodePackageInstallerConfig{
		RootDir: cliRoot,
		Runtimes: nodePackageRuntimeStub{root: runtimeRoot, node: ConnectorExecutable{
			Path: nodePath, SHA256: strings.Repeat("a", 64), SizeBytes: 7,
		}},
		Processes: &nodePackageProcessStub{},
	})
	if err != nil {
		t.Fatal(err)
	}
	installer, err := NewReleaseInstaller(artifacts, cli)
	if err != nil {
		t.Fatal(err)
	}
	firstReceipt, err := installer.InstallRelease(context.Background(), market.InstallReleaseRequest{
		OperationID: "install-v1", Release: first,
	})
	if err != nil {
		t.Fatal(err)
	}
	secondReceipt, err := installer.InstallRelease(context.Background(), market.InstallReleaseRequest{
		OperationID: "install-v2", Release: second,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		firstReceipt.Artifact.PreparedPath,
		firstReceipt.CLIInstallation.InstallRoot,
		secondReceipt.Artifact.PreparedPath,
		secondReceipt.CLIInstallation.InstallRoot,
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("installed release path %q is unavailable: %v", path, err)
		}
	}
	sharedMarker := filepath.Join(cliRoot, "shared", "pnpm-store", "shared-marker")
	if err := os.WriteFile(sharedMarker, []byte("shared"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installer.UninstallRelease(context.Background(), market.UninstallReleaseRequest{
		OperationID: "uninstall", Release: second,
	}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(stateRoot, "artifacts", "prepared", first.ConnectorKey),
		filepath.Join(cliRoot, "packages", first.ConnectorKey),
		filepath.Join(stateRoot, "artifacts", "cache", first.ConnectorKey),
	} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("Connector uninstall retained %q: %v", path, err)
		}
	}
	if content, err := os.ReadFile(sharedMarker); err != nil || string(content) != "shared" {
		t.Fatalf("Connector uninstall changed shared package storage: %q, %v", content, err)
	}
}

type releaseInstallerFetcher struct{ archives map[string][]byte }

func (fetcher releaseInstallerFetcher) Fetch(_ context.Context, request connectorartifact.FetchRequest) (connectorartifact.FetchResponse, error) {
	archive := fetcher.archives[request.Release.ReleaseDigest]
	return connectorartifact.FetchResponse{
		Body: io.NopCloser(bytes.NewReader(archive)), ContentLength: int64(len(archive)), MediaType: "application/zip",
	}, nil
}

func releaseInstallerTestZIP(t *testing.T, manifest []byte, version string) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for path, content := range map[string][]byte{
		"connector-manifest.json": manifest,
		"connector.js":            []byte("// " + version),
	} {
		entry, err := writer.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func releaseInstallerNodeRelease(version, releaseDigest string, archive, manifest []byte) market.Release {
	release := testNodePackageRelease("lark", releaseDigest)
	artifactDigest := sha256.Sum256(archive)
	manifestDigest := sha256.Sum256(manifest)
	release.ReleaseID = release.ConnectorKey + "@" + version
	release.Version = version
	release.ManifestDigest = hex.EncodeToString(manifestDigest[:])
	release.Artifact = market.Artifact{Key: release.ReleaseID + ".zip", SHA256: hex.EncodeToString(artifactDigest[:]),
		SizeBytes: int64(len(archive)), MediaType: "application/zip"}
	return release
}

func runtimeTestRelease() market.Release {
	return market.Release{
		SchemaVersion: "1", ReleaseID: "example@1.0.0", ConnectorKey: "example", Version: "1.0.0",
		ReleaseDigest:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Manifest: market.Manifest{SchemaVersion: "1", DisplayName: "Example",
			IconURL: "https://cdn.example.test/tutti/connector-market/example/1.0.0/example-1.0.0-icon.svg", AuthorizationKind: "none",
			Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio,
				ManagedStdio: &market.ManagedStdioImplementation{
					Runtime: market.RuntimeRequirement{Language: "node", Profile: "connector-node-static", ABI: "node24-linux-arm64"},
					MCP:     &market.ManagedMCPInterface{Entrypoint: "connector.js"},
				}},
		},
		Artifact: market.Artifact{Key: "example.zip", SHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			SizeBytes: 1, MediaType: "application/zip"},
		PublishedAt: time.Date(2026, 8, 7, 0, 0, 0, 0, time.UTC), Status: market.ReleaseStatusAvailable,
	}
}
