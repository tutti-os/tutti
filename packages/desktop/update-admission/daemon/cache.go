package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const featureCacheSchemaVersion = "tutti.desktop-update-admission-feature-cache.v1"

type featureCacheDocument struct {
	SchemaVersion  string    `json:"schemaVersion"`
	Identity       Identity  `json:"identity"`
	PolicyRevision string    `json:"policyRevision"`
	FetchedAt      time.Time `json:"fetchedAt"`
	Keys           []string  `json:"keys"`
}

type FeatureCache interface {
	Load(Identity) (FeatureAvailabilitySnapshot, error)
	Save(Identity, FeatureAvailabilitySnapshot) error
}

type FileFeatureCache struct {
	Path string
}

func (cache FileFeatureCache) Load(identity Identity) (FeatureAvailabilitySnapshot, error) {
	raw, err := os.ReadFile(cache.Path)
	if err != nil {
		return FeatureAvailabilitySnapshot{}, err
	}
	var document featureCacheDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return FeatureAvailabilitySnapshot{}, fmt.Errorf("decode feature availability cache: %w", err)
	}
	if document.SchemaVersion != featureCacheSchemaVersion {
		return FeatureAvailabilitySnapshot{}, errors.New("feature availability cache schema is unsupported")
	}
	if document.Identity != identity {
		return FeatureAvailabilitySnapshot{}, errors.New("feature availability cache identity does not match")
	}
	if document.PolicyRevision == "" || document.FetchedAt.IsZero() {
		return FeatureAvailabilitySnapshot{}, errors.New("feature availability cache metadata is invalid")
	}
	keys, err := parseFeatureAvailability(mustJSON(map[string]any{"keys": document.Keys}))
	if err != nil {
		return FeatureAvailabilitySnapshot{}, err
	}
	revision := document.PolicyRevision
	fetchedAt := document.FetchedAt.UTC()
	return FeatureAvailabilitySnapshot{
		Keys:           keys,
		Source:         "cache",
		PolicyRevision: &revision,
		FetchedAt:      &fetchedAt,
	}, nil
}

func (cache FileFeatureCache) Save(identity Identity, snapshot FeatureAvailabilitySnapshot) error {
	if cache.Path == "" {
		return errors.New("feature availability cache path is empty")
	}
	if snapshot.PolicyRevision == nil || snapshot.FetchedAt == nil {
		return errors.New("feature availability snapshot is not persistable")
	}
	if err := os.MkdirAll(filepath.Dir(cache.Path), 0o700); err != nil {
		return fmt.Errorf("create feature availability cache directory: %w", err)
	}
	document := featureCacheDocument{
		SchemaVersion:  featureCacheSchemaVersion,
		Identity:       identity,
		PolicyRevision: *snapshot.PolicyRevision,
		FetchedAt:      snapshot.FetchedAt.UTC(),
		Keys:           cloneFeatureKeys(snapshot.Keys),
	}
	raw, err := json.Marshal(document)
	if err != nil {
		return fmt.Errorf("encode feature availability cache: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(cache.Path), ".desktop-update-admission-*.tmp")
	if err != nil {
		return fmt.Errorf("create feature availability cache temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("protect feature availability cache temporary file: %w", err)
	}
	if _, err := temporary.Write(append(raw, '\n')); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write feature availability cache temporary file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync feature availability cache temporary file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close feature availability cache temporary file: %w", err)
	}
	if err := os.Rename(temporaryPath, cache.Path); err != nil {
		return fmt.Errorf("replace feature availability cache: %w", err)
	}
	return nil
}

func mustJSON(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}
