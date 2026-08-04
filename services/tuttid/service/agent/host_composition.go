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
	agenthost.RuntimeOperationHealthStore
	committedSessionForkReader
}

// HostSupportPorts contains only the adapter-owned capabilities Host consumes.
// It is complete before Host construction and intentionally has no Service
// field, so Host cannot become a reverse container for the tuttid facade.
type HostSupportPorts struct {
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
	RuntimeOperationHealth agenthost.RuntimeOperationHealthStore
	OperationEvents        agenthost.RuntimeOperationEventPublisher
	OperationOwner         string
	StaleTurnSettler       agenthost.StaleTurnSettler
	WorktreeGC             agenthost.WorktreeGarbageCollector
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
		SessionPurge:         config.Sessions.PurgeStore,
		SessionDeletionGuard: config.Sessions.DeletionGuard,
		SessionForkContext: serviceHostSessionForkContextPolicy{
			runtimePreparer: config.Runtime.Preparer,
		},
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
		RuntimeStartGate:       serviceHostStartupGate{gate: claudecodeservice.DefaultStartupGate},
		LifecycleObserver:      serviceHostLifecycleObserver{reporter: config.Observers.AnalyticsReporter},
		CommitObserver:         serviceHostCommitObserver{observer: config.Observers.CommitObserver},
		RuntimeOperations:      config.Runtime.RuntimeOperationStore,
		RuntimeOperationHealth: canonical,
		OperationEvents: serviceHostRuntimeOperationEventPublisher{
			publisher: config.Observers.RuntimeOperationEventPublisher,
		},
		OperationOwner:   config.Runtime.RuntimeOperationOwner,
		StaleTurnSettler: config.Runtime.StaleTurnSettler,
		WorktreeGC: serviceHostWorktreeGC{
			mu:                     worktreeIsolationLock,
			stateDir:               config.Resources.WorktreeStateDir,
			workspaceIDs:           config.Resources.WorkspaceIDs,
			sessionReader:          config.Sessions.Reader,
			runtime:                runtime,
			agentTargetStore:       config.Composer.AgentTargetStore,
			workspaceAgentResolver: config.Composer.WorkspaceAgentResolver,
		},
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
	if support.RuntimeOperationHealth == nil {
		support.RuntimeOperationHealth = canonical
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
		agenthost.EditRetryAdmissionAllowNew,
		agenthost.EditRetryRecoveryDrain,
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
	editRetryAdmission agenthost.EditRetryAdmissionPolicy,
	editRetryRecovery agenthost.EditRetryRecoveryPolicy,
) *agenthost.Host {
	sessionForks, _ := canonical.(agenthost.SessionForkStore)
	if sessionForkRecovery == nil {
		sessionForkRecovery, _ = canonical.(agenthost.SessionForkRecoveryStore)
	}
	sessionForkRuntime, _ := runtime.(agenthost.SessionForkRuntime)
	turnSubmissions, _ := canonical.(agenthost.TurnSubmissionStore)
	// The edit-retry operation and session fence share one canonical SQLite
	// transaction. Production composition must never substitute a split store.
	effectiveHistory, _ := canonical.(agenthost.EffectiveHistoryStore)
	if effectiveHistory == nil {
		return nil
	}
	historyRuntime, _ := runtime.(agenthost.RuntimeHistoryController)
	return agenthost.New(agenthost.Config{
		CanonicalStore: canonical, SessionManagement: sessionManagement,
		SessionBatchManagement: sessionBatchManagement, SessionPurge: support.SessionPurge,
		SessionForks: sessionForks, SessionForkRecovery: sessionForkRecovery,
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
		SettingsPolicy: support.SettingsPolicy,
		Clock:          support.Clock, SessionLocker: support.SessionLocker,
		RuntimeStartGate:  support.RuntimeStartGate,
		LifecycleObserver: support.LifecycleObserver,
		CommitObserver:    support.CommitObserver,
		RuntimeOperations: support.RuntimeOperations, OperationEvents: support.OperationEvents,
		RuntimeOperationHealth: support.RuntimeOperationHealth,
		OperationOwner:         support.OperationOwner, StaleTurnSettler: support.StaleTurnSettler,
		WorktreeGC: support.WorktreeGC,
		GoalStore:  support.GoalStore, GoalFences: support.GoalFences,
		GoalRuntime: goalRuntime, GoalInbox: support.GoalInbox,
		GoalOwner: support.GoalOwner, GoalClock: support.GoalClock,
		GoalAttemptTimeout: support.GoalAttemptTimeout, GoalRecoveryBudget: support.GoalRecoveryBudget,
		GoalMaxAttempts: support.GoalMaxAttempts, GoalDispatchDeadline: support.GoalDispatchDeadline,
		GoalActor: agenthost.NewSessionActor(),
		// Production admits V2 edit retries. Host recovery remains independently
		// governed by each durable operation's checkpoint and provider evidence.
		EditRetryAdmission: editRetryAdmission,
		EditRetryRecovery:  editRetryRecovery,
	})
}
