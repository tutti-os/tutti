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
	root := m.managedRuntimeRoot(installation)
	if strings.TrimSpace(m.RuntimeInstallDir) == "" {
		return RuntimeBinding{}, errors.New("managed runtime install directory is not configured")
	}
	var activation managedRuntimeActivation
	if err := readJSON(filepath.Join(root, "activation.json"), &activation); err != nil {
		return RuntimeBinding{}, err
	}
	if activation.SchemaVersion != managedRuntimeActivationSchema || activation.ExtensionInstallationID != installation.ID {
		return RuntimeBinding{}, errors.New("managed runtime activation identity is invalid")
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
