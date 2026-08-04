package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

type ApplicationConfig struct {
	Repository             Repository
	CatalogSource          CatalogSource
	Installer              ArtifactInstaller
	Authorization          AuthorizationProvider
	Compatibility          CompatibilityEvaluator
	Scheduler              OperationScheduler
	Events                 EventPublisher
	ImplementationRegistry ImplementationRegistry
	Now                    func() time.Time
	NewID                  func() (string, error)
}

type Application struct {
	config ApplicationConfig
}

var _ Service = (*Application)(nil)

func NewApplication(config ApplicationConfig) (*Application, error) {
	if config.Repository == nil {
		return nil, errors.New("connector market repository is required")
	}
	if config.CatalogSource == nil {
		return nil, errors.New("connector market catalog source is required")
	}
	if config.Installer == nil {
		return nil, errors.New("connector market artifact installer is required")
	}
	if config.Authorization == nil {
		return nil, errors.New("connector market authorization provider is required")
	}
	if config.Compatibility == nil {
		return nil, errors.New("connector market compatibility evaluator is required")
	}
	if config.Scheduler == nil {
		return nil, errors.New("connector market operation scheduler is required")
	}
	if config.Events == nil {
		return nil, errors.New("connector market event publisher is required")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.NewID == nil {
		config.NewID = randomID
	}
	return &Application{config: config}, nil
}

func (application *Application) Snapshot(ctx context.Context, workspaceID string) (Snapshot, error) {
	return application.config.Repository.Snapshot(ctx, workspaceID)
}

func (application *Application) GetConnector(
	ctx context.Context,
	connectorKey string,
	workspaceID string,
) (Connector, error) {
	if strings.TrimSpace(connectorKey) == "" {
		return Connector{}, invalidRequest("connectorKey is required")
	}
	return application.config.Repository.Connector(ctx, connectorKey, workspaceID)
}

func (application *Application) GetOperation(ctx context.Context, operationID string) (Operation, error) {
	if strings.TrimSpace(operationID) == "" {
		return Operation{}, invalidRequest("operationID is required")
	}
	return application.config.Repository.Operation(ctx, operationID)
}

func (application *Application) RefreshCatalog(
	ctx context.Context,
	mutation Mutation,
) (MutationResult, error) {
	return application.acceptOperation(ctx, mutation, OperationKindRefreshCatalog, "")
}

func (application *Application) Install(
	ctx context.Context,
	mutation ConnectorMutation,
) (MutationResult, error) {
	var target InstallationState
	result, err := application.acceptConnectorOperation(
		ctx,
		mutation,
		OperationKindInstall,
		func(connector Connector) (Connector, error) {
			if connector.Compatibility.State != CompatibilityStateSupported {
				return Connector{}, NewDomainError(
					ErrorCodeIncompatible,
					"connector is not compatible with this host",
					false,
					nil,
				)
			}
			if connector.Installation.State == InstallationStateInstalled {
				target = InstallationStateUpdating
			} else {
				target = InstallationStateInstalling
			}
			if !CanTransitionInstallation(connector.Installation.State, target) {
				return Connector{}, invalidTransition("installation", string(connector.Installation.State), string(target))
			}
			connector.Installation.State = target
			connector.Installation.FailureCode = ""
			return connector, nil
		},
	)
	return result, err
}

func (application *Application) Uninstall(
	ctx context.Context,
	mutation ConnectorMutation,
) (MutationResult, error) {
	return application.acceptConnectorOperation(
		ctx,
		mutation,
		OperationKindUninstall,
		func(connector Connector) (Connector, error) {
			if !CanTransitionInstallation(connector.Installation.State, InstallationStateUninstalling) {
				return Connector{}, invalidTransition(
					"installation",
					string(connector.Installation.State),
					string(InstallationStateUninstalling),
				)
			}
			connector.Installation.State = InstallationStateUninstalling
			connector.Installation.FailureCode = ""
			return connector, nil
		},
	)
}

func (application *Application) BeginAuthorization(
	ctx context.Context,
	mutation ConnectorMutation,
) (AuthorizationResult, error) {
	if err := validateConnectorMutation(mutation); err != nil {
		return AuthorizationResult{}, err
	}
	var result AuthorizationResult
	shouldBegin := false
	shouldComplete := false
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		existing, err := tx.OperationByClientRequestID(mutation.ClientRequestID)
		if err != nil {
			return err
		}
		if existing != nil {
			if err := verifyIdempotentOperation(*existing, OperationKindStartAuthorization, mutation.ConnectorKey); err != nil {
				return err
			}
			connector, err := tx.Connector(mutation.ConnectorKey)
			if err != nil {
				return err
			}
			result = AuthorizationResult{Connector: connector, Operation: *existing, Revision: tx.Revision()}
			if existing.State == OperationStateFailed {
				return NewDomainError(
					ErrorCodeAuthorizationFailed,
					"connector authorization attempt previously failed",
					true,
					nil,
				)
			}
			shouldBegin = true
			shouldComplete = existing.State != OperationStateCompleted
			return nil
		}
		if err := verifyRevision(tx, mutation.ExpectedRevision); err != nil {
			return err
		}
		if err := rejectActiveOperation(tx, mutation.ConnectorKey); err != nil {
			return err
		}

		connector, err := tx.Connector(mutation.ConnectorKey)
		if err != nil {
			return err
		}
		if !CanTransitionAuthorization(connector.Authorization.State, AuthorizationStatePending) {
			return invalidTransition(
				"authorization",
				string(connector.Authorization.State),
				string(AuthorizationStatePending),
			)
		}
		now := application.config.Now().UTC()
		revision := tx.AdvanceRevision()
		operationID, err := application.config.NewID()
		if err != nil {
			return NewDomainError(ErrorCodeUnavailable, "connector operation id could not be generated", true, err)
		}
		connector.Authorization = Authorization{State: AuthorizationStatePending}
		connector.Revision = revision
		operation := Operation{
			OperationID:     operationID,
			ClientRequestID: mutation.ClientRequestID,
			ConnectorKey:    mutation.ConnectorKey,
			Kind:            OperationKindStartAuthorization,
			State:           OperationStateRunning,
			Stage:           "starting",
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		result = AuthorizationResult{Connector: connector, Operation: operation, Revision: revision}
		shouldBegin = true
		shouldComplete = true
		return nil
	})
	if err != nil {
		return AuthorizationResult{}, err
	}
	if !shouldBegin {
		return result, nil
	}

	url, beginErr := application.config.Authorization.Begin(
		ctx,
		result.Connector,
		mutation.ClientRequestID,
	)
	if beginErr != nil {
		if shouldComplete {
			_ = application.failOperation(ctx, result.Operation.OperationID, ErrorCodeAuthorizationFailed)
		}
		return AuthorizationResult{}, NewDomainError(
			ErrorCodeAuthorizationFailed,
			"connector authorization could not be started",
			true,
			beginErr,
		)
	}
	if !shouldComplete {
		result.AuthorizationURL = url
		return result, nil
	}
	completed, err := application.completeSynchronousOperation(ctx, result.Operation.OperationID, "pending_external_authorization")
	if err != nil {
		return AuthorizationResult{}, err
	}
	completed.AuthorizationURL = url
	return completed, nil
}

