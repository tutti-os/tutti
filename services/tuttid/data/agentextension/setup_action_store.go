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

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

const setupActionRelativeDir = "agent/extension-runtime-actions"

type FileSetupActionStore struct {
	stateDir string
}

func NewFileSetupActionStore(stateDir string) *FileSetupActionStore {
	return &FileSetupActionStore{stateDir: strings.TrimSpace(stateDir)}
}

func (s *FileSetupActionStore) Read(ctx context.Context, scope agentextensionbiz.SetupActionScope) (*agentextensionbiz.SetupAction, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := s.actionPath(scope)
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
	var action agentextensionbiz.SetupAction
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&action); err != nil {
		return nil, err
	}
	if err := validateActionScope(scope, action); err != nil {
		return nil, err
	}
	return &action, nil
}

func (s *FileSetupActionStore) Put(ctx context.Context, scope agentextensionbiz.SetupActionScope, action agentextensionbiz.SetupAction) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateActionScope(scope, action); err != nil {
		return err
	}
	path, err := s.actionPath(scope)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(action, "", "  ")
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

func (s *FileSetupActionStore) actionPath(scope agentextensionbiz.SetupActionScope) (string, error) {
	if s == nil || s.stateDir == "" {
		return "", errors.New("agent extension setup action state directory is required")
	}
	if strings.TrimSpace(scope.AgentTargetID) == "" || strings.TrimSpace(scope.ExtensionInstallationID) == "" {
		return "", errors.New("agent extension setup action scope is required")
	}
	digest := sha256.Sum256([]byte(scope.AgentTargetID + "\x00" + scope.ExtensionInstallationID))
	return filepath.Join(s.stateDir, filepath.FromSlash(setupActionRelativeDir), hex.EncodeToString(digest[:])+".json"), nil
}

func validateActionScope(scope agentextensionbiz.SetupActionScope, action agentextensionbiz.SetupAction) error {
	if action.AgentTargetID != scope.AgentTargetID || action.ExtensionInstallationID != scope.ExtensionInstallationID {
		return errors.New("agent target setup action scope is invalid")
	}
	return nil
}
