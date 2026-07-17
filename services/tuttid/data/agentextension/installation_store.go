package agentextension

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/mod/semver"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

const installationRelativeDir = "agent/extensions"

var installationKeyPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`)

type FileInstallationStore struct {
	stateDir string
}

func NewFileInstallationStore(stateDir string) *FileInstallationStore {
	return &FileInstallationStore{stateDir: strings.TrimSpace(stateDir)}
}

func (s *FileInstallationStore) AgentDir(agentKey string) (string, error) {
	root, err := s.root()
	if err != nil {
		return "", err
	}
	if !installationKeyPattern.MatchString(agentKey) {
		return "", errors.New("agent extension key is invalid")
	}
	return filepath.Join(root, agentKey), nil
}

func (s *FileInstallationStore) PackageDir(agentKey, version string) (string, error) {
	agentDir, err := s.AgentDir(agentKey)
	if err != nil {
		return "", err
	}
	if !semver.IsValid("v" + version) {
		return "", errors.New("agent extension installation identity is invalid")
	}
	return filepath.Join(agentDir, version), nil
}

func (s *FileInstallationStore) ReadActive(agentKey string) (agentextensionbiz.Installation, error) {
	agentDir, err := s.AgentDir(agentKey)
	if err != nil {
		return agentextensionbiz.Installation{}, err
	}
	return readInstallation(filepath.Join(agentDir, "active.json"))
}

func (s *FileInstallationStore) ReadInstallation(installationID string) (agentextensionbiz.Installation, error) {
	agentKey, version, ok := strings.Cut(installationID, "@")
	if !ok || strings.Contains(version, "@") {
		return agentextensionbiz.Installation{}, errors.New("agent extension installation id is invalid")
	}
	packageDir, err := s.PackageDir(agentKey, version)
	if err != nil {
		return agentextensionbiz.Installation{}, err
	}
	return readInstallation(filepath.Join(packageDir, "installation.json"))
}

func (s *FileInstallationStore) PutActive(installation agentextensionbiz.Installation) error {
	packageDir, err := s.PackageDir(installation.AgentKey, installation.Version)
	if err != nil {
		return err
	}
	if installation.ID != installation.AgentKey+"@"+installation.Version || filepath.Clean(installation.PackageDir) != packageDir {
		return errors.New("agent extension installation record identity is invalid")
	}
	if err := writeInstallation(filepath.Join(packageDir, "installation.json"), installation); err != nil {
		return err
	}
	return writeInstallation(filepath.Join(filepath.Dir(packageDir), "active.json"), installation)
}

func (s *FileInstallationStore) root() (string, error) {
	if s == nil || s.stateDir == "" {
		return "", errors.New("agent extension installation state directory is required")
	}
	return filepath.Join(s.stateDir, filepath.FromSlash(installationRelativeDir)), nil
}

func readInstallation(path string) (agentextensionbiz.Installation, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return agentextensionbiz.Installation{}, err
	}
	var installation agentextensionbiz.Installation
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&installation); err != nil {
		return agentextensionbiz.Installation{}, err
	}
	return installation, nil
}

func writeInstallation(path string, installation agentextensionbiz.Installation) error {
	data, err := json.MarshalIndent(installation, "", "  ")
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
