//revive:disable:file-length-limit

package host

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// SyncCatalog replaces the complete local Last-Known-Good snapshot without
// entering the connector operation/claim subsystem. Catalog has its own
// revision and serialization boundary; a failed pull leaves the previous
// snapshot and connector projection intact.
func (application *Application) SyncCatalog(ctx context.Context) error {
	application.catalogMu.Lock()
	if current := application.catalogSync; current != nil {
		application.catalogMu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-current.done:
			return current.err
		}
	}
	execution := &catalogSyncExecution{done: make(chan struct{})}
	application.catalogSync = execution
	application.catalogMu.Unlock()

	execution.err = application.syncCatalogOnce(ctx)
	application.catalogMu.Lock()
	application.catalogSync = nil
	close(execution.done)
	application.catalogMu.Unlock()
	return execution.err
}

func (application *Application) syncCatalogOnce(ctx context.Context) error {
	catalog, err := application.config.CatalogSource.Refresh(ctx)
	if err != nil {
		return preserveCatalogSourceError("connector catalog refresh failed", err)
	}
	if err := validateCatalogSnapshot(catalog); err != nil {
		return err
	}
	for _, release := range catalog.Releases {
		if err := ValidateReleaseShape(release); err != nil {
			return err
		}
		if release.Status != ReleaseStatusAvailable {
			return invalidManifest("active catalog releases must have available status", nil)
		}
	}
	current, currentErr := application.config.Repository.CatalogSnapshot(ctx)
	if currentErr == nil && current.CatalogRevision == catalog.CatalogRevision &&
		current.SnapshotDigest == catalog.SnapshotDigest && current.SourceRevision == catalog.SourceRevision {
		return nil
	}
	if currentErr != nil && !errors.Is(currentErr, ErrNotFound) {
		return currentErr
	}
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
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
			connector.Security = securityForInstallation(catalog, connector.Installation)
			compatibility, compatibilityErr := application.compatibilityFor(release.Manifest)
			if compatibilityErr != nil {
				return compatibilityErr
			}
			connector.Compatibility = compatibility
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
			connector.Compatibility = Compatibility{State: CompatibilityStateUnsupportedVersion, Reason: "removed_from_catalog"}
			connector.Security = securityForInstallation(catalog, connector.Installation)
			if err := tx.SaveConnector(connector); err != nil {
				return err
			}
		}
		if err := tx.SaveCatalogRevision(catalog.SourceRevision); err != nil {
			return err
		}
		if err := tx.SaveCatalogSnapshot(catalog); err != nil {
			return err
		}
		if err := tx.SetCatalogState(CatalogStateReady); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{Revision: revision})
	})
}

func validateCatalogSnapshot(catalog CatalogSnapshot) error {
	if catalog.CatalogRevision == 0 || !remoteBindingContractHashPattern.MatchString(catalog.SnapshotDigest) ||
		strings.TrimSpace(catalog.SourceRevision) == "" {
		return invalidManifest("connector catalog snapshot identity is invalid", nil)
	}
	categories := make(map[string]struct{}, len(catalog.Categories))
	for _, category := range catalog.Categories {
		if strings.TrimSpace(category.CategoryID) == "" ||
			(category.Kind != "category" && category.Kind != "featured") || category.ItemCount < 0 {
			return invalidManifest("connector catalog snapshot category is invalid", nil)
		}
		if _, duplicate := categories[category.CategoryID]; duplicate {
			return invalidManifest("connector catalog snapshot contains duplicate categories", nil)
		}
		categories[category.CategoryID] = struct{}{}
	}
	releases := make(map[string]Release, len(catalog.Releases))
	for _, release := range catalog.Releases {
		if err := ValidateReleaseShape(release); err != nil {
			return err
		}
		if _, duplicate := releases[release.ConnectorKey]; duplicate {
			return invalidManifest("connector catalog snapshot contains conflicting active releases", nil)
		}
		releases[release.ConnectorKey] = release
	}
	for _, entry := range catalog.Entries {
		if _, exists := categories[entry.CategoryID]; !exists {
			return invalidManifest("connector catalog snapshot entry category is unknown", nil)
		}
		if release, exists := releases[entry.Release.ConnectorKey]; !exists || release.ReleaseDigest != entry.Release.ReleaseDigest {
			return invalidManifest("connector catalog snapshot entry release is unknown", nil)
		}
	}
	revocations := make(map[string]struct{}, len(catalog.Revocations))
	for _, revocation := range catalog.Revocations {
		if !remoteBindingContractHashPattern.MatchString(revocation.ArtifactDigest) ||
			strings.TrimSpace(revocation.RevocationID) == "" || strings.TrimSpace(revocation.ReasonCode) == "" ||
			revocation.EffectiveAt.IsZero() {
			return invalidManifest("connector catalog snapshot revocation is invalid", nil)
		}
		if _, duplicate := revocations[revocation.RevocationID]; duplicate {
			return invalidManifest("connector catalog snapshot contains duplicate revocations", nil)
		}
		revocations[revocation.RevocationID] = struct{}{}
	}
	return nil
}

