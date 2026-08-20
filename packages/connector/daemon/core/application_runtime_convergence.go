package host

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

func (application *Application) prepareInstallRuntimeDesired(
	ctx context.Context,
	operationID string,
	release Release,
	binding RuntimeBinding,
) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateCompleted {
			return nil
		}
		connector, err := tx.Connector(operation.ConnectorKey)
		if err != nil {
			return err
		}
		revision := tx.AdvanceRevision()
		connector.Installation.CandidateVersion = release.Version
		connector.Installation.CandidateReleaseID = release.ReleaseID
		connector.Installation.CandidateReleaseDigest = release.ReleaseDigest
		connector.Installation.FailureCode = ""
		connector.Revision = revision
		operation.State = OperationStateRunning
		operation.Stage = OperationStageRuntimePending
		operation.FailureCode = ""
		operation.UpdatedAt = application.config.Now().UTC()
		activationEnabled, err := runtimeActivationPreference(tx, operation.Scope, connector.Key)
		if err != nil {
			return err
		}
		binding.Enabled = binding.Enabled && activationEnabled
		if _, _, err := upsertRuntimeDesired(
			tx, operation.Scope, connector.Key, release.ReleaseDigest, binding, activationEnabled, nextGeneration(revision), false, operation.UpdatedAt,
		); err != nil {
			return err
		}
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: connector.Key,
			OperationID:  operation.OperationID,
			Revision:     revision,
		})
	})
}

func (application *Application) finalizeInstallAfterRuntime(
	ctx context.Context,
	operationID string,
) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateCompleted {
			return nil
		}
		connector, err := tx.Connector(operation.ConnectorKey)
		if err != nil {
			return err
		}
		if operation.Target == nil || connector.Installation.CandidateReleaseDigest != operation.Target.ReleaseDigest {
			return NewDomainError(ErrorCodeRevisionConflict, "connector install candidate changed before completion", true, nil)
		}
		convergence, err := tx.RuntimeConvergence(operation.Scope, connector.Key)
		if err != nil {
			return err
		}
		if convergence.Desired.ReleaseDigest != operation.Target.ReleaseDigest ||
			convergence.Observed.DesiredGeneration != convergence.Desired.Generation ||
			convergence.Observed.BootEpoch != application.config.BootEpoch {
			return NewDomainError(ErrorCodeUnavailable, "connector runtime candidate is not observed", true, nil)
		}
		revision := tx.AdvanceRevision()
		installedAt := application.config.Now().UTC()
		connector.Installation.State = InstallationStateInstalled
		connector.Installation.InstalledAtUnixMS = installedAt.UnixMilli()
		connector.Installation.InstalledVersion = connector.Installation.CandidateVersion
		connector.Installation.InstalledReleaseID = connector.Installation.CandidateReleaseID
		connector.Installation.InstalledReleaseDigest = connector.Installation.CandidateReleaseDigest
		connector.Installation.CandidateVersion = ""
		connector.Installation.CandidateReleaseID = ""
		connector.Installation.CandidateReleaseDigest = ""
		connector.Installation.FailureCode = ""
		connector.Revision = revision
		operation.State = OperationStateCompleted
		operation.Stage = OperationStageCompleted
		operation.FailureCode = ""
		operation.UpdatedAt = installedAt
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: connector.Key, OperationID: operation.OperationID, Revision: revision,
		})
	})
}

