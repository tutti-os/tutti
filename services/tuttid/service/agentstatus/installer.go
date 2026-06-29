package agentstatus

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

type providerRuntimeResolution struct {
	CLIPath        string
	AdapterPath    string
	AdapterVersion string
	AdapterCommand []string
	AdapterEnv     []string
	ReasonCode     string
	InstallDir     string
	Env            []string
}

type installerExecutionSummary struct {
	Commands []string
	Stdout   []string
	Stderr   []string
	ExitCode *int
}

func (s Service) resolveProviderRuntime(ctx context.Context, spec ProviderSpec) providerRuntimeResolution {
	resolver := s.commandResolver()
	env := resolver.Env(spec.AdapterEnv)
	if strings.TrimSpace(os.Getenv("TUTTI_MOCK_AGENT_UNBOUND")) == "1" && spec.Provider == "codex" {
		return providerRuntimeResolution{Env: env}
	}
	if strings.TrimSpace(spec.ExternalRegistryID) != "" {
		return s.resolveExternalProviderRuntime(ctx, spec, resolver, env)
	}
	adapterPath := resolveBinaryWithResolver(resolver, adapterBinaryNames(spec), nil)
	return providerRuntimeResolution{
		CLIPath:        resolveBinaryWithResolver(resolver, spec.BinaryNames, nil),
		AdapterPath:    adapterPath,
		AdapterVersion: resolveAdapterPackageVersion(adapterPath, spec.AdapterPackage),
		AdapterCommand: cloneStrings(spec.AdapterCommand),
		AdapterEnv:     cloneStrings(spec.AdapterEnv),
		Env:            env,
	}
}

func (s Service) resolveExternalProviderRuntime(
	_ context.Context,
	spec ProviderSpec,
	resolver runtimecmd.Resolver,
	env []string,
) providerRuntimeResolution {
	result := providerRuntimeResolution{
		CLIPath:        resolveBinaryWithResolver(resolver, spec.BinaryNames, nil),
		AdapterCommand: cloneStrings(spec.AdapterCommand),
		AdapterEnv:     cloneStrings(spec.AdapterEnv),
		ReasonCode:     spec.AdapterUnavailableReasonCode,
		Env:            env,
	}
	if spec.AdapterInstall.RegistryNPM != nil {
		npm := spec.AdapterInstall.RegistryNPM
		result.AdapterPath = strings.TrimSpace(npm.PackageDir)
		result.AdapterVersion = installedNPMPackageVersion(npm.PackageDir, spec.AdapterPackage.Name)
		if result.AdapterVersion == "" || len(spec.AdapterCommand) == 0 {
			result.AdapterPath = ""
		}
		return result
	}
	if len(spec.AdapterCommand) > 0 {
		path := strings.TrimSpace(spec.AdapterCommand[0])
		if path != "" && s.executableFile(path) {
			result.AdapterPath = path
			result.AdapterVersion = spec.AdapterPackage.Version
		}
	}
	return result
}

func resolveAdapterPackageVersion(adapterPath string, requirement AdapterPackageRequirement) string {
	if strings.TrimSpace(adapterPath) == "" || strings.TrimSpace(requirement.Name) == "" {
		return ""
	}
	packageJSONPath := findAdapterPackageJSON(adapterPath, requirement.Name)
	if packageJSONPath == "" {
		return ""
	}
	content, err := os.ReadFile(packageJSONPath)
	if err != nil {
		return ""
	}
	var manifest struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return ""
	}
	if strings.TrimSpace(manifest.Name) != strings.TrimSpace(requirement.Name) {
		return ""
	}
	return strings.TrimSpace(manifest.Version)
}

