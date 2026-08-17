package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	market "github.com/tutti-os/tutti/packages/connector/host"
)

type HostConfig struct {
	Repository               market.Repository
	CatalogSource            market.CatalogSource
	ReleaseInstallations     market.ReleaseInstallationManager
	ImplementationHost       market.ImplementationHost
	Authorization            market.AuthorizationProvider
	AuthorizationProjections market.AuthorizationProjectionStore
	AuthorizationSnapshots   market.AuthorizationSnapshotSource
	AuthorizationEvents      market.AuthorizationEventSource
	AuthorizationReadiness   *market.AuthorizationReadinessGate
	RuntimeBindings          market.RuntimeBindingResolver
	Compatibility            market.CompatibilityEvaluator
	ImplementationRegistry   market.ImplementationRegistry
	Outbox                   market.ChangedEventOutbox
	Lifecycle                market.LifecycleCleanupStore
	LifecyclePolicy          LifecycleCleanupPolicy
	Publisher                ChangedEventPublisher
	Publication              CapabilityPublicationController
}

// CapabilityPublicationController is the daemon-level publication boundary
// for runtimes owned by another process or machine.
type CapabilityPublicationController interface {
	ApplyCapabilityPublication(context.Context, market.OperationScope, bool) error
}

type Host struct {
	Application *market.Application

	cancel                     context.CancelFunc
	scheduler                  *OperationScheduler
	outboxDone                 chan struct{}
	lifecycleDone              chan struct{}
	authorizationSyncDone      chan struct{}
	authorizationSyncWake      chan struct{}
	authorizationEventsDone    chan struct{}
	authorizationScopeWake     chan struct{}
	runtimeRecoveryDone        chan struct{}
	runtimeRecoveryWake        chan struct{}
	runtimeConvergenceDone     chan struct{}
	operationRecoveryDone      chan struct{}
	closeOnce                  sync.Once
	bootstrapMu                sync.Mutex
	bootstrapped               bool
	bootstrapScope             market.OperationScope
	refreshWorkerStarted       bool
	repository                 market.Repository
	implementationHost         market.ImplementationHost
	activationGate             *activationGateHost
	publicationGate            capabilityPublicationGate
	publication                CapabilityPublicationController
	authorizationSnapshots     market.AuthorizationSnapshotSource
	authorizationSnapshotStore market.AuthorizationSnapshotStore
	authorizationEvents        market.AuthorizationEventSource
	authorizationReadiness     *market.AuthorizationReadinessGate
	authorizationDirty         map[string]map[string]struct{}
	runtimeRecoveryPending     map[string]struct{}
}

type capabilityPublicationGate interface {
	SetCapabilityPublication(bool)
}

