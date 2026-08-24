package agentextension

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

const managedRuntimeActivationSchema = "tutti.agent.managed-runtime.v1"

type managedRuntimeActivation struct {
	SchemaVersion           string                       `json:"schemaVersion"`
	ExtensionInstallationID string                       `json:"extensionInstallationId"`
	RuntimeIdentity         string                       `json:"runtimeIdentity"`
	PackageName             string                       `json:"packageName"`
	PackageVersion          string                       `json:"packageVersion"`
	ExecutableRelativePath  string                       `json:"executableRelativePath"`
	ExecutableFingerprint   runtimeExecutableFingerprint `json:"executableFingerprint"`
	InstalledAt             time.Time                    `json:"installedAt"`
}

// installedManagedRuntimeRoot resolves the install root of the agent's managed
// runtime without requiring the runtime to already be installed. It is the
// same identity computation used by resolveInstalledManagedRuntime.
func (m *Manager) installedManagedRuntimeRoot(installation Installation) (string, error) {
	if strings.TrimSpace(m.RuntimeInstallDir) == "" {
		return "", errors.New("managed runtime install directory is not configured")
	}
	var profile DiscoveryProfile
	if err := readJSON(filepath.Join(installation.PackageDir, filepath.FromSlash(installation.Manifest.Profiles.Discovery)), &profile); err != nil {
		return "", err
	}
	if profile.SchemaVersion != "tutti.agent.discovery.v1" {
		return "", errors.New("unsupported discovery profile schema")
	}
	packageName, packageVersion, _, err := runtimeInstallIdentity(installation.Manifest, runtimePlatform())
	if err != nil {
		return "", err
	}
	runtimeIdentity, err := managedRuntimeIdentity(installation, profile, packageName, packageVersion, runtimePlatform())
	if err != nil {
		return "", err
	}
	return managedRuntimeRoot(m.RuntimeInstallDir, installation.AgentKey, runtimeIdentity), nil
}

