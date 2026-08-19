package host

import (
	"context"
	"errors"
	"strings"
	"time"
)

const authorizationSessionTTL = 10 * time.Minute

const compatibilityReasonRemovedFromCatalog = "removed_from_catalog"

func (application *Application) executeRefresh(ctx context.Context, operation Operation) error {
	if _, err := application.updateOperationStage(ctx, operation.OperationID, OperationStageRefreshing, nil); err != nil {
		return err
	}
	fetchSequence := application.beginCatalogFetch()
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
	applied, err := application.applyCatalogFetch(fetchSequence, func() error {
		return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
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
				connector.Authorization = authorizationForManifest(connector.Authorization, release.Manifest.AuthorizationKind)
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
					active, err := tx.ActiveOperationInLane(connector.Key)
					if err != nil {
						return err
					}
					if active == nil {
						if err := tx.DeleteConnector(connector.Key); err != nil {
							return err
						}
						continue
					}
				}
				connector.Compatibility = Compatibility{
					State:  CompatibilityStateUnsupportedVersion,
					Reason: compatibilityReasonRemovedFromCatalog,
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
	})
	if err != nil {
		return err
	}
	if !applied {
		return application.completeSupersededCatalogRefresh(ctx, operation.OperationID)
	}
	return nil
}

func (application *Application) completeSupersededCatalogRefresh(ctx context.Context, operationID string) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateCompleted {
			return nil
		}
		operation.State = OperationStateCompleted
		operation.Stage = OperationStageCompleted
		operation.UpdatedAt = application.config.Now().UTC()
		return tx.SaveOperation(operation)
	})
}

func (application *Application) executeInstall(ctx context.Context, operation Operation) error {
	release, err := frozenRelease(operation)
	if err != nil {
		return err
	}
	if err := application.config.ImplementationRegistry.Validate(release.Manifest); err != nil {
		return err
	}
	operation, err = application.updateOperationStage(ctx, operation.OperationID, OperationStageInstalling, nil)
	if err != nil {
		return err
	}
	installed, installErr := application.config.ReleaseInstallations.InstallRelease(ctx, InstallReleaseRequest{
		OperationID: operation.OperationID,
		Scope:       operation.Scope,
		Generation:  operation.HostGeneration,
		Release:     release,
	})
	if installErr != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector release installation failed", true, installErr)
	}
	if err := validateReleaseInstallationReceipt(operation, release, installed); err != nil {
		return err
	}
	operation, err = application.updateOperationStage(
		ctx,
		operation.OperationID,
		OperationStageInstalled,
		func(current *Operation) { current.Execution.ReleaseInstallation = &installed },
	)
	if err != nil {
		return err
	}
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey)
	if err != nil {
		return err
	}
	connector.Release = release
	binding, err := application.resolveRuntimeBinding(ctx, operation, connector, release, RuntimeBindingPurposePlan)
	if err != nil {
		return err
	}
	defer clear(binding.CredentialBrokerGrant)
	if len(binding.CredentialBrokerGrant) != 0 {
		return invalidOperationReceipt("runtime planning returned a credential grant")
	}
	// The prepared receipt above is durable before this idempotent physical
	// commit. A crash after the commit leaves a running operation with enough
	// evidence for the continuous recovery scanner to replay this exact target.
	if err := application.config.ReleaseInstallations.CommitReleaseInstallation(ctx, CommitReleaseInstallationRequest{
		OperationID: operation.OperationID, Scope: operation.Scope, Generation: operation.HostGeneration,
		Release: release, Receipt: installed,
	}); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector release installation commit failed", true, err)
	}
	if err := application.prepareInstallRuntimeDesired(ctx, operation.OperationID, release, binding); err != nil {
		return err
	}
	if err := application.awaitRuntimeDesired(ctx, operation.Scope, operation.ConnectorKey); err != nil {
		return err
	}
	return application.finalizeInstallAfterRuntime(ctx, operation.OperationID)
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
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey)
	if err != nil {
		return err
	}
	release, err := application.installedReleaseEvidence(ctx, connector)
	if err != nil {
		return err
	}
	binding, err := application.resolveRuntimeBinding(ctx, operation, connector, release, RuntimeBindingPurposeDeactivate)
	if err != nil {
		return err
	}
	clear(binding.CredentialBrokerGrant)
	binding.Enabled = false
	if err := application.prepareUninstallRuntimeDisabled(ctx, operation.OperationID, release, binding); err != nil {
		return err
	}
	if err := application.awaitRuntimeDesired(ctx, operation.Scope, operation.ConnectorKey); err != nil {
		return err
	}
	operation, err = application.updateOperationStage(ctx, operation.OperationID, OperationStageRemoving, nil)
	if err != nil {
		return err
	}
	if err := application.config.ReleaseInstallations.UninstallRelease(ctx, UninstallReleaseRequest{
		OperationID: operation.OperationID,
		Scope:       operation.Scope,
		Generation:  operation.HostGeneration,
		Release:     release,
	}); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector release cleanup failed", true, err)
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
		// Local uninstall changes only device installation truth. Authorization is
		// a separate lifecycle: remote authorization is projected from the account
		// snapshot, while local providers are disconnected only through the explicit
		// DisconnectAuthorization operation.
		connector.Revision = revision
		operation.State, operation.Stage, operation.FailureCode = OperationStateCompleted, OperationStageCompleted, ""
		operation.UpdatedAt = application.config.Now().UTC()
		if err := tx.DeleteRuntimeConvergence(operation.Scope, connector.Key); err != nil {
			return err
		}
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
	releaseDigest string, generation HostGeneration, expectedEnabled bool) error {
	if receipt.OperationID != operationID || receipt.ConnectionID != connectionID ||
		receipt.ConnectorKey != connectorKey || receipt.ReleaseDigest != releaseDigest || receipt.Generation != generation {
		return invalidOperationReceipt("implementation host returned a mismatched runtime receipt")
	}
	if !expectedEnabled {
		if receipt.Readiness.State != RuntimeReadinessBlocked ||
			receipt.Readiness.ReasonCode != RuntimeReadinessReasonRuntimeDisabled ||
			len(receipt.Readiness.Interfaces) != 0 {
			return invalidOperationReceipt("implementation host returned invalid disabled runtime readiness")
		}
		return nil
	}
	if receipt.Readiness.State != RuntimeReadinessReady {
		return invalidOperationReceipt("implementation host did not return a ready runtime receipt")
	}
	if receipt.Summary == nil {
		return invalidOperationReceipt("implementation host returned no matching connector summary")
	}
	if err := ValidateConnectorSummary(*receipt.Summary, connectorKey); err != nil {
		return invalidOperationReceipt("implementation host returned an invalid connector summary")
	}
	if len(receipt.Readiness.Interfaces) == 0 {
		return invalidOperationReceipt("implementation host returned no ready interfaces")
	}
	readyInterfaces := make(map[string]struct{}, len(receipt.Readiness.Interfaces))
	for _, readiness := range receipt.Readiness.Interfaces {
		if (readiness.Kind != "mcp" && readiness.Kind != "cli") || readiness.State != RuntimeReadinessReady {
			return invalidOperationReceipt("implementation host returned invalid interface readiness")
		}
		readyInterfaces[readiness.Kind] = struct{}{}
	}
	if len(readyInterfaces) != len(receipt.Summary.Interfaces) {
		return invalidOperationReceipt("implementation host returned inconsistent interface summary")
	}
	for _, summary := range receipt.Summary.Interfaces {
		if _, ok := readyInterfaces[summary.Kind]; !ok {
			return invalidOperationReceipt("implementation host returned inconsistent interface summary")
		}
	}
	return nil
}

