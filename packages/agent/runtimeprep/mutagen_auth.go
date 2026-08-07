package runtimeprep

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	mutagenVersion        = "0.18.1"
	mutagenWindowsAMD64   = "mutagen_windows_amd64_v0.18.1.tar.gz"
	mutagenWindowsSHA256  = "3e237e77f69959ed520a0f877330a431507bb0a85d9da7919764ba0c87b702c7"
	mutagenMaxArchiveSize = 100 << 20
	mutagenSessionMarker  = ".tutti-mutagen-session"
)

type AuthFileProjection struct {
	SourcePath     string
	TargetPath     string
	LockSourcePath string
	LockTargetPath string
}

type AuthFileProjector interface {
	Project(context.Context, AuthFileProjection) (func(context.Context) error, error)
}

// MutagenAuthFileProjector uses Mutagen's conflict-aware two-way-safe mode
// only when an ordinary file symlink cannot be created. The injected hooks
// keep process execution and filesystem privilege failures unit-testable.
type MutagenAuthFileProjector struct {
	StateDir          string
	ResolveExecutable func(context.Context) (string, error)
	Run               func(context.Context, string, []string, []string) ([]byte, error)
	Symlink           func(string, string) error
	Link              func(string, string) error
	HTTPClient        *http.Client
	DownloadURL       string
	ArchiveSHA256     string
}

func (p MutagenAuthFileProjector) Project(ctx context.Context, input AuthFileProjection) (func(context.Context) error, error) {
	if err := os.MkdirAll(filepath.Dir(input.TargetPath), 0o700); err != nil {
		return nil, fmt.Errorf("create auth target directory: %w", err)
	}
	markerPath := filepath.Join(filepath.Dir(input.TargetPath), mutagenSessionMarker)
	if marker, err := os.ReadFile(markerPath); err == nil {
		sessionName := strings.TrimSpace(string(marker))
		if sessionName == "" || strings.ContainsAny(sessionName, "\r\n\x00") {
			return nil, errors.New("invalid persisted Mutagen auth session marker")
		}
		executable, err := p.resolveExecutable(ctx)
		if err != nil {
			return nil, err
		}
		return p.cleanupCallback(executable, sessionName, markerPath), nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read Mutagen auth session marker: %w", err)
	}
	targetInfo, targetErr := os.Lstat(input.TargetPath)
	targetExists := targetErr == nil
	if targetErr != nil && !os.IsNotExist(targetErr) {
		return nil, fmt.Errorf("inspect auth target: %w", targetErr)
	}
	createdTarget := false
	symlink := p.Symlink
	if symlink == nil {
		symlink = os.Symlink
	}
	if !targetExists {
		if err := symlink(input.SourcePath, input.TargetPath); err == nil {
			if err := p.projectLock(input); err != nil {
				_ = os.Remove(input.TargetPath)
				return nil, err
			}
			return nil, nil
		}
	}
	if targetExists && targetInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("auth target symlink has no recoverable Mutagen session marker")
	}
	if !targetExists {
		if err := copyFile(input.SourcePath, input.TargetPath, 0o600); err != nil {
			return nil, fmt.Errorf("seed Mutagen auth target: %w", err)
		}
		createdTarget = true
	}
	if err := p.projectLock(input); err != nil {
		if createdTarget {
			_ = os.Remove(input.TargetPath)
		}
		return nil, err
	}
	executable, err := p.resolveExecutable(ctx)
	if err != nil {
		if createdTarget {
			p.removeProjectionTargets(input)
		}
		return nil, err
	}
	sessionName := mutagenAuthSessionName(input.SourcePath, input.TargetPath)
	if _, err := p.run(ctx, executable, []string{
		"sync", "create", "--name=" + sessionName, "--sync-mode=two-way-safe",
		"--no-global-configuration", input.SourcePath, input.TargetPath,
	}); err != nil {
		if createdTarget {
			p.removeProjectionTargets(input)
		}
		return nil, fmt.Errorf("create Mutagen auth session: %w", err)
	}
	// Establish the common baseline before the provider can refresh the token;
	// create may return while Mutagen's initial scan is still in progress.
	if _, err := p.run(ctx, executable, []string{"sync", "flush", sessionName}); err != nil {
		_, _ = p.run(ctx, executable, []string{"sync", "terminate", sessionName})
		if createdTarget {
			p.removeProjectionTargets(input)
		}
		return nil, fmt.Errorf("initialize Mutagen auth session: %w", err)
	}
	if err := os.WriteFile(markerPath, []byte(sessionName+"\n"), 0o600); err != nil {
		_, _ = p.run(ctx, executable, []string{"sync", "terminate", sessionName})
		if createdTarget {
			p.removeProjectionTargets(input)
		}
		return nil, fmt.Errorf("persist Mutagen auth session marker: %w", err)
	}
	return p.cleanupCallback(executable, sessionName, markerPath), nil
}

