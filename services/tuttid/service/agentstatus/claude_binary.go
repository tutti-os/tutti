package agentstatus

// Claude Code runtime binary provisioning.
//
// The desktop bundle ships the Claude SDK sidecar JS without the platform's
// native `claude` binary (the @anthropic-ai/claude-agent-sdk-<platform> npm
// package, ~230MB per platform, essentially incompressible with gzip). tuttid
// provisions the binary at runtime instead:
//
//  1. CDN (S3 + CloudFront, zstd-compressed, ~50MB) — primary source,
//     published per SDK version by .github/workflows/publish-claude-code-binaries.yml.
//  2. npm registry chain (official → CN mirrors) tarball — fallback.
//
// The expected version and sha256 come from the vendored SDK's manifest.json,
// so integrity anchors on the (signed) app bundle regardless of which source
// served the bytes. The installed path is exposed to session launches through
// a pointer file consumed by runtimeprep's ClaudeCodePreparer, which emits
// TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE for the sidecar (see
// packages/agent/runtimeprep/claude.go — keep the pointer path contract in
// sync with claudeCodeManagedPointerRelPath there).

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	// claudeCodeBinaryBaseURLEnv overrides the CDN base URL that hosts the
	// zstd-compressed claude binaries (layout: <base>/<claudeVersion>/claude-<platform>.zst).
	claudeCodeBinaryBaseURLEnv = "TUTTI_CLAUDE_CODE_BINARY_BASE_URL"

	// defaultClaudeCodeBinaryBaseURL matches the CloudFront distribution that
	// already serves tutti-app-runtimes (see managedruntime.runtime.go).
	defaultClaudeCodeBinaryBaseURL = "https://d1x7gb6wqsqmnm.cloudfront.net/claude-code"

	// claudeCodeStateRelDir is the tutti-state-relative root for provisioned
	// claude binaries. Versioned subdirectories keep an in-use binary intact
	// while a newer one installs (Windows cannot replace a running executable).
	claudeCodeStateRelDir = "agent-providers/claude-code"

	// claudeCodePointerFileName is the pointer consumed by runtimeprep's
	// ClaudeCodePreparer. Contract: JSON {"version": string, "executable": abs path}.
	claudeCodePointerFileName = "current.json"

	claudeSDKPackageScopeDir = "@anthropic-ai"
	claudeSDKPackageName     = "claude-agent-sdk"
)

// claudeBinaryProvisionSem serializes EnsureClaudeCodeBinary within this
// process (the file-based install lock arbitrates across processes). A
// 1-slot channel instead of a mutex so waiters stay cancellable through
// their context.
var claudeBinaryProvisionSem = make(chan struct{}, 1)

type ClaudeCodeBinaryStatus struct {
	// Path is the provisioned executable, empty when provisioning was skipped.
	Path string
	// Version is the claude release version from the SDK manifest (e.g. 2.1.201).
	Version string
	// Source records where the binary came from: "installed", "cdn", "npm",
	// or a skip reason ("sidecar_unavailable", "native_package_present",
	// "platform_unsupported").
	Source string
}

// claudeSDKRuntimeDescriptor is derived from the vendored SDK package next to
// the sidecar entry and pins exactly which binary this app build expects.
type claudeSDKRuntimeDescriptor struct {
	NPMVersion    string
	ClaudeVersion string
	PlatformKey   string
	BinaryName    string
	SHA256        string
	SizeBytes     int64
}

type claudeSDKManifest struct {
	Version   string                               `json:"version"`
	Platforms map[string]claudeSDKManifestPlatform `json:"platforms"`
}

type claudeSDKManifestPlatform struct {
	Binary   string `json:"binary"`
	Checksum string `json:"checksum"`
	Size     int64  `json:"size"`
}

type claudeCodeBinaryPointer struct {
	Version    string `json:"version"`
	Executable string `json:"executable"`
}

