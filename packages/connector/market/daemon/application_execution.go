package daemon

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

func (application *Application) executeRefresh(ctx context.Context, operation Operation) error {
	if _, err := application.updateOperationStage(ctx, operation.OperationID, OperationStageRefreshing, nil); err != nil {
		return err
	}
	catalog, err := application.config.CatalogSource.Refresh(ctx)
	if err != nil {
		return preserveCatalogSourceError("connector catalog refresh failed", err)
	}
	for _, release := range catalog.Releases {
		if err := ValidateReleaseShape(release); err != nil {
			return err
		}
		if release.Status != ReleaseStatusAvailable {
			return invalidManifest("active catalog releases must have available status", nil)
		}
	}
	err = application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		storedOperation, err := tx.Operation(operation.OperationID)
		if err != nil {
			return err
		}
		existing, err := tx.Connectors()
		if err != nil {
			return err
		}
		byKey := make(map[string]Connector, len(existing))
		for _, connector := range existing {
			byKey[connector.Key] = connector
		}
		revision := tx.AdvanceRevision()
		accepted := make(map[string]bool, len(catalog.Releases))
		for _, release := range catalog.Releases {
			accepted[release.ConnectorKey] = true
			connector, ok := byKey[release.ConnectorKey]
			if !ok {
				connector = newCatalogConnector(release)
			}
			connector.Release = release
			compatibility, err := application.compatibilityFor(release.Manifest)
			if err != nil {
				return err
			}
			connector.Compatibility = compatibility
			connector.Revision = revision
			if err := tx.SaveConnector(connector); err != nil {
				return err
			}
		}
		for _, connector := range existing {
			if accepted[connector.Key] {
				continue
			}
			if connector.Installation.State == InstallationStateNotInstalled {
				if err := tx.DeleteConnector(connector.Key); err != nil {
					return err
				}
				continue
			}
			connector.Compatibility = Compatibility{
				State:  CompatibilityStateUnsupportedVersion,
				Reason: "removed_from_catalog",
			}
			connector.Revision = revision
			if err := tx.SaveConnector(connector); err != nil {
				return err
			}
		}
		storedOperation.State = OperationStateCompleted
		storedOperation.Stage = OperationStageCompleted
		storedOperation.UpdatedAt = application.config.Now().UTC()
		if err := tx.SaveOperation(storedOperation); err != nil {
			return err
		}
		if err := tx.SaveCatalogRevision(catalog.SourceRevision); err != nil {
			return err
		}
		if err := tx.SetCatalogState(CatalogStateReady); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{
			OperationID: storedOperation.OperationID,
			Revision:    revision,
		})
	})
	if err != nil {
		return err
	}
	return nil
}

func (application *Application) executeInstall(ctx context.Context, operation Operation) error {
	release, err := frozenRelease(operation)
	if err != nil {
		return err
	}
	if err := application.config.ImplementationRegistry.Validate(release.Manifest); err != nil {
		return err
	}
	operation, err = application.updateOperationStage(ctx, operation.OperationID, OperationStageDownloading, nil)
	if err != nil {
		return err
	}
	prepared, prepareErr := application.config.ArtifactPreparer.Prepare(ctx, PrepareArtifactRequest{
		OperationID: operation.OperationID,
		Release:     release,
	})
	if prepareErr != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector artifact preparation failed", true, prepareErr)
	}
	if err := validatePreparedArtifact(operation, release, prepared); err != nil {
		return err
	}
	operation, err = application.updateOperationStage(
		ctx,
		operation.OperationID,
		OperationStagePrepared,
		func(current *Operation) { current.Execution.PreparedArtifact = &prepared },
	)
	if err != nil {
		return err
	}
	if cliInstall := releaseCLIInstallation(release); cliInstall != nil {
		if application.config.CLIInstallations == nil {
			return NewDomainError(ErrorCodeInstallFailed, "connector CLI installation is not registered", false, nil)
		}
		operation, err = application.updateOperationStage(ctx, operation.OperationID, OperationStageActivating, nil)
		if err != nil {
			return err
		}
		installed, installErr := application.config.CLIInstallations.InstallCLI(ctx, InstallCLIRequest{
			OperationID: operation.OperationID,
			Release:     release,
		})
		if installErr != nil {
			return NewDomainError(ErrorCodeInstallFailed, "connector CLI installation failed", true, installErr)
		}
		if err := validateCLIInstallationReceipt(operation, release, *cliInstall, installed); err != nil {
			return err
		}
		operation, err = application.updateOperationStage(ctx, operation.OperationID, OperationStageActivating,
			func(current *Operation) { current.Execution.CLIInstallation = &installed })
		if err != nil {
			return err
		}
	}

	rollout, err := application.rolloutInstalledBindings(ctx, operation, release)
	if err != nil {
		return err
	}
	err = application.completeConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
		connector.Installation = Installation{
			State:                  InstallationStateInstalled,
			InstalledVersion:       release.Version,
			InstalledReleaseID:     release.ReleaseID,
			InstalledReleaseDigest: release.ReleaseDigest,
		}
		return connector
	})
	if err != nil {
		return errors.Join(err, application.rollbackInstalledBindings(context.WithoutCancel(ctx), operation, rollout))
	}
	return nil
}

