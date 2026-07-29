package agentextension

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
)

var ErrManagedRuntimeIntegrity = errors.New("managed runtime integrity check failed")

type runtimeExecutableFingerprint struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func fingerprintRuntimeExecutable(path string) (runtimeExecutableFingerprint, error) {
	file, err := os.Open(path)
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	defer file.Close()
	return fingerprintRuntimeExecutableFile(file)
}

func fingerprintRuntimeExecutableFile(file *os.File) (runtimeExecutableFingerprint, error) {
	if file == nil {
		return runtimeExecutableFingerprint{}, errors.New("runtime executable descriptor is required")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	info, err := file.Stat()
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return runtimeExecutableFingerprint{}, errors.New("runtime executable is not an executable regular file")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	_, _ = file.Seek(0, io.SeekStart)
	return runtimeExecutableFingerprint{SHA256: hex.EncodeToString(hash.Sum(nil)), Size: info.Size()}, nil
}
