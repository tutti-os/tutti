package runtime

import (
	"context"
	"errors"
	"fmt"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

// ReleaseInstaller composes the same-machine artifact and optional CLI
// installation mechanics behind the host's single physical installation
// boundary. Remote products implement market.ReleaseInstallationManager in
// their control-plane adapter and use the same lower-level importer and CLI
// installer inside the runtime machine.
type ReleaseInstaller struct {
	artifacts market.ArtifactPreparer
	cli       market.CLIInstallationManager
}

var _ market.ReleaseInstallationManager = (*ReleaseInstaller)(nil)

func NewReleaseInstaller(
	artifacts market.ArtifactPreparer,
	cli market.CLIInstallationManager,
) (*ReleaseInstaller, error) {
	if artifacts == nil {
		return nil, errors.New("connector release artifact preparer is required")
	}
	return &ReleaseInstaller{artifacts: artifacts, cli: cli}, nil
}

func (installer *ReleaseInstaller) InstallRelease(
	ctx context.Context,
	request market.InstallReleaseRequest,
) (market.ReleaseInstallationReceipt, error) {
	if installer == nil || installer.artifacts == nil {
		return market.ReleaseInstallationReceipt{}, errors.New("connector release installer is unavailable")
	}
	if err := market.ValidateReleaseShape(request.Release); err != nil {
		return market.ReleaseInstallationReceipt{}, err
	}
	prepared, err := installer.artifacts.Prepare(ctx, market.PrepareArtifactRequest(request))
	if err != nil {
		return market.ReleaseInstallationReceipt{}, fmt.Errorf("prepare connector release artifact: %w", err)
	}

	receipt := market.ReleaseInstallationReceipt{
		OperationID:    request.OperationID,
		ConnectorKey:   request.Release.ConnectorKey,
		Version:        request.Release.Version,
		ReleaseID:      request.Release.ReleaseID,
		ReleaseDigest:  request.Release.ReleaseDigest,
		ArtifactSHA256: request.Release.Artifact.SHA256,
		Artifact:       prepared,
	}
	if !releaseRequiresCLIInstallation(request.Release) {
		return receipt, nil
	}
	if installer.cli == nil {
		return market.ReleaseInstallationReceipt{}, errors.New("connector CLI installation is required but unavailable")
	}
	cliReceipt, err := installer.cli.InstallCLI(ctx, market.InstallCLIRequest(request))
	if err != nil {
		rollbackErr := installer.artifacts.Remove(context.WithoutCancel(ctx), market.RemoveArtifactRequest{
			OperationID:   request.OperationID,
			Scope:         request.Scope,
			Generation:    request.Generation,
			ConnectorKey:  request.Release.ConnectorKey,
			Version:       request.Release.Version,
			ReleaseDigest: request.Release.ReleaseDigest,
		})
		return market.ReleaseInstallationReceipt{}, fmt.Errorf(
			"install connector CLI package: %w",
			errors.Join(err, rollbackErr),
		)
	}
	receipt.CLIInstallation = &cliReceipt
	return receipt, nil
}

func (installer *ReleaseInstaller) UninstallRelease(
	ctx context.Context,
	request market.UninstallReleaseRequest,
) error {
	if installer == nil || installer.artifacts == nil {
		return errors.New("connector release installer is unavailable")
	}
	if err := market.ValidateRuntimeReleaseShape(request.Release); err != nil {
		return err
	}
	var cleanupErrors []error
	if releaseRequiresCLIInstallation(request.Release) {
		if installer.cli == nil {
			cleanupErrors = append(cleanupErrors, errors.New("connector CLI installation manager is unavailable"))
		} else {
			cleanupErrors = append(cleanupErrors, installer.cli.RemoveCLI(ctx, market.RemoveCLIRequest{
				OperationID:   request.OperationID,
				Scope:         request.Scope,
				Generation:    request.Generation,
				ConnectorKey:  request.Release.ConnectorKey,
				ReleaseDigest: request.Release.ReleaseDigest,
			}))
		}
	}
	cleanupErrors = append(cleanupErrors, installer.artifacts.Remove(ctx, market.RemoveArtifactRequest{
		OperationID:   request.OperationID,
		Scope:         request.Scope,
		Generation:    request.Generation,
		ConnectorKey:  request.Release.ConnectorKey,
		Version:       request.Release.Version,
		ReleaseDigest: request.Release.ReleaseDigest,
	}))
	return errors.Join(cleanupErrors...)
}

func (*ReleaseInstaller) CommitReleaseInstallation(
	context.Context,
	market.CommitReleaseInstallationRequest,
) error {
	// Same-machine preparation already atomically published its latest verified
	// archive. Remote adapters defer candidate promotion until this callback.
	return nil
}

func releaseRequiresCLIInstallation(release market.Release) bool {
	managed := release.Manifest.Implementation.ManagedStdio
	return managed != nil && managed.CLI != nil && managed.CLI.Install != nil &&
		managed.CLI.Install.NodePackage != nil
}
