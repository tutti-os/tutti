package agenthost

import (
	"context"
	"sync"
	"time"
)

type Config struct {
	CanonicalStore         CanonicalStore
	InteractionTrees       CanonicalInteractionTreeStore
	TurnSubmissions        TurnSubmissionStore
	EffectiveHistory       EffectiveHistoryStore
	SessionManagement      SessionManagementStore
	SessionBatchManagement SessionBatchManagementStore
	SessionDeletionGuard   SessionDeletionGuard
	SessionPurge           SessionPurgeStore
	HistoricalState        HistoricalSessionStateStore
	SessionForks           SessionForkStore
	SessionForkRecovery    SessionForkRecoveryStore
	SessionForkRuntime     SessionForkRuntime
	SessionForkContext     SessionForkContextPolicy
	SessionForkState       SessionForkProviderStateBinder
	SessionForkAttachments SessionForkAttachmentStager
	Runtime                RuntimeController
	HistoryRuntime         RuntimeHistoryController
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

	RuntimeOperationHealth  RuntimeOperationHealthStore
	EditRetryAttemptTimeout time.Duration
	EditRetryMaxConcurrent  int
	EditRetryAdmission      EditRetryAdmissionPolicy
	EditRetryRecovery       EditRetryRecoveryPolicy
}

type Host struct {
	store                       CanonicalStore
	interactionTrees            CanonicalInteractionTreeStore
	turnSubmissions             TurnSubmissionStore
	effectiveHistory            EffectiveHistoryStore
	sessionManagement           SessionManagementStore
	sessionBatchManagement      SessionBatchManagementStore
	sessionDeletionGuard        SessionDeletionGuard
	sessionPurge                SessionPurgeStore
	historicalState             HistoricalSessionStateStore
	sessionForks                SessionForkStore
	sessionForkRecovery         SessionForkRecoveryStore
	sessionForkRuntime          SessionForkRuntime
	sessionForkContext          SessionForkContextPolicy
	sessionForkState            SessionForkProviderStateBinder
	sessionForkAttachments      SessionForkAttachmentStager
	runtime                     RuntimeController
	historyRuntime              RuntimeHistoryController
	preparation                 RuntimePreparationPort
	settingsPolicy              SettingsPolicy
	attachments                 AttachmentMaterializer
	clock                       Clock
	locker                      SessionLocker
	startupGate                 RuntimeStartGate
	observer                    LifecycleObserver
	commitObserver              CommitObserver
	operations                  RuntimeOperationStore
	events                      RuntimeOperationEventPublisher
	owner                       string
	scheduler                   Scheduler
	staleTurns                  StaleTurnSettler
	worktreeGC                  WorktreeGarbageCollector
	goals                       GoalStateStore
	goalFences                  GoalGenerationFenceStore
	goalRuntime                 GoalRuntimeController
	goalInbox                   GoalReconcileInboxStore
	goalOwner                   string
	goalClock                   Clock
	goalAttemptTimeout          time.Duration
	goalRecoveryBudget          time.Duration
	goalMaxAttempts             int
	goalDispatchDeadline        time.Duration
	goalActor                   *SessionActor
	sessionMutationActor        *SessionActor
	runtimeOperationHealthStore RuntimeOperationHealthStore
	editRetryAttemptTimeout     time.Duration
	editRetryExecutor           *editRetryExecutor
	editRetryAdmission          EditRetryAdmissionPolicy
	editRetryRecovery           EditRetryRecoveryPolicy
	runtimeOperationHealth      runtimeOperationWorkerHealth
	outboxMu                    sync.Mutex
	goalFencesRestored          sync.Map
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
		store: config.CanonicalStore, interactionTrees: config.InteractionTrees,
		turnSubmissions: config.TurnSubmissions, effectiveHistory: config.EffectiveHistory,
		sessionManagement: config.SessionManagement, sessionBatchManagement: config.SessionBatchManagement, sessionDeletionGuard: config.SessionDeletionGuard, sessionPurge: config.SessionPurge,
		sessionForks: config.SessionForks, sessionForkRuntime: config.SessionForkRuntime,
		historicalState:    config.HistoricalState,
		sessionForkContext: config.SessionForkContext, sessionForkState: config.SessionForkState,
		sessionForkAttachments: config.SessionForkAttachments,
		runtime:                config.Runtime,
		historyRuntime:         config.HistoryRuntime,
		sessionForkRecovery:    config.SessionForkRecovery,
		preparation:            config.RuntimePreparation, settingsPolicy: config.SettingsPolicy, attachments: config.Attachments,
		clock: config.Clock, locker: config.SessionLocker, startupGate: config.RuntimeStartGate,
		observer: config.LifecycleObserver, commitObserver: config.CommitObserver,
		operations: config.RuntimeOperations, runtimeOperationHealthStore: config.RuntimeOperationHealth, events: config.OperationEvents,
		owner: config.OperationOwner, scheduler: config.Scheduler, staleTurns: config.StaleTurnSettler,
		worktreeGC: config.WorktreeGC,
		goals:      config.GoalStore, goalFences: config.GoalFences, goalRuntime: config.GoalRuntime, goalInbox: config.GoalInbox,
		goalOwner: config.GoalOwner, goalClock: config.GoalClock,
		goalAttemptTimeout: config.GoalAttemptTimeout, goalRecoveryBudget: config.GoalRecoveryBudget,
		goalMaxAttempts: config.GoalMaxAttempts, goalDispatchDeadline: config.GoalDispatchDeadline,
		goalActor: goalActor, sessionMutationActor: sessionMutationActor,
		editRetryAttemptTimeout: editRetryAttemptTimeout(config.EditRetryAttemptTimeout),
		editRetryExecutor:       newEditRetryExecutor(config.EditRetryMaxConcurrent),
		editRetryAdmission:      config.EditRetryAdmission, editRetryRecovery: config.EditRetryRecovery,
	}
	if host.interactionTrees == nil {
		host.interactionTrees, _ = host.store.(CanonicalInteractionTreeStore)
	}
	if host.sessionForkRecovery == nil {
		host.sessionForkRecovery, _ = host.sessionForks.(SessionForkRecoveryStore)
	}
	if host.operations != nil && host.commitObserver != nil {
		host.operations = &observedRuntimeOperationStore{RuntimeOperationStore: host.operations, host: host}
	}
	if host.effectiveHistory != nil && host.commitObserver != nil {
		host.effectiveHistory = &observedEffectiveHistoryStore{
			EffectiveHistoryStore: host.effectiveHistory,
			host:                  host,
		}
	}
	if host.goals != nil && host.commitObserver != nil {
		host.goals = &observedGoalStateStore{GoalStateStore: host.goals, host: host}
	}
	if registrar, ok := config.GoalRuntime.(GoalRuntimeControlLifecycleRegistrar); ok {
		registrar.SetGoalControlAppliedSink(host.ObserveRuntimeGoalControlApplied)
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