func (application *Application) prepareUninstallRuntimeDisabled(
	ctx context.Context,
	operationID string,
	release Release,
	binding RuntimeBinding,
) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		connector, err := tx.Connector(operation.ConnectorKey)
		if err != nil {
			return err
		}
		if connector.Installation.State != InstallationStateUninstalling ||
			connector.Installation.InstalledReleaseDigest != release.ReleaseDigest {
			return NewDomainError(ErrorCodeRevisionConflict, "connector uninstall target changed", true, nil)
		}
		binding.Enabled = false
		now := application.config.Now().UTC()
		revision := tx.AdvanceRevision()
		activationEnabled, err := runtimeActivationPreference(tx, operation.Scope, connector.Key)
		if err != nil {
			return err
		}
		if _, _, err := upsertRuntimeDesired(
			tx, operation.Scope, connector.Key, release.ReleaseDigest, binding, activationEnabled, nextGeneration(revision), false, now,
		); err != nil {
			return err
		}
		connector.Revision = revision
		operation.State = OperationStateRunning
		operation.Stage = OperationStageDeactivating
		operation.UpdatedAt = now
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: connector.Key, OperationID: operation.OperationID, Revision: revision,
		})
	})
}

// EnsureRuntimeDesired derives and durably records the current runtime intent
// without issuing or persisting a credential grant. Repeating the same intent
// is a no-op; a changed intent advances only the Connector's convergence
// generation.
func (application *Application) EnsureRuntimeDesired(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) (RuntimeConvergence, error) {
	return application.ensureRuntimeDesired(ctx, scope, connectorKey, false)
}

// PlanRuntimeAfterFence advances Desired without waiting for host convergence.
// Daemon bootstrap uses it after fail-closing routes so the background worker
// can independently prove a fresh Observed receipt even when the fence and the
// prior receipt were produced during the same daemon boot.
func (application *Application) PlanRuntimeAfterFence(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) (RuntimeConvergence, error) {
	return application.ensureRuntimeDesired(ctx, scope, connectorKey, true)
}

func (application *Application) ensureRuntimeDesired(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
	forceNewGeneration bool,
) (RuntimeConvergence, error) {
	connectorKey = strings.TrimSpace(connectorKey)
	scope.AccountID = strings.TrimSpace(scope.AccountID)
	if connectorKey == "" {
		return RuntimeConvergence{}, invalidRequest("connectorKey is required")
	}
	connector, release, err := application.runtimeConnectorAndRelease(ctx, connectorKey)
	if err != nil {
		return RuntimeConvergence{}, err
	}
	binding, err := application.resolveRuntimeBinding(ctx, Operation{
		OperationID:  "plan-runtime/" + connectorKey,
		ConnectorKey: connectorKey,
		Scope:        scope,
	}, connector, release, RuntimeBindingPurposePlan)
	if err != nil {
		return RuntimeConvergence{}, err
	}
	defer clear(binding.CredentialBrokerGrant)
	if len(binding.CredentialBrokerGrant) != 0 {
		return RuntimeConvergence{}, invalidOperationReceipt("runtime planning returned a credential grant")
	}
	return application.saveRuntimeDesired(ctx, scope, connectorKey, release.ReleaseDigest, binding, forceNewGeneration, nil, nil)
}

// SetRuntimeEnabled records user activation independently from installation
// and authorization. The resulting effective Desired is the conjunction of
// this durable preference and the current account binding.
func (application *Application) SetRuntimeEnabled(
	ctx context.Context,
	mutation ConnectorMutation,
	enabled bool,
) (Connector, error) {
	if err := validateConnectorMutation(mutation); err != nil {
		return Connector{}, err
	}
	mutation.Scope.AccountID = strings.TrimSpace(mutation.AccountID)
	connector, release, err := application.runtimeConnectorAndRelease(ctx, mutation.ConnectorKey)
	if err != nil {
		return Connector{}, err
	}
	binding, err := application.resolveRuntimeBinding(ctx, Operation{
		OperationID:  "set-runtime-enabled/" + connector.Key,
		ConnectorKey: connector.Key,
		Scope:        mutation.Scope,
	}, connector, release, RuntimeBindingPurposePlan)
	if err != nil {
		return Connector{}, err
	}
	defer clear(binding.CredentialBrokerGrant)
	if len(binding.CredentialBrokerGrant) != 0 {
		return Connector{}, invalidOperationReceipt("runtime activation planning returned a credential grant")
	}
	if _, err := application.saveRuntimeDesired(
		ctx, mutation.Scope, connector.Key, release.ReleaseDigest, binding, false, &enabled, &mutation,
	); err != nil {
		return Connector{}, err
	}
	snapshot, err := application.SnapshotForScope(ctx, mutation.Scope)
	if err != nil {
		return Connector{}, err
	}
	for _, projected := range snapshot.Connectors {
		if projected.Key == connector.Key {
			return projected, nil
		}
	}
	return Connector{}, ErrNotFound
}

