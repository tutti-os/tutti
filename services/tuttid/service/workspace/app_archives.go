package workspace

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/httpx"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

const maxWorkspaceAppArtifactBytes int64 = 512 * 1024 * 1024
const defaultAppArtifactDownloadAttempts = 3
const defaultAppArtifactDownloadIdleTimeout = 60 * time.Second
const defaultAppArtifactDownloadRetryBaseDelay = 250 * time.Millisecond

type appArtifactDownloadPolicy struct {
	attempts       int
	idleTimeout    time.Duration
	retryBaseDelay time.Duration
}

type appArtifactStatusError struct {
	statusCode int
}

func (e appArtifactStatusError) Error() string {
	return fmt.Sprintf("unexpected status %d", e.statusCode)
}

func downloadAppArtifact(ctx context.Context, client *http.Client, artifactURL string, destinationPath string) error {
	return downloadAppArtifactWithPolicy(ctx, client, artifactURL, destinationPath, defaultAppArtifactDownloadPolicy())
}

func defaultAppArtifactDownloadPolicy() appArtifactDownloadPolicy {
	return appArtifactDownloadPolicy{
		attempts:       defaultAppArtifactDownloadAttempts,
		idleTimeout:    defaultAppArtifactDownloadIdleTimeout,
		retryBaseDelay: defaultAppArtifactDownloadRetryBaseDelay,
	}
}

func normalizeAppArtifactDownloadPolicy(policy appArtifactDownloadPolicy) appArtifactDownloadPolicy {
	if policy.attempts <= 0 {
		policy.attempts = defaultAppArtifactDownloadAttempts
	}
	if policy.idleTimeout <= 0 {
		policy.idleTimeout = defaultAppArtifactDownloadIdleTimeout
	}
	if policy.retryBaseDelay <= 0 {
		policy.retryBaseDelay = defaultAppArtifactDownloadRetryBaseDelay
	}
	return policy
}

func downloadAppArtifactWithPolicy(ctx context.Context, client *http.Client, artifactURL string, destinationPath string, policy appArtifactDownloadPolicy) error {
	artifactURL = strings.TrimSpace(artifactURL)
	destinationPath = strings.TrimSpace(destinationPath)
	if artifactURL == "" || destinationPath == "" {
		return errors.New("app artifact url and destination path are required")
	}
	if client == nil {
		client = httpx.Default()
	}
	policy = normalizeAppArtifactDownloadPolicy(policy)

	var lastErr error
	attemptsUsed := 0
	for attempt := 1; attempt <= policy.attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		attemptsUsed = attempt
		attemptStarted := time.Now()
		slog.Info(
			"app artifact download attempt started",
			"url", artifactURL,
			"destination", destinationPath,
			"attempt", attempt,
			"maxAttempts", policy.attempts,
			"idleTimeout", policy.idleTimeout,
		)
		bytesWritten, err := downloadAppArtifactOnce(ctx, client, artifactURL, destinationPath, policy.idleTimeout)
		duration := time.Since(attemptStarted)
		if err == nil {
			slog.Info(
				"app artifact download completed",
				"url", artifactURL,
				"destination", destinationPath,
				"attempt", attempt,
				"bytesWritten", bytesWritten,
				"duration", duration,
			)
			return nil
		}
		lastErr = err
		_ = os.Remove(destinationPath)
		slog.Warn(
			"app artifact download attempt failed",
			"url", artifactURL,
			"destination", destinationPath,
			"attempt", attempt,
			"maxAttempts", policy.attempts,
			"bytesWritten", bytesWritten,
			"duration", duration,
			"retryable", isRetryableAppArtifactDownloadError(err),
			"error", err,
		)
		if !isRetryableAppArtifactDownloadError(err) || attempt == policy.attempts {
			break
		}
		if err := waitForAppArtifactDownloadRetry(ctx, attempt, policy.retryBaseDelay); err != nil {
			return err
		}
	}
	return fmt.Errorf("download app artifact failed after %d attempt(s): %w", attemptsUsed, lastErr)
}

