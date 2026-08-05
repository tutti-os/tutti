package connectormarket

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
)

type HostConfig struct {
	Repository             market.Repository
	CatalogSource          market.CatalogSource
	ArtifactPreparer       market.ArtifactPreparer
	ImplementationHost     market.ImplementationHost
	Authorization          market.AuthorizationProvider
	Compatibility          market.CompatibilityEvaluator
	ImplementationRegistry market.ImplementationRegistry
	Outbox                 market.ChangedEventOutbox
	Publisher              ChangedEventPublisher
}

type Host struct {
	Application *market.Application

	cancel               context.CancelFunc
	scheduler            *OperationScheduler
	outboxDone           chan struct{}
	closeOnce            sync.Once
	bootstrapMu          sync.Mutex
	bootstrapped         bool
	refreshWorkerStarted bool
	repository           market.Repository
	implementationHost   market.ImplementationHost
	activationGate       *activationGateHost
	publicationGate      capabilityPublicationGate
}

type capabilityPublicationGate interface {
	SetCapabilityPublication(bool)
}

type runtimeProjectionFencer interface {
	FenceAll(context.Context, time.Time) error
}

type activationGateHost struct {
	delegate   market.ImplementationHost
	mu         sync.Mutex
	open       bool
	failClosed bool
	staged     map[string]market.WorkspaceReconcileRequest
}

func newActivationGateHost(delegate market.ImplementationHost) *activationGateHost {
	return &activationGateHost{delegate: delegate, staged: make(map[string]market.WorkspaceReconcileRequest)}
}

func (gate *activationGateHost) Reconcile(ctx context.Context, request market.WorkspaceReconcileRequest) (market.WorkspaceRuntimeReceipt, error) {
	key := request.WorkspaceID + "\x00" + request.Connector.Key
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
	return market.WorkspaceRuntimeReceipt{OperationID: request.OperationID, WorkspaceID: request.WorkspaceID,
		ConnectorKey: request.Connector.Key, ReleaseDigest: request.Connector.Release.ReleaseDigest, Generation: request.Generation}, nil
}

func (gate *activationGateHost) DeactivateWorkspace(ctx context.Context, request market.WorkspaceDeactivationRequest) error {
	gate.mu.Lock()
	delete(gate.staged, request.WorkspaceID+"\x00"+request.ConnectorKey)
	gate.mu.Unlock()
	return gate.delegate.DeactivateWorkspace(ctx, request)
}

func (gate *activationGateHost) FailClosed(ctx context.Context, deadline time.Time) error {
	gate.mu.Lock()
	gate.failClosed = true
	gate.staged = make(map[string]market.WorkspaceReconcileRequest)
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
		gate.staged = make(map[string]market.WorkspaceReconcileRequest)
	}
	gate.mu.Unlock()
}

