package agenthost

import (
	"context"
	"strings"
	"sync"
	"time"
)

type Config struct {
	CanonicalStore          CanonicalStore
	InteractionTrees        CanonicalInteractionTreeStore
	TurnSubmissions         TurnSubmissionStore
	EffectiveHistory        EffectiveHistoryStore
	SessionManagement       SessionManagementStore
	SessionBatchManagement  SessionBatchManagementStore
	SessionDeletionGuard    SessionDeletionGuard
	SessionPurge            SessionPurgeStore
	DeletedSessions         DeletedSessionStore
	HistoricalState         HistoricalSessionStateStore
	SessionForks            SessionForkStore
	SessionForkRecovery     SessionForkRecoveryStore
	SessionForkRuntime      SessionForkRuntime
	SessionForkContext      SessionForkContextPolicy
	SessionForkState        SessionForkProviderStateBinder
	SessionForkAttachments  SessionForkAttachmentStager
	Runtime                 RuntimeController
	HistoryRuntime          RuntimeHistoryController
	RuntimePreparation      RuntimePreparationPort
	SettingsPolicy          SettingsPolicy
	Attachments             AttachmentMaterializer
	Clock                   Clock
	SessionLocker           SessionLocker
	RuntimeStartGate        RuntimeStartGate
	LifecycleObserver       LifecycleObserver
	TerminalFailureObserver TerminalFailureObserver
	CommitObserver          CommitObserver
	RuntimeOperations       RuntimeOperationStore
	OperationEvents         RuntimeOperationEventPublisher
	OperationOwner          string
	Scheduler               Scheduler
	StaleTurnSettler        StaleTurnSettler
	GoalStore               GoalStateStore
	GoalFences              GoalGenerationFenceStore
	GoalRuntime             GoalRuntimeController
	GoalInbox               GoalReconcileInboxStore
	GoalOwner               string
	GoalClock               Clock
	GoalAttemptTimeout      time.Duration
	GoalRecoveryBudget      time.Duration
	GoalMaxAttempts         int
	GoalDispatchDeadline    time.Duration
	GoalActor               *SessionActor
	SessionMutationActor    *SessionActor

	// EditRetryDisabled neutralizes the durable edit-and-retry feature (PR
	// #1681). When set, new edit-retry operations are refused and any operation
	// left over from before it was disabled is quarantined during recovery
	// instead of engaging the saga. The zero value keeps the feature enabled so
	// its unit/conformance tests still exercise it; production wiring sets this
	// true. Remove once the saga's resend/recovery gap is fixed.
	EditRetryDisabled bool
}

type Host struct {
	store                     CanonicalStore
	interactionTrees          CanonicalInteractionTreeStore
	turnSubmissions           TurnSubmissionStore
	effectiveHistory          EffectiveHistoryStore
	sessionManagement         SessionManagementStore
	sessionBatchManagement    SessionBatchManagementStore
	sessionDeletionGuard      SessionDeletionGuard
	sessionPurge              SessionPurgeStore
	deletedSessions           DeletedSessionStore
	historicalState           HistoricalSessionStateStore
	sessionForks              SessionForkStore
	sessionForkRecovery       SessionForkRecoveryStore
	sessionForkRuntime        SessionForkRuntime
	sessionForkContext        SessionForkContextPolicy
	sessionForkState          SessionForkProviderStateBinder
	sessionForkAttachments    SessionForkAttachmentStager
	runtime                   RuntimeController
	historyRuntime            RuntimeHistoryController
	preparation               RuntimePreparationPort
	settingsPolicy            SettingsPolicy
	attachments               AttachmentMaterializer
	clock                     Clock
	locker                    SessionLocker
	startupGate               RuntimeStartGate
	observer                  LifecycleObserver
	terminalFailure           TerminalFailureObserver
	commitObserver            CommitObserver
	operations                RuntimeOperationStore
	events                    RuntimeOperationEventPublisher
	owner                     string
	scheduler                 Scheduler
	staleTurns                StaleTurnSettler
	goals                     GoalStateStore
	goalFences                GoalGenerationFenceStore
	goalRuntime               GoalRuntimeController
	goalInbox                 GoalReconcileInboxStore
	goalOwner                 string
	goalClock                 Clock
	goalAttemptTimeout        time.Duration
	goalRecoveryBudget        time.Duration
	goalMaxAttempts           int
	goalDispatchDeadline      time.Duration
	goalActor                 *SessionActor
	sessionMutationActor      *SessionActor
	workspaceRuntimeAdmission *workspaceRuntimeAdmission
	editRetryDisabled         bool
	goalFencesRestored        sync.Map
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
		deletedSessions: config.DeletedSessions,
		sessionForks:    config.SessionForks, sessionForkRuntime: config.SessionForkRuntime,
		historicalState:    config.HistoricalState,
		sessionForkContext: config.SessionForkContext, sessionForkState: config.SessionForkState,
		sessionForkAttachments: config.SessionForkAttachments,
		runtime:                config.Runtime,
		historyRuntime:         config.HistoryRuntime,
		sessionForkRecovery:    config.SessionForkRecovery,
		preparation:            config.RuntimePreparation, settingsPolicy: config.SettingsPolicy, attachments: config.Attachments,
		clock: config.Clock, locker: config.SessionLocker, startupGate: config.RuntimeStartGate,
		observer: config.LifecycleObserver, terminalFailure: config.TerminalFailureObserver,
		commitObserver: config.CommitObserver,
		operations:     config.RuntimeOperations, events: config.OperationEvents,
		owner: config.OperationOwner, scheduler: config.Scheduler, staleTurns: config.StaleTurnSettler,
		goals: config.GoalStore, goalFences: config.GoalFences, goalRuntime: config.GoalRuntime, goalInbox: config.GoalInbox,
		goalOwner: config.GoalOwner, goalClock: config.GoalClock,
		goalAttemptTimeout: config.GoalAttemptTimeout, goalRecoveryBudget: config.GoalRecoveryBudget,
		goalMaxAttempts: config.GoalMaxAttempts, goalDispatchDeadline: config.GoalDispatchDeadline,
		goalActor: goalActor, sessionMutationActor: sessionMutationActor,
		workspaceRuntimeAdmission: newWorkspaceRuntimeAdmission(),
		editRetryDisabled:         config.EditRetryDisabled,
	}
	if host.interactionTrees == nil {
		host.interactionTrees, _ = host.store.(CanonicalInteractionTreeStore)
	}
	if host.deletedSessions == nil {
		host.deletedSessions, _ = config.SessionBatchManagement.(DeletedSessionStore)
	}
	if host.sessionForkRecovery == nil {
		host.sessionForkRecovery, _ = host.sessionForks.(SessionForkRecoveryStore)
	}
	// Durable runtime and goal failures reach TerminalFailureObserver through
	// the same wrappers, so an adapter that wires only failure analytics still
	// observes them.
	observesCommits := host.commitObserver != nil || host.terminalFailure != nil
	if host.operations != nil && observesCommits {
		host.operations = &observedRuntimeOperationStore{RuntimeOperationStore: host.operations, host: host}
	}
	if host.effectiveHistory != nil && observesCommits {
		host.effectiveHistory = &observedEffectiveHistoryStore{
			EffectiveHistoryStore: host.effectiveHistory,
			host:                  host,
		}
	}
	if host.goals != nil && observesCommits {
		host.goals = &observedGoalStateStore{GoalStateStore: host.goals, host: host}
	}
	if registrar, ok := config.GoalRuntime.(GoalRuntimeControlLifecycleRegistrar); ok {
		registrar.SetGoalControlAppliedSink(host.ObserveRuntimeGoalControlApplied)
	}
	return host
}

