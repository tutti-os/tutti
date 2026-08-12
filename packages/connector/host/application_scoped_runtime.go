package host

import (
	"context"
	"errors"
	"fmt"
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

func (application *Application) projectAuthorizationAndScheduleRuntime(
	ctx context.Context,
	scope OperationScope,
	connectorKey, connectionID string,
	state AuthorizationState,
	failureCode string,
) error {
	if application.config.AuthorizationProjections == nil || strings.TrimSpace(scope.AccountID) == "" {
		return nil
	}
	connectionID = strings.TrimSpace(connectionID)
	if state == AuthorizationStateConnected && connectionID == "" {
		return invalidOperationReceipt("connected authorization did not provide a connection id")
	}
	connector, err := application.config.Repository.Connector(ctx, strings.TrimSpace(connectorKey))
	if err != nil {
		return err
	}
	release, err := application.installedReleaseEvidence(ctx, connector)
	if err != nil {
		return err
	}
	if release.Manifest.Implementation.RemoteStreamableHTTP != nil {
		snapshotStore, ok := application.config.AuthorizationProjections.(AuthorizationSnapshotStore)
		if !ok || application.config.AuthorizationSnapshots == nil {
			return NewDomainError(ErrorCodeUnavailable, "remote connector authorization snapshot is unavailable", true, nil)
		}
		authoritative, snapshotErr := application.config.AuthorizationSnapshots.AuthorizationSnapshot(ctx, scope.AccountID)
		if snapshotErr != nil {
			return fmt.Errorf("refresh remote connector authorization snapshot: %w", snapshotErr)
		}
		if _, applyErr := snapshotStore.ApplyAuthorizationSnapshot(ctx, scope.AccountID, authoritative); applyErr != nil {
			return fmt.Errorf("apply remote connector authorization snapshot: %w", applyErr)
		}
		if application.config.AuthorizationReadiness != nil {
			application.config.AuthorizationReadiness.SetReady(scope.AccountID, true)
		}
	} else {
		deviceSnapshot, snapshotErr := application.Snapshot(ctx)
		if snapshotErr != nil {
			return snapshotErr
		}
		requestID, idErr := application.config.NewID()
		if idErr != nil {
			return idErr
		}
		if _, err := application.ObserveAuthorization(ctx, ConnectorMutation{
			Mutation:     Mutation{ClientRequestID: "authorization-projection/" + requestID, ExpectedRevision: deviceSnapshot.Revision},
			ConnectorKey: strings.TrimSpace(connectorKey), AccountID: strings.TrimSpace(scope.AccountID),
		}, AuthorizationProjection{
			AccountID: strings.TrimSpace(scope.AccountID), ConnectorKey: strings.TrimSpace(connectorKey),
			ConnectionID: connectionID, State: state, FailureCode: strings.TrimSpace(failureCode), UpdatedAt: application.config.Now().UTC(),
		}); err != nil {
			return err
		}
		return nil
	}
	deviceSnapshot, err := application.Snapshot(ctx)
	if err != nil {
		return err
	}
	requestID, err := application.config.NewID()
	if err != nil {
		return err
	}
	_, err = application.ReconcileRuntime(ctx, ConnectorMutation{
		Mutation: Mutation{
			ClientRequestID:  "authorization-snapshot/" + requestID,
			ExpectedRevision: deviceSnapshot.Revision,
		},
		ConnectorKey: strings.TrimSpace(connectorKey),
		AccountID:    strings.TrimSpace(scope.AccountID),
	})
	return err
}

func (application *Application) ReconcileInstalledRuntimes(ctx context.Context) error {
	return application.ReconcileInstalledRuntimesForScope(ctx, OperationScope{})
}

// ReconcileInstalledRuntimesForScope rebuilds runtime intent for an explicit
// account authority after daemon or guest restart.
func (application *Application) ReconcileInstalledRuntimesForScope(ctx context.Context, scope OperationScope) error {
	return application.reconcileInstalledRuntimesForScope(ctx, scope, false)
}

// ReconcileRemoteAuthorizedRuntimesForScope is the level-triggered repair
// path for account snapshot convergence. It deliberately excludes local and
// authorization-free runtimes so the five-minute calibration cannot restart
// unrelated CLI or stdio processes.
func (application *Application) ReconcileRemoteAuthorizedRuntimesForScope(ctx context.Context, scope OperationScope) error {
	return application.reconcileInstalledRuntimesForScope(ctx, scope, true)
}

func (application *Application) InstalledRemoteAuthorizedConnectorKeys(ctx context.Context) ([]string, error) {
	snapshot, err := application.config.Repository.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0)
	for _, connector := range snapshot.Connectors {
		if connector.Installation.State != InstallationStateInstalled {
			continue
		}
		release, err := application.installedReleaseEvidence(ctx, connector)
		if err != nil {
			// Keep a currently-known remote connector eligible so a broken local
			// release evidence record cannot hide a fail-closed authorization
			// reconcile. Unrelated local connectors are skipped independently.
			release = connector.Release
		}
		if release.Manifest.Implementation.RemoteStreamableHTTP != nil && release.Manifest.AuthorizationKind != "none" {
			keys = append(keys, connector.Key)
		}
	}
	return keys, nil
}

