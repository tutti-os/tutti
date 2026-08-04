package sessionreplay

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

var (
	maxPortablePromptAsset = MaxPortableBlobBytes
)

type blobManifest = BlobManifest
type blobManifestEntry = BlobManifestEntry

type attachmentReference struct {
	AgentSessionID string
	AttachmentID   string
	MimeType       string
}

type generatedImageReference struct {
	AgentSessionID        string
	ProviderHomeDirectory string
	RelativePath          string
	MimeType              string
}

// exportFixtureBlobs adds file dependencies explicitly referenced by the
// exported SessionGraph. It does not scan the workspace or copy a state tree.
func (s *Store) exportFixtureBlobs(statePath, recordingDirectory string) error {
	attachments, generatedImages, err := blobReferencesFromReplayState(statePath)
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
		known[blobManifestEntryKey(entry)] = struct{}{}
	}
	for _, reference := range attachments {
		key := attachmentBlobReferenceKey(
			reference.AgentSessionID,
			reference.AttachmentID,
			reference.MimeType,
		)
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
	for _, reference := range generatedImages {
		key := generatedImageBlobReferenceKey(
			reference.AgentSessionID,
			reference.RelativePath,
			reference.MimeType,
		)
		if _, ok := known[key]; ok {
			continue
		}
		entry, err := s.copyGeneratedImageBlob(recordingDirectory, reference)
		if err != nil {
			return err
		}
		manifest.Blobs = append(manifest.Blobs, entry)
		known[key] = struct{}{}
	}
	return writeJSONAtomic(manifestPath, manifest)
}