func NewHost(parent context.Context, config HostConfig) (*Host, error) {
	if parent == nil {
		parent = context.Background()
	}
	if config.Outbox == nil || config.Lifecycle == nil || config.Publisher == nil {
		return nil, errors.New("connector market outbox, lifecycle cleanup, and publisher are required")
	}
	hostContext, cancel := context.WithCancel(parent)
	scheduler := NewOperationScheduler(hostContext)
	activationGate := newActivationGateHost(config.ImplementationHost)
	application, err := market.NewApplication(market.ApplicationConfig{
		Repository:               config.Repository,
		CatalogSource:            config.CatalogSource,
		ReleaseInstallations:     config.ReleaseInstallations,
		Host:                     activationGate,
		Authorization:            config.Authorization,
		AuthorizationProjections: config.AuthorizationProjections,
		AuthorizationSnapshots:   config.AuthorizationSnapshots,
		AuthorizationReadiness:   config.AuthorizationReadiness,
		RuntimeBindings:          config.RuntimeBindings,
		Compatibility:            config.Compatibility,
		Scheduler:                scheduler,
		ImplementationRegistry:   config.ImplementationRegistry,
	})
	if err != nil {
		cancel()
		return nil, err
	}
	if err := scheduler.Bind(application); err != nil {
		cancel()
		return nil, err
	}
	host := &Host{
		Application:             application,
		cancel:                  cancel,
		scheduler:               scheduler,
		outboxDone:              make(chan struct{}),
		lifecycleDone:           make(chan struct{}),
		authorizationSyncDone:   make(chan struct{}),
		authorizationSyncWake:   make(chan struct{}, 1),
		authorizationEventsDone: make(chan struct{}),
		authorizationScopeWake:  make(chan struct{}, 1),
		runtimeRecoveryDone:     make(chan struct{}),
		runtimeRecoveryWake:     make(chan struct{}, 1),
		runtimeConvergenceDone:  make(chan struct{}),
		operationRecoveryDone:   make(chan struct{}),
		repository:              config.Repository,
		implementationHost:      config.ImplementationHost,
		activationGate:          activationGate,
		publication:             config.Publication,
		authorizationSnapshots:  config.AuthorizationSnapshots,
		authorizationEvents:     config.AuthorizationEvents,
		authorizationReadiness:  config.AuthorizationReadiness,
		authorizationDirty:      make(map[string]map[string]struct{}),
		runtimeRecoveryPending:  make(map[string]struct{}),
	}
	if snapshotStore, ok := config.AuthorizationProjections.(market.AuthorizationSnapshotStore); ok {
		host.authorizationSnapshotStore = snapshotStore
	}
	if publicationGate, ok := config.ImplementationHost.(capabilityPublicationGate); ok {
		host.publicationGate = publicationGate
		if host.publication == nil {
			publicationGate.SetCapabilityPublication(false)
		}
	}
	dispatcher := OutboxDispatcher{Outbox: config.Outbox, Publisher: config.Publisher}
	go func() {
		defer close(host.outboxDone)
		dispatcher.Run(hostContext)
	}()
	if host.authorizationSnapshots != nil && host.authorizationSnapshotStore != nil {
		go host.runAuthorizationSnapshotWorker(hostContext)
	} else {
		close(host.authorizationSyncDone)
	}
	if host.authorizationEvents != nil {
		go host.runAuthorizationEventWorker(hostContext)
	} else {
		close(host.authorizationEventsDone)
	}
	if _, ok := config.Authorization.(market.AuthorizationObserver); ok {
		go host.runAuthorizationReconcileWorker(hostContext)
	}
	go func() {
		defer close(host.runtimeRecoveryDone)
		host.runRuntimeRecoveryWorker(hostContext)
	}()
	go func() {
		defer close(host.runtimeConvergenceDone)
		host.runRuntimeConvergenceWorker(hostContext)
	}()
	go func() {
		defer close(host.operationRecoveryDone)
		host.runOperationRecoveryWorker(hostContext)
	}()
	cleanupWorker := LifecycleCleanupWorker{Store: config.Lifecycle, Policy: config.LifecyclePolicy}
	go func() {
		defer close(host.lifecycleDone)
		cleanupWorker.Run(hostContext)
	}()
	return host, nil
}

func (host *Host) runAuthorizationReconcileWorker(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reconcileContext, cancel := context.WithTimeout(ctx, 15*time.Second)
			host.bootstrapMu.Lock()
			bootstrapped, scope := host.bootstrapped, host.bootstrapScope
			if !bootstrapped || strings.TrimSpace(scope.AccountID) == "" {
				host.bootstrapMu.Unlock()
				cancel()
				continue
			}
			err := host.reconcileAuthorizationsLocked(reconcileContext, scope)
			host.bootstrapMu.Unlock()
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("connector authorization reconciliation failed", "error", err)
			}
		}
	}
}

func (host *Host) reconcileAuthorizationsLocked(ctx context.Context, scope market.OperationScope) error {
	intents, err := host.Application.ReconcileAuthorizations(ctx, scope)
	if err != nil || len(intents) == 0 {
		return err
	}
	// ReconcileAuthorizations persists projection intent. Create or join one
	// scoped runtime operation for every affected Connector before releasing the
	// lifecycle fence, so logout or account switching cannot be followed by a
	// late old-account route publication.
	connectorKeys := make(map[string]struct{}, len(intents))
	for _, intent := range intents {
		connectorKeys[intent.ConnectorKey] = struct{}{}
	}
	for connectorKey := range connectorKeys {
		if reconcileErr := host.reconcileRuntimeForScopeLocked(ctx, scope, connectorKey); reconcileErr != nil {
			err = errors.Join(err, reconcileErr)
		}
	}
	if err != nil {
		return err
	}
	for _, intent := range intents {
		if resolveErr := host.repository.ResolveAuthorizationSession(ctx, intent.OperationID, intent.Resolution); resolveErr != nil {
			err = errors.Join(err, resolveErr)
		}
	}
	return err
}

