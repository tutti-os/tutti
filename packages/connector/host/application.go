//revive:disable:file-length-limit

package host

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"
)

type ApplicationConfig struct {
	Repository               Repository
	CatalogSource            CatalogSource
	ReleaseInstallations     ReleaseInstallationManager
	Host                     ImplementationHost
	Authorization            AuthorizationProvider
	AuthorizationProjections AuthorizationProjectionStore
	AuthorizationSnapshots   AuthorizationSnapshotSource
	AuthorizationReadiness   *AuthorizationReadinessGate
	RuntimeBindings          RuntimeBindingResolver
	Compatibility            CompatibilityEvaluator
	Scheduler                OperationScheduler
	ImplementationRegistry   ImplementationRegistry
	WorkerID                 string
	BootEpoch                string
	LeaseDuration            time.Duration
	Now                      func() time.Time
	NewID                    func() (string, error)
}

type Application struct {
	config ApplicationConfig

	// executionMu and inFlight provide process-local ownership for operation
	// execution. Durable recovery remains the repository and adapter contract.
	executionMu sync.Mutex
	inFlight    map[string]*operationExecution
}

type operationExecution struct {
	done chan struct{}
	err  error
}

var _ Service = (*Application)(nil)

func NewApplication(config ApplicationConfig) (*Application, error) {
	if config.Repository == nil {
		return nil, errors.New("connector market repository is required")
	}
	if config.CatalogSource == nil {
		return nil, errors.New("connector market catalog source is required")
	}
	if config.ReleaseInstallations == nil {
		return nil, errors.New("connector market release installation manager is required")
	}
	if config.Host == nil {
		return nil, errors.New("connector market implementation host is required")
	}
	if config.Authorization == nil {
		return nil, errors.New("connector market authorization provider is required")
	}
	if config.RuntimeBindings == nil {
		config.RuntimeBindings = defaultRuntimeBindingResolver{}
	}
	if config.Compatibility == nil {
		return nil, errors.New("connector market compatibility evaluator is required")
	}
	if config.Scheduler == nil {
		return nil, errors.New("connector market operation scheduler is required")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.NewID == nil {
		config.NewID = randomID
	}
	if strings.TrimSpace(config.WorkerID) == "" {
		workerID, err := config.NewID()
		if err != nil {
			return nil, fmt.Errorf("generate connector market worker id: %w", err)
		}
		config.WorkerID = workerID
	}
	if strings.TrimSpace(config.BootEpoch) == "" {
		bootEpoch, err := config.NewID()
		if err != nil {
			return nil, fmt.Errorf("generate connector market boot epoch: %w", err)
		}
		config.BootEpoch = bootEpoch
	}
	if config.LeaseDuration <= 0 {
		config.LeaseDuration = 30 * time.Second
	}
	return &Application{config: config, inFlight: make(map[string]*operationExecution)}, nil
}

func (application *Application) Snapshot(ctx context.Context) (Snapshot, error) {
	return application.config.Repository.Snapshot(ctx)
}

func (application *Application) ListCatalogCategories(ctx context.Context) ([]CatalogCategory, error) {
	categories, err := application.config.CatalogSource.ListCategories(ctx)
	if err != nil {
		return nil, preserveCatalogSourceError("connector catalog categories could not be loaded", err)
	}
	seen := make(map[string]struct{}, len(categories))
	for _, category := range categories {
		if strings.TrimSpace(category.CategoryID) == "" ||
			(category.Kind != "category" && category.Kind != "featured") ||
			category.ItemCount < 0 {
			return nil, invalidManifest("connector catalog returned an invalid category", nil)
		}
		if _, exists := seen[category.CategoryID]; exists {
			return nil, invalidManifest("connector catalog returned duplicate categories", nil)
		}
		seen[category.CategoryID] = struct{}{}
	}
	return categories, nil
}

func (application *Application) ListCatalogPage(ctx context.Context, query CatalogPageQuery) (CatalogPage, error) {
	query.SectionID = strings.TrimSpace(query.SectionID)
	query.PageToken = strings.TrimSpace(query.PageToken)
	if query.SectionID == "" || query.PageSize < 1 || query.PageSize > 100 {
		return CatalogPage{}, invalidRequest("sectionId and a pageSize between 1 and 100 are required")
	}
	page, err := application.config.CatalogSource.ListPage(ctx, CatalogSourcePageQuery(query))
	if err != nil {
		return CatalogPage{}, preserveCatalogSourceError("connector catalog page could not be loaded", err)
	}
	if page.SectionID != query.SectionID {
		return CatalogPage{}, invalidManifest("connector catalog page section does not match the request", nil)
	}
	seen := make(map[string]struct{}, len(page.Entries))
	compatibilityByKey := make(map[string]Compatibility, len(page.Entries))
	for _, entry := range page.Entries {
		if strings.TrimSpace(entry.CategoryID) == "" {
			return CatalogPage{}, invalidManifest("connector catalog item category is required", nil)
		}
		if _, exists := seen[entry.Release.ConnectorKey]; exists {
			return CatalogPage{}, invalidManifest("connector catalog page contains duplicate connectors", nil)
		}
		seen[entry.Release.ConnectorKey] = struct{}{}
		if err := ValidateReleaseShape(entry.Release); err != nil {
			return CatalogPage{}, err
		}
		compatibility, err := application.compatibilityFor(entry.Release.Manifest)
		if err != nil {
			return CatalogPage{}, err
		}
		compatibilityByKey[entry.Release.ConnectorKey] = compatibility
	}

	// Browsing is a cache-aside catalog sync. Persisting newly observed releases
	// makes an item immediately installable without waiting for the background
	// authoritative refresh; unseen items are never removed by a partial page.
	var revision uint64
	err = application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		revision = tx.Revision()
		changed := make([]Connector, 0, len(page.Entries))
		for _, entry := range page.Entries {
			connector, lookupErr := tx.Connector(entry.Release.ConnectorKey)
			if lookupErr != nil && !errors.Is(lookupErr, ErrNotFound) {
				return lookupErr
			}
			if errors.Is(lookupErr, ErrNotFound) {
				connector = newCatalogConnector(entry.Release)
			}
			compatibility := compatibilityByKey[entry.Release.ConnectorKey]
			if lookupErr == nil && reflect.DeepEqual(connector.Release, entry.Release) && reflect.DeepEqual(connector.Compatibility, compatibility) {
				continue
			}
			connector.Release = entry.Release
			connector.Authorization = authorizationForManifest(connector.Authorization, entry.Release.Manifest.AuthorizationKind)
			connector.Compatibility = compatibility
			changed = append(changed, connector)
		}
		if len(changed) == 0 {
			return nil
		}
		revision = tx.AdvanceRevision()
		for _, connector := range changed {
			connector.Revision = revision
			if err := tx.SaveConnector(connector); err != nil {
				return err
			}
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{Revision: revision})
	})
	if err != nil {
		return CatalogPage{}, err
	}

	result := CatalogPage{SectionID: page.SectionID, Items: make([]CatalogListing, 0, len(page.Entries)), NextPageToken: page.NextPageToken, Revision: revision}
	for _, entry := range page.Entries {
		connector, err := application.config.Repository.Connector(ctx, entry.Release.ConnectorKey)
		if err != nil {
			return CatalogPage{}, err
		}
		result.Items = append(result.Items, CatalogListing{CategoryID: entry.CategoryID, Featured: entry.Featured, Connector: connector})
	}
	return result, nil
}

