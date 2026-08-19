package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"runtime"
)

var ErrManagedRuntimeIntegrity = errors.New("managed runtime integrity check failed")

type runtimeExecutableFingerprint struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func fingerprintRuntimeExecutable(path string) (runtimeExecutableFingerprint, error) {
	return fingerprintRuntimeExecutableContext(context.Background(), path)
}

func fingerprintRuntimeExecutableContext(ctx context.Context, path string) (runtimeExecutableFingerprint, error) {
	if err := ctx.Err(); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	defer file.Close()
	return fingerprintRuntimeExecutableFileContext(ctx, file)
}

func fingerprintRuntimeExecutableFile(file *os.File) (runtimeExecutableFingerprint, error) {
	return fingerprintRuntimeExecutableFileContext(context.Background(), file)
}

func fingerprintRuntimeExecutableFileContext(ctx context.Context, file *os.File) (runtimeExecutableFingerprint, error) {
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
	if !isExecutableFileInfo(info) {
		return runtimeExecutableFingerprint{}, errors.New("runtime executable is not an executable regular file")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, &contextCheckingReader{ctx: ctx, reader: file}); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	_, _ = file.Seek(0, io.SeekStart)
	return runtimeExecutableFingerprint{SHA256: hex.EncodeToString(hash.Sum(nil)), Size: info.Size()}, nil
}

type contextCheckingReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextCheckingReader) Read(value []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	count, err := reader.reader.Read(value)
	if err == nil {
		if contextErr := reader.ctx.Err(); contextErr != nil {
			return count, contextErr
		}
	}
	return count, err
}

// Windows does not expose Unix executable permission bits for ordinary PE
// files. Native Windows runtime validation is performed by the PE/platform
// checks; Unix runtimes still require a real executable permission bit.
func isExecutableFileInfo(info os.FileInfo) bool {
	if info == nil || !info.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode()&0o111 != 0
}
