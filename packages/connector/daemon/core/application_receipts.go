package host

import (
	"fmt"
	"path/filepath"
	"strings"
)

func (application *Application) compatibilityFor(manifest Manifest) (Compatibility, error) {
	if !application.config.ImplementationRegistry.Supports(manifest.Implementation.Kind) {
		return Compatibility{State: CompatibilityStateUnsupportedImplementation, Reason: "unsupported_implementation"}, nil
	}
	compatibility := application.config.Compatibility.Evaluate(manifest)
	switch compatibility.State {
	case CompatibilityStateSupported, CompatibilityStateUnsupportedProduct,
		CompatibilityStateUnsupportedPlatform, CompatibilityStateUnsupportedVersion:
		return compatibility, nil
	default:
		return Compatibility{}, NewDomainError(ErrorCodeUnavailable,
			"connector compatibility evaluator returned an invalid state", false, nil)
	}
}

func newCatalogConnector(release Release) Connector {
	return Connector{Key: release.ConnectorKey, Release: release,
		Installation:  Installation{State: InstallationStateNotInstalled},
		Authorization: initialAuthorization(release.Manifest.AuthorizationKind),
		Compatibility: Compatibility{State: CompatibilityStateSupported}}
}

func initialAuthorization(kind string) Authorization {
	if kind == "none" {
		return Authorization{State: AuthorizationStateNotRequired}
	}
	return Authorization{State: AuthorizationStateDisconnected}
}

// authorizationForManifest migrates stored state when catalog metadata
// corrects whether a connector requires credentials.
func authorizationForManifest(current Authorization, kind string) Authorization {
	if kind == "none" {
		return Authorization{State: AuthorizationStateNotRequired}
	}
	if current.State == AuthorizationStateNotRequired {
		return Authorization{State: AuthorizationStateDisconnected}
	}
	return current
}

func frozenRelease(operation Operation) (Release, error) {
	release, err := frozenReleaseIdentity(operation)
	if err != nil {
		return Release{}, err
	}
	if err := ValidateReleaseShape(release); err != nil {
		return Release{}, err
	}
	return release, nil
}

func frozenReleaseIdentity(operation Operation) (Release, error) {
	if operation.Target == nil || operation.Target.Release == nil {
		return Release{}, invalidOperationReceipt("operation does not contain a frozen release")
	}
	release := *operation.Target.Release
	if release.ConnectorKey != operation.ConnectorKey || release.ReleaseID != operation.Target.ReleaseID ||
		release.ReleaseDigest != operation.Target.ReleaseDigest || release.Version != operation.Target.Version {
		return Release{}, invalidOperationReceipt("operation release identity is inconsistent")
	}
	return release, nil
}

func validatePreparedArtifact(operation Operation, release Release, receipt PreparedArtifactReceipt) error {
	if receipt.OperationID != operation.OperationID || receipt.ConnectorKey != release.ConnectorKey ||
		receipt.Version != release.Version || receipt.ReleaseDigest != release.ReleaseDigest ||
		receipt.ArtifactSHA256 != release.Artifact.SHA256 ||
		!artifactSHA256Pattern.MatchString(receipt.InventoryDigest) ||
		(strings.TrimSpace(receipt.PreparedPath) == "" && strings.TrimSpace(receipt.OpaqueArtifactRef) == "") {
		return invalidOperationReceipt("artifact preparer returned a mismatched receipt")
	}
	return nil
}

func validateReleaseInstallationReceipt(operation Operation, release Release, receipt ReleaseInstallationReceipt) error {
	if receipt.OperationID != operation.OperationID || receipt.ConnectorKey != release.ConnectorKey ||
		receipt.Version != release.Version || receipt.ReleaseID != release.ReleaseID ||
		receipt.ReleaseDigest != release.ReleaseDigest || receipt.ArtifactSHA256 != release.Artifact.SHA256 {
		return invalidOperationReceipt("release installer returned a mismatched receipt")
	}
	if err := validatePreparedArtifact(operation, release, receipt.Artifact); err != nil {
		return err
	}
	cliInstall := releaseCLIInstallation(release)
	if cliInstall == nil {
		if receipt.CLIInstallation != nil {
			return invalidOperationReceipt("release installer returned an unexpected CLI receipt")
		}
		return nil
	}
	if receipt.CLIInstallation == nil {
		return invalidOperationReceipt("release installer did not return the required CLI receipt")
	}
	return validateCLIInstallationReceipt(operation, release, *cliInstall, *receipt.CLIInstallation)
}

func releaseCLIInstallation(release Release) *NodePackageInstallation {
	managed := release.Manifest.Implementation.ManagedStdio
	if managed == nil || managed.CLI == nil || managed.CLI.Install == nil || managed.CLI.Install.NodePackage == nil {
		return nil
	}
	return managed.CLI.Install.NodePackage
}

func validateCLIInstallationReceipt(operation Operation, release Release, install NodePackageInstallation, receipt CLIInstallationReceipt) error {
	if receipt.SchemaVersion != "tutti.connector.cli-installation.v1" ||
		receipt.OperationID != operation.OperationID || receipt.ConnectorKey != release.ConnectorKey ||
		receipt.ReleaseDigest != release.ReleaseDigest || receipt.Package != install.Package ||
		receipt.PackageVersion != install.Version || receipt.PackageIntegrity != install.Integrity ||
		receipt.LaunchKind != install.Launch.Kind || receipt.EntrypointSize <= 0 ||
		!artifactSHA256Pattern.MatchString(receipt.NodeSHA256) ||
		!artifactSHA256Pattern.MatchString(receipt.EntrypointSHA256) ||
		strings.TrimSpace(receipt.RuntimeProfile) == "" || strings.TrimSpace(receipt.RuntimeABI) == "" ||
		strings.TrimSpace(receipt.NodeVersion) == "" || !safeRelativeEntrypoint(receipt.Entrypoint) {
		return invalidOperationReceipt("CLI installer returned a mismatched receipt")
	}
	localReceipt := filepath.IsAbs(receipt.InstallRoot) && filepath.IsAbs(receipt.StoreRoot) &&
		artifactSHA256Pattern.MatchString(receipt.LockSHA256)
	remoteReceipt := strings.TrimSpace(receipt.OpaqueInstallationRef) != ""
	if !localReceipt && !remoteReceipt {
		return invalidOperationReceipt("CLI installer returned a mismatched receipt")
	}
	return nil
}

func invalidOperationReceipt(message string) error {
	return NewDomainError(ErrorCodeInstallFailed,
		fmt.Sprintf("invalid connector operation receipt: %s", message), false, nil)
}
