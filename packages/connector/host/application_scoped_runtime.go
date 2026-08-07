package host

import (
	"context"
	"errors"
	"strings"
	"time"
)

// ReconcileRuntime reapplies device-installed truth for the mutation's
// explicit account scope. It does not mutate installation state.
func (application *Application) ReconcileRuntime(ctx context.Context, mutation ConnectorMutation) (MutationResult, error) {
	return application.acceptConnectorOperation(ctx, mutation, OperationKindReconcileRuntime, func(connector Connector) (Connector, error) {
		if connector.Installation.State != InstallationStateInstalled ||
			strings.TrimSpace(connector.Installation.InstalledReleaseDigest) == "" {
			return Connector{}, invalidTransition("runtime", string(connector.Installation.State), string(InstallationStateInstalled))
		}
		return connector, nil
	})
}

func (application *Application) GetAuthorizationProjection(
	ctx context.Context,
	accountID, connectorKey string,
) (AuthorizationProjection, error) {
	if application.config.AuthorizationProjections == nil {
		return AuthorizationProjection{}, NewDomainError(ErrorCodeUnavailable, "account authorization projections are not registered", false, nil)
	}
	if strings.TrimSpace(accountID) == "" || strings.TrimSpace(connectorKey) == "" {
		return AuthorizationProjection{}, invalidRequest("accountId and connectorKey are required")
	}
	return application.config.AuthorizationProjections.AuthorizationProjection(ctx, accountID, connectorKey)
}

// ObserveAuthorization persists server-observed account authorization and
// schedules a durable runtime reconcile for an installed connector.
func (application *Application) ObserveAuthorization(
	ctx context.Context,
	mutation ConnectorMutation,
	projection AuthorizationProjection,
) (MutationResult, error) {
	if application.config.AuthorizationProjections == nil {
		return MutationResult{}, NewDomainError(ErrorCodeUnavailable, "account authorization projections are not registered", false, nil)
	}
	projection.AccountID = strings.TrimSpace(projection.AccountID)
	projection.ConnectorKey = strings.TrimSpace(projection.ConnectorKey)
	projection.ConnectionID = strings.TrimSpace(projection.ConnectionID)
	if projection.AccountID == "" || projection.ConnectorKey == "" ||
		projection.AccountID != strings.TrimSpace(mutation.AccountID) ||
		projection.ConnectorKey != strings.TrimSpace(mutation.ConnectorKey) {
		return MutationResult{}, invalidRequest("authorization projection does not match the mutation scope")
	}
	if projection.ConnectionID != "" && !runtimeConnectionIDPattern.MatchString(projection.ConnectionID) {
		return MutationResult{}, invalidRequest("authorization projection connectionId is invalid")
	}
	switch projection.State {
	case AuthorizationStateNotRequired, AuthorizationStateDisconnected, AuthorizationStatePending,
		AuthorizationStateConnected, AuthorizationStateExpired, AuthorizationStateFailed:
	default:
		return MutationResult{}, invalidRequest("authorization projection state is invalid")
	}
	if projection.UpdatedAt.IsZero() {
		projection.UpdatedAt = application.config.Now().UTC()
	}
	if err := application.config.AuthorizationProjections.SaveAuthorizationProjection(ctx, projection); err != nil {
		return MutationResult{}, err
	}
	return application.ReconcileRuntime(ctx, mutation)
}

func (application *Application) ReconcileInstalledRuntimes(ctx context.Context) error {
	return application.ReconcileInstalledRuntimesForScope(ctx, OperationScope{})
}