func downloadAppArtifactOnce(ctx context.Context, client *http.Client, artifactURL string, destinationPath string, idleTimeout time.Duration) (int64, error) {
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	lastProgressUnixNano := atomic.Int64{}
	idleTimedOut := atomic.Bool{}
	lastProgressUnixNano.Store(time.Now().UnixNano())
	done := make(chan struct{})
	go monitorAppArtifactDownloadProgress(requestCtx, done, cancel, &lastProgressUnixNano, &idleTimedOut, idleTimeout)
	defer close(done)

	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, artifactURL, nil)
	if err != nil {
		return 0, fmt.Errorf("create app artifact request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, wrapAppArtifactDownloadError("download app artifact", err, idleTimedOut.Load())
	}
	lastProgressUnixNano.Store(time.Now().UnixNano())
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 0, fmt.Errorf("download app artifact: %w", appArtifactStatusError{statusCode: response.StatusCode})
	}

	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return 0, fmt.Errorf("create app artifact destination parent: %w", err)
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, fmt.Errorf("open app artifact destination: %w", err)
	}
	targetClosed := false
	defer func() {
		if !targetClosed {
			_ = target.Close()
		}
	}()
	body := appArtifactProgressReader{
		reader:               response.Body,
		lastProgressUnixNano: &lastProgressUnixNano,
		onProgress:           appArtifactDownloadProgressFromContext(requestCtx),
		totalBytes:           response.ContentLength,
		bytesWritten:         0,
	}
	bytesWritten, err := io.Copy(target, io.LimitReader(&body, maxWorkspaceAppArtifactBytes+1))
	if err != nil {
		return bytesWritten, wrapAppArtifactDownloadError("write app artifact", err, idleTimedOut.Load())
	}
	info, err := target.Stat()
	if err != nil {
		return bytesWritten, fmt.Errorf("stat app artifact: %w", err)
	}
	if err := target.Close(); err != nil {
		targetClosed = true
		return bytesWritten, fmt.Errorf("close app artifact destination: %w", err)
	}
	targetClosed = true
	if info.Size() > maxWorkspaceAppArtifactBytes {
		return bytesWritten, fmt.Errorf("app artifact exceeds maximum size %d", maxWorkspaceAppArtifactBytes)
	}
	return bytesWritten, nil
}

func isRetryableAppArtifactDownloadError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var statusErr appArtifactStatusError
	if errors.As(err, &statusErr) {
		return statusErr.statusCode == http.StatusTooManyRequests || statusErr.statusCode >= 500
	}
	return true
}

type appArtifactProgressReader struct {
	reader               io.Reader
	lastProgressUnixNano *atomic.Int64
	onProgress           func(AppArtifactDownloadProgress)
	totalBytes           int64
	bytesWritten         int64
}

func (r *appArtifactProgressReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n > 0 {
		r.lastProgressUnixNano.Store(time.Now().UnixNano())
		r.bytesWritten += int64(n)
		if r.onProgress != nil {
			r.onProgress(AppArtifactDownloadProgress{
				DownloadedBytes: r.bytesWritten,
				TotalBytes:      r.totalBytes,
			})
		}
	}
	return n, err
}

func monitorAppArtifactDownloadProgress(
	ctx context.Context,
	done <-chan struct{},
	cancel context.CancelFunc,
	lastProgressUnixNano *atomic.Int64,
	idleTimedOut *atomic.Bool,
	idleTimeout time.Duration,
) {
	interval := idleTimeout / 2
	if interval <= 0 {
		interval = idleTimeout
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			lastProgress := time.Unix(0, lastProgressUnixNano.Load())
			if time.Since(lastProgress) < idleTimeout {
				continue
			}
			idleTimedOut.Store(true)
			cancel()
			return
		}
	}
}