type installRollout struct {
	previous *Release
	applied  []string
}

func (application *Application) rolloutInstalledBindings(ctx context.Context, operation Operation, release Release) (installRollout, error) {
	rollout := installRollout{}
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey)
	if err != nil {
		return rollout, err
	}
	if connector.Installation.InstalledReleaseDigest != "" && connector.Installation.InstalledReleaseDigest != release.ReleaseDigest {
		previous, evidenceErr := application.installedReleaseEvidence(ctx, connector)
		if evidenceErr != nil {
			return rollout, evidenceErr
		}
		rollout.previous = &previous
	}
	connector.Release = release
	connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: release.Version,
		InstalledReleaseID: release.ReleaseID, InstalledReleaseDigest: release.ReleaseDigest}
	generation := operation.HostGeneration
	if strings.TrimSpace(generation.BootEpoch) == "" || generation.Generation == 0 {
		return rollout, invalidOperationReceipt("install rollout generation is missing")
	}
	for _, connectionID := range []string{defaultConnectorConnectionID} {
		operationID := operation.OperationID + "/rollout/" + connectionID
		receipt, reconcileErr := application.config.Host.Reconcile(ctx, RuntimeReconcileRequest{
			OperationID: operationID, ConnectionID: connectionID, Connector: connector, Enabled: true, Generation: generation,
		})
		if reconcileErr == nil {
			reconcileErr = validateRuntimeReceipt(receipt, operationID, connectionID,
				operation.ConnectorKey, release.ReleaseDigest, generation)
		}
		if reconcileErr != nil {
			rollbackErr := application.rollbackInstalledBindings(context.WithoutCancel(ctx), operation, rollout)
			return rollout, NewDomainError(ErrorCodeInstallFailed, "connector runtime could not be rolled forward", true, errors.Join(reconcileErr, rollbackErr))
		}
		rollout.applied = append(rollout.applied, connectionID)
	}
	return rollout, nil
}

func (application *Application) rollbackInstalledBindings(ctx context.Context, operation Operation, rollout installRollout) error {
	if len(rollout.applied) == 0 {
		return nil
	}
	var rollbackErrors []error
	for index := len(rollout.applied) - 1; index >= 0; index-- {
		connectionID := rollout.applied[index]
		if rollout.previous == nil {
			rollbackErrors = append(rollbackErrors, application.config.Host.DeactivateRuntime(ctx, RuntimeDeactivationRequest{
				ConnectionID: connectionID, ConnectorKey: operation.ConnectorKey,
				ReleaseDigest: operation.Target.ReleaseDigest, Generation: operation.HostGeneration,
				Deadline: application.config.Now().UTC().Add(5 * time.Second),
			}))
			continue
		}
		previousConnector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey)
		if err != nil {
			rollbackErrors = append(rollbackErrors, err)
			continue
		}
		previousConnector.Release = *rollout.previous
		previousConnector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: rollout.previous.Version,
			InstalledReleaseID: rollout.previous.ReleaseID, InstalledReleaseDigest: rollout.previous.ReleaseDigest}
		rollbackOperationID := operation.OperationID + "/rollback/" + connectionID
		receipt, err := application.config.Host.Reconcile(ctx, RuntimeReconcileRequest{OperationID: rollbackOperationID,
			ConnectionID: connectionID, Connector: previousConnector, Enabled: true, Generation: operation.HostGeneration})
		if err == nil {
			err = validateRuntimeReceipt(receipt, rollbackOperationID, connectionID,
				operation.ConnectorKey, rollout.previous.ReleaseDigest, operation.HostGeneration)
		}
		rollbackErrors = append(rollbackErrors, err)
	}
	return errors.Join(rollbackErrors...)
}

