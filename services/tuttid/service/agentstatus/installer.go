package agentstatus

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
)

type providerRuntimeResolution struct {
	CLIPath     string
	AdapterPath string
	InstallDir  string
	Env         []string
}

type installerExecutionSummary struct {
	Commands []string
	Stdout   []string
	Stderr   []string
	ExitCode *int
}

func (s Service) resolveProviderRuntime(spec ProviderSpec) providerRuntimeResolution {
	resolver := s.commandResolver()
	env := resolver.Env(nil)
	return providerRuntimeResolution{
		CLIPath:     resolveBinaryWithResolver(resolver, spec.BinaryNames, nil),
		AdapterPath: resolveBinaryWithResolver(resolver, adapterBinaryNames(spec), nil),
		Env:         env,
	}
}

func resolveBinaryWithResolver(resolver runtimecmd.Resolver, binaryNames []string, overrides []string) string {
	return resolver.ResolveBinary(binaryNames, overrides)
}

func adapterBinaryNames(spec ProviderSpec) []string {
	if len(spec.AdapterBinaryNames) > 0 {
		return cloneStrings(spec.AdapterBinaryNames)
	}
	return cloneStrings(spec.BinaryNames)
}

func (s Service) installMissingProviderRuntime(
	ctx context.Context,
	spec ProviderSpec,
	runtime providerRuntimeResolution,
) (installerExecutionSummary, providerRuntimeResolution, error) {
	summary := installerExecutionSummary{}
	current := runtime
	attemptedCLI := false
	attemptedAdapter := false
	for {
		installer, missing, installTarget := nextMissingInstaller(spec, current)
		if !missing {
			return summary, current, nil
		}
		switch installTarget {
		case "cli":
			if attemptedCLI {
				return summary, current, fmt.Errorf("provider CLI is still unavailable after install")
			}
			attemptedCLI = true
		case "adapter":
			if attemptedAdapter {
				return summary, current, fmt.Errorf("provider adapter is still unavailable after install")
			}
			attemptedAdapter = true
		}
		command, result, err := s.executeInstaller(ctx, installer, &current)
		if command != "" {
			summary.Commands = append(summary.Commands, command)
		}
		if trimmed := strings.TrimSpace(result.Stdout); trimmed != "" {
			summary.Stdout = append(summary.Stdout, trimmed)
		}
		if trimmed := strings.TrimSpace(result.Stderr); trimmed != "" {
			summary.Stderr = append(summary.Stderr, trimmed)
		}
		summary.ExitCode = intPointer(result.ExitCode)
		if err != nil {
			return summary, current, err
		}
		if result.ExitCode != 0 {
			return summary, current, nil
		}
		selectedInstallDir := current.InstallDir
		current = s.resolveProviderRuntime(spec)
		current.InstallDir = selectedInstallDir
	}
}

func nextMissingInstaller(spec ProviderSpec, runtime providerRuntimeResolution) (InstallerSpec, bool, string) {
	if strings.TrimSpace(runtime.CLIPath) == "" {
		if spec.Install.Kind == "" {
			return InstallerSpec{}, false, ""
		}
		return spec.Install, true, "cli"
	}
	if strings.TrimSpace(runtime.AdapterPath) == "" {
		if spec.AdapterInstall.Kind != "" {
			return spec.AdapterInstall, true, "adapter"
		}
		if spec.Install.Kind != "" {
			return spec.Install, true, "adapter"
		}
	}
	return InstallerSpec{}, false, ""
}

