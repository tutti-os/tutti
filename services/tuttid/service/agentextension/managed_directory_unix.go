//go:build !windows

package agentextension

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

type managedRuntimeWorkspace struct {
	rootPath  string
	agentPath string
	rootDir   *os.File
	agentDir  *os.File
}

type managedRuntimeDirectory struct {
	workspace *managedRuntimeWorkspace
	name      string
	path      string
	file      *os.File
}

func openManagedRuntimeWorkspace(runtimeInstallDir, agentKey string) (*managedRuntimeWorkspace, error) {
	return openManagedRuntimeWorkspaceForInstall(runtimeInstallDir, agentKey, false)
}

func openManagedRuntimeWorkspaceForInstall(runtimeInstallDir, agentKey string, _ bool) (*managedRuntimeWorkspace, error) {
	if !filepath.IsAbs(runtimeInstallDir) || !safeKey.MatchString(agentKey) {
		return nil, errors.New("managed runtime workspace identity is invalid")
	}
	rootPath := filepath.Clean(runtimeInstallDir)
	rootDir, err := openOrCreateAbsoluteDirectoryNoFollow(rootPath)
	if err != nil {
		return nil, fmt.Errorf("open managed runtime root without symlinks: %w", err)
	}
	if err := unix.Mkdirat(int(rootDir.Fd()), agentKey, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
		rootDir.Close()
		return nil, err
	}
	agentFD, err := unix.Openat(int(rootDir.Fd()), agentKey, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		rootDir.Close()
		return nil, fmt.Errorf("open managed runtime agent directory: %w", err)
	}
	workspace := &managedRuntimeWorkspace{
		rootPath: rootPath, agentPath: filepath.Join(rootPath, agentKey),
		rootDir: rootDir, agentDir: os.NewFile(uintptr(agentFD), "managed-runtime-agent"),
	}
	if err := workspace.verify(); err != nil {
		workspace.Close()
		return nil, err
	}
	return workspace, nil
}