// DueRuntimeConvergences returns private, level-triggered work for the active
// scope. Callers use it only as a scheduling hint; ClaimRuntimeConvergence
// rechecks every due predicate atomically.
func (application *Application) DueRuntimeConvergences(
	ctx context.Context,
	scope OperationScope,
	limit int,
) ([]RuntimeConvergence, error) {
	return application.config.Repository.DueRuntimeConvergences(
		ctx, scope, application.config.BootEpoch, application.config.Now().UTC(), limit,
	)
}

// ReconcileRuntimeDesired synchronously proves that the latest Desired is
// observed by this boot. If another worker owns the lease, it waits for that
// worker rather than creating a second public operation.
func (application *Application) ReconcileRuntimeDesired(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) error {
	if _, err := application.EnsureRuntimeDesired(ctx, scope, connectorKey); err != nil {
		return err
	}
	return application.awaitRuntimeDesired(ctx, scope, connectorKey)
}

func (application *Application) reconcileRuntimeDesiredAfterFence(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) error {
	if _, err := application.ensureRuntimeDesired(ctx, scope, connectorKey, true); err != nil {
		return err
	}
	return application.awaitRuntimeDesired(ctx, scope, connectorKey)
}

// ReconcileRuntimeAfterInvalidation advances the Desired generation even when
// its payload is unchanged. Runtime-exit and route-loss observers use this to
// invalidate an otherwise matching Observed receipt.
func (application *Application) ReconcileRuntimeAfterInvalidation(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) error {
	return application.reconcileRuntimeDesiredAfterFence(ctx, scope, connectorKey)
}