// Bootstrap restores durable local runtime intent without depending on the
// remote catalog. Account-authorized remote routes additionally require a
// fresh server snapshot before the lifecycle gate opens.
func (host *Host) Bootstrap(ctx context.Context) error {
	return host.BootstrapForScope(ctx, market.OperationScope{})
}

// BootstrapForScope restores device-installed runtimes for the explicitly
// active account authority. The scope is retained for retry workers but no
// short-lived grant is retained by the daemon.
func (host *Host) BootstrapForScope(ctx context.Context, scope market.OperationScope) error {
	if host == nil || host.Application == nil {
		return errors.New("connector market host is unavailable")
	}
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	sameScope := host.bootstrapScope == scope
	if host.bootstrapped && sameScope && !host.activationGate.requiresRecovery() {
		return host.reconcilePendingRuntimesLocked(ctx, scope)
	}
	host.bootstrapScope = scope
	host.runtimeRecoveryPending = make(map[string]struct{})
	if host.authorizationReadiness != nil && strings.TrimSpace(scope.AccountID) != "" {
		host.authorizationReadiness.SetReady(scope.AccountID, false)
	}
	host.notifyAuthorizationScopeChanged()
	host.bootstrapped = false
	if !host.refreshWorkerStarted {
		host.refreshWorkerStarted = true
		go host.runCatalogRefreshWorker()
	}
	host.activationGate.setOpen(scope, false)
	if err := host.applyCapabilityPublication(ctx, scope, false); err != nil {
		return err
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		host.activationGate.setOpen(scope, false)
		_ = host.applyCapabilityPublication(context.Background(), scope, false)
		fenceContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := host.implementationHost.FailClosed(fenceContext, time.Now().Add(10*time.Second)); err != nil {
			slog.Error("connector market bootstrap rollback runtime fence failed", "error", err)
		}
		if err := host.Application.FenceInstalledRuntimesForScope(fenceContext, scope); err != nil {
			slog.Error("connector market bootstrap rollback fence failed", "error", err)
		}
	}()
	// Fence any route left by an interrupted previous bootstrap before recovery
	// can replay host-touching operations. Reconcile calls remain staged behind
	// activationGate until durable local recovery has completed.
	if err := host.implementationHost.FailClosed(ctx, time.Now().Add(10*time.Second)); err != nil {
		return err
	}
	if err := host.Application.FenceInstalledRuntimesForScope(ctx, scope); err != nil {
		return err
	}
	if err := host.recoverAndWait(ctx); err != nil {
		return err
	}
	if err := host.Application.CalibrateInstalledConnectorsForScope(ctx, scope); err != nil {
		// A timeout or other indeterminate probe must preserve durable truth. The
		// following runtime reconcile remains authoritative and may still recover.
		slog.Warn("connector installation calibration was indeterminate", "error", err)
	}
	if strings.TrimSpace(scope.AccountID) != "" {
		if _, err := host.syncAuthorizationSnapshot(ctx, scope); err != nil {
			// Account authorization is fail-closed independently. Device-local
			// authorization-free connectors can still recover while a later WS or
			// poll retries the authoritative snapshot.
			slog.Warn("connector authorization snapshot unavailable during bootstrap", "error", err)
		} else if host.authorizationReadiness != nil {
			host.authorizationReadiness.SetReady(scope.AccountID, true)
		}
	}
	host.activationGate.setOpen(scope, true)
	reconcileErr := host.Application.ReconcileInstalledRuntimesForScope(ctx, scope)
	var reconcileFailures *market.RuntimeReconcileFailures
	if reconcileErr != nil && !errors.As(reconcileErr, &reconcileFailures) {
		return reconcileErr
	}
	if reconcileFailures != nil {
		for _, connectorKey := range reconcileFailures.ConnectorKeys() {
			host.runtimeRecoveryPending[connectorKey] = struct{}{}
		}
		host.notifyRuntimeRecovery()
	}
	if err := host.applyCapabilityPublication(ctx, scope, true); err != nil {
		return err
	}
	host.activationGate.markRecovered()
	host.bootstrapped = true
	committed = true
	if reconcileFailures != nil {
		slog.Warn("connector market bootstrap completed with unavailable connectors", "error", reconcileFailures)
	}
	return nil
}