func wrapAppArtifactDownloadError(operation string, err error, idleTimedOut bool) error {
	if idleTimedOut {
		return fmt.Errorf("%s: no download progress before idle timeout: %w", operation, context.DeadlineExceeded)
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func waitForAppArtifactDownloadRetry(ctx context.Context, failedAttempt int, retryBaseDelay time.Duration) error {
	delay := retryBaseDelay * time.Duration(failedAttempt)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func createAppPackageZip(sourceDir string, destinationPath string) error {
	sourceDir = filepath.Clean(sourceDir)
	destinationPath = strings.TrimSpace(destinationPath)
	if sourceDir == "" || destinationPath == "" {
		return errors.New("app package source dir and destination path are required")
	}
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return fmt.Errorf("create app archive destination parent: %w", err)
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("create app archive: %w", err)
	}
	zipWriter := zip.NewWriter(target)
	walkErr := filepath.WalkDir(sourceDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relativePath, err := filepath.Rel(sourceDir, path)
		if err != nil {
			return fmt.Errorf("resolve app archive relative path: %w", err)
		}
		if relativePath == "." {
			return nil
		}
		archiveName := filepath.ToSlash(filepath.Clean(relativePath))
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("read app archive file info: %w", err)
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return fmt.Errorf("create app archive header: %w", err)
		}
		header.Name = archiveName
		if entry.IsDir() {
			header.Name += "/"
		} else {
			header.Method = zip.Deflate
		}
		writer, err := zipWriter.CreateHeader(header)
		if err != nil {
			return fmt.Errorf("create app archive entry: %w", err)
		}
		if entry.IsDir() {
			return nil
		}
		sourceFile, err := os.Open(path)
		if err != nil {
			return fmt.Errorf("open app archive source file: %w", err)
		}
		_, copyErr := io.Copy(writer, sourceFile)
		return errors.Join(
			wrapCopyFileError("copy app archive source file", copyErr),
			wrapCopyFileError("close app archive source file", sourceFile.Close()),
		)
	})
	return errors.Join(
		wrapCopyFileError("walk app archive source", walkErr),
		wrapCopyFileError("close app archive writer", zipWriter.Close()),
		wrapCopyFileError("close app archive file", target.Close()),
	)
}

func extractAppPackageZip(archivePath string, destinationDir string) error {
	return extractAppPackageZipWithLimits(
		archivePath,
		destinationDir,
		maxWorkspaceAppArtifactBytes,
		maxWorkspaceAppArtifactBytes,
	)
}

func extractAppPackageZipWithLimits(archivePath string, destinationDir string, maxArchiveBytes int64, maxExpandedBytes int64) error {
	archivePath = strings.TrimSpace(archivePath)
	destinationDir = filepath.Clean(destinationDir)
	if archivePath == "" || destinationDir == "" {
		return errors.New("app archive path and destination dir are required")
	}
	archiveInfo, err := os.Stat(archivePath)
	if err != nil {
		return fmt.Errorf("stat app archive: %w", err)
	}
	if archiveInfo.Size() > maxArchiveBytes {
		return fmt.Errorf("app archive exceeds maximum size %d", maxArchiveBytes)
	}
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open app archive: %w", err)
	}
	defer func() {
		_ = reader.Close()
	}()
	if err := os.MkdirAll(destinationDir, 0o755); err != nil {
		return fmt.Errorf("create app archive destination: %w", err)
	}
	var expandedBytes int64
	for _, file := range reader.File {
		if !file.FileInfo().IsDir() {
			if file.UncompressedSize64 > uint64(maxExpandedBytes) {
				return fmt.Errorf("app archive entry %q exceeds maximum size %d", file.Name, maxExpandedBytes)
			}
			declaredSize := int64(file.UncompressedSize64)
			if expandedBytes > maxExpandedBytes-declaredSize {
				return fmt.Errorf("app archive exceeds maximum expanded size %d", maxExpandedBytes)
			}
		}
		copiedBytes, err := extractAppPackageZipEntry(file, destinationDir, maxExpandedBytes-expandedBytes, maxExpandedBytes)
		if err != nil {
			return err
		}
		expandedBytes += copiedBytes
	}
	return nil
}

