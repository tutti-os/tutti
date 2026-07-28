package agenthost

import (
	"context"
	"sync"
	"time"
)

type Config struct {
	CanonicalStore         CanonicalStore
	SessionManagement      SessionManagementStore
	SessionBatchManagement SessionBatchManagementStore
	SessionPurge           SessionPurgeStore
	SessionForks           SessionForkStore
	SessionForkRecovery    SessionForkRecoveryStore
	SessionForkRuntime     SessionForkRuntime
	SessionForkContext     SessionForkContextPolicy
	SessionForkState       SessionForkProviderStateBinder
	Runtime                RuntimeController
	RuntimePreparation     RuntimePreparationPort
	SettingsPolicy         SettingsPolicy
	Attachments            AttachmentMaterializer
	Clock                  Clock
	SessionLocker          SessionLocker
	RuntimeStartGate       RuntimeStartGate
	LifecycleObserver      LifecycleObserver
	CommitObserver         CommitObserver
	RuntimeOperations      RuntimeOperationStore
	OperationEvents        RuntimeOperationEventPublisher
	OperationOwner         string
	Scheduler              Scheduler
	StaleTurnSettler       StaleTurnSettler
	WorktreeGC             WorktreeGarbageCollector
	GoalStore              GoalStateStore
	GoalFences             GoalGenerationFenceStore
	GoalRuntime            GoalRuntimeController
	GoalInbox              GoalReconcileInboxStore
	GoalOwner              string
	GoalClock              Clock
	GoalAttemptTimeout     time.Duration
	GoalRecoveryBudget     time.Duration
	GoalMaxAttempts        int
	GoalDispatchDeadline   time.Duration
	GoalActor              *SessionActor
	SessionMutationActor   *SessionActor
}

type Host struct {
	store                  CanonicalStore
	sessionManagement      SessionManagementStore
	sessionBatchManagement SessionBatchManagementStore
	sessionPurge           SessionPurgeStore
	sessionForks           SessionForkStore
	sessionForkRecovery    SessionForkRecoveryStore
	sessionForkRuntime     SessionForkRuntime
	sessionForkContext     SessionForkContextPolicy
	sessionForkState       SessionForkProviderStateBinder
	runtime                RuntimeController
	preparation            RuntimePreparationPort
	settingsPolicy         SettingsPolicy
	attachments            AttachmentMaterializer
	clock                  Clock
	locker                 SessionLocker
	startupGate            RuntimeStartGate
	observer               LifecycleObserver
	commitObserver         CommitObserver
	operations             RuntimeOperationStore
	events                 RuntimeOperationEventPublisher
	owner                  string
	scheduler              Scheduler
	staleTurns             StaleTurnSettler
	worktreeGC             WorktreeGarbageCollector
	goals                  GoalStateStore
	goalFences             GoalGenerationFenceStore
	goalRuntime            GoalRuntimeController
	goalInbox              GoalReconcileInboxStore
	goalOwner              string
	goalClock              Clock
	goalAttemptTimeout     time.Duration
	goalRecoveryBudget     time.Duration
	goalMaxAttempts        int
	goalDispatchDeadline   time.Duration
	goalActor              *SessionActor
	sessionMutationActor   *SessionActor
	goalFencesRestored     sync.Map
}

func New(config Config) *Host {
	goalActor := config.GoalActor
	if goalActor == nil {
		goalActor = NewSessionActor()
	}
	sessionMutationActor := config.SessionMutationActor
	if sessionMutationActor == nil {
		sessionMutationActor = NewSessionActor()
	}
	host := &Host{
		store: config.CanonicalStore, sessionManagement: config.SessionManagement, sessionBatchManagement: config.SessionBatchManagement, sessionPurge: config.SessionPurge,
		sessionForks: config.SessionForks, sessionForkRuntime: config.SessionForkRuntime,
		sessionForkContext: config.SessionForkContext, sessionForkState: config.SessionForkState,
		runtime:             config.Runtime,
		sessionForkRecovery: config.SessionForkRecovery,
		preparation:         config.RuntimePreparation, settingsPolicy: config.SettingsPolicy, attachments: config.Attachments,
		clock: config.Clock, locker: config.SessionLocker, startupGate: config.RuntimeStartGate,
		observer: config.LifecycleObserver, commitObserver: config.CommitObserver,
		operations: config.RuntimeOperations, events: config.OperationEvents,
		owner: config.OperationOwner, scheduler: config.Scheduler, staleTurns: config.StaleTurnSettler,
		worktreeGC: config.WorktreeGC,
		goals:      config.GoalStore, goalFences: config.GoalFences, goalRuntime: config.GoalRuntime, goalInbox: config.GoalInbox,
		goalOwner: config.GoalOwner, goalClock: config.GoalClock,
		goalAttemptTimeout: config.GoalAttemptTimeout, goalRecoveryBudget: config.GoalRecoveryBudget,
		goalMaxAttempts: config.GoalMaxAttempts, goalDispatchDeadline: config.GoalDispatchDeadline,
		goalActor: goalActor, sessionMutationActor: sessionMutationActor,
	}
	if host.sessionForkRecovery == nil {
		host.sessionForkRecovery, _ = host.sessionForks.(SessionForkRecoveryStore)
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