func (application *Application) awaitRuntimeDesired(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := application.ConvergeRuntime(ctx, scope, connectorKey); err != nil {
			return err
		}
		convergence, err := application.config.Repository.RuntimeConvergence(ctx, scope, connectorKey)
		if err != nil {
			return err
		}
		if convergence.Observed.DesiredGeneration == convergence.Desired.Generation &&
			convergence.Observed.BootEpoch == application.config.BootEpoch {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// ConvergeRuntime applies one durable Desired generation. Failures remain
// retryable convergence debt instead of becoming public terminal Operations.
func (application *Application) ConvergeRuntime(
	ctx context.Context,
	scope OperationScope,
	connectorKey string,
) (executeErr error) {
	now := application.config.Now().UTC()
	convergence, claimed, err := application.config.Repository.ClaimRuntimeConvergence(
		ctx, scope, connectorKey, application.config.BootEpoch, application.config.WorkerID,
		now, now.Add(application.config.LeaseDuration),
	)
	if err != nil || !claimed {
		return err
	}
	executionContext, cancelExecution := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go application.renewRuntimeConvergenceLease(executionContext, cancelExecution, convergence, heartbeatDone)
	defer func() {
		cancelExecution()
		heartbeatErr := <-heartbeatDone
		if heartbeatErr != nil {
			executeErr = errors.Join(executeErr, heartbeatErr)
		}
		_ = application.config.Repository.ReleaseRuntimeConvergenceLease(
			context.WithoutCancel(ctx), convergence.Desired.Scope, convergence.Desired.ConnectorKey,
			application.config.WorkerID, convergence.LeaseToken,
		)
	}()

	connector, release, err := application.runtimeConnectorAndReleaseForDigest(
		executionContext, convergence.Desired.ConnectorKey, convergence.Desired.ReleaseDigest, convergence.Desired.Enabled,
	)
	if err != nil {
		return application.retryRuntimeConvergence(ctx, convergence, err)
	}
	if release.ReleaseDigest != convergence.Desired.ReleaseDigest {
		return application.retryRuntimeConvergence(ctx, convergence,
			NewDomainError(ErrorCodeRevisionConflict, "installed connector changed during runtime convergence", true, nil))
	}
	operationID := fmt.Sprintf("runtime/%s/%s/%d", application.config.BootEpoch,
		convergence.Desired.ConnectorKey, convergence.Desired.Generation)
	operation := Operation{OperationID: operationID, ConnectorKey: connector.Key, Scope: convergence.Desired.Scope}
	binding := RuntimeBinding{
		ConnectionID: convergence.Desired.ConnectionID, Enabled: false,
		AuthorizationState: convergence.Desired.AuthorizationState,
	}
	if convergence.Desired.Enabled {
		connector, err = application.inspectRuntimeAuthorization(executionContext, convergence, connector)
		if err != nil {
			return application.retryRuntimeConvergence(ctx, convergence, err)
		}
		binding, err = application.resolveRuntimeBinding(executionContext, operation, connector, release, RuntimeBindingPurposeReconcile)
		if err != nil {
			return application.retryRuntimeConvergence(ctx, convergence, err)
		}
	}
	defer clear(binding.CredentialBrokerGrant)
	if !runtimeBindingMatchesDesired(binding, convergence.Desired) {
		clear(binding.CredentialBrokerGrant)
		_, saveErr := application.saveRuntimeDesired(
			context.WithoutCancel(ctx), convergence.Desired.Scope, connector.Key, release.ReleaseDigest, binding, false, nil, nil,
		)
		return saveErr
	}
	connector.Authorization.State = binding.AuthorizationState
	generation := HostGeneration{BootEpoch: application.config.BootEpoch, Generation: convergence.Desired.Generation}
	receipt, err := application.reconcileRuntime(executionContext, RuntimeReconcileRequest{
		OperationID: operationID, Scope: convergence.Desired.Scope, ConnectionID: binding.ConnectionID,
		Connector: connector, Enabled: binding.Enabled, Generation: generation,
		ConnectionVersion:     binding.ConnectionVersion,
		ServerRevision:        binding.ServerRevision,
		CredentialBrokerGrant: binding.CredentialBrokerGrant,
	})
	if err != nil {
		if authorizationRequiredError(err) {
			return application.replanRuntimeAfterAuthorizationRequired(
				context.WithoutCancel(ctx), convergence, connector, release,
			)
		}
		return application.retryRuntimeConvergence(ctx, convergence,
			NewDomainError(ErrorCodeInstallFailed, "connector runtime could not be reconciled", true, err))
	}
	if err := validateRuntimeReceipt(receipt, operationID, binding.ConnectionID, connector.Key,
		release.ReleaseDigest, generation, binding.Enabled); err != nil {
		return application.retryRuntimeConvergence(ctx, convergence, err)
	}
	observedAt := application.config.Now().UTC()
	observed := RuntimeObserved{
		DesiredGeneration: convergence.Desired.Generation,
		BootEpoch:         application.config.BootEpoch,
		Enabled:           binding.Enabled,
		ConnectionID:      binding.ConnectionID,
		ReleaseDigest:     release.ReleaseDigest,
		Readiness:         receipt.Readiness,
		Summary:           receipt.Summary,
		ObservedAt:        observedAt,
	}
	return application.completeRuntimeConvergence(context.WithoutCancel(ctx), convergence, observed, observedAt)
}

func (application *Application) completeRuntimeConvergence(
	ctx context.Context,
	claimed RuntimeConvergence,
	observed RuntimeObserved,
	now time.Time,
) error {
	return application.finishRuntimeConvergence(ctx, claimed, now, func(convergence *RuntimeConvergence) {
		convergence.Observed = observed
		convergence.Attempt = 0
		convergence.NextAttemptAt = time.Time{}
		convergence.LastErrorCode = ""
		convergence.LastError = ""
	})
}

func (application *Application) runtimeConnectorAndRelease(
	ctx context.Context,
	connectorKey string,
) (Connector, Release, error) {
	connector, err := application.config.Repository.Connector(ctx, strings.TrimSpace(connectorKey))
	if err != nil {
		return Connector{}, Release{}, err
	}
	connector, err = validateRuntimeReconcileConnector(connector)
	if err != nil {
		return Connector{}, Release{}, err
	}
	release, err := application.installedReleaseEvidence(ctx, connector)
	if err != nil {
		return Connector{}, Release{}, err
	}
	connector.Release = release
	return connector, release, nil
}

func (application *Application) runtimeConnectorAndReleaseForDigest(
	ctx context.Context,
	connectorKey, releaseDigest string,
	validateRelease bool,
) (Connector, Release, error) {
	connector, err := application.config.Repository.Connector(ctx, strings.TrimSpace(connectorKey))
	if err != nil {
		return Connector{}, Release{}, err
	}
	releaseDigest = strings.TrimSpace(releaseDigest)
	current := (connector.Installation.State == InstallationStateInstalled ||
		connector.Installation.State == InstallationStateUninstalling) &&
		connector.Installation.InstalledReleaseDigest == releaseDigest
	candidate := (connector.Installation.State == InstallationStateInstalling ||
		connector.Installation.State == InstallationStateUpdating) &&
		connector.Installation.CandidateReleaseDigest == releaseDigest
	if !current && !candidate {
		return Connector{}, Release{}, NewDomainError(
			ErrorCodeRevisionConflict, "runtime target is not the current or candidate release", true, nil,
		)
	}
	release, err := application.config.Repository.InstalledRelease(ctx, connector.Key, releaseDigest)
	if errors.Is(err, ErrNotFound) && connector.Release.ReleaseDigest == releaseDigest {
		release, err = connector.Release, nil
	}
	if err != nil {
		return Connector{}, Release{}, err
	}
	if validateRelease {
		if err := ValidateRuntimeReleaseShape(release); err != nil {
			return Connector{}, Release{}, err
		}
	}
	connector.Release = release
	return connector, release, nil
}

func (application *Application) saveRuntimeDesired(
	ctx context.Context,
	scope OperationScope,
	connectorKey, releaseDigest string,
	binding RuntimeBinding,
	forceNewGeneration bool,
	activationOverride *bool,
	mutation *ConnectorMutation,
) (RuntimeConvergence, error) {
	var saved RuntimeConvergence
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		connector, err := tx.Connector(connectorKey)
		if err != nil {
			return err
		}
		if !runtimeDesiredTargetMatches(connector, releaseDigest) {
			return NewDomainError(ErrorCodeRevisionConflict, "installed connector changed while planning runtime", true, nil)
		}
		if mutation != nil {
			if mutation.ExpectedConnectorRevision != nil {
				if connector.Revision != *mutation.ExpectedConnectorRevision {
					return NewDomainError(
						ErrorCodeRevisionConflict,
						fmt.Sprintf("expected connector revision %d but current connector revision is %d", *mutation.ExpectedConnectorRevision, connector.Revision),
						true,
						nil,
					)
				}
			} else if err := verifyRevision(tx, mutation.ExpectedRevision); err != nil {
				return err
			}
		}
		activationEnabled, err := runtimeActivationPreference(tx, scope, connectorKey)
		if err != nil {
			return err
		}
		if activationOverride != nil {
			activationEnabled = *activationOverride
		}
		binding.Enabled = binding.Enabled && activationEnabled
		convergence, changed, err := upsertRuntimeDesired(
			tx, scope, connectorKey, releaseDigest, binding, activationEnabled, nextGeneration(connector.Revision), forceNewGeneration,
			application.config.Now().UTC(),
		)
		if err != nil {
			return err
		}
		saved = convergence
		if !changed {
			return nil
		}
		revision := tx.AdvanceRevision()
		for revision <= connector.Revision {
			revision = tx.AdvanceRevision()
		}
		connector.Revision = revision
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{ConnectorKey: connectorKey, Revision: revision})
	})
	return saved, err
}

