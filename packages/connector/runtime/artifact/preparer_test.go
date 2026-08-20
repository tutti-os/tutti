package artifact

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
	"runtime"
	"strings"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
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

func TestResolvePreparedRejectsReleaseWithoutHTTPSIcon(t *testing.T) {
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
	_, err = preparer.Prepare(context.Background(), market.PrepareArtifactRequest{
		OperationID: "operation-1",
		Release:     release,
	})
	if err != nil {
		t.Fatal(err)
	}

	invalidRelease := release
	invalidRelease.Manifest.IconURL = ""
	if _, err := preparer.ResolvePrepared(context.Background(), invalidRelease); err == nil || !strings.Contains(err.Error(), "iconUrl") {
		t.Fatalf("ResolvePrepared() error = %v, want iconUrl rejection", err)
	}
}

func TestResolvePreparedReportsInvalidInventoryWithoutRepair(t *testing.T) {
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

	_, err = preparer.ResolvePrepared(context.Background(), release)
	if !errors.Is(err, market.ErrReleaseInstallationInvalid) {
		t.Fatalf("ResolvePrepared() error = %v, want invalid installation", err)
	}
	if fetcher.calls != 1 {
		t.Fatalf("fetch calls = %d, want 1 verified artifact download", fetcher.calls)
	}
	if _, err := os.Stat(filepath.Join(prepared.PreparedPath, ".DS_Store")); err != nil {
		t.Fatalf("invalid tree was unexpectedly changed: %v", err)
	}
}

func TestResolvePreparedReportsModifiedContentWithoutRepair(t *testing.T) {
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

	if _, err := preparer.ResolvePrepared(context.Background(), release); !errors.Is(err, market.ErrReleaseInstallationInvalid) {
		t.Fatalf("ResolvePrepared() error = %v, want invalid installation", err)
	}
	content, err := os.ReadFile(connectorPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "tampered" {
		t.Fatalf("invalid content was unexpectedly repaired: %q", content)
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
	if err == nil {
		t.Fatalf("error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "escape")); !os.IsNotExist(err) {
		t.Fatalf("escape file exists: %v", err)
	}
}

func TestSafeArchiveEntryKeyRejectsWindowsUnsafePathsOnEveryHost(t *testing.T) {
	for _, name := range []string{
		`C:/runtime/gh.exe`, `\\server\share\gh.exe`, `runtime\gh.exe`, `runtime/gh.exe:stream`,
		`runtime/CON`, `runtime/nul.txt`, `runtime/COM1.exe`, `runtime/trailing.`, `runtime/trailing `,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := safeArchiveEntryKey(name); err == nil {
				t.Fatalf("Windows-unsafe archive path %q was accepted", name)
			}
		})
	}
}

func TestPreparerRejectsCaseCollidingArchiveEntries(t *testing.T) {
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"github"}`)
	archive := testZIPEntries(t, []testZIPEntry{
		{name: packagedManifestPath, content: manifest},
		{name: "runtime/GH.exe", content: []byte("first")},
		{name: "runtime/gh.exe", content: []byte("second")},
	})
	release := testRelease(archive, manifest)
	preparer, err := NewPreparer(Config{RootDir: t.TempDir(),
		Fetcher: &memoryFetcher{body: archive, mediaType: release.Artifact.MediaType}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = preparer.Prepare(context.Background(), market.PrepareArtifactRequest{OperationID: "operation-1", Release: release})
	if err == nil || !strings.Contains(err.Error(), "case-colliding") {
		t.Fatalf("case-colliding archive error = %v", err)
	}
}

func TestPreparerRemoveRejectsSymlinkParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symbolic-link removal coverage")
	}
	root := t.TempDir()
	preparer, err := NewPreparer(Config{
		RootDir: root,
		Fetcher: &memoryFetcher{mediaType: "application/zip"},
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("a", 64)
	victim := t.TempDir()
	victimRelease := filepath.Join(victim, digest)
	if err := os.MkdirAll(victimRelease, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(victimRelease, "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	connectorRoot := filepath.Join(root, "prepared", "github")
	if err := os.MkdirAll(connectorRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(connectorRoot, "1.0.0")); err != nil {
		t.Fatal(err)
	}
	err = preparer.Remove(context.Background(), market.RemoveArtifactRequest{
		ConnectorKey: "github", Version: "1.0.0", ReleaseDigest: digest,
	})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("Remove() error = %v, want symbolic-link rejection", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("Remove() followed a symlink parent: %v", err)
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
	entries := make([]testZIPEntry, 0, len(files))
	for name, content := range files {
		entries = append(entries, testZIPEntry{name: name, content: content})
	}
	return testZIPEntries(t, entries)
}

type testZIPEntry struct {
	name    string
	content []byte
}

func testZIPEntries(t *testing.T, entries []testZIPEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		file, err := writer.Create(entry.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(entry.content); err != nil {
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
			IconURL:       "https://cdn.example.test/tutti/connector-market/github/1.0.0/github-1.0.0-icon.svg",
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
