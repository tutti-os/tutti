//go:build windows

package agentruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

type preparedProcessExecutable struct {
	path       string
	file       *os.File
	privateDir string
}

func prepareProcessExecutable(path string, expected *ExecutableIdentity) (preparedProcessExecutable, error) {
	if expected == nil {
		return preparedProcessExecutable{path: path}, nil
	}
	if !validWindowsExecutableIdentity(expected) {
		return preparedProcessExecutable{}, errors.New("process executable identity is invalid")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return preparedProcessExecutable{}, errors.New("verified process executable is not an ordinary file")
	}
	source, err := os.Open(path)
	if err != nil {
		return preparedProcessExecutable{}, fmt.Errorf("open verified process executable: %w", err)
	}
	defer func() { _ = source.Close() }()
	if err := verifyWindowsExecutable(source, expected); err != nil {
		return preparedProcessExecutable{}, err
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return preparedProcessExecutable{}, fmt.Errorf("rewind verified process executable: %w", err)
	}

	privateDir, err := os.MkdirTemp("", ".tutti-verified-exec-")
	if err != nil {
		return preparedProcessExecutable{}, err
	}
	snapshotPath := filepath.Join(privateDir, "runtime.exe")
	cleanup := func() { _ = os.RemoveAll(privateDir) }
	target, err := os.OpenFile(snapshotPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o500)
	if err != nil {
		cleanup()
		return preparedProcessExecutable{}, err
	}
	_, copyErr := io.Copy(target, source)
	syncErr := target.Sync()
	closeErr := target.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil {
		cleanup()
		return preparedProcessExecutable{}, errors.Join(copyErr, syncErr, closeErr)
	}
	snapshot, err := os.Open(snapshotPath)
	if err != nil {
		cleanup()
		return preparedProcessExecutable{}, err
	}
	verifyErr := verifyWindowsExecutable(snapshot, expected)
	closeErr = snapshot.Close()
	if verifyErr != nil || closeErr != nil {
		cleanup()
		return preparedProcessExecutable{}, errors.Join(verifyErr, closeErr)
	}
	return preparedProcessExecutable{path: snapshotPath, privateDir: privateDir}, nil
}

func prepareReusableNodeInterpreter(
	ctx context.Context,
	runner *VerifiedNodeScriptRunner,
	path string,
	expected *ExecutableIdentity,
) (preparedProcessExecutable, error) {
	if !validWindowsExecutableIdentity(expected) {
		return preparedProcessExecutable{}, errors.New("node interpreter identity is invalid")
	}
	if runner == nil || runner.snapshotRoot == "" {
		return prepareWindowsNodeInterpreterSnapshot(ctx, "", path, expected)
	}
	runner.snapshotMu.Lock()
	defer runner.snapshotMu.Unlock()
	if runner.verifiedSnapshots == nil {
		runner.verifiedSnapshots = map[string]*os.File{}
	}
	snapshotPath := filepath.Join(runner.snapshotRoot, expected.SHA256+".exe")
	if lockedSnapshot := runner.verifiedSnapshots[expected.SHA256]; lockedSnapshot != nil {
		pathInfo, pathErr := os.Lstat(snapshotPath)
		fileInfo, fileErr := lockedSnapshot.Stat()
		if pathErr == nil && fileErr == nil && pathInfo.Mode().IsRegular() && pathInfo.Mode()&os.ModeSymlink == 0 &&
			fileInfo.Mode().IsRegular() && fileInfo.Size() == expected.SizeBytes && os.SameFile(pathInfo, fileInfo) {
			return preparedProcessExecutable{path: snapshotPath}, nil
		}
		_ = lockedSnapshot.Close()
		delete(runner.verifiedSnapshots, expected.SHA256)
	}
	prepared, err := prepareWindowsNodeInterpreterSnapshot(ctx, runner.snapshotRoot, path, expected)
	if err != nil {
		return preparedProcessExecutable{}, err
	}
	lockedSnapshot, err := lockAndVerifyWindowsNodeSnapshot(ctx, prepared.path, expected)
	if err != nil && ctx.Err() == nil {
		if removeErr := os.Remove(prepared.path); removeErr != nil {
			return preparedProcessExecutable{}, errors.Join(err, removeErr)
		}
		prepared, err = createWindowsNodeSnapshot(ctx, runner.snapshotRoot, path, expected)
		if err == nil {
			lockedSnapshot, err = lockAndVerifyWindowsNodeSnapshot(ctx, prepared.path, expected)
		}
	}
	if err != nil {
		return preparedProcessExecutable{}, err
	}
	pathInfo, pathErr := os.Lstat(prepared.path)
	fileInfo, fileErr := lockedSnapshot.Stat()
	if pathErr != nil || fileErr != nil || !pathInfo.Mode().IsRegular() ||
		!fileInfo.Mode().IsRegular() || fileInfo.Size() != expected.SizeBytes || !os.SameFile(pathInfo, fileInfo) {
		_ = lockedSnapshot.Close()
		return preparedProcessExecutable{}, errors.New("verified Node snapshot changed while locking")
	}
	runner.verifiedSnapshots[expected.SHA256] = lockedSnapshot
	return prepared, nil
}

func lockAndVerifyWindowsNodeSnapshot(ctx context.Context, path string, expected *ExecutableIdentity) (*os.File, error) {
	lockedSnapshot, err := openLockedWindowsNodeSnapshot(path)
	if err != nil {
		return nil, err
	}
	if err := verifyWindowsExecutableContext(ctx, lockedSnapshot, expected); err != nil {
		_ = lockedSnapshot.Close()
		return nil, err
	}
	if _, err := lockedSnapshot.Seek(0, io.SeekStart); err != nil {
		_ = lockedSnapshot.Close()
		return nil, err
	}
	return lockedSnapshot, nil
}