func (application *Application) executeInstall(ctx context.Context, operation Operation) error {
	release, err := frozenRelease(operation)
	if err != nil {
		return err
	}
	if err := application.rejectRevokedRelease(ctx, release); err != nil {
		return err
	}
	if err := application.config.ImplementationRegistry.Validate(release.Manifest); err != nil {
		return err
	}
	operation, err = application.updateOperationStage(ctx, operation.OperationID, OperationStageInstalling, nil)
	if err != nil {
		return err
	}
	installed, installErr := application.config.ReleaseInstallations.PrepareReleaseInstallation(ctx, PrepareReleaseInstallationRequest{
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
	if err := application.rejectRevokedRelease(ctx, release); err != nil {
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
	// Activate switches execution to the candidate but must retain the previous
	// active release as a rollback slot. The operation claim remains held until
	// repository projection and Finalize both succeed.
	transition := ReleaseInstallationTransitionRequest{
		OperationID: operation.OperationID, Scope: operation.Scope, Generation: operation.HostGeneration,
		Release: release, Receipt: installed,
	}
	if err := application.config.ReleaseInstallations.ActivateReleaseInstallation(ctx, transition); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector release installation activation failed", true, err)
	}
	if _, err := application.updateOperationStage(ctx, operation.OperationID, OperationStageActivated, nil); err != nil {
		return err
	}
	if err := application.projectConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
		connector.Installation = Installation{
			State:                   InstallationStateInstalled,
			InstalledVersion:        release.Version,
			InstalledReleaseID:      release.ReleaseID,
			InstalledReleaseDigest:  release.ReleaseDigest,
			InstalledArtifactSHA256: release.Artifact.SHA256,
		}
		connector.Security = Security{State: SecurityStateAllowed}
		return connector
	}); err != nil {
		projected, inspectErr := application.installationProjectionMatches(ctx, operation.ConnectorKey, release.ReleaseDigest)
		if inspectErr != nil {
			return OutcomeUnknown(errors.Join(err, inspectErr))
		}
		if !projected {
			if abortErr := application.config.ReleaseInstallations.AbortReleaseInstallation(context.WithoutCancel(ctx), transition); abortErr != nil {
				return OutcomeUnknown(errors.Join(err, abortErr))
			}
			return err
		}
	}
	if _, err := application.updateOperationStage(ctx, operation.OperationID, OperationStageFinalizing, nil); err != nil {
		return err
	}
	if err := application.config.ReleaseInstallations.FinalizeReleaseInstallation(ctx, transition); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector release installation finalization failed", true, err)
	}
	if err := application.completeProjectedConnectorOperation(ctx, operation.OperationID); err != nil {
		return err
	}
	// Runtime publication is a distinct durable operation. Failure to enqueue it
	// cannot roll back installed truth; bootstrap and authorization observation
	// provide independent convergence paths.
	_ = application.schedulePostInstallRuntimeReconcile(ctx, operation)
	return nil
}

func (application *Application) rejectRevokedRelease(ctx context.Context, release Release) error {
	snapshot, err := application.config.Repository.CatalogSnapshot(ctx)
	if err != nil {
		return NewDomainError(ErrorCodeUnavailable, "connector catalog snapshot is unavailable", true, err)
	}
	if catalogRevokesRelease(snapshot, release) {
		return NewDomainError(ErrorCodeReleaseRevoked, "connector release is revoked", false, nil)
	}
	return nil
}

