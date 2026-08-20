package host

import (
	"context"
	"fmt"
	"strings"
)

// replanRuntimeAfterAuthorizationRequired keeps device installation truth and
// turns a remote authorization-required observation into inactive runtime
// intent. Install and later convergence can then complete without retrying MCP
// 428 as install failure.
func (application *Application) replanRuntimeAfterAuthorizationRequired(
	ctx context.Context,
	convergence RuntimeConvergence,
	connector Connector,
	release Release,
) error {
	scope := convergence.Desired.Scope
	if application.config.AuthorizationProjections != nil && strings.TrimSpace(scope.AccountID) != "" {
		projection := AuthorizationProjection{
			AccountID:    scope.AccountID,
			ConnectorKey: connector.Key,
			ConnectionID: strings.TrimSpace(convergence.Desired.ConnectionID),
			State:        AuthorizationStateExpired,
			UpdatedAt:    application.config.Now().UTC(),
		}
		if current, err := application.config.AuthorizationProjections.AuthorizationProjection(
			ctx, scope.AccountID, connector.Key,
		); err == nil {
			if strings.TrimSpace(current.ConnectionID) != "" {
				projection.ConnectionID = strings.TrimSpace(current.ConnectionID)
			}
			projection.ConnectorVersion = current.ConnectorVersion
			projection.ServerSynchronized = current.ServerSynchronized
			projection.ConnectionVersion = current.ConnectionVersion
			projection.ServerRevision = current.ServerRevision
		}
		if err := application.saveAuthorizationProjection(ctx, ConnectorMutation{
			ConnectorKey: connector.Key,
			AccountID:    scope.AccountID,
		}, projection); err != nil {
			return err
		}
	}
	binding := RuntimeBinding{
		ConnectionID:       convergence.Desired.ConnectionID,
		Enabled:            false,
		AuthorizationState: AuthorizationStateExpired,
	}
	_, err := application.saveRuntimeDesired(
		ctx, scope, connector.Key, release.ReleaseDigest, binding, false, nil, nil,
	)
	return err
}

func (application *Application) inspectRuntimeAuthorization(
	ctx context.Context,
	convergence RuntimeConvergence,
	connector Connector,
) (Connector, error) {
	if connector.Release.Manifest.Implementation.ManagedStdio == nil ||
		connector.Release.Manifest.AuthorizationKind == "none" {
		return connector, nil
	}
	inspector, ok := application.config.Authorization.(AuthorizationInspector)
	if !ok {
		return connector, nil
	}
	observation, err := inspector.InspectAuthorization(ctx, AuthorizationInspectRequest{
		Scope: convergence.Desired.Scope, Connector: connector,
		AuthorizationGeneration: convergence.Desired.Generation,
		DesktopBootEpoch:        application.config.BootEpoch,
		StateRevision:           connector.Revision,
	})
	if err != nil {
		return Connector{}, fmt.Errorf("inspect connector authorization: %w", err)
	}
	if observation.ConnectorKey != "" && observation.ConnectorKey != connector.Key ||
		observation.ReleaseDigest != "" && observation.ReleaseDigest != connector.Release.ReleaseDigest {
		return Connector{}, invalidOperationReceipt("authorization inspector returned a mismatched observation")
	}
	var state AuthorizationState
	switch observation.State {
	case AuthorizationObservationConnected:
		state = AuthorizationStateConnected
	case AuthorizationObservationDisconnected:
		state = AuthorizationStateDisconnected
	case AuthorizationObservationExpired:
		state = AuthorizationStateExpired
	case AuthorizationObservationFailed:
		state = AuthorizationStateFailed
	case AuthorizationObservationPending:
		state = AuthorizationStatePending
	default:
		return Connector{}, invalidOperationReceipt("authorization inspector returned an invalid state")
	}
	if connector.Authorization.State != state || connector.Authorization.FailureCode != observation.FailureCode {
		err = application.config.Repository.Transaction(ctx, func(tx Transaction) error {
			stored, txErr := tx.Connector(connector.Key)
			if txErr != nil {
				return txErr
			}
			revision := tx.AdvanceRevision()
			stored.Authorization = Authorization{State: state, FailureCode: strings.TrimSpace(observation.FailureCode)}
			stored.Revision = revision
			if txErr := tx.SaveConnector(stored); txErr != nil {
				return txErr
			}
			return tx.EnqueueConnectorMarketChanged(ChangedEvent{ConnectorKey: stored.Key, Revision: revision})
		})
		if err != nil {
			return Connector{}, err
		}
		connector.Authorization = Authorization{State: state, FailureCode: strings.TrimSpace(observation.FailureCode)}
	}
	if application.config.AuthorizationProjections != nil && strings.TrimSpace(convergence.Desired.Scope.AccountID) != "" {
		connectionID := strings.TrimSpace(observation.ConnectionID)
		if state == AuthorizationStateConnected && connectionID == "" {
			return Connector{}, invalidOperationReceipt("connected authorization inspection returned no connection id")
		}
		if err := application.saveAuthorizationProjection(ctx, ConnectorMutation{
			ConnectorKey: connector.Key, AccountID: convergence.Desired.Scope.AccountID,
		}, AuthorizationProjection{
			AccountID: convergence.Desired.Scope.AccountID, ConnectorKey: connector.Key,
			ConnectionID: connectionID, State: state, FailureCode: observation.FailureCode,
			UpdatedAt: application.config.Now().UTC(),
		}); err != nil {
			return Connector{}, err
		}
	}
	return connector, nil
}