func upsertRuntimeDesired(
	tx Transaction,
	scope OperationScope,
	connectorKey, releaseDigest string,
	binding RuntimeBinding,
	activationEnabled bool,
	minimumGeneration uint64,
	forceNewGeneration bool,
	now time.Time,
) (RuntimeConvergence, bool, error) {
	scope.AccountID = strings.TrimSpace(scope.AccountID)
	connectorKey = strings.TrimSpace(connectorKey)
	releaseDigest = strings.TrimSpace(releaseDigest)
	binding.ConnectionID = strings.TrimSpace(binding.ConnectionID)
	if connectorKey == "" || releaseDigest == "" || binding.ConnectionID == "" {
		return RuntimeConvergence{}, false, invalidOperationReceipt("runtime desired identity is incomplete")
	}
	convergence, err := tx.RuntimeConvergence(scope, connectorKey)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return RuntimeConvergence{}, false, err
	}
	if err == nil && !forceNewGeneration && runtimeDesiredMatchesBinding(convergence.Desired, releaseDigest, binding, activationEnabled) {
		return convergence, false, nil
	}
	generation := maxGeneration(minimumGeneration)
	if err == nil {
		if convergence.Desired.Generation == math.MaxUint64 {
			return RuntimeConvergence{}, false, NewDomainError(ErrorCodeUnavailable, "runtime desired generation is exhausted", false, nil)
		}
		generation = convergence.Desired.Generation + 1
		if generation < minimumGeneration {
			generation = minimumGeneration
		}
		convergence.LeaseToken++
	}
	convergence.Desired = RuntimeDesired{
		Scope: scope, ConnectorKey: connectorKey, Generation: generation, ActivationEnabled: boolPointer(activationEnabled), Enabled: binding.Enabled,
		ConnectionID: binding.ConnectionID, ReleaseDigest: releaseDigest, AuthorizationState: binding.AuthorizationState,
		UpdatedAt: now,
	}
	convergence.Attempt = 0
	convergence.NextAttemptAt = now
	convergence.LeaseOwner = ""
	convergence.LeaseExpiresAt = nil
	convergence.LastErrorCode = ""
	convergence.LastError = ""
	convergence.UpdatedAt = now
	if err := tx.SaveRuntimeConvergence(convergence); err != nil {
		return RuntimeConvergence{}, false, err
	}
	return convergence, true, nil
}

