package sessionreplay

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func (s *Store) Publish(
	_ context.Context,
	recording Recording,
	cassetteID string,
	activityEventCount uint64,
) (Artifact, error) {
	cassetteID = strings.TrimSpace(cassetteID)
	if cassetteID == "" {
		return Artifact{}, ErrInvalidState
	}
	layout, _ := s.LocateRecording(context.Background(), recording)
	activityEvents, err := validateRecordedActivityEvents(
		layout.StorageKey,
		activityEventCount,
	)
	if err != nil {
		return Artifact{}, err
	}
	plan, err := loadAndValidateCheckpointPlan(layout.StorageKey, activityEvents)
	if err != nil {
		return Artifact{}, err
	}
	if err := ValidatePublishedCheckpointPlan(plan); err != nil {
		return Artifact{}, err
	}
	if err := validateObservationJournal(layout.StorageKey, plan); err != nil {
		return Artifact{}, err
	}
	blobManifest, err := readBlobManifest(filepath.Join(layout.StorageKey, BlobManifestFile))
	if err != nil {
		return Artifact{}, err
	}
	files, err := collectCassetteFiles(layout.StorageKey, nil)
	if err != nil {
		return Artifact{}, err
	}
	manifest, err := BuildCassetteManifest(CassetteManifestInput{
		ID:                  cassetteID,
		StateFormat:         StateFormat,
		Name:                recording.Name,
		SourceRecordingID:   recording.ID,
		AgentTargetID:       recording.AgentTargetID,
		ReplayPrerequisites: recording.ReplayPrerequisites,
		RootSessionID:       recording.RootAgentSessionID,
		Mode:                recording.Mode,
		CreatedAtUnixMS:     s.now().UnixMilli(),
	}, files, blobManifest)
	if err != nil {
		return Artifact{}, err
	}
	manifestPath := filepath.Join(layout.StorageKey, CassetteManifestFile)
	if err := writeJSONAtomic(manifestPath, manifest); err != nil {
		return Artifact{}, err
	}
	manifestHash, err := fileSHA256(manifestPath)
	if err != nil {
		return Artifact{}, err
	}
	destination := s.cassetteLayout(cassetteID)
	if err := os.MkdirAll(filepath.Dir(destination.StorageKey), 0o700); err != nil {
		return Artifact{}, err
	}
	if err := os.RemoveAll(filepath.Join(layout.StorageKey, ".recording")); err != nil {
		return Artifact{}, err
	}
	if err := os.Rename(layout.StorageKey, destination.StorageKey); err != nil {
		return Artifact{}, fmt.Errorf("publish cassette: %w", err)
	}
	cassette := Cassette{
		ID:                 cassetteID,
		Name:               manifest.Name,
		SourceRecordingID:  recording.ID,
		AgentTargetID:      recording.AgentTargetID,
		RootAgentSessionID: recording.RootAgentSessionID,
		Mode:               recording.Mode,
		TotalBytes:         manifest.TotalBytes,
		ManifestSHA256:     manifestHash,
		ArtifactKey:        destination.StorageKey,
		CreatedAtUnixMS:    manifest.CreatedAtUnixMS,
	}
	return Artifact{Cassette: cassette, Layout: destination}, nil
}

func validateRecordedActivityEvents(
	directory string,
	expectedCount uint64,
) ([]ActivityEvent, error) {
	events, err := readJSONLines[ActivityEvent](
		filepath.Join(directory, ActivityEventsFile),
		"activity event",
	)
	if err != nil {
		return nil, err
	}
	if uint64(len(events)) != expectedCount {
		return nil, fmt.Errorf(
			"activity event count is %d, want %d",
			len(events),
			expectedCount,
		)
	}
	if err := ValidateActivityEvents(events); err != nil {
		return nil, err
	}
	if err := validatePortableActivityEvents(events); err != nil {
		return nil, err
	}
	return events, nil
}

func validatePortableReplayFiles(directory string) error {
	events, err := readJSONLines[ActivityEvent](
		filepath.Join(directory, ActivityEventsFile),
		"activity event",
	)
	if err != nil {
		return err
	}
	if err := ValidateActivityEvents(events); err != nil {
		return err
	}
	if err := validatePortableActivityEvents(events); err != nil {
		return err
	}
	if _, err := loadAndValidateCheckpointPlan(directory, events); err != nil {
		return err
	}
	if err := rejectJSONLineScopeFields(
		filepath.Join(directory, ActivityEventsFile),
		"activity event",
	); err != nil {
		return err
	}
	for _, statePath := range []string{
		InitialStateFile,
		ExpectedStateFile,
	} {
		path := filepath.Join(directory, filepath.FromSlash(statePath))
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		if _, _, err := readSemanticReplayState(path); err != nil {
			return err
		}
	}
	return nil
}