func (application *Application) installedReleaseEvidence(ctx context.Context, connector Connector) (Release, error) {
	release, err := application.config.Repository.InstalledRelease(ctx, connector.Key, connector.Installation.InstalledReleaseDigest)
	if err == nil && release.ReleaseDigest == connector.Installation.InstalledReleaseDigest {
		return release, nil
	}
	if connector.Release.ReleaseDigest == connector.Installation.InstalledReleaseDigest {
		return connector.Release, nil
	}
	return Release{}, NewDomainError(ErrorCodeUnavailable, "installed connector release evidence is unavailable", false, err)
}

func (application *Application) executeUninstall(ctx context.Context, operation Operation) error {
	if operation.Target == nil || strings.TrimSpace(operation.Target.ReleaseDigest) == "" {
		return invalidOperationReceipt("uninstall operation target is missing")
	}
	operation, err := application.updateOperationStage(ctx, operation.OperationID, OperationStageDeactivating, nil)
	if err != nil {
		return err
	}
	if err := application.config.Host.DeactivateRuntime(ctx, RuntimeDeactivationRequest{
		ConnectionID: defaultConnectorConnectionID, ConnectorKey: operation.Target.ConnectorKey, ReleaseDigest: operation.Target.ReleaseDigest,
		Generation: operation.HostGeneration,
		Deadline:   application.config.Now().UTC().Add(5 * time.Second),
	}); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector runtime routes could not be deactivated", true, err)
	}
	if operation.Target.Release != nil && releaseCLIInstallation(*operation.Target.Release) != nil {
		if application.config.CLIInstallations == nil {
			return NewDomainError(ErrorCodeInstallFailed, "connector CLI installation is not registered", false, nil)
		}
		if err := application.config.CLIInstallations.RemoveCLI(ctx, RemoveCLIRequest{
			OperationID: operation.OperationID, ConnectorKey: operation.Target.ConnectorKey,
			ReleaseDigest: operation.Target.ReleaseDigest,
		}); err != nil {
			return NewDomainError(ErrorCodeInstallFailed, "connector CLI installation cleanup failed", true, err)
		}
	}
	if err := application.config.ArtifactPreparer.Remove(ctx, RemoveArtifactRequest{
		OperationID:   operation.OperationID,
		ConnectorKey:  operation.Target.ConnectorKey,
		Version:       operation.Target.Version,
		ReleaseDigest: operation.Target.ReleaseDigest,
	}); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector prepared artifact cleanup failed", true, err)
	}
	return application.completeUninstall(ctx, operation.OperationID)
}

func (application *Application) completeUninstall(ctx context.Context, operationID string) error {
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
		connector.Installation = Installation{State: InstallationStateNotInstalled}
		connector.Authorization = initialAuthorization(connector.Release.Manifest.AuthorizationKind)
		connector.Revision = revision
		operation.State, operation.Stage, operation.FailureCode = OperationStateCompleted, OperationStageCompleted, ""
		operation.UpdatedAt = application.config.Now().UTC()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{ConnectorKey: connector.Key, OperationID: operation.OperationID, Revision: revision})
	})
}

const defaultConnectorConnectionID = "default"

func validateRuntimeReceipt(receipt RuntimeReceipt, operationID, connectionID, connectorKey,
	releaseDigest string, generation HostGeneration) error {
	if receipt.OperationID != operationID || receipt.ConnectionID != connectionID ||
		receipt.ConnectorKey != connectorKey || receipt.ReleaseDigest != releaseDigest || receipt.Generation != generation {
		return invalidOperationReceipt("implementation host returned a mismatched runtime receipt")
	}
	return nil
}

func (application *Application) beginAuthorizationSession(
	ctx context.Context,
	operation Operation,
) (AuthorizationSession, error) {
	release, err := frozenRelease(operation)
	if err != nil {
		return AuthorizationSession{}, err
	}
	if operation.State == OperationStateAccepted {
		operation, err = application.markOperationRunning(ctx, operation.OperationID)
		if err != nil {
			return AuthorizationSession{}, err
		}
	}
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey)
	if err != nil {
		return AuthorizationSession{}, err
	}
	if operation.State != OperationStateCompleted {
		operation, err = application.updateOperationStage(ctx, operation.OperationID, OperationStageAuthorizing, nil)
		if err != nil {
			return AuthorizationSession{}, err
		}
	}
	session, err := application.config.Authorization.Begin(ctx, AuthorizationStartRequest{
		OperationID:     operation.OperationID,
		ClientRequestID: operation.ClientRequestID,
		Connector:       connector,
		Release:         release,
	})
	if err != nil {
		return AuthorizationSession{}, NewDomainError(
			ErrorCodeAuthorizationFailed,
			"connector authorization could not be started",
			true,
			err,
		)
	}
	if session.OperationID != operation.OperationID || session.ConnectorKey != operation.ConnectorKey ||
		strings.TrimSpace(session.SessionID) == "" || strings.TrimSpace(session.AuthorizationURL) == "" {
		return AuthorizationSession{}, invalidOperationReceipt("authorization provider returned an invalid session")
	}
	if operation.State != OperationStateCompleted {
		if err := application.completeAuthorizationStart(ctx, operation.OperationID, session); err != nil {
			return AuthorizationSession{}, err
		}
	}
	return session, nil
}