func findAdapterPackageJSON(adapterPath string, packageName string) string {
	resolvedPath := strings.TrimSpace(adapterPath)
	if resolved, err := filepath.EvalSymlinks(resolvedPath); err == nil {
		resolvedPath = resolved
	}
	dir := filepath.Dir(resolvedPath)
	for range 8 {
		candidate := filepath.Join(dir, "package.json")
		if packageJSONHasName(candidate, packageName) {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

func packageJSONHasName(path string, packageName string) bool {
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var manifest struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return false
	}
	return strings.TrimSpace(manifest.Name) == strings.TrimSpace(packageName)
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
		installer, missing, installTarget := s.nextMissingInstaller(spec, current)
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
		slog.Info(
			"agent provider install step started",
			"provider", spec.Provider,
			"target", installTarget,
			"installerKind", installer.Kind,
			"command", installer.displayCommand(),
			"cliPath", current.CLIPath,
			"adapterPath", current.AdapterPath,
			"adapterVersion", current.AdapterVersion,
			"installDir", current.InstallDir,
		)
		setActiveAction(ctx, spec.Provider, ActiveAction{
			ID:     ActionInstall,
			Status: "running",
			Step:   installTarget,
		})
		command, result, err := s.executeInstaller(ctx, spec.Provider, installer, &current)
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
			slog.Warn(
				"agent provider install step failed to run",
				"provider", spec.Provider,
				"target", installTarget,
				"installerKind", installer.Kind,
				"command", command,
				"exitCode", result.ExitCode,
				"stdout", trimActionOutput(result.Stdout),
				"stderr", trimActionOutput(result.Stderr),
				"error", err,
			)
			return summary, current, err
		}
		if result.ExitCode != 0 {
			slog.Warn(
				"agent provider install step failed",
				"provider", spec.Provider,
				"target", installTarget,
				"installerKind", installer.Kind,
				"command", command,
				"exitCode", result.ExitCode,
				"stdout", trimActionOutput(result.Stdout),
				"stderr", trimActionOutput(result.Stderr),
			)
			return summary, current, nil
		}
		slog.Info(
			"agent provider install step completed",
			"provider", spec.Provider,
			"target", installTarget,
			"installerKind", installer.Kind,
			"command", command,
			"exitCode", result.ExitCode,
			"stdout", trimActionOutput(result.Stdout),
			"stderr", trimActionOutput(result.Stderr),
		)
		selectedInstallDir := current.InstallDir
		resolvedSpec, _ := s.resolveProviderSpec(ctx, spec, false)
		current = s.resolveProviderRuntime(ctx, resolvedSpec)
		current.InstallDir = selectedInstallDir
		slog.Info(
			"agent provider install step rechecked runtime",
			"provider", spec.Provider,
			"target", installTarget,
			"cliPath", current.CLIPath,
			"adapterPath", current.AdapterPath,
			"adapterVersion", current.AdapterVersion,
			"installDir", current.InstallDir,
		)
	}
}

func (s Service) nextMissingInstaller(spec ProviderSpec, runtime providerRuntimeResolution) (InstallerSpec, bool, string) {
	if strings.TrimSpace(runtime.CLIPath) == "" {
		if spec.Install.Kind == "" {
			return InstallerSpec{}, false, ""
		}
		return spec.Install, true, "cli"
	}
	if s.providerCLIRequiresInstall(spec, runtime) {
		if spec.Install.Kind == "" {
			return InstallerSpec{}, false, ""
		}
		return spec.Install, true, "cli"
	}
	if strings.TrimSpace(runtime.AdapterPath) == "" {
		if spec.AdapterInstall.Kind != "" {
			return spec.AdapterInstall, true, "adapter"
		}
		if strings.TrimSpace(spec.ExternalRegistryID) != "" {
			return InstallerSpec{}, false, ""
		}
		if spec.Install.Kind != "" {
			return spec.Install, true, "adapter"
		}
	}
	if !adapterPackageRequirementSatisfied(spec.AdapterPackage, runtime.AdapterVersion) {
		if spec.AdapterInstall.Kind != "" {
			return spec.AdapterInstall, true, "adapter"
		}
		if strings.TrimSpace(spec.ExternalRegistryID) != "" {
			return InstallerSpec{}, false, ""
		}
		if spec.Install.Kind != "" {
			return spec.Install, true, "adapter"
		}
	}
	return InstallerSpec{}, false, ""
}