func validatePortableActivityEvents(events []ActivityEvent) error {
	for _, event := range events {
		if !isSessionActivationActivityType(event.Type) {
			continue
		}
		if err := validatePortableReplayPath(
			event.Payload["cwd"],
			fmt.Sprintf("activity event %d payload.cwd", event.Sequence),
		); err != nil {
			return err
		}
		railPlacement, _ := event.Payload["railPlacement"].(map[string]any)
		if err := validatePortableReplayPath(
			railPlacement["projectPath"],
			fmt.Sprintf("activity event %d payload.railPlacement.projectPath", event.Sequence),
		); err != nil {
			return err
		}
		if err := validatePortableRailSectionKey(
			railPlacement["sectionKey"],
			fmt.Sprintf("activity event %d payload.railPlacement.sectionKey", event.Sequence),
		); err != nil {
			return err
		}
		if err := validatePortableRailSectionKey(
			event.Payload["railSectionKey"],
			fmt.Sprintf("activity event %d payload.railSectionKey", event.Sequence),
		); err != nil {
			return err
		}
	}
	return nil
}

func validatePortableRailSectionKey(value any, label string) error {
	key, ok := value.(string)
	const prefix = "project:"
	if !ok || !strings.HasPrefix(key, prefix) {
		return nil
	}
	return validatePortableReplayPath(strings.TrimPrefix(key, prefix), label)
}

func validatePortableReplayPath(value any, label string) error {
	path, ok := value.(string)
	if !ok || strings.TrimSpace(path) == "" {
		return nil
	}
	path = strings.TrimSpace(path)
	if path == PortableReplayCWDToken ||
		strings.HasPrefix(path, PortableReplayCWDToken+"/") {
		return nil
	}
	if isCrossPlatformAbsolutePath(path) || strings.HasPrefix(path, "file://") {
		return fmt.Errorf("%s contains an absolute recording path", label)
	}
	return nil
}

func loadAndValidateCheckpointPlan(
	directory string,
	events []ActivityEvent,
) (CheckpointPlan, error) {
	raw, err := os.ReadFile(filepath.Join(directory, CheckpointPlanFile))
	if err != nil {
		return CheckpointPlan{}, fmt.Errorf("read checkpoint plan: %w", err)
	}
	var plan CheckpointPlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		return CheckpointPlan{}, fmt.Errorf("decode checkpoint plan: %w", err)
	}
	connectionIDs, err := readProviderConnectionIDs(directory)
	if err != nil {
		return CheckpointPlan{}, err
	}
	if err := ValidateCheckpointPlan(plan, connectionIDs, events); err != nil {
		return CheckpointPlan{}, fmt.Errorf("checkpoint_plan_invalid: %w", err)
	}
	return plan, nil
}

func validateObservationJournal(
	directory string,
	plan CheckpointPlan,
) error {
	entries, err := readJSONLines[ObservationJournalEntry](
		filepath.Join(directory, observationJournalPath),
		"observation journal entry",
	)
	if err != nil {
		return err
	}
	return ValidateCheckpointJournalAnchors(plan, entries)
}

func readProviderConnectionIDs(directory string) ([]string, error) {
	raw, err := os.ReadFile(filepath.Join(directory, ProviderManifestFile))
	if err != nil {
		return nil, fmt.Errorf("read provider manifest for checkpoint plan: %w", err)
	}
	var manifest ProcessCassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("decode provider manifest for checkpoint plan: %w", err)
	}
	if manifest.SchemaVersion != ProcessCassetteSchemaVersion ||
		manifest.ProjectionVersion != ProcessCassetteProjectionVersion ||
		manifest.Status != ProcessCassetteStatusComplete {
		return nil, errors.New("provider tape is not a completed projected recording")
	}
	frames, err := os.Open(filepath.Join(directory, ProviderFramesFile))
	if err != nil {
		return nil, fmt.Errorf("open projected provider tape: %w", err)
	}
	auditErr := AuditProjectedProcessCassetteFrames(
		frames,
		manifest.Connections,
	)
	closeErr := frames.Close()
	if err := errors.Join(auditErr, closeErr); err != nil {
		return nil, fmt.Errorf("audit projected provider tape: %w", err)
	}
	connectionIDs := make([]string, 0, len(manifest.Connections))
	for _, connection := range manifest.Connections {
		connectionIDs = append(connectionIDs, connection.ConnectionID)
	}
	return connectionIDs, nil
}

func rejectPortableScopeFields(raw []byte, label string) error {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("decode %s: %w", label, err)
	}
	for _, field := range []string{"scopeId", "workspaceId"} {
		if _, exists := value[field]; exists {
			return fmt.Errorf("%s contains non-portable %s", label, field)
		}
	}
	return nil
}

func rejectJSONLineScopeFields(path, label string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), int(MaxCassetteBytes))
	for scanner.Scan() {
		if err := rejectPortableScopeFields(scanner.Bytes(), label); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func readJSONLines[T any](path, label string) ([]T, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var values []T
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), int(MaxCassetteBytes))
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
	expected []CassetteFile,
) ([]CassetteFile, error) {
	expectedRoles := make(map[string]string, len(expected))
	for _, file := range expected {
		expectedRoles[file.Path] = file.Role
	}
	var result []CassetteFile
	err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(directory, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			if len(expected) == 0 && relative == ".recording" {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() == ".DS_Store" {
			return nil
		}
		if relative == CassetteManifestFile {
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
		result = append(result, CassetteFile{
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