func runtimeDesiredMatchesBinding(desired RuntimeDesired, releaseDigest string, binding RuntimeBinding, activationEnabled bool) bool {
	return desired.ReleaseDigest == strings.TrimSpace(releaseDigest) && desired.Enabled == binding.Enabled &&
		runtimeActivationEnabled(desired) == activationEnabled && desired.ConnectionID == strings.TrimSpace(binding.ConnectionID) &&
		desired.AuthorizationState == binding.AuthorizationState
}

func runtimeBindingMatchesDesired(binding RuntimeBinding, desired RuntimeDesired) bool {
	return desired.ReleaseDigest != "" && desired.Enabled == binding.Enabled &&
		desired.ConnectionID == strings.TrimSpace(binding.ConnectionID) && desired.AuthorizationState == binding.AuthorizationState
}

func runtimeDesiredTargetMatches(connector Connector, releaseDigest string) bool {
	releaseDigest = strings.TrimSpace(releaseDigest)
	if connector.Installation.State == InstallationStateInstalled &&
		connector.Installation.InstalledReleaseDigest == releaseDigest {
		return true
	}
	return (connector.Installation.State == InstallationStateInstalling ||
		connector.Installation.State == InstallationStateUpdating) &&
		connector.Installation.CandidateReleaseDigest == releaseDigest
}

func runtimeActivationEnabled(desired RuntimeDesired) bool {
	return desired.ActivationEnabled == nil || *desired.ActivationEnabled
}

