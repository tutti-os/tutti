package sessionreplay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Store struct {
	StateDir  string
	Now       Clock
	journalMu sync.Mutex
}

const observationJournalPath = ".recording/observation-journal.jsonl"

func (s *Store) Prepare(
	_ context.Context,
	recording Recording,
) (ArtifactLayout, error) {
	layout := s.recordingLayout(recording.ID)
	for _, directory := range []string{
		layout.StorageKey,
		filepath.Dir(layout.ProviderTapeKey),
		filepath.Join(layout.StorageKey, "blobs", "sha256"),
		filepath.Join(layout.StorageKey, ".recording"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return ArtifactLayout{}, err
		}
	}
	if err := writeJSONAtomic(filepath.Join(layout.StorageKey, BlobManifestFile), BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
		Blobs:         []BlobManifestEntry{},
	}); err != nil {
		return ArtifactLayout{}, err
	}
	if err := os.WriteFile(
		filepath.Join(layout.StorageKey, ActivityEventsFile),
		nil,
		0o600,
	); err != nil {
		return ArtifactLayout{}, err
	}
	if err := os.WriteFile(
		filepath.Join(layout.StorageKey, observationJournalPath),
		nil,
		0o600,
	); err != nil {
		return ArtifactLayout{}, err
	}
	if err := writeJSONAtomic(
		layout.CheckpointPlanKey,
		NewCheckpointPlan([]ReplayCheckpoint{{
			ID:    "checkpoint-0000",
			Index: 0,
			Kind:  "replay.bootstrap",
			Tags:  []string{"replay.bootstrap"},
			Trigger: CheckpointTrigger{
				Source: CheckpointTriggerBootstrap,
			},
			Readiness: CheckpointReadiness{
				All: []ReadinessPredicate{},
			},
		}}),
	); err != nil {
		return ArtifactLayout{}, err
	}
	return layout, nil
}