func (m *Manager) resolveInstalledManagedRuntime(
	ctx context.Context,
	installation Installation,
	profile DiscoveryProfile,
	cwd string,
) (RuntimeBinding, error) {
	if strings.TrimSpace(m.RuntimeInstallDir) == "" {
		return RuntimeBinding{}, errors.New("managed runtime install directory is not configured")
	}
	packageName, packageVersion, artifact, err := runtimeInstallIdentity(installation.Manifest, runtimePlatform())
	if err != nil {
		return RuntimeBinding{}, err
	}
	runtimeIdentity, err := managedRuntimeIdentity(installation, profile, packageName, packageVersion, runtimePlatform())
	if err != nil {
		return RuntimeBinding{}, err
	}
	root := managedRuntimeRoot(m.RuntimeInstallDir, installation.AgentKey, runtimeIdentity)
	workspace, err := openManagedRuntimeWorkspaceForInstall(m.RuntimeInstallDir, installation.AgentKey, artifact == nil)
	if err != nil {
		return RuntimeBinding{}, err
	}
	defer workspace.Close()
	if artifact != nil {
		executable := filepath.Clean(strings.NewReplacer(
			"${installRoot}", root,
			"${platform}", runtimePlatform(),
		).Replace(installation.Manifest.Runtime.Launch.Executable))
		relativeExecutable, relativeErr := filepath.Rel(root, executable)
		if relativeErr != nil || relativeExecutable == "." || !pathWithin(executable, root) {
			return RuntimeBinding{}, errors.New("managed runtime recovery executable escapes install root")
		}
		expected, expectationErr := binaryRuntimeRecoveryExpectation(
			installation, runtimeIdentity, packageName, packageVersion, relativeExecutable, artifact,
		)
		if expectationErr != nil {
			return RuntimeBinding{}, expectationErr
		}
		if err := recoverInterruptedBinaryActivation(workspace, expected); err != nil {
			return RuntimeBinding{}, err
		}
	}
	activePresent, err := managedRuntimeEntryPresent(workspace, runtimeIdentity)
	if err != nil {
		return RuntimeBinding{}, err
	}
	if !activePresent {
		if err := m.adoptCompatibleManagedRuntime(ctx, installation, profile, packageName, packageVersion, artifact, runtimeIdentity, root); err != nil {
			return RuntimeBinding{}, err
		}
	}
	active, err := workspace.openDirectoryName(runtimeIdentity)
	if err != nil {
		return RuntimeBinding{}, fmt.Errorf("%w: active runtime root is unsafe: %v", ErrManagedRuntimeIntegrity, err)
	}
	defer active.Close()
	var activation managedRuntimeActivation
	if err := active.readJSON("activation.json", &activation); err != nil {
		return RuntimeBinding{}, err
	}
	if activation.SchemaVersion != managedRuntimeActivationSchema || activation.RuntimeIdentity != runtimeIdentity {
		return RuntimeBinding{}, errors.New("managed runtime activation identity is invalid")
	}
	if activation.PackageName != packageName || activation.PackageVersion != packageVersion {
		return RuntimeBinding{}, errors.New("managed runtime package identity is invalid")
	}
	relativeExecutable := filepath.Clean(filepath.FromSlash(activation.ExecutableRelativePath))
	if relativeExecutable == "." || filepath.IsAbs(relativeExecutable) || relativeExecutable == ".." || strings.HasPrefix(relativeExecutable, ".."+string(filepath.Separator)) {
		return RuntimeBinding{}, errors.New("managed runtime executable escapes install root")
	}
	executableFile, err := active.openFile(relativeExecutable, os.O_RDONLY)
	if err != nil {
		return RuntimeBinding{}, errors.New("managed runtime executable is not an ordinary file")
	}
	fingerprint, fingerprintErr := fingerprintRuntimeExecutableFile(executableFile)
	var platformErr error
	if artifact != nil {
		platformErr = validateNativeExecutableFile(executableFile, artifact.Platform)
	}
	closeErr := executableFile.Close()
	if fingerprintErr != nil || platformErr != nil || closeErr != nil {
		return RuntimeBinding{}, fmt.Errorf("%w: verify executable: %v", ErrManagedRuntimeIntegrity, errors.Join(fingerprintErr, platformErr, closeErr))
	}
	if fingerprint != activation.ExecutableFingerprint || fingerprint.SHA256 == "" {
		return RuntimeBinding{}, fmt.Errorf("%w: executable fingerprint changed", ErrManagedRuntimeIntegrity)
	}
	if artifact != nil {
		expected := runtimeExecutableFingerprint{SHA256: artifact.SHA256, Size: artifact.SizeBytes}
		if fingerprint != expected {
			return RuntimeBinding{}, fmt.Errorf("%w: executable does not match current signed artifact", ErrManagedRuntimeIntegrity)
		}
	}
	executable := filepath.Join(root, relativeExecutable)
	if publishesUserCommand(installation.Manifest) {
		entry, err := m.managedRuntimeEntry(
			installation,
			root,
			installation.Manifest.Runtime.Launch.Executable,
			activation.ExecutableRelativePath,
		)
		if err != nil {
			return RuntimeBinding{}, fmt.Errorf("%w: derive user executable entry: %v", ErrManagedRuntimeIntegrity, err)
		}
		if err := verifyManagedRuntimeEntry(entry); err != nil {
			return RuntimeBinding{}, fmt.Errorf("%w: %v", ErrManagedRuntimeIntegrity, err)
		}
		m.repairUserCommandPath(ctx)
	}
	for _, candidate := range profile.Candidates {
		if err := active.verify(); err != nil || !managedRuntimeCandidateExecutableUnchanged(active, relativeExecutable, fingerprint) {
			return RuntimeBinding{}, fmt.Errorf("%w: active runtime root or executable changed before version probe", ErrManagedRuntimeIntegrity)
		}
		var identity *agentruntime.ExecutableIdentity
		if artifact != nil {
			identity = executableIdentity(fingerprint)
		}
		version, err := m.runtimeVersionWithIdentity(ctx, executable, candidate.Version.Args, candidate.Version.Constraint, identity)
		if err != nil {
			if artifact != nil {
				return RuntimeBinding{}, fmt.Errorf("%w: verified version probe failed: %v", ErrManagedRuntimeIntegrity, err)
			}
			continue
		}
		if artifact != nil && version != packageVersion {
			continue
		}
		if err := active.verify(); err != nil {
			return RuntimeBinding{}, fmt.Errorf("%w: active runtime root changed during version probe: %v", ErrManagedRuntimeIntegrity, err)
		}
		if !managedRuntimeCandidateExecutableUnchanged(active, relativeExecutable, fingerprint) {
			return RuntimeBinding{}, fmt.Errorf("%w: active runtime executable changed during version probe", ErrManagedRuntimeIntegrity)
		}
		launchArgs := resolveRuntimeArguments(installation.Manifest.Runtime.Launch.Args, cwd, root)
		binding, err := m.runtimeBinding(
			installation,
			append([]string{executable}, launchArgs...),
			version,
			"managed",
		)
		if err != nil {
			return RuntimeBinding{}, err
		}
		return binding, nil
	}
	return RuntimeBinding{}, errors.New("managed runtime version is incompatible")
}