// EnsureClaudeCodeBinary provisions the native claude binary matching the
// vendored SDK when the sidecar bundle does not carry one. It is safe to call
// concurrently (file lock) and cheap when the binary is already installed.
func (s Service) EnsureClaudeCodeBinary(ctx context.Context) (ClaudeCodeBinaryStatus, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	entry := s.resolveClaudeSDKSidecarEntryPath()
	if entry == "" {
		return ClaudeCodeBinaryStatus{Source: "sidecar_unavailable"}, nil
	}
	bundleDir := filepath.Dir(filepath.Dir(entry))
	sdkDir, err := resolveClaudeSDKPackageDir(bundleDir)
	if err != nil {
		// A dev tree without node_modules cannot resolve the SDK package; the
		// sidecar itself is equally unusable there, so there is nothing to
		// provision yet.
		return ClaudeCodeBinaryStatus{Source: "sdk_package_unresolved"}, nil
	}
	descriptor, err := readClaudeSDKRuntimeDescriptor(sdkDir)
	if err != nil {
		return ClaudeCodeBinaryStatus{}, err
	}
	if descriptor.PlatformKey == "" {
		return ClaudeCodeBinaryStatus{Source: "platform_unsupported"}, nil
	}
	if nativeClaudeBinaryPresent(sdkDir, descriptor.BinaryName) {
		// The bundle (dev tree via pnpm, or a legacy package) still carries the
		// native package; the SDK resolves it directly and no download is needed.
		return ClaudeCodeBinaryStatus{Version: descriptor.ClaudeVersion, Source: "native_package_present"}, nil
	}

	stateRoot := s.claudeCodeStateRoot()
	finalPath := filepath.Join(stateRoot, "versions", descriptor.ClaudeVersion, descriptor.BinaryName)
	if claudeBinaryReady(finalPath, descriptor) {
		if err := writeClaudeCodePointer(stateRoot, descriptor, finalPath); err != nil {
			return ClaudeCodeBinaryStatus{}, err
		}
		return ClaudeCodeBinaryStatus{Path: finalPath, Version: descriptor.ClaudeVersion, Source: "installed"}, nil
	}

	// In-process serialization first: two goroutines of the same daemon would
	// otherwise race Recover/Acquire on the same PID-keyed lock file (the file
	// lock only arbitrates between processes).
	select {
	case claudeBinaryProvisionSem <- struct{}{}:
		defer func() { <-claudeBinaryProvisionSem }()
	case <-ctx.Done():
		return ClaudeCodeBinaryStatus{}, ctx.Err()
	}

	lock := newInstallCommandLock(claudeCodeBinaryLockCommand)
	// Self-heal an orphaned lock (daemon crash mid-provisioning) before
	// acquiring: Acquire polls indefinitely on an existing lock file and the
	// startup recovery in main.go only sweeps the npm-global lock. Recover
	// removes the file only when its owning PID is dead and re-verifies the
	// file's identity right before deletion, so it cannot break a live
	// concurrent provisioning run.
	if _, err := lock.Recover(); err != nil {
		return ClaudeCodeBinaryStatus{}, fmt.Errorf("recover claude binary install lock: %w", err)
	}
	releaseLock, err := lock.Acquire(ctx)
	if err != nil {
		return ClaudeCodeBinaryStatus{}, err
	}
	defer releaseLock()
	if claudeBinaryReady(finalPath, descriptor) {
		if err := writeClaudeCodePointer(stateRoot, descriptor, finalPath); err != nil {
			return ClaudeCodeBinaryStatus{}, err
		}
		return ClaudeCodeBinaryStatus{Path: finalPath, Version: descriptor.ClaudeVersion, Source: "installed"}, nil
	}

	source, err := s.downloadClaudeCodeBinary(ctx, descriptor, finalPath)
	if err != nil {
		return ClaudeCodeBinaryStatus{}, err
	}
	if err := writeClaudeCodePointer(stateRoot, descriptor, finalPath); err != nil {
		return ClaudeCodeBinaryStatus{}, err
	}
	cleanupClaudeCodeVersions(stateRoot, descriptor.ClaudeVersion)
	return ClaudeCodeBinaryStatus{Path: finalPath, Version: descriptor.ClaudeVersion, Source: source}, nil
}

