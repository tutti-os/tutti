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
}

func New(config Config) *Host {
	return &Host{
		store: config.CanonicalStore, runtime: config.Runtime,
		preparation: config.RuntimePreparation, attachments: config.Attachments,
		clock: config.Clock, locker: config.SessionLocker, startupGate: config.RuntimeStartGate,
		observer: config.LifecycleObserver,
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
