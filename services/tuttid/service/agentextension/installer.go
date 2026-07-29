package agentextension

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

var (
	ErrRuntimeInstallFailed  = errors.New("agent target runtime install failed")
	ErrRuntimeVerifyFailed   = errors.New("agent target runtime verification failed")
	ErrRuntimeProbeFailed    = errors.New("agent target runtime ACP probe failed")
	ErrRuntimeActivateFailed = errors.New("agent target runtime activation failed")
)

type InstallCommandRunner interface {
	Run(context.Context, []string, string, []string) error
}

type localInstallCommandRunner struct{}

func (localInstallCommandRunner) Run(ctx context.Context, command []string, cwd string, env []string) error {
	if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
		return errors.New("install command is required")
	}
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = cwd
	cmd.Env = env
	output := &boundedBuffer{limit: 128 << 10}
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return fmt.Errorf("install command %s failed: %[1]s is not installed or not on the daemon PATH", filepath.Base(command[0]))
		}
		return fmt.Errorf("install command %s failed: %w", filepath.Base(command[0]), err)
	}
	return nil
}

type boundedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (w *boundedBuffer) Write(value []byte) (int, error) {
	written := len(value)
	remaining := w.limit - w.buffer.Len()
	if remaining > 0 {
		if len(value) > remaining {
			value = value[:remaining]
		}
		_, _ = w.buffer.Write(value)
	}
	return written, nil
}