// RuntimeReconcileFailures contains Connector-local recovery failures. The
// caller may safely publish routes committed by other Connectors while retrying
// these keys independently. Snapshot and generation-commit failures are not
// included because they require the global runtime fence to remain closed.
type RuntimeReconcileFailures struct {
	failures []error
	keys     []string
}

func (failures *RuntimeReconcileFailures) Error() string {
	return errors.Join(failures.failures...).Error()
}

func (failures *RuntimeReconcileFailures) Unwrap() []error {
	return append([]error(nil), failures.failures...)
}

func (failures *RuntimeReconcileFailures) ConnectorKeys() []string {
	return append([]string(nil), failures.keys...)
}

func (failures *RuntimeReconcileFailures) add(connectorKey, stage string, err error) {
	failures.keys = append(failures.keys, connectorKey)
	failures.failures = append(failures.failures, fmt.Errorf("%s: %s: %w", connectorKey, stage, err))
}

func (failures *RuntimeReconcileFailures) errOrNil() error {
	if len(failures.failures) == 0 {
		return nil
	}
	return failures
}

func (application *Application) reconcileInstalledRuntimesForScope(ctx context.Context, scope OperationScope, remoteAuthorizedOnly bool) error {
	if application == nil {
		return NewDomainError(ErrorCodeUnavailable, "connector application is unavailable", false, nil)
	}
	snapshot, err := application.config.Repository.Snapshot(ctx)
	if err != nil {
		return err
	}
	reconcileFailures := &RuntimeReconcileFailures{}
	for _, connector := range snapshot.Connectors {
		if connector.Installation.State != InstallationStateInstalled {
			continue
		}
		installedRelease, evidenceErr := application.installedReleaseEvidence(ctx, connector)
		if evidenceErr != nil {
			reconcileFailures.add(connector.Key, "load installed release", evidenceErr)
			continue
		}
		if remoteAuthorizedOnly && (installedRelease.Manifest.Implementation.RemoteStreamableHTTP == nil ||
			installedRelease.Manifest.AuthorizationKind == "none") {
			continue
		}
		if validationErr := ValidateRuntimeReleaseShape(installedRelease); validationErr != nil {
			reconcileFailures.add(connector.Key, "validate installed release", validationErr)
			continue
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
			reconcileFailures.add(connector.Key, "resolve runtime binding", err)
			continue
		}
		installedConnector.Authorization.State = binding.AuthorizationState
		receipt, err := application.reconcileRuntime(ctx, RuntimeReconcileRequest{
			OperationID: operationID, Scope: scope, ConnectionID: binding.ConnectionID,
			Connector: installedConnector, Enabled: binding.Enabled, CredentialBrokerGrant: binding.CredentialBrokerGrant,
			Generation: HostGeneration{BootEpoch: application.config.BootEpoch, Generation: generation},
		})
		if err != nil {
			reconcileFailures.add(connector.Key, "reconcile runtime", err)
			continue
		}
		if err := validateRuntimeReceipt(receipt, operationID, binding.ConnectionID, connector.Key,
			installedRelease.ReleaseDigest, HostGeneration{BootEpoch: application.config.BootEpoch, Generation: generation},
			binding.Enabled); err != nil {
			reconcileFailures.add(connector.Key, "validate runtime receipt", err)
			continue
		}
		if err := application.recordDirectRuntimeGeneration(ctx, scope, connector.Key, installedRelease.ReleaseDigest, operationID, generation); err != nil {
			if remoteAuthorizedOnly {
				reconcileFailures.add(connector.Key, "record runtime generation", err)
				continue
			}
			return err
		}
	}
	return reconcileFailures.errOrNil()
}

// recordDirectRuntimeGeneration makes startup reconciliation participate in
// the same durable generation clock as user-initiated operations. Without this
// commit, the VM can accept generation N+1 while SQLite remains at N; the next
// same-boot fence is then rejected as stale even though desktopd is the owner.
func (application *Application) recordDirectRuntimeGeneration(
	ctx context.Context,
	scope OperationScope,
	connectorKey, releaseDigest, operationID string,
	generation uint64,
) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		connector, err := tx.Connector(connectorKey)
		if err != nil {
			return err
		}
		if connector.Installation.State != InstallationStateInstalled ||
			connector.Installation.InstalledReleaseDigest != releaseDigest {
			return NewDomainError(ErrorCodeRevisionConflict, "installed connector changed during runtime recovery", true, nil)
		}
		if connector.Revision >= generation {
			return nil
		}
		revision := tx.Revision()
		for revision < generation {
			revision = tx.AdvanceRevision()
		}
		connector.Revision = revision
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		now := application.config.Now().UTC()
		if err := tx.SaveOperation(Operation{
			OperationID:     operationID,
			ClientRequestID: operationID,
			ConnectorKey:    connector.Key,
			Kind:            OperationKindReconcileRuntime,
			Scope:           scope,
			State:           OperationStateCompleted,
			Stage:           OperationStageCompleted,
			Target:          operationTarget(OperationKindReconcileRuntime, connector),
			HostGeneration:  HostGeneration{BootEpoch: application.config.BootEpoch, Generation: generation},
			Attempt:         1,
			CreatedAt:       now,
			UpdatedAt:       now,
		}); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: connector.Key, OperationID: operationID, Revision: revision,
		})
	})
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
