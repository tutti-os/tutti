package agentsessionreplay

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func (s *Store) Publish(
	_ context.Context,
	recording replay.Recording,
	cassetteID string,
	activityEventCount uint64,
) (replay.Artifact, error) {
	cassetteID = strings.TrimSpace(cassetteID)
	if cassetteID == "" {
		return replay.Artifact{}, replay.ErrInvalidState
	}
	layout, _ := s.LocateRecording(context.Background(), recording)
	if err := writeJSONAtomic(filepath.Join(layout.StorageKey, replay.EnvironmentFile), map[string]any{
		"schemaVersion": 1,
		"pathTokens": map[string]string{
			"stateDirectory": "${TUTTI_STATE_DIR}",
			"workspace":      "${WORKSPACE}",
		},
	}); err != nil {
		return replay.Artifact{}, err
	}
	if err := validateRecordedActivityEvents(layout.StorageKey, activityEventCount); err != nil {
		return replay.Artifact{}, err
	}
	if err := writeReplayCheckpoints(layout.StorageKey, activityEventCount); err != nil {
		return replay.Artifact{}, err
	}
	blobManifest, err := readBlobManifest(filepath.Join(layout.StorageKey, replay.BlobManifestFile))
	if err != nil {
		return replay.Artifact{}, err
	}
	files, err := collectCassetteFiles(layout.StorageKey, nil)
	if err != nil {
		return replay.Artifact{}, err
	}
	manifest, err := replay.BuildCassetteManifest(replay.CassetteManifestInput{
		ID:                cassetteID,
		Name:              recording.Name,
		SourceRecordingID: recording.ID,
		ScopeID:           recording.ScopeID,
		AgentTargetID:     recording.AgentTargetID,
		RootSessionID:     recording.RootAgentSessionID,
		Mode:              recording.Mode,
		CreatedAtUnixMS:   s.now().UnixMilli(),
	}, files, blobManifest)
	if err != nil {
		return replay.Artifact{}, err
	}
	manifestPath := filepath.Join(layout.StorageKey, replay.CassetteManifestFile)
	if err := writeJSONAtomic(manifestPath, manifest); err != nil {
		return replay.Artifact{}, err
	}
	manifestHash, err := fileSHA256(manifestPath)
	if err != nil {
		return replay.Artifact{}, err
	}
	destination := s.cassetteLayout(cassetteID)
	if err := os.MkdirAll(filepath.Dir(destination.StorageKey), 0o700); err != nil {
		return replay.Artifact{}, err
	}
	if err := os.Rename(layout.StorageKey, destination.StorageKey); err != nil {
		return replay.Artifact{}, fmt.Errorf("publish cassette: %w", err)
	}
	cassette := replay.Cassette{
		ID:                 cassetteID,
		Name:               manifest.Name,
		SourceRecordingID:  recording.ID,
		ScopeID:            recording.ScopeID,
		AgentTargetID:      recording.AgentTargetID,
		RootAgentSessionID: recording.RootAgentSessionID,
		Mode:               recording.Mode,
		TotalBytes:         manifest.TotalBytes,
		ManifestSHA256:     manifestHash,
		ArtifactKey:        destination.StorageKey,
		CreatedAtUnixMS:    manifest.CreatedAtUnixMS,
	}
	return replay.Artifact{Cassette: cassette, Layout: destination}, nil
}

func writeReplayCheckpoints(directory string, activityEventCount uint64) error {
	checkpoints := make([]replay.ReplayCheckpoint, 0, activityEventCount+1)
	checkpoints = append(checkpoints, replay.ReplayCheckpoint{
		SchemaVersion:              replay.CassetteSchemaVersion,
		Index:                      0,
		Kind:                       replay.ReplayCheckpointKindBootstrap,
		ExpectedActivityProjection: replay.ActivityProjection{QueuedPromptIDs: []string{}},
	})
	for sequence := uint64(1); sequence <= activityEventCount; sequence++ {
		checkpoints = append(checkpoints, replay.ReplayCheckpoint{
			SchemaVersion:              replay.CassetteSchemaVersion,
			Index:                      int64(sequence),
			Kind:                       replay.ReplayCheckpointKindAfterActivityEvent,
			AfterActivityEventSequence: sequence,
			ExpectedActivityProjection: replay.ActivityProjection{QueuedPromptIDs: []string{}},
		})
	}
	return writeJSONLinesAtomic(
		filepath.Join(directory, replay.CheckpointsFile),
		checkpoints,
	)
}

func validateRecordedActivityEvents(directory string, expectedCount uint64) error {
	events, err := readJSONLines[replay.ActivityEvent](
		filepath.Join(directory, replay.ActivityEventsFile),
		"activity event",
	)
	if err != nil {
		return err
	}
	if uint64(len(events)) != expectedCount {
		return fmt.Errorf(
			"activity event count is %d, want %d",
			len(events),
			expectedCount,
		)
	}
	return replay.ValidateActivityEvents(events)
}

func validatePortableReplayFiles(directory string) error {
	events, err := readJSONLines[replay.ActivityEvent](
		filepath.Join(directory, replay.ActivityEventsFile),
		"activity event",
	)
	if err != nil {
		return err
	}
	if err := replay.ValidateActivityEvents(events); err != nil {
		return err
	}
	checkpoints, err := readJSONLines[replay.ReplayCheckpoint](
		filepath.Join(directory, replay.CheckpointsFile),
		"replay checkpoint",
	)
	if err != nil {
		return err
	}
	return replay.ValidateReplayCheckpoints(checkpoints, uint64(len(events)))
}

func readJSONLines[T any](path, label string) ([]T, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var values []T
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), int(replay.MaxCassetteBytes))
	for scanner.Scan() {
		var value T
		if err := json.Unmarshal(scanner.Bytes(), &value); err != nil {
			return nil, fmt.Errorf("decode %s: %w", label, err)
		}
		values = append(values, value)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return values, nil
}

func collectCassetteFiles(
	directory string,
	expected []replay.CassetteFile,
) ([]replay.CassetteFile, error) {
	expectedRoles := make(map[string]string, len(expected))
	for _, file := range expected {
		expectedRoles[file.Path] = file.Role
	}
	var result []replay.CassetteFile
	err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(directory, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if relative == replay.CassetteManifestFile {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("cassette file %q is not regular", relative)
		}
		digest, err := fileSHA256(path)
		if err != nil {
			return err
		}
		result = append(result, replay.CassetteFile{
			Path:      relative,
			Role:      expectedRoles[relative],
			SizeBytes: info.Size(),
			SHA256:    digest,
		})
		return nil
	})
	return result, err
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return strings.ToLower(hex.EncodeToString(hash.Sum(nil))), nil
}
