package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestDownloadCacheKeepsCurrentUntilCandidateIsPromoted(t *testing.T) {
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"github"}`)
	firstArchive := testZIP(t, map[string][]byte{packagedManifestPath: manifest, "version": []byte("one")})
	secondArchive := testZIP(t, map[string][]byte{packagedManifestPath: manifest, "version": []byte("two")})
	first := testRelease(firstArchive, manifest)
	fetcher := &memoryFetcher{body: firstArchive, mediaType: first.Artifact.MediaType}
	root := t.TempDir()
	cache, err := NewDownloadCache(DownloadCacheConfig{RootDir: root, Fetcher: fetcher})
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := cache.PrepareCandidate(context.Background(), market.PrepareArtifactRequest{OperationID: "install-1", Release: first})
	if err != nil {
		t.Fatal(err)
	}
	current, err := cache.PromoteCandidate(context.Background(), candidate, first)
	if err != nil {
		t.Fatal(err)
	}

	second := first
	second.ReleaseID = "github@2.0.0"
	second.Version = "2.0.0"
	second.ReleaseDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	secondDigest := sha256.Sum256(secondArchive)
	second.Artifact.SHA256 = hex.EncodeToString(secondDigest[:])
	second.Artifact.SizeBytes = int64(len(secondArchive))
	second.Artifact.Key = "connectors/github/2.0.0.zip"
	fetcher.body = secondArchive

	secondCandidate, err := cache.PrepareCandidate(context.Background(), market.PrepareArtifactRequest{OperationID: "install-2", Release: second})
	if err != nil {
		t.Fatal(err)
	}
	if secondCandidate.Slot != "candidate" {
		t.Fatalf("candidate slot = %q", secondCandidate.Slot)
	}
	stillCurrent, err := os.ReadFile(current.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(stillCurrent) != string(firstArchive) {
		t.Fatal("current artifact changed before candidate promotion")
	}
	promoted, err := cache.PromoteCandidate(context.Background(), secondCandidate, second)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(promoted.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(secondArchive) || promoted.Slot != "current" {
		t.Fatalf("promoted artifact = %#v", promoted)
	}
	if _, err := os.Stat(filepath.Join(root, first.ConnectorKey, "candidate")); !os.IsNotExist(err) {
		t.Fatalf("candidate remains after promotion: %v", err)
	}
}
