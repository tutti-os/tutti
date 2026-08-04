package daemon

import (
	"context"
	"errors"
)

func (application *Application) executeRefresh(ctx context.Context, operation Operation) error {
	catalog, err := application.config.CatalogSource.Refresh(ctx)
	if err != nil {
		return NewDomainError(
			ErrorCodeUpstreamUnavailable,
			"connector catalog refresh failed",
			true,
			err,
		)
	}
	for _, manifest := range catalog.Manifests {
		if err := ValidateManifestShape(manifest); err != nil {
			return err
		}
	}

	var revision uint64
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
		revision = tx.AdvanceRevision()
		accepted := make(map[string]bool, len(catalog.Manifests))
		for _, manifest := range catalog.Manifests {
			accepted[manifest.Key] = true
			connector, ok := byKey[manifest.Key]
			if !ok {
				connector = newCatalogConnector(manifest)
			}
			connector.Manifest = manifest
			compatibility, err := application.compatibilityFor(manifest)
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
		storedOperation.Stage = "completed"
		storedOperation.UpdatedAt = application.config.Now().UTC()
		if err := tx.SaveOperation(storedOperation); err != nil {
			return err
		}
		if err := tx.SaveCatalogRevision(catalog.SourceRevision); err != nil {
			return err
		}
		return tx.SetCatalogState(CatalogStateReady)
	})
	if err != nil {
		return err
	}
	application.publishChanged(ctx, "", operation.OperationID, revision)
	return nil
}

func (application *Application) executeInstall(ctx context.Context, operation Operation) error {
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey, "")
	if err != nil {
		return err
	}
	if err := application.config.ImplementationRegistry.Validate(connector.Manifest); err != nil {
		return err
	}
	if err := application.config.Installer.Install(ctx, connector.Manifest); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector installation failed", true, err)
	}
	return application.completeConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
		connector.Installation = Installation{
			State:            InstallationStateInstalled,
			InstalledVersion: connector.Manifest.Version,
		}
		return connector
	})
}

func (application *Application) executeUninstall(ctx context.Context, operation Operation) error {
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey, "")
	if err != nil {
		return err
	}
	if err := application.config.Installer.Uninstall(ctx, connector); err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector uninstall failed", true, err)
	}
	return application.completeConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
		connector.Installation = Installation{State: InstallationStateNotInstalled}
		connector.Authorization = initialAuthorization(connector.Manifest.AuthorizationKind)
		return connector
	})
}

func (application *Application) executeDisconnectAuthorization(ctx context.Context, operation Operation) error {
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey, "")
	if err != nil {
		return err
	}
	if err := application.config.Authorization.Disconnect(ctx, connector); err != nil {
		return NewDomainError(ErrorCodeAuthorizationFailed, "connector authorization disconnect failed", true, err)
	}
	return application.completeConnectorOperation(ctx, operation.OperationID, func(connector Connector) Connector {
		connector.Authorization = Authorization{State: AuthorizationStateDisconnected}
		return connector
	})
}

func (application *Application) markOperationRunning(ctx context.Context, operationID string) error {
	var event ChangedEvent
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateRunning {
			return nil
		}
		revision := tx.AdvanceRevision()
		operation.State = OperationStateRunning
		operation.Stage = "running"
		operation.UpdatedAt = application.config.Now().UTC()
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		event = ChangedEvent{ConnectorKey: operation.ConnectorKey, OperationID: operation.OperationID, Revision: revision}
		return nil
	})
	if err == nil && event.Revision > 0 {
		application.publishChanged(ctx, event.ConnectorKey, event.OperationID, event.Revision)
	}
	return err
}

func (application *Application) completeConnectorOperation(
	ctx context.Context,
	operationID string,
	update func(Connector) Connector,
) error {
	var event ChangedEvent
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		connector, err := tx.Connector(operation.ConnectorKey)
		if err != nil {
			return err
		}
		revision := tx.AdvanceRevision()
		connector = update(connector)
		connector.Revision = revision
		operation.State = OperationStateCompleted
		operation.Stage = "completed"
		operation.FailureCode = ""
		operation.UpdatedAt = application.config.Now().UTC()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		event = ChangedEvent{ConnectorKey: connector.Key, OperationID: operation.OperationID, Revision: revision}
		return nil
	})
	if err != nil {
		return err
	}
	application.publishChanged(ctx, event.ConnectorKey, event.OperationID, event.Revision)
	return nil
}

func (application *Application) completeSynchronousOperation(
	ctx context.Context,
	operationID string,
	stage string,
) (AuthorizationResult, error) {
	var result AuthorizationResult
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		connector, err := tx.Connector(operation.ConnectorKey)
		if err != nil {
			return err
		}
		revision := tx.AdvanceRevision()
		connector.Revision = revision
		operation.State = OperationStateCompleted
		operation.Stage = stage
		operation.UpdatedAt = application.config.Now().UTC()
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		result = AuthorizationResult{Connector: connector, Operation: operation, Revision: revision}
		return nil
	})
	if err != nil {
		return AuthorizationResult{}, err
	}
	application.publishChanged(ctx, result.Connector.Key, result.Operation.OperationID, result.Revision)
	return result, nil
}

func (application *Application) failOperation(ctx context.Context, operationID string, code ErrorCode) error {
	var event ChangedEvent
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		revision := tx.AdvanceRevision()
		operation.State = OperationStateFailed
		operation.Stage = "failed"
		operation.FailureCode = string(code)
		operation.UpdatedAt = application.config.Now().UTC()
		if operation.Kind == OperationKindRefreshCatalog {
			if err := tx.SetCatalogState(CatalogStateFailed); err != nil {
				return err
			}
		} else if operation.ConnectorKey != "" {
			connector, err := tx.Connector(operation.ConnectorKey)
			if err != nil && !errors.Is(err, ErrNotFound) {
				return err
			}
			if err == nil {
				switch operation.Kind {
				case OperationKindInstall, OperationKindUninstall:
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
		event = ChangedEvent{ConnectorKey: operation.ConnectorKey, OperationID: operation.OperationID, Revision: revision}
		return nil
	})
	if err != nil {
		return err
	}
	application.publishChanged(ctx, event.ConnectorKey, event.OperationID, event.Revision)
	return nil
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

func newCatalogConnector(manifest Manifest) Connector {
	return Connector{
		Key:           manifest.Key,
		Manifest:      manifest,
		Installation:  Installation{State: InstallationStateNotInstalled},
		Authorization: initialAuthorization(manifest.AuthorizationKind),
		Compatibility: Compatibility{State: CompatibilityStateSupported},
	}
}

func initialAuthorization(kind string) Authorization {
	if kind == "none" {
		return Authorization{State: AuthorizationStateNotRequired}
	}
	return Authorization{State: AuthorizationStateDisconnected}
}