func runtimeActivationPreference(tx Transaction, scope OperationScope, connectorKey string) (bool, error) {
	convergence, err := tx.RuntimeConvergence(scope, connectorKey)
	if errors.Is(err, ErrNotFound) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return runtimeActivationEnabled(convergence.Desired), nil
}

func boolPointer(value bool) *bool {
	return &value
}

func (application *Application) retryRuntimeConvergence(
	ctx context.Context,
	convergence RuntimeConvergence,
	cause error,
) error {
	now := application.config.Now().UTC()
	nextAttemptAt := now.Add(runtimeConvergenceBackoff(convergence.Attempt + 1))
	message := strings.TrimSpace(cause.Error())
	if len(message) > 512 {
		message = message[:512]
	}
	retryErr := application.finishRuntimeConvergence(context.WithoutCancel(ctx), convergence, now,
		func(current *RuntimeConvergence) {
			current.Attempt++
			current.NextAttemptAt = nextAttemptAt
			current.LastErrorCode = string(errorCodeOr(cause, ErrorCodeUnavailable))
			current.LastError = message
		})
	if retryErr != nil && !errors.Is(retryErr, ErrOperationLeaseLost) {
		return errors.Join(cause, fmt.Errorf("record runtime convergence retry: %w", retryErr))
	}
	return cause
}

// finishRuntimeConvergence atomically commits the private lease outcome and a
// public projection invalidation. Without this shared transaction, a runtime
// could become ready or fail after bootstrap while the UI remained on the
// earlier "starting" snapshot until an unrelated market event occurred.
func (application *Application) finishRuntimeConvergence(
	ctx context.Context,
	claimed RuntimeConvergence,
	now time.Time,
	update func(*RuntimeConvergence),
) error {
	now = now.UTC()
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		convergence, err := tx.RuntimeConvergence(claimed.Desired.Scope, claimed.Desired.ConnectorKey)
		if err != nil {
			return err
		}
		if convergence.Desired.Generation != claimed.Desired.Generation ||
			convergence.LeaseOwner != application.config.WorkerID ||
			convergence.LeaseToken != claimed.LeaseToken ||
			convergence.LeaseExpiresAt == nil || !convergence.LeaseExpiresAt.After(now) {
			return ErrOperationLeaseLost
		}
		update(&convergence)
		convergence.LeaseOwner = ""
		convergence.LeaseExpiresAt = nil
		convergence.UpdatedAt = now
		connector, err := tx.Connector(claimed.Desired.ConnectorKey)
		if err != nil {
			return err
		}
		revision := tx.AdvanceRevision()
		for revision <= connector.Revision {
			revision = tx.AdvanceRevision()
		}
		connector.Revision = revision
		if err := tx.SaveRuntimeConvergence(convergence); err != nil {
			return err
		}
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: connector.Key,
			Revision:     revision,
		})
	})
}

func runtimeConvergenceBackoff(attempt uint32) time.Duration {
	if attempt > 6 {
		attempt = 6
	}
	return time.Second * time.Duration(uint64(1)<<attempt)
}

func (application *Application) renewRuntimeConvergenceLease(
	ctx context.Context,
	cancel context.CancelFunc,
	convergence RuntimeConvergence,
	done chan<- error,
) {
	interval := application.config.LeaseDuration / 3
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	defer close(done)
	for {
		select {
		case <-ctx.Done():
			done <- nil
			return
		case <-ticker.C:
			now := application.config.Now().UTC()
			renewContext, renewCancel := context.WithTimeout(context.WithoutCancel(ctx), interval)
			err := application.config.Repository.RenewRuntimeConvergenceLease(
				renewContext, convergence.Desired.Scope, convergence.Desired.ConnectorKey,
				application.config.WorkerID, convergence.LeaseToken, now, now.Add(application.config.LeaseDuration),
			)
			renewCancel()
			if err != nil {
				cancel()
				done <- err
				return
			}
		}
	}
}
