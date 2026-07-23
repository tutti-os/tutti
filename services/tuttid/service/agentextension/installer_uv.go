package agentextension

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// executeUVInstallInPlace installs uv-runner runtimes directly into the final
// install root. Unlike npm/pnpm packages, uv tool environments embed absolute
// paths (bin symlinks, venv shebangs, pyvenv.cfg) and cannot survive the
// stage-then-rename activation model, so the install happens in place with an
// explicit backup/rollback boundary:
//
//  1. A previously committed root (valid activation.json) is moved aside to
//     "<identity>.previous"; an uncommitted partial root is discarded.
//  2. `uv tool install` runs with UV_TOOL_DIR/UV_TOOL_BIN_DIR/
//     UV_PYTHON_INSTALL_DIR pointing inside the final root and UV_CACHE_DIR in
//     the shared content-addressed toolchain cache.
//  3. The usual fingerprint/version/ACP-probe verification runs against the
//     final root; activation.json remains the commit marker.
//  4. Any failure removes the new root and restores the backup.
func (s *SetupService) executeUVInstallInPlace(
	ctx context.Context,
	installation Installation,
	plan InstallPlan,
	discoveryRoot string,
	update func(SetupActionPhase) error,
) error {
	manager := s.Plans.Manager
	workspace, err := openManagedRuntimeWorkspaceForInstall(manager.RuntimeInstallDir, installation.AgentKey, true)
	if err != nil {
		return fmt.Errorf("%w: open managed runtime workspace: %w", ErrRuntimeInstallFailed, err)
	}
	defer workspace.Close()
	finalRoot := plan.InstallRoot
	if err := validateManagedRuntimeRoot(finalRoot, manager.RuntimeInstallDir, installation.AgentKey, plan.RuntimeIdentity); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}
	finalName := plan.RuntimeIdentity
	backupName := finalName + ".previous"

	uvResolver := s.UVToolchain
	if uvResolver == nil {
		uvResolver = resolveManagedUVToolchain
	}
	uvDir, err := uvResolver(ctx, manager.Client, manager.RuntimeInstallDir)
	if err != nil {
		return fmt.Errorf("%w: resolve managed uv toolchain: %w", ErrRuntimeInstallFailed, err)
	}

	scratchDir, err := workspace.createTemp(".runtime-install-work-")
	if err != nil {
		return fmt.Errorf("%w: create installer work directory: %w", ErrRuntimeInstallFailed, err)
	}
	defer scratchDir.Close()
	scratchName := scratchDir.name
	defer func() { _ = workspace.remove(scratchName) }()
	scratch := scratchDir.path

	var profile DiscoveryProfile
	if err := readJSON(filepath.Join(installation.PackageDir, installation.Manifest.Profiles.Discovery), &profile); err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}

	// Classify the existing root by commit state. A missing root with a
	// self-consistent backup restores the backup instead of reinstalling.
	restored := false
	hadPrevious := false
	if _, err := os.Lstat(finalRoot); errors.Is(err, os.ErrNotExist) {
		if _, ok := uvCommittedActivation(workspace, backupName, plan); ok {
			if err := workspace.rename(backupName, finalName); err != nil {
				return fmt.Errorf("%w: restore previous managed runtime: %w", ErrRuntimeInstallFailed, err)
			}
			restored = true
		}
	} else if err != nil {
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}
	if !restored {
		_ = workspace.remove(backupName)
		if _, err := os.Lstat(finalRoot); err == nil {
			if _, committed := uvCommittedActivation(workspace, finalName, plan); !committed {
				if err := workspace.remove(finalName); err != nil {
					return fmt.Errorf("%w: remove uncommitted managed runtime: %w", ErrRuntimeInstallFailed, err)
				}
			} else {
				previous, openErr := workspace.openDirectory(finalRoot)
				if openErr != nil {
					return fmt.Errorf("%w: existing managed runtime root is unsafe: %w", ErrRuntimeInstallFailed, openErr)
				}
				previous.Close()
				if err := workspace.rename(finalName, backupName); err != nil {
					return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
				}
				hadPrevious = true
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
		}
	}

	var rootDir *managedRuntimeDirectory
	if restored {
		rootDir, err = workspace.openDirectoryName(finalName)
	} else {
		rootDir, err = workspace.createDirectory(finalName)
	}
	if err != nil {
		return fmt.Errorf("%w: open managed runtime root: %w", ErrRuntimeInstallFailed, err)
	}
	defer rootDir.Close()

	rollback := func() {
		_ = workspace.remove(finalName)
		if hadPrevious {
			_ = workspace.rename(backupName, finalName)
		}
	}

	if !restored {
		if err := update(SetupPhaseInstalling); err != nil {
			rollback()
			return err
		}
		command := append([]string(nil), plan.InstallCommand...)
		if len(command) == 0 || command[0] != plan.Runner {
			rollback()
			return fmt.Errorf("%w: runner identity changed", ErrRuntimeInstallFailed)
		}
		// exec.Command resolves a bare command name against the daemon's own
		// PATH before cmd.Env applies, so the managed toolchain directory on
		// the child PATH never affects executable resolution. Point the runner
		// at the managed uv executable by absolute path; the PATH prefix in
		// uvInstallEnvironment remains for uv's own subprocesses.
		command[0] = filepath.Join(uvDir, uvExecutableName())
		runner := s.Runner
		if runner == nil {
			runner = localInstallCommandRunner{}
		}
		installCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
		defer cancel()
		env := uvInstallEnvironment(scratch, finalRoot, uvDir, uvToolchainCacheDir(manager.RuntimeInstallDir))
		if err := runner.Run(installCtx, command, scratch, env); err != nil {
			rollback()
			return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
		}
	}
	if err := rootDir.verify(); err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, err)
	}

	if err := update(SetupPhaseVerifying); err != nil {
		rollback()
		return err
	}
	if err := rootDir.verify(); err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	finalExecutable, err := stagedRuntimeExecutable(plan, finalRoot)
	if err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	realExecutable, err := filepath.EvalSymlinks(finalExecutable)
	if err != nil {
		rollback()
		return fmt.Errorf("%w: resolve installed executable: %w", ErrRuntimeVerifyFailed, err)
	}
	realRoot, err := filepath.EvalSymlinks(finalRoot)
	if err != nil {
		rollback()
		return fmt.Errorf("%w: resolve install root: %w", ErrRuntimeVerifyFailed, err)
	}
	if !pathWithin(realExecutable, realRoot) {
		rollback()
		return fmt.Errorf("%w: installed executable escapes install root", ErrRuntimeVerifyFailed)
	}
	info, err := os.Lstat(realExecutable)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 {
		rollback()
		return fmt.Errorf("%w: installed executable is not an ordinary file", ErrRuntimeVerifyFailed)
	}
	fingerprint, err := fingerprintRuntimeExecutable(realExecutable)
	if err != nil {
		rollback()
		return fmt.Errorf("%w: fingerprint installed executable: %w", ErrRuntimeVerifyFailed, err)
	}
	if err := verifyRuntimeExecutableUnchanged(realExecutable, fingerprint); err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	version, err := compatibleInstalledVersion(ctx, realExecutable, profile, nil)
	if err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}
	if err := verifyRuntimeExecutableUnchanged(realExecutable, fingerprint); err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeVerifyFailed, err)
	}

	if err := update(SetupPhaseProbing); err != nil {
		rollback()
		return err
	}
	launchArgs := resolveRuntimeArguments(installation.Manifest.Runtime.Launch.Args, discoveryRoot, finalRoot)
	binding, err := manager.runtimeBinding(
		installation, append([]string{realExecutable}, launchArgs...), version, "managed",
	)
	if err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeProbeFailed, err)
	}
	if _, err := ProbeRuntime(ctx, binding, plan.AgentTargetID, discoveryRoot, s.Transport, s.Host); err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeProbeFailed, err)
	}
	if err := verifyRuntimeExecutableUnchanged(realExecutable, fingerprint); err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeProbeFailed, err)
	}

	if err := update(SetupPhaseActivating); err != nil {
		rollback()
		return err
	}
	if err := rootDir.verify(); err != nil {
		rollback()
		return fmt.Errorf("%w: %w", ErrRuntimeActivateFailed, err)
	}
	relativeExecutable, err := filepath.Rel(realRoot, realExecutable)
	if err != nil || relativeExecutable == "." || strings.HasPrefix(relativeExecutable, ".."+string(filepath.Separator)) {
		rollback()
		return fmt.Errorf("%w: installed executable path is invalid", ErrRuntimeActivateFailed)
	}
	activation := managedRuntimeActivation{
		SchemaVersion: managedRuntimeActivationSchema, ExtensionInstallationID: installation.ID,
		RuntimeIdentity: plan.RuntimeIdentity, PackageName: plan.PackageName, PackageVersion: plan.PackageVersion,
		ExecutableRelativePath: filepath.ToSlash(relativeExecutable), InstalledAt: time.Now().UTC(),
	}
	activation.ExecutableFingerprint = fingerprint
	if err := rootDir.writeJSONAtomic("activation.json", activation); err != nil {
		rollback()
		return fmt.Errorf("%w: write activation: %w", ErrRuntimeActivateFailed, err)
	}
	if plan.PublishUserCommand {
		entry, err := manager.managedRuntimeEntry(installation, plan.InstallRoot, plan.Executable, activation.ExecutableRelativePath)
		if err != nil {
			rollback()
			return fmt.Errorf("%w: derive user executable entry: %w", ErrRuntimeActivateFailed, err)
		}
		if err := validateManagedRuntimeEntry(entry); err != nil {
			rollback()
			return fmt.Errorf("%w: %w", ErrRuntimeActivateFailed, err)
		}
		if err := verifyRuntimeExecutableUnchanged(realExecutable, fingerprint); err != nil {
			rollback()
			return fmt.Errorf("%w: %w", ErrRuntimeActivateFailed, err)
		}
		if err := publishManagedRuntimeEntry(entry); err != nil {
			rollback()
			return fmt.Errorf("%w: %w", ErrRuntimeActivateFailed, err)
		}
	}
	_ = workspace.remove(backupName)
	return nil
}