// Per-source download budgets: a stalled primary source must not consume the
// caller's whole deadline and starve the fallback of a live context. The
// caller's context still bounds the overall attempt.
const claudeCDNDownloadTimeout = 10 * time.Minute
const claudeNPMDownloadTimeoutPerRegistry = 10 * time.Minute

func (s Service) downloadClaudeCodeBinary(
	ctx context.Context,
	descriptor claudeSDKRuntimeDescriptor,
	finalPath string,
) (string, error) {
	cdnCtx, cancelCDN := context.WithTimeout(ctx, claudeCDNDownloadTimeout)
	cdnErr := s.installClaudeCodeBinaryFromCDN(cdnCtx, descriptor, finalPath)
	cancelCDN()
	if cdnErr == nil {
		return "cdn", nil
	}
	if ctx.Err() != nil {
		return "", cdnErr
	}
	slog.Warn(
		"claude code binary CDN download failed, falling back to npm registries",
		"event", "tutti.claude_code_binary.cdn_failed",
		"version", descriptor.ClaudeVersion,
		"platform", descriptor.PlatformKey,
		"error", cdnErr,
	)
	npmErr := s.installClaudeCodeBinaryFromNPM(ctx, descriptor, finalPath)
	if npmErr == nil {
		return "npm", nil
	}
	return "", fmt.Errorf("claude code binary unavailable: cdn: %w; npm: %w", cdnErr, npmErr)
}

func (s Service) installClaudeCodeBinaryFromCDN(
	ctx context.Context,
	descriptor claudeSDKRuntimeDescriptor,
	finalPath string,
) error {
	base := strings.TrimSpace(s.lookupEnv(claudeCodeBinaryBaseURLEnv))
	if base == "" {
		base = defaultClaudeCodeBinaryBaseURL
	}
	sourceURL := strings.TrimRight(base, "/") + "/" + descriptor.ClaudeVersion +
		"/claude-" + descriptor.PlatformKey + ".zst"
	archivePath := filepath.Join(filepath.Dir(filepath.Dir(finalPath)), "downloads",
		"claude-"+descriptor.ClaudeVersion+"-"+descriptor.PlatformKey+".zst")
	defer func() {
		_ = os.Remove(archivePath)
	}()
	if err := s.downloadFile(ctx, sourceURL, archivePath); err != nil {
		return err
	}
	stagingPath := claudeBinaryStagingPath(finalPath)
	if err := decompressZstdFile(archivePath, stagingPath, descriptor.SizeBytes); err != nil {
		return err
	}
	return promoteClaudeBinary(stagingPath, finalPath, descriptor)
}

func (s Service) installClaudeCodeBinaryFromNPM(
	ctx context.Context,
	descriptor claudeSDKRuntimeDescriptor,
	finalPath string,
) error {
	packageName := claudeSDKPackageScopeDir + "/" + claudeSDKPackageName + "-" + descriptor.PlatformKey
	archivePath := filepath.Join(filepath.Dir(filepath.Dir(finalPath)), "downloads",
		"claude-"+descriptor.ClaudeVersion+"-"+descriptor.PlatformKey+".tgz")
	defer func() {
		_ = os.Remove(archivePath)
	}()
	var lastErr error
	for _, registry := range s.rankedAgentNPMRegistries(ctx, packageName) {
		if ctx.Err() != nil {
			return errors.Join(ctx.Err(), lastErr)
		}
		sourceURL := npmPackageTarballURL(registry, packageName, descriptor.NPMVersion)
		if sourceURL == "" {
			continue
		}
		// A registry that stalls mid-transfer must fail over to the next one
		// instead of consuming the caller's whole deadline.
		registryCtx, cancelRegistry := context.WithTimeout(ctx, claudeNPMDownloadTimeoutPerRegistry)
		downloadErr := s.downloadFile(registryCtx, sourceURL, archivePath)
		cancelRegistry()
		if downloadErr != nil {
			lastErr = downloadErr
			continue
		}
		stagingPath := claudeBinaryStagingPath(finalPath)
		if err := extractClaudeBinaryFromTarball(archivePath, descriptor.BinaryName, stagingPath, descriptor.SizeBytes); err != nil {
			lastErr = err
			continue
		}
		if err := promoteClaudeBinary(stagingPath, finalPath, descriptor); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("no npm registry produced a tarball URL")
	}
	return lastErr
}

