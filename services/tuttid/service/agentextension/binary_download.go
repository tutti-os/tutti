package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
)

func downloadRuntimeBinary(
	ctx context.Context,
	client *http.Client,
	artifact RuntimeBinaryArtifact,
	destination string,
) (runtimeExecutableFingerprint, error) {
	if err := validateRuntimeBinaryArtifacts([]RuntimeBinaryArtifact{artifact}); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(destination)
		}
	}()

	fingerprint, err := downloadRuntimeBinaryToFile(ctx, client, artifact, file)
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if err := file.Close(); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if err := verifyRuntimeExecutableUnchanged(destination, fingerprint); err != nil {
		return runtimeExecutableFingerprint{}, errors.New("runtime binary changed after download verification")
	}
	keep = true
	return fingerprint, nil
}

func downloadRuntimeBinaryToFile(
	ctx context.Context,
	client *http.Client,
	artifact RuntimeBinaryArtifact,
	file *os.File,
) (runtimeExecutableFingerprint, error) {
	if err := validateRuntimeBinaryArtifacts([]RuntimeBinaryArtifact{artifact}); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if file == nil {
		return runtimeExecutableFingerprint{}, errors.New("runtime binary destination descriptor is required")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	request.Header.Set("Accept-Encoding", "identity")
	if client == nil {
		client = httpx.NewClient(15 * time.Minute)
	}
	client = httpsOnlyRedirectClient(client, errors.New("runtime binary download redirected away from HTTPS"))
	response, err := client.Do(request)
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	defer response.Body.Close()
	if response.Request == nil || response.Request.URL == nil || response.Request.URL.Scheme != "https" {
		return runtimeExecutableFingerprint{}, errors.New("runtime binary download redirected away from HTTPS")
	}
	if response.StatusCode != http.StatusOK {
		return runtimeExecutableFingerprint{}, fmt.Errorf("runtime binary download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength >= 0 && response.ContentLength != artifact.SizeBytes {
		return runtimeExecutableFingerprint{}, errors.New("runtime binary Content-Length does not match signed metadata")
	}

	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, artifact.SizeBytes+1))
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if written != artifact.SizeBytes {
		return runtimeExecutableFingerprint{}, errors.New("runtime binary size does not match signed metadata")
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if digest != artifact.SHA256 {
		return runtimeExecutableFingerprint{}, errors.New("runtime binary SHA-256 does not match signed metadata")
	}
	if err := file.Sync(); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if err := file.Chmod(0o700); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	if err := file.Sync(); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	expected := runtimeExecutableFingerprint{SHA256: artifact.SHA256, Size: artifact.SizeBytes}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != artifact.SizeBytes || info.Mode()&0o111 == 0 {
		return runtimeExecutableFingerprint{}, errors.New("runtime binary changed after download verification")
	}
	return expected, nil
}

func verifyRuntimeExecutableUnchanged(path string, expected runtimeExecutableFingerprint) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 {
		return errors.New("runtime executable is not an ordinary executable file")
	}
	actual, err := fingerprintRuntimeExecutable(path)
	if err != nil {
		return err
	}
	if actual != expected || actual.SHA256 == "" {
		return errors.New("runtime executable changed across verification boundary")
	}
	return nil
}
