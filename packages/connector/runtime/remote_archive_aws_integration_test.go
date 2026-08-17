package runtime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func TestRemoteArchiveInstallerRunsOfficialAWSCLI(t *testing.T) {
	if os.Getenv("TUTTI_RUN_AWS_REMOTE_ARCHIVE_SMOKE") != "1" {
		t.Skip("set TUTTI_RUN_AWS_REMOTE_ARCHIVE_SMOKE=1 for the official AWS CLI smoke")
	}
	if runtime.GOOS != "linux" || runtime.GOARCH != "arm64" {
		t.Skip("the pinned AWS smoke artifact targets linux-arm64")
	}
	release := market.Release{
		SchemaVersion: "1", ReleaseID: "aws-cli@0.2.0-smoke", ConnectorKey: "aws-cli", Version: "0.2.0",
		ReleaseDigest: strings.Repeat("d", 64), ManifestDigest: strings.Repeat("e", 64), Status: market.ReleaseStatusAvailable,
		Artifact:    market.Artifact{Key: "aws-cli.tgz", SHA256: strings.Repeat("f", 64), SizeBytes: 1, MediaType: "application/gzip"},
		PublishedAt: time.Unix(1, 0).UTC(),
		Manifest: market.Manifest{
			SchemaVersion: "1", DisplayName: "AWS CLI", IconURL: "data:image/png;base64,iVBORw0KGgo=", AuthorizationKind: "none",
			Compatibility: market.CompatibilityRequirements{MinimumHostVersion: "0.2.27", FallbackVersion: "0.1.1"},
			Implementation: market.Implementation{Kind: market.ImplementationKindManagedStdio, ManagedStdio: &market.ManagedStdioImplementation{
				Runtime: market.RuntimeRequirement{Language: "node", Profile: ConnectorNodeProfile, ABI: "node24-linux-arm64", VersionRange: ">=24.18.0 <25.0.0"},
				CLI: &market.ManagedCLIInterface{Entrypoint: "dist/aws", Command: "aws", TimeoutMS: 120_000, Install: &market.CLIInstallation{Kind: "remote_archive", RemoteArchive: &market.RemoteArchiveInstallation{
					Source: market.RemoteArchiveSource{
						URL: "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-2.36.24.zip", AllowedHosts: []string{"awscli.amazonaws.com"}, Format: "zip",
						SHA256: "c024c45a9d22005f81c7c0fab9e23ee7118ffa210d812845b42e980cf93727a7", SizeBytes: 70_691_953,
					},
					Extraction: market.RemoteArchiveExtraction{
						Root: "aws", FileCount: 7_558, ExpandedSizeBytes: 249_398_041, InventoryAlgorithm: "tutti.connector.tree.v1",
						InventorySHA256: "4eff269010e54d59dd29c715993e95dd2d6728726f384dc3c4750607b6ea2e15",
					},
					Launch: market.RemoteArchiveLaunch{Kind: "native", Entrypoint: "dist/aws", SHA256: "5b35976e1a04fbaa20848b6a9538f4757bcf941d4d1c31321aff0dfbd0492806", SizeBytes: 8_958_392},
				}}},
			}},
		},
	}
	installer, err := NewRemoteArchiveInstaller(RemoteArchiveInstallerConfig{RootDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := installer.InstallCLI(context.Background(), market.InstallCLIRequest{OperationID: "aws-smoke", Release: release})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(filepath.Join(receipt.InstallRoot, "dist", "aws"), "--version")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("aws --version failed: %v: %s", err, output)
	}
	if !strings.Contains(string(output), "aws-cli/2.36.24") {
		t.Fatalf("unexpected aws --version output: %s", output)
	}
}
