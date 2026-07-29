package tuttiagent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofrs/flock"
)

const tuttiAgentAuthLockRetryDelay = 25 * time.Millisecond

type tuttiAgentAuthSnapshot struct {
	path       string
	entryPath  string
	linkTarget string
	data       []byte
	mode       os.FileMode
	exists     bool
	wasSymlink bool
}

func captureTuttiAgentAuthSnapshot() (tuttiAgentAuthSnapshot, error) {
	authPath, ok := userTuttiAgentAuthPath()
	if !ok {
		return tuttiAgentAuthSnapshot{}, fmt.Errorf("resolve tutti-agent auth path")
	}
	snapshot := tuttiAgentAuthSnapshot{entryPath: authPath}
	entryInfo, entryErr := os.Lstat(authPath)
	if entryErr != nil && !errors.Is(entryErr, os.ErrNotExist) {
		return tuttiAgentAuthSnapshot{}, fmt.Errorf("inspect tutti-agent auth entry: %w", entryErr)
	}
	if entryErr == nil && entryInfo.Mode()&os.ModeSymlink != 0 {
		snapshot.linkTarget, entryErr = os.Readlink(authPath)
		if entryErr != nil {
			return tuttiAgentAuthSnapshot{}, fmt.Errorf("read tutti-agent auth symlink: %w", entryErr)
		}
		snapshot.wasSymlink = true
	}
	authPath, err := resolveTuttiAgentAuthFileTarget(authPath)
	if err != nil {
		return tuttiAgentAuthSnapshot{}, fmt.Errorf("resolve tutti-agent auth target: %w", err)
	}
	snapshot.path = authPath
	info, err := os.Stat(authPath)
	if errors.Is(err, os.ErrNotExist) {
		return snapshot, nil
	}
	if err != nil {
		return tuttiAgentAuthSnapshot{}, fmt.Errorf("inspect tutti-agent auth path: %w", err)
	}
	snapshot.data, err = os.ReadFile(authPath)
	if err != nil {
		return tuttiAgentAuthSnapshot{}, fmt.Errorf("read tutti-agent auth snapshot: %w", err)
	}
	snapshot.mode = info.Mode().Perm()
	snapshot.exists = true
	return snapshot, nil
}

func (s tuttiAgentAuthSnapshot) Restore() error {
	if !s.exists {
		if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove failed tutti-agent auth write: %w", err)
		}
	} else {
		current, readErr := os.ReadFile(s.path)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return fmt.Errorf("read current tutti-agent auth: %w", readErr)
		}
		if readErr != nil || !bytes.Equal(current, s.data) {
			if err := writeTuttiAgentAuthSafely(s.path, s.data, s.mode); err != nil {
				return err
			}
		}
	}
	return s.restoreSymlinkEntry()
}

func (s tuttiAgentAuthSnapshot) restoreSymlinkEntry() error {
	if !s.wasSymlink {
		return nil
	}
	info, err := os.Lstat(s.entryPath)
	if err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return fmt.Errorf("restore tutti-agent auth symlink: entry is no longer a symlink")
		}
		currentTarget, readErr := os.Readlink(s.entryPath)
		if readErr != nil {
			return fmt.Errorf("read current tutti-agent auth symlink: %w", readErr)
		}
		if currentTarget != s.linkTarget {
			return fmt.Errorf("restore tutti-agent auth symlink: link target changed")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect current tutti-agent auth entry: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.entryPath), 0o700); err != nil {
		return fmt.Errorf("create tutti-agent auth symlink directory: %w", err)
	}
	if err := os.Symlink(s.linkTarget, s.entryPath); err != nil {
		return fmt.Errorf("restore tutti-agent auth symlink: %w", err)
	}
	return nil
}

func writeTuttiAgentAuthSafely(path string, data []byte, mode os.FileMode) error {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fmt.Errorf("create tutti-agent auth directory: %w", err)
	}
	temporary, err := os.CreateTemp(parent, ".auth-restore-*")
	if err != nil {
		return fmt.Errorf("create temporary tutti-agent auth: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if mode == 0 {
		mode = 0o600
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("set temporary tutti-agent auth mode: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write temporary tutti-agent auth: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync temporary tutti-agent auth: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary tutti-agent auth: %w", err)
	}
	if err := replaceTuttiAgentAuthFile(temporaryPath, path); err != nil {
		return fmt.Errorf("replace tutti-agent auth safely: %w", err)
	}
	return nil
}

func acquireTuttiAgentAuthMutationLock(ctx context.Context) (*flock.Flock, error) {
	authPath, ok := userTuttiAgentAuthPath()
	if !ok {
		return nil, fmt.Errorf("resolve tutti-agent auth path")
	}
	authPath, err := resolveTuttiAgentAuthFileTarget(authPath)
	if err != nil {
		return nil, fmt.Errorf("resolve tutti-agent auth target: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		return nil, fmt.Errorf("create tutti-agent auth lock directory: %w", err)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// Tutti Agent's Rust fs2 lock and gofrs/flock both use the operating
	// system's advisory file-lock primitive (flock on Unix, LockFileEx on
	// Windows). They interoperate only when both processes resolve this same
	// local-filesystem lock path; this is not a distributed lock.
	authLock := flock.New(authPath + ".refresh.lock")
	locked, err := authLock.TryLockContext(ctx, tuttiAgentAuthLockRetryDelay)
	if err != nil {
		return nil, fmt.Errorf("lock tutti-agent auth mutation: %w", err)
	}
	if !locked {
		return nil, fmt.Errorf("lock tutti-agent auth mutation")
	}
	return authLock, nil
}

func resolveTuttiAgentAuthFileTarget(path string) (string, error) {
	const maxSymlinkDepth = 40

	current, err := normalizeTuttiAgentAuthPath(path)
	if err != nil {
		return "", err
	}
	visited := make(map[string]struct{}, maxSymlinkDepth)
	for range maxSymlinkDepth {
		if _, ok := visited[current]; ok {
			return "", fmt.Errorf("auth.json symlink loop detected")
		}
		visited[current] = struct{}{}
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return current, nil
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return current, nil
		}
		target, err := os.Readlink(current)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(current), target)
		}
		current, err = normalizeTuttiAgentAuthPath(target)
		if err != nil {
			return "", err
		}
	}
	return "", fmt.Errorf("auth.json symlink depth exceeded")
}

func normalizeTuttiAgentAuthPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if errors.Is(err, os.ErrNotExist) {
		return filepath.Clean(absolute), nil
	}
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(absolute)), nil
}
