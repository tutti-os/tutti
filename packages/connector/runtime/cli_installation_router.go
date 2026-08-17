package runtime

import (
	"context"
	"errors"
	"fmt"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

type CLIInstallationRouter struct {
	nodePackage   market.CLIInstallationManager
	remoteArchive market.CLIInstallationManager
}

var _ market.CLIInstallationManager = (*CLIInstallationRouter)(nil)

func NewCLIInstallationRouter(nodePackage, remoteArchive market.CLIInstallationManager) (*CLIInstallationRouter, error) {
	if nodePackage == nil || remoteArchive == nil {
		return nil, errors.New("connector CLI installation router requires every supported installer")
	}
	return &CLIInstallationRouter{nodePackage: nodePackage, remoteArchive: remoteArchive}, nil
}

func (router *CLIInstallationRouter) InstallCLI(ctx context.Context, request market.InstallCLIRequest) (market.CLIInstallationReceipt, error) {
	installer, err := router.installer(request.Release)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	return installer.InstallCLI(ctx, request)
}

func (router *CLIInstallationRouter) ResolveCLI(ctx context.Context, release market.Release) (market.CLIInstallationReceipt, error) {
	installer, err := router.installer(release)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	return installer.ResolveCLI(ctx, release)
}

func (router *CLIInstallationRouter) RemoveCLI(ctx context.Context, request market.RemoveCLIRequest) error {
	if router == nil {
		return errors.New("connector CLI installation router is unavailable")
	}
	return errors.Join(router.nodePackage.RemoveCLI(ctx, request), router.remoteArchive.RemoveCLI(ctx, request))
}

func (router *CLIInstallationRouter) RemoveConnector(ctx context.Context, request market.RemoveConnectorInstallationRequest) error {
	if router == nil {
		return errors.New("connector CLI installation router is unavailable")
	}
	return errors.Join(router.nodePackage.RemoveConnector(ctx, request), router.remoteArchive.RemoveConnector(ctx, request))
}

func (router *CLIInstallationRouter) installer(release market.Release) (market.CLIInstallationManager, error) {
	if router == nil {
		return nil, errors.New("connector CLI installation router is unavailable")
	}
	managed := release.Manifest.Implementation.ManagedStdio
	if managed == nil || managed.CLI == nil || managed.CLI.Install == nil {
		return nil, errors.New("connector release does not declare a CLI installation")
	}
	switch managed.CLI.Install.Kind {
	case "node_package":
		return router.nodePackage, nil
	case "remote_archive":
		return router.remoteArchive, nil
	default:
		return nil, fmt.Errorf("unsupported connector CLI installation kind %q", managed.CLI.Install.Kind)
	}
}
