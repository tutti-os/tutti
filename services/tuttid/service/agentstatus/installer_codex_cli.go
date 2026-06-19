package agentstatus

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const defaultCodexCLILatestBaseURL = "https://github.com/openai/codex/releases/latest/download"

func (s Service) runCodexCLILatestInstaller(
	ctx context.Context,
	spec InstallerSpec,
	installDir string,
) (InstallCommandResult, error) {
	if spec.CodexCLI == nil {
		return InstallCommandResult{ExitCode: 1, Stderr: "codex CLI latest installer config is required"}, nil
	}
	if strings.TrimSpace(installDir) == "" {
		return InstallCommandResult{ExitCode: 1, Stderr: "install directory is required"}, nil
	}
	if err := ensureWritableInstallDir(installDir); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	target, ok := codexCLIPackageTarget(runtime.GOOS, runtime.GOARCH)
	if !ok {
		return InstallCommandResult{
			ExitCode: 1,
			Stderr:   fmt.Sprintf("codex CLI latest installer asset is unavailable for %s", releaseBinaryPlatformKey(runtime.GOOS, runtime.GOARCH)),
		}, nil
	}
	baseURL := strings.TrimRight(firstNonBlank(spec.CodexCLI.BaseURL, defaultCodexCLILatestBaseURL), "/")
	archiveName := "codex-package-" + target + ".tar.gz"
	archiveURL := baseURL + "/" + archiveName
	checksumURL := baseURL + "/codex-package_SHA256SUMS"
	slog.Info(
		"agent provider codex CLI latest install asset selected",
		"target", target,
		"installDir", installDir,
		"archiveURL", archiveURL,
		"checksumURL", checksumURL,
	)

	archiveFile, err := os.CreateTemp("", "tutti-codex-cli-package-*.tar.gz")
	if err != nil {
		return InstallCommandResult{ExitCode: 1}, err
	}
	archivePath := archiveFile.Name()
	defer func() {
		_ = os.Remove(archivePath)
	}()
	if err := archiveFile.Close(); err != nil {
		return InstallCommandResult{ExitCode: 1}, err
	}
	if err := s.downloadFile(ctx, archiveURL, archivePath); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}

	checksumFile, err := os.CreateTemp("", "tutti-codex-cli-SHA256SUMS-*")
	if err != nil {
		return InstallCommandResult{ExitCode: 1}, err
	}
	checksumPath := checksumFile.Name()
	defer func() {
		_ = os.Remove(checksumPath)
	}()
	if err := checksumFile.Close(); err != nil {
		return InstallCommandResult{ExitCode: 1}, err
	}
	if err := s.downloadFile(ctx, checksumURL, checksumPath); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	expected, err := codexPackageChecksum(checksumPath, archiveName)
	if err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	actualSHA256, err := fileSHA256(archivePath)
	if err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	if !strings.EqualFold(actualSHA256, expected) {
		return InstallCommandResult{ExitCode: 1, Stderr: fmt.Sprintf("downloaded Codex CLI package sha256 mismatch: want %s got %s", expected, actualSHA256)}, nil
	}

	standaloneRoot, err := s.codexStandaloneRoot()
	if err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	releaseDir := filepath.Join(standaloneRoot, "releases", "latest-"+target)
	if err := installCodexCLIPackageArchive(archivePath, releaseDir); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	currentLink := filepath.Join(standaloneRoot, "current")
	if err := replaceSymlink(currentLink, releaseDir); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	visiblePath := filepath.Join(installDir, "codex")
	if err := replaceSymlink(visiblePath, filepath.Join(currentLink, "bin", "codex")); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	return InstallCommandResult{
		ExitCode: 0,
		Stdout: fmt.Sprintf(
			"Installed Codex CLI latest %s to %s",
			target,
			visiblePath,
		),
	}, nil
}

func codexCLIPackageTarget(goos string, goarch string) (string, bool) {
	switch releaseBinaryPlatformKey(goos, goarch) {
	case releaseBinaryPlatformKey("darwin", "arm64"):
		return "aarch64-apple-darwin", true
	case releaseBinaryPlatformKey("darwin", "amd64"):
		return "x86_64-apple-darwin", true
	case releaseBinaryPlatformKey("linux", "arm64"):
		return "aarch64-unknown-linux-musl", true
	case releaseBinaryPlatformKey("linux", "amd64"):
		return "x86_64-unknown-linux-musl", true
	default:
		return "", false
	}
}

