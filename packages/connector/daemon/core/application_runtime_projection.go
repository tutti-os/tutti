package host

import (
	"context"
	"errors"
)

func (application *Application) projectConnectorRuntimes(
	ctx context.Context,
	snapshot Snapshot,
	scope OperationScope,
) (Snapshot, error) {
	for index := range snapshot.Connectors {
		connector := &snapshot.Connectors[index]
		if connector.Installation.State != InstallationStateInstalled {
			connector.Runtime = nil
			continue
		}
		convergence, err := application.config.Repository.RuntimeConvergence(ctx, scope, connector.Key)
		if errors.Is(err, ErrNotFound) {
			// An installed Connector without a Desired row is legacy/bootstrap
			// planning debt, not an explicit user-disabled state. Project it as
			// starting while the independent planner creates durable intent.
			connector.Runtime = &ConnectorRuntime{State: ConnectorRuntimeStateStarting}
			continue
		}
		if err != nil {
			return Snapshot{}, err
		}
		connector.Runtime = connectorRuntimeProjection(convergence, application.config.BootEpoch)
	}
	return snapshot, nil
}

func connectorRuntimeProjection(convergence RuntimeConvergence, bootEpoch string) *ConnectorRuntime {
	observedCurrent := convergence.Observed.DesiredGeneration == convergence.Desired.Generation &&
		convergence.Observed.BootEpoch == bootEpoch
	if observedCurrent && convergence.Observed.Enabled &&
		convergence.Observed.Readiness.State == RuntimeReadinessReady {
		return &ConnectorRuntime{State: ConnectorRuntimeStateStarted}
	}
	if !convergence.Desired.Enabled {
		return &ConnectorRuntime{State: ConnectorRuntimeStateStopped}
	}
	if convergence.LastErrorCode != "" {
		return &ConnectorRuntime{State: ConnectorRuntimeStateFailed, FailureCode: convergence.LastErrorCode}
	}
	return &ConnectorRuntime{State: ConnectorRuntimeStateStarting}
}
