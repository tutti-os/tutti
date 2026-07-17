package agentextension

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const localPackageVersionMarker = "+local."

func (m *Manager) installLocalPackage(key, sourceDir string) (Installation, error) {
	if m.Installations == nil {
		return Installation{}, errors.New("agent extension installation store is not configured")
	}
	sourceDir, err := filepath.Abs(strings.TrimSpace(sourceDir))
	if err != nil {
		return Installation{}, fmt.Errorf("resolve local extension package: %w", err)
	}
	info, err := os.Lstat(sourceDir)
	if err != nil {
		return Installation{}, fmt.Errorf("stat local extension package: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return Installation{}, errors.New("local extension package must be a directory")
	}

	root, err := m.Installations.AgentDir(key)
	if err != nil {
		return Installation{}, err
	}
	if pathWithin(root, sourceDir) {
		return Installation{}, errors.New("local extension package cannot contain daemon extension state")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return Installation{}, err
	}
	staging, err := os.MkdirTemp(root, ".local-")
	if err != nil {
		return Installation{}, err
	}
	defer os.RemoveAll(staging)
	digest, err := copyLocalPackage(sourceDir, staging)
	if err != nil {
		return Installation{}, err
	}

	var manifest Manifest
	manifestPath := filepath.Join(staging, "tutti.agent.json")
	if err := readJSON(manifestPath, &manifest); err != nil {
		return Installation{}, fmt.Errorf("read local extension manifest: %w", err)
	}
	if manifest.AgentKey != key || !validSemver(manifest.Version) {
		return Installation{}, errors.New("local extension manifest identity is invalid")
	}
	localVersion := localPackageVersion(manifest.Version, digest)
	manifest.Version = localVersion
	if err := writeJSONAtomic(manifestPath, manifest); err != nil {
		return Installation{}, fmt.Errorf("stamp local extension snapshot version: %w", err)
	}
	manifest, err = validateInstalledPackage(staging, key, localVersion)
	if err != nil {
		return Installation{}, fmt.Errorf("validate local extension package: %w", err)
	}
	if installed, err := m.loadActive(key); err == nil && installed.Version == localVersion {
		return installed, nil
	}

	finalDir, err := m.Installations.PackageDir(key, localVersion)
	if err != nil {
		return Installation{}, err
	}
	if _, err := os.Stat(finalDir); errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(staging, finalDir); err != nil {
			return Installation{}, err
		}
	} else if err != nil {
		return Installation{}, err
	} else if _, err := validateInstalledPackage(finalDir, key, localVersion); err != nil {
		return Installation{}, fmt.Errorf("validate existing local extension snapshot: %w", err)
	}

	installation := Installation{
		SchemaVersion: "tutti.agent.installation.v1",
		ID:            key + "@" + localVersion,
		AgentKey:      key,
		Version:       localVersion,
		Provider:      "acp:" + key,
		PackageDir:    finalDir,
		Manifest:      manifest,
		InstalledAt:   time.Now().UTC(),
	}
	locales := map[string]string{}
	if err := readJSON(filepath.Join(finalDir, filepath.FromSlash(manifest.LocalizationInfo.DefaultFile)), &locales); err != nil {
		return Installation{}, fmt.Errorf("read local extension default locale: %w", err)
	}
	installation.DisplayName = strings.TrimSpace(locales["agent.name"])
	if installation.DisplayName == "" {
		installation.DisplayName = manifest.Name
	}
	installation.AuthMessage = strings.TrimSpace(locales["runtime.authRequired"])
	if err := m.Installations.PutActive(installation); err != nil {
		return Installation{}, err
	}
	return installation, nil
}

func copyLocalPackage(sourceDir, destination string) (string, error) {
	files := make([]string, 0, maxFiles)
	entryCount := 0
	var total int64
	err := filepath.WalkDir(sourceDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == sourceDir {
			return nil
		}
		entryCount++
		if entryCount > maxFiles {
			return errors.New("local extension package file count exceeds limit")
		}
		relative, err := filepath.Rel(sourceDir, path)
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("local extension package contains symlink: %s", relative)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode()&0o111 != 0 {
			return fmt.Errorf("local extension package contains forbidden file: %s", relative)
		}
		if !allowedExtension(filepath.Ext(relative)) {
			return fmt.Errorf("local extension package contains forbidden file type: %s", relative)
		}
		total += info.Size()
		if total > maxArtifact {
			return errors.New("local extension package exceeds size limit")
		}
		files = append(files, relative)
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(files) == 0 {
		return "", errors.New("local extension package is empty")
	}
	sort.Strings(files)
	hash := sha256.New()
	for _, relative := range files {
		sourcePath := filepath.Join(sourceDir, relative)
		data, err := os.ReadFile(sourcePath)
		if err != nil {
			return "", err
		}
		_, _ = io.WriteString(hash, filepath.ToSlash(relative))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write(data)
		_, _ = hash.Write([]byte{0})
		targetPath := filepath.Join(destination, relative)
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
			return "", err
		}
		if err := os.WriteFile(targetPath, data, 0o600); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func localPackageVersion(version, digest string) string {
	base, _, _ := strings.Cut(version, "+")
	return base + localPackageVersionMarker + digest[:12]
}