func (application *Application) DisconnectAuthorization(
	ctx context.Context,
	mutation ConnectorMutation,
) (MutationResult, error) {
	return application.acceptConnectorOperation(
		ctx,
		mutation,
		OperationKindDisconnectAuthorization,
		func(connector Connector) (Connector, error) {
			if connector.Authorization.State == AuthorizationStateNotRequired {
				return Connector{}, invalidTransition(
					"authorization",
					string(connector.Authorization.State),
					string(AuthorizationStateDisconnected),
				)
			}
			return connector, nil
		},
	)
}

func (application *Application) SetWorkspaceEnabled(
	ctx context.Context,
	command SetWorkspaceEnabledCommand,
) (WorkspaceBindingResult, error) {
	if err := validateConnectorMutation(command.ConnectorMutation); err != nil {
		return WorkspaceBindingResult{}, err
	}
	if strings.TrimSpace(command.WorkspaceID) == "" {
		return WorkspaceBindingResult{}, invalidRequest("workspaceId is required")
	}
	var result WorkspaceBindingResult
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		existing, err := tx.OperationByClientRequestID(command.ClientRequestID)
		if err != nil {
			return err
		}
		if existing != nil {
			if err := verifyIdempotentOperation(*existing, OperationKindSetWorkspaceEnabled, command.ConnectorKey); err != nil {
				return err
			}
			connector, err := tx.Connector(command.ConnectorKey)
			if err != nil {
				return err
			}
			result = WorkspaceBindingResult{Connector: connector, Operation: *existing, Revision: tx.Revision()}
			return nil
		}
		if err := verifyRevision(tx, command.ExpectedRevision); err != nil {
			return err
		}
		if err := rejectActiveOperation(tx, command.ConnectorKey); err != nil {
			return err
		}
		now := application.config.Now().UTC()
		revision := tx.AdvanceRevision()
		operationID, err := application.config.NewID()
		if err != nil {
			return NewDomainError(ErrorCodeUnavailable, "connector operation id could not be generated", true, err)
		}
		connector, err := tx.SetWorkspaceBinding(command.ConnectorKey, WorkspaceBinding{
			WorkspaceID: command.WorkspaceID,
			Enabled:     command.Enabled,
		})
		if err != nil {
			return err
		}
		connector.Revision = revision
		operation := Operation{
			OperationID:     operationID,
			ClientRequestID: command.ClientRequestID,
			ConnectorKey:    command.ConnectorKey,
			Kind:            OperationKindSetWorkspaceEnabled,
			State:           OperationStateCompleted,
			Stage:           "completed",
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		result = WorkspaceBindingResult{Connector: connector, Operation: operation, Revision: revision}
		return nil
	})
	if err != nil {
		return WorkspaceBindingResult{}, err
	}
	application.publishChanged(ctx, result.Connector.Key, result.Operation.OperationID, result.Revision)
	return result, nil
}

