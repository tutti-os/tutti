package agentextension

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type managedRuntimeRecoveryExpectation struct {
	extensionInstallationID string
	runtimeIdentity         string
	packageName             string
	packageVersion          string
	executableRelativePath  string
	executableFingerprint   runtimeExecutableFingerprint
	platform                string
}

func binaryRuntimeRecoveryExpectation(
	installation Installation,
	runtimeIdentity string,
	packageName string,
	packageVersion string,
	executableRelativePath string,
	artifact *RuntimeBinaryArtifact,
) (*managedRuntimeRecoveryExpectation, error) {
	if artifact == nil {
		return nil, nil
	}
	relative := filepath.Clean(filepath.FromSlash(executableRelativePath))
	if relative == "." || filepath.IsAbs(relative) || relative == ".." || !pathWithin(filepath.Join("root", relative), "root") {
		return nil, errors.New("managed runtime recovery executable path is invalid")
	}
	return &managedRuntimeRecoveryExpectation{
		extensionInstallationID: installation.ID,
		runtimeIdentity:         runtimeIdentity,
		packageName:             packageName,
		packageVersion:          packageVersion,
		executableRelativePath:  relative,
		executableFingerprint: runtimeExecutableFingerprint{
			SHA256: artifact.SHA256,
			Size:   artifact.SizeBytes,
		},
		platform: artifact.Platform,
	}, nil
}

// recoverInterruptedBinaryActivation resolves the only durable intermediate
// state used by managed binary replacement. A backup is never deleted until a
// verified active root has been identified, and it is never promoted unless it
// independently matches the current signed artifact and activation identity.
func recoverInterruptedBinaryActivation(
	workspace *managedRuntimeWorkspace,
	expected *managedRuntimeRecoveryExpectation,
) error {
	if expected == nil {
		return nil
	}
	if workspace == nil {
		return errors.New("managed runtime recovery workspace is unavailable")
	}
	if err := workspace.verify(); err != nil {
		return err
	}
	activeName := expected.runtimeIdentity
	backupName := activeName + ".previous"
	backupPresent, err := managedRuntimeEntryPresent(workspace, backupName)
	if err != nil || !backupPresent {
		return err
	}

	activePresent, err := managedRuntimeEntryPresent(workspace, activeName)
	if err != nil {
		return err
	}
	if activePresent {
		active, openErr := workspace.openDirectoryName(activeName)
		if openErr == nil {
			validErr := validateManagedRuntimeRecoveryCandidate(active, expected)
			active.Close()
			if validErr == nil {
				if err := workspace.remove(backupName); err != nil {
					return fmt.Errorf("remove superseded managed runtime backup: %w", err)
				}
				return nil
			}
		}
	}

	backup, err := workspace.openDirectoryName(backupName)
	if err != nil {
		return fmt.Errorf("%w: interrupted managed runtime backup is unsafe: %v", ErrManagedRuntimeIntegrity, err)
	}
	if err := validateManagedRuntimeRecoveryCandidate(backup, expected); err != nil {
		backup.Close()
		return fmt.Errorf("%w: interrupted managed runtime backup is unverified: %v", ErrManagedRuntimeIntegrity, err)
	}
	if activePresent {
		if err := workspace.remove(activeName); err != nil {
			backup.Close()
			return fmt.Errorf("remove invalid interrupted managed runtime active root: %w", err)
		}
	}
	if err := workspace.rename(backupName, activeName); err != nil {
		backup.Close()
		return fmt.Errorf("restore verified managed runtime backup: %w", err)
	}
	backup.name = activeName
	backup.path = filepath.Join(workspace.agentPath, activeName)
	if err := validateManagedRuntimeRecoveryCandidate(backup, expected); err != nil {
		_ = workspace.rename(activeName, backupName)
		backup.name = backupName
		backup.path = filepath.Join(workspace.agentPath, backupName)
		backup.Close()
		return fmt.Errorf("%w: restored managed runtime root changed across rename: %v", ErrManagedRuntimeIntegrity, err)
	}
	backup.Close()
	return nil
}

func managedRuntimeEntryPresent(workspace *managedRuntimeWorkspace, name string) (bool, error) {
	if workspace == nil {
		return false, errors.New("managed runtime workspace is unavailable")
	}
	if err := workspace.verify(); err != nil {
		return false, err
	}
	_, err := os.Lstat(filepath.Join(workspace.agentPath, name))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func validateManagedRuntimeRecoveryCandidate(
	candidate *managedRuntimeDirectory,
	expected *managedRuntimeRecoveryExpectation,
) error {
	if candidate == nil || expected == nil {
		return errors.New("managed runtime recovery candidate is unavailable")
	}
	var activation managedRuntimeActivation
	if err := candidate.readJSON("activation.json", &activation); err != nil {
		return err
	}
	if activation.SchemaVersion != managedRuntimeActivationSchema ||
		activation.ExtensionInstallationID != expected.extensionInstallationID ||
		activation.RuntimeIdentity != expected.runtimeIdentity ||
		activation.PackageName != expected.packageName ||
		activation.PackageVersion != expected.packageVersion ||
		filepath.Clean(filepath.FromSlash(activation.ExecutableRelativePath)) != expected.executableRelativePath ||
		activation.ExecutableFingerprint != expected.executableFingerprint {
		return errors.New("managed runtime recovery activation identity does not match")
	}
	file, err := candidate.openFile(expected.executableRelativePath, os.O_RDONLY)
	if err != nil {
		return err
	}
	fingerprint, fingerprintErr := fingerprintRuntimeExecutableFile(file)
	platformErr := validateNativeExecutableFile(file, expected.platform)
	closeErr := file.Close()
	if fingerprintErr != nil || platformErr != nil || closeErr != nil {
		return errors.Join(fingerprintErr, platformErr, closeErr)
	}
	if fingerprint != expected.executableFingerprint || fingerprint.SHA256 == "" {
		return errors.New("managed runtime recovery executable does not match signed artifact")
	}
	if err := candidate.verify(); err != nil {
		return err
	}
	if !managedRuntimeCandidateExecutableUnchanged(candidate, expected.executableRelativePath, expected.executableFingerprint) {
		return errors.New("managed runtime recovery executable changed during verification")
	}
	return nil
}