// NotifyAuthorizationChanged treats realtime events and MCP authorization
// errors as convergence hints. The account snapshot remains the only truth.
func (host *Host) NotifyAuthorizationChanged() {
	if host == nil {
		return
	}
	select {
	case host.authorizationSyncWake <- struct{}{}:
	default:
	}
}

func (host *Host) notifyAuthorizationScopeChanged() {
	select {
	case host.authorizationScopeWake <- struct{}{}:
	default:
	}
}

func (host *Host) runAuthorizationEventWorker(ctx context.Context) {
	defer close(host.authorizationEventsDone)
	retry := time.Second
	for {
		host.bootstrapMu.Lock()
		scope := host.bootstrapScope
		host.bootstrapMu.Unlock()
		if strings.TrimSpace(scope.AccountID) == "" {
			select {
			case <-ctx.Done():
				return
			case <-host.authorizationScopeWake:
				continue
			}
		}
		attemptCtx, cancel := context.WithCancel(ctx)
		result := make(chan error, 1)
		go func(accountID string) {
			result <- host.authorizationEvents.RunAuthorizationEvents(attemptCtx, accountID, host.NotifyAuthorizationChanged)
		}(scope.AccountID)
		select {
		case <-ctx.Done():
			cancel()
			<-result
			return
		case <-host.authorizationScopeWake:
			cancel()
			<-result
			retry = time.Second
			continue
		case err := <-result:
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("connector authorization realtime listener failed", "error", err)
			}
		}
		timer := time.NewTimer(retry)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-host.authorizationScopeWake:
			timer.Stop()
			retry = time.Second
		case <-timer.C:
			if retry < time.Minute {
				retry *= 2
			}
		}
	}
}

type authorizationSyncResult struct {
	changed         []string
	receipts        []string
	becameReady     bool
	calibrate       bool
	snapshotApplied bool
}

func (host *Host) syncAuthorizationSnapshot(ctx context.Context, scope market.OperationScope) (authorizationSyncResult, error) {
	if host.authorizationSnapshots == nil || host.authorizationSnapshotStore == nil || strings.TrimSpace(scope.AccountID) == "" {
		return authorizationSyncResult{}, nil
	}
	snapshot, err := host.authorizationSnapshots.AuthorizationSnapshot(ctx, scope.AccountID)
	if err != nil {
		return authorizationSyncResult{}, err
	}
	applied, err := host.authorizationSnapshotStore.ApplyAuthorizationSnapshot(ctx, scope.AccountID, snapshot)
	result := authorizationSyncResult{
		changed:         applied.ChangedConnectorKeys,
		receipts:        applied.PendingReceiptConnectorKeys,
		snapshotApplied: err == nil,
	}
	return result, err
}

func (host *Host) runAuthorizationSnapshotWorker(ctx context.Context) {
	defer close(host.authorizationSyncDone)
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		calibrate := false
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			calibrate = true
		case <-host.authorizationSyncWake:
		}
		host.bootstrapMu.Lock()
		bootstrapped, scope := host.bootstrapped, host.bootstrapScope
		host.bootstrapMu.Unlock()
		if !bootstrapped || strings.TrimSpace(scope.AccountID) == "" {
			continue
		}
		syncContext, cancel := context.WithTimeout(ctx, 30*time.Second)
		result, err := host.syncAuthorizationSnapshot(syncContext, scope)
		result.calibrate = calibrate
		cancel()
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				slog.Warn("connector authorization snapshot sync failed", "error", err)
			}
			continue
		}
		reconcileContext, cancel := context.WithTimeout(ctx, 2*time.Minute)
		err = host.reconcileAuthorizationChanges(reconcileContext, scope, result)
		cancel()
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("connector authorization runtime reconcile failed", "error", err)
		}
	}
}

