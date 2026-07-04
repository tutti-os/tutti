package agentstatus

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func extractReleaseBinary(archivePath string, binaryName string, destinationPath string) error {
	switch {
	case strings.HasSuffix(archivePath, ".tar.gz"):
		return extractReleaseBinaryFromTarGz(archivePath, binaryName, destinationPath)
	case strings.HasSuffix(archivePath, ".zip"):
		return extractReleaseBinaryFromZip(archivePath, binaryName, destinationPath)
	default:
		return fmt.Errorf("unsupported release archive format: %s", archivePath)
	}
}

func extractReleaseBinaryFromTarGz(archivePath string, binaryName string, destinationPath string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("open release archive: %w", err)
	}
	defer func() {
		_ = file.Close()
	}()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("open gzip release archive: %w", err)
	}
	defer func() {
		_ = gzipReader.Close()
	}()
	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read tar release archive: %w", err)
		}
		if header == nil || header.FileInfo().IsDir() {
			continue
		}
		if filepath.Base(header.Name) != binaryName {
			continue
		}
		return writeReleaseBinary(destinationPath, reader, header.FileInfo().Mode())
	}
	return fmt.Errorf("release archive does not contain %s", binaryName)
}

func extractReleaseBinaryFromZip(archivePath string, binaryName string, destinationPath string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open zip release archive: %w", err)
	}
	defer func() {
		_ = reader.Close()
	}()
	for _, file := range reader.File {
		if file == nil || file.FileInfo().IsDir() {
			continue
		}
		if filepath.Base(file.Name) != binaryName {
			continue
		}
		content, err := file.Open()
		if err != nil {
			return fmt.Errorf("open zipped release binary %s: %w", binaryName, err)
		}
		err = writeReleaseBinary(destinationPath, content, file.Mode())
		closeErr := content.Close()
		return errors.Join(err, closeErr)
	}
	return fmt.Errorf("release archive does not contain %s", binaryName)
}

func writeReleaseBinary(destinationPath string, content io.Reader, mode os.FileMode) error {
	dir := filepath.Dir(destinationPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create release binary parent: %w", err)
	}
	target, err := os.CreateTemp(dir, "."+filepath.Base(destinationPath)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create release binary temp file: %w", err)
	}
	tempPath := target.Name()
	defer func() {
		_ = os.Remove(tempPath)
	}()
	_, copyErr := io.Copy(target, content)
	closeErr := target.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return err
	}
	mode = mode.Perm()
	if mode == 0 {
		mode = 0o755
	}
	if chmodErr := os.Chmod(tempPath, mode); chmodErr != nil {
		return chmodErr
	}
	if err := os.Rename(tempPath, destinationPath); err != nil {
		return fmt.Errorf("install release binary: %w", err)
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open file for sha256: %w", err)
	}
	defer func() {
		_ = file.Close()
	}()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", fmt.Errorf("compute file sha256: %w", err)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func normalizeSHA256(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(strings.ToLower(value), "sha256:")
	return value
}

func archiveSuffix(url string) string {
	switch {
	case strings.HasSuffix(url, ".tar.gz"):
		return ".tar.gz"
	case strings.HasSuffix(url, ".zip"):
		return ".zip"
	default:
		return ""
	}
}
