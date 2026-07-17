package agenthost

import (
	"context"
	"time"
)

type Config struct {
	CanonicalStore     CanonicalStore
	Runtime            RuntimeController
	RuntimePreparation RuntimePreparationPort
	Attachments        AttachmentMaterializer
	Clock              Clock
	SessionLocker      SessionLocker
	RuntimeStartGate   RuntimeStartGate
	LifecycleObserver  LifecycleObserver
	RuntimeOperations  RuntimeOperationStore
	OperationEvents    RuntimeOperationEventPublisher
	OperationOwner     string
	Scheduler          Scheduler
	StartupRecovery    StartupRecoveryPort
	StaleTurnSettler   StaleTurnSettler
}

type Host struct {
	store       CanonicalStore
	runtime     RuntimeController
	preparation RuntimePreparationPort
	attachments AttachmentMaterializer
	clock       Clock
	locker      SessionLocker
	startupGate RuntimeStartGate
	observer    LifecycleObserver
	operations  RuntimeOperationStore
	events      RuntimeOperationEventPublisher
	owner       string
	scheduler   Scheduler
	recovery    StartupRecoveryPort
	staleTurns  StaleTurnSettler
}

func New(config Config) *Host {
	return &Host{
		store: config.CanonicalStore, runtime: config.Runtime,
		preparation: config.RuntimePreparation, attachments: config.Attachments,
		clock: config.Clock, locker: config.SessionLocker, startupGate: config.RuntimeStartGate,
		observer:   config.LifecycleObserver,
		operations: config.RuntimeOperations, events: config.OperationEvents,
		owner: config.OperationOwner, scheduler: config.Scheduler,
		recovery: config.StartupRecovery, staleTurns: config.StaleTurnSettler,
	}
}

func (h *Host) observeStep(ctx context.Context, flow, name, sessionID, provider string, startedAt time.Time, err error) {
	if h != nil && h.observer != nil {
		h.observer.ObserveLifecycleStep(ctx, LifecycleStep{
			Flow: flow, Name: name, AgentSessionID: sessionID, Provider: provider, StartedAt: startedAt, Err: err,
		})
	}
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

func (h *Host) now() time.Time {
	if h != nil && h.clock != nil {
		return h.clock.Now()
	}
	return systemClock{}.Now()
}