func (p MutagenAuthFileProjector) cleanupCallback(executable, sessionName, markerPath string) func(context.Context) error {
	return func(cleanupCtx context.Context) error {
		if _, err := p.run(cleanupCtx, executable, []string{"sync", "flush", sessionName}); err != nil {
			return fmt.Errorf("flush Mutagen auth session; runtime preserved: %w", err)
		}
		output, err := p.run(cleanupCtx, executable, []string{"sync", "list", "--template={{ json . }}", sessionName})
		if err != nil {
			return fmt.Errorf("inspect Mutagen auth session; runtime preserved: %w", err)
		}
		var state any
		if err := json.Unmarshal(output, &state); err != nil {
			return fmt.Errorf("decode Mutagen auth state; runtime preserved: %w", err)
		}
		if mutagenStateHasConflicts(state) {
			return errors.New("mutagen auth synchronization conflict; runtime preserved for recovery")
		}
		if _, err := p.run(cleanupCtx, executable, []string{"sync", "terminate", sessionName}); err != nil {
			return fmt.Errorf("terminate Mutagen auth session; runtime preserved: %w", err)
		}
		if err := os.Remove(markerPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove Mutagen auth session marker: %w", err)
		}
		return nil
	}
}

func recoverMutagenAuthSessions(ctx context.Context, stateDir, runtimeRoot string) error {
	markers := make([]string, 0, 1)
	if err := filepath.WalkDir(runtimeRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !entry.IsDir() && entry.Name() == mutagenSessionMarker {
			markers = append(markers, path)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("scan persisted Mutagen auth sessions: %w", err)
	}
	if len(markers) == 0 {
		return nil
	}
	projector := MutagenAuthFileProjector{StateDir: stateDir}
	executable, err := projector.resolveExecutable(ctx)
	if err != nil {
		return err
	}
	for _, markerPath := range markers {
		marker, err := os.ReadFile(markerPath)
		if err != nil {
			return fmt.Errorf("read persisted Mutagen auth session: %w", err)
		}
		sessionName := strings.TrimSpace(string(marker))
		if sessionName == "" || strings.ContainsAny(sessionName, "\r\n\x00") {
			return errors.New("invalid persisted Mutagen auth session marker")
		}
		if err := projector.cleanupCallback(executable, sessionName, markerPath)(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (p MutagenAuthFileProjector) projectLock(input AuthFileProjection) error {
	if strings.TrimSpace(input.LockSourcePath) == "" || strings.TrimSpace(input.LockTargetPath) == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(input.LockSourcePath), 0o700); err != nil {
		return fmt.Errorf("create stable auth lock directory: %w", err)
	}
	file, err := os.OpenFile(input.LockSourcePath, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create stable auth lock: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close stable auth lock: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(input.LockTargetPath), 0o700); err != nil {
		return fmt.Errorf("create runtime auth lock directory: %w", err)
	}
	if err := os.Remove(input.LockTargetPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale runtime auth lock: %w", err)
	}
	symlink := p.Symlink
	if symlink == nil {
		symlink = os.Symlink
	}
	if err := symlink(input.LockSourcePath, input.LockTargetPath); err == nil {
		return nil
	}
	link := p.Link
	if link == nil {
		link = os.Link
	}
	if err := link(input.LockSourcePath, input.LockTargetPath); err != nil {
		return fmt.Errorf("project shared auth refresh lock: %w", err)
	}
	return nil
}

func (MutagenAuthFileProjector) removeProjectionTargets(input AuthFileProjection) {
	_ = os.Remove(input.TargetPath)
	_ = os.Remove(input.LockTargetPath)
}

func (p MutagenAuthFileProjector) run(ctx context.Context, executable string, args []string) ([]byte, error) {
	env := append(os.Environ(), "MUTAGEN_DATA_DIRECTORY="+filepath.Join(p.StateDir, "mutagen"))
	if p.Run != nil {
		return p.Run(ctx, executable, args, env)
	}
	command := exec.CommandContext(ctx, executable, args...)
	command.Env = env
	command.Stderr = io.Discard
	return command.Output()
}

func mutagenAuthSessionName(source, target string) string {
	digest := sha256.Sum256([]byte(filepath.Clean(source) + "\x00" + filepath.Clean(target)))
	return "tutti-auth-" + hex.EncodeToString(digest[:8])
}

func mutagenStateHasConflicts(value any) bool {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if mutagenStateHasConflicts(item) {
				return true
			}
		}
	case map[string]any:
		for key, item := range typed {
			if strings.EqualFold(key, "conflicts") {
				switch conflicts := item.(type) {
				case []any:
					return len(conflicts) > 0
				case map[string]any:
					return len(conflicts) > 0
				case float64:
					return conflicts != 0
				case bool:
					return conflicts
				case string:
					return conflicts != "" && conflicts != "0" && !strings.EqualFold(conflicts, "false")
				}
			}
			if mutagenStateHasConflicts(item) {
				return true
			}
		}
	}
	return false
}

var mutagenInstallMu sync.Mutex

func (p MutagenAuthFileProjector) resolveExecutable(ctx context.Context) (string, error) {
	if p.ResolveExecutable != nil {
		return p.ResolveExecutable(ctx)
	}
	if configured := strings.TrimSpace(os.Getenv("TUTTI_MUTAGEN_BIN")); configured != "" {
		path, err := exec.LookPath(configured)
		if err != nil {
			return "", fmt.Errorf("resolve TUTTI_MUTAGEN_BIN: %w", err)
		}
		return path, nil
	}
	if path, err := exec.LookPath("mutagen"); err == nil {
		return path, nil
	}
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		return "", fmt.Errorf("automatic Mutagen installation is not yet supported on %s/%s; configure TUTTI_MUTAGEN_BIN", runtime.GOOS, runtime.GOARCH)
	}
	return p.installWindowsAMD64(ctx)
}

