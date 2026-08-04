package sessionreplay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type SemanticCassetteReader struct {
	directories map[string]string
}

func NewSemanticCassetteReader(
	directories map[string]string,
) (*SemanticCassetteReader, error) {
	resolved := make(map[string]string, len(directories))
	for cassetteID, directory := range directories {
		cassetteID = strings.TrimSpace(cassetteID)
		directory = strings.TrimSpace(directory)
		if cassetteID == "" || directory == "" {
			return nil, errors.New("semantic cassette reader requires cassette ID and directory")
		}
		resolved[cassetteID] = directory
	}
	return &SemanticCassetteReader{directories: resolved}, nil
}

func (r *SemanticCassetteReader) ReadSemanticCassette(
	ctx context.Context,
	cassetteID string,
) (SemanticCassetteArtifact, error) {
	if err := ctx.Err(); err != nil {
		return SemanticCassetteArtifact{}, err
	}
	cassetteID = strings.TrimSpace(cassetteID)
	if r == nil || cassetteID == "" {
		return SemanticCassetteArtifact{}, errors.New(
			"semantic cassette reader requires cassette ID",
		)
	}
	directory := strings.TrimSpace(r.directories[cassetteID])
	if directory == "" {
		return SemanticCassetteArtifact{}, fmt.Errorf(
			"semantic cassette %q is not registered",
			cassetteID,
		)
	}

	manifestRaw, err := os.ReadFile(
		filepath.Join(directory, CassetteManifestFile),
	)
	if err != nil {
		return SemanticCassetteArtifact{}, err
	}
	var manifest CassetteManifest
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		return SemanticCassetteArtifact{}, err
	}
	if err := rejectPortableScopeFields(manifestRaw, "cassette manifest"); err != nil {
		return SemanticCassetteArtifact{}, err
	}
	if manifest.ID != cassetteID {
		return SemanticCassetteArtifact{}, errors.New(
			"cassette identity mismatch",
		)
	}
	if manifest.StateFormat != StateFormat {
		return SemanticCassetteArtifact{}, errors.New(
			"unsupported cassette state format",
		)
	}
	blobManifest, err := readBlobManifest(
		filepath.Join(directory, BlobManifestFile),
	)
	if err != nil {
		return SemanticCassetteArtifact{}, err
	}
	if err := ValidateCassetteManifestPolicy(manifest, blobManifest); err != nil {
		return SemanticCassetteArtifact{}, err
	}
	files, err := collectCassetteFiles(directory, manifest.Files)
	if err != nil {
		return SemanticCassetteArtifact{}, err
	}
	if err := ValidateCassetteIntegrity(manifest, files); err != nil {
		return SemanticCassetteArtifact{}, err
	}
	if err := validatePortableReplayFiles(directory); err != nil {
		return SemanticCassetteArtifact{}, err
	}

	events, err := readJSONLines[ActivityEvent](
		filepath.Join(directory, ActivityEventsFile),
		"activity event",
	)
	if err != nil {
		return SemanticCassetteArtifact{}, err
	}
	plan, err := loadAndValidateCheckpointPlan(directory, events)
	if err != nil {
		return SemanticCassetteArtifact{}, err
	}
	expected, _, err := readSemanticReplayState(
		filepath.Join(directory, ExpectedStateFile),
	)
	if err != nil {
		return SemanticCassetteArtifact{}, err
	}

	artifact := SemanticCassetteArtifact{
		Manifest:       manifest,
		ExpectedState:  expected,
		CheckpointPlan: plan,
	}
	if manifest.Mode == ScenarioModeContinueSession {
		initial, raw, err := readSemanticReplayState(
			filepath.Join(directory, InitialStateFile),
		)
		if err != nil {
			return SemanticCassetteArtifact{}, err
		}
		artifact.InitialStateRaw = raw
		artifact.InitialState = &initial
	}
	return artifact, nil
}

func readSemanticReplayState(
	path string,
) (TuttiReplayState, []byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return TuttiReplayState{}, nil, err
	}
	var state TuttiReplayState
	if err := json.Unmarshal(raw, &state); err != nil {
		return TuttiReplayState{}, nil, fmt.Errorf(
			"decode semantic replay state %s: %w",
			filepath.Base(path),
			err,
		)
	}
	if err := ValidateTuttiReplayState(state); err != nil {
		return TuttiReplayState{}, nil, err
	}
	return state, raw, nil
}