func (s *SetupService) executeInstall(
	ctx context.Context,
	plan InstallPlan,
	discoveryRoot string,
	update func(SetupActionPhase) error,
) error {
	if s.Plans.Manager == nil {
		return errors.New("agent extension manager is not configured")
	}
	installation, err := s.Plans.Manager.loadInstallationByID(plan.ExtensionInstallationID)
	if err != nil {
		return err
	}
	if plan.Runner != installation.Manifest.Runtime.Install.Runner ||
		plan.PublishUserCommand != publishesUserCommand(installation.Manifest) {
		return fmt.Errorf("%w: runtime install contract changed", ErrRuntimeInstallFailed)
	}
	if plan.Runner == "uv" {
		return s.executeUVInstallInPlace(ctx, installation, plan, discoveryRoot, update)
	}
	workspace, err := openManagedRuntimeWorkspaceForInstall(
		s.Plans.Manager.RuntimeInstallDir,
		installation.AgentKey,
		plan.Runner != "binary",
	)
	if err != nil {
		return fmt.Errorf("%w: open managed runtime workspace: %w", ErrRuntimeInstallFailed, err)
	}
	defer workspace.Close()
	stagingDir, err := workspace.createTemp(".runtime-install-")
	if err != nil {
		return fmt.Errorf("%w: create staging directory: %w", ErrRuntimeInstallFailed, err)
	}
	defer stagingDir.Close()
	stagingName := stagingDir.name
	defer func() { _ = workspace.remove(stagingName) }()
	staging := stagingDir.path
	scratchDir, err := workspace.createTemp(".runtime-install-work-")
	if err != nil {
		return fmt.Errorf("%w: create installer work directory: %w", ErrRuntimeInstallFailed, err)
	}
	defer scratchDir.Close()
	scratchName := scratchDir.name
	defer func() { _ = workspace.remove(scratchName) }()
	scratch := scratchDir.path

	if err := update(SetupPhaseInstalling); err != nil {
		return err
	}
	installCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	if err := stagingDir.verify(); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}
	if err := scratchDir.verify(); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}
	stagedExecutable, err := stagedRuntimeExecutable(plan, staging)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}
	var verifiedFingerprint runtimeExecutableFingerprint
	if plan.Runner == "binary" {
		artifact, err := verifiedPlanBinaryArtifact(installation, plan)
		if err != nil {
			return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
		}
		relativeExecutable, err := filepath.Rel(staging, stagedExecutable)
		if err != nil {
			return fmt.Errorf("%w: derive staged binary path: %w", ErrRuntimeInstallFailed, err)
		}
		destination, err := stagingDir.createFile(relativeExecutable, 0o600)
		if err != nil {
			return fmt.Errorf("%w: create staged binary without following links: %w", ErrRuntimeInstallFailed, err)
		}
		verifiedFingerprint, err = downloadRuntimeBinaryToFile(installCtx, s.Plans.Manager.Client, artifact, destination)
		closeErr := destination.Close()
		if err != nil {
			return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
		}
		if closeErr != nil {
			return fmt.Errorf("%w: close staged binary: %w", ErrRuntimeInstallFailed, closeErr)
		}
		if err := validateNativeExecutablePlatform(stagedExecutable, plan.Platform); err != nil {
			return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
		}
	} else {
		command := replaceInstallRoot(plan.InstallCommand, plan.InstallRoot, staging)
		if len(command) == 0 || command[0] != plan.Runner {
			return fmt.Errorf("%w: runner identity changed", ErrRuntimeInstallFailed)
		}
		runner := s.Runner
		if runner == nil {
			runner = localInstallCommandRunner{}
		}
		if err := runner.Run(installCtx, command, scratch, cleanInstallEnvironment(scratch)); err != nil {
			return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
		}
	}
	if err := stagingDir.verify(); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}
	if err := scratchDir.verify(); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}

	if err := update(SetupPhaseVerifying); err != nil {
		return err
	}
	if err := stagingDir.verify(); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	realExecutable, err := filepath.EvalSymlinks(stagedExecutable)
	if err != nil {
		return fmt.Errorf("%w: resolve installed executable: %w", ErrRuntimeVerifyFailed, err)
	}
	realStaging, err := filepath.EvalSymlinks(staging)
	if err != nil {
		return fmt.Errorf("%w: resolve staging root: %w", ErrRuntimeVerifyFailed, err)
	}
	if !pathWithin(realExecutable, realStaging) {
		return fmt.Errorf("%w: installed executable escapes staging root", ErrRuntimeVerifyFailed)
	}
	info, err := os.Lstat(realExecutable)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 {
		return fmt.Errorf("%w: installed executable is not an ordinary file", ErrRuntimeVerifyFailed)
	}
	if verifiedFingerprint.SHA256 == "" {
		verifiedFingerprint, err = fingerprintRuntimeExecutable(realExecutable)
		if err != nil {
			return fmt.Errorf("%w: fingerprint installed executable: %w", ErrRuntimeVerifyFailed, err)
		}
	}
	if err := verifyRuntimeExecutableUnchanged(realExecutable, verifiedFingerprint); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	var profile DiscoveryProfile
	if err := readJSON(filepath.Join(installation.PackageDir, installation.Manifest.Profiles.Discovery), &profile); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	var versionIdentity *agentruntime.ExecutableIdentity
	if plan.Runner == "binary" {
		versionIdentity = executableIdentity(verifiedFingerprint)
	}
	version, err := compatibleInstalledVersion(ctx, realExecutable, profile, versionIdentity)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	if plan.Runner == "binary" && version != plan.PackageVersion {
		return fmt.Errorf("%w: installed binary version %s does not match signed artifact version %s", ErrRuntimeVerifyFailed, version, plan.PackageVersion)
	}
	if err := verifyRuntimeExecutableUnchanged(realExecutable, verifiedFingerprint); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}

	if err := update(SetupPhaseProbing); err != nil {
		return err
	}
	launchArgs := resolveRuntimeArguments(installation.Manifest.Runtime.Launch.Args, discoveryRoot, staging)
	binding, err := s.Plans.Manager.runtimeBinding(
		installation, append([]string{realExecutable}, launchArgs...), version, "managed",
	)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeProbeFailed, err)
	}
	if _, err := ProbeRuntime(ctx, binding, plan.AgentTargetID, discoveryRoot, s.Transport, s.Host); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeProbeFailed, err)
	}
	if err := verifyRuntimeExecutableUnchanged(realExecutable, verifiedFingerprint); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeProbeFailed, err)
	}

	if err := update(SetupPhaseActivating); err != nil {
		return err
	}
	if err := stagingDir.verify(); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeActivateFailed, err)
	}
	relativeExecutable, err := filepath.Rel(realStaging, realExecutable)
	if err != nil || relativeExecutable == "." || strings.HasPrefix(relativeExecutable, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: installed executable path is invalid", ErrRuntimeActivateFailed)
	}
	activation := managedRuntimeActivation{
		SchemaVersion: managedRuntimeActivationSchema, ExtensionInstallationID: installation.ID,
		RuntimeIdentity: plan.RuntimeIdentity, PackageName: plan.PackageName, PackageVersion: plan.PackageVersion,
		ExecutableRelativePath: filepath.ToSlash(relativeExecutable), InstalledAt: time.Now().UTC(),
	}
	activation.ExecutableFingerprint = verifiedFingerprint
	if err := stagingDir.writeJSONAtomic("activation.json", activation); err != nil {
		return fmt.Errorf("%w: write activation: %w", ErrRuntimeActivateFailed, err)
	}
	var entry *managedRuntimeEntry
	if plan.PublishUserCommand {
		value, err := s.Plans.Manager.managedRuntimeEntry(installation, plan.InstallRoot, plan.Executable, activation.ExecutableRelativePath)
		if err != nil {
			return fmt.Errorf("%w: derive user executable entry: %w", ErrRuntimeActivateFailed, err)
		}
		entry = &value
	}
	if err := activateManagedRuntime(installation, workspace, stagingDir, plan, s.Plans.Manager.RuntimeInstallDir, entry, activation); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeActivateFailed, err)
	}
	return nil
}

