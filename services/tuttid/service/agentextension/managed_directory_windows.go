//go:build windows

package agentextension

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Windows retains the established package-manager installation path. Binary
// runtimes never opt into this fallback: they remain unavailable until Windows
// has descriptor-relative/no-follow activation with equivalent guarantees.
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

func openManagedRuntimeWorkspaceForInstall(runtimeInstallDir, agentKey string, allowLegacyPackageManager bool) (*managedRuntimeWorkspace, error) {
	if !allowLegacyPackageManager {
		return nil, errors.New("no-follow managed binary runtime activation is unavailable on this platform")
	}
	if !filepath.IsAbs(runtimeInstallDir) || !safeKey.MatchString(agentKey) {
		return nil, errors.New("managed runtime workspace identity is invalid")
	}
	rootPath := filepath.Clean(runtimeInstallDir)
	agentPath := filepath.Join(rootPath, agentKey)
	if err := os.MkdirAll(agentPath, 0o700); err != nil {
		return nil, err
	}
	rootDir, err := openLegacyManagedDirectory(rootPath)
	if err != nil {
		return nil, err
	}
	agentDir, err := openLegacyManagedDirectory(agentPath)
	if err != nil {
		rootDir.Close()
		return nil, err
	}
	workspace := &managedRuntimeWorkspace{
		rootPath: rootPath, agentPath: agentPath, rootDir: rootDir, agentDir: agentDir,
	}
	if err := workspace.verify(); err != nil {
		workspace.Close()
		return nil, err
	}
	return workspace, nil
}

func openLegacyManagedDirectory(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, errors.New("managed runtime directory is unsafe")
	}
	return os.Open(path)
}

func (w *managedRuntimeWorkspace) createTemp(prefix string) (*managedRuntimeDirectory, error) {
	if err := w.verify(); err != nil {
		return nil, err
	}
	path, err := os.MkdirTemp(w.agentPath, prefix)
	if err != nil {
		return nil, err
	}
	result, err := w.openDirectory(path)
	if err != nil {
		_ = os.RemoveAll(path)
		return nil, err
	}
	return result, nil
}

// createDirectory creates a fresh named directory inside the agent workspace.
// It fails when the name already exists, so callers must remove or rename any
// prior entry first.
func (w *managedRuntimeWorkspace) createDirectory(name string) (*managedRuntimeDirectory, error) {
	if err := w.verify(); err != nil {
		return nil, err
	}
	if !validManagedRuntimeEntryName(name) {
		return nil, errors.New("managed runtime directory name is invalid")
	}
	path := filepath.Join(w.agentPath, name)
	if err := os.Mkdir(path, 0o700); err != nil {
		return nil, err
	}
	return w.openDirectory(path)
}

func (w *managedRuntimeWorkspace) openDirectory(path string) (*managedRuntimeDirectory, error) {
	path = filepath.Clean(path)
	if filepath.Dir(path) != w.agentPath {
		return nil, errors.New("managed runtime directory escapes agent root")
	}
	name := filepath.Base(path)
	if !validManagedRuntimeEntryName(name) {
		return nil, errors.New("managed runtime directory name is invalid")
	}
	file, err := openLegacyManagedDirectory(path)
	if err != nil {
		return nil, err
	}
	directory := &managedRuntimeDirectory{workspace: w, name: name, path: path, file: file}
	if err := directory.verify(); err != nil {
		directory.Close()
		return nil, err
	}
	return directory, nil
}

func (w *managedRuntimeWorkspace) openDirectoryName(name string) (*managedRuntimeDirectory, error) {
	if !validManagedRuntimeEntryName(name) {
		return nil, errors.New("managed runtime directory name is invalid")
	}
	return w.openDirectory(filepath.Join(w.agentPath, name))
}

func (w *managedRuntimeWorkspace) directoryNames() ([]string, error) {
	if err := w.verify(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(w.agentPath)
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

func (w *managedRuntimeWorkspace) rename(oldName, newName string) error {
	if err := w.verify(); err != nil {
		return err
	}
	if !validManagedRuntimeEntryName(oldName) || !validManagedRuntimeEntryName(newName) {
		return errors.New("managed runtime entry name is invalid")
	}
	return os.Rename(filepath.Join(w.agentPath, oldName), filepath.Join(w.agentPath, newName))
}

func (w *managedRuntimeWorkspace) remove(name string) error {
	if err := w.verify(); err != nil {
		return err
	}
	if !validManagedRuntimeEntryName(name) {
		return errors.New("managed runtime entry name is invalid")
	}
	path := filepath.Join(w.agentPath, name)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return os.Remove(path)
	}
	return os.RemoveAll(path)
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
		return errors.New("managed runtime directory path identity changed")
	}
	fileInfo, err := d.file.Stat()
	if err != nil || !os.SameFile(pathInfo, fileInfo) {
		return errors.New("managed runtime directory handle identity changed")
	}
	return nil
}

func (d *managedRuntimeDirectory) createFile(relative string, mode os.FileMode) (*os.File, error) {
	path, err := d.safeFilePath(relative)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode.Perm())
}

func (d *managedRuntimeDirectory) openFile(relative string, flags int) (*os.File, error) {
	path, err := d.safeFilePath(relative)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("managed runtime file is unsafe")
	}
	return os.OpenFile(path, flags, 0)
}

func (d *managedRuntimeDirectory) safeFilePath(relative string) (string, error) {
	if err := d.verify(); err != nil {
		return "", err
	}
	relative = filepath.Clean(relative)
	if relative == "." || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("managed runtime file path is unsafe")
	}
	path := filepath.Join(d.path, relative)
	if !pathWithin(path, d.path) {
		return "", errors.New("managed runtime file escapes directory")
	}
	return path, nil
}

func (d *managedRuntimeDirectory) readJSON(name string, target any) error {
	file, err := d.openFile(name, os.O_RDONLY)
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
	if filepath.Base(name) != name || !validManagedRuntimeEntryName(name) {
		return errors.New("managed runtime state file name is invalid")
	}
	if err := d.verify(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temp, err := os.CreateTemp(d.path, ".write-")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := func() { _ = os.Remove(tempPath) }
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		cleanup()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tempPath, filepath.Join(d.path, name)); err != nil {
		cleanup()
		return err
	}
	return nil
}

func validManagedRuntimeEntryName(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name &&
		!strings.ContainsAny(name, `/\\`)
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