func openLockedWindowsNodeSnapshot(path string) (*os.File, error) {
	nativePath, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(
		nativePath,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return nil, fmt.Errorf("lock verified Node snapshot: %w", err)
	}
	return os.NewFile(uintptr(handle), path), nil
}

func prepareWindowsNodeInterpreterSnapshot(
	ctx context.Context,
	snapshotRoot string,
	path string,
	expected *ExecutableIdentity,
) (preparedProcessExecutable, error) {
	if err := ctx.Err(); err != nil {
		return preparedProcessExecutable{}, err
	}
	if !validWindowsExecutableIdentity(expected) {
		return preparedProcessExecutable{}, errors.New("node interpreter identity is invalid")
	}
	if snapshotRoot == "" {
		privateDir, err := os.MkdirTemp("", ".tutti-verified-node-")
		if err != nil {
			return preparedProcessExecutable{}, err
		}
		prepared, err := createWindowsNodeSnapshot(ctx, privateDir, path, expected)
		if err != nil {
			_ = os.RemoveAll(privateDir)
			return preparedProcessExecutable{}, err
		}
		prepared.privateDir = privateDir
		return prepared, nil
	}
	if err := os.MkdirAll(snapshotRoot, 0o700); err != nil {
		return preparedProcessExecutable{}, fmt.Errorf("create verified Node snapshot directory: %w", err)
	}
	rootInfo, err := os.Lstat(snapshotRoot)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return preparedProcessExecutable{}, errors.New("verified Node snapshot directory is invalid")
	}
	snapshotPath := filepath.Join(snapshotRoot, expected.SHA256+".exe")
	if snapshotInfo, statErr := os.Lstat(snapshotPath); statErr == nil {
		if snapshotInfo.Mode().IsRegular() && snapshotInfo.Mode()&os.ModeSymlink == 0 && snapshotInfo.Size() == expected.SizeBytes {
			return preparedProcessExecutable{path: snapshotPath}, nil
		}
		if removeErr := os.Remove(snapshotPath); removeErr != nil {
			return preparedProcessExecutable{}, removeErr
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return preparedProcessExecutable{}, statErr
	}
	return createWindowsNodeSnapshot(ctx, snapshotRoot, path, expected)
}

func createWindowsNodeSnapshot(
	ctx context.Context,
	snapshotRoot string,
	path string,
	expected *ExecutableIdentity,
) (preparedProcessExecutable, error) {
	pathInfo, err := os.Lstat(path)
	if err != nil || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return preparedProcessExecutable{}, errors.New("verified Node interpreter is not an ordinary file")
	}
	source, err := os.Open(path)
	if err != nil {
		return preparedProcessExecutable{}, fmt.Errorf("open verified Node interpreter: %w", err)
	}
	defer func() { _ = source.Close() }()
	sourceInfo, err := source.Stat()
	if err != nil || !sourceInfo.Mode().IsRegular() || !os.SameFile(pathInfo, sourceInfo) {
		return preparedProcessExecutable{}, errors.New("verified Node interpreter changed while opening")
	}
	target, err := os.CreateTemp(snapshotRoot, ".node-snapshot-")
	if err != nil {
		return preparedProcessExecutable{}, err
	}
	tempPath := target.Name()
	defer os.Remove(tempPath)
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(target, hash), &contextReader{ctx: ctx, reader: source})
	identityMatches := size == expected.SizeBytes && hex.EncodeToString(hash.Sum(nil)) == expected.SHA256
	if copyErr != nil {
		return preparedProcessExecutable{}, errors.Join(copyErr, target.Close())
	}
	syncErr := target.Sync()
	closeErr := target.Close()
	if syncErr != nil || closeErr != nil {
		return preparedProcessExecutable{}, errors.Join(syncErr, closeErr)
	}
	if !identityMatches {
		return preparedProcessExecutable{}, errors.New("node interpreter does not match expected identity")
	}
	if err := os.Chmod(tempPath, 0o500); err != nil {
		return preparedProcessExecutable{}, err
	}
	snapshotPath := filepath.Join(snapshotRoot, expected.SHA256+".exe")
	if err := os.Rename(tempPath, snapshotPath); err != nil {
		return preparedProcessExecutable{}, err
	}
	return preparedProcessExecutable{path: snapshotPath}, nil
}

func verifyWindowsExecutable(file *os.File, expected *ExecutableIdentity) error {
	return verifyWindowsExecutableContext(context.Background(), file, expected)
}

func verifyWindowsExecutableContext(ctx context.Context, file *os.File, expected *ExecutableIdentity) error {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("verified process executable is not an ordinary file")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, &contextReader{ctx: ctx, reader: file})
	if err != nil {
		return fmt.Errorf("fingerprint process executable: %w", err)
	}
	if size != expected.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return errors.New("process executable does not match expected identity")
	}
	return nil
}

func validWindowsExecutableIdentity(identity *ExecutableIdentity) bool {
	if identity == nil || identity.SizeBytes <= 0 || len(identity.SHA256) != sha256.Size*2 || identity.SHA256 != strings.ToLower(identity.SHA256) {
		return false
	}
	_, err := hex.DecodeString(identity.SHA256)
	return err == nil
}

func (p *preparedProcessExecutable) Close() error {
	if p == nil {
		return nil
	}
	var err error
	if p.file != nil {
		err = p.file.Close()
		p.file = nil
	}
	if p.privateDir == "" {
		return err
	}
	err = errors.Join(err, os.RemoveAll(p.privateDir))
	p.privateDir = ""
	return err
}
