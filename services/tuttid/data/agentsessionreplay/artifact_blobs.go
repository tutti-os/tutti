package agentsessionreplay

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

var (
	maxPortablePromptAsset = replay.MaxPortableBlobBytes
)

type blobManifest = replay.BlobManifest
type blobManifestEntry = replay.BlobManifestEntry

type fixtureRecord struct {
	Table  string         `json:"table"`
	Values map[string]any `json:"values"`
}

type attachmentReference struct {
	AgentSessionID string
	AttachmentID   string
	MimeType       string
}

// exportFixtureBlobs adds file dependencies explicitly referenced by the
// exported SessionGraph. It does not scan the workspace or copy a state tree.
func (s *Store) exportFixtureBlobs(fixturePath, recordingDirectory string) error {
	references, err := attachmentReferencesFromFixture(fixturePath)
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(recordingDirectory, "blobs", "manifest.json")
	manifest, err := readBlobManifest(manifestPath)
	if err != nil {
		return err
	}
	known := make(map[string]struct{}, len(manifest.Blobs))
	for _, entry := range manifest.Blobs {
		known[blobReferenceKey(entry.AgentSessionID, entry.AttachmentID, entry.MimeType)] = struct{}{}
	}
	for _, reference := range references {
		key := blobReferenceKey(reference.AgentSessionID, reference.AttachmentID, reference.MimeType)
		if _, ok := known[key]; ok {
			continue
		}
		entry, err := s.copyAttachmentBlob(recordingDirectory, reference)
		if err != nil {
			return err
		}
		manifest.Blobs = append(manifest.Blobs, entry)
		known[key] = struct{}{}
	}
	return writeJSONAtomic(manifestPath, manifest)
}

func attachmentReferencesFromFixture(path string) ([]attachmentReference, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	seen := map[string]struct{}{}
	var references []attachmentReference
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		var record fixtureRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			return nil, fmt.Errorf("decode fixture record for blobs: %w", err)
		}
		if record.Table != "workspace_agent_messages" {
			continue
		}
		sessionID, _ := record.Values["agent_session_id"].(string)
		payloadJSON, _ := record.Values["payload_json"].(string)
		if strings.TrimSpace(sessionID) == "" || strings.TrimSpace(payloadJSON) == "" {
			continue
		}
		var payload any
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
			return nil, fmt.Errorf("decode message payload for blobs: %w", err)
		}
		for _, image := range findAttachmentImages(payload) {
			reference := attachmentReference{
				AgentSessionID: sessionID,
				AttachmentID:   image.AttachmentID,
				MimeType:       image.MimeType,
			}
			key := blobReferenceKey(sessionID, image.AttachmentID, image.MimeType)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			references = append(references, reference)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return references, nil
}

func findAttachmentImages(value any) []attachmentReference {
	var result []attachmentReference
	var visit func(any)
	visit = func(current any) {
		switch typed := current.(type) {
		case []any:
			for _, item := range typed {
				visit(item)
			}
		case map[string]any:
			if typed["type"] == "image" {
				attachmentID, _ := typed["attachmentId"].(string)
				mimeType, _ := typed["mimeType"].(string)
				if strings.TrimSpace(attachmentID) != "" && promptImageExtension(mimeType) != "" {
					result = append(result, attachmentReference{
						AttachmentID: strings.TrimSpace(attachmentID),
						MimeType:     strings.TrimSpace(mimeType),
					})
				}
			}
			for _, item := range typed {
				visit(item)
			}
		}
	}
	visit(value)
	return result
}

