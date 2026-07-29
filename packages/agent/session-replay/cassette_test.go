package sessionreplay

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
)

func cassetteDigest(value string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(value)))
}

func validCassetteFiles() []CassetteFile {
	var result []CassetteFile
	for _, file := range requiredCassetteFiles() {
		result = append(result, CassetteFile{
			Path: file, SizeBytes: 1, SHA256: cassetteDigest(file),
		})
	}
	return result
}

func TestBuildAndValidateCassetteManifest(t *testing.T) {
	manifest, err := BuildCassetteManifest(CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:    "2026-07-28T10:00:00.000Z",
		ScopeID: "scope-1", AgentTargetID: "target-1",
		RootSessionID: "session-1", Mode: ScenarioModeCreateSession,
		CreatedAtUnixMS: 1,
	}, validCassetteFiles(), BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
		Blobs:         []BlobManifestEntry{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.TotalBytes != int64(len(requiredCassetteFiles())) {
		t.Fatalf("manifest = %#v", manifest)
	}
	if err := ValidateCassetteIntegrity(manifest, manifest.Files); err != nil {
		t.Fatal(err)
	}
}

func TestCassetteSchemaV3RequiresActivityEventsAndCheckpoints(t *testing.T) {
	if CassetteSchemaVersion != 3 {
		t.Fatalf("cassette schema version = %d, want 3", CassetteSchemaVersion)
	}
	required := requiredCassetteFiles()
	foundCheckpoints := false
	foundActivityEvents := false
	for _, file := range required {
		if file == CheckpointsFile {
			foundCheckpoints = true
		}
		if file == ActivityEventsFile {
			foundActivityEvents = true
		}
	}
	if !foundCheckpoints || !foundActivityEvents {
		t.Fatalf("v3 files are not required: %#v", required)
	}
	files := validCassetteFiles()
	for index, file := range files {
		if file.Path == CheckpointsFile {
			files = append(files[:index], files[index+1:]...)
			break
		}
	}
	_, err := BuildCassetteManifest(CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:    "2026-07-28T10:00:00.000Z",
		ScopeID: "scope-1", RootSessionID: "session-1", CreatedAtUnixMS: 1,
	}, files, BlobManifest{SchemaVersion: BlobManifestSchemaVersion})
	if err == nil || !strings.Contains(err.Error(), CheckpointsFile) {
		t.Fatalf("missing checkpoints error = %v", err)
	}
}

func TestCassetteManifestRejectsUnknownAndMissingFiles(t *testing.T) {
	input := CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:    "2026-07-28T10:00:00.000Z",
		ScopeID: "scope-1", RootSessionID: "session-1", CreatedAtUnixMS: 1,
	}
	files := validCassetteFiles()
	files = append(files, CassetteFile{
		Path: "desktop.log", SizeBytes: 1, SHA256: cassetteDigest("log"),
	})
	if _, err := BuildCassetteManifest(input, files, BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	}); err == nil || !strings.Contains(err.Error(), "unrelated file") {
		t.Fatalf("unknown file error = %v", err)
	}
	files = validCassetteFiles()[1:]
	if _, err := BuildCassetteManifest(input, files, BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	}); err == nil || !strings.Contains(err.Error(), "missing required file") {
		t.Fatalf("missing file error = %v", err)
	}
}

func TestCassetteIntegrityRejectsChangedHash(t *testing.T) {
	manifest, err := BuildCassetteManifest(CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:    "2026-07-28T10:00:00.000Z",
		ScopeID: "scope-1", RootSessionID: "session-1", CreatedAtUnixMS: 1,
	}, validCassetteFiles(), BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	actual := append([]CassetteFile(nil), manifest.Files...)
	actual[0].SHA256 = cassetteDigest("changed")
	if err := ValidateCassetteIntegrity(manifest, actual); err == nil {
		t.Fatal("changed cassette hash was accepted")
	}
}

func TestCassetteManifestPolicyRejectsTamperedAllowlist(t *testing.T) {
	manifest, err := BuildCassetteManifest(CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:    "2026-07-28T10:00:00.000Z",
		ScopeID: "scope-1", RootSessionID: "session-1", CreatedAtUnixMS: 1,
	}, validCassetteFiles(), BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest.Files = append(manifest.Files, CassetteFile{
		Path: "tuttid.db", Role: "database", SizeBytes: 1, SHA256: cassetteDigest("db"),
	})
	manifest.TotalBytes++
	if err := ValidateCassetteManifestPolicy(manifest, BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	}); err == nil {
		t.Fatal("tampered cassette allowlist was accepted")
	}
}

func TestCassetteBlobVocabularyControlsAllowlist(t *testing.T) {
	digest := cassetteDigest("blob")
	roles, err := AllowedCassetteFiles(BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
		Blobs: []BlobManifestEntry{{
			Kind: BlobKindAgentPromptAttachment, SHA256: digest, SizeBytes: 4,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if roles["blobs/sha256/"+digest] != "referenced-blob" {
		t.Fatalf("roles = %#v", roles)
	}
}
