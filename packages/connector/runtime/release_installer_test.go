package runtime

import (
	"context"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

type releaseArtifactStub struct {
	prepared market.PreparedArtifactReceipt
	removes  int
}

func (stub *releaseArtifactStub) Prepare(_ context.Context, request market.PrepareArtifactRequest) (market.PreparedArtifactReceipt, error) {
	receipt := stub.prepared
	receipt.OperationID = request.OperationID
	return receipt, nil
}

func (stub *releaseArtifactStub) Remove(context.Context, market.RemoveArtifactRequest) error {
	stub.removes++
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

func runtimeTestRelease() market.Release {
	return market.Release{
		SchemaVersion: "1", ReleaseID: "example@1.0.0", ConnectorKey: "example", Version: "1.0.0",
		ReleaseDigest:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Manifest: market.Manifest{SchemaVersion: "1", DisplayName: "Example",
			IconURL: "data:image/png;base64,YQ==", AuthorizationKind: "none",
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