func (application *Application) ExecuteOperation(ctx context.Context, operationID string) error {
	operation, err := application.config.Repository.Operation(ctx, operationID)
	if err != nil {
		return err
	}
	if operation.State == OperationStateCompleted || operation.State == OperationStateFailed {
		return nil
	}
	if err := application.markOperationRunning(ctx, operation.OperationID); err != nil {
		return err
	}

	var executeErr error
	switch operation.Kind {
	case OperationKindRefreshCatalog:
		executeErr = application.executeRefresh(ctx, operation)
	case OperationKindInstall:
		executeErr = application.executeInstall(ctx, operation)
	case OperationKindUninstall:
		executeErr = application.executeUninstall(ctx, operation)
	case OperationKindDisconnectAuthorization:
		executeErr = application.executeDisconnectAuthorization(ctx, operation)
	default:
		executeErr = invalidRequest(fmt.Sprintf("operation kind %q is not executable", operation.Kind))
	}
	if executeErr != nil {
		code := ErrorCodeInstallFailed
		if operation.Kind == OperationKindRefreshCatalog {
			code = ErrorCodeUpstreamUnavailable
		}
		if operation.Kind == OperationKindDisconnectAuthorization {
			code = ErrorCodeAuthorizationFailed
		}
		_ = application.failOperation(ctx, operation.OperationID, code)
		return executeErr
	}
	return nil
}

func (application *Application) Recover(ctx context.Context) error {
	operations, err := application.config.Repository.RecoverableOperations(ctx)
	if err != nil {
		return err
	}
	for _, operation := range operations {
		if err := application.config.Scheduler.Schedule(ctx, operation.OperationID); err != nil {
			return NewDomainError(ErrorCodeUnavailable, "connector operation recovery could not be scheduled", true, err)
		}
	}
	return nil
}

func (application *Application) acceptConnectorOperation(
	ctx context.Context,
	mutation ConnectorMutation,
	kind OperationKind,
	transition func(Connector) (Connector, error),
) (MutationResult, error) {
	if err := validateConnectorMutation(mutation); err != nil {
		return MutationResult{}, err
	}
	var result MutationResult
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		existing, err := tx.OperationByClientRequestID(mutation.ClientRequestID)
		if err != nil {
			return err
		}
		if existing != nil {
			if err := verifyIdempotentOperation(*existing, kind, mutation.ConnectorKey); err != nil {
				return err
			}
			connector, err := tx.Connector(mutation.ConnectorKey)
			if err != nil {
				return err
			}
			result = MutationResult{Connector: &connector, Operation: *existing, Revision: tx.Revision()}
			return nil
		}
		if err := verifyRevision(tx, mutation.ExpectedRevision); err != nil {
			return err
		}
		if err := rejectActiveOperation(tx, mutation.ConnectorKey); err != nil {
			return err
		}
		connector, err := tx.Connector(mutation.ConnectorKey)
		if err != nil {
			return err
		}
		connector, err = transition(connector)
		if err != nil {
			return err
		}
		now := application.config.Now().UTC()
		revision := tx.AdvanceRevision()
		operationID, err := application.config.NewID()
		if err != nil {
			return NewDomainError(ErrorCodeUnavailable, "connector operation id could not be generated", true, err)
		}
		connector.Revision = revision
		operation := Operation{
			OperationID:     operationID,
			ClientRequestID: mutation.ClientRequestID,
			ConnectorKey:    mutation.ConnectorKey,
			Kind:            kind,
			State:           OperationStateAccepted,
			Stage:           "accepted",
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		result = MutationResult{Connector: &connector, Operation: operation, Revision: revision}
		return nil
	})
	if err != nil {
		return MutationResult{}, err
	}
	if result.Operation.State == OperationStateAccepted || result.Operation.State == OperationStateRunning {
		if err := application.config.Scheduler.Schedule(ctx, result.Operation.OperationID); err != nil {
			return MutationResult{}, NewDomainError(ErrorCodeUnavailable, "connector operation could not be scheduled", true, err)
		}
	}
	application.publishChanged(ctx, mutation.ConnectorKey, result.Operation.OperationID, result.Revision)
	return result, nil
}

