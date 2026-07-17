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
	info, err := file.Stat()
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if !info.Mode().IsRegular() {
		return runtimeExecutableFingerprint{}, errors.New("runtime executable is not a regular file")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	return runtimeExecutableFingerprint{SHA256: hex.EncodeToString(hash.Sum(nil)), Size: info.Size()}, nil
}