func (application *Application) GetConnector(
	ctx context.Context,
	connectorKey string,
) (Connector, error) {
	if strings.TrimSpace(connectorKey) == "" {
		return Connector{}, invalidRequest("connectorKey is required")
	}
	return application.config.Repository.Connector(ctx, connectorKey)
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
			if installationRequiresPhysicalRepair(connector.Installation) {
				// Calibration deliberately retains the last committed release while
				// an installation is absent or invalid so a later observation can
				// restore it without reinstalling. Once the user explicitly repairs
				// the Connector, that evidence no longer describes a usable
				// installation and must not survive the transition to installing.
				connector.Installation = Installation{}
			}
			connector.Installation.State = target
			connector.Installation.FailureCode = ""
			return connector, nil
		},
	)
	return result, err
}

func installationRequiresPhysicalRepair(installation Installation) bool {
	if installation.State != InstallationStateFailed {
		return false
	}
	return installation.FailureCode == InstallationFailureCodePhysicallyAbsent ||
		installation.FailureCode == InstallationFailureCodePhysicallyInvalid
}

// Uninstall removes the Connector runtime and release from this device. It is
// deliberately independent from DisconnectAuthorization: account authorization
// remains server-owned and can be reused by another device or a later reinstall.
func (application *Application) Uninstall(
	ctx context.Context,
	mutation ConnectorMutation,
) (MutationResult, error) {
	return application.acceptConnectorOperation(
		ctx,
		mutation,
		OperationKindUninstall,
		func(connector Connector) (Connector, error) {
			if connector.Installation.InstalledReleaseDigest == "" {
				return Connector{}, invalidTransition(
					"installation",
					string(connector.Installation.State),
					string(InstallationStateUninstalling),
				)
			}
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
	secret []byte,
) (AuthorizationResult, error) {
	defer clear(secret)
	if err := validateConnectorMutation(mutation); err != nil {
		return AuthorizationResult{}, err
	}
	current, err := application.config.Repository.Connector(ctx, mutation.ConnectorKey)
	if err != nil {
		return AuthorizationResult{}, err
	}
	remote := current.Release.Manifest.Implementation.RemoteStreamableHTTP != nil
	accountID := strings.TrimSpace(mutation.AccountID)
	accountScoped := accountID != ""
	if remote && !accountScoped {
		return AuthorizationResult{}, invalidRequest("accountId is required for remote connector authorization")
	}
	idempotentReplay, err := application.isIdempotentConnectorOperation(
		ctx,
		mutation,
		OperationKindStartAuthorization,
	)
	if err != nil {
		return AuthorizationResult{}, err
	}
	if accountScoped && !idempotentReplay {
		projection, projectionErr := application.GetAuthorizationProjection(ctx, accountID, mutation.ConnectorKey)
		if projectionErr != nil && !errors.Is(projectionErr, ErrNotFound) {
			return AuthorizationResult{}, projectionErr
		}
		if projectionErr == nil && projection.State != AuthorizationStateDisconnected &&
			projection.State != AuthorizationStateExpired && projection.State != AuthorizationStateFailed {
			return AuthorizationResult{}, invalidTransition(
				"authorization", string(projection.State), string(AuthorizationStatePending),
			)
		}
	}
	accepted, err := application.acceptConnectorOperation(
		ctx,
		mutation,
		OperationKindStartAuthorization,
		func(connector Connector) (Connector, error) {
			if remote {
				return connector, nil
			}
			// Account-scoped authorization may reuse an already connected local
			// credential broker. Keep device truth intact while the provider binds
			// that credential to the current account projection.
			if accountScoped && connector.Authorization.State == AuthorizationStateConnected {
				return connector, nil
			}
			if !CanTransitionAuthorization(connector.Authorization.State, AuthorizationStatePending) {
				return Connector{}, invalidTransition(
					"authorization",
					string(connector.Authorization.State),
					string(AuthorizationStatePending),
				)
			}
			connector.Authorization = Authorization{State: AuthorizationStatePending}
			return connector, nil
		},
	)
	if err != nil {
		return AuthorizationResult{}, err
	}
	if accepted.Operation.State == OperationStateFailed {
		return AuthorizationResult{}, NewDomainError(
			ErrorCodeAuthorizationFailed,
			"connector authorization attempt previously failed",
			true,
			nil,
		)
	}

	session, err := application.beginAuthorizationSession(ctx, accepted.Operation, secret)
	if err != nil {
		if accepted.Operation.State != OperationStateCompleted {
			_ = application.failOperation(ctx, accepted.Operation.OperationID, ErrorCodeAuthorizationFailed)
		}
		return AuthorizationResult{}, err
	}
	operation, err := application.config.Repository.Operation(ctx, accepted.Operation.OperationID)
	if err != nil {
		return AuthorizationResult{}, err
	}
	connector, err := application.config.Repository.Connector(ctx, mutation.ConnectorKey)
	if err != nil {
		return AuthorizationResult{}, err
	}
	if accountScoped {
		projection, projectionErr := application.GetAuthorizationProjection(ctx, accountID, mutation.ConnectorKey)
		if errors.Is(projectionErr, ErrNotFound) {
			connector.Authorization = Authorization{State: AuthorizationStateDisconnected}
		} else if projectionErr != nil {
			return AuthorizationResult{}, projectionErr
		} else {
			connector.Authorization = Authorization{State: projection.State, FailureCode: projection.FailureCode}
		}
	}
	return AuthorizationResult{
		Connector:        connector,
		Operation:        operation,
		AuthorizationURL: session.AuthorizationURL,
		Revision:         connector.Revision,
	}, nil
}

// ReconcileAuthorizations observes unresolved private start receipts for one
// explicit account. Remote Connector truth comes from the account projection;
// the device-scoped Connector authorization field is only used by local
// Connectors. It is safe to call repeatedly and after a daemon restart.
func (application *Application) ReconcileAuthorizations(ctx context.Context, scope OperationScope) ([]AuthorizationReconcileIntent, error) {
	observer, ok := application.config.Authorization.(AuthorizationObserver)
	if !ok {
		return nil, nil
	}
	operations, err := application.config.Repository.UnresolvedAuthorizationSessionOperations(ctx, scope)
	if err != nil {
		return nil, err
	}
	intents := make([]AuthorizationReconcileIntent, 0, len(operations))
	var reconcileErr error
	for _, operation := range operations {
		if operation.Execution.AuthorizationSession == nil {
			continue
		}
		connector, connectorErr := application.config.Repository.Connector(ctx, operation.ConnectorKey)
		if connectorErr != nil {
			reconcileErr = errors.Join(reconcileErr, connectorErr)
			continue
		}
		release, releaseErr := frozenRelease(operation)
		if releaseErr != nil {
			reconcileErr = errors.Join(reconcileErr, releaseErr)
			continue
		}
		remote := release.Manifest.Implementation.RemoteStreamableHTTP != nil
		if remote {
			projection, projectionErr := application.GetAuthorizationProjection(ctx, scope.AccountID, connector.Key)
			if projectionErr == nil && projection.State == AuthorizationStateConnected {
				intents = append(intents, AuthorizationReconcileIntent{OperationID: operation.OperationID,
					ConnectorKey: connector.Key, Resolution: AuthorizationSessionResolutionAccountStateConverged})
				continue
			}
			if projectionErr != nil && !errors.Is(projectionErr, ErrNotFound) {
				reconcileErr = errors.Join(reconcileErr, projectionErr)
				continue
			}
		} else if connector.Authorization.State != AuthorizationStatePending {
			continue
		}
		session := *operation.Execution.AuthorizationSession
		observation, observeErr := observer.Observe(ctx, AuthorizationObserveRequest{
			Scope: operation.Scope, Connector: connector, Release: release, Session: session,
		})
		if observeErr != nil {
			reconcileErr = errors.Join(reconcileErr, observeErr)
			continue
		}
		if observation.State == AuthorizationObservationPending {
			continue
		}
		if observation.State != AuthorizationObservationConnected && observation.State != AuthorizationObservationFailed {
			reconcileErr = errors.Join(reconcileErr, errors.New("authorization observer returned an invalid state"))
			continue
		}
		resolution := authorizationSessionResolutionForObservation(observation)
		if !remote {
			if completeErr := application.completeAuthorizationObservation(ctx, connector.Key, observation); completeErr != nil {
				reconcileErr = errors.Join(reconcileErr, completeErr)
				continue
			}
		}
		projectionState := AuthorizationStateConnected
		if observation.State == AuthorizationObservationFailed {
			projectionState = AuthorizationStateFailed
		}
		if _, err := application.projectAuthorization(ctx, operation.Scope, connector.Key,
			observation.ConnectionID, projectionState, observation.FailureCode); err != nil {
			reconcileErr = errors.Join(reconcileErr, err)
			continue
		}
		intents = append(intents, AuthorizationReconcileIntent{OperationID: operation.OperationID,
			ConnectorKey: connector.Key, Resolution: resolution})
	}
	return intents, reconcileErr
}

func authorizationSessionResolutionForObservation(observation AuthorizationObservation) AuthorizationSessionResolution {
	if observation.State == AuthorizationObservationConnected {
		return AuthorizationSessionResolutionProviderConnected
	}
	if strings.Contains(strings.ToLower(strings.TrimSpace(observation.FailureCode)), "superseded") {
		return AuthorizationSessionResolutionSuperseded
	}
	return AuthorizationSessionResolutionProviderFailed
}

func (application *Application) DisconnectAuthorization(
	ctx context.Context,
	mutation ConnectorMutation,
) (MutationResult, error) {
	if err := validateConnectorMutation(mutation); err != nil {
		return MutationResult{}, err
	}
	current, err := application.config.Repository.Connector(ctx, mutation.ConnectorKey)
	if err != nil {
		return MutationResult{}, err
	}
	remote := current.Release.Manifest.Implementation.RemoteStreamableHTTP != nil
	if remote && strings.TrimSpace(mutation.AccountID) == "" {
		return MutationResult{}, invalidRequest("accountId is required for remote connector authorization")
	}
	return application.acceptConnectorOperation(
		ctx,
		mutation,
		OperationKindDisconnectAuthorization,
		func(connector Connector) (Connector, error) {
			if remote {
				return connector, nil
			}
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

func (application *Application) ExecuteOperation(ctx context.Context, operationID string) error {
	execution, owner := application.beginOperationExecution(operationID)
	if !owner {
		select {
		case <-execution.done:
			return execution.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	var executeErr error
	defer func() {
		application.finishOperationExecution(operationID, execution, executeErr)
	}()
	executeErr = application.executeOperation(ctx, operationID)
	return executeErr
}

func (application *Application) beginOperationExecution(operationID string) (*operationExecution, bool) {
	application.executionMu.Lock()
	defer application.executionMu.Unlock()
	if execution, ok := application.inFlight[operationID]; ok {
		return execution, false
	}
	execution := &operationExecution{done: make(chan struct{})}
	application.inFlight[operationID] = execution
	return execution, true
}

func (application *Application) finishOperationExecution(
	operationID string,
	execution *operationExecution,
	err error,
) {
	application.executionMu.Lock()
	defer application.executionMu.Unlock()
	execution.err = err
	delete(application.inFlight, operationID)
	close(execution.done)
}

func (application *Application) executeOperation(ctx context.Context, operationID string) error {
	now := application.config.Now().UTC()
	operation, claimed, err := application.config.Repository.ClaimOperation(
		ctx,
		operationID,
		application.config.WorkerID,
		now,
		now.Add(application.config.LeaseDuration),
	)
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}
	executionContext, cancelExecution := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go application.renewOperationLease(executionContext, cancelExecution, operation, heartbeatDone)
	defer func() {
		cancelExecution()
		<-heartbeatDone
		_ = application.config.Repository.ReleaseOperationLease(
			context.WithoutCancel(ctx),
			operationID,
			application.config.WorkerID,
			operation.LeaseToken,
		)
	}()
	if operation.State == OperationStateCompleted || operation.State == OperationStateFailed {
		return nil
	}
	operation, err = application.markOperationRunning(executionContext, operation.OperationID)
	if err != nil {
		return err
	}

	var executeErr error
	switch operation.Kind {
	case OperationKindRefreshCatalog:
		executeErr = application.executeRefresh(executionContext, operation)
	case OperationKindInstall:
		executeErr = application.executeInstall(executionContext, operation)
	case OperationKindUninstall:
		executeErr = application.executeUninstall(executionContext, operation)
	case OperationKindReconcileRuntime:
		executeErr = application.executeRuntimeReconcile(executionContext, operation)
	case OperationKindDisconnectAuthorization:
		executeErr = application.executeDisconnectAuthorization(executionContext, operation)
	case OperationKindStartAuthorization:
		_, executeErr = application.beginAuthorizationSession(executionContext, operation, nil)
	default:
		executeErr = invalidRequest(fmt.Sprintf("operation kind %q is not executable", operation.Kind))
	}
	if executeErr != nil {
		code := ErrorCodeInstallFailed
		if operation.Kind == OperationKindRefreshCatalog {
			code = errorCodeOr(executeErr, ErrorCodeUpstreamUnavailable)
		}
		if operation.Kind == OperationKindStartAuthorization ||
			operation.Kind == OperationKindDisconnectAuthorization {
			code = ErrorCodeAuthorizationFailed
		}
		terminalContext, cancelTerminal := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		terminalErr := application.failOperation(terminalContext, operation.OperationID, code)
		cancelTerminal()
		if terminalErr != nil {
			return errors.Join(executeErr, fmt.Errorf("record connector operation failure: %w", terminalErr))
		}
		return executeErr
	}
	return nil
}

func (application *Application) renewOperationLease(ctx context.Context, cancel context.CancelFunc, operation Operation, done chan<- error) {
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
			err := application.config.Repository.RenewOperationLease(renewContext, operation.OperationID,
				application.config.WorkerID, operation.LeaseToken, now, now.Add(application.config.LeaseDuration))
			renewCancel()
			if err != nil {
				cancel()
				done <- err
				return
			}
		}
	}
}

func (application *Application) Recover(ctx context.Context) error {
	operations, err := application.config.Repository.RecoverableOperations(ctx)
	if err != nil {
		return err
	}
	for _, operation := range operations {
		if operationTouchesImplementationHost(operation.Kind) && operation.HostGeneration.BootEpoch != application.config.BootEpoch {
			operation, err = application.adoptRuntimeOperation(ctx, operation.OperationID)
			if err != nil {
				return err
			}
		}
		if operation.LeaseExpiresAt != nil && operation.LeaseExpiresAt.After(application.config.Now().UTC()) &&
			operation.LeaseOwner != "" && operation.LeaseOwner != application.config.WorkerID {
			delay := operation.LeaseExpiresAt.Sub(application.config.Now().UTC())
			operationID := operation.OperationID
			go func() {
				timer := time.NewTimer(delay)
				defer timer.Stop()
				select {
				case <-ctx.Done():
					return
				case <-timer.C:
					_ = application.config.Scheduler.Schedule(ctx, operationID)
				}
			}()
			continue
		}
		if err := application.config.Scheduler.Schedule(ctx, operation.OperationID); err != nil {
			return NewDomainError(ErrorCodeUnavailable, "connector operation recovery could not be scheduled", true, err)
		}
	}
	return nil
}

func operationTouchesImplementationHost(kind OperationKind) bool {
	switch kind {
	case OperationKindInstall, OperationKindUninstall, OperationKindReconcileRuntime:
		return true
	default:
		return false
	}
}

func (application *Application) adoptRuntimeOperation(ctx context.Context, operationID string) (Operation, error) {
	var adopted Operation
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		operation, err := tx.Operation(operationID)
		if err != nil {
			return err
		}
		if operation.State == OperationStateCompleted || operation.State == OperationStateFailed {
			adopted = operation
			return nil
		}
		revision := tx.AdvanceRevision()
		operation.HostGeneration = HostGeneration{BootEpoch: application.config.BootEpoch, Generation: revision}
		operation.UpdatedAt = application.config.Now().UTC()
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		if err := tx.EnqueueConnectorMarketChanged(ChangedEvent{ConnectorKey: operation.ConnectorKey, OperationID: operation.OperationID, Revision: revision}); err != nil {
			return err
		}
		adopted = operation
		return nil
	})
	return adopted, err
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
			if err := verifyIdempotentOperation(*existing, kind, mutation.ConnectorKey, mutation.AccountID); err != nil {
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
			Scope:           OperationScope{AccountID: strings.TrimSpace(mutation.AccountID)},
			State:           OperationStateAccepted,
			Stage:           OperationStageAccepted,
			Target:          operationTarget(kind, connector),
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		if kind == OperationKindInstall || kind == OperationKindUninstall || kind == OperationKindReconcileRuntime {
			operation.HostGeneration = HostGeneration{BootEpoch: application.config.BootEpoch, Generation: revision}
		}
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		if err := tx.SaveOperation(operation); err != nil {
			return err
		}
		if err := tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: connector.Key,
			OperationID:  operation.OperationID,
			Revision:     revision,
		}); err != nil {
			return err
		}
		result = MutationResult{Connector: &connector, Operation: operation, Revision: revision}
		return nil
	})
	if err != nil {
		return MutationResult{}, err
	}
	if kind != OperationKindStartAuthorization &&
		(result.Operation.State == OperationStateAccepted || result.Operation.State == OperationStateRunning) {
		if err := application.config.Scheduler.Schedule(ctx, result.Operation.OperationID); err != nil {
			return MutationResult{}, NewDomainError(ErrorCodeUnavailable, "connector operation could not be scheduled", true, err)
		}
	}
	return result, nil
}