// npmPackageTarballURL builds the conventional npm tarball location
// (<registry>/<scope>/<name>/-/<name>-<version>.tgz); the CN mirrors in
// agentNPMRegistries serve identical layouts.
func npmPackageTarballURL(registry string, packageName string, version string) string {
	registry = strings.TrimRight(strings.TrimSpace(registry), "/")
	packageName = strings.TrimSpace(packageName)
	version = strings.TrimSpace(version)
	if registry == "" || packageName == "" || version == "" {
		return ""
	}
	bareName := packageName
	if index := strings.LastIndex(packageName, "/"); index >= 0 {
		bareName = packageName[index+1:]
	}
	return registry + "/" + packageName + "/-/" + bareName + "-" + version + ".tgz"
}

func claudeBinaryStagingPath(finalPath string) string {
	// Same directory as the final path so the post-verification rename is
	// atomic on the same filesystem.
	return filepath.Join(filepath.Dir(finalPath), "."+filepath.Base(finalPath)+".staging")
}

func decompressZstdFile(archivePath string, destinationPath string, expectedSize int64) error {
	archive, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("open claude binary archive: %w", err)
	}
	defer func() {
		_ = archive.Close()
	}()
	decoder, err := zstd.NewReader(archive)
	if err != nil {
		return fmt.Errorf("open zstd claude binary archive: %w", err)
	}
	defer decoder.Close()
	// The manifest pins the exact decompressed size; anything larger is a
	// corrupt or forged archive and must not fill the disk.
	limited := io.LimitReader(decoder, expectedSize+1)
	if err := writeReleaseBinary(destinationPath, limited, 0o755); err != nil {
		return err
	}
	return verifyFileSize(destinationPath, expectedSize)
}

// extractClaudeBinaryFromTarball extracts the claude binary member from an
// npm tarball, bounded by the manifest size so a forged archive cannot fill
// the state volume before integrity verification.
func extractClaudeBinaryFromTarball(archivePath string, binaryName string, destinationPath string, expectedSize int64) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("open claude npm tarball: %w", err)
	}
	defer func() {
		_ = file.Close()
	}()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("open gzip claude npm tarball: %w", err)
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
			return fmt.Errorf("read claude npm tarball: %w", err)
		}
		if header == nil || header.FileInfo().IsDir() || filepath.Base(header.Name) != binaryName {
			continue
		}
		limited := io.LimitReader(reader, expectedSize+1)
		if err := writeReleaseBinary(destinationPath, limited, 0o755); err != nil {
			return err
		}
		return verifyFileSize(destinationPath, expectedSize)
	}
	return fmt.Errorf("claude npm tarball does not contain %s", binaryName)
}

func verifyFileSize(path string, expectedSize int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat claude binary: %w", err)
	}
	if info.Size() != expectedSize {
		_ = os.Remove(path)
		return fmt.Errorf("claude binary size mismatch: got %d, want %d", info.Size(), expectedSize)
	}
	return nil
}