func blobReferencesFromReplayState(
	statePath string,
) ([]attachmentReference, []generatedImageReference, error) {
	raw, err := os.ReadFile(statePath)
	if err != nil {
		return nil, nil, err
	}
	var state struct {
		Agent struct {
			Sessions []struct {
				ID            string `json:"id"`
				AgentTargetID string `json:"agentTargetId"`
				Provider      string `json:"provider"`
				Messages      []struct {
					Payload map[string]any `json:"payload"`
				} `json:"messages"`
			} `json:"sessions"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, nil, fmt.Errorf("decode semantic replay state for blobs: %w", err)
	}
	seen := map[string]struct{}{}
	var attachments []attachmentReference
	var generatedImages []generatedImageReference
	for _, session := range state.Agent.Sessions {
		descriptor, _ := ResolveProviderReplay(
			session.AgentTargetID,
			session.Provider,
		)
		for _, message := range session.Messages {
			for _, image := range findAttachmentImages(message.Payload) {
				reference := attachmentReference{
					AgentSessionID: session.ID,
					AttachmentID:   image.AttachmentID,
					MimeType:       image.MimeType,
				}
				key := attachmentBlobReferenceKey(
					session.ID,
					image.AttachmentID,
					image.MimeType,
				)
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				attachments = append(attachments, reference)
			}
			for _, image := range findGeneratedImages(message.Payload) {
				image.AgentSessionID = session.ID
				image.ProviderHomeDirectory =
					descriptor.PortableRuntime.SessionHomeDirectory
				key := generatedImageBlobReferenceKey(
					session.ID,
					image.RelativePath,
					image.MimeType,
				)
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				generatedImages = append(generatedImages, image)
			}
		}
	}
	return attachments, generatedImages, nil
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

func findGeneratedImages(payload map[string]any) []generatedImageReference {
	output, ok := payload["output"].(map[string]any)
	if !ok {
		return nil
	}
	mimeType, _ := output["imageMimeType"].(string)
	mimeType = strings.TrimSpace(mimeType)
	if promptImageExtension(mimeType) == "" {
		return nil
	}
	values := []any{output["savedPath"]}
	if savedPaths, ok := output["savedPaths"].([]any); ok {
		values = append(values, savedPaths...)
	}
	var result []generatedImageReference
	for _, value := range values {
		savedPath, _ := value.(string)
		relativePath, ok := portableGeneratedImageRelativePath(savedPath)
		if !ok || path.Ext(relativePath) != promptImageExtension(mimeType) {
			continue
		}
		result = append(result, generatedImageReference{
			RelativePath: relativePath,
			MimeType:     mimeType,
		})
	}
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
	digest, size, err := copyPortableBlob(source, recordingDirectory)
	if err != nil {
		return blobManifestEntry{}, fmt.Errorf(
			"copy Agent Session attachment blob: %w",
			err,
		)
	}
	return blobManifestEntry{
		Kind:           BlobKindAgentPromptAttachment,
		SHA256:         digest,
		SizeBytes:      size,
		AgentSessionID: reference.AgentSessionID,
		AttachmentID:   reference.AttachmentID,
		MimeType:       reference.MimeType,
	}, nil
}

func (s *Store) copyGeneratedImageBlob(
	recordingDirectory string,
	reference generatedImageReference,
) (blobManifestEntry, error) {
	if !safeBlobSegment(reference.AgentSessionID) ||
		!safeBlobSegment(reference.ProviderHomeDirectory) ||
		!safeGeneratedImageRelativePath(reference.RelativePath) ||
		path.Ext(reference.RelativePath) != promptImageExtension(reference.MimeType) {
		return blobManifestEntry{}, errors.New("invalid generated image blob identity")
	}
	source := filepath.Join(
		filepath.Clean(strings.TrimSpace(s.StateDir)),
		"agent",
		"runs",
		reference.AgentSessionID,
		reference.ProviderHomeDirectory,
		filepath.FromSlash(reference.RelativePath),
	)
	digest, size, err := copyPortableBlob(source, recordingDirectory)
	if err != nil {
		return blobManifestEntry{}, fmt.Errorf(
			"copy Agent Session generated image blob: %w",
			err,
		)
	}
	return blobManifestEntry{
		Kind:           BlobKindAgentGeneratedImage,
		SHA256:         digest,
		SizeBytes:      size,
		AgentSessionID: reference.AgentSessionID,
		RelativePath:   reference.RelativePath,
		MimeType:       reference.MimeType,
	}, nil
}

func copyPortableBlob(
	source string,
	recordingDirectory string,
) (string, int64, error) {
	file, err := os.Open(source)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxPortablePromptAsset {
		return "", 0, fmt.Errorf(
			"blob is not a supported regular file: size=%d limit=%d",
			info.Size(),
			maxPortablePromptAsset,
		)
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, err
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	destination := filepath.Join(recordingDirectory, "blobs", "sha256", digest)
	if _, err := os.Stat(destination); errors.Is(err, os.ErrNotExist) {
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return "", 0, err
		}
		tempPath := destination + ".tmp"
		output, err := os.OpenFile(tempPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return "", 0, err
		}
		_, copyErr := io.Copy(output, file)
		closeErr := output.Close()
		if err := errors.Join(copyErr, closeErr); err != nil {
			_ = os.Remove(tempPath)
			return "", 0, err
		}
		if err := os.Rename(tempPath, destination); err != nil {
			_ = os.Remove(tempPath)
			return "", 0, err
		}
	} else if err != nil {
		return "", 0, err
	}
	return digest, size, nil
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
	if manifest.SchemaVersion != BlobManifestSchemaVersion {
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

func portableGeneratedImageRelativePath(value string) (string, bool) {
	const prefix = PortableReplayHomeToken + "/"
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, prefix) {
		return "", false
	}
	relative := strings.TrimPrefix(value, prefix)
	return relative, safeGeneratedImageRelativePath(relative)
}

func attachmentBlobReferenceKey(sessionID, attachmentID, mimeType string) string {
	return BlobKindAgentPromptAttachment + "\x00" +
		sessionID + "\x00" + attachmentID + "\x00" + mimeType
}

func generatedImageBlobReferenceKey(sessionID, relativePath, mimeType string) string {
	return BlobKindAgentGeneratedImage + "\x00" +
		sessionID + "\x00" + relativePath + "\x00" + mimeType
}

func blobManifestEntryKey(entry blobManifestEntry) string {
	switch entry.Kind {
	case BlobKindAgentPromptAttachment:
		return attachmentBlobReferenceKey(
			entry.AgentSessionID,
			entry.AttachmentID,
			entry.MimeType,
		)
	case BlobKindAgentGeneratedImage:
		return generatedImageBlobReferenceKey(
			entry.AgentSessionID,
			entry.RelativePath,
			entry.MimeType,
		)
	default:
		return ""
	}
}

// portableActivityEvent projects runtime-owned fields before the mutable
// recording candidate is written. User-authored content remains unchanged.
func (s *Store) portableActivityEvent(
	event ActivityEvent,
) (ActivityEvent, error) {
	if event.Payload == nil {
		return event, nil
	}
	raw, err := json.Marshal(event.Payload)
	if err != nil {
		return ActivityEvent{}, err
	}
	var portable map[string]any
	if err := json.Unmarshal(raw, &portable); err != nil {
		return ActivityEvent{}, err
	}
	for _, field := range []string{"content", "runtimeContent", "initialContent"} {
		content, _ := portable[field].([]any)
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
				return ActivityEvent{}, err
			}
			block["data"] = base64.StdEncoding.EncodeToString(data)
			delete(block, "path")
		}
	}
	if isSessionActivationActivityType(event.Type) {
		projectPortableSessionActivationPaths(portable)
	}
	event.Payload = portable
	return event, nil
}

func isSessionActivationActivityType(eventType string) bool {
	return eventType == "activation/requested" ||
		eventType == "session.create" ||
		eventType == "session/activate"
}

func projectPortableSessionActivationPaths(payload map[string]any) {
	cwd, _ := payload["cwd"].(string)
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return
	}
	payload["cwd"] = PortableReplayCWDToken
	railPlacement, _ := payload["railPlacement"].(map[string]any)
	projectPath, _ := railPlacement["projectPath"].(string)
	if mapped, ok := portableReplayPath(projectPath, cwd); ok {
		railPlacement["projectPath"] = mapped
	}
	projectPortableRailSectionKey(railPlacement, "sectionKey", cwd)
	projectPortableRailSectionKey(payload, "railSectionKey", cwd)
}

// projectPortableRailSectionKey rewrites a `project:<absolute path>` rail
// section key to its portable `project:${REPLAY_CWD}...` form so recorded
// activation stimuli replay against the replay runtime cwd instead of the
// recording machine's absolute project path.
func projectPortableRailSectionKey(
	container map[string]any,
	field, cwd string,
) {
	if container == nil {
		return
	}
	key, _ := container[field].(string)
	const prefix = "project:"
	if !strings.HasPrefix(key, prefix) {
		return
	}
	if mapped, ok := portableReplayPath(
		strings.TrimPrefix(key, prefix),
		cwd,
	); ok {
		container[field] = prefix + mapped
	}
}

func portableReplayPath(path, root string) (string, bool) {
	path = strings.TrimSpace(path)
	root = strings.TrimSpace(root)
	if path == "" || root == "" {
		return path, false
	}
	normalizedPath := path
	normalizedRoot := root
	if evaluated, err := filepath.EvalSymlinks(path); err == nil {
		normalizedPath = evaluated
	}
	if evaluated, err := filepath.EvalSymlinks(root); err == nil {
		normalizedRoot = evaluated
	}
	normalizedPath = filepath.Clean(normalizedPath)
	normalizedRoot = filepath.Clean(normalizedRoot)
	relative, err := filepath.Rel(normalizedRoot, normalizedPath)
	if err != nil || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relative) {
		return path, false
	}
	if relative == "." {
		return PortableReplayCWDToken, true
	}
	return PortableReplayCWDToken + "/" + filepath.ToSlash(relative), true
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