// uvCommittedActivation reports whether the named workspace directory holds a
// committed runtime matching the plan: a readable activation record with the
// expected identity whose declared executable still matches its fingerprint.
func uvCommittedActivation(
	workspace *managedRuntimeWorkspace,
	name string,
	plan InstallPlan,
) (managedRuntimeActivation, bool) {
	directory, err := workspace.openDirectoryName(name)
	if err != nil {
		return managedRuntimeActivation{}, false
	}
	defer directory.Close()
	var activation managedRuntimeActivation
	if err := directory.readJSON("activation.json", &activation); err != nil {
		return managedRuntimeActivation{}, false
	}
	if activation.SchemaVersion != managedRuntimeActivationSchema ||
		activation.ExtensionInstallationID != plan.ExtensionInstallationID ||
		activation.RuntimeIdentity != plan.RuntimeIdentity ||
		activation.PackageName != plan.PackageName ||
		activation.PackageVersion != plan.PackageVersion ||
		activation.ExecutableRelativePath == "" ||
		activation.ExecutableFingerprint.SHA256 == "" {
		return managedRuntimeActivation{}, false
	}
	executable := filepath.Join(directory.path, filepath.FromSlash(activation.ExecutableRelativePath))
	if !pathWithin(executable, directory.path) {
		return managedRuntimeActivation{}, false
	}
	if err := verifyRuntimeExecutableUnchanged(executable, activation.ExecutableFingerprint); err != nil {
		return managedRuntimeActivation{}, false
	}
	return activation, true
}

// uvInstallEnvironment builds the hermetic install environment for the uv
// runner. The managed uv directory is prepended to PATH so the runner is still
// executed by bare name, and the UV_* variables confine the tool environment,
// executables, managed CPython, and cache to Tutti-owned directories.
func uvInstallEnvironment(scratch, installRoot, uvDir, cacheDir string) []string {
	base := cleanInstallEnvironment(scratch)
	result := make([]string, 0, len(base)+6)
	pathValue := uvDir
	for _, entry := range base {
		key, value, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, "PATH") {
			pathValue = uvDir + string(os.PathListSeparator) + value
			continue
		}
		result = append(result, entry)
	}
	return append(result,
		"PATH="+pathValue,
		"UV_TOOL_DIR="+filepath.Join(installRoot, "tools"),
		"UV_TOOL_BIN_DIR="+filepath.Join(installRoot, "bin"),
		"UV_PYTHON_INSTALL_DIR="+filepath.Join(installRoot, "python"),
		"UV_CACHE_DIR="+cacheDir,
		"UV_NO_CONFIG=1",
	)
}