func (application *Application) beginAuthorizationSession(
	ctx context.Context,
	operation Operation,
	secret []byte,
	replacementPolicy AuthorizationReplacementPolicy,
) (AuthorizationSession, error) {
	release, err := frozenRelease(operation)
	if err != nil {
		return AuthorizationSession{}, err
	}
	if operation.State == OperationStateCompleted && operation.Execution.AuthorizationSession != nil &&
		operation.Execution.AuthorizationSession.IsResolved() {
		session := *operation.Execution.AuthorizationSession
		session.AuthorizationURL = ""
		switch session.Resolution {
		case AuthorizationSessionResolutionProviderConnected, AuthorizationSessionResolutionAccountStateConverged:
			session.State = AuthorizationStateConnected
		default:
			session.State = AuthorizationStateFailed
		}
		return session, nil
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
		OperationID:       operation.OperationID,
		ClientRequestID:   operation.ClientRequestID,
		ReplacementPolicy: replacementPolicy,
		Scope:             operation.Scope,
		Connector:         connector,
		Release:           release,
		Secret:            secret,
	})
	if err != nil {
		return AuthorizationSession{}, NewDomainError(
			ErrorCodeAuthorizationFailed,
			"connector authorization could not be started",
			true,
			err,
		)
	}
	if session.ExpiresAt.IsZero() {
		session.ExpiresAt = application.config.Now().UTC().Add(authorizationSessionTTL)
	}
	if session.OperationID != operation.OperationID || session.ConnectorKey != operation.ConnectorKey ||
		strings.TrimSpace(session.SessionID) == "" || !validAuthorizationSessionAction(session) {
		return AuthorizationSession{}, invalidOperationReceipt("authorization provider returned an invalid session")
	}
	remote := release.Manifest.Implementation.RemoteStreamableHTTP != nil
	accountScoped := strings.TrimSpace(operation.Scope.AccountID) != ""
	if session.State == AuthorizationStateConnected && !remote {
		session.Resolution = AuthorizationSessionResolutionProviderConnected
	} else {
		session.Resolution = AuthorizationSessionResolutionUnresolved
	}
	projectDeviceState := !remote && (!accountScoped || connector.Authorization.State != AuthorizationStateConnected)
	if err := application.completeAuthorizationStart(ctx, operation.OperationID, session, projectDeviceState); err != nil {
		return AuthorizationSession{}, err
	}
	if session.State == AuthorizationStateConnected || (!remote && accountScoped) {
		if err := application.projectAuthorizationAndScheduleRuntime(ctx, operation.Scope, operation.ConnectorKey, session.ConnectionID, session.State, ""); err != nil {
			return AuthorizationSession{}, err
		}
	}
	return session, nil
}