func stagedRuntimeExecutable(plan InstallPlan, staging string) (string, error) {
	relative, err := filepath.Rel(filepath.Clean(plan.InstallRoot), filepath.Clean(plan.Executable))
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("runtime executable escapes install root")
	}
	result := filepath.Join(staging, relative)
	if !pathWithin(result, staging) {
		return "", errors.New("staged runtime executable escapes staging root")
	}
	return result, nil
}

func verifiedPlanBinaryArtifact(installation Installation, plan InstallPlan) (RuntimeBinaryArtifact, error) {
	if plan.Artifact == nil || plan.Platform != runtimePlatform() {
		return RuntimeBinaryArtifact{}, errors.New("binary artifact plan is unavailable for this platform")
	}
	artifact, err := runtimeBinaryArtifactForPlatform(installation.Manifest, plan.Platform)
	if err != nil {
		return RuntimeBinaryArtifact{}, err
	}
	if artifact != *plan.Artifact || plan.PackageVersion != artifact.Version ||
		len(plan.InstallCommand) != 2 || plan.InstallCommand[0] != "download" || plan.InstallCommand[1] != artifact.URL {
		return RuntimeBinaryArtifact{}, errors.New("binary artifact plan changed")
	}
	return artifact, nil
}

func compatibleInstalledVersion(
	ctx context.Context,
	executable string,
	profile DiscoveryProfile,
	identity *agentruntime.ExecutableIdentity,
) (string, error) {
	var lastErr error
	for _, candidate := range profile.Candidates {
		version, err := runtimeVersionWithIdentity(ctx, executable, candidate.Version.Args, candidate.Version.Constraint, identity)
		if err == nil {
			return version, nil
		}
		lastErr = err
	}
	return "", fmt.Errorf("installed runtime version is incompatible: %w", lastErr)
}

func executableIdentity(fingerprint runtimeExecutableFingerprint) *agentruntime.ExecutableIdentity {
	return &agentruntime.ExecutableIdentity{SHA256: fingerprint.SHA256, SizeBytes: fingerprint.Size}
}

func replaceInstallRoot(values []string, from, to string) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = strings.ReplaceAll(value, from, to)
	}
	return result
}

func cleanInstallEnvironment(scratch string) []string {
	allowed := []string{
		"PATH", "HOME", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
	}
	result := make([]string, 0, len(allowed)+5)
	for _, key := range allowed {
		if value, ok := os.LookupEnv(key); ok {
			result = append(result, key+"="+value)
		}
	}
	return append(result,
		"npm_config_cache="+filepath.Join(scratch, "npm-cache"),
		"npm_config_userconfig="+filepath.Join(scratch, "user.npmrc"),
		"npm_config_globalconfig="+filepath.Join(scratch, "global.npmrc"),
		"npm_config_update_notifier=false", "npm_config_fund=false", "npm_config_audit=false", "npm_config_global=false",
	)
}

func activateManagedRuntime(
	installation Installation,
	workspace *managedRuntimeWorkspace,
	staging *managedRuntimeDirectory,
	plan InstallPlan,
	runtimeInstallDir string,
	entry *managedRuntimeEntry,
	activation managedRuntimeActivation,
) error {
	return activateManagedRuntimeWithCrashInjection(
		installation, workspace, staging, plan, runtimeInstallDir, entry, activation, nil,
	)
}

type managedRuntimeRenameBoundary string

