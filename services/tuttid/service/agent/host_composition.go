package agent

import (
	"sync"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

type ApplicationHostRuntime interface {
	agenthost.RuntimeController
	agenthost.RuntimeHistoryController
	agenthost.GoalRuntimeController
}

// ApplicationHostCanonicalPorts groups the shared canonical store roles that
// must advance together in production.
type ApplicationHostCanonicalPorts interface {
	agenthost.CanonicalStore
	agenthost.SessionManagementStore
	agenthost.SessionBatchManagementStore
	agenthost.TurnSubmissionStore
	agenthost.EffectiveHistoryStore
	committedSessionForkReader
}

// HostSupportPorts contains only the adapter-owned capabilities Host consumes.
// It is complete before Host construction and intentionally has no Service
// field, so Host cannot become a reverse container for the tuttid facade.
type HostSupportPorts struct {
	// DeletedSessions wraps the canonical lifecycle store so tuttid-owned
	// sidecars survive restore, participate in the same purge transaction, and
	// publish restored canonical commits through the product projection.
	DeletedSessions        agenthost.DeletedSessionStore
	SessionPurge           agenthost.SessionPurgeStore
	SessionDeletionGuard   agenthost.SessionDeletionGuard
	SessionForkContext     agenthost.SessionForkContextPolicy
	SessionForkState       agenthost.SessionForkProviderStateBinder
	SessionForkAttachments agenthost.SessionForkAttachmentStager
	RuntimePreparation     agenthost.RuntimePreparationPort
	Attachments            agenthost.AttachmentMaterializer
	SettingsPolicy         agenthost.SettingsPolicy
	Clock                  agenthost.Clock
	SessionLocker          agenthost.SessionLocker
	RuntimeStartGate       agenthost.RuntimeStartGate
	LifecycleObserver      agenthost.LifecycleObserver
	CommitObserver         agenthost.CommitObserver
	RuntimeOperations      agenthost.RuntimeOperationStore
	OperationEvents        agenthost.RuntimeOperationEventPublisher
	OperationOwner         string
	StaleTurnSettler       agenthost.StaleTurnSettler
	GoalStore              agenthost.GoalStateStore
	GoalFences             agenthost.GoalGenerationFenceStore
	GoalInbox              agenthost.GoalReconcileInboxStore
	GoalOwner              string
	GoalClock              agenthost.Clock
	GoalAttemptTimeout     time.Duration
	GoalRecoveryBudget     time.Duration
	GoalMaxAttempts        int
	GoalDispatchDeadline   time.Duration
}

// ServiceComponents owns the narrow mutable components shared by production
// Host and Service. It is built before either consumer and contains no Service
// reference, keeping the composition graph one-way.
type ServiceComponents struct {
	hostSupport           HostSupportPorts
	runtimePreparation    *serviceRuntimePreparation
	sessionSettings       *serviceSessionSettingsState
	worktreeIsolationLock *sync.RWMutex
}

func NewServiceComponents(
	runtime RuntimeController,
	config ServiceConfig,
	canonical ApplicationHostCanonicalPorts,
) *ServiceComponents {
	if runtime == nil {
		panic("agent service components require a runtime")
	}
	runtimePreparation := newServiceRuntimePreparation(config)
	sessionSettings := &serviceSessionSettingsState{}
	worktreeIsolationLock := &sync.RWMutex{}
	support := HostSupportPorts{
		DeletedSessions:      config.Sessions.DeletedSessions,
		SessionPurge:         config.Sessions.PurgeStore,
		SessionDeletionGuard: config.Sessions.DeletionGuard,
		SessionForkContext:   serviceHostSessionForkContextPolicy{},
		SessionForkState: serviceHostSessionForkProviderStateBinder{
			runtimePreparer: config.Runtime.Preparer,
		},
		SessionForkAttachments: config.Resources.PromptAttachmentStore,
		RuntimePreparation: serviceHostPreparation{
			support:         runtimePreparation,
			runtimePreparer: config.Runtime.Preparer,
			sessionForks:    canonical,
		},
		Attachments:    config.Resources.PromptAttachmentStore,
		SettingsPolicy: serviceHostSettingsPolicy{catalog: config.Composer.ModelCatalog},
		Clock:          serviceHostClock{now: config.Runtime.RuntimeOperationClock},
		SessionLocker: serviceHostLocker{
			mu: &sessionSettings.mu, locks: &sessionSettings.locks,
		},
		RuntimeStartGate:  serviceHostStartupGate{gate: claudecodeservice.DefaultStartupGate},
		LifecycleObserver: serviceHostLifecycleObserver{reporter: config.Observers.AnalyticsReporter},
		CommitObserver:    serviceHostCommitObserver{observer: config.Observers.CommitObserver},
		RuntimeOperations: config.Runtime.RuntimeOperationStore,
		OperationEvents: serviceHostRuntimeOperationEventPublisher{
			publisher: config.Observers.RuntimeOperationEventPublisher,
		},
		OperationOwner:       config.Runtime.RuntimeOperationOwner,
		StaleTurnSettler:     config.Runtime.StaleTurnSettler,
		GoalStore:            config.Runtime.GoalStateStore,
		GoalFences:           config.Runtime.GoalGenerationFenceStore,
		GoalInbox:            config.Runtime.GoalReconcileInboxStore,
		GoalOwner:            config.Runtime.GoalOperationOwner,
		GoalClock:            serviceHostClock{now: config.Runtime.GoalOperationClock},
		GoalAttemptTimeout:   config.Runtime.GoalOperationAttemptTimeout,
		GoalRecoveryBudget:   config.Runtime.GoalOperationRecoveryBudget,
		GoalMaxAttempts:      config.Runtime.GoalOperationMaxAttempts,
		GoalDispatchDeadline: config.Runtime.GoalOperationDispatchDeadline,
	}
	return &ServiceComponents{
		hostSupport:           support,
		runtimePreparation:    runtimePreparation,
		sessionSettings:       sessionSettings,
		worktreeIsolationLock: worktreeIsolationLock,
	}
}

func (c *ServiceComponents) HostSupportPorts() HostSupportPorts {
	if c == nil {
		return HostSupportPorts{}
	}
	return c.hostSupport
}

func NewApplicationHostWithPorts(
	support HostSupportPorts,
	canonical ApplicationHostCanonicalPorts,
	sessionForkRecovery agenthost.SessionForkRecoveryStore,
	historicalState agenthost.HistoricalSessionStateStore,
	runtime ApplicationHostRuntime,
) *agenthost.Host {
	if canonical == nil || runtime == nil || support.RuntimePreparation == nil {
		return nil
	}
	if support.DeletedSessions == nil {
		if _, ok := any(canonical).(agenthost.DeletedSessionStore); !ok {
			return nil
		}
	}
	return composeApplicationHost(
		support,
		canonical,
		canonical,
		canonical,
		sessionForkRecovery,
		historicalState,
		runtime,
		runtime,
	)
}

func composeApplicationHost(
	support HostSupportPorts,
	canonical agenthost.CanonicalStore,
	sessionManagement agenthost.SessionManagementStore,
	sessionBatchManagement agenthost.SessionBatchManagementStore,
	sessionForkRecovery agenthost.SessionForkRecoveryStore,
	historicalState agenthost.HistoricalSessionStateStore,
	runtime agenthost.RuntimeController,
	goalRuntime agenthost.GoalRuntimeController,
) *agenthost.Host {
	sessionForks, _ := canonical.(agenthost.SessionForkStore)
	if sessionForkRecovery == nil {
		sessionForkRecovery, _ = canonical.(agenthost.SessionForkRecoveryStore)
	}
	sessionForkRuntime, _ := runtime.(agenthost.SessionForkRuntime)
	sideConversationRuntime, _ := runtime.(agenthost.SideConversationRuntime)
	turnSubmissions, _ := canonical.(agenthost.TurnSubmissionStore)
	effectiveHistory, _ := canonical.(agenthost.EffectiveHistoryStore)
	deletedSessions := support.DeletedSessions
	if deletedSessions == nil {
		deletedSessions, _ = canonical.(agenthost.DeletedSessionStore)
	}
	historyRuntime, _ := runtime.(agenthost.RuntimeHistoryController)
	return agenthost.New(agenthost.Config{
		CanonicalStore: canonical, SessionManagement: sessionManagement,
		SessionBatchManagement: sessionBatchManagement, SessionPurge: support.SessionPurge,
		DeletedSessions: deletedSessions,
		SessionForks:    sessionForks, SessionForkRecovery: sessionForkRecovery,
		HistoricalState:        historicalState,
		SessionForkRuntime:     sessionForkRuntime,
		SessionForkContext:     support.SessionForkContext,
		SessionForkState:       support.SessionForkState,
		SessionForkAttachments: support.SessionForkAttachments,
		SessionDeletionGuard:   support.SessionDeletionGuard,
		TurnSubmissions:        turnSubmissions,
		EffectiveHistory:       effectiveHistory,
		Runtime:                runtime,
		HistoryRuntime:         historyRuntime,
		RuntimePreparation:     support.RuntimePreparation, Attachments: support.Attachments,
		SideConversationRuntime: sideConversationRuntime,
		SettingsPolicy:          support.SettingsPolicy,
		Clock:                   support.Clock, SessionLocker: support.SessionLocker,
		RuntimeStartGate:  support.RuntimeStartGate,
		LifecycleObserver: support.LifecycleObserver,
		CommitObserver:    support.CommitObserver,
		RuntimeOperations: support.RuntimeOperations, OperationEvents: support.OperationEvents,
		OperationOwner: support.OperationOwner, StaleTurnSettler: support.StaleTurnSettler,
		GoalStore: support.GoalStore, GoalFences: support.GoalFences,
		GoalRuntime: goalRuntime, GoalInbox: support.GoalInbox,
		GoalOwner: support.GoalOwner, GoalClock: support.GoalClock,
		GoalAttemptTimeout: support.GoalAttemptTimeout, GoalRecoveryBudget: support.GoalRecoveryBudget,
		GoalMaxAttempts: support.GoalMaxAttempts, GoalDispatchDeadline: support.GoalDispatchDeadline,
		GoalActor: agenthost.NewSessionActor(),
		// Durable edit-and-retry (PR #1681) is neutralized: its saga can strand a
		// session in a rolled-back-but-not-resent state whose runtime operation
		// becomes a cold-recovery poison pill that crashes tuttid on launch.
		EditRetryDisabled: true,
	})
}