func openOrCreateAbsoluteDirectoryNoFollow(path string) (*os.File, error) {
	currentFD, err := unix.Open(string(filepath.Separator), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	components := strings.Split(strings.TrimPrefix(filepath.Clean(path), string(filepath.Separator)), string(filepath.Separator))
	for _, component := range components {
		if component == "" || component == "." || component == ".." {
			unix.Close(currentFD)
			return nil, errors.New("managed runtime root contains an unsafe component")
		}
		if err := unix.Mkdirat(currentFD, component, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
			unix.Close(currentFD)
			return nil, err
		}
		nextFD, err := unix.Openat(currentFD, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(currentFD)
		if err != nil {
			return nil, err
		}
		currentFD = nextFD
	}
	return os.NewFile(uintptr(currentFD), "managed-runtime-root"), nil
}

func (w *managedRuntimeWorkspace) createTemp(prefix string) (*managedRuntimeDirectory, error) {
	if err := w.verify(); err != nil {
		return nil, err
	}
	for range 128 {
		var random [12]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, err
		}
		name := prefix + hex.EncodeToString(random[:])
		if err := unix.Mkdirat(int(w.agentDir.Fd()), name, 0o700); errors.Is(err, unix.EEXIST) {
			continue
		} else if err != nil {
			return nil, err
		}
		fd, err := unix.Openat(int(w.agentDir.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			_ = unix.Unlinkat(int(w.agentDir.Fd()), name, unix.AT_REMOVEDIR)
			return nil, err
		}
		directory := &managedRuntimeDirectory{workspace: w, name: name, path: filepath.Join(w.agentPath, name), file: os.NewFile(uintptr(fd), name)}
		if err := directory.verify(); err != nil {
			directory.Close()
			return nil, err
		}
		return directory, nil
	}
	return nil, errors.New("allocate managed runtime temporary directory")
}

// createDirectory creates a fresh named directory inside the agent workspace.
// It fails when the name already exists, so callers must remove or rename any
// prior entry first.
func (w *managedRuntimeWorkspace) createDirectory(name string) (*managedRuntimeDirectory, error) {
	if err := w.verify(); err != nil {
		return nil, err
	}
	if name == "" || name == "." || name == ".." || strings.ContainsRune(name, filepath.Separator) {
		return nil, errors.New("managed runtime directory name is invalid")
	}
	if err := unix.Mkdirat(int(w.agentDir.Fd()), name, 0o700); err != nil {
		return nil, err
	}
	fd, err := unix.Openat(int(w.agentDir.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = unix.Unlinkat(int(w.agentDir.Fd()), name, unix.AT_REMOVEDIR)
		return nil, err
	}
	directory := &managedRuntimeDirectory{workspace: w, name: name, path: filepath.Join(w.agentPath, name), file: os.NewFile(uintptr(fd), name)}
	if err := directory.verify(); err != nil {
		directory.Close()
		return nil, err
	}
	return directory, nil
}

func (w *managedRuntimeWorkspace) openDirectory(path string) (*managedRuntimeDirectory, error) {
	if filepath.Dir(filepath.Clean(path)) != w.agentPath {
		return nil, errors.New("managed runtime directory escapes agent root")
	}
	name := filepath.Base(path)
	if name == "." || name == ".." || strings.ContainsRune(name, filepath.Separator) {
		return nil, errors.New("managed runtime directory name is invalid")
	}
	fd, err := unix.Openat(int(w.agentDir.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	directory := &managedRuntimeDirectory{workspace: w, name: name, path: filepath.Join(w.agentPath, name), file: os.NewFile(uintptr(fd), name)}
	if err := directory.verify(); err != nil {
		directory.Close()
		return nil, err
	}
	return directory, nil
}

func (w *managedRuntimeWorkspace) openDirectoryName(name string) (*managedRuntimeDirectory, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsRune(name, filepath.Separator) {
		return nil, errors.New("managed runtime directory name is invalid")
	}
	return w.openDirectory(filepath.Join(w.agentPath, name))
}

func (w *managedRuntimeWorkspace) directoryNames() ([]string, error) {
	if err := w.verify(); err != nil {
		return nil, err
	}
	fd, err := unix.Dup(int(w.agentDir.Fd()))
	if err != nil {
		return nil, err
	}
	directory := os.NewFile(uintptr(fd), "managed-runtime-agent-list")
	defer directory.Close()
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink == 0 && entry.IsDir() {
			result = append(result, entry.Name())
		}
	}
	return result, nil
}

func (w *managedRuntimeWorkspace) verify() error {
	if w == nil || w.rootDir == nil || w.agentDir == nil {
		return errors.New("managed runtime workspace is closed")
	}
	for _, pair := range []struct {
		path string
		file *os.File
	}{{w.rootPath, w.rootDir}, {w.agentPath, w.agentDir}} {
		pathInfo, err := os.Lstat(pair.path)
		if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.IsDir() {
			return errors.New("managed runtime directory path identity changed")
		}
		fileInfo, err := pair.file.Stat()
		if err != nil || !os.SameFile(pathInfo, fileInfo) {
			return errors.New("managed runtime directory handle identity changed")
		}
	}
	return nil
}

func (d *managedRuntimeDirectory) verify() error {
	if d == nil || d.file == nil || d.workspace == nil {
		return errors.New("managed runtime directory is closed")
	}
	if err := d.workspace.verify(); err != nil {
		return err
	}
	pathInfo, err := os.Lstat(d.path)
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.IsDir() {
		return errors.New("managed runtime temporary directory path identity changed")
	}
	fileInfo, err := d.file.Stat()
	if err != nil || !os.SameFile(pathInfo, fileInfo) {
		return errors.New("managed runtime temporary directory handle identity changed")
	}
	resolvedRoot, err := filepath.EvalSymlinks(d.workspace.rootPath)
	if err != nil {
		return err
	}
	resolvedPath, err := filepath.EvalSymlinks(d.path)
	if err != nil || !pathWithin(resolvedPath, resolvedRoot) {
		return errors.New("managed runtime temporary directory escapes configured root")
	}
	return nil
}

func (w *managedRuntimeWorkspace) rename(oldName, newName string) error {
	if err := w.verify(); err != nil {
		return err
	}
	return unix.Renameat(int(w.agentDir.Fd()), oldName, int(w.agentDir.Fd()), newName)
}

func (d *managedRuntimeDirectory) createFile(relative string, mode os.FileMode) (*os.File, error) {
	if err := d.verify(); err != nil {
		return nil, err
	}
	relative = filepath.Clean(relative)
	if relative == "." || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, errors.New("managed runtime file path is unsafe")
	}
	components := strings.Split(relative, string(filepath.Separator))
	currentFD, err := unix.Dup(int(d.file.Fd()))
	if err != nil {
		return nil, err
	}
	defer func() { _ = unix.Close(currentFD) }()
	for _, component := range components[:len(components)-1] {
		if component == "" || component == "." || component == ".." {
			return nil, errors.New("managed runtime file path contains an unsafe component")
		}
		if err := unix.Mkdirat(currentFD, component, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
			return nil, err
		}
		nextFD, err := unix.Openat(currentFD, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		unix.Close(currentFD)
		currentFD = nextFD
	}
	name := components[len(components)-1]
	if name == "" || name == "." || name == ".." {
		return nil, errors.New("managed runtime file name is unsafe")
	}
	fd, err := unix.Openat(currentFD, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, uint32(mode.Perm()))
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), name), nil
}

func (d *managedRuntimeDirectory) openFile(relative string, flags int) (*os.File, error) {
	if err := d.verify(); err != nil {
		return nil, err
	}
	relative = filepath.Clean(relative)
	if relative == "." || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, errors.New("managed runtime file path is unsafe")
	}
	components := strings.Split(relative, string(filepath.Separator))
	currentFD, err := unix.Dup(int(d.file.Fd()))
	if err != nil {
		return nil, err
	}
	defer func() { _ = unix.Close(currentFD) }()
	for _, component := range components[:len(components)-1] {
		nextFD, err := unix.Openat(currentFD, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		unix.Close(currentFD)
		currentFD = nextFD
	}
	fd, err := unix.Openat(currentFD, components[len(components)-1], flags|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), components[len(components)-1]), nil
}

func (d *managedRuntimeDirectory) readJSON(name string, target any) error {
	file, err := d.openFile(name, unix.O_RDONLY)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1<<20))
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func (d *managedRuntimeDirectory) writeJSONAtomic(name string, value any) error {
	if filepath.Base(name) != name || name == "." || name == ".." {
		return errors.New("managed runtime state file name is invalid")
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	tempName := ".write-" + hex.EncodeToString(random[:])
	file, err := d.createFile(tempName, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		_ = unix.Unlinkat(int(d.file.Fd()), tempName, 0)
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		_ = unix.Unlinkat(int(d.file.Fd()), tempName, 0)
		return err
	}
	if err := file.Close(); err != nil {
		_ = unix.Unlinkat(int(d.file.Fd()), tempName, 0)
		return err
	}
	if err := unix.Renameat(int(d.file.Fd()), tempName, int(d.file.Fd()), name); err != nil {
		_ = unix.Unlinkat(int(d.file.Fd()), tempName, 0)
		return err
	}
	return nil
}

func (w *managedRuntimeWorkspace) remove(name string) error {
	if err := w.verify(); err != nil {
		return err
	}
	if name == "" || name == "." || name == ".." || strings.ContainsRune(name, filepath.Separator) {
		return errors.New("managed runtime entry name is invalid")
	}
	fd, err := unix.Openat(int(w.agentDir.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		if errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.ELOOP) {
			return unix.Unlinkat(int(w.agentDir.Fd()), name, 0)
		}
		return err
	}
	directory := os.NewFile(uintptr(fd), name)
	if err := removeManagedDirectoryContents(directory); err != nil {
		directory.Close()
		return err
	}
	if err := directory.Close(); err != nil {
		return err
	}
	return unix.Unlinkat(int(w.agentDir.Fd()), name, unix.AT_REMOVEDIR)
}

func removeManagedDirectoryContents(directory *os.File) error {
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "." || name == ".." {
			return errors.New("managed runtime directory contains unsafe entry")
		}
		if entry.Type()&os.ModeSymlink == 0 && entry.IsDir() {
			fd, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return err
			}
			child := os.NewFile(uintptr(fd), name)
			if err := removeManagedDirectoryContents(child); err != nil {
				child.Close()
				return err
			}
			if err := child.Close(); err != nil {
				return err
			}
			if err := unix.Unlinkat(int(directory.Fd()), name, unix.AT_REMOVEDIR); err != nil {
				return err
			}
			continue
		}
		if err := unix.Unlinkat(int(directory.Fd()), name, 0); err != nil {
			return err
		}
	}
	return nil
}

func (d *managedRuntimeDirectory) Close() error {
	if d == nil || d.file == nil {
		return nil
	}
	err := d.file.Close()
	d.file = nil
	return err
}

func (w *managedRuntimeWorkspace) Close() error {
	if w == nil {
		return nil
	}
	var result error
	if w.agentDir != nil {
		result = errors.Join(result, w.agentDir.Close())
		w.agentDir = nil
	}
	if w.rootDir != nil {
		result = errors.Join(result, w.rootDir.Close())
		w.rootDir = nil
	}
	return result
}