func (host *Host) reconcileAuthorizationChanges(ctx context.Context, scope market.OperationScope, result authorizationSyncResult) error {
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	if !host.bootstrapped || host.bootstrapScope != scope || host.activationGate.requiresRecovery() {
		return nil
	}
	if result.snapshotApplied && host.authorizationReadiness != nil {
		result.becameReady = host.authorizationReadiness.SetReady(scope.AccountID, true)
	}
	dirty := host.authorizationDirty[scope.AccountID]
	if dirty == nil {
		dirty = make(map[string]struct{})
		host.authorizationDirty[scope.AccountID] = dirty
	}
	connectorKeys, err := host.Application.InstalledRemoteAuthorizedConnectorKeys(ctx)
	if err != nil {
		return err
	}
	eligible := make(map[string]struct{}, len(connectorKeys))
	for _, connectorKey := range connectorKeys {
		eligible[connectorKey] = struct{}{}
	}
	for connectorKey := range dirty {
		if _, ok := eligible[connectorKey]; !ok {
			delete(dirty, connectorKey)
		}
	}
	for _, connectorKey := range result.changed {
		if _, ok := eligible[connectorKey]; ok {
			dirty[connectorKey] = struct{}{}
		}
	}
	for _, connectorKey := range result.receipts {
		if _, ok := eligible[connectorKey]; ok {
			dirty[connectorKey] = struct{}{}
		}
	}
	if result.becameReady || result.calibrate {
		for _, connectorKey := range connectorKeys {
			dirty[connectorKey] = struct{}{}
		}
	}
	var reconcileErr error
	for connectorKey := range dirty {
		if err := host.reconcileRuntimeForScopeLocked(ctx, scope, connectorKey); err != nil {
			reconcileErr = errors.Join(reconcileErr, fmt.Errorf("%s: %w", connectorKey, err))
			continue
		}
		delete(dirty, connectorKey)
	}
	return reconcileErr
}

// FenceForScope closes publication and runtime authority for an account
// boundary without deleting device installation truth. A later bootstrap,
// including one for the same account, must perform full recovery before routes
// can be published again.
func (host *Host) FenceForScope(ctx context.Context, scope market.OperationScope) error {
	if host == nil || host.Application == nil {
		return errors.New("connector market host is unavailable")
	}
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	host.activationGate.setOpen(scope, false)
	previousScope := host.bootstrapScope
	if host.authorizationReadiness != nil && strings.TrimSpace(previousScope.AccountID) != "" {
		host.authorizationReadiness.SetReady(previousScope.AccountID, false)
	}
	if host.authorizationReadiness != nil && strings.TrimSpace(scope.AccountID) != "" {
		host.authorizationReadiness.SetReady(scope.AccountID, false)
	}
	host.bootstrapped = false
	host.bootstrapScope = scope
	host.runtimeRecoveryPending = make(map[string]struct{})
	host.notifyAuthorizationScopeChanged()
	publicationErr := host.applyCapabilityPublication(ctx, scope, false)
	fenceErr := host.activationGate.FailClosed(ctx, time.Now().Add(10*time.Second))
	return errors.Join(publicationErr, fenceErr)
}

// ReconcileRuntimeForScope repairs one observed runtime route under the same
// lifecycle gate as bootstrap and fencing. The operation is awaited while the
// gate is held so a concurrent runtime replacement cannot fence its generation
// after acceptance but before the VM receipt is committed.
func (host *Host) ReconcileRuntimeForScope(ctx context.Context, scope market.OperationScope, connectorKey string) error {
	if host == nil || host.Application == nil {
		return errors.New("connector market host is unavailable")
	}
	if !host.bootstrapMu.TryLock() {
		// A bootstrap, fence, or earlier repair already owns convergence. The
		// observer will verify a fresh VM snapshot after that operation finishes.
		return nil
	}
	defer host.bootstrapMu.Unlock()
	if !host.bootstrapped || host.bootstrapScope != scope || host.activationGate.requiresRecovery() {
		// Bootstrap owns convergence while the lifecycle gate is closed. Enqueuing
		// a second per-Connector operation here would race its generation fence.
		return nil
	}
	return host.reconcileRuntimeForScopeLockedMode(ctx, scope, connectorKey, true)
}

