package implementationhost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

const maxCLIReadinessOutput = 64 << 10

func (host *Host) checkCLIReadiness(ctx context.Context, route *connectorRoute, probe *market.CLIReadinessProbe) error {
	if probe == nil {
		return nil
	}
	if host == nil || route == nil || route.cliLaunch == nil {
		return errors.New("connector CLI readiness target is unavailable")
	}
	launch := route.cliLaunch
	probeContext, cancel := context.WithTimeout(ctx, time.Duration(probe.TimeoutMS)*time.Millisecond)
	defer cancel()
	arguments := append(append([]string(nil), launch.arguments...), probe.Arguments...)
	spec := connectorruntime.ConnectorProcessSpec(route.connectionID, route.connectorKey, launch.language,
		launch.executable, launch.cwd, arguments, launch.stateDir, route.userHome, launch.artifactTrees)
	connection, processID, err := host.startProcess(probeContext, route, spec, false)
	if err != nil {
		return err
	}
	defer func() { _ = route.releaseProcess(processID, connection) }()
	if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
		_ = graceful.CloseInput()
	}
	return waitCLIReadiness(probeContext, connection)
}

func waitCLIReadiness(ctx context.Context, connection agentruntime.ProcessConnection) error {
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
				return errors.New("CLI readiness probe exited without an exit code")
			}
			return err
		}
		outputBytes += len(frame.Stdout) + len(frame.Stderr)
		if outputBytes > maxCLIReadinessOutput {
			if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
				_ = graceful.Kill()
			}
			return errors.New("CLI readiness probe output exceeded its limit")
		}
		if frame.ExitCode == nil {
			continue
		}
		if *frame.ExitCode != 0 {
			return fmt.Errorf("CLI readiness probe exited with code %d", *frame.ExitCode)
		}
		return nil
	}
}