func (m *Manager) adoptCompatibleManagedRuntime(
	ctx context.Context,
	installation Installation,
	profile DiscoveryProfile,
	packageName string,
	packageVersion string,
	artifact *RuntimeBinaryArtifact,
	runtimeIdentity string,
	targetRoot string,
) error {
	workspace, err := openManagedRuntimeWorkspaceForInstall(m.RuntimeInstallDir, installation.AgentKey, artifact == nil)
	if err != nil {
		return err
	}
	defer workspace.Close()
	if filepath.Clean(targetRoot) != filepath.Join(workspace.agentPath, runtimeIdentity) {
		return errors.New("managed runtime adoption target does not match held workspace")
	}
	names, err := workspace.directoryNames()
	if err != nil {
		return err
	}
	for _, name := range names {
		if name == "bin" || name == runtimeIdentity || strings.HasSuffix(name, ".previous") || strings.HasPrefix(name, ".runtime-install-") {
			continue
		}
		candidate, err := workspace.openDirectoryName(name)
		if err != nil {
			continue
		}
		originalActivation, relativeExecutable, fingerprint, ok := compatibleManagedRuntimeCandidate(
			ctx, candidate, profile, packageName, packageVersion, artifact,
		)
		if !ok {
			candidate.Close()
			continue
		}
		var runtimeEntry managedRuntimeEntry
		if publishesUserCommand(installation.Manifest) {
			runtimeEntry, err = m.managedRuntimeEntry(
				installation,
				targetRoot,
				installation.Manifest.Runtime.Launch.Executable,
				filepath.ToSlash(relativeExecutable),
			)
			if err != nil {
				candidate.Close()
				return err
			}
			if err := validateManagedRuntimeEntry(runtimeEntry); err != nil {
				candidate.Close()
				return err
			}
		}
		activation := originalActivation
		activation.ExtensionInstallationID = installation.ID
		activation.RuntimeIdentity = runtimeIdentity
		if err := candidate.writeJSONAtomic("activation.json", activation); err != nil {
			candidate.Close()
			return err
		}
		if !managedRuntimeCandidateExecutableUnchanged(candidate, relativeExecutable, fingerprint) {
			_ = candidate.writeJSONAtomic("activation.json", originalActivation)
			candidate.Close()
			return fmt.Errorf("%w: adoption candidate changed before rename", ErrManagedRuntimeIntegrity)
		}
		// Windows does not allow a directory to be renamed while this process
		// still holds its directory handle. Close the verified source, rename it,
		// then reopen the promoted directory and repeat the integrity check.
		if err := candidate.Close(); err != nil {
			return err
		}
		restoreActivation := func(entryName string) {
			restored, openErr := workspace.openDirectoryName(entryName)
			if openErr != nil {
				return
			}
			_ = restored.writeJSONAtomic("activation.json", originalActivation)
			_ = restored.Close()
		}
		if err := workspace.rename(name, runtimeIdentity); err != nil {
			restoreActivation(name)
			return err
		}
		promoted, err := workspace.openDirectoryName(runtimeIdentity)
		if err != nil {
			_ = workspace.rename(runtimeIdentity, name)
			restoreActivation(name)
			return err
		}
		rollback := func() {
			_ = promoted.Close()
			if workspace.rename(runtimeIdentity, name) == nil {
				restoreActivation(name)
			}
		}
		if err := promoted.verify(); err != nil || !managedRuntimeCandidateExecutableUnchanged(promoted, relativeExecutable, fingerprint) {
			rollback()
			return fmt.Errorf("%w: adoption candidate changed across rename", ErrManagedRuntimeIntegrity)
		}
		if publishesUserCommand(installation.Manifest) {
			if err := m.ensureUserCommandPath(ctx); err != nil {
				rollback()
				return err
			}
			published, err := publishManagedRuntimeEntry(runtimeEntry)
			if err != nil {
				rollback()
				return err
			}
			if !published {
				slog.Warn("agent extension user command publication skipped; a user-owned command with the same name is preserved",
					"userPath", runtimeEntry.UserPath)
			}
		}
		promoted.Close()
		return nil
	}
	return os.ErrNotExist
}