func (application *Application) executeDisconnectAuthorization(ctx context.Context, operation Operation) error {
	operation, err := application.updateOperationStage(ctx, operation.OperationID, OperationStageDisconnecting, nil)
	if err != nil {
		return err
	}
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey)
	if err != nil {
		return err
	}
	if err := application.config.Authorization.Disconnect(ctx, AuthorizationDisconnectRequest{
		OperationID: operation.OperationID,
		Connector:   connector,
	}); err != nil {
		return NewDomainError(ErrorCodeAuthorizationFailed, "connector authorization disconnect failed", true, err)
	}
	return application.completeConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
		connector.Authorization = Authorization{State: AuthorizationStateDisconnected}
		return connector
	})
}

func (application *Application) markOperationRunning(ctx context.Context, operationID string) (Operation, error) {
	var result Operation
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateCompleted || operation.State == OperationStateFailed {
			result = operation
			return nil
		}
		revision := tx.AdvanceRevision()
		operation.State = OperationStateRunning
		operation.Attempt++
		operation.UpdatedAt = application.config.Now().UTC()
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		if err := tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: operation.ConnectorKey,
			OperationID:  operation.OperationID,
			Revision:     revision,
		}); err != nil {
			return err
		}
		result = operation
		return nil
	})
	return result, err
}

func (application *Application) updateOperationStage(
	ctx context.Context,
	operationID string,
	stage OperationStage,
	mutate func(*Operation),
) (Operation, error) {
	var result Operation
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateCompleted || operation.State == OperationStateFailed {
			result = operation
			return nil
		}
		revision := tx.AdvanceRevision()
		operation.State = OperationStateRunning
		operation.Stage = stage
		operation.UpdatedAt = application.config.Now().UTC()
		if mutate != nil {
			mutate(&operation)
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		if err := tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: operation.ConnectorKey,
			OperationID:  operation.OperationID,
			Revision:     revision,
		}); err != nil {
			return err
		}
		result = operation
		return nil
	})
	return result, err
}

func (application *Application) completeConnectorOperation(
	ctx context.Context,
	operationID string,
	update func(Connector) Connector,
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
		connector = update(connector)
		connector.Revision = revision
		operation.State = OperationStateCompleted
		operation.Stage = OperationStageCompleted
		operation.FailureCode = ""
		operation.UpdatedAt = application.config.Now().UTC()
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

func (application *Application) completeAuthorizationStart(
	ctx context.Context,
	operationID string,
	session AuthorizationSession,
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
		connector.Revision = revision
		operation.State = OperationStateCompleted
		operation.Stage = OperationStageCompleted
		operation.Execution.AuthorizationSession = &session
		operation.UpdatedAt = application.config.Now().UTC()
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

func (application *Application) failOperation(ctx context.Context, operationID string, code ErrorCode) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateCompleted || operation.State == OperationStateFailed {
			return nil
		}
		revision := tx.AdvanceRevision()
		operation.State = OperationStateFailed
		operation.Stage = OperationStageFailed
		operation.FailureCode = string(code)
		operation.UpdatedAt = application.config.Now().UTC()
		if operation.Kind == OperationKindRefreshCatalog {
			// Preserve the last-known-good connector projection on refresh failure.
			if err := tx.SetCatalogState(CatalogStateStale); err != nil {
				return err
			}
		} else if operation.ConnectorKey != "" {
			connector, err := tx.Connector(operation.ConnectorKey)
			if err != nil && !errors.Is(err, ErrNotFound) {
				return err
			}
			if err == nil {
				switch operation.Kind {
				case OperationKindInstall:
					if connector.Installation.InstalledReleaseDigest != "" {
						connector.Installation.State = InstallationStateInstalled
						connector.Installation.FailureCode = string(code)
						break
					}
					connector.Installation.State = InstallationStateFailed
					connector.Installation.FailureCode = string(code)
				case OperationKindUninstall:
					connector.Installation.State = InstallationStateFailed
					connector.Installation.FailureCode = string(code)
				case OperationKindStartAuthorization, OperationKindDisconnectAuthorization:
					connector.Authorization.State = AuthorizationStateFailed
					connector.Authorization.FailureCode = string(code)
				}
				connector.Revision = revision
				if err := tx.SaveConnector(connector); err != nil {
					return err
				}
			}
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: operation.ConnectorKey,
			OperationID:  operation.OperationID,
			Revision:     revision,
		})
	})
}

