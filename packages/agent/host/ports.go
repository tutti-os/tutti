package agenthost

import (
	"context"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type CanonicalSessionStore interface {
	GetSession(context.Context, string, string) (storesqlite.Session, bool, error)
	SessionDeleted(context.Context, string, string) (bool, error)
	RollbackRuntimeSessionInitialization(context.Context, string, string) (bool, error)
	InitializeRuntimeSession(context.Context, ProviderRuntimeSession) (storesqlite.Session, error)
	UpdateSessionTitle(context.Context, string, string, string) (storesqlite.Session, bool, error)
	ListChildSessions(context.Context, string, string) ([]storesqlite.Session, error)
}

type CanonicalTurnStore interface {
	GetTurn(context.Context, string, string, string) (storesqlite.Turn, bool, error)
	FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error)
	ListLatestTurnInteractions(context.Context, string, []string) (map[string][]storesqlite.Interaction, error)
	ListSessionInteractions(context.Context, storesqlite.ListSessionInteractionsInput) ([]storesqlite.Interaction, error)
}

type CanonicalMessageStore interface {
	ListSessionMessages(context.Context, storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error)
}

type CanonicalSubmitClaimStore interface {
	PrepareSubmitClaim(context.Context, storesqlite.SubmitClaimPrepare) (storesqlite.SubmitClaim, bool, error)
	AcceptSubmitClaim(context.Context, string, string, string, string, int64) (storesqlite.SubmitClaim, bool, error)
	DeleteSubmitClaim(context.Context, string, string, string) (bool, error)
}

// CanonicalStore composes the session, turn, and submit-claim facts shared by
// lifecycle commands. Runtime-operation and goal saga stores stay separate so
// adapters cannot accidentally substitute one durability boundary for another.
type CanonicalStore interface {
	CanonicalSessionStore
	CanonicalTurnStore
	CanonicalMessageStore
	CanonicalSubmitClaimStore
}

// SessionManagementStore is the narrow canonical mutation surface for session
// metadata commands. It stays separate from lifecycle storage so read/create
// consumers are not forced to implement unrelated mutations.
type SessionManagementStore interface {
	UpdateSessionSettings(context.Context, string, string, ComposerSettings) (storesqlite.Session, bool, error)
	UpdateSessionPinned(context.Context, string, string, bool) (storesqlite.Session, bool, error)
}

// SessionBatchManagementStore is the atomic canonical mutation boundary for
// project/section deletion. It is separate from single-session management so
// runtimes can advertise batch support only when the backing store implements
// one transaction rather than a renderer-side request loop.
type SessionBatchManagementStore interface {
	PlanClearSessions(context.Context, string) (storesqlite.DeleteSessionsPlan, error)
	PlanDeleteSessions(context.Context, storesqlite.DeleteSessionsBatchInput) (storesqlite.DeleteSessionsPlan, error)
	DeleteSessionsBatch(context.Context, storesqlite.DeleteSessionsBatchInput) (storesqlite.DeleteSessionsBatchResult, error)
}

// SessionPurgeStore is the narrow permanent-removal boundary. Retention and
// local-file ownership policies remain outside Host.
type SessionPurgeStore interface {
	PurgeDeletedSessions(context.Context, storesqlite.PurgeDeletedSessionsInput) (storesqlite.PurgeDeletedSessionsResult, error)
}

// RuntimeController is the provider-neutral live-runtime surface needed by
// create, resume, send, exact cancel, interactive, plan, title, and visibility
// workflows. Process transport and provider implementations stay behind it.
type RuntimeController interface {
	Start(context.Context, RuntimeStartInput) (ProviderRuntimeSession, error)
	Resume(context.Context, RuntimeResumeInput) (ProviderRuntimeSession, error)
	Session(workspaceID string, agentSessionID string) (ProviderRuntimeSession, bool)
	CanResume(RuntimeResumeInput) bool
	Exec(context.Context, RuntimeExecInput) (RuntimeExecResult, error)
	ValidatePromptContent(context.Context, RuntimeExecInput) error
	Cancel(context.Context, RuntimeCancelInput) (RuntimeCancelResult, error)
	SubmitInteractive(context.Context, RuntimeSubmitInteractiveInput) (RuntimeSubmitInteractiveResult, error)
	InteractiveDisposition(workspaceID, rootAgentSessionID, agentSessionID, turnID, requestID string) RuntimeInteractiveDisposition
	UpdateSettings(context.Context, RuntimeUpdateSettingsInput) error
	SetTitle(context.Context, RuntimeSetTitleInput) (ProviderRuntimeSession, error)
	SetVisible(context.Context, RuntimeSetVisibleInput) (ProviderRuntimeSession, error)
	Close(context.Context, RuntimeCloseInput) error
}

