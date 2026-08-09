package artifact

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestImporterInstallsSynchronizedArchiveWithoutFetcher(t *testing.T) {
	manifest := []byte(`{"schemaVersion":"1","connectorKey":"github"}`)
	archive := testZIP(t, map[string][]byte{packagedManifestPath: manifest, "bin/connector": []byte("ready")})
	release := testRelease(archive, manifest)
	inbox := filepath.Join(t.TempDir(), "artifact.zip")
	if err := os.WriteFile(inbox, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	importer, err := NewImporter(ImporterConfig{RootDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := importer.Import(context.Background(), ImportArchiveRequest{
		OperationID: "install-1", Release: release, ArchivePath: inbox,
	})
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(receipt.PreparedPath, "bin", "connector"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "ready" {
		t.Fatalf("installed content = %q", content)
	}
	if _, err := importer.ResolvePrepared(context.Background(), release); err != nil {
		t.Fatal(err)
	}
}
