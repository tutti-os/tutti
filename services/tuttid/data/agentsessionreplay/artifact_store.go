package agentsessionreplay

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

type Store struct {
	StateDir string
	Now      replay.Clock
}

func (s *Store) Prepare(
	_ context.Context,
	recording replay.Recording,
) (replay.ArtifactLayout, error) {
	layout := s.recordingLayout(recording.ID)
	for _, directory := range []string{
		layout.StorageKey,
		filepath.Dir(layout.SeedFixtureKey),
		filepath.Dir(layout.ProviderTapeKey),
		filepath.Dir(layout.ExpectedFixtureKey),
		filepath.Join(layout.StorageKey, "blobs", "sha256"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return replay.ArtifactLayout{}, err
		}
	}
	if err := writeJSONAtomic(filepath.Join(layout.StorageKey, replay.BlobManifestFile), replay.BlobManifest{
		SchemaVersion: replay.BlobManifestSchemaVersion,
		Blobs:         []replay.BlobManifestEntry{},
	}); err != nil {
		return replay.ArtifactLayout{}, err
	}
	if err := os.WriteFile(
		filepath.Join(layout.StorageKey, replay.ActivityEventsFile),
		nil,
		0o600,
	); err != nil {
		return replay.ArtifactLayout{}, err
	}
	return layout, nil
}

func (s *Store) LocateRecording(
	_ context.Context,
	recording replay.Recording,
) (replay.ArtifactLayout, error) {
	if strings.TrimSpace(recording.CassetteID) != "" {
		return s.cassetteLayout(recording.CassetteID), nil
	}
	return s.recordingLayout(recording.ID), nil
}

func (s *Store) WriteScenario(
	_ context.Context,
	recording replay.Recording,
	activityEventCount uint64,
) error {
	layout, _ := s.LocateRecording(context.Background(), recording)
	return writeJSONAtomic(filepath.Join(layout.StorageKey, replay.ScenarioFile), map[string]any{
		"schemaVersion":      1,
		"id":                 recording.ID,
		"mode":               recording.Mode,
		"scopeId":            recording.ScopeID,
		"agentTargetId":      recording.AgentTargetID,
		"rootAgentSessionId": recording.RootAgentSessionID,
		"captureWindow": map[string]any{
			"startedAtUnixMs": recording.RecordingAtUnixMS,
			"stoppedAtUnixMs": recording.StoppedAtUnixMS,
		},
		"activityEventCount": activityEventCount,
	})
}

func (s *Store) AppendActivityEvent(
	_ context.Context,
	recording replay.Recording,
	event replay.ActivityEvent,
) error {
	if err := replay.ValidateActivityEvent(event); err != nil {
		return err
	}
	portable, err := s.portableActivityEventPayload(event.Payload)
	if err != nil {
		return err
	}
	event.Payload = portable
	layout, _ := s.LocateRecording(context.Background(), recording)
	return appendJSONLine(filepath.Join(layout.StorageKey, replay.ActivityEventsFile), event)
}

func (s *Store) CollectFixtureDependencies(
	_ context.Context,
	recording replay.Recording,
	phase replay.FixturePhase,
) error {
	layout, _ := s.LocateRecording(context.Background(), recording)
	fixturePath := layout.ExpectedFixtureKey
	if phase == replay.FixturePhaseSeed {
		fixturePath = layout.SeedFixtureKey
	}
	return s.exportFixtureBlobs(fixturePath, layout.StorageKey)
}

func (s *Store) DiscardRecording(_ context.Context, recordingID string) error {
	return os.RemoveAll(s.recordingLayout(recordingID).StorageKey)
}

func (s *Store) RollbackPublish(
	_ context.Context,
	artifact replay.Artifact,
	recording replay.Recording,
) error {
	candidate := s.recordingLayout(recording.ID)
	if err := os.MkdirAll(filepath.Dir(candidate.StorageKey), 0o700); err != nil {
		return err
	}
	return os.Rename(artifact.Layout.StorageKey, candidate.StorageKey)
}

