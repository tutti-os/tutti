package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	market "github.com/tutti-os/tutti/packages/connector/host"
)

type HostConfig struct {
	Repository               market.Repository
	CatalogSource            market.CatalogSource
	ReleaseInstallations     market.ReleaseInstallationManager
	InstallationChecker      market.InstallationChecker
	ImplementationHost       market.ImplementationHost
	Authorization            market.AuthorizationProvider
	AuthorizationProjections market.AuthorizationProjectionStore
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

	cancel               context.CancelFunc
	scheduler            *OperationScheduler
	outboxDone           chan struct{}
	lifecycleDone        chan struct{}
	closeOnce            sync.Once
	bootstrapMu          sync.Mutex
	bootstrapped         bool
	bootstrapScope       market.OperationScope
	refreshWorkerStarted bool
	repository           market.Repository
	implementationHost   market.ImplementationHost
	activationGate       *activationGateHost
	publicationGate      capabilityPublicationGate
	publication          CapabilityPublicationController
}

type capabilityPublicationGate interface {
	SetCapabilityPublication(bool)
}

type activationGateHost struct {
	delegate   market.ImplementationHost
	mu         sync.Mutex
	open       bool
	failClosed bool
	staged     map[string]market.RuntimeReconcileRequest
}

func newActivationGateHost(delegate market.ImplementationHost) *activationGateHost {
	return &activationGateHost{delegate: delegate, staged: make(map[string]market.RuntimeReconcileRequest)}
}

func (gate *activationGateHost) Reconcile(ctx context.Context, request market.RuntimeReconcileRequest) (market.RuntimeReceipt, error) {
	key := request.ConnectionID + "\x00" + request.Connector.Key
	gate.mu.Lock()
	if !request.Enabled {
		delete(gate.staged, key)
		gate.mu.Unlock()
		return gate.delegate.Reconcile(ctx, request)
	}
	if gate.open {
		gate.mu.Unlock()
		return gate.delegate.Reconcile(ctx, request)
	}
	current, exists := gate.staged[key]
	if !exists || current.Generation.BootEpoch != request.Generation.BootEpoch || request.Generation.Generation >= current.Generation.Generation {
		gate.staged[key] = request
	}
	gate.mu.Unlock()
	return market.RuntimeReceipt{OperationID: request.OperationID, ConnectionID: request.ConnectionID,
		ConnectorKey: request.Connector.Key, ReleaseDigest: request.Connector.Release.ReleaseDigest, Generation: request.Generation}, nil
}

func (gate *activationGateHost) DeactivateRuntime(ctx context.Context, request market.RuntimeDeactivationRequest) error {
	gate.mu.Lock()
	delete(gate.staged, request.ConnectionID+"\x00"+request.ConnectorKey)
	gate.mu.Unlock()
	return gate.delegate.DeactivateRuntime(ctx, request)
}

func (gate *activationGateHost) FailClosed(ctx context.Context, deadline time.Time) error {
	gate.mu.Lock()
	gate.failClosed = true
	gate.staged = make(map[string]market.RuntimeReconcileRequest)
	gate.mu.Unlock()
	return gate.delegate.FailClosed(ctx, deadline)
}

func (gate *activationGateHost) requiresRecovery() bool {
	gate.mu.Lock()
	defer gate.mu.Unlock()
	return gate.failClosed
}

func (gate *activationGateHost) markRecovered() {
	gate.mu.Lock()
	gate.failClosed = false
	gate.mu.Unlock()
}

func (gate *activationGateHost) setOpen(open bool) {
	gate.mu.Lock()
	gate.open = open
	if !open {
		gate.staged = make(map[string]market.RuntimeReconcileRequest)
	}
	gate.mu.Unlock()
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
	installationChecker := config.InstallationChecker
	if installationChecker == nil {
		installationChecker, _ = config.ImplementationHost.(market.InstallationChecker)
	}
	application, err := market.NewApplication(market.ApplicationConfig{
		Repository:               config.Repository,
		CatalogSource:            config.CatalogSource,
		ReleaseInstallations:     config.ReleaseInstallations,
		InstallationChecker:      installationChecker,
		Host:                     activationGate,
		Authorization:            config.Authorization,
		AuthorizationProjections: config.AuthorizationProjections,
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
		Application:        application,
		cancel:             cancel,
		scheduler:          scheduler,
		outboxDone:         make(chan struct{}),
		lifecycleDone:      make(chan struct{}),
		repository:         config.Repository,
		implementationHost: config.ImplementationHost,
		activationGate:     activationGate,
		publication:        config.Publication,
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
	if _, ok := config.Authorization.(market.AuthorizationObserver); ok {
		go host.runAuthorizationReconcileWorker(hostContext)
	}
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
			err := host.Application.ReconcileAuthorizations(reconcileContext)
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("connector authorization reconciliation failed", "error", err)
			}
		}
	}
}

// Bootstrap restores durable local runtime intent without depending on the
// remote catalog. Catalog refresh has its own retry loop: a network, auth, or
// presentation-policy failure must never keep installed MCP/CLI routes fenced.
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
		return nil
	}
	host.bootstrapScope = scope
	host.bootstrapped = false
	if !host.refreshWorkerStarted {
		host.refreshWorkerStarted = true
		go host.runCatalogRefreshWorker()
	}
	host.activationGate.setOpen(false)
	if err := host.applyCapabilityPublication(ctx, scope, false); err != nil {
		return err
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		host.activationGate.setOpen(false)
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
	host.activationGate.setOpen(true)
	if err := host.Application.ReconcileInstalledRuntimesForScope(ctx, scope); err != nil {
		return err
	}
	if err := host.applyCapabilityPublication(ctx, scope, true); err != nil {
		return err
	}
	host.activationGate.markRecovered()
	host.bootstrapped = true
	committed = true
	return nil
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
	host.activationGate.setOpen(false)
	host.bootstrapped = false
	host.bootstrapScope = scope
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
	snapshot, err := host.Application.Snapshot(ctx)
	if err != nil {
		return err
	}
	result, err := host.Application.ReconcileRuntime(ctx, market.ConnectorMutation{
		Mutation:     market.Mutation{ClientRequestID: "daemon-runtime-drift/" + uuid.NewString(), ExpectedRevision: snapshot.Revision},
		ConnectorKey: connectorKey, AccountID: scope.AccountID,
	})
	if err != nil {
		return err
	}
	return host.waitForOperation(ctx, result.Operation.OperationID, "runtime reconcile")
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
	snapshot, err := host.Application.Snapshot(ctx)
	if err != nil {
		return err
	}
	result, err := host.Application.ObserveAuthorization(ctx, market.ConnectorMutation{
		Mutation:     market.Mutation{ClientRequestID: "daemon-authorization-observation/" + uuid.NewString(), ExpectedRevision: snapshot.Revision},
		ConnectorKey: projection.ConnectorKey, AccountID: scope.AccountID,
	}, projection)
	if err != nil {
		return err
	}
	return host.waitForOperation(ctx, result.Operation.OperationID, "authorization reconcile")
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

func (host *Host) waitForOperation(ctx context.Context, operationID, label string) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		operation, err := host.Application.GetOperation(ctx, operationID)
		if err != nil {
			return err
		}
		switch operation.State {
		case market.OperationStateCompleted:
			return nil
		case market.OperationStateFailed:
			return fmt.Errorf("connector market %s failed: %s", label, operation.FailureCode)
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