// promoteClaudeBinary verifies the staged binary and only then moves it to the
// final path. The final path therefore never holds unverified bytes: an
// interruption at any point leaves either no file or a fully verified one, and
// the fast size-based readiness gate stays trustworthy.
func promoteClaudeBinary(stagingPath string, finalPath string, descriptor claudeSDKRuntimeDescriptor) error {
	sum, err := fileSHA256(stagingPath)
	if err != nil {
		_ = os.Remove(stagingPath)
		return err
	}
	if !strings.EqualFold(sum, normalizeSHA256(descriptor.SHA256)) {
		_ = os.Remove(stagingPath)
		return fmt.Errorf("claude binary sha256 mismatch for %s: got %s, want %s",
			descriptor.PlatformKey, sum, descriptor.SHA256)
	}
	if err := os.Chmod(stagingPath, 0o755); err != nil {
		_ = os.Remove(stagingPath)
		return fmt.Errorf("chmod claude binary: %w", err)
	}
	if err := os.Rename(stagingPath, finalPath); err != nil {
		_ = os.Remove(stagingPath)
		return fmt.Errorf("install claude binary: %w", err)
	}
	return nil
}

func claudeBinaryReady(path string, descriptor claudeSDKRuntimeDescriptor) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	// Full sha256 of a ~230MB file is too slow for every resolve; the checksum
	// was verified before the file was promoted to this path (see
	// promoteClaudeBinary) and the exact size gates torn writes.
	if info.Size() != descriptor.SizeBytes {
		return false
	}
	// Windows file modes never expose Unix execute bits, so the bit check
	// only applies where it is meaningful.
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}

func (s Service) claudeCodeStateRoot() string {
	stateDir := strings.TrimSpace(s.ClaudeCodeStateDir)
	if stateDir == "" {
		stateDir = tuttitypes.DefaultStateDir()
	}
	return filepath.Join(stateDir, filepath.FromSlash(claudeCodeStateRelDir))
}

func writeClaudeCodePointer(stateRoot string, descriptor claudeSDKRuntimeDescriptor, executable string) error {
	pointer := claudeCodeBinaryPointer{
		Version:    descriptor.ClaudeVersion,
		Executable: executable,
	}
	current, err := readClaudeCodePointer(stateRoot)
	if err == nil && current == pointer {
		return nil
	}
	content, err := json.MarshalIndent(pointer, "", "  ")
	if err != nil {
		return fmt.Errorf("encode claude binary pointer: %w", err)
	}
	if err := os.MkdirAll(stateRoot, 0o755); err != nil {
		return fmt.Errorf("create claude binary state root: %w", err)
	}
	target, err := os.CreateTemp(stateRoot, "."+claudeCodePointerFileName+".tmp-*")
	if err != nil {
		return fmt.Errorf("create claude binary pointer temp file: %w", err)
	}
	tempPath := target.Name()
	defer func() {
		_ = os.Remove(tempPath)
	}()
	_, writeErr := target.Write(append(content, '\n'))
	closeErr := target.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	if err := os.Rename(tempPath, filepath.Join(stateRoot, claudeCodePointerFileName)); err != nil {
		return fmt.Errorf("install claude binary pointer: %w", err)
	}
	return nil
}

func readClaudeCodePointer(stateRoot string) (claudeCodeBinaryPointer, error) {
	content, err := os.ReadFile(filepath.Join(stateRoot, claudeCodePointerFileName))
	if err != nil {
		return claudeCodeBinaryPointer{}, err
	}
	var pointer claudeCodeBinaryPointer
	if err := json.Unmarshal(content, &pointer); err != nil {
		return claudeCodeBinaryPointer{}, err
	}
	return pointer, nil
}

// cleanupClaudeCodeVersions removes provisioned versions other than the one in
// use. Best-effort: an in-use binary on Windows refuses deletion, which is
// fine — the next successful cleanup gets it.
func cleanupClaudeCodeVersions(stateRoot string, keepVersion string) {
	versionsDir := filepath.Join(stateRoot, "versions")
	entries, err := os.ReadDir(versionsDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == keepVersion {
			continue
		}
		_ = os.RemoveAll(filepath.Join(versionsDir, entry.Name()))
	}
	_ = os.RemoveAll(filepath.Join(stateRoot, "downloads"))
}