func compatibleManagedRuntimeCandidate(
	ctx context.Context,
	candidate *managedRuntimeDirectory,
	profile DiscoveryProfile,
	packageName string,
	packageVersion string,
	artifact *RuntimeBinaryArtifact,
) (managedRuntimeActivation, string, runtimeExecutableFingerprint, bool) {
	var activation managedRuntimeActivation
	if candidate == nil || candidate.readJSON("activation.json", &activation) != nil {
		return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
	}
	if activation.SchemaVersion != managedRuntimeActivationSchema || activation.PackageName != packageName || activation.PackageVersion != packageVersion {
		return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
	}
	relativeExecutable := filepath.Clean(filepath.FromSlash(activation.ExecutableRelativePath))
	if relativeExecutable == "." || filepath.IsAbs(relativeExecutable) || relativeExecutable == ".." || strings.HasPrefix(relativeExecutable, ".."+string(filepath.Separator)) {
		return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
	}
	executableFile, err := candidate.openFile(relativeExecutable, os.O_RDONLY)
	if err != nil {
		return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
	}
	defer executableFile.Close()
	fingerprint, err := fingerprintRuntimeExecutableFile(executableFile)
	if err != nil || fingerprint != activation.ExecutableFingerprint || fingerprint.SHA256 == "" {
		return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
	}
	if artifact != nil {
		expected := runtimeExecutableFingerprint{SHA256: artifact.SHA256, Size: artifact.SizeBytes}
		if fingerprint != expected || validateNativeExecutableFile(executableFile, artifact.Platform) != nil {
			return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
		}
	}
	executable := filepath.Join(candidate.path, relativeExecutable)
	if err := candidate.verify(); err != nil {
		return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
	}
	var identity *agentruntime.ExecutableIdentity
	if artifact != nil {
		identity = executableIdentity(fingerprint)
	}
	version, err := compatibleInstalledVersion(ctx, executable, profile, identity)
	if err != nil || (artifact != nil && version != packageVersion) {
		return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
	}
	if err := candidate.verify(); err != nil || !managedRuntimeCandidateExecutableUnchanged(candidate, relativeExecutable, fingerprint) {
		return managedRuntimeActivation{}, "", runtimeExecutableFingerprint{}, false
	}
	return activation, relativeExecutable, fingerprint, true
}

func managedRuntimeCandidateExecutableUnchanged(candidate *managedRuntimeDirectory, relative string, expected runtimeExecutableFingerprint) bool {
	file, err := candidate.openFile(relative, os.O_RDONLY)
	if err != nil {
		return false
	}
	defer file.Close()
	fingerprint, err := fingerprintRuntimeExecutableFile(file)
	return err == nil && fingerprint == expected && fingerprint.SHA256 != ""
}

func resolveRuntimeArguments(arguments []string, cwd, installRoot string) []string {
	platform := runtimePlatform()
	result := make([]string, len(arguments))
	for index, value := range arguments {
		result[index] = strings.NewReplacer(
			"${projectRoot}", cwd,
			"${installRoot}", installRoot,
			"${platform}", platform,
		).Replace(value)
	}
	return result
}

func runtimePlatform() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}