// RuntimeOperationStore is the complete durable coordinator boundary. Keeping
// every transition on one port prevents adapters from reimplementing only the
// transport-facing half of the state machine.
type RuntimeOperationStore interface {
	PrepareRuntimeOperation(context.Context, storesqlite.RuntimeOperationPrepare) (storesqlite.RuntimeOperation, bool, error)
	PrepareInteractiveRuntimeOperation(context.Context, storesqlite.RuntimeOperationPrepare) (storesqlite.RuntimeOperation, storesqlite.Interaction, storesqlite.InteractionTransitionResult, error)
	GetRuntimeOperation(context.Context, string, string) (storesqlite.RuntimeOperation, bool, error)
	ListClaimableRuntimeOperations(context.Context, storesqlite.ListClaimableRuntimeOperationsInput) ([]storesqlite.RuntimeOperation, error)
	ClaimRuntimeOperationLease(context.Context, storesqlite.ClaimRuntimeOperationLeaseInput) (storesqlite.RuntimeOperation, bool, error)
	ReleaseOrFailRuntimeOperation(context.Context, storesqlite.ReleaseOrFailRuntimeOperationInput) (storesqlite.RuntimeOperation, bool, error)
	CheckpointRuntimeOperation(context.Context, storesqlite.CheckpointRuntimeOperationInput) (storesqlite.RuntimeOperation, bool, error)
	RequeueLeasedRuntimeOperationsOnStartup(context.Context, int64) (int64, error)
	CompleteInteractiveRuntimeOperation(context.Context, storesqlite.CompleteInteractiveRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error)
	CompleteCancelRuntimeOperation(context.Context, storesqlite.CompleteCancelRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error)
	CompletePlanDecisionRuntimeOperation(context.Context, storesqlite.CompletePlanDecisionRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error)
	ListPendingRuntimeOperationEvents(context.Context, string, int) ([]storesqlite.RuntimeOperationEvent, error)
	MarkRuntimeOperationEventPublished(context.Context, string, int64, int64) (bool, error)
}

type RuntimeOperationEventPublisher interface {
	PublishRuntimeOperationEvent(context.Context, storesqlite.RuntimeOperationEvent) error
}

// StaleTurnSettler runs after durable runtime operations, goal operations, and
// goal reconcile inbox work have been recovered and before the adapter-specific
// worktree-isolation sweep.
type StaleTurnSettler interface {
	SettleStaleTurnsOnStartup(context.Context) error
}

// WorktreeGarbageCollector owns adapter-specific git/filesystem cleanup. Host
// schedules it during startup recovery and from the periodic Run worker so
// cleanup cannot accidentally follow a turn or runtime terminal transition.
type WorktreeGarbageCollector interface {
	SweepWorktreeIsolation(context.Context) error
}

type GoalStateStore interface {
	PrepareGoalControlOperation(context.Context, storesqlite.GoalControlOperationPrepare) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error)
	GetGoalControlAudit(context.Context, string, string, string) (storesqlite.Message, bool, error)
	MarkGoalControlOperationDispatched(context.Context, string, string, int64) (storesqlite.GoalControlOperation, bool, error)
	AcknowledgeGoalControlOperation(context.Context, storesqlite.GoalControlOperationAcknowledge) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error)
	CompleteGoalControlOperation(context.Context, storesqlite.GoalControlOperationComplete) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error)
	GetSessionGoalState(context.Context, string, string) (storesqlite.SessionGoalState, bool, error)
	ReconcileSessionGoalObservation(context.Context, storesqlite.GoalObservationReconcile) (storesqlite.SessionGoalState, error)
	MarkGoalRevisionTerminalIncident(context.Context, storesqlite.GoalTerminalIncidentInput) (storesqlite.SessionGoalState, error)
	GetGoalControlOperation(context.Context, string, string) (storesqlite.GoalControlOperation, bool, error)
	ListClaimableGoalControlOperations(context.Context, storesqlite.ListClaimableGoalControlOperationsInput) ([]storesqlite.GoalControlOperation, error)
	ClaimGoalControlOperation(context.Context, storesqlite.ClaimGoalControlOperationInput) (storesqlite.GoalControlOperation, bool, error)
	ReleaseGoalControlOperation(context.Context, storesqlite.ReleaseGoalControlOperationInput) (storesqlite.GoalControlOperation, bool, error)
	RecordGoalControlOperationEvidence(context.Context, storesqlite.GoalControlOperationEvidence) (storesqlite.GoalControlOperation, bool, error)
	EnsureOrWakeGoalRepairOperation(context.Context, storesqlite.EnsureGoalRepairOperationInput) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error)
	RequeueLeasedGoalControlOperationsOnStartup(context.Context, int64) (int64, error)
}