func catalogRevokesRelease(snapshot CatalogSnapshot, release Release) bool {
	digest := "sha256:" + strings.ToLower(strings.TrimSpace(release.Artifact.SHA256))
	for _, revocation := range snapshot.Revocations {
		if strings.EqualFold(strings.TrimSpace(revocation.ArtifactDigest), digest) {
			return true
		}
	}
	return false
}

func securityForInstallation(snapshot CatalogSnapshot, installation Installation) Security {
	artifactSHA := strings.ToLower(strings.TrimSpace(installation.InstalledArtifactSHA256))
	if artifactSHA == "" {
		return Security{State: SecurityStateAllowed}
	}
	for _, revocation := range snapshot.Revocations {
		if strings.EqualFold(strings.TrimSpace(revocation.ArtifactDigest), "sha256:"+artifactSHA) {
			return Security{State: SecurityStateRevoked, RevocationID: revocation.RevocationID, ReasonCode: revocation.ReasonCode}
		}
	}
	return Security{State: SecurityStateAllowed}
}

func (application *Application) recoverInstallOutcome(ctx context.Context, operation Operation) error {
	release, err := frozenRelease(operation)
	if err != nil {
		return err
	}
	observation, err := application.config.ReleaseInstallations.InspectReleaseInstallation(ctx, InspectReleaseInstallationRequest{
		OperationID: operation.OperationID, Scope: operation.Scope, Generation: operation.HostGeneration, Release: release,
	})
	if err != nil {
		return OutcomeUnknown(err)
	}
	if observation.ConnectorKey != release.ConnectorKey || observation.ReleaseDigest != release.ReleaseDigest {
		return invalidOperationReceipt("installation inspection returned a mismatched release")
	}
	switch observation.State {
	case ReleaseInstallationPresent:
		if err := application.rejectRevokedRelease(ctx, release); err != nil {
			return err
		}
		if observation.Receipt == nil {
			return invalidOperationReceipt("installation inspection returned no receipt")
		}
		if err := validateReleaseInstallationReceipt(operation, release, *observation.Receipt); err != nil {
			return err
		}
		if _, err := application.updateOperationStage(ctx, operation.OperationID, OperationStageInstalled, func(current *Operation) {
			current.Execution.ReleaseInstallation = observation.Receipt
		}); err != nil {
			return err
		}
		transition := ReleaseInstallationTransitionRequest{
			OperationID: operation.OperationID, Scope: operation.Scope, Generation: operation.HostGeneration,
			Release: release, Receipt: *observation.Receipt,
		}
		if err := application.config.ReleaseInstallations.ActivateReleaseInstallation(ctx, transition); err != nil {
			return OutcomeUnknown(err)
		}
		if err := application.projectConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
			connector.Installation = Installation{State: InstallationStateInstalled, InstalledVersion: release.Version, InstalledReleaseID: release.ReleaseID,
				InstalledReleaseDigest: release.ReleaseDigest, InstalledArtifactSHA256: release.Artifact.SHA256}
			connector.Security = Security{State: SecurityStateAllowed}
			return connector
		}); err != nil {
			return OutcomeUnknown(err)
		}
		if err := application.config.ReleaseInstallations.FinalizeReleaseInstallation(ctx, transition); err != nil {
			return OutcomeUnknown(err)
		}
		return application.completeProjectedConnectorOperation(ctx, operation.OperationID)
	case ReleaseInstallationAbsent:
		return application.executeInstall(ctx, operation)
	case ReleaseInstallationIndeterminate:
		return OutcomeUnknown(errors.New(observation.ReasonCode))
	case ReleaseInstallationInvalid:
		return NewDomainError(ErrorCodeInstallFailed, "connector release installation is invalid", false, errors.New(observation.ReasonCode))
	default:
		return invalidOperationReceipt("installation inspection returned an invalid state")
	}
}