func (s Service) providerCLIRequiresInstall(spec ProviderSpec, runtime providerRuntimeResolution) bool {
	if spec.Provider != agentprovider.Codex {
		return false
	}
	if !s.codexPlatformBinaryOK(runtime.CLIPath) {
		return true
	}
	return !codexVersionMeetsMinimum(s.cliVersion(context.Background(), runtime.CLIPath))
}

func adapterPackageRequirementSatisfied(requirement AdapterPackageRequirement, version string) bool {
	requiredVersion := strings.TrimSpace(requirement.Version)
	if requiredVersion == "" {
		return true
	}
	return strings.TrimSpace(version) == requiredVersion
}

func (s Service) executeInstaller(
	ctx context.Context,
	provider string,
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
			Command:  spec.ShellCommand,
			Env:      s.commandResolver().Env(nil),
			OnStdout: activeActionStdoutAppender(ctx, provider),
		})
		if err == nil && result.ExitCode == 0 {
			result = s.applyInstallerPostStep(installCtx, spec, result)
		}
		return runResult(result, err)
	case InstallerKindOfficialScript:
		result, err := s.runOfficialScriptInstaller(installCtx, provider, spec)
		return runResult(result, err)
	case InstallerKindGitHubReleaseBinary:
		installDir := ""
		if spec.ReleaseBinary != nil {
			installDir = strings.TrimSpace(spec.ReleaseBinary.InstallDir)
		}
		if runtime != nil && strings.TrimSpace(runtime.InstallDir) != "" {
			installDir = strings.TrimSpace(runtime.InstallDir)
		}
		if installDir == "" {
			installDir, err = s.selectInstallDir()
			if err != nil {
				return command, InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
			}
			if runtime != nil {
				runtime.InstallDir = installDir
			}
		} else if runtime != nil {
			runtime.InstallDir = installDir
		}
		result, err := s.runReleaseBinaryInstaller(installCtx, spec, installDir)
		return runResult(result, err)
	case InstallerKindCodexCLILatest:
		result, err := s.runCodexCLILatestInstaller(installCtx, spec, "")
		return runResult(result, err)
	case InstallerKindExternalAgentRegistryNPM:
		result, err := s.runExternalAgentRegistryNPMInstaller(installCtx, provider, spec)
		if err == nil && result.ExitCode == 0 {
			result = s.applyInstallerPostStep(installCtx, spec, result)
		}
		return runResult(result, err)
	default:
		return command, InstallCommandResult{ExitCode: 1, Stderr: fmt.Sprintf("unsupported installer kind %q", spec.Kind)}, nil
	}
}

func installerLockCommand(spec InstallerSpec) string {
	if spec.Kind == InstallerKindShellCommand {
		return spec.ShellCommand
	}
	if spec.Kind == InstallerKindExternalAgentRegistryNPM && spec.RegistryNPM != nil {
		return strings.Join([]string{
			string(spec.Kind),
			strings.TrimSpace(spec.RegistryNPM.AgentID),
			strings.TrimSpace(spec.RegistryNPM.Package),
			strings.TrimSpace(spec.RegistryNPM.PrefixDir),
		}, ":")
	}
	return ""
}