func (s *Store) Resolve(_ context.Context, requested replay.Cassette) (replay.Artifact, error) {
	layout := s.cassetteLayout(requested.ID)
	manifestPath := filepath.Join(layout.StorageKey, replay.CassetteManifestFile)
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return replay.Artifact{}, err
	}
	manifestSHA256, err := fileSHA256(manifestPath)
	if err != nil {
		return replay.Artifact{}, err
	}
	if requested.ManifestSHA256 != "" &&
		!strings.EqualFold(requested.ManifestSHA256, manifestSHA256) {
		return replay.Artifact{}, errors.New("cassette manifest integrity mismatch")
	}
	var manifest replay.CassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return replay.Artifact{}, err
	}
	if manifest.ID != requested.ID {
		return replay.Artifact{}, errors.New("cassette identity mismatch")
	}
	blobManifest, err := readBlobManifest(filepath.Join(layout.StorageKey, replay.BlobManifestFile))
	if err != nil {
		return replay.Artifact{}, err
	}
	if err := replay.ValidateCassetteManifestPolicy(manifest, blobManifest); err != nil {
		return replay.Artifact{}, err
	}
	if requested.ScopeID != "" && requested.ScopeID != manifest.ScopeID {
		return replay.Artifact{}, errors.New("cassette scope identity mismatch")
	}
	files, err := collectCassetteFiles(layout.StorageKey, manifest.Files)
	if err != nil {
		return replay.Artifact{}, err
	}
	if err := replay.ValidateCassetteIntegrity(manifest, files); err != nil {
		return replay.Artifact{}, err
	}
	if err := validatePortableReplayFiles(layout.StorageKey); err != nil {
		return replay.Artifact{}, err
	}
	return replay.Artifact{
		Cassette: replay.Cassette{
			ID:                 manifest.ID,
			Name:               manifest.Name,
			SourceRecordingID:  manifest.SourceRecordingID,
			ScopeID:            manifest.ScopeID,
			AgentTargetID:      manifest.AgentTargetID,
			RootAgentSessionID: manifest.RootSessionID,
			Mode:               manifest.Mode,
			TotalBytes:         manifest.TotalBytes,
			ManifestSHA256:     manifestSHA256,
			ArtifactKey:        layout.StorageKey,
			CreatedAtUnixMS:    manifest.CreatedAtUnixMS,
		},
		Layout: layout,
	}, nil
}

func (s *Store) RenameCassette(
	ctx context.Context,
	requested replay.Cassette,
	name string,
) (replay.Artifact, error) {
	name, err := replay.NormalizeRecordingName(name)
	if err != nil {
		return replay.Artifact{}, err
	}
	artifact, err := s.Resolve(ctx, requested)
	if err != nil {
		return replay.Artifact{}, err
	}
	manifestPath := filepath.Join(artifact.Layout.StorageKey, replay.CassetteManifestFile)
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return replay.Artifact{}, err
	}
	var manifest replay.CassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return replay.Artifact{}, err
	}
	manifest.Name = name
	if err := writeJSONAtomic(manifestPath, manifest); err != nil {
		return replay.Artifact{}, err
	}
	manifestSHA256, err := fileSHA256(manifestPath)
	if err != nil {
		return replay.Artifact{}, err
	}
	artifact.Cassette.Name = name
	artifact.Cassette.ManifestSHA256 = manifestSHA256
	return artifact, nil
}

func (s *Store) recordingLayout(recordingID string) replay.ArtifactLayout {
	root := filepath.Join(
		filepath.Clean(strings.TrimSpace(s.StateDir)),
		"agent-session-recordings",
		strings.TrimSpace(recordingID),
		"candidate",
	)
	return artifactLayout(root)
}

func (s *Store) cassetteLayout(cassetteID string) replay.ArtifactLayout {
	root := filepath.Join(
		filepath.Clean(strings.TrimSpace(s.StateDir)),
		"agent-session-cassettes",
		strings.TrimSpace(cassetteID),
	)
	return artifactLayout(root)
}

func artifactLayout(root string) replay.ArtifactLayout {
	return replay.ArtifactLayout{
		StorageKey:         root,
		ProviderTapeKey:    filepath.Join(root, "provider"),
		SeedFixtureKey:     filepath.Join(root, filepath.FromSlash(replay.SeedFixtureFile)),
		ExpectedFixtureKey: filepath.Join(root, filepath.FromSlash(replay.ExpectedFixtureFile)),
	}
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func appendJSONLine(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	writer := bufio.NewWriter(file)
	_, writeErr := writer.Write(append(raw, '\n'))
	flushErr := writer.Flush()
	closeErr := file.Close()
	return errors.Join(writeErr, flushErr, closeErr)
}

func writeJSONAtomic(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tempPath := path + ".tmp"
	if err := os.WriteFile(tempPath, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace %s: %w", filepath.Base(path), err)
	}
	return nil
}

func writeJSONLinesAtomic[T any](path string, values []T) error {
	tempPath := path + ".tmp"
	file, err := os.OpenFile(
		tempPath,
		os.O_CREATE|os.O_TRUNC|os.O_WRONLY,
		0o600,
	)
	if err != nil {
		return err
	}
	writer := bufio.NewWriter(file)
	var writeErr error
	for _, value := range values {
		var raw []byte
		raw, writeErr = json.Marshal(value)
		if writeErr != nil {
			break
		}
		if _, writeErr = writer.Write(append(raw, '\n')); writeErr != nil {
			break
		}
	}
	flushErr := writer.Flush()
	closeErr := file.Close()
	if err := errors.Join(writeErr, flushErr, closeErr); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("replace %s: %w", filepath.Base(path), err)
	}
	return nil
}
