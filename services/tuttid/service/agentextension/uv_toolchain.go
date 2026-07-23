package agentextension

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

// UVToolchainResolver returns the directory containing the Tutti-managed uv
// executable for the current platform, downloading and verifying it on first
// use. It is a test seam on SetupService, mirroring the Runner field.
type UVToolchainResolver func(ctx context.Context, client *http.Client, runtimeInstallDir string) (uvDir string, err error)

const (
	uvToolchainRootName     = "_tools"
	uvToolchainKindName     = "uv"
	uvToolchainCacheName    = "cache"
	uvToolchainVerifiedName = ".verified"
)

// uvToolchainProvenanceURL documents where the managed uv archives come from;
// it satisfies the binary-artifact provenance contract reused for downloads.
const uvToolchainProvenanceURL = "https://github.com/astral-sh/uv/releases"

type uvToolchainVerifiedMarker struct {
	ArchiveSHA256 string `json:"archiveSha256"`
	ArchiveSize   int64  `json:"archiveSize"`
}

func uvExecutableName() string {
	if runtime.GOOS == "windows" {
		return "uv.exe"
	}
	return "uv"
}

func uvToolchainDirs(runtimeInstallDir string, artifact tuttitypes.UVToolArtifact) (toolDir string, uvPath string) {
	toolDir = filepath.Join(runtimeInstallDir, uvToolchainRootName, uvToolchainKindName, artifact.Platform, artifact.Version)
	return toolDir, filepath.Join(toolDir, uvExecutableName())
}

func uvToolchainCacheDir(runtimeInstallDir string) string {
	return filepath.Join(runtimeInstallDir, uvToolchainRootName, uvToolchainKindName, uvToolchainCacheName)
}

func resolveManagedUVToolchain(ctx context.Context, client *http.Client, runtimeInstallDir string) (string, error) {
	artifact, ok := tuttitypes.ResolveUVToolArtifact(runtimePlatform())
	if !ok {
		return "", fmt.Errorf("managed uv toolchain is unavailable for platform %s", runtimePlatform())
	}
	return ensureManagedUVToolchain(ctx, client, runtimeInstallDir, artifact)
}

func ensureManagedUVToolchain(ctx context.Context, client *http.Client, runtimeInstallDir string, artifact tuttitypes.UVToolArtifact) (string, error) {
	runtimeInstallDir = strings.TrimSpace(runtimeInstallDir)
	if runtimeInstallDir == "" || !filepath.IsAbs(runtimeInstallDir) {
		return "", errors.New("managed uv toolchain install directory is invalid")
	}
	if err := rejectManagedRuntimeSymlinkAncestors(runtimeInstallDir); err != nil {
		return "", fmt.Errorf("managed uv toolchain root is unsafe: %w", err)
	}
	toolDir, uvPath := uvToolchainDirs(runtimeInstallDir, artifact)
	if verifiedManagedUV(uvPath, toolDir, artifact) {
		return toolDir, nil
	}
	if err := os.MkdirAll(toolDir, 0o700); err != nil {
		return "", err
	}
	archivePath, err := downloadUVToolchainArchive(ctx, client, artifact, toolDir)
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(archivePath) }()
	if err := extractUVToolchainExecutable(archivePath, artifact, uvPath); err != nil {
		return "", err
	}
	marker, err := json.Marshal(uvToolchainVerifiedMarker{ArchiveSHA256: artifact.SHA256, ArchiveSize: artifact.SizeBytes})
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(toolDir, uvToolchainVerifiedName), marker, 0o600); err != nil {
		return "", err
	}
	return toolDir, nil
}