func (application *Application) schedulePostInstallRuntimeReconcile(ctx context.Context, operation Operation) error {
	_, err := application.EnsureRuntimeReconcile(ctx, operation.Scope, operation.ConnectorKey)
	return err
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
	if err := application.config.Host.DeactivateRuntime(ctx, RuntimeDeactivationRequest{
		Scope: operation.Scope, ConnectionID: binding.ConnectionID, ConnectorKey: operation.Target.ConnectorKey, ReleaseDigest: operation.Target.ReleaseDigest,
		AllConnections: true,
		Generation:     operation.HostGeneration,
		Deadline:       application.config.Now().UTC().Add(5 * time.Second),
	}); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector runtime routes could not be deactivated", true, err)
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

func (application *Application) recoverUninstallOutcome(ctx context.Context, operation Operation) error {
	release, err := frozenRelease(operation)
	if err != nil {
		return err
	}
	observation, err := application.config.ReleaseInstallations.InspectReleaseInstallation(ctx, InspectReleaseInstallationRequest{
		OperationID: operation.OperationID, Scope: operation.Scope, Generation: operation.HostGeneration, Release: release,
	})
	if err != nil {
		return OutcomeUnknown(err)
	}
	if observation.ConnectorKey != release.ConnectorKey || observation.ReleaseDigest != release.ReleaseDigest {
		return invalidOperationReceipt("uninstall inspection returned a mismatched release")
	}
	switch observation.State {
	case ReleaseInstallationAbsent:
		return application.completeUninstall(ctx, operation.OperationID)
	case ReleaseInstallationPresent:
		return application.executeUninstall(ctx, operation)
	case ReleaseInstallationIndeterminate:
		return OutcomeUnknown(errors.New(observation.ReasonCode))
	case ReleaseInstallationInvalid:
		return NewDomainError(ErrorCodeInstallFailed, "connector release installation is invalid", false, errors.New(observation.ReasonCode))
	default:
		return invalidOperationReceipt("uninstall inspection returned an invalid state")
	}
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
		connector.Revision++
		now := application.config.Now().UTC()
		operation.State, operation.Stage, operation.FailureCode = OperationStateCompleted, OperationStageCompleted, ""
		operation.NextAttemptAt = nil
		operation.FinishedAt = &now
		operation.TerminalAt = &now
		operation.UpdatedAt = now
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
		OperationID:     operation.OperationID,
		ClientRequestID: operation.ClientRequestID,
		Scope:           operation.Scope,
		Connector:       connector,
		Release:         release,
		Secret:          secret,
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
	if err := application.completeConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
		if !remote {
			connector.Authorization = Authorization{State: AuthorizationStateDisconnected}
		}
		return connector
	}); err != nil {
		return err
	}
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
	return nil
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
		now := application.config.Now().UTC()
		operation.State = OperationStateRunning
		operation.Attempt++
		operation.NextAttemptAt = nil
		if operation.StartedAt == nil {
			operation.StartedAt = &now
		}
		operation.UpdatedAt = now
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
		connector.Revision++
		now := application.config.Now().UTC()
		operation.State = OperationStateCompleted
		operation.Stage = OperationStageCompleted
		operation.FailureCode = ""
		operation.NextAttemptAt = nil
		operation.FinishedAt = &now
		operation.TerminalAt = &now
		operation.UpdatedAt = now
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

