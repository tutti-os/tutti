package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type LocalSessionDirectoryAllocator struct {
	StateDir string
	Now      func() time.Time
}

func (a LocalSessionDirectoryAllocator) CreateSessionDirectory(ctx context.Context) (string, error) {
	stateDir := filepath.Clean(a.StateDir)
	if stateDir == "." || stateDir == string(filepath.Separator) {
		return "", errors.New("agent session state directory is not configured")
	}

	root := filepath.Join(stateDir, "agent", "sessions")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("create agent sessions directory: %w", err)
	}

	now := time.Now().UTC()
	if a.Now != nil {
		now = a.Now().UTC()
	}
	prefix := now.Format("2006-01-02")
	for index := 1; index <= 9999; index++ {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}
		path := filepath.Join(root, fmt.Sprintf("%s-%03d", prefix, index))
		err := os.Mkdir(path, 0o755)
		if err == nil {
			return path, nil
		}
		if errors.Is(err, os.ErrExist) {
			continue
		}
		return "", fmt.Errorf("create agent session directory: %w", err)
	}

	return "", fmt.Errorf("create agent session directory: exhausted names for %s", prefix)
}

func (a LocalSessionDirectoryAllocator) ReleaseSessionDirectory(_ context.Context, path string) error {
	root := filepath.Join(filepath.Clean(a.StateDir), "agent", "sessions")
	path = filepath.Clean(path)
	// Allocation rollback is intentionally limited to one exact direct child of
	// the managed sessions root. Never let a malformed caller broaden cleanup.
	if filepath.Dir(path) != root || path == root {
		return fmt.Errorf("release agent session directory: path %q is outside managed root", path)
	}
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("release agent session directory: %w", err)
	}
	return nil
}