func (host *Host) reconcileRuntimeForScopeLocked(ctx context.Context, scope market.OperationScope, connectorKey string) error {
	return host.reconcileRuntimeForScopeLockedMode(ctx, scope, connectorKey, false)
}

func (host *Host) reconcileRuntimeForScopeLockedMode(
	ctx context.Context,
	scope market.OperationScope,
	connectorKey string,
	force bool,
) error {
	connector, err := host.Application.GetConnector(ctx, connectorKey)
	if errors.Is(err, market.ErrNotFound) || err == nil && connector.Installation.State != market.InstallationStateInstalled {
		return nil
	}
	if err != nil {
		return err
	}
	if force {
		return host.Application.ReconcileRuntimeAfterInvalidation(ctx, scope, connectorKey)
	}
	return host.Application.ReconcileRuntimeDesired(ctx, scope, connectorKey)
}

// ObserveAuthorizationForScope commits account authorization and its runtime
// reconcile under the lifecycle gate. This prevents authorization callbacks
// from publishing a generation concurrently with bootstrap recovery.
func (host *Host) ObserveAuthorizationForScope(
	ctx context.Context,
	scope market.OperationScope,
	projection market.AuthorizationProjection,
) error {
	if host == nil || host.Application == nil {
		return errors.New("connector market host is unavailable")
	}
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	if err := host.Application.ProjectAuthorization(ctx, scope, projection); err != nil {
		return err
	}
	return host.reconcileRuntimeForScopeLocked(ctx, scope, projection.ConnectorKey)
}

func (host *Host) applyCapabilityPublication(ctx context.Context, scope market.OperationScope, enabled bool) error {
	if host.publication != nil {
		return host.publication.ApplyCapabilityPublication(ctx, scope, enabled)
	}
	if host.publicationGate != nil {
		host.publicationGate.SetCapabilityPublication(enabled)
	}
	return nil
}

