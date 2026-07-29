//go:build linux

package agentruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

type preparedProcessExecutable struct {
	path string
	file *os.File
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
	file := os.NewFile(uintptr(fd), "verified-process-executable")
	closeWithError := func(err error) (preparedProcessExecutable, error) {
		_ = file.Close()
		return preparedProcessExecutable{}, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return closeWithError(errors.New("verified process executable is not an executable ordinary file"))
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return closeWithError(fmt.Errorf("fingerprint process executable descriptor: %w", err))
	}
	if size != expected.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return closeWithError(errors.New("process executable does not match expected identity"))
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return closeWithError(fmt.Errorf("rewind process executable descriptor: %w", err))
	}
	return preparedProcessExecutable{path: "/proc/self/fd/3", file: file}, nil
}

func validExecutableIdentity(identity *ExecutableIdentity) bool {
	if identity == nil || identity.SizeBytes <= 0 || len(identity.SHA256) != sha256.Size*2 || identity.SHA256 != strings.ToLower(identity.SHA256) {
		return false
	}
	_, err := hex.DecodeString(identity.SHA256)
	return err == nil
}

func (p *preparedProcessExecutable) Close() error {
	if p == nil || p.file == nil {
		return nil
	}
	err := p.file.Close()
	p.file = nil
	return err
}