func (p MutagenAuthFileProjector) installWindowsAMD64(ctx context.Context) (string, error) {
	mutagenInstallMu.Lock()
	defer mutagenInstallMu.Unlock()
	target := filepath.Join(filepath.Clean(p.StateDir), "bin", "mutagen.exe")
	if info, err := os.Stat(target); err == nil && !info.IsDir() {
		return target, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", fmt.Errorf("create Mutagen cache: %w", err)
	}
	url := strings.TrimSpace(p.DownloadURL)
	if url == "" {
		url = "https://github.com/mutagen-io/mutagen/releases/download/v" + mutagenVersion + "/" + mutagenWindowsAMD64
	}
	client := p.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("create Mutagen download request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("download Mutagen: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("download Mutagen: HTTP %d", response.StatusCode)
	}
	archive, err := io.ReadAll(io.LimitReader(response.Body, mutagenMaxArchiveSize+1))
	if err != nil {
		return "", fmt.Errorf("read Mutagen archive: %w", err)
	}
	if len(archive) > mutagenMaxArchiveSize {
		return "", errors.New("mutagen archive exceeds 100 MiB limit")
	}
	wantDigest := strings.TrimSpace(p.ArchiveSHA256)
	if wantDigest == "" {
		wantDigest = mutagenWindowsSHA256
	}
	digest := sha256.Sum256(archive)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), wantDigest) {
		return "", errors.New("mutagen archive SHA-256 mismatch")
	}
	binary, err := extractMutagenExecutable(archive)
	if err != nil {
		return "", err
	}
	temporary := target + fmt.Sprintf(".%d.tmp", time.Now().UnixNano())
	if err := os.WriteFile(temporary, binary, 0o700); err != nil {
		return "", fmt.Errorf("write Mutagen temporary binary: %w", err)
	}
	defer os.Remove(temporary)
	file, err := os.OpenFile(temporary, os.O_RDWR, 0)
	if err != nil {
		return "", fmt.Errorf("open Mutagen temporary binary: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("sync Mutagen temporary binary: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close Mutagen temporary binary: %w", err)
	}
	if err := os.Rename(temporary, target); err != nil {
		return "", fmt.Errorf("publish Mutagen binary: %w", err)
	}
	return target, nil
}

func extractMutagenExecutable(archive []byte) ([]byte, error) {
	gzipReader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open Mutagen archive: %w", err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read Mutagen archive: %w", err)
		}
		if filepath.Base(header.Name) != "mutagen.exe" || !header.FileInfo().Mode().IsRegular() {
			continue
		}
		if header.Size <= 0 || header.Size > mutagenMaxArchiveSize {
			return nil, errors.New("mutagen archive contains an invalid executable")
		}
		return io.ReadAll(io.LimitReader(tarReader, header.Size))
	}
	return nil, errors.New("mutagen archive does not contain mutagen.exe")
}