func validAuthorizationSessionAction(session AuthorizationSession) bool {
	switch strings.TrimSpace(session.ActionType) {
	case "":
		return (session.State == AuthorizationStatePending && strings.TrimSpace(session.AuthorizationURL) != "") ||
			(session.State == AuthorizationStateConnected && strings.TrimSpace(session.AuthorizationURL) == "" && strings.TrimSpace(session.ConnectionID) != "")
	case "redirect":
		return session.State == AuthorizationStatePending && strings.TrimSpace(session.AuthorizationURL) != ""
	case "submit_secret":
		return session.State == AuthorizationStateConnected && strings.TrimSpace(session.AuthorizationURL) == "" && strings.TrimSpace(session.ConnectionID) != ""
	default:
		return false
	}
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
	release, err := frozenRelease(operation)
	if err != nil {
		return err
	}
	if err := application.config.Authorization.Disconnect(ctx, AuthorizationDisconnectRequest{
		OperationID: operation.OperationID,
		Scope:       operation.Scope,
		Connector:   connector,
		Release:     release,
	}); err != nil {
		return NewDomainError(ErrorCodeAuthorizationFailed, "connector authorization disconnect failed", true, err)
	}
	remote := release.Manifest.Implementation.RemoteStreamableHTTP != nil
	if err := application.projectAuthorizationAndScheduleRuntime(ctx, operation.Scope, operation.ConnectorKey, "", AuthorizationStateDisconnected, ""); err != nil {
		return err
	}
	if remote {
		receipts, err := application.config.Repository.UnresolvedAuthorizationSessionOperations(ctx, operation.Scope)
		if err != nil {
			return err
		}
		for _, receipt := range receipts {
			if receipt.ConnectorKey != operation.ConnectorKey {
				continue
			}
			if err := application.config.Repository.ResolveAuthorizationSession(ctx, receipt.OperationID, AuthorizationSessionResolutionSuperseded); err != nil {
				return err
			}
		}
	}
	return application.completeConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
		if !remote {
			connector.Authorization = Authorization{State: AuthorizationStateDisconnected}
		}
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
	projectDeviceState bool,
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
		stateChanged := projectDeviceState && connector.Authorization.State != session.State
		if operation.State == OperationStateCompleted && !stateChanged {
			return nil
		}
		if stateChanged && !CanTransitionAuthorization(connector.Authorization.State, session.State) {
			return invalidTransition("authorization", string(connector.Authorization.State), string(session.State))
		}
		revision := tx.AdvanceRevision()
		if projectDeviceState {
			connector.Authorization = Authorization{State: session.State}
		}
		connector.Revision = revision
		if operation.State != OperationStateCompleted {
			operation.State = OperationStateCompleted
			operation.Stage = OperationStageCompleted
		}
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

func (application *Application) completeAuthorizationObservation(
	ctx context.Context,
	connectorKey string,
	observation AuthorizationObservation,
) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		connector, err := tx.Connector(connectorKey)
		if err != nil {
			return err
		}
		if connector.Authorization.State != AuthorizationStatePending {
			return nil
		}
		target := AuthorizationStateConnected
		failureCode := ""
		if observation.State == AuthorizationObservationFailed {
			target = AuthorizationStateFailed
			failureCode = strings.TrimSpace(observation.FailureCode)
			if failureCode == "" {
				failureCode = string(ErrorCodeAuthorizationFailed)
			}
		}
		if !CanTransitionAuthorization(connector.Authorization.State, target) {
			return invalidTransition("authorization", string(connector.Authorization.State), string(target))
		}
		revision := tx.AdvanceRevision()
		connector.Authorization = Authorization{State: target, FailureCode: failureCode}
		connector.Revision = revision
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{ConnectorKey: connector.Key, Revision: revision})
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
					if connector.Installation.CandidateReleaseDigest != "" {
						if err := tx.DeleteRuntimeConvergence(operation.Scope, connector.Key); err != nil {
							return err
						}
					}
					connector.Installation.CandidateVersion = ""
					connector.Installation.CandidateReleaseID = ""
					connector.Installation.CandidateReleaseDigest = ""
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