func (s *Store) copyAttachmentBlob(
	recordingDirectory string,
	reference attachmentReference,
) (blobManifestEntry, error) {
	if !safeBlobSegment(reference.AgentSessionID) || !safeBlobSegment(reference.AttachmentID) {
		return blobManifestEntry{}, errors.New("invalid attachment blob identity")
	}
	extension := promptImageExtension(reference.MimeType)
	if extension == "" {
		return blobManifestEntry{}, errors.New("unsupported attachment blob media type")
	}
	source := filepath.Join(
		filepath.Clean(strings.TrimSpace(s.StateDir)),
		"agent",
		"attachments",
		reference.AgentSessionID,
		reference.AttachmentID+extension,
	)
	file, err := os.Open(source)
	if err != nil {
		return blobManifestEntry{}, fmt.Errorf("open Agent Session attachment blob: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return blobManifestEntry{}, fmt.Errorf("stat Agent Session attachment blob: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > maxPortablePromptAsset {
		return blobManifestEntry{}, fmt.Errorf(
			"agent session attachment blob is not a supported regular file: size=%d limit=%d",
			info.Size(),
			maxPortablePromptAsset,
		)
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return blobManifestEntry{}, fmt.Errorf("hash Agent Session attachment blob: %w", err)
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	destination := filepath.Join(recordingDirectory, "blobs", "sha256", digest)
	if _, err := os.Stat(destination); errors.Is(err, os.ErrNotExist) {
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return blobManifestEntry{}, err
		}
		tempPath := destination + ".tmp"
		output, err := os.OpenFile(tempPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return blobManifestEntry{}, err
		}
		_, copyErr := io.Copy(output, file)
		closeErr := output.Close()
		if err := errors.Join(copyErr, closeErr); err != nil {
			_ = os.Remove(tempPath)
			return blobManifestEntry{}, err
		}
		if err := os.Rename(tempPath, destination); err != nil {
			_ = os.Remove(tempPath)
			return blobManifestEntry{}, err
		}
	} else if err != nil {
		return blobManifestEntry{}, err
	}
	return blobManifestEntry{
		Kind:           replay.BlobKindAgentPromptAttachment,
		SHA256:         digest,
		SizeBytes:      size,
		AgentSessionID: reference.AgentSessionID,
		AttachmentID:   reference.AttachmentID,
		MimeType:       reference.MimeType,
	}, nil
}

func readBlobManifest(path string) (blobManifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return blobManifest{}, err
	}
	var manifest blobManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return blobManifest{}, err
	}
	if manifest.SchemaVersion != replay.BlobManifestSchemaVersion {
		return blobManifest{}, errors.New("unsupported blob manifest schema version")
	}
	if manifest.Blobs == nil {
		manifest.Blobs = []blobManifestEntry{}
	}
	return manifest, nil
}

func promptImageExtension(mimeType string) string {
	switch strings.TrimSpace(mimeType) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	default:
		return ""
	}
}

func safeBlobSegment(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && value != "." && value != ".." &&
		!strings.ContainsAny(value, `/\`) && filepath.Base(value) == value
}

func blobReferenceKey(sessionID, attachmentID, mimeType string) string {
	return sessionID + "\x00" + attachmentID + "\x00" + mimeType
}

// portableActivityEventPayload replaces accepted staged image paths with inline
// bytes. The replay API can then persist the same input without reading the
// recording machine's state directory.
func (s *Store) portableActivityEventPayload(payload map[string]any) (map[string]any, error) {
	if payload == nil {
		return nil, nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var portable map[string]any
	if err := json.Unmarshal(raw, &portable); err != nil {
		return nil, err
	}
	content, _ := portable["content"].([]any)
	for _, item := range content {
		block, _ := item.(map[string]any)
		if block["type"] != "image" {
			continue
		}
		path, _ := block["path"].(string)
		if strings.TrimSpace(path) == "" {
			continue
		}
		data, err := s.readPortablePromptAsset(path)
		if err != nil {
			return nil, err
		}
		block["data"] = base64.StdEncoding.EncodeToString(data)
		delete(block, "path")
	}
	return portable, nil
}

func (s *Store) readPortablePromptAsset(path string) ([]byte, error) {
	root := filepath.Join(filepath.Clean(strings.TrimSpace(s.StateDir)), "agent-prompt-assets")
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve prompt asset root for recording: %w", err)
	}
	resolvedPath, err := filepath.EvalSymlinks(strings.TrimSpace(path))
	if err != nil {
		return nil, fmt.Errorf("resolve prompt asset for recording: %w", err)
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relative) {
		return nil, errors.New("recording prompt asset is outside the state asset root")
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxPortablePromptAsset {
		return nil, errors.New("recording prompt asset is not a supported regular file")
	}
	return os.ReadFile(resolvedPath)
}