func (host *Host) recoverAndWait(ctx context.Context) error {
	operations, err := host.repository.RecoverableOperations(ctx)
	if err != nil {
		return err
	}
	if len(operations) == 0 {
		return nil
	}
	if err := host.Application.Recover(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		pending := false
		for _, candidate := range operations {
			// Remote refresh and authorization operations may legitimately wait on
			// the network. Recover them, but do not make local route restoration
			// wait for their terminal state.
			if candidate.Kind != market.OperationKindInstall && candidate.Kind != market.OperationKindUninstall &&
				candidate.Kind != market.OperationKindReconcileRuntime {
				continue
			}
			operation, err := host.Application.GetOperation(ctx, candidate.OperationID)
			if err != nil {
				return err
			}
			if operation.State == market.OperationStateAccepted || operation.State == market.OperationStateRunning {
				pending = true
			}
		}
		if !pending {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (host *Host) refreshAndWait(ctx context.Context) error {
	snapshot, err := host.Application.Snapshot(ctx)
	if err != nil {
		return err
	}
	result, err := host.Application.RefreshCatalog(ctx, market.Mutation{
		ClientRequestID: "daemon-refresh-" + uuid.NewString(), ExpectedRevision: snapshot.Revision,
	})
	if err != nil {
		return err
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		operation, err := host.Application.GetOperation(ctx, result.Operation.OperationID)
		if err != nil {
			return err
		}
		switch operation.State {
		case market.OperationStateCompleted:
			return nil
		case market.OperationStateFailed:
			return fmt.Errorf("connector market refresh failed: %s", operation.FailureCode)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (host *Host) runCatalogRefreshWorker() {
	bootstrapRetry := time.Second
	catalogRetry := time.Duration(0)
	for {
		host.bootstrapMu.Lock()
		bootstrapped := host.bootstrapped
		scope := host.bootstrapScope
		host.bootstrapMu.Unlock()
		if !bootstrapped {
			timer := time.NewTimer(bootstrapRetry)
			select {
			case <-host.scheduler.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			bootstrapContext, cancel := context.WithTimeout(host.scheduler.ctx, 45*time.Second)
			err := host.BootstrapForScope(bootstrapContext, scope)
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("connector market bootstrap retry failed", "error", err)
				if bootstrapRetry < time.Minute {
					bootstrapRetry *= 2
				}
			} else {
				bootstrapRetry = time.Second
			}
			continue
		}
		timer := time.NewTimer(catalogRetry)
		select {
		case <-host.scheduler.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		refreshContext, cancel := context.WithTimeout(host.scheduler.ctx, 45*time.Second)
		err := host.refreshAndWait(refreshContext)
		cancel()
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("connector market scheduled refresh failed", "error", err)
			if catalogRetry < time.Minute {
				catalogRetry = time.Minute
			} else if catalogRetry < 5*time.Minute {
				catalogRetry *= 2
			}
			continue
		}
		catalogRetry = time.Minute
	}
}

func (host *Host) Close() {
	if host == nil {
		return
	}
	host.closeOnce.Do(func() {
		host.cancel()
		if closer, ok := host.implementationHost.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
		<-host.outboxDone
		<-host.lifecycleDone
		<-host.authorizationSyncDone
		<-host.authorizationEventsDone
		<-host.runtimeRecoveryDone
		<-host.runtimeConvergenceDone
		<-host.operationRecoveryDone
		host.scheduler.Wait()
	})
}

// CatalogOnlyPorts deliberately advertise no installable implementation. The
// host can safely expose remote browsing before a concrete runtime activator,
// artifact resolver, and authorization provider are registered.
func CatalogOnlyPorts() (
	market.ReleaseInstallationManager,
	market.ImplementationHost,
	market.AuthorizationProvider,
	market.CompatibilityEvaluator,
	market.ImplementationRegistry,
) {
	return unavailableReleaseInstaller{}, unavailableRuntime{}, unavailableAuthorization{},
		rejectingCompatibility{}, market.NewImplementationRegistry(nil)
}

type unavailableReleaseInstaller struct{}

func (unavailableReleaseInstaller) InstallRelease(context.Context, market.InstallReleaseRequest) (market.ReleaseInstallationReceipt, error) {
	return market.ReleaseInstallationReceipt{}, errors.New("connector release installation is not registered")
}

func (unavailableReleaseInstaller) InspectReleaseInstallation(_ context.Context, request market.InspectReleaseInstallationRequest) (market.ReleaseInstallationObservation, error) {
	return market.ReleaseInstallationObservation{State: market.ReleaseInstallationIndeterminate,
		ConnectorKey: request.Release.ConnectorKey, ReleaseDigest: request.Release.ReleaseDigest,
		ReasonCode: "release_installation_manager_unavailable"}, nil
}

func (unavailableReleaseInstaller) CommitReleaseInstallation(context.Context, market.CommitReleaseInstallationRequest) error {
	return errors.New("connector release installation is not registered")
}

func (unavailableReleaseInstaller) UninstallRelease(context.Context, market.UninstallReleaseRequest) error {
	return errors.New("connector release installation is not registered")
}

type unavailableRuntime struct{}

func (unavailableRuntime) Reconcile(context.Context, market.RuntimeReconcileRequest) (market.RuntimeReceipt, error) {
	return market.RuntimeReceipt{}, errors.New("connector implementation host is not registered")
}

func (unavailableRuntime) DeactivateRuntime(context.Context, market.RuntimeDeactivationRequest) error {
	return errors.New("connector runtime is not registered")
}

func (unavailableRuntime) FailClosed(context.Context, time.Time) error {
	return errors.New("connector runtime is not registered")
}

type unavailableAuthorization struct{}

func (unavailableAuthorization) Begin(context.Context, market.AuthorizationStartRequest) (market.AuthorizationSession, error) {
	return market.AuthorizationSession{}, errors.New("connector authorization is not registered")
}

func (unavailableAuthorization) Disconnect(context.Context, market.AuthorizationDisconnectRequest) error {
	return errors.New("connector authorization is not registered")
}

type rejectingCompatibility struct{}

func (rejectingCompatibility) Evaluate(market.Manifest) market.Compatibility {
	return market.Compatibility{
		State:  market.CompatibilityStateUnsupportedVersion,
		Reason: "connector_runtime_not_registered",
	}
}
