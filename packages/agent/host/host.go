package agenthost

import (
	"context"
	"time"
)

type Config struct {
	CanonicalStore       CanonicalStore
	SessionManagement    SessionManagementStore
	SessionPurge         SessionPurgeStore
	Runtime              RuntimeController
	RuntimePreparation   RuntimePreparationPort
	SettingsPolicy       SettingsPolicy
	Attachments          AttachmentMaterializer
	Clock                Clock
	SessionLocker        SessionLocker
	RuntimeStartGate     RuntimeStartGate
	LifecycleObserver    LifecycleObserver
	CommitObserver       CommitObserver
	RuntimeOperations    RuntimeOperationStore
	OperationEvents      RuntimeOperationEventPublisher
	OperationOwner       string
	Scheduler            Scheduler
	StaleTurnSettler     StaleTurnSettler
	WorktreeGC           WorktreeGarbageCollector
	GoalStore            GoalStateStore
	GoalRuntime          GoalRuntimeController
	GoalInbox            GoalReconcileInboxStore
	GoalOwner            string
	GoalClock            Clock
	GoalAttemptTimeout   time.Duration
	GoalRecoveryBudget   time.Duration
	GoalMaxAttempts      int
	GoalDispatchDeadline time.Duration
	GoalActor            *GoalActor
}

type Host struct {
	store                CanonicalStore
	sessionManagement    SessionManagementStore
	sessionPurge         SessionPurgeStore
	runtime              RuntimeController
	preparation          RuntimePreparationPort
	settingsPolicy       SettingsPolicy
	attachments          AttachmentMaterializer
	clock                Clock
	locker               SessionLocker
	startupGate          RuntimeStartGate
	observer             LifecycleObserver
	commitObserver       CommitObserver
	operations           RuntimeOperationStore
	events               RuntimeOperationEventPublisher
	owner                string
	scheduler            Scheduler
	staleTurns           StaleTurnSettler
	worktreeGC           WorktreeGarbageCollector
	goals                GoalStateStore
	goalRuntime          GoalRuntimeController
	goalInbox            GoalReconcileInboxStore
	goalOwner            string
	goalClock            Clock
	goalAttemptTimeout   time.Duration
	goalRecoveryBudget   time.Duration
	goalMaxAttempts      int
	goalDispatchDeadline time.Duration
	goalActor            *GoalActor
}

func New(config Config) *Host {
	goalActor := config.GoalActor
	if goalActor == nil {
		goalActor = NewGoalActor()
	}
	host := &Host{
		store: config.CanonicalStore, sessionManagement: config.SessionManagement, sessionPurge: config.SessionPurge, runtime: config.Runtime,
		preparation: config.RuntimePreparation, settingsPolicy: config.SettingsPolicy, attachments: config.Attachments,
		clock: config.Clock, locker: config.SessionLocker, startupGate: config.RuntimeStartGate,
		observer: config.LifecycleObserver, commitObserver: config.CommitObserver,
		operations: config.RuntimeOperations, events: config.OperationEvents,
		owner: config.OperationOwner, scheduler: config.Scheduler, staleTurns: config.StaleTurnSettler,
		worktreeGC: config.WorktreeGC,
		goals:      config.GoalStore, goalRuntime: config.GoalRuntime, goalInbox: config.GoalInbox,
		goalOwner: config.GoalOwner, goalClock: config.GoalClock,
		goalAttemptTimeout: config.GoalAttemptTimeout, goalRecoveryBudget: config.GoalRecoveryBudget,
		goalMaxAttempts: config.GoalMaxAttempts, goalDispatchDeadline: config.GoalDispatchDeadline,
		goalActor: goalActor,
	}
	if host.operations != nil && host.commitObserver != nil {
		host.operations = &observedRuntimeOperationStore{RuntimeOperationStore: host.operations, host: host}
	}
	if host.goals != nil && host.commitObserver != nil {
		host.goals = &observedGoalStateStore{GoalStateStore: host.goals, host: host}
	}
	return host
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
