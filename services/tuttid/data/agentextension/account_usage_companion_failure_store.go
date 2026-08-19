package agentextension

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

const accountUsageCompanionFailureRelativeDir = "agent/extension-account-usage-companion-failures"

type FileAccountUsageCompanionFailureStore struct {
	stateDir string
	mu       sync.RWMutex
}

func NewFileAccountUsageCompanionFailureStore(stateDir string) *FileAccountUsageCompanionFailureStore {
	return &FileAccountUsageCompanionFailureStore{stateDir: strings.TrimSpace(stateDir)}
}

func (s *FileAccountUsageCompanionFailureStore) Read(
	ctx context.Context,
	scope agentextensionbiz.AccountUsageCompanionFailureScope,
) (*agentextensionbiz.AccountUsageCompanionFailure, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	path, err := s.failurePath(scope)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var failure agentextensionbiz.AccountUsageCompanionFailure
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&failure); err != nil {
		return nil, err
	}
	if err := validateAccountUsageCompanionFailure(scope, failure); err != nil {
		return nil, err
	}
	return &failure, nil
}

func (s *FileAccountUsageCompanionFailureStore) Put(
	ctx context.Context,
	scope agentextensionbiz.AccountUsageCompanionFailureScope,
	failure agentextensionbiz.AccountUsageCompanionFailure,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateAccountUsageCompanionFailure(scope, failure); err != nil {
		return err
	}
	path, err := s.failurePath(scope)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(failure, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".write-")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

func (s *FileAccountUsageCompanionFailureStore) Delete(
	ctx context.Context,
	scope agentextensionbiz.AccountUsageCompanionFailureScope,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.failurePath(scope)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *FileAccountUsageCompanionFailureStore) failurePath(
	scope agentextensionbiz.AccountUsageCompanionFailureScope,
) (string, error) {
	if s == nil || s.stateDir == "" {
		return "", errors.New("account usage companion failure state directory is required")
	}
	if strings.TrimSpace(scope.AgentTargetID) == "" || strings.TrimSpace(scope.ExtensionInstallationID) == "" {
		return "", errors.New("account usage companion failure scope is required")
	}
	digest := sha256.Sum256([]byte(scope.AgentTargetID + "\x00" + scope.ExtensionInstallationID))
	return filepath.Join(
		s.stateDir,
		filepath.FromSlash(accountUsageCompanionFailureRelativeDir),
		hex.EncodeToString(digest[:])+".json",
	), nil
}

func validateAccountUsageCompanionFailure(
	scope agentextensionbiz.AccountUsageCompanionFailureScope,
	failure agentextensionbiz.AccountUsageCompanionFailure,
) error {
	if failure.SchemaVersion != agentextensionbiz.AccountUsageCompanionFailureSchemaVersion ||
		failure.AgentTargetID != scope.AgentTargetID ||
		failure.ExtensionInstallationID != scope.ExtensionInstallationID ||
		strings.TrimSpace(failure.RuntimeIdentity) == "" ||
		failure.ErrorCode != "install_failed" ||
		failure.ConsecutiveFailures <= 0 ||
		failure.LastAttemptAtUnixMS <= 0 ||
		failure.NextAttemptAtUnixMS < failure.LastAttemptAtUnixMS {
		return errors.New("account usage companion failure state is invalid")
	}
	return nil
}
