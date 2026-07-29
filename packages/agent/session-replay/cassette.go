package sessionreplay

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
)

const BlobKindAgentPromptAttachment = "agent-prompt-attachment"

type CassetteFile struct {
	Path      string `json:"path"`
	Role      string `json:"role"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

type CassetteManifest struct {
	SchemaVersion     int            `json:"schemaVersion"`
	ID                string         `json:"id"`
	Name              string         `json:"name"`
	SourceRecordingID string         `json:"sourceRecordingId"`
	ScopeID           string         `json:"scopeId"`
	AgentTargetID     string         `json:"agentTargetId"`
	RootSessionID     string         `json:"rootAgentSessionId"`
	Mode              ScenarioMode   `json:"mode"`
	TotalBytes        int64          `json:"totalBytes"`
	MaxTotalBytes     int64          `json:"maxTotalBytes"`
	Files             []CassetteFile `json:"files"`
	CreatedAtUnixMS   int64          `json:"createdAtUnixMs"`
}

type BlobManifest struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Blobs         []BlobManifestEntry `json:"blobs"`
}

type BlobManifestEntry struct {
	Kind           string `json:"kind"`
	SHA256         string `json:"sha256"`
	SizeBytes      int64  `json:"sizeBytes"`
	AgentSessionID string `json:"agentSessionId"`
	AttachmentID   string `json:"attachmentId"`
	MimeType       string `json:"mimeType"`
}

type CassetteManifestInput struct {
	ID                string
	Name              string
	SourceRecordingID string
	ScopeID           string
	AgentTargetID     string
	RootSessionID     string
	Mode              ScenarioMode
	CreatedAtUnixMS   int64
}

func BuildCassetteManifest(
	input CassetteManifestInput,
	files []CassetteFile,
	blobs BlobManifest,
) (CassetteManifest, error) {
	roles, err := AllowedCassetteFiles(blobs)
	if err != nil {
		return CassetteManifest{}, err
	}
	if strings.TrimSpace(input.ID) == "" ||
		strings.TrimSpace(input.SourceRecordingID) == "" ||
		strings.TrimSpace(input.ScopeID) == "" ||
		strings.TrimSpace(input.RootSessionID) == "" ||
		input.CreatedAtUnixMS <= 0 {
		return CassetteManifest{}, ErrInvalidState
	}
	name, err := NormalizeRecordingName(input.Name)
	if err != nil {
		return CassetteManifest{}, err
	}
	seen := make(map[string]struct{}, len(files))
	blobSizes := make(map[string]int64, len(blobs.Blobs))
	for _, blob := range blobs.Blobs {
		blobSizes[path.Join("blobs", "sha256", strings.ToLower(blob.SHA256))] = blob.SizeBytes
	}
	var total int64
	validated := append([]CassetteFile(nil), files...)
	for index := range validated {
		file := &validated[index]
		role, ok := roles[file.Path]
		if !ok {
			return CassetteManifest{}, fmt.Errorf("cassette contains unrelated file %q", file.Path)
		}
		if _, exists := seen[file.Path]; exists {
			return CassetteManifest{}, fmt.Errorf("cassette contains duplicate file %q", file.Path)
		}
		if file.Role != "" && file.Role != role {
			return CassetteManifest{}, fmt.Errorf("cassette file %q has role %q, want %q", file.Path, file.Role, role)
		}
		if file.SizeBytes < 0 || !validSHA256(file.SHA256) {
			return CassetteManifest{}, fmt.Errorf("cassette file %q has invalid integrity evidence", file.Path)
		}
		if file.Path == ProviderFramesFile && file.SizeBytes > MaxProviderTapeBytes {
			return CassetteManifest{}, fmt.Errorf(
				"provider tape size limit exceeded: total=%d limit=%d",
				file.SizeBytes,
				MaxProviderTapeBytes,
			)
		}
		if blobSize, ok := blobSizes[file.Path]; ok && blobSize != file.SizeBytes {
			return CassetteManifest{}, fmt.Errorf("cassette blob size mismatch for %q", file.Path)
		}
		file.Role = role
		total += file.SizeBytes
		if total > MaxCassetteBytes {
			return CassetteManifest{}, fmt.Errorf(
				"cassette size limit exceeded: total=%d limit=%d",
				total,
				MaxCassetteBytes,
			)
		}
		seen[file.Path] = struct{}{}
	}
	for _, required := range requiredCassetteFiles() {
		if _, ok := seen[required]; !ok {
			return CassetteManifest{}, fmt.Errorf("cassette is missing required file %q", required)
		}
	}
	sort.Slice(validated, func(i, j int) bool { return validated[i].Path < validated[j].Path })
	return CassetteManifest{
		SchemaVersion:     CassetteSchemaVersion,
		ID:                input.ID,
		Name:              name,
		SourceRecordingID: input.SourceRecordingID,
		ScopeID:           input.ScopeID,
		AgentTargetID:     input.AgentTargetID,
		RootSessionID:     input.RootSessionID,
		Mode:              input.Mode,
		TotalBytes:        total,
		MaxTotalBytes:     MaxCassetteBytes,
		Files:             validated,
		CreatedAtUnixMS:   input.CreatedAtUnixMS,
	}, nil
}

func ValidateCassetteIntegrity(
	manifest CassetteManifest,
	actual []CassetteFile,
) error {
	if manifest.SchemaVersion != CassetteSchemaVersion ||
		manifest.MaxTotalBytes != MaxCassetteBytes {
		return errors.New("unsupported cassette manifest schema or size policy")
	}
	expected := make(map[string]CassetteFile, len(manifest.Files))
	for _, file := range manifest.Files {
		expected[file.Path] = file
	}
	if len(expected) != len(actual) {
		return errors.New("cassette file inventory mismatch")
	}
	var total int64
	for _, file := range actual {
		want, ok := expected[file.Path]
		if !ok || want.Role != file.Role ||
			want.SizeBytes != file.SizeBytes ||
			!strings.EqualFold(want.SHA256, file.SHA256) {
			return fmt.Errorf("cassette file integrity mismatch for %q", file.Path)
		}
		total += file.SizeBytes
	}
	if total != manifest.TotalBytes || total > MaxCassetteBytes {
		return errors.New("cassette total size mismatch")
	}
	return nil
}

func ValidateCassetteManifestPolicy(
	manifest CassetteManifest,
	blobs BlobManifest,
) error {
	if manifest.SchemaVersion != CassetteSchemaVersion ||
		manifest.MaxTotalBytes != MaxCassetteBytes {
		return errors.New("unsupported cassette manifest schema or size policy")
	}
	rebuilt, err := BuildCassetteManifest(CassetteManifestInput{
		ID:                manifest.ID,
		Name:              manifest.Name,
		SourceRecordingID: manifest.SourceRecordingID,
		ScopeID:           manifest.ScopeID,
		AgentTargetID:     manifest.AgentTargetID,
		RootSessionID:     manifest.RootSessionID,
		Mode:              manifest.Mode,
		CreatedAtUnixMS:   manifest.CreatedAtUnixMS,
	}, manifest.Files, blobs)
	if err != nil {
		return err
	}
	if rebuilt.TotalBytes != manifest.TotalBytes ||
		len(rebuilt.Files) != len(manifest.Files) {
		return errors.New("cassette manifest inventory mismatch")
	}
	return nil
}

func AllowedCassetteFiles(blobs BlobManifest) (map[string]string, error) {
	if blobs.SchemaVersion != BlobManifestSchemaVersion {
		return nil, errors.New("unsupported blob manifest schema version")
	}
	roles := make(map[string]string, len(PortableCassettePolicy.Files))
	for _, file := range PortableCassettePolicy.Files {
		if file.Inventory != nil && !*file.Inventory {
			continue
		}
		roles[file.Path] = file.Role
	}
	for _, blob := range blobs.Blobs {
		digest := strings.ToLower(strings.TrimSpace(blob.SHA256))
		if !validSHA256(digest) || blob.SizeBytes < 0 ||
			blob.SizeBytes > MaxPortableBlobBytes ||
			strings.TrimSpace(blob.Kind) == "" {
			return nil, fmt.Errorf("cassette blob has invalid integrity evidence %q", blob.SHA256)
		}
		roles[path.Join("blobs", "sha256", digest)] = "referenced-blob"
	}
	return roles, nil
}

func requiredCassetteFiles() []string {
	required := []string{}
	for _, file := range PortableCassettePolicy.Files {
		if file.Required {
			required = append(required, file.Path)
		}
	}
	sort.Strings(required)
	return required
}

func validSHA256(value string) bool {
	decoded, err := hex.DecodeString(strings.TrimSpace(value))
	return err == nil && len(decoded) == sha256.Size
}
