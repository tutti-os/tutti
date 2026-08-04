package sessionreplay

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestExportFixtureBlobsWritesContentAddressedAttachmentContract(t *testing.T) {
	stateDir := t.TempDir()
	recordingDirectory := t.TempDir()
	sessionID := "session-1"
	attachmentID := "attachment-1"
	data := []byte("portable image attachment")
	source := filepath.Join(
		stateDir,
		"agent",
		"attachments",
		sessionID,
		attachmentID+".png",
	)
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(
		filepath.Join(recordingDirectory, "blobs", "sha256"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(recordingDirectory, "blobs", "manifest.json")
	if err := writeJSONAtomic(manifestPath, blobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
		Blobs:         []blobManifestEntry{},
	}); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(recordingDirectory, ExpectedStateFile)
	state := map[string]any{
		"agent": map[string]any{
			"sessions": []any{map[string]any{
				"id": sessionID,
				"messages": []any{map[string]any{
					"payload": map[string]any{
						"content": []any{map[string]any{
							"type":         "image",
							"attachmentId": attachmentID,
							"mimeType":     "image/png",
						}},
					},
				}},
			}},
		},
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	store := &Store{StateDir: stateDir}
	if err := store.exportFixtureBlobs(statePath, recordingDirectory); err != nil {
		t.Fatal(err)
	}

	manifest, err := readBlobManifest(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Blobs) != 1 {
		t.Fatalf("blobs = %#v", manifest.Blobs)
	}
	digestBytes := sha256.Sum256(data)
	digest := hex.EncodeToString(digestBytes[:])
	entry := manifest.Blobs[0]
	if entry.Kind != BlobKindAgentPromptAttachment ||
		entry.SHA256 != digest ||
		entry.SizeBytes != int64(len(data)) ||
		entry.AgentSessionID != sessionID ||
		entry.AttachmentID != attachmentID ||
		entry.MimeType != "image/png" {
		t.Fatalf("entry = %#v", entry)
	}
	materialized, err := os.ReadFile(
		filepath.Join(recordingDirectory, "blobs", "sha256", digest),
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(materialized) != string(data) {
		t.Fatalf("blob = %q", materialized)
	}
}