func resolveClaudeSDKPackageDir(bundleDir string) (string, error) {
	sdkDir := filepath.Join(bundleDir, "node_modules", claudeSDKPackageScopeDir, claudeSDKPackageName)
	resolved, err := filepath.EvalSymlinks(sdkDir)
	if err != nil {
		return "", fmt.Errorf("resolve claude sdk package dir: %w", err)
	}
	return resolved, nil
}

func readClaudeSDKRuntimeDescriptor(sdkDir string) (claudeSDKRuntimeDescriptor, error) {
	packageContent, err := os.ReadFile(filepath.Join(sdkDir, "package.json"))
	if err != nil {
		return claudeSDKRuntimeDescriptor{}, fmt.Errorf("read claude sdk package.json: %w", err)
	}
	var packageManifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(packageContent, &packageManifest); err != nil {
		return claudeSDKRuntimeDescriptor{}, fmt.Errorf("parse claude sdk package.json: %w", err)
	}
	manifestContent, err := os.ReadFile(filepath.Join(sdkDir, "manifest.json"))
	if err != nil {
		return claudeSDKRuntimeDescriptor{}, fmt.Errorf("read claude sdk manifest.json: %w", err)
	}
	var manifest claudeSDKManifest
	if err := json.Unmarshal(manifestContent, &manifest); err != nil {
		return claudeSDKRuntimeDescriptor{}, fmt.Errorf("parse claude sdk manifest.json: %w", err)
	}
	platformKey := claudeCodePlatformKey(runtime.GOOS, runtime.GOARCH)
	platform, ok := manifest.Platforms[platformKey]
	if !ok || strings.TrimSpace(platform.Binary) == "" ||
		strings.TrimSpace(platform.Checksum) == "" || platform.Size <= 0 {
		platformKey = ""
	}
	descriptor := claudeSDKRuntimeDescriptor{
		NPMVersion:    strings.TrimSpace(packageManifest.Version),
		ClaudeVersion: strings.TrimSpace(manifest.Version),
		PlatformKey:   platformKey,
	}
	if platformKey != "" {
		descriptor.BinaryName = strings.TrimSpace(platform.Binary)
		descriptor.SHA256 = strings.TrimSpace(platform.Checksum)
		descriptor.SizeBytes = platform.Size
	}
	if descriptor.NPMVersion == "" || descriptor.ClaudeVersion == "" {
		return claudeSDKRuntimeDescriptor{}, errors.New("claude sdk manifest is missing version metadata")
	}
	return descriptor, nil
}

// claudeCodePlatformKey maps GOOS/GOARCH to the SDK manifest / npm package
// platform key. Desktop builds target glibc distributions, so the musl
// variants are intentionally not selected.
func claudeCodePlatformKey(goos string, goarch string) string {
	arch := ""
	switch goarch {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	default:
		return ""
	}
	switch goos {
	case "darwin":
		return "darwin-" + arch
	case "linux":
		return "linux-" + arch
	case "windows":
		return "win32-" + arch
	default:
		return ""
	}
}

// nativeClaudeBinaryPresent reports whether the SDK can resolve its native
// binary from an optional-dependency package next to it. Both the pnpm virtual
// store (dev tree) and the flat vendored bundle place the platform package as
// a sibling inside the same @anthropic-ai scope directory.
func nativeClaudeBinaryPresent(sdkDir string, binaryName string) bool {
	platformKey := claudeCodePlatformKey(runtime.GOOS, runtime.GOARCH)
	if platformKey == "" || strings.TrimSpace(binaryName) == "" {
		return false
	}
	candidates := []string{platformKey}
	if runtime.GOOS == "linux" {
		candidates = append(candidates, platformKey+"-musl")
	}
	scopeDir := filepath.Dir(sdkDir)
	for _, candidate := range candidates {
		binaryPath := filepath.Join(scopeDir, claudeSDKPackageName+"-"+candidate, binaryName)
		resolved, err := filepath.EvalSymlinks(binaryPath)
		if err != nil {
			continue
		}
		info, err := os.Stat(resolved)
		if err == nil && !info.IsDir() {
			return true
		}
	}
	return false
}
