package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

const preparedReceiptFilename = ".tutti-connector-receipt.json"

// ExecutionSnapshotter copies a verified prepared tree into an immutable,
// route-scoped snapshot so updates cannot mutate a running connector.
type ExecutionSnapshotter struct{ root string }

func NewExecutionSnapshotter(root string) (*ExecutionSnapshotter, error) {
	if !filepath.IsAbs(strings.TrimSpace(root)) {
		return nil, errors.New("connector execution snapshot root must be absolute")
	}
	return &ExecutionSnapshotter{root: filepath.Clean(root)}, nil
}

// CleanupOrphans removes execution snapshots left by a previous host process.
// It must run before runtime routes are restored because active routes own
// their snapshots in memory and remove them during normal retirement.
func (snapshotter *ExecutionSnapshotter) CleanupOrphans() error {
	if snapshotter == nil {
		return errors.New("connector execution snapshotter is unavailable")
	}
	if err := os.MkdirAll(snapshotter.root, 0o700); err != nil {
		return err
	}
	stateRoot, err := filepath.EvalSymlinks(snapshotter.root)
	if err != nil {
		return err
	}
	parent := filepath.Join(stateRoot, "execution-snapshots")
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		return err
	}
	var cleanupErrors []error
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, ".staging-") && !strings.HasSuffix(name, ".ready") {
			continue
		}
		if err := snapshotter.remove(filepath.Join(parent, name), true); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	return errors.Join(cleanupErrors...)
}

func (snapshotter *ExecutionSnapshotter) Create(prepared market.PreparedArtifactReceipt, executableEntries ...string) (string, error) {
	if snapshotter == nil || strings.TrimSpace(prepared.InventoryDigest) == "" {
		return "", errors.New("prepared connector inventory digest is missing")
	}
	if err := os.MkdirAll(snapshotter.root, 0o700); err != nil {
		return "", err
	}
	stateRoot, err := filepath.EvalSymlinks(snapshotter.root)
	if err != nil {
		return "", err
	}
	parent := filepath.Join(stateRoot, "execution-snapshots")
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return "", err
	}
	staging, err := os.MkdirTemp(parent, ".staging-")
	if err != nil {
		return "", err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = snapshotter.remove(staging, true)
		}
	}()
	if err := copyExecutionTree(prepared.PreparedPath, staging); err != nil {
		return "", err
	}
	digest, err := ExecutionInventoryDigest(staging)
	if err != nil {
		return "", err
	}
	if digest != prepared.InventoryDigest {
		return "", errors.New("connector execution snapshot does not match verified inventory")
	}
	for _, relative := range executableEntries {
		executable, entryErr := PreparedEntrypoint(staging, relative)
		if entryErr != nil {
			return "", fmt.Errorf("prepare connector artifact-native entrypoint: %w", entryErr)
		}
		if err := os.Chmod(executable, 0o500); err != nil {
			return "", err
		}
	}
	target := staging + ".ready"
	if err := os.Rename(staging, target); err != nil {
		return "", err
	}
	staging = target
	readyExecutablePaths := make(map[string]struct{}, len(executableEntries))
	for _, relative := range executableEntries {
		readyExecutablePaths[filepath.Join(target, filepath.FromSlash(relative))] = struct{}{}
	}
	if err := makeExecutionTreeReadOnly(target, readyExecutablePaths); err != nil {
		return "", err
	}
	cleanup = false
	return target, nil
}

func (snapshotter *ExecutionSnapshotter) Remove(root string) error {
	return snapshotter.remove(root, false)
}

func (snapshotter *ExecutionSnapshotter) remove(root string, allowStaging bool) error {
	if snapshotter == nil {
		return errors.New("connector execution snapshotter is unavailable")
	}
	if strings.TrimSpace(root) == "" {
		return nil
	}
	stateRoot, err := filepath.EvalSymlinks(snapshotter.root)
	if err != nil {
		return err
	}
	parent := filepath.Join(stateRoot, "execution-snapshots")
	parentReal, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return err
	}
	clean := filepath.Clean(root)
	base := filepath.Base(clean)
	validName := strings.HasSuffix(base, ".ready") || (allowStaging && strings.HasPrefix(base, ".staging-"))
	info, statErr := os.Lstat(clean)
	if !validName || filepath.Dir(clean) != parentReal || statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("connector execution snapshot removal target is invalid")
	}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr == nil && entry.IsDir() {
			_ = os.Chmod(path, 0o700)
		}
		return nil
	})
	return os.RemoveAll(root)
}

func copyExecutionTree(source, destination string) error {
	return filepath.WalkDir(source, func(path string, _ os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil || relative == "." {
			return err
		}
		target := filepath.Join(destination, relative)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("prepared connector snapshot contains a symlink")
		}
		if info.IsDir() {
			return os.Mkdir(target, 0o700)
		}
		if !info.Mode().IsRegular() {
			return errors.New("prepared connector snapshot contains an unsupported file type")
		}
		sourceFile, err := os.Open(path)
		if err != nil {
			return err
		}
		openedInfo, statErr := sourceFile.Stat()
		if statErr != nil || !openedInfo.Mode().IsRegular() {
			_ = sourceFile.Close()
			return errors.New("prepared connector file changed during snapshot")
		}
		targetFile, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			_ = sourceFile.Close()
			return err
		}
		_, copyErr := io.Copy(targetFile, sourceFile)
		syncErr := targetFile.Sync()
		return errors.Join(copyErr, syncErr, targetFile.Close(), sourceFile.Close())
	})
}

// ExecutionInventoryDigest computes the same verified tree identity used by
// artifact preparation and immutable execution snapshots.
func ExecutionInventoryDigest(root string) (string, error) {
	hash := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil || relative == "." || relative == preparedReceiptFilename {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("connector execution snapshot contains an unsupported file type")
		}
		_, _ = io.WriteString(hash, filepath.ToSlash(relative))
		_, _ = hash.Write([]byte{0})
		if entry.IsDir() {
			_, _ = hash.Write([]byte("dir\x00"))
			return nil
		}
		_, _ = io.WriteString(hash, fmt.Sprintf("file\x00%d\x00", info.Size()))
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(hash, file)
		return errors.Join(copyErr, file.Close())
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func makeExecutionTreeReadOnly(root string, executablePaths map[string]struct{}) error {
	var directories []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
			return nil
		}
		mode := os.FileMode(0o400)
		if _, executable := executablePaths[filepath.Clean(path)]; executable {
			mode = 0o500
		}
		return os.Chmod(path, mode)
	})
	if err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := os.Chmod(directories[index], 0o500); err != nil {
			return err
		}
	}
	return nil
}