func (application *Application) compatibilityFor(manifest Manifest) (Compatibility, error) {
	if !application.config.ImplementationRegistry.Supports(manifest.Implementation.Kind) {
		return Compatibility{
			State:  CompatibilityStateUnsupportedImplementation,
			Reason: "unsupported_implementation",
		}, nil
	}
	compatibility := application.config.Compatibility.Evaluate(manifest)
	switch compatibility.State {
	case CompatibilityStateSupported,
		CompatibilityStateUnsupportedProduct,
		CompatibilityStateUnsupportedPlatform,
		CompatibilityStateUnsupportedVersion:
		return compatibility, nil
	default:
		return Compatibility{}, NewDomainError(
			ErrorCodeUnavailable,
			"connector compatibility evaluator returned an invalid state",
			false,
			nil,
		)
	}
}

func newCatalogConnector(release Release) Connector {
	return Connector{
		Key:           release.ConnectorKey,
		Release:       release,
		Installation:  Installation{State: InstallationStateNotInstalled},
		Authorization: initialAuthorization(release.Manifest.AuthorizationKind),
		Compatibility: Compatibility{State: CompatibilityStateSupported},
	}
}

func initialAuthorization(kind string) Authorization {
	if kind == "none" {
		return Authorization{State: AuthorizationStateNotRequired}
	}
	return Authorization{State: AuthorizationStateDisconnected}
}

func frozenRelease(operation Operation) (Release, error) {
	if operation.Target == nil || operation.Target.Release == nil {
		return Release{}, invalidOperationReceipt("operation does not contain a frozen release")
	}
	release := *operation.Target.Release
	if release.ConnectorKey != operation.ConnectorKey ||
		release.ReleaseID != operation.Target.ReleaseID ||
		release.ReleaseDigest != operation.Target.ReleaseDigest ||
		release.Version != operation.Target.Version {
		return Release{}, invalidOperationReceipt("operation release identity is inconsistent")
	}
	if err := ValidateReleaseShape(release); err != nil {
		return Release{}, err
	}
	return release, nil
}

func validatePreparedArtifact(
	operation Operation,
	release Release,
	receipt PreparedArtifactReceipt,
) error {
	if receipt.OperationID != operation.OperationID ||
		receipt.ConnectorKey != release.ConnectorKey ||
		receipt.Version != release.Version ||
		receipt.ReleaseDigest != release.ReleaseDigest ||
		receipt.ArtifactSHA256 != release.Artifact.SHA256 ||
		!artifactSHA256Pattern.MatchString(receipt.InventoryDigest) ||
		strings.TrimSpace(receipt.PreparedPath) == "" {
		return invalidOperationReceipt("artifact preparer returned a mismatched receipt")
	}
	return nil
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
		!artifactSHA256Pattern.MatchString(receipt.LockSHA256) ||
		strings.TrimSpace(receipt.RuntimeProfile) == "" || strings.TrimSpace(receipt.RuntimeABI) == "" ||
		strings.TrimSpace(receipt.NodeVersion) == "" || !filepath.IsAbs(receipt.InstallRoot) ||
		!filepath.IsAbs(receipt.StoreRoot) || !safeRelativeEntrypoint(receipt.Entrypoint) {
		return invalidOperationReceipt("CLI installer returned a mismatched receipt")
	}
	return nil
}

func validateRuntimeActivation(
	operation Operation,
	release Release,
	receipt RuntimeActivationReceipt,
) error {
	if receipt.OperationID != operation.OperationID ||
		receipt.ConnectorKey != release.ConnectorKey ||
		receipt.ReleaseDigest != release.ReleaseDigest {
		return invalidOperationReceipt("runtime activator returned a mismatched receipt")
	}
	return nil
}

func invalidOperationReceipt(message string) error {
	return NewDomainError(ErrorCodeInstallFailed, fmt.Sprintf("invalid connector operation receipt: %s", message), false, nil)
}