func extractAppPackageZipEntry(file *zip.File, destinationDir string, remainingBytes int64, maxExpandedBytes int64) (int64, error) {
	name := strings.TrimSpace(file.Name)
	cleanName := filepath.Clean(filepath.FromSlash(name))
	if name == "" || cleanName == "." || filepath.IsAbs(cleanName) || hasPathTraversalSegment(name) {
		return 0, fmt.Errorf("app archive contains unsafe path %q", file.Name)
	}
	mode := file.FileInfo().Mode()
	if mode&os.ModeSymlink != 0 {
		return 0, fmt.Errorf("app archive contains unsupported symlink %q", file.Name)
	}
	targetPath := filepath.Join(destinationDir, cleanName)
	relativeTarget, err := filepath.Rel(destinationDir, targetPath)
	if err != nil {
		return 0, fmt.Errorf("resolve app archive target path: %w", err)
	}
	if relativeTarget == ".." || strings.HasPrefix(relativeTarget, ".."+string(filepath.Separator)) {
		return 0, fmt.Errorf("app archive contains unsafe path %q", file.Name)
	}
	if file.FileInfo().IsDir() {
		return 0, os.MkdirAll(targetPath, zipEntryPerm(mode, 0o755))
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return 0, fmt.Errorf("create app archive entry parent: %w", err)
	}
	source, err := file.Open()
	if err != nil {
		return 0, fmt.Errorf("open app archive entry: %w", err)
	}
	target, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, zipEntryPerm(mode, 0o644))
	if err != nil {
		return 0, errors.Join(
			fmt.Errorf("create app archive entry: %w", err),
			wrapCopyFileError("close app archive entry", source.Close()),
		)
	}
	copiedBytes, copyErr := io.Copy(target, io.LimitReader(source, remainingBytes+1))
	var sizeErr error
	if copyErr == nil && copiedBytes > remainingBytes {
		sizeErr = fmt.Errorf("app archive exceeds maximum expanded size %d", maxExpandedBytes)
	}
	return copiedBytes, errors.Join(
		wrapCopyFileError("copy app archive entry", copyErr),
		sizeErr,
		wrapCopyFileError("close app archive target", target.Close()),
		wrapCopyFileError("close app archive entry", source.Close()),
	)
}

func hasPathTraversalSegment(value string) bool {
	for _, part := range strings.FieldsFunc(value, func(char rune) bool {
		return char == '/' || char == '\\'
	}) {
		if part == ".." {
			return true
		}
	}
	return false
}

func zipEntryPerm(mode os.FileMode, fallback os.FileMode) os.FileMode {
	perm := mode.Perm()
	if perm == 0 {
		return fallback
	}
	return perm
}

func resolveExtractedPackageRoot(stagingDir string) (string, error) {
	if ok, err := appManifestFileExists(stagingDir); ok {
		return stagingDir, nil
	} else if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("stat extracted app manifest: %w", err)
	}
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		return "", fmt.Errorf("read extracted app archive: %w", err)
	}
	var packageRoots []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(stagingDir, entry.Name())
		if ok, err := appManifestFileExists(candidate); ok {
			packageRoots = append(packageRoots, candidate)
		} else if err != nil && !os.IsNotExist(err) {
			return "", fmt.Errorf("stat nested app manifest: %w", err)
		}
	}
	if len(packageRoots) != 1 {
		return "", errors.New("app archive must contain exactly one package root with tutti.app.json")
	}
	return packageRoots[0], nil
}

func appManifestFileExists(packageDir string) (bool, error) {
	_, err := os.Stat(filepath.Join(packageDir, "tutti.app.json"))
	if err == nil {
		return true, nil
	}
	return false, err
}

func validateExtractedAppPackage(packageRoot string, manifest workspacebiz.AppManifest) error {
	bootstrapPath := filepath.Join(packageRoot, filepath.Clean(manifest.Runtime.Bootstrap))
	info, err := os.Stat(bootstrapPath)
	if err != nil {
		return fmt.Errorf("stat runtime bootstrap: %w", err)
	}
	if info.IsDir() {
		return errors.New("runtime bootstrap must be a file")
	}
	if info.Mode()&0o111 == 0 {
		return errors.New("runtime bootstrap must be executable")
	}
	agentsData, err := os.ReadFile(filepath.Join(packageRoot, "AGENTS.md"))
	if err != nil {
		return fmt.Errorf("read AGENTS.md: %w", err)
	}
	if strings.TrimSpace(string(agentsData)) == "" {
		return errors.New("AGENTS.md must be non-empty")
	}
	return nil
}

func fileSHA256AndSize(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, fmt.Errorf("open file for sha256: %w", err)
	}
	hash := sha256.New()
	size, copyErr := io.Copy(hash, file)
	return fmt.Sprintf("%x", hash.Sum(nil)), size, errors.Join(
		wrapCopyFileError("hash file", copyErr),
		wrapCopyFileError("close file for sha256", file.Close()),
	)
}