func (s Service) runOfficialScriptInstaller(ctx context.Context, provider string, spec InstallerSpec) (InstallCommandResult, error) {
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
		Command:  joinShellCommand([]string{spec.ScriptShell, scriptPath}),
		Env:      s.commandResolver().Env(nil),
		OnStdout: activeActionStdoutAppender(ctx, provider),
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
	platformKey := releaseBinaryPlatformKey(runtime.GOOS, runtime.GOARCH)
	slog.Info(
		"agent provider release binary install asset selected",
		"binary", spec.ReleaseBinary.BinaryName,
		"version", spec.ReleaseBinary.Version,
		"platform", platformKey,
		"installDir", installDir,
		"url", asset.URL,
	)

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

func (s Service) runExternalAgentRegistryNPMInstaller(ctx context.Context, provider string, spec InstallerSpec) (InstallCommandResult, error) {
	if spec.RegistryNPM == nil {
		return InstallCommandResult{ExitCode: 1, Stderr: "external agent registry npm installer config is required"}, nil
	}
	npmSpec := spec.RegistryNPM
	if err := os.MkdirAll(npmSpec.PrefixDir, 0o755); err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	appRuntime, err := s.managedRuntimeResolver().Resolve(ctx)
	if err != nil {
		return InstallCommandResult{ExitCode: 1, Stderr: err.Error()}, nil
	}
	packageSpec := boundedNPMPackageSpec(npmSpec.Package)
	command := joinShellCommand([]string{
		appRuntime.NPM,
		"--prefix",
		npmSpec.PrefixDir,
		"install",
		packageSpec,
	})
	baseEnv := managedruntime.ProcessEnv(append(appRuntime.EnvOverrides, envMapToList(npmSpec.Env)...)...)
	// Use a dedicated, tutti-owned npm cache inside the install prefix rather than
	// the user's global ~/.npm, which on some machines holds root-owned files that
	// make every user-mode npm install fail with EACCES before any registry is hit.
	baseEnv = withAgentNPMCache(baseEnv, filepath.Join(npmSpec.PrefixDir, agentNPMCacheDirName))

	// Try official npm first (fastest when reachable), then fall back through the
	// CN-available mirrors when it is slow or blocked. Each attempt is bounded so a
	// blocked registry fails over quickly instead of consuming the whole budget;
	// the npm_config_registry value selects the source.
	registries := s.agentNPMRegistries()
	var result InstallCommandResult
	for i, registry := range registries {
		setActiveAction(ctx, provider, ActiveAction{
			ID:       ActionInstall,
			Status:   "running",
			Step:     "adapter",
			Registry: displayNPMRegistry(registry),
		})
		env := withAgentNPMRegistry(slices.Clone(baseEnv), registry)
		attemptCtx, cancel := context.WithTimeout(ctx, perRegistryInstallTimeout)
		result, err = s.installCommand(attemptCtx, InstallCommandInput{
			Command:  command,
			Env:      env,
			OnStdout: activeActionStdoutAppender(ctx, provider),
		})
		cancel()
		if err == nil && result.ExitCode == 0 {
			return result, nil
		}
		if i < len(registries)-1 {
			slog.Warn(
				"agent adapter npm install failed on registry, trying next",
				"registry", registry,
				"exitCode", result.ExitCode,
				"error", err,
			)
		}
	}
	return result, err
}

func (s Service) selectInstallDir() (string, error) {
	resolver := s.commandResolver()
	// Prefer a stable, user-global location (~/.local/bin, then ~/bin) so
	// installed binaries survive toolchain/version-manager churn and never
	// land in a volatile or app-scoped PATH entry (e.g. a node-version
	// manager's bin dir that disappears when that version is removed). These
	// dirs are always searched by the resolver's knownExecutableDirs, so the
	// binary stays discoverable even when ~/.local/bin is not on PATH.
	if home, err := s.homeDir(); err == nil && strings.TrimSpace(home) != "" {
		for _, dir := range []string{
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "bin"),
		} {
			if err := ensureWritableInstallDir(dir); err == nil {
				return dir, nil
			}
		}
	}
	// Fall back to the first writable directory already on the user's PATH.
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

func (s Service) httpClient() *http.Client {
	if s.HTTPClient != nil {
		return s.HTTPClient
	}
	// Route downloads (codex CLI package, claude install.sh, release binaries)
	// through the macOS system proxy. This is an in-process HTTP call, so it
	// cannot inherit the proxy env we inject into spawned children — resolve it
	// directly. Prefers an explicit env proxy, falls back to the system proxy.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = runtimecmd.HTTPProxyFunc()
	return &http.Client{Transport: transport}
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
