package implementationhost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

const maxInstallationProbeOutput = 64 << 10

// CheckInstallation runs the signed release's explicit MCP/CLI probes without
// publishing a route. It never infers absence from a timeout, transport error,
// or an unexpected exit code.
func (host *Host) CheckInstallation(
	ctx context.Context,
	request market.InstallationCheckRequest,
) (market.InstallationObservation, error) {
	if host == nil || host.artifacts == nil || host.planner == nil || host.processes == nil ||
		!hostIdentityPattern.MatchString(request.ConnectionID) ||
		!hostIdentityPattern.MatchString(request.Connector.Key) ||
		strings.TrimSpace(request.OperationID) == "" ||
		strings.TrimSpace(request.Generation.BootEpoch) == "" || request.Generation.Generation == 0 {
		return market.InstallationObservation{}, errors.New("connector installation probe identity is invalid")
	}
	release := request.Connector.Release
	if err := market.ValidateRuntimeReleaseShape(release); err != nil {
		return market.InstallationObservation{}, err
	}
	managed := release.Manifest.Implementation.ManagedStdio
	if release.Manifest.Implementation.Kind != market.ImplementationKindManagedStdio || managed == nil ||
		!hasInstallationProbe(managed) {
		return market.InstallationObservation{}, errors.New("connector installation probe is not declared")
	}
	prepared, err := host.artifacts.ResolvePrepared(ctx, release)
	if err != nil {
		return market.InstallationObservation{}, fmt.Errorf("resolve prepared connector artifact for installation probe: %w", err)
	}
	plan, err := host.planner.Build(ctx, market.RuntimeReconcileRequest{
		OperationID: request.OperationID, Scope: request.Scope, ConnectionID: request.ConnectionID,
		Connector: request.Connector, Generation: request.Generation,
	}, prepared)
	if err != nil {
		if errors.Is(err, connectorruntime.ErrCLIInstallationUnavailable) &&
			managed.CLI != nil && managed.CLI.InstallationProbe != nil {
			return installationObservation(request, market.InstallationObservationAbsent), nil
		}
		return market.InstallationObservation{}, err
	}
	if managed.MCP != nil && managed.MCP.InstallationProbe != nil {
		present, probeErr := host.runManagedInstallationProbe(ctx, request, plan, prepared,
			managed.MCP.Entrypoint, managed.MCP.Arguments, managed.MCP.InstallationProbe, nil)
		if probeErr != nil {
			return market.InstallationObservation{}, fmt.Errorf("probe connector MCP installation: %w", probeErr)
		}
		if !present {
			return installationObservation(request, market.InstallationObservationAbsent), nil
		}
	}
	if managed.CLI != nil && managed.CLI.InstallationProbe != nil {
		present, probeErr := host.runManagedInstallationProbe(ctx, request, plan, prepared,
			managed.CLI.Entrypoint, managed.CLI.Arguments, managed.CLI.InstallationProbe, plan.InstalledCLI)
		if probeErr != nil {
			return market.InstallationObservation{}, fmt.Errorf("probe connector CLI installation: %w", probeErr)
		}
		if !present {
			return installationObservation(request, market.InstallationObservationAbsent), nil
		}
	}
	return installationObservation(request, market.InstallationObservationPresent), nil
}

func hasInstallationProbe(managed *market.ManagedStdioImplementation) bool {
	return managed != nil && ((managed.MCP != nil && managed.MCP.InstallationProbe != nil) ||
		(managed.CLI != nil && managed.CLI.InstallationProbe != nil))
}

func installationObservation(
	request market.InstallationCheckRequest,
	state market.InstallationObservationState,
) market.InstallationObservation {
	return market.InstallationObservation{State: state, ConnectorKey: request.Connector.Key,
		ReleaseDigest: request.Connector.Release.ReleaseDigest}
}

func (host *Host) runManagedInstallationProbe(
	ctx context.Context,
	request market.InstallationCheckRequest,
	plan connectorruntime.ManagedRoutePlan,
	prepared market.PreparedArtifactReceipt,
	entrypointRelative string,
	interfaceArguments []string,
	probe *market.InstallationProbe,
	installed *market.CLIInstallationReceipt,
) (bool, error) {
	entrypointRoot := prepared.PreparedPath
	if installed != nil {
		entrypointRoot, entrypointRelative = installed.InstallRoot, installed.Entrypoint
	}
	entrypoint, err := connectorruntime.PreparedEntrypoint(entrypointRoot, entrypointRelative)
	if err != nil {
		return false, err
	}
	launchExecutable := plan.Executable
	arguments := []string{entrypoint}
	if installed != nil && installed.LaunchKind == "native" {
		launchExecutable = connectorruntime.ConnectorExecutable{Path: entrypoint,
			SHA256: installed.EntrypointSHA256, SizeBytes: installed.EntrypointSize}
		arguments = nil
	}
	arguments = append(arguments, interfaceArguments...)
	arguments = append(arguments, probe.Arguments...)
	probeCtx, cancel := context.WithTimeout(ctx, time.Duration(probe.TimeoutMS)*time.Millisecond)
	defer cancel()
	spec := connectorruntime.ConnectorProcessSpec(request.ConnectionID, request.Connector.Key,
		plan.Managed.Runtime.Language, launchExecutable, prepared.PreparedPath, arguments,
		plan.StateDir, plan.UserHome, plan.ArtifactTrees)
	connection, err := host.processes.Start(probeCtx, spec)
	if err != nil {
		return false, err
	}
	defer connection.Close()
	if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
		_ = graceful.CloseInput()
	}
	return waitInstallationProbe(probeCtx, connection)
}

func waitInstallationProbe(ctx context.Context, connection agentruntime.ProcessConnection) (bool, error) {
	outputBytes := 0
	for {
		var frame agentruntime.ProcessFrame
		var err error
		if contextual, ok := connection.(agentruntime.ContextProcessConnection); ok {
			frame, err = contextual.RecvContext(ctx)
		} else {
			frame, err = connection.Recv()
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return false, errors.New("installation probe exited without an exit code")
			}
			return false, err
		}
		outputBytes += len(frame.Stdout) + len(frame.Stderr)
		if outputBytes > maxInstallationProbeOutput {
			if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
				_ = graceful.Kill()
			}
			return false, errors.New("installation probe output exceeded its limit")
		}
		if frame.ExitCode == nil {
			continue
		}
		switch *frame.ExitCode {
		case 0:
			return true, nil
		case 1:
			return false, nil
		default:
			return false, fmt.Errorf("installation probe exited with indeterminate code %d", *frame.ExitCode)
		}
	}
}