func (s *Store) AppendObservationJournalEntry(
	_ context.Context,
	recording Recording,
	entry ObservationJournalEntry,
) error {
	s.journalMu.Lock()
	defer s.journalMu.Unlock()
	layout, _ := s.LocateRecording(context.Background(), recording)
	path := filepath.Join(layout.StorageKey, observationJournalPath)
	entries, err := readJSONLines[ObservationJournalEntry](
		path,
		"observation journal entry",
	)
	if err != nil {
		return err
	}
	merged := false
	for index := range entries {
		if entries[index].Position == entry.Position {
			entries[index], err = mergeObservationJournalEntry(
				entries[index],
				entry,
			)
			if err != nil {
				return err
			}
			merged = true
			break
		}
	}
	if !merged {
		entries = append(entries, entry)
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	for _, current := range entries {
		if err := encoder.Encode(current); err != nil {
			return err
		}
	}
	return writeFileAtomic(path, encoded.Bytes())
}

func mergeObservationJournalEntry(
	current ObservationJournalEntry,
	update ObservationJournalEntry,
) (ObservationJournalEntry, error) {
	if current.SchemaVersion != update.SchemaVersion ||
		current.UnitKind != update.UnitKind ||
		current.Position != update.Position {
		return ObservationJournalEntry{}, errors.New(
			"observation journal entry identity conflict",
		)
	}
	observations := make(map[ProviderObservationPosition]int)
	for index, observation := range current.Observations {
		observations[observation.Position] = index
	}
	for _, observation := range update.Observations {
		if index, ok := observations[observation.Position]; ok {
			existing := current.Observations[index]
			if existing.Type != observation.Type ||
				existing.Fingerprint != observation.Fingerprint ||
				!EntityAddressesEqual(
					existing.Address,
					observation.Address,
				) {
				return ObservationJournalEntry{}, errors.New(
					"observation journal observation identity conflict",
				)
			}
			continue
		}
		observations[observation.Position] = len(current.Observations)
		current.Observations = append(current.Observations, observation)
	}
	correlations := make(map[string]int)
	for index, correlation := range current.Correlations {
		correlations[correlation.ID] = index
	}
	for _, correlation := range update.Correlations {
		if index, ok := correlations[correlation.ID]; ok {
			existing := current.Correlations[index]
			if existing.Kind != correlation.Kind ||
				existing.Expected != correlation.Expected ||
				existing.ObservationPosition !=
					correlation.ObservationPosition ||
				existing.ObservationFingerprint !=
					correlation.ObservationFingerprint ||
				!EntityAddressesEqual(
					existing.Address,
					correlation.Address,
				) {
				return ObservationJournalEntry{}, errors.New(
					"observation journal commit correlation identity conflict",
				)
			}
			if existing.TransactionID != "" &&
				correlation.TransactionID != "" &&
				existing.TransactionID != correlation.TransactionID {
				return ObservationJournalEntry{}, errors.New(
					"observation journal commit transaction conflict",
				)
			}
			existing.Confirmed = existing.Confirmed || correlation.Confirmed
			if existing.TransactionID == "" {
				existing.TransactionID = correlation.TransactionID
			}
			current.Correlations[index] = existing
			continue
		}
		correlations[correlation.ID] = len(current.Correlations)
		current.Correlations = append(current.Correlations, correlation)
	}
	return current, nil
}

func (s *Store) LocateRecording(
	_ context.Context,
	recording Recording,
) (ArtifactLayout, error) {
	if strings.TrimSpace(recording.CassetteID) != "" {
		return s.cassetteLayout(recording.CassetteID), nil
	}
	return s.recordingLayout(recording.ID), nil
}

func (s *Store) AppendActivityEvent(
	_ context.Context,
	recording Recording,
	event ActivityEvent,
) error {
	if err := ValidateActivityEvent(event); err != nil {
		return err
	}
	portable, err := s.portableActivityEvent(event)
	if err != nil {
		return err
	}
	event = portable
	layout, _ := s.LocateRecording(context.Background(), recording)
	return appendJSONLine(filepath.Join(layout.StorageKey, ActivityEventsFile), event)
}

func (s *Store) WriteReplayState(
	_ context.Context,
	recording Recording,
	phase ReplayStatePhase,
	state []byte,
) error {
	layout, _ := s.LocateRecording(context.Background(), recording)
	statePath := layout.ExpectedStateKey
	if phase == ReplayStatePhaseInitial {
		statePath = layout.InitialStateKey
	}
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		return err
	}
	if err := writeFileAtomic(statePath, state); err != nil {
		return err
	}
	return s.exportFixtureBlobs(statePath, layout.StorageKey)
}

func (s *Store) WriteCheckpointPlan(
	_ context.Context,
	recording Recording,
	plan CheckpointPlan,
) error {
	if err := ValidateCheckpointPlan(plan, nil, nil); err != nil {
		return err
	}
	layout, _ := s.LocateRecording(context.Background(), recording)
	return writeJSONAtomic(layout.CheckpointPlanKey, plan)
}

func (s *Store) DiscardRecording(_ context.Context, recordingID string) error {
	return os.RemoveAll(s.recordingLayout(recordingID).StorageKey)
}

func (s *Store) DiscardCassette(_ context.Context, cassetteID string) error {
	return os.RemoveAll(s.cassetteLayout(cassetteID).StorageKey)
}

func (s *Store) RollbackPublish(
	_ context.Context,
	artifact Artifact,
	recording Recording,
) error {
	candidate := s.recordingLayout(recording.ID)
	if err := os.MkdirAll(filepath.Dir(candidate.StorageKey), 0o700); err != nil {
		return err
	}
	return os.Rename(artifact.Layout.StorageKey, candidate.StorageKey)
}

