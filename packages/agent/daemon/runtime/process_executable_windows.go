//go:build windows

package agentruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
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

func verifyWindowsExecutable(file *os.File, expected *ExecutableIdentity) error {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("verified process executable is not an ordinary file")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
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