// observeStep reports a diagnostic lifecycle step. A failed step never emits a
// TerminalFailure on its own; it only names the stage that the enclosing
// command reports once at its boundary.
func (h *Host) observeStep(ctx context.Context, flow, name, workspaceID, sessionID, provider string, startedAt time.Time, err error) {
	if h != nil && h.observer != nil {
		h.observer.ObserveLifecycleStep(ctx, LifecycleStep{
			Flow: flow, Name: name, AgentSessionID: sessionID, Provider: provider, StartedAt: startedAt, Err: err,
		})
	}
	recordCommandFailureStage(ctx, flow, workspaceID, sessionID, provider, name, err)
}

func (h *Host) observeGuidanceTargetFailure(
	ctx context.Context,
	ref SessionRef,
	provider, turnID, clientSubmitID string,
	startedAt time.Time,
	err error,
) {
	if err == nil {
		return
	}
	if h != nil && h.observer != nil {
		h.observer.ObserveLifecycleStep(ctx, LifecycleStep{
			Flow: "guidance", Name: "guidance_target", AgentSessionID: ref.AgentSessionID,
			Provider: provider, StartedAt: startedAt, Err: err,
		})
	}
	h.observeTerminalFailure(ctx, TerminalFailure{
		Flow:           "guidance",
		FailureStage:   "guidance_target",
		WorkspaceID:    ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID,
		TurnID:         strings.TrimSpace(turnID),
		ClientSubmitID: strings.TrimSpace(clientSubmitID),
		Provider:       provider,
		ErrorCode:      guidanceTargetFailureCode(err),
		ErrorMessage:   err.Error(),
		Retryable:      false,
	})
}

func (h *Host) observeTerminalFailure(ctx context.Context, failure TerminalFailure) {
	if h == nil || h.terminalFailure == nil {
		return
	}
	if h.store != nil && strings.TrimSpace(failure.WorkspaceID) != "" && strings.TrimSpace(failure.AgentSessionID) != "" {
		if session, found, err := h.store.GetSession(ctx, failure.WorkspaceID, failure.AgentSessionID); err == nil && found {
			if strings.TrimSpace(failure.Provider) == "" {
				failure.Provider = strings.TrimSpace(session.Provider)
			}
			failure.IsChildSession = failure.IsChildSession || canonicalSessionIsChild(session)
		}
	}
	if failure.ErrorMessage == "" && failure.ErrorCode == "" {
		return
	}
	// A specific emission owns the incident; the enclosing command boundary
	// must not report the same failure a second time.
	markCommandTerminalFailureEmitted(ctx)
	h.terminalFailure.ObserveTerminalFailure(ctx, failure)
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

func (h *Host) now() time.Time {
	if h != nil && h.clock != nil {
		return h.clock.Now()
	}
	return systemClock{}.Now()
}