// isIdempotentConnectorOperation distinguishes a continuation of an existing
// command from a new state transition. Authorization providers may expose a
// multi-step flow through repeated BeginAuthorization calls with one stable
// clientRequestId, so account projection guards must not reject that replay as
// a new pending-to-pending transition. acceptConnectorOperation repeats this
// verification inside its mutation transaction before returning the operation.
func (application *Application) isIdempotentConnectorOperation(
	ctx context.Context,
	mutation ConnectorMutation,
	kind OperationKind,
) (bool, error) {
	var replay bool
	err := application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		existing, err := tx.OperationByClientRequestID(mutation.ClientRequestID)
		if err != nil {
			return err
		}
		if existing == nil {
			return nil
		}
		if err := verifyIdempotentOperation(*existing, kind, mutation.ConnectorKey, mutation.AccountID); err != nil {
			return err
		}
		replay = true
		return nil
	})
	return replay, err
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
			if err := verifyIdempotentOperation(*existing, kind, connectorKey, ""); err != nil {
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
			Stage:           OperationStageAccepted,
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
		if err := tx.EnqueueConnectorMarketChanged(ChangedEvent{
			ConnectorKey: connectorKey,
			OperationID:  operation.OperationID,
			Revision:     revision,
		}); err != nil {
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

func verifyIdempotentOperation(operation Operation, kind OperationKind, connectorKey, accountID string) error {
	if operation.Kind != kind || operation.ConnectorKey != connectorKey ||
		operation.Scope.AccountID != strings.TrimSpace(accountID) {
		return invalidRequest("clientRequestId was already used for a different connector-market command")
	}
	return nil
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

func operationTarget(kind OperationKind, connector Connector) *OperationTarget {
	if kind == OperationKindInstall || kind == OperationKindStartAuthorization ||
		kind == OperationKindDisconnectAuthorization {
		release := connector.Release
		return &OperationTarget{
			ConnectorKey:   release.ConnectorKey,
			Version:        release.Version,
			ReleaseID:      release.ReleaseID,
			ReleaseDigest:  release.ReleaseDigest,
			ArtifactSHA256: release.Artifact.SHA256,
			Release:        &release,
		}
	}
	if kind == OperationKindUninstall || kind == OperationKindReconcileRuntime {
		return &OperationTarget{
			ConnectorKey:  connector.Key,
			Version:       connector.Installation.InstalledVersion,
			ReleaseID:     connector.Installation.InstalledReleaseID,
			ReleaseDigest: connector.Installation.InstalledReleaseDigest,
		}
	}
	return nil
}