const (
	managedRuntimeAfterBackupRename    managedRuntimeRenameBoundary = "after-backup-rename"
	managedRuntimeAfterPromotionRename managedRuntimeRenameBoundary = "after-promotion-rename"
)

func activateManagedRuntimeWithCrashInjection(
	installation Installation,
	workspace *managedRuntimeWorkspace,
	staging *managedRuntimeDirectory,
	plan InstallPlan,
	runtimeInstallDir string,
	entry *managedRuntimeEntry,
	activation managedRuntimeActivation,
	injectCrash func(managedRuntimeRenameBoundary) error,
) error {
	finalRoot := plan.InstallRoot
	if err := validateManagedRuntimeRoot(finalRoot, runtimeInstallDir, installation.AgentKey, plan.RuntimeIdentity); err != nil {
		return err
	}
	if entry != nil {
		if err := validateManagedRuntimeEntry(*entry); err != nil {
			return err
		}
	}
	if workspace == nil || staging == nil || staging.workspace != workspace {
		return errors.New("managed runtime activation workspace is invalid")
	}
	if err := staging.verify(); err != nil {
		return err
	}
	if filepath.Dir(finalRoot) != workspace.agentPath || filepath.Base(finalRoot) != plan.RuntimeIdentity {
		return errors.New("managed runtime activation root does not match workspace handle")
	}
	backupName := plan.RuntimeIdentity + ".previous"
	var recoveryExpectation *managedRuntimeRecoveryExpectation
	if plan.Runner == "binary" {
		artifact, err := verifiedPlanBinaryArtifact(installation, plan)
		if err != nil {
			return err
		}
		recoveryExpectation, err = binaryRuntimeRecoveryExpectation(
			installation,
			plan.RuntimeIdentity,
			plan.PackageName,
			plan.PackageVersion,
			activation.ExecutableRelativePath,
			&artifact,
		)
		if err != nil {
			return err
		}
		if err := recoverInterruptedBinaryActivation(workspace, recoveryExpectation); err != nil {
			return err
		}
	} else {
		_ = workspace.remove(backupName)
	}
	hadPrevious := false
	if _, err := os.Lstat(finalRoot); err == nil {
		previous, openErr := workspace.openDirectory(finalRoot)
		if openErr != nil {
			return fmt.Errorf("existing managed runtime root is unsafe: %w", openErr)
		}
		previous.Close()
		if err := workspace.rename(plan.RuntimeIdentity, backupName); err != nil {
			return err
		}
		hadPrevious = true
		if injectCrash != nil {
			if err := injectCrash(managedRuntimeAfterBackupRename); err != nil {
				return err
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := workspace.rename(staging.name, plan.RuntimeIdentity); err != nil {
		if hadPrevious {
			_ = workspace.rename(backupName, plan.RuntimeIdentity)
		}
		return err
	}
	staging.path = finalRoot
	staging.name = plan.RuntimeIdentity
	if injectCrash != nil {
		if err := injectCrash(managedRuntimeAfterPromotionRename); err != nil {
			return err
		}
	}
	if err := staging.verify(); err != nil {
		_ = workspace.remove(plan.RuntimeIdentity)
		if hadPrevious {
			_ = workspace.rename(backupName, plan.RuntimeIdentity)
		}
		return err
	}
	finalExecutable := filepath.Join(finalRoot, filepath.FromSlash(activation.ExecutableRelativePath))
	if err := verifyRuntimeExecutableUnchanged(finalExecutable, activation.ExecutableFingerprint); err != nil {
		_ = workspace.remove(plan.RuntimeIdentity)
		if hadPrevious {
			_ = workspace.rename(backupName, plan.RuntimeIdentity)
		}
		return err
	}
	if entry != nil {
		if err := publishManagedRuntimeEntry(*entry); err != nil {
			_ = workspace.remove(plan.RuntimeIdentity)
			if hadPrevious {
				_ = workspace.rename(backupName, plan.RuntimeIdentity)
			}
			return err
		}
	}
	_ = workspace.remove(backupName)
	return nil
}

func installErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrRuntimeInstallFailed):
		return "install_failed"
	case errors.Is(err, ErrRuntimeVerifyFailed):
		return "version_check_failed"
	case errors.Is(err, ErrRuntimeProbeFailed):
		return "acp_probe_failed"
	case errors.Is(err, ErrRuntimeActivateFailed):
		return "activation_failed"
	default:
		return "setup_failed"
	}
}