func (application *Application) acceptOperation(
	ctx context.Context,
	mutation Mutation,
	kind OperationKind,
	connectorKey string,
) (MutationResult, error) {
	if err := validateMutation(mutation); err != nil {
		return MutationResult{}, err
	}
	var result MutationResult
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		existing, err := tx.OperationByClientRequestID(mutation.ClientRequestID)
		if err != nil {
			return err
		}
		if existing != nil {
			if err := verifyIdempotentOperation(*existing, kind, connectorKey); err != nil {
				return err
			}
			result = MutationResult{Operation: *existing, Revision: tx.Revision()}
			return nil
		}
		if err := verifyRevision(tx, mutation.ExpectedRevision); err != nil {
			return err
		}
		if err := rejectActiveOperation(tx, connectorKey); err != nil {
			return err
		}
		now := application.config.Now().UTC()
		revision := tx.AdvanceRevision()
		operationID, err := application.config.NewID()
		if err != nil {
			return NewDomainError(ErrorCodeUnavailable, "connector operation id could not be generated", true, err)
		}
		operation := Operation{
			OperationID:     operationID,
			ClientRequestID: mutation.ClientRequestID,
			ConnectorKey:    connectorKey,
			Kind:            kind,
			State:           OperationStateAccepted,
			Stage:           "accepted",
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		if kind == OperationKindRefreshCatalog {
			if err := tx.SetCatalogState(CatalogStateRefreshing); err != nil {
				return err
			}
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		result = MutationResult{Operation: operation, Revision: revision}
		return nil
	})
	if err != nil {
		return MutationResult{}, err
	}
	if result.Operation.State == OperationStateAccepted || result.Operation.State == OperationStateRunning {
		if err := application.config.Scheduler.Schedule(ctx, result.Operation.OperationID); err != nil {
			return MutationResult{}, NewDomainError(ErrorCodeUnavailable, "connector operation could not be scheduled", true, err)
		}
	}
	application.publishChanged(ctx, connectorKey, result.Operation.OperationID, result.Revision)
	return result, nil
}

func validateMutation(mutation Mutation) error {
	if strings.TrimSpace(mutation.ClientRequestID) == "" {
		return invalidRequest("clientRequestId is required")
	}
	return nil
}

func validateConnectorMutation(mutation ConnectorMutation) error {
	if err := validateMutation(mutation.Mutation); err != nil {
		return err
	}
	if strings.TrimSpace(mutation.ConnectorKey) == "" {
		return invalidRequest("connectorKey is required")
	}
	return nil
}

func verifyRevision(tx Transaction, expected uint64) error {
	if tx.Revision() == expected {
		return nil
	}
	return NewDomainError(
		ErrorCodeRevisionConflict,
		fmt.Sprintf("expected revision %d but current revision is %d", expected, tx.Revision()),
		true,
		nil,
	)
}

func verifyIdempotentOperation(operation Operation, kind OperationKind, connectorKey string) error {
	if operation.Kind == kind && operation.ConnectorKey == connectorKey {
		return nil
	}
	return invalidRequest("clientRequestId was already used for a different connector-market command")
}

func rejectActiveOperation(tx Transaction, connectorKey string) error {
	active, err := tx.ActiveOperation(connectorKey)
	if err != nil {
		return err
	}
	if active == nil {
		return nil
	}
	return NewDomainError(
		ErrorCodeOperationInProgress,
		fmt.Sprintf("operation %s is already in progress", active.OperationID),
		true,
		nil,
	)
}

func invalidRequest(message string) error {
	return NewDomainError(ErrorCodeInvalidRequest, message, false, nil)
}

func invalidTransition(kind, from, to string) error {
	return NewDomainError(
		ErrorCodeOperationInProgress,
		fmt.Sprintf("%s cannot transition from %s to %s", kind, from, to),
		true,
		nil,
	)
}

func randomID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func (application *Application) publishChanged(ctx context.Context, connectorKey, operationID string, revision uint64) {
	_ = application.config.Events.ConnectorMarketChanged(ctx, ChangedEvent{
		ConnectorKey: connectorKey,
		OperationID:  operationID,
		Revision:     revision,
	})
}