func NewHost(parent context.Context, config HostConfig) (*Host, error) {
	if parent == nil {
		parent = context.Background()
	}
	if config.Outbox == nil || config.Publisher == nil {
		return nil, errors.New("connector market outbox and publisher are required")
	}
	hostContext, cancel := context.WithCancel(parent)
	scheduler := NewOperationScheduler(hostContext)
	activationGate := newActivationGateHost(config.ImplementationHost)
	application, err := market.NewApplication(market.ApplicationConfig{
		Repository:             config.Repository,
		CatalogSource:          config.CatalogSource,
		ArtifactPreparer:       config.ArtifactPreparer,
		Host:                   activationGate,
		Authorization:          config.Authorization,
		Compatibility:          config.Compatibility,
		Scheduler:              scheduler,
		ImplementationRegistry: config.ImplementationRegistry,
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
		repository:         config.Repository,
		implementationHost: config.ImplementationHost,
		activationGate:     activationGate,
	}
	if publicationGate, ok := config.ImplementationHost.(capabilityPublicationGate); ok {
		host.publicationGate = publicationGate
		publicationGate.SetCapabilityPublication(false)
	}
	dispatcher := OutboxDispatcher{Outbox: config.Outbox, Publisher: config.Publisher}
	go func() {
		defer close(host.outboxDone)
		dispatcher.Run(hostContext)
	}()
	return host, nil
}

// Bootstrap refreshes and accepts the current market catalog before any
// durable workspace intent is allowed to recreate MCP/CLI routes. Failed
// bootstrap attempts leave the connector host fenced and may be retried.
func (host *Host) Bootstrap(ctx context.Context) error {
	if host == nil || host.Application == nil {
		return errors.New("connector market host is unavailable")
	}
	host.bootstrapMu.Lock()
	defer host.bootstrapMu.Unlock()
	if host.bootstrapped && !host.activationGate.requiresRecovery() {
		return nil
	}
	host.bootstrapped = false
	if !host.refreshWorkerStarted {
		host.refreshWorkerStarted = true
		go host.runCatalogRefreshWorker()
	}
	host.activationGate.setOpen(false)
	if host.publicationGate != nil {
		host.publicationGate.SetCapabilityPublication(false)
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		host.activationGate.setOpen(false)
		if host.publicationGate != nil {
			host.publicationGate.SetCapabilityPublication(false)
		}
		fenceContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if fencer, ok := host.implementationHost.(runtimeProjectionFencer); ok {
			if err := fencer.FenceAll(fenceContext, time.Now().Add(10*time.Second)); err != nil {
				slog.Error("connector market bootstrap rollback runtime fence failed", "error", err)
			}
		}
		if err := host.Application.FenceDurableBindings(fenceContext); err != nil {
			slog.Error("connector market bootstrap rollback fence failed", "error", err)
		}
	}()
	// Fence any route left by an interrupted previous bootstrap before recovery
	// can replay host-touching operations. Reconcile calls remain staged behind
	// activationGate until a fresh market catalog has been accepted.
	if fencer, ok := host.implementationHost.(runtimeProjectionFencer); ok {
		if err := fencer.FenceAll(ctx, time.Now().Add(10*time.Second)); err != nil {
			return err
		}
	}
	if err := host.Application.FenceDurableBindings(ctx); err != nil {
		return err
	}
	if err := host.recoverAndWait(ctx); err != nil {
		return err
	}
	if err := host.refreshAndWait(ctx); err != nil {
		return err
	}
	host.activationGate.setOpen(true)
	if err := host.Application.ReconcileDurableBindings(ctx); err != nil {
		return err
	}
	if host.publicationGate != nil {
		host.publicationGate.SetCapabilityPublication(true)
	}
	host.activationGate.markRecovered()
	host.bootstrapped = true
	committed = true
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
	snapshot, err := host.Application.Snapshot(ctx, "")
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
	retry := time.Minute
	for {
		host.bootstrapMu.Lock()
		bootstrapped := host.bootstrapped
		host.bootstrapMu.Unlock()
		if !bootstrapped {
			timer := time.NewTimer(time.Second)
			select {
			case <-host.scheduler.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			bootstrapContext, cancel := context.WithTimeout(host.scheduler.ctx, 45*time.Second)
			err := host.Bootstrap(bootstrapContext)
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("connector market bootstrap retry failed", "error", err)
			}
			continue
		}
		wait := retry
		timer := time.NewTimer(wait)
		select {
		case <-host.scheduler.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		refreshContext, cancel := context.WithTimeout(host.scheduler.ctx, 45*time.Second)
		err := host.refreshAndWait(refreshContext)
		if err == nil {
			err = host.Application.ReconcileDurableBindings(refreshContext)
			if err == nil && host.activationGate.requiresRecovery() {
				if host.publicationGate != nil {
					host.publicationGate.SetCapabilityPublication(true)
				}
				host.activationGate.markRecovered()
			}
		}
		cancel()
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("connector market scheduled refresh failed", "error", err)
			if retry < 5*time.Minute {
				retry *= 2
			}
			continue
		}
		retry = time.Minute
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
		host.scheduler.Wait()
	})
}

// CatalogOnlyPorts deliberately advertise no installable implementation. The
// host can safely expose remote browsing before a concrete runtime activator,
// artifact resolver, and authorization provider are registered.
func CatalogOnlyPorts() (
	market.ArtifactPreparer,
	market.ImplementationHost,
	market.AuthorizationProvider,
	market.CompatibilityEvaluator,
	market.ImplementationRegistry,
) {
	return unavailableArtifactPreparer{}, unavailableRuntime{}, unavailableAuthorization{},
		rejectingCompatibility{}, market.NewImplementationRegistry(nil)
}

type unavailableArtifactPreparer struct{}

func (unavailableArtifactPreparer) Prepare(context.Context, market.PrepareArtifactRequest) (market.PreparedArtifactReceipt, error) {
	return market.PreparedArtifactReceipt{}, errors.New("connector artifact preparation is not registered")
}

func (unavailableArtifactPreparer) Remove(context.Context, market.RemoveArtifactRequest) error {
	return errors.New("connector artifact preparation is not registered")
}

type unavailableRuntime struct{}

func (unavailableRuntime) Reconcile(context.Context, market.WorkspaceReconcileRequest) (market.WorkspaceRuntimeReceipt, error) {
	return market.WorkspaceRuntimeReceipt{}, errors.New("connector implementation host is not registered")
}

func (unavailableRuntime) DeactivateWorkspace(context.Context, market.WorkspaceDeactivationRequest) error {
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
