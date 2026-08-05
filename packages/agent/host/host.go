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

	// EditRetryDisabled neutralizes the durable edit-and-retry feature (PR
	// #1681). When set, new edit-retry operations are refused and any operation
	// left over from before it was disabled is quarantined during recovery
	// instead of engaging the saga. The zero value keeps the feature enabled so
	// its unit/conformance tests still exercise it; production wiring sets this
	// true. Remove once the saga's resend/recovery gap is fixed.
	EditRetryDisabled       bool
	SideConversationRuntime SideConversationRuntime
}

type Host struct {
	store                  CanonicalStore
	interactionTrees       CanonicalInteractionTreeStore
	turnSubmissions        TurnSubmissionStore
	effectiveHistory       EffectiveHistoryStore
	sessionManagement      SessionManagementStore
	sessionBatchManagement SessionBatchManagementStore
	sessionDeletionGuard   SessionDeletionGuard
	sessionPurge           SessionPurgeStore
	historicalState        HistoricalSessionStateStore
	sessionForks           SessionForkStore
	sessionForkRecovery    SessionForkRecoveryStore
	sessionForkRuntime     SessionForkRuntime
	sideRuntime            SideConversationRuntime
	sessionForkContext     SessionForkContextPolicy
	sessionForkState       SessionForkProviderStateBinder
	sessionForkAttachments SessionForkAttachmentStager
	runtime                RuntimeController
	historyRuntime         RuntimeHistoryController
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
	editRetryDisabled      bool
	goalFencesRestored     sync.Map
	sideMu                 sync.Mutex
	sideConversations      map[string]sideConversationRegistration
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
		sideRuntime:        config.SideConversationRuntime,
		sessionForkContext: config.SessionForkContext, sessionForkState: config.SessionForkState,
		sessionForkAttachments: config.SessionForkAttachments,
		runtime:                config.Runtime,
		historyRuntime:         config.HistoryRuntime,
		sessionForkRecovery:    config.SessionForkRecovery,
		preparation:            config.RuntimePreparation, settingsPolicy: config.SettingsPolicy, attachments: config.Attachments,
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
		editRetryDisabled: config.EditRetryDisabled,
		sideConversations: make(map[string]sideConversationRegistration),
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