// ReconcileInstalledRuntimesForScope rebuilds runtime intent for an explicit
// account authority after daemon or guest restart.
func (application *Application) ReconcileInstalledRuntimesForScope(ctx context.Context, scope OperationScope) error {
	if application == nil {
		return NewDomainError(ErrorCodeUnavailable, "connector application is unavailable", false, nil)
	}
	snapshot, err := application.config.Repository.Snapshot(ctx)
	if err != nil {
		return err
	}
	for _, connector := range snapshot.Connectors {
		if connector.Installation.State != InstallationStateInstalled {
			continue
		}
		installedRelease, evidenceErr := application.installedReleaseEvidence(ctx, connector)
		if evidenceErr != nil {
			return NewDomainError(ErrorCodeUnavailable, "installed connector release evidence is unavailable", false, nil)
		}
		if validationErr := ValidateRuntimeReleaseShape(installedRelease); validationErr != nil {
			return NewDomainError(ErrorCodeUnavailable, "installed connector release evidence is invalid", false, validationErr)
		}
		installedConnector := connector
		installedConnector.Release = installedRelease
		// Bootstrap first fences durable runtime intent at the connector's
		// current revision. Recovery must publish a strictly newer generation;
		// otherwise RouteTable correctly rejects it as a stale resurrection.
		generation := nextGeneration(connector.Revision)
		operationID := "reconcile/" + application.config.BootEpoch + "/" + connector.Key
		operation := Operation{OperationID: operationID, ConnectorKey: connector.Key, Scope: scope}
		binding, err := application.resolveRuntimeBinding(ctx, operation, installedConnector, installedRelease, RuntimeBindingPurposeReconcile)
		if err != nil {
			return NewDomainError(ErrorCodeUnavailable, "connector runtime binding could not be resolved", true, err)
		}
		receipt, err := application.reconcileRuntime(ctx, RuntimeReconcileRequest{
			OperationID: operationID, Scope: scope, ConnectionID: binding.ConnectionID,
			Connector: installedConnector, Enabled: binding.Enabled, CredentialBrokerGrant: binding.CredentialBrokerGrant,
			Generation: HostGeneration{BootEpoch: application.config.BootEpoch, Generation: generation},
		})
		if err != nil {
			return NewDomainError(ErrorCodeUnavailable, "connector runtime could not be reconciled", true, err)
		}
		if err := validateRuntimeReceipt(receipt, operationID, binding.ConnectionID, connector.Key,
			installedRelease.ReleaseDigest, HostGeneration{BootEpoch: application.config.BootEpoch, Generation: generation}); err != nil {
			return err
		}
	}
	return nil
}

func (application *Application) FenceInstalledRuntimes(ctx context.Context) error {
	return application.FenceInstalledRuntimesForScope(ctx, OperationScope{})
}

// FenceInstalledRuntimesForScope removes runtime projections without deleting
// device installation facts.
func (application *Application) FenceInstalledRuntimesForScope(ctx context.Context, scope OperationScope) error {
	if application == nil {
		return NewDomainError(ErrorCodeUnavailable, "connector application is unavailable", false, nil)
	}
	snapshot, err := application.config.Repository.Snapshot(ctx)
	if err != nil {
		return err
	}
	var fenceErrors []error
	for _, connector := range snapshot.Connectors {
		if connector.Installation.State != InstallationStateInstalled {
			continue
		}
		installedRelease, evidenceErr := application.installedReleaseEvidence(ctx, connector)
		if evidenceErr != nil {
			fenceErrors = append(fenceErrors, evidenceErr)
			continue
		}
		connector.Release = installedRelease
		operation := Operation{OperationID: "fence/" + application.config.BootEpoch + "/" + connector.Key,
			ConnectorKey: connector.Key, Scope: scope}
		binding, bindingErr := application.resolveRuntimeBinding(ctx, operation, connector, installedRelease, RuntimeBindingPurposeDeactivate)
		if bindingErr != nil {
			fenceErrors = append(fenceErrors, bindingErr)
			continue
		}
		clear(binding.CredentialBrokerGrant)
		fenceErrors = append(fenceErrors, application.config.Host.DeactivateRuntime(ctx, RuntimeDeactivationRequest{
			Scope: scope, ConnectionID: binding.ConnectionID, ConnectorKey: connector.Key,
			ReleaseDigest: connector.Installation.InstalledReleaseDigest,
			Generation:    HostGeneration{BootEpoch: application.config.BootEpoch, Generation: maxGeneration(connector.Revision)},
			Deadline:      application.config.Now().UTC().Add(5 * time.Second),
		}))
	}
	return errors.Join(fenceErrors...)
}

func maxGeneration(generation uint64) uint64 {
	if generation == 0 {
		return 1
	}
	return generation
}

func nextGeneration(generation uint64) uint64 {
	return maxGeneration(generation) + 1
}
