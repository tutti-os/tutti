package agentextension

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const setupDiscoveryRelativeDir = "agent/discovery/agent-extensions"

type FileSetupDiscoveryDirectory struct {
	stateDir string
}

func NewFileSetupDiscoveryDirectory(stateDir string) *FileSetupDiscoveryDirectory {
	return &FileSetupDiscoveryDirectory{stateDir: strings.TrimSpace(stateDir)}
}

func (d *FileSetupDiscoveryDirectory) Ensure(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if d == nil || d.stateDir == "" {
		return "", errors.New("agent extension setup discovery state directory is required")
	}
	root := filepath.Join(d.stateDir, filepath.FromSlash(setupDiscoveryRelativeDir))
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	return root, nil
}