func (s Service) executeInstaller(
	ctx context.Context,
	spec InstallerSpec,
	runtime *providerRuntimeResolution,
) (string, InstallCommandResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	command := spec.displayCommand()
	if err := validateInstallerSpec(spec); err != nil {
		return command, InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	releaseLock, err := newInstallCommandLock(installerLockCommand(spec)).Acquire(ctx)
	if err != nil {
		return command, InstallCommandResult{ExitCode: 1}, err
	}
	defer releaseLock()

	installCtx, cancel := context.WithTimeout(ctx, s.installTimeout())
	defer cancel()

	runResult := func(result InstallCommandResult, runErr error) (string, InstallCommandResult, error) {
		if installCtx.Err() != nil {
			return command, result, installCtx.Err()
		}
		return command, result, runErr
	}

	switch spec.Kind {
	case InstallerKindShellCommand:
		result, err := s.installCommand(installCtx, InstallCommandInput{
			Command: spec.ShellCommand,
			Env:     s.commandResolver().Env(nil),
		})
		if err == nil && result.ExitCode == 0 {
			result = s.applyInstallerPostStep(installCtx, spec.PostInstall, result)
		}
		return runResult(result, err)
	case InstallerKindOfficialScript:
		result, err := s.runOfficialScriptInstaller(installCtx, spec)
		return runResult(result, err)
	case InstallerKindGitHubReleaseBinary:
		if runtime != nil && strings.TrimSpace(runtime.InstallDir) == "" {
			installDir, err := s.selectInstallDir()
			if err != nil {
				return command, InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
			}
			runtime.InstallDir = installDir
		}
		result, err := s.runReleaseBinaryInstaller(installCtx, spec, strings.TrimSpace(runtime.InstallDir))
		return runResult(result, err)
	default:
		return command, InstallCommandResult{ExitCode: 1, Stderr: fmt.Sprintf("unsupported installer kind %q", spec.Kind)}, nil
	}
}

func installerLockCommand(spec InstallerSpec) string {
	if spec.Kind == InstallerKindShellCommand {
		return spec.ShellCommand
	}
	return ""
}

func (s Service) runOfficialScriptInstaller(ctx context.Context, spec InstallerSpec) (InstallCommandResult, error) {
	installerFile, err := os.CreateTemp("", "tutti-agent-provider-install-*.sh")
	if err != nil {
		return InstallCommandResult{ExitCode: 1}, err
	}
	scriptPath := installerFile.Name()
	defer func() {
		_ = os.Remove(scriptPath)
	}()
	if err := installerFile.Close(); err != nil {
		return InstallCommandResult{ExitCode: 1}, err
	}
	if err := s.downloadFile(ctx, spec.ScriptURL, scriptPath); err != nil {
		return InstallCommandResult{
			ExitCode: 1,
			Stderr:   err.Error(),
		}, nil
	}
	if err := os.Chmod(scriptPath, 0o700); err != nil {
		return InstallCommandResult{
			ExitCode: 1,
			Stderr:   err.Error(),
		}, nil
	}
	return s.installCommand(ctx, InstallCommandInput{
		Command: joinShellCommand([]string{spec.ScriptShell, scriptPath}),
		Env:     s.commandResolver().Env(nil),
	})
}

func (s Service) runReleaseBinaryInstaller(
	ctx context.Context,
	spec InstallerSpec,
	installDir string,
) (InstallCommandResult, error) {
	if strings.TrimSpace(installDir) == "" {
		return InstallCommandResult{ExitCode: 1, Stderr: "install directory is required"}, nil
	}
	if err := ensureWritableInstallDir(installDir); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	asset, ok := spec.releaseAsset(runtime.GOOS, runtime.GOARCH)
	if !ok {
		return InstallCommandResult{
			ExitCode: 1,
			Stderr:   fmt.Sprintf("release binary installer asset is unavailable for %s", releaseBinaryPlatformKey(runtime.GOOS, runtime.GOARCH)),
		}, nil
	}

	archiveFile, err := os.CreateTemp("", "tutti-agent-provider-archive-*"+archiveSuffix(asset.URL))
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
	if err := s.downloadFile(ctx, asset.URL, archivePath); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	actualSHA256, err := fileSHA256(archivePath)
	if err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	if expected := normalizeSHA256(asset.SHA256); expected != "" && !strings.EqualFold(actualSHA256, expected) {
		return InstallCommandResult{ExitCode: 1, Stderr: fmt.Sprintf("downloaded release asset sha256 mismatch: want %s got %s", expected, actualSHA256)}, nil
	}

	destinationPath := filepath.Join(installDir, spec.ReleaseBinary.BinaryName)
	if err := extractReleaseBinary(archivePath, spec.ReleaseBinary.BinaryName, destinationPath); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	if err := os.Chmod(destinationPath, 0o755); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	return InstallCommandResult{
		ExitCode: 0,
		Stdout: fmt.Sprintf(
			"Installed %s %s to %s",
			spec.ReleaseBinary.BinaryName,
			spec.ReleaseBinary.Version,
			destinationPath,
		),
	}, nil
}

func (s Service) selectInstallDir() (string, error) {
	resolver := s.commandResolver()
	for _, dir := range resolver.UserBinInstallDirs(nil) {
		if err := ensureWritableInstallDir(dir); err == nil {
			return dir, nil
		}
	}
	return "", errors.New("no writable user install directory is available")
}

func ensureWritableInstallDir(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return errors.New("install directory is empty")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create install directory %s: %w", dir, err)
	}
	file, err := os.CreateTemp(dir, ".tutti-install-test-*")
	if err != nil {
		return fmt.Errorf("install directory %s is not writable: %w", dir, err)
	}
	path := file.Name()
	closeErr := file.Close()
	removeErr := os.Remove(path)
	return errors.Join(closeErr, removeErr)
}

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
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return fmt.Errorf("create release binary parent: %w", err)
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return fmt.Errorf("create release binary destination: %w", err)
	}
	_, copyErr := io.Copy(target, content)
	closeErr := target.Close()
	if mode != 0 {
		mode = mode.Perm()
		if mode == 0 {
			mode = 0o755
		}
		if chmodErr := os.Chmod(destinationPath, mode); chmodErr != nil {
			return errors.Join(copyErr, closeErr, chmodErr)
		}
	}
	return errors.Join(copyErr, closeErr)
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

func (s Service) downloadFile(ctx context.Context, sourceURL string, destinationPath string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return fmt.Errorf("create download request: %w", err)
	}
	response, err := s.httpClient().Do(request)
	if err != nil {
		return fmt.Errorf("download %s: %w", sourceURL, err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("download %s: unexpected status %d", sourceURL, response.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return fmt.Errorf("create download parent: %w", err)
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("create download destination: %w", err)
	}
	_, copyErr := io.Copy(target, response.Body)
	closeErr := target.Close()
	return errors.Join(copyErr, closeErr)
}

func (s Service) httpClient() *http.Client {
	if s.HTTPClient != nil {
		return s.HTTPClient
	}
	return http.DefaultClient
}

func joinShellCommand(parts []string) string {
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			continue
		}
		filtered = append(filtered, shellQuote(part))
	}
	return strings.Join(filtered, " ")
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if isSafeShellWord(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func isSafeShellWord(value string) bool {
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case strings.ContainsRune("@%_+=:,./-", r):
		default:
			return false
		}
	}
	return value != ""
}