func codexPackageChecksum(checksumPath string, archiveName string) (string, error) {
	content, err := os.ReadFile(checksumPath)
	if err != nil {
		return "", fmt.Errorf("read codex CLI checksums: %w", err)
	}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		checksumName := strings.TrimPrefix(fields[1], "*")
		if checksumName == archiveName {
			checksum := normalizeSHA256(fields[0])
			if len(checksum) != 64 {
				return "", fmt.Errorf("codex CLI checksum for %s is invalid", archiveName)
			}
			return checksum, nil
		}
	}
	return "", fmt.Errorf("codex CLI checksums do not contain %s", archiveName)
}

func installCodexCLIPackageArchive(archivePath string, releaseDir string) error {
	parent := filepath.Dir(releaseDir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create codex CLI releases parent: %w", err)
	}
	stageDir, err := os.MkdirTemp(parent, ".staging."+filepath.Base(releaseDir)+".")
	if err != nil {
		return fmt.Errorf("create codex CLI staging dir: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(stageDir)
	}()
	if err := extractTarGzArchive(archivePath, stageDir); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Join(stageDir, "bin", "codex"), 0o755); err != nil {
		return fmt.Errorf("chmod codex CLI binary: %w", err)
	}
	if err := os.Chmod(filepath.Join(stageDir, "codex-path", "rg"), 0o755); err != nil {
		return fmt.Errorf("chmod codex CLI rg binary: %w", err)
	}
	if err := replaceSymlink(filepath.Join(stageDir, "codex"), "bin/codex"); err != nil {
		return err
	}
	if err := os.RemoveAll(releaseDir); err != nil {
		return fmt.Errorf("remove existing codex CLI release: %w", err)
	}
	if err := os.Rename(stageDir, releaseDir); err != nil {
		return fmt.Errorf("install codex CLI release: %w", err)
	}
	return nil
}

func extractTarGzArchive(archivePath string, destinationDir string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("open tar.gz archive: %w", err)
	}
	defer func() {
		_ = file.Close()
	}()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("open gzip archive: %w", err)
	}
	defer func() {
		_ = gzipReader.Close()
	}()
	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read tar.gz archive: %w", err)
		}
		if header == nil {
			continue
		}
		name := filepath.Clean(header.Name)
		if name == "." || filepath.IsAbs(name) || strings.HasPrefix(name, ".."+string(filepath.Separator)) || name == ".." {
			return fmt.Errorf("tar.gz archive contains unsafe path %s", header.Name)
		}
		targetPath := filepath.Join(destinationDir, name)
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetPath, header.FileInfo().Mode().Perm()); err != nil {
				return fmt.Errorf("create archive directory: %w", err)
			}
		case tar.TypeReg:
			if err := writeArchiveFile(targetPath, reader, header.FileInfo().Mode()); err != nil {
				return err
			}
		}
	}
}

func writeArchiveFile(destinationPath string, content io.Reader, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return fmt.Errorf("create archive file parent: %w", err)
	}
	perm := mode.Perm()
	if perm == 0 {
		perm = 0o644
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("create archive file destination: %w", err)
	}
	_, copyErr := io.Copy(target, content)
	closeErr := target.Close()
	return errors.Join(copyErr, closeErr)
}

func replaceSymlink(linkPath string, targetPath string) error {
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
		return fmt.Errorf("create symlink parent: %w", err)
	}
	tmpLink := filepath.Join(filepath.Dir(linkPath), "."+filepath.Base(linkPath)+".tmp")
	if err := os.RemoveAll(tmpLink); err != nil {
		return fmt.Errorf("remove stale symlink temp path: %w", err)
	}
	if err := os.Symlink(targetPath, tmpLink); err != nil {
		return fmt.Errorf("create symlink: %w", err)
	}
	if err := os.RemoveAll(linkPath); err != nil {
		_ = os.Remove(tmpLink)
		return fmt.Errorf("remove existing symlink path: %w", err)
	}
	if err := os.Rename(tmpLink, linkPath); err != nil {
		_ = os.Remove(tmpLink)
		return fmt.Errorf("replace symlink: %w", err)
	}
	return nil
}

func (s Service) codexStandaloneRoot() (string, error) {
	home, err := s.homeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	codexHome := strings.TrimSpace(envValue(s.Environ, "CODEX_HOME"))
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	return filepath.Join(codexHome, "packages", "standalone"), nil
}

func envValue(environ func() []string, key string) string {
	if environ == nil {
		return ""
	}
	prefix := key + "="
	for _, value := range environ() {
		if strings.HasPrefix(value, prefix) {
			return strings.TrimPrefix(value, prefix)
		}
	}
	return ""
}