func (s *Store) Resolve(_ context.Context, requested Cassette) (Artifact, error) {
	layout := s.cassetteLayout(requested.ID)
	manifestPath := filepath.Join(layout.StorageKey, CassetteManifestFile)
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return Artifact{}, err
	}
	manifestSHA256, err := fileSHA256(manifestPath)
	if err != nil {
		return Artifact{}, err
	}
	if requested.ManifestSHA256 != "" &&
		!strings.EqualFold(requested.ManifestSHA256, manifestSHA256) {
		return Artifact{}, errors.New("cassette manifest integrity mismatch")
	}
	var manifest CassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Artifact{}, err
	}
	if err := rejectPortableScopeFields(raw, "cassette manifest"); err != nil {
		return Artifact{}, err
	}
	if manifest.ID != requested.ID {
		return Artifact{}, errors.New("cassette identity mismatch")
	}
	if manifest.StateFormat != StateFormat {
		return Artifact{}, errors.New("unsupported cassette state format")
	}
	blobManifest, err := readBlobManifest(filepath.Join(layout.StorageKey, BlobManifestFile))
	if err != nil {
		return Artifact{}, err
	}
	if err := ValidateCassetteManifestPolicy(manifest, blobManifest); err != nil {
		return Artifact{}, err
	}
	files, err := collectCassetteFiles(layout.StorageKey, manifest.Files)
	if err != nil {
		return Artifact{}, err
	}
	if err := ValidateCassetteIntegrity(manifest, files); err != nil {
		return Artifact{}, err
	}
	if err := validatePortableReplayFiles(layout.StorageKey); err != nil {
		return Artifact{}, err
	}
	return Artifact{
		Cassette: Cassette{
			ID:                 manifest.ID,
			Name:               manifest.Name,
			SourceRecordingID:  manifest.SourceRecordingID,
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
	requested Cassette,
	name string,
) (Artifact, error) {
	name, err := NormalizeRecordingName(name)
	if err != nil {
		return Artifact{}, err
	}
	artifact, err := s.Resolve(ctx, requested)
	if err != nil {
		return Artifact{}, err
	}
	manifestPath := filepath.Join(artifact.Layout.StorageKey, CassetteManifestFile)
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return Artifact{}, err
	}
	var manifest CassetteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Artifact{}, err
	}
	manifest.Name = name
	if err := writeJSONAtomic(manifestPath, manifest); err != nil {
		return Artifact{}, err
	}
	manifestSHA256, err := fileSHA256(manifestPath)
	if err != nil {
		return Artifact{}, err
	}
	artifact.Cassette.Name = name
	artifact.Cassette.ManifestSHA256 = manifestSHA256
	return artifact, nil
}

func (s *Store) recordingLayout(recordingID string) ArtifactLayout {
	root := filepath.Join(
		filepath.Clean(strings.TrimSpace(s.StateDir)),
		"agent-session-recordings",
		strings.TrimSpace(recordingID),
		"candidate",
	)
	return artifactLayout(root)
}

func (s *Store) cassetteLayout(cassetteID string) ArtifactLayout {
	root := filepath.Join(
		filepath.Clean(strings.TrimSpace(s.StateDir)),
		"agent-session-cassettes",
		strings.TrimSpace(cassetteID),
	)
	return artifactLayout(root)
}

func artifactLayout(root string) ArtifactLayout {
	return ArtifactLayout{
		StorageKey:        root,
		ProviderTapeKey:   filepath.Join(root, "provider"),
		CheckpointPlanKey: filepath.Join(root, filepath.FromSlash(CheckpointPlanFile)),
		InitialStateKey:   filepath.Join(root, filepath.FromSlash(InitialStateFile)),
		ExpectedStateKey:  filepath.Join(root, filepath.FromSlash(ExpectedStateFile)),
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

func writeFileAtomic(path string, value []byte) error {
	tempPath := path + ".tmp"
	if err := os.WriteFile(tempPath, value, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("replace %s: %w", filepath.Base(path), err)
	}
	return nil
}
