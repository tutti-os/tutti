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
	parent := filepath.Dir(plan.InstallRoot)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fmt.Errorf("%w: create runtime parent: %w", ErrRuntimeInstallFailed, err)
	}
	staging, err := os.MkdirTemp(parent, ".runtime-install-")
	if err != nil {
		return fmt.Errorf("%w: create staging directory: %w", ErrRuntimeInstallFailed, err)
	}
	defer os.RemoveAll(staging)
	scratch, err := os.MkdirTemp(parent, ".runtime-install-work-")
	if err != nil {
		return fmt.Errorf("%w: create installer work directory: %w", ErrRuntimeInstallFailed, err)
	}
	defer os.RemoveAll(scratch)

	command := replaceInstallRoot(plan.InstallCommand, plan.InstallRoot, staging)
	if len(command) == 0 || command[0] != plan.Runner {
		return fmt.Errorf("%w: runner identity changed", ErrRuntimeInstallFailed)
	}
	if err := update(SetupPhaseInstalling); err != nil {
		return err
	}
	installCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	runner := s.Runner
	if runner == nil {
		runner = localInstallCommandRunner{}
	}
	installEnvironment := cleanInstallEnvironment(scratch)
	if plan.Runner == "uv" {
		installEnvironment = append(installEnvironment,
			"UV_TOOL_DIR="+filepath.Join(staging, "tool"),
			"UV_TOOL_BIN_DIR="+filepath.Join(staging, "bin"),
		)
	}
	if err := runner.Run(installCtx, command, scratch, installEnvironment); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}

	if err := update(SetupPhaseVerifying); err != nil {
		return err
	}
	stagedExecutable := strings.Replace(plan.Executable, plan.InstallRoot, staging, 1)
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
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: installed executable is not an ordinary file", ErrRuntimeVerifyFailed)
	}
	var profile DiscoveryProfile
	if err := readJSON(filepath.Join(installation.PackageDir, installation.Manifest.Profiles.Discovery), &profile); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	version, err := compatibleInstalledVersion(ctx, realExecutable, profile)
	if err != nil {
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

	if err := update(SetupPhaseActivating); err != nil {
		return err
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
	activation.ExecutableFingerprint, err = fingerprintRuntimeExecutable(realExecutable)
	if err != nil {
		return fmt.Errorf("%w: fingerprint installed executable: %w", ErrRuntimeActivateFailed, err)
	}
	if err := writeJSONAtomic(filepath.Join(staging, "activation.json"), activation); err != nil {
		return fmt.Errorf("%w: write activation: %w", ErrRuntimeActivateFailed, err)
	}
	entry, err := s.Plans.Manager.managedRuntimeEntry(installation, plan.InstallRoot, plan.Executable, activation.ExecutableRelativePath)
	if err != nil {
		return fmt.Errorf("%w: derive user executable entry: %w", ErrRuntimeActivateFailed, err)
	}
	if err := activateManagedRuntime(installation, staging, plan, s.Plans.Manager.RuntimeInstallDir, entry); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeActivateFailed, err)
	}
	return nil
}

func compatibleInstalledVersion(ctx context.Context, executable string, profile DiscoveryProfile) (string, error) {
	var lastErr error
	for _, candidate := range profile.Candidates {
		version, err := runtimeVersion(ctx, executable, candidate.Version.Args, candidate.Version.Constraint)
		if err == nil {
			return version, nil
		}
		lastErr = err
	}
	return "", fmt.Errorf("installed runtime version is incompatible: %w", lastErr)
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

func activateManagedRuntime(installation Installation, staging string, plan InstallPlan, runtimeInstallDir string, entry managedRuntimeEntry) error {
	finalRoot := plan.InstallRoot
	if err := validateManagedRuntimeRoot(finalRoot, runtimeInstallDir, installation.AgentKey, plan.RuntimeIdentity); err != nil {
		return err
	}
	if err := validateManagedRuntimeEntry(entry); err != nil {
		return err
	}
	backup := finalRoot + ".previous"
	_ = os.RemoveAll(backup)
	hadPrevious := false
	if _, err := os.Lstat(finalRoot); err == nil {
		if err := os.Rename(finalRoot, backup); err != nil {
			return err
		}
		hadPrevious = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(staging, finalRoot); err != nil {
		if hadPrevious {
			_ = os.Rename(backup, finalRoot)
		}
		return err
	}
	if err := publishManagedRuntimeEntry(entry); err != nil {
		_ = os.RemoveAll(finalRoot)
		if hadPrevious {
			_ = os.Rename(backup, finalRoot)
		}
		return err
	}
	_ = os.RemoveAll(backup)
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
