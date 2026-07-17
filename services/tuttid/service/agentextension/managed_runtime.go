package agentextension

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
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

func (m *Manager) resolveInstalledManagedRuntime(
	ctx context.Context,
	installation Installation,
	profile DiscoveryProfile,
	cwd string,
) (RuntimeBinding, error) {
	if strings.TrimSpace(m.RuntimeInstallDir) == "" {
		return RuntimeBinding{}, errors.New("managed runtime install directory is not configured")
	}
	packageName, packageVersion, err := exactRuntimePackage(installation.Manifest.Runtime.Install.Runner, installation.Manifest.Runtime.Install.Args)
	if err != nil {
		return RuntimeBinding{}, err
	}
	runtimeIdentity, err := managedRuntimeIdentity(installation, profile, packageName, packageVersion, runtimePlatform())
	if err != nil {
		return RuntimeBinding{}, err
	}
	root := managedRuntimeRoot(m.RuntimeInstallDir, installation.AgentKey, runtimeIdentity)
	var activation managedRuntimeActivation
	if err := readJSON(filepath.Join(root, "activation.json"), &activation); err != nil {
		if adoptErr := m.adoptCompatibleManagedRuntime(ctx, installation, profile, packageName, packageVersion, runtimeIdentity, root); adoptErr != nil {
			return RuntimeBinding{}, err
		}
		if err := readJSON(filepath.Join(root, "activation.json"), &activation); err != nil {
			return RuntimeBinding{}, err
		}
	}
	if activation.SchemaVersion != managedRuntimeActivationSchema || activation.RuntimeIdentity != runtimeIdentity {
		return RuntimeBinding{}, errors.New("managed runtime activation identity is invalid")
	}
	if activation.PackageName != packageName || activation.PackageVersion != packageVersion {
		return RuntimeBinding{}, errors.New("managed runtime package identity is invalid")
	}
	executable := filepath.Clean(filepath.Join(root, filepath.FromSlash(activation.ExecutableRelativePath)))
	if !pathWithin(executable, root) {
		return RuntimeBinding{}, errors.New("managed runtime executable escapes install root")
	}
	info, err := os.Lstat(executable)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return RuntimeBinding{}, errors.New("managed runtime executable is not an ordinary file")
	}
	fingerprint, err := fingerprintRuntimeExecutable(executable)
	if err != nil || fingerprint != activation.ExecutableFingerprint || fingerprint.SHA256 == "" {
		return RuntimeBinding{}, fmt.Errorf("%w: executable fingerprint changed", ErrManagedRuntimeIntegrity)
	}
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
	for _, candidate := range profile.Candidates {
		version, err := runtimeVersion(ctx, executable, candidate.Version.Args, candidate.Version.Constraint)
		if err != nil {
			continue
		}
		launchArgs := resolveRuntimeArguments(installation.Manifest.Runtime.Launch.Args, cwd, root)
		return m.runtimeBinding(
			installation,
			append([]string{executable}, launchArgs...),
			version,
			"managed",
		)
	}
	return RuntimeBinding{}, errors.New("managed runtime version is incompatible")
}

func (m *Manager) adoptCompatibleManagedRuntime(
	ctx context.Context,
	installation Installation,
	profile DiscoveryProfile,
	packageName string,
	packageVersion string,
	runtimeIdentity string,
	targetRoot string,
) error {
	agentRoot := filepath.Join(strings.TrimSpace(m.RuntimeInstallDir), installation.AgentKey)
	entries, err := os.ReadDir(agentRoot)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "bin" || entry.Name() == runtimeIdentity {
			continue
		}
		sourceRoot := filepath.Join(agentRoot, entry.Name())
		activation, executable, ok := compatibleManagedRuntimeCandidate(ctx, sourceRoot, profile, packageName, packageVersion)
		if !ok {
			continue
		}
		relativeExecutable, err := filepath.Rel(sourceRoot, executable)
		if err != nil || relativeExecutable == "." || strings.HasPrefix(relativeExecutable, ".."+string(filepath.Separator)) {
			return errors.New("managed runtime executable path is invalid")
		}
		runtimeEntry, err := m.managedRuntimeEntry(
			installation,
			targetRoot,
			installation.Manifest.Runtime.Launch.Executable,
			filepath.ToSlash(relativeExecutable),
		)
		if err != nil {
			return err
		}
		if err := validateManagedRuntimeEntry(runtimeEntry); err != nil {
			return err
		}
		activation.ExtensionInstallationID = installation.ID
		activation.RuntimeIdentity = runtimeIdentity
		if err := writeJSONAtomic(filepath.Join(sourceRoot, "activation.json"), activation); err != nil {
			return err
		}
		if err := os.Rename(sourceRoot, targetRoot); err != nil {
			return err
		}
		return publishManagedRuntimeEntry(runtimeEntry)
	}
	return os.ErrNotExist
}

func compatibleManagedRuntimeCandidate(
	ctx context.Context,
	root string,
	profile DiscoveryProfile,
	packageName string,
	packageVersion string,
) (managedRuntimeActivation, string, bool) {
	var activation managedRuntimeActivation
	if err := readJSON(filepath.Join(root, "activation.json"), &activation); err != nil {
		return managedRuntimeActivation{}, "", false
	}
	if activation.SchemaVersion != managedRuntimeActivationSchema || activation.PackageName != packageName || activation.PackageVersion != packageVersion {
		return managedRuntimeActivation{}, "", false
	}
	executable := filepath.Clean(filepath.Join(root, filepath.FromSlash(activation.ExecutableRelativePath)))
	if !pathWithin(executable, root) {
		return managedRuntimeActivation{}, "", false
	}
	info, err := os.Lstat(executable)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return managedRuntimeActivation{}, "", false
	}
	fingerprint, err := fingerprintRuntimeExecutable(executable)
	if err != nil || fingerprint != activation.ExecutableFingerprint || fingerprint.SHA256 == "" {
		return managedRuntimeActivation{}, "", false
	}
	if _, err := compatibleInstalledVersion(ctx, executable, profile); err != nil {
		return managedRuntimeActivation{}, "", false
	}
	return activation, executable, true
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
