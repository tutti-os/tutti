//go:build darwin

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

	"golang.org/x/sys/unix"
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
	if !validExecutableIdentity(expected) {
		return preparedProcessExecutable{}, errors.New("process executable identity is invalid")
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return preparedProcessExecutable{}, fmt.Errorf("open verified process executable: %w", err)
	}
	source := os.NewFile(uintptr(fd), "verified-process-executable")
	defer func() { _ = source.Close() }()
	if err := verifyExecutableDescriptor(source, expected); err != nil {
		return preparedProcessExecutable{}, err
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return preparedProcessExecutable{}, err
	}
	tempRoot, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return preparedProcessExecutable{}, err
	}
	privateDir, err := os.MkdirTemp(tempRoot, ".tutti-verified-exec-")
	if err != nil {
		return preparedProcessExecutable{}, err
	}
	snapshotPath := filepath.Join(privateDir, "runtime")
	cleanup := func() {
		_ = unix.Chflags(snapshotPath, 0)
		_ = unix.Chflags(privateDir, 0)
		_ = os.Chmod(privateDir, 0o700)
		_ = os.RemoveAll(privateDir)
	}
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
	if err := os.Chmod(snapshotPath, 0o500); err != nil {
		cleanup()
		return preparedProcessExecutable{}, err
	}
	if err := unix.Chflags(snapshotPath, unix.UF_IMMUTABLE); err != nil {
		cleanup()
		return preparedProcessExecutable{}, err
	}
	if err := os.Chmod(privateDir, 0o500); err != nil {
		cleanup()
		return preparedProcessExecutable{}, err
	}
	if err := unix.Chflags(privateDir, unix.UF_IMMUTABLE); err != nil {
		cleanup()
		return preparedProcessExecutable{}, err
	}
	snapshotFD, err := unix.Open(snapshotPath, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		cleanup()
		return preparedProcessExecutable{}, err
	}
	snapshot := os.NewFile(uintptr(snapshotFD), "verified-process-snapshot")
	if err := verifyExecutableDescriptor(snapshot, expected); err != nil {
		_ = snapshot.Close()
		cleanup()
		return preparedProcessExecutable{}, err
	}
	if err := snapshot.Close(); err != nil {
		cleanup()
		return preparedProcessExecutable{}, err
	}
	return preparedProcessExecutable{path: snapshotPath, privateDir: privateDir}, nil
}

// Node distributions on macOS may resolve dynamic libraries relative to their
// installed path, so relocating the executable can make a valid interpreter
// unloadable. Keep a verified no-follow descriptor open across process start
// and execute the fixed host-owned path.
func prepareReusableNodeInterpreter(
	ctx context.Context,
	_ *VerifiedNodeScriptRunner,
	path string,
	expected *ExecutableIdentity,
) (preparedProcessExecutable, error) {
	return prepareDarwinNodeInterpreter(ctx, path, expected)
}

func prepareDarwinNodeInterpreter(ctx context.Context, path string, expected *ExecutableIdentity) (preparedProcessExecutable, error) {
	if err := ctx.Err(); err != nil {
		return preparedProcessExecutable{}, err
	}
	if !validExecutableIdentity(expected) {
		return preparedProcessExecutable{}, errors.New("node interpreter identity is invalid")
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return preparedProcessExecutable{}, fmt.Errorf("open verified Node interpreter: %w", err)
	}
	file := os.NewFile(uintptr(fd), "verified-node-interpreter")
	if err := verifyExecutableDescriptorContext(ctx, file, expected); err != nil {
		_ = file.Close()
		return preparedProcessExecutable{}, err
	}
	return preparedProcessExecutable{path: path, file: file}, nil
}

func verifyExecutableDescriptorContext(ctx context.Context, file *os.File, expected *ExecutableIdentity) error {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return errors.New("verified process executable is not an executable ordinary file")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, &contextReader{ctx: ctx, reader: file})
	if err != nil {
		return fmt.Errorf("fingerprint process executable descriptor: %w", err)
	}
	if size != expected.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return errors.New("process executable does not match expected identity")
	}
	return nil
}

func verifyExecutableDescriptor(file *os.File, expected *ExecutableIdentity) error {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return errors.New("verified process executable is not an executable ordinary file")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return fmt.Errorf("fingerprint process executable descriptor: %w", err)
	}
	if size != expected.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return errors.New("process executable does not match expected identity")
	}
	return nil
}

func validExecutableIdentity(identity *ExecutableIdentity) bool {
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
	var result error
	if p.file != nil {
		result = p.file.Close()
		p.file = nil
	}
	if p.privateDir != "" {
		_ = unix.Chflags(p.path, 0)
		_ = unix.Chflags(p.privateDir, 0)
		if err := os.Chmod(p.privateDir, 0o700); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, err)
		}
		if err := os.RemoveAll(p.privateDir); err != nil {
			result = errors.Join(result, err)
		}
		p.privateDir = ""
	}
	return result
}