// verifiedManagedUV reports whether a previously extracted uv executable is
// usable. The archive checksum authenticated the bytes at extraction time;
// the marker ties the on-disk executable to that verified extraction.
func verifiedManagedUV(uvPath, toolDir string, artifact tuttitypes.UVToolArtifact) bool {
	info, err := os.Lstat(uvPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 {
		return false
	}
	markerBytes, err := os.ReadFile(filepath.Join(toolDir, uvToolchainVerifiedName))
	if err != nil {
		return false
	}
	var marker uvToolchainVerifiedMarker
	if err := json.Unmarshal(markerBytes, &marker); err != nil {
		return false
	}
	return marker.ArchiveSHA256 == artifact.SHA256 && marker.ArchiveSize == artifact.SizeBytes
}

func downloadUVToolchainArchive(ctx context.Context, client *http.Client, artifact tuttitypes.UVToolArtifact, toolDir string) (string, error) {
	file, err := os.CreateTemp(toolDir, ".uv-download-*")
	if err != nil {
		return "", err
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(file.Name())
		}
	}()
	binaryArtifact := agentextensionbiz.RuntimeBinaryArtifact{
		Kind:      "executable",
		Platform:  artifact.Platform,
		Version:   artifact.Version,
		URL:       artifact.URL,
		SHA256:    artifact.SHA256,
		SizeBytes: artifact.SizeBytes,
	}
	binaryArtifact.Provenance.Kind = "official-release"
	binaryArtifact.Provenance.URL = uvToolchainProvenanceURL
	if _, err := downloadRuntimeBinaryToFile(ctx, client, binaryArtifact, file); err != nil {
		return "", fmt.Errorf("download managed uv toolchain: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	keep = true
	return file.Name(), nil
}

func extractUVToolchainExecutable(archivePath string, artifact tuttitypes.UVToolArtifact, uvPath string) error {
	temp, err := os.CreateTemp(filepath.Dir(uvPath), ".uv-extract-*")
	if err != nil {
		return err
	}
	keep := false
	defer func() {
		_ = temp.Close()
		if !keep {
			_ = os.Remove(temp.Name())
		}
	}()
	switch artifact.Archive {
	case "tar.gz":
		err = extractUVFromTarGz(archivePath, artifact.ArchiveExecutable, temp)
	case "zip":
		err = extractUVFromZip(archivePath, artifact.ArchiveExecutable, temp)
	default:
		err = fmt.Errorf("managed uv toolchain archive kind %q is unsupported", artifact.Archive)
	}
	if err != nil {
		return err
	}
	if err := temp.Chmod(0o700); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	// The pinned version guarantees identical bytes, so a concurrent winner is
	// indistinguishable; remove-then-rename keeps Windows happy.
	_ = os.Remove(uvPath)
	if err := os.Rename(temp.Name(), uvPath); err != nil {
		return err
	}
	keep = true
	return nil
}

func cleanArchiveMemberName(name string) (string, bool) {
	cleaned := filepath.ToSlash(filepath.Clean(filepath.FromSlash(name)))
	if cleaned == "." || strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return "", false
	}
	return cleaned, true
}

func extractUVFromTarGz(archivePath, executable string, destination *os.File) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	found := false
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name, ok := cleanArchiveMemberName(header.Name)
		if !ok {
			return fmt.Errorf("managed uv toolchain archive contains unsafe path %q", header.Name)
		}
		if name != executable {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.FileInfo().Mode()&0o111 == 0 {
			return errors.New("managed uv toolchain archive executable is not an executable regular file")
		}
		if found {
			return errors.New("managed uv toolchain archive names the executable more than once")
		}
		found = true
		if _, err := io.Copy(destination, io.LimitReader(reader, header.Size+1)); err != nil {
			return err
		}
	}
	if !found {
		return fmt.Errorf("managed uv toolchain archive does not contain %q", executable)
	}
	return nil
}

func extractUVFromZip(archivePath, executable string, destination *os.File) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	found := false
	for _, member := range reader.File {
		name, ok := cleanArchiveMemberName(member.Name)
		if !ok {
			return fmt.Errorf("managed uv toolchain archive contains unsafe path %q", member.Name)
		}
		if name != executable {
			continue
		}
		if member.FileInfo().IsDir() || !member.FileInfo().Mode().IsRegular() || member.Mode()&os.ModeSymlink != 0 {
			return errors.New("managed uv toolchain archive executable is not a regular file")
		}
		if found {
			return errors.New("managed uv toolchain archive names the executable more than once")
		}
		found = true
		source, err := member.Open()
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(destination, io.LimitReader(source, int64(member.UncompressedSize64)+1))
		closeErr := source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if !found {
		return fmt.Errorf("managed uv toolchain archive does not contain %q", executable)
	}
	return nil
}
