package agentextension

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	installationRecordName    = "installation.json"
	signedReleaseRecordName   = ".tutti-signed-release.json"
	signedReleaseArtifactName = ".tutti-signed-artifact.zip"
)

func internalPackageRecord(relative string) bool {
	switch filepath.ToSlash(relative) {
	case installationRecordName, signedReleaseRecordName, signedReleaseArtifactName:
		return true
	default:
		return false
	}
}

func packageContentSHA256(root string) (string, error) {
	root = filepath.Clean(root)
	info, err := os.Lstat(root)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", errors.New("extension package root is not an ordinary directory")
	}
	files := make([]string, 0, maxFiles)
	var total int64
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("extension package contains symlink: %s", relative)
		}
		if entry.IsDir() {
			return nil
		}
		if internalPackageRecord(relative) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("extension package contains non-regular file: %s", relative)
		}
		if len(files) >= maxFiles {
			return errors.New("extension package file count exceeds limit")
		}
		total += info.Size()
		if total > maxArtifact {
			return errors.New("extension package exceeds expanded size limit")
		}
		files = append(files, relative)
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(files) == 0 {
		return "", errors.New("extension package is empty")
	}
	sort.Strings(files)
	hash := sha256.New()
	var length [8]byte
	for _, relative := range files {
		canonical := filepath.ToSlash(relative)
		binary.BigEndian.PutUint64(length[:], uint64(len(canonical)))
		_, _ = hash.Write(length[:])
		_, _ = io.WriteString(hash, canonical)
		filePath := filepath.Join(root, relative)
		pathInfo, err := os.Lstat(filePath)
		if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
			return "", fmt.Errorf("extension package file identity is unsafe: %s", relative)
		}
		file, err := os.Open(filePath)
		if err != nil {
			return "", err
		}
		info, err := file.Stat()
		if err != nil || !os.SameFile(pathInfo, info) {
			file.Close()
			return "", fmt.Errorf("extension package file identity changed: %s", relative)
		}
		binary.BigEndian.PutUint64(length[:], uint64(info.Size()))
		_, _ = hash.Write(length[:])
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validPackageContentSHA256(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func packageArchiveContentSHA256(data []byte) (string, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	if len(reader.File) == 0 || len(reader.File) > maxFiles {
		return "", errors.New("agent extension archive file count is invalid")
	}
	files := make(map[string][]byte, len(reader.File))
	var total uint64
	for _, archived := range reader.File {
		name := filepath.Clean(filepath.FromSlash(archived.Name))
		if name == "." || filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return "", errors.New("agent extension archive contains unsafe path")
		}
		if archived.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("agent extension archive contains symlink")
		}
		if archived.FileInfo().IsDir() {
			continue
		}
		if internalPackageRecord(name) || archived.Mode()&0o111 != 0 || !allowedExtension(filepath.Ext(name)) {
			return "", fmt.Errorf("agent extension archive contains forbidden file: %s", name)
		}
		canonical := filepath.ToSlash(name)
		if _, exists := files[canonical]; exists {
			return "", fmt.Errorf("agent extension archive contains duplicate file: %s", canonical)
		}
		total += archived.UncompressedSize64
		if total > maxArtifact {
			return "", errors.New("agent extension archive exceeds expanded size limit")
		}
		source, err := archived.Open()
		if err != nil {
			return "", err
		}
		content, readErr := io.ReadAll(io.LimitReader(source, int64(archived.UncompressedSize64)+1))
		closeErr := source.Close()
		if readErr != nil || closeErr != nil {
			return "", errors.Join(readErr, closeErr)
		}
		if uint64(len(content)) != archived.UncompressedSize64 {
			return "", errors.New("agent extension archive file size changed while reading")
		}
		files[canonical] = content
	}
	if len(files) == 0 {
		return "", errors.New("extension package is empty")
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	hash := sha256.New()
	var length [8]byte
	for _, name := range names {
		binary.BigEndian.PutUint64(length[:], uint64(len(name)))
		_, _ = hash.Write(length[:])
		_, _ = io.WriteString(hash, name)
		content := files[name]
		binary.BigEndian.PutUint64(length[:], uint64(len(content)))
		_, _ = hash.Write(length[:])
		_, _ = hash.Write(content)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
