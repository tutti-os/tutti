package artifact

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func TestPreparerVerifiesPromotesAndReusesLatestArtifact(t *testing.T) {
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"github"}`)
	archive := testZIP(t, map[string][]byte{
		packagedManifestPath: manifest,
		"bin/connector":      []byte("executable"),
	})
	release := testRelease(archive, manifest)
	fetcher := &memoryFetcher{body: archive, mediaType: release.Artifact.MediaType}
	root := t.TempDir()
	preparer, err := NewPreparer(Config{RootDir: root, Fetcher: fetcher})
	if err != nil {
		t.Fatal(err)
	}

	first, err := preparer.Prepare(context.Background(), market.PrepareArtifactRequest{
		OperationID: "operation-1",
		Release:     release,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := preparer.Prepare(context.Background(), market.PrepareArtifactRequest{
		OperationID: "operation-2",
		Release:     release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fetcher.calls != 1 {
		t.Fatalf("fetch calls = %d, want 1", fetcher.calls)
	}
	if first.PreparedPath != second.PreparedPath || second.OperationID != "operation-2" {
		t.Fatalf("receipts = %#v %#v", first, second)
	}
	content, err := os.ReadFile(filepath.Join(first.PreparedPath, "bin", "connector"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "executable" {
		t.Fatalf("prepared content = %q", content)
	}
	cached := filepath.Join(root, "cache", release.ConnectorKey, "current", downloadCacheArtifactFile)
	if _, err := os.Stat(cached); err != nil {
		t.Fatalf("current cached artifact: %v", err)
	}
}

func TestResolvePreparedAllowsLegacyReleaseWithoutIcon(t *testing.T) {
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"github"}`)
	archive := testZIP(t, map[string][]byte{
		packagedManifestPath: manifest,
		"bin/connector":      []byte("executable"),
	})
	release := testRelease(archive, manifest)
	preparer, err := NewPreparer(Config{
		RootDir: t.TempDir(),
		Fetcher: &memoryFetcher{body: archive, mediaType: release.Artifact.MediaType},
	})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := preparer.Prepare(context.Background(), market.PrepareArtifactRequest{
		OperationID: "operation-1",
		Release:     release,
	})
	if err != nil {
		t.Fatal(err)
	}

	legacyRelease := release
	legacyRelease.Manifest.IconURL = ""
	if err := os.WriteFile(filepath.Join(prepared.PreparedPath, ".DS_Store"), []byte("finder metadata"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolved, err := preparer.ResolvePrepared(context.Background(), legacyRelease)
	if err != nil {
		t.Fatalf("ResolvePrepared() rejected legacy presentation metadata: %v", err)
	}
	if resolved.PreparedPath != prepared.PreparedPath {
		t.Fatalf("resolved path = %q, want %q", resolved.PreparedPath, prepared.PreparedPath)
	}
	if _, err := preparer.Prepare(context.Background(), market.PrepareArtifactRequest{
		OperationID: "operation-2",
		Release:     legacyRelease,
	}); err == nil || !strings.Contains(err.Error(), "iconUrl") {
		t.Fatalf("Prepare() error = %v, want full icon validation", err)
	}
}

func TestResolvePreparedRepairsInvalidInventoryFromLatestVerifiedArtifact(t *testing.T) {
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"github"}`)
	archive := testZIP(t, map[string][]byte{
		packagedManifestPath: manifest,
		"bin/connector":      []byte("executable"),
	})
	release := testRelease(archive, manifest)
	fetcher := &memoryFetcher{body: archive, mediaType: release.Artifact.MediaType}
	preparer, err := NewPreparer(Config{RootDir: t.TempDir(), Fetcher: fetcher})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := preparer.Prepare(context.Background(), market.PrepareArtifactRequest{
		OperationID: "operation-1",
		Release:     release,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prepared.PreparedPath, ".DS_Store"), []byte("finder metadata"), 0o600); err != nil {
		t.Fatal(err)
	}

	resolved, err := preparer.ResolvePrepared(context.Background(), release)
	if err != nil {
		t.Fatalf("ResolvePrepared() failed to repair invalid inventory: %v", err)
	}
	if fetcher.calls != 1 {
		t.Fatalf("fetch calls = %d, want 1 verified artifact download", fetcher.calls)
	}
	if resolved.PreparedPath != prepared.PreparedPath || resolved.InventoryDigest != prepared.InventoryDigest {
		t.Fatalf("resolved receipt = %#v, want repaired %#v", resolved, prepared)
	}
	if _, err := os.Stat(filepath.Join(resolved.PreparedPath, ".DS_Store")); !os.IsNotExist(err) {
		t.Fatalf("unexpected metadata survived repair: %v", err)
	}
	content, err := os.ReadFile(filepath.Join(resolved.PreparedPath, "bin", "connector"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "executable" {
		t.Fatalf("repaired content = %q", content)
	}
}

func TestResolvePreparedRepairsModifiedContentFromLatestVerifiedArtifact(t *testing.T) {
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"github"}`)
	archive := testZIP(t, map[string][]byte{
		packagedManifestPath: manifest,
		"bin/connector":      []byte("executable"),
	})
	release := testRelease(archive, manifest)
	fetcher := &memoryFetcher{body: archive, mediaType: release.Artifact.MediaType}
	preparer, err := NewPreparer(Config{RootDir: t.TempDir(), Fetcher: fetcher})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := preparer.Prepare(context.Background(), market.PrepareArtifactRequest{
		OperationID: "operation-1",
		Release:     release,
	})
	if err != nil {
		t.Fatal(err)
	}
	connectorPath := filepath.Join(prepared.PreparedPath, "bin", "connector")
	if err := os.WriteFile(connectorPath, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := preparer.ResolvePrepared(context.Background(), release); err != nil {
		t.Fatalf("ResolvePrepared() failed to repair modified content: %v", err)
	}
	content, err := os.ReadFile(connectorPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "executable" {
		t.Fatalf("repaired content = %q", content)
	}
	if fetcher.calls != 1 {
		t.Fatalf("fetch calls = %d, want 1 verified artifact download", fetcher.calls)
	}
}

func TestPreparerRejectsArchivePathTraversal(t *testing.T) {
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"github"}`)
	archive := testZIP(t, map[string][]byte{
		packagedManifestPath: manifest,
		"../escape":          []byte("nope"),
	})
	release := testRelease(archive, manifest)
	root := t.TempDir()
	preparer, err := NewPreparer(Config{
		RootDir: root,
		Fetcher: &memoryFetcher{body: archive, mediaType: release.Artifact.MediaType},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = preparer.Prepare(context.Background(), market.PrepareArtifactRequest{
		OperationID: "operation-1",
		Release:     release,
	})
	if err == nil || !strings.Contains(err.Error(), "escapes the extraction root") {
		t.Fatalf("error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "escape")); !os.IsNotExist(err) {
		t.Fatalf("escape file exists: %v", err)
	}
}

type memoryFetcher struct {
	body      []byte
	mediaType string
	calls     int
}

func (fetcher *memoryFetcher) Fetch(context.Context, FetchRequest) (FetchResponse, error) {
	fetcher.calls++
	return FetchResponse{
		Body:          io.NopCloser(bytes.NewReader(fetcher.body)),
		ContentLength: int64(len(fetcher.body)),
		MediaType:     fetcher.mediaType,
	}, nil
}

func testZIP(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func testRelease(archive, manifest []byte) market.Release {
	artifactDigest := sha256.Sum256(archive)
	manifestDigest := sha256.Sum256(manifest)
	return market.Release{
		SchemaVersion:  "1",
		ReleaseID:      "github@1.0.0",
		ConnectorKey:   "github",
		Version:        "1.0.0",
		ReleaseDigest:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestDigest: hex.EncodeToString(manifestDigest[:]),
		Manifest: market.Manifest{
			SchemaVersion: "1",
			DisplayName:   "GitHub",
			IconURL:       "data:image/png;base64,iVBORw0KGgo=",
			Implementation: market.Implementation{
				Kind: market.ImplementationKindManagedStdio,
				ManagedStdio: &market.ManagedStdioImplementation{
					Runtime: market.RuntimeRequirement{Language: "node", Profile: "connector-node-static", ABI: "node20-darwin-arm64"},
					MCP:     &market.ManagedMCPInterface{Entrypoint: "bin/connector.js"},
				},
			},
			AuthorizationKind: "none",
		},
		Artifact: market.Artifact{
			Key:       "connectors/github/1.0.0.zip",
			SHA256:    hex.EncodeToString(artifactDigest[:]),
			SizeBytes: int64(len(archive)),
			MediaType: "application/vnd.tutti.connector+zip",
		},
		PublishedAt: time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC), Status: market.ReleaseStatusAvailable,
	}
}