// projectConnectorOperation commits business truth while deliberately keeping
// the physical execution claim. The caller must Finalize the physical
// transition before completing the operation and releasing that claim.
func (application *Application) projectConnectorOperation(
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
		connector.Revision++
		operation.State = OperationStateRunning
		operation.Stage = OperationStageActivated
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

func (application *Application) installationProjectionMatches(
	ctx context.Context,
	connectorKey, releaseDigest string,
) (bool, error) {
	connector, err := application.config.Repository.Connector(ctx, connectorKey)
	if err != nil {
		return false, err
	}
	return connector.Installation.State == InstallationStateInstalled &&
		connector.Installation.InstalledReleaseDigest == releaseDigest, nil
}

func (application *Application) completeProjectedConnectorOperation(ctx context.Context, operationID string) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateCompleted {
			return nil
		}
		revision := tx.AdvanceRevision()
		now := application.config.Now().UTC()
		operation.State = OperationStateCompleted
		operation.Stage = OperationStageCompleted
		operation.FailureCode = ""
		operation.NextAttemptAt = nil
		operation.FinishedAt = &now
		operation.TerminalAt = &now
		operation.UpdatedAt = now
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
		if projectDeviceState {
			connector.Revision++
		}
		if operation.State != OperationStateCompleted {
			now := application.config.Now().UTC()
			operation.State = OperationStateCompleted
			operation.Stage = OperationStageCompleted
			operation.NextAttemptAt = nil
			operation.FinishedAt = &now
			operation.TerminalAt = &now
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
		connector.Revision++
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
		now := application.config.Now().UTC()
		operation.State = OperationStateFailed
		operation.Stage = OperationStageFailed
		operation.FailureCode = string(code)
		operation.NextAttemptAt = nil
		operation.FinishedAt = &now
		operation.TerminalAt = &now
		operation.UpdatedAt = now
		if operation.ConnectorKey != "" {
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
				connector.Revision++
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
		Security:      Security{State: SecurityStateAllowed},
	}
}

func initialAuthorization(kind string) Authorization {
	if kind == "none" {
		return Authorization{State: AuthorizationStateNotRequired}
	}
	return Authorization{State: AuthorizationStateDisconnected}
}

// authorizationForManifest migrates the stored state when catalog metadata
// corrects whether a connector requires credentials. This is a catalog schema
// reconciliation, not a user-driven authorization transition.
func authorizationForManifest(current Authorization, kind string) Authorization {
	if kind == "none" {
		return Authorization{State: AuthorizationStateNotRequired}
	}
	if current.State == AuthorizationStateNotRequired {
		return Authorization{State: AuthorizationStateDisconnected}
	}
	return current
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
		(strings.TrimSpace(receipt.PreparedPath) == "" && strings.TrimSpace(receipt.OpaqueArtifactRef) == "") {
		return invalidOperationReceipt("artifact preparer returned a mismatched receipt")
	}
	return nil
}

func validateReleaseInstallationReceipt(
	operation Operation,
	release Release,
	receipt ReleaseInstallationReceipt,
) error {
	if receipt.OperationID != operation.OperationID ||
		receipt.ConnectorKey != release.ConnectorKey ||
		receipt.Version != release.Version ||
		receipt.ReleaseID != release.ReleaseID ||
		receipt.ReleaseDigest != release.ReleaseDigest ||
		receipt.ArtifactSHA256 != release.Artifact.SHA256 {
		return invalidOperationReceipt("release installer returned a mismatched receipt")
	}
	if err := validatePreparedArtifact(operation, release, receipt.Artifact); err != nil {
		return err
	}
	cliInstall := releaseCLIInstallation(release)
	if cliInstall == nil {
		if receipt.CLIInstallation != nil {
			return invalidOperationReceipt("release installer returned an unexpected CLI receipt")
		}
		return nil
	}
	if receipt.CLIInstallation == nil {
		return invalidOperationReceipt("release installer did not return the required CLI receipt")
	}
	return validateCLIInstallationReceipt(operation, release, *cliInstall, *receipt.CLIInstallation)
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
		strings.TrimSpace(receipt.RuntimeProfile) == "" || strings.TrimSpace(receipt.RuntimeABI) == "" ||
		strings.TrimSpace(receipt.NodeVersion) == "" || !safeRelativeEntrypoint(receipt.Entrypoint) {
		return invalidOperationReceipt("CLI installer returned a mismatched receipt")
	}
	localReceipt := filepath.IsAbs(receipt.InstallRoot) && filepath.IsAbs(receipt.StoreRoot) &&
		artifactSHA256Pattern.MatchString(receipt.LockSHA256)
	remoteReceipt := strings.TrimSpace(receipt.OpaqueInstallationRef) != ""
	if !localReceipt && !remoteReceipt {
		return invalidOperationReceipt("CLI installer returned a mismatched receipt")
	}
	return nil
}

func invalidOperationReceipt(message string) error {
	return NewDomainError(ErrorCodeInstallFailed, fmt.Sprintf("invalid connector operation receipt: %s", message), false, nil)
}