type GoalReconcileInboxStore interface {
	ListClaimableGoalReconcileInbox(context.Context, int64, int) ([]storesqlite.GoalReconcileInboxItem, error)
	ClaimGoalReconcileInbox(context.Context, storesqlite.ClaimGoalReconcileInboxInput) (storesqlite.GoalReconcileInboxItem, bool, error)
	CompleteGoalReconcileInbox(context.Context, string, string, int64) (bool, error)
	ReleaseGoalReconcileInbox(context.Context, storesqlite.ReleaseGoalReconcileInboxInput) (bool, error)
	RequeueLeasedGoalReconcileInboxOnStartup(context.Context, int64) (int64, error)
}

type GoalRuntimeController interface {
	GoalControl(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error)
}

type GoalRuntimeReconciler interface {
	ReconcileGoal(context.Context, RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error)
}

type GoalRuntimeRecoveryPolicyResolver interface {
	GoalRecoveryPolicy(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error)
}

type RuntimePreparationInput struct {
	WorkspaceID            string
	AgentSessionID         string
	AgentTargetID          string
	Provider               string
	Cwd                    string
	Title                  string
	PermissionModeID       string
	PlanMode               bool
	BrowserUse             bool
	ComputerUse            bool
	ProviderTargetRef      map[string]any
	Model                  string
	ReasoningEffort        string
	ConversationDetailMode string
	Metadata               map[string]any
	RuntimeContext         map[string]any
	SessionOrigin          string
	ProviderSessionID      string
	CreatedAtUnixMS        int64
	UpdatedAtUnixMS        int64
	Visible                bool
	Settings               ComposerSettings
	SessionMetadata        storesqlite.SessionMetadata
}

type PreparedRuntime struct {
	Cwd               string
	Env               []string
	ProviderTargetRef map[string]any
	Settings          *ComposerSettings
	RuntimeContext    map[string]any
}

type RuntimeCleanupInput struct {
	WorkspaceID    string
	AgentSessionID string
	Provider       string
}

type RuntimePreparationPort interface {
	Prepare(context.Context, RuntimePreparationInput) (PreparedRuntime, error)
	Cleanup(context.Context, RuntimeCleanupInput) error
}

// SettingsPolicy keeps provider-specific model, reasoning, and speed
// normalization in adapters while Host owns the application decision between
// a durable historical update and a live runtime update.
type SettingsPolicy interface {
	NormalizePersistedSettings(context.Context, storesqlite.Session, ComposerSettings, ComposerSettingsPatch) ComposerSettings
	NormalizeRuntimeSettingsPatch(context.Context, ProviderRuntimeSession, ComposerSettingsPatch) ComposerSettingsPatch
}

type AttachmentMaterializer interface {
	PersistRequestContent(workspaceID string, agentSessionID string, content []PromptContentBlock) ([]PromptContentBlock, error)
	HydrateRuntimeContent(workspaceID string, agentSessionID string, content []PromptContentBlock) ([]PromptContentBlock, error)
}

type Clock interface {
	Now() time.Time
}

type Scheduler interface {
	Sleep(context.Context, time.Duration) error
}

// SessionLocker serializes application commands for one canonical session.
// Implementations may use an in-process keyed lock; the Host does not assume a
// database, process, or transport-specific locking mechanism.
type SessionLocker interface {
	Acquire(context.Context, SessionRef) (release func(), err error)
}

// RuntimeStartGate protects provider-specific startup critical sections. For
// example, an adapter may serialize credential-touching provider startup.
type RuntimeStartGate interface {
	Acquire(context.Context, string) (release func(), err error)
}

type LifecycleStep struct {
	Flow           string
	Name           string
	AgentSessionID string
	Provider       string
	StartedAt      time.Time
	Err            error
}

// LifecycleObserver receives diagnostic step outcomes. It must not influence
// command correctness; durable state remains in CanonicalStore.
type LifecycleObserver interface {
	ObserveLifecycleStep(context.Context, LifecycleStep)
}

// CommitObserver is the single post-commit wake surface. Implementations must
// not treat it as a durable fact carrier; reliable work is read back from
// canonical storage after the wake.
type CommitObserver interface {
	ObserveCommitted(context.Context, CommittedDelta) error
}
